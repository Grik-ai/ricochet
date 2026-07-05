import { useRef, useMemo, useEffect, useState, type ReactNode } from 'react';
import {
    buildTaskRunViewModel,
    useChat,
    type ChatMessage as ChatMessageModel,
    type QueuedTurnState,
    type WorkSummary
} from '../../hooks/useChat';
import { ChatMessage } from './ChatMessage';
import { ChatInput, type SelectedModel } from './ChatInput';
import { useLiveMode } from '../../hooks/useLiveMode';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { useSessions } from '../../hooks/useSessions';
import { MissionWidget } from './MissionWidget';
import { AccountBadge } from '../account/AccountBadge';
import { useAgentStateMachine } from '../../hooks/useAgentStateMachine';
import { useNetworkHealth } from '../../hooks/useNetworkHealth';
import { Clock3, History, Loader2, MessageSquare } from 'lucide-react';
import { PendingApprovalSurface } from './PendingApprovalSurface';
import { PendingPlanDecisionSurface, collectPendingPlanDecisionArtifacts } from './PendingPlanDecisionSurface';
import { PendingReviewSurface } from './PendingReviewSurface';
import { cleanAssistantVisibleText, isRenderableChatMessage } from '../../utils/chatVisibility';
import { findRetryPromptBefore } from '../../utils/chatErrors';
import { TaskRunHeader } from './TaskRunHeader';
import { CheckpointPanel } from '../checkpoints/CheckpointPanel';
import type { ContextFilePayload } from '../../types/protocol';
import type { SessionMetadata } from '../../types/session';
import type { GrikAccountController } from '../../hooks/useGrikAccount';

const ACTIVE_TOOL_STALE_MS = 5 * 60 * 1000;

export interface ChatViewProps {
    onOpenHistory: () => void;
    onOpenAgent: () => void;
    onOpenAccount: () => void;
    onOpenSettings: (tab?: string) => void;
    grikAccount: GrikAccountController;
    agentState: ReturnType<typeof useAgentStateMachine>;
    mode: 'plan' | 'act' | 'mission';
    onModeChange: (mode: 'plan' | 'act' | 'mission') => void;
    model: SelectedModel;
    onModelChange: (model: SelectedModel) => void;
}

export interface ChatRow {
    message: ChatMessageModel;
    workSummary?: WorkSummary;
    queuedTurn?: QueuedTurnState;
}

function summaryHasVisiblePayload(summary: WorkSummary): boolean {
    return summary.items.length > 0 || Boolean(summary.activityHint && summary.activityHint !== 'none');
}

function shouldAttachWorkSummary(summary?: WorkSummary): summary is WorkSummary {
    if (!summary) return false;
    if (summary.status === 'completed' && !summaryHasVisiblePayload(summary)) return false;
    return true;
}

function shouldRenderOrphanWorkSummary(summary: WorkSummary): boolean {
    if (summary.status === 'running' || summary.status === 'waiting') return true;
    if (!summaryHasVisiblePayload(summary)) return false;
    return summary.status === 'completed' || summary.status === 'failed' || summary.status === 'stopped' || summary.status === 'rejected';
}

function isApprovalOnlySummary(summary: WorkSummary): boolean {
    return summary.items.length > 0 && summary.items.every(item => item.type === 'approval');
}

function hasSiblingApprovalSummary(summary: WorkSummary, summaries: Record<string, WorkSummary>): boolean {
    const targets = new Set(summary.items
        .filter(item => item.type === 'approval')
        .map(item => item.target || item.id)
        .filter(Boolean));
    if (targets.size === 0) return false;

    return Object.values(summaries).some(other => {
        if (other.turnId === summary.turnId || isApprovalOnlySummary(other)) return false;
        if (other.status !== 'running' && other.status !== 'waiting') return false;
        return other.items.some(item => item.type === 'approval' && targets.has(item.target || item.id));
    });
}

function messageSummaryKeys(message: ChatMessageModel): string[] {
    return [message.run_id, message.turn_id, message.id].filter(Boolean) as string[];
}

function queuedTurnForMessage(message: ChatMessageModel, queuedTurnsByRunId: Record<string, QueuedTurnState>): QueuedTurnState | undefined {
    if (message.role !== 'user') return undefined;
    return messageSummaryKeys(message).map(key => queuedTurnsByRunId[key]).find(Boolean);
}

function nearestUserRowWithoutSummary(rows: ChatRow[], summary: WorkSummary): number {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.message.role !== 'user' || row.workSummary) continue;
        if (!summary.startedAt || !row.message.timestamp || row.message.timestamp <= summary.startedAt) {
            return index;
        }
    }

    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row.message.role === 'user' && !row.workSummary) return index;
    }

    return -1;
}

export function buildChatRows(
    visibleMessages: ChatMessageModel[],
    workSummariesByTurn: Record<string, WorkSummary>,
    queuedTurnsByRunId: Record<string, QueuedTurnState> = {}
): ChatRow[] {
    const renderedSummaryKeys = new Set<string>();
    const rows: ChatRow[] = [];

    for (const message of visibleMessages) {
        let workSummary: WorkSummary | undefined;
        for (const summaryKey of messageSummaryKeys(message)) {
            const candidate = workSummariesByTurn[summaryKey];
            if (candidate && !renderedSummaryKeys.has(candidate.turnId) && shouldAttachWorkSummary(candidate)) {
                workSummary = candidate;
                renderedSummaryKeys.add(candidate.turnId);
                break;
            }
        }

        if (message.role === 'assistant') {
            const hasVisibleAssistantContent = Boolean(
                cleanAssistantVisibleText(message.content || '') ||
                message.errorInfo ||
                message.checkpointHash ||
                (Array.isArray((message as any).artifacts) && (message as any).artifacts.length > 0)
            );

            if (!hasVisibleAssistantContent && !workSummary) {
                continue;
            }
        }

        rows.push({
            message,
            workSummary,
            queuedTurn: queuedTurnForMessage(message, queuedTurnsByRunId),
        });
    }

    Object.values(workSummariesByTurn)
        .filter(summary => !renderedSummaryKeys.has(summary.turnId) && shouldRenderOrphanWorkSummary(summary))
        .filter(summary => !(isApprovalOnlySummary(summary) && hasSiblingApprovalSummary(summary, workSummariesByTurn)))
        .sort((a, b) => a.startedAt - b.startedAt)
        .forEach(summary => {
            renderedSummaryKeys.add(summary.turnId);
            const attachToUserIndex = nearestUserRowWithoutSummary(rows, summary);
            if (attachToUserIndex !== -1) {
                rows[attachToUserIndex] = { ...rows[attachToUserIndex], workSummary: summary };
                return;
            }
            rows.push({
                message: {
                    id: `work-summary-${summary.turnId}`,
                    role: 'assistant',
                    content: '',
                    timestamp: summary.startedAt,
                    run_id: summary.turnId,
                    turn_id: summary.turnId,
                },
                workSummary: summary,
            });
        });

    return rows;
}

export function ChatView({
    onOpenHistory,
    onOpenAgent,
    onOpenAccount,
    onOpenSettings,
    grikAccount,
    agentState,
    mode,
    onModeChange,
    model,
    onModelChange
}: ChatViewProps) {
    const { sessions, currentSessionId, loadSession } = useSessions();
    const {
        messages,
        todos,
        isLoading,
        isStopping,
        inputValue,
        setInputValue,
        sendMessage,
        cancelGeneration,
        contextStatus,
        usageSnapshot,
        taskProgress,
        hubTasks,
        workSummariesByTurn,
        queuedTurnsByRunId,
        fileResults,
        searchFiles,
        pendingPermissions,
        pendingEdits,
        respondToPermission,
        restoreCheckpoint
    } = useChat(currentSessionId);

    const { status: liveStatus, isLoading: isLiveModeLoading, toggleLiveMode } = useLiveMode();
    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const { onMessage, postMessage } = useVSCodeApi();
    const [workspaceName, setWorkspaceName] = useState('Project');
    const visibleMessages = useMemo(() => messages.filter(isRenderableChatMessage), [messages]);
    const messageRows = useMemo(
        () => buildChatRows(visibleMessages, workSummariesByTurn, queuedTurnsByRunId),
        [visibleMessages, workSummariesByTurn, queuedTurnsByRunId]
    );
    const hasVisibleWorkSummary = useMemo(
        () => messageRows.some(row => Boolean(row.workSummary)),
        [messageRows]
    );
    const hasVisibleMessages = visibleMessages.length > 0;
    const [emptyStateExiting, setEmptyStateExiting] = useState(false);
    const previousHadMessagesRef = useRef(hasVisibleMessages);

    const pendingInteractionList = useMemo(() => Object.values(pendingPermissions), [pendingPermissions]);
    const hasInlineEditApproval = pendingEdits.length > 0;
    const pendingApprovalList = useMemo(
        () => pendingInteractionList.filter((request: any) => !(hasInlineEditApproval && /edit|file|write|save|apply|diff/i.test(request.question || ''))),
        [hasInlineEditApproval, pendingInteractionList]
    );
    const pendingPlanArtifacts = useMemo(
        () => collectPendingPlanDecisionArtifacts(visibleMessages),
        [visibleMessages]
    );
    const activeWorkSummary = useMemo(() => {
        return Object.values(workSummariesByTurn).find(summary => summary.status === 'running' || summary.status === 'waiting') || null;
    }, [workSummariesByTurn]);
    const agentRuntimeIsScopedToView = useMemo(() => {
        const agentSessionId = agentState.context.sessionId;
        return !agentSessionId || !currentSessionId || agentSessionId === currentSessionId;
    }, [agentState.context.sessionId, currentSessionId]);
    const explicitAgentRuntimeActive = useMemo(() => {
        if (!agentRuntimeIsScopedToView || !agentState.uiState.isActive) return false;
        const hasWorkers = Object.keys(agentState.context.workers || {}).length > 0;
        const hasRuntimeResources = hasWorkers
            || Boolean(agentState.context.pendingChoice || agentState.context.pendingTool)
            || Object.values(agentState.context.activeToolCalls || {}).some((tool: any) => tool.status === 'running');
        if (!agentState.context.missionTitle && !hasRuntimeResources) return false;
        return !/^(completed|failed|stopped|idle)$/i.test(agentState.context.missionStatus || '');
    }, [
        agentRuntimeIsScopedToView,
        agentState.context.activeToolCalls,
        agentState.context.missionStatus,
        agentState.context.missionTitle,
        agentState.context.pendingChoice,
        agentState.context.pendingTool,
        agentState.context.workers,
        agentState.uiState.isActive
    ]);
    const taskRunWorkers = useMemo(() => {
        if (!explicitAgentRuntimeActive) return [];
        return Object.values(agentState.context.workers || {}).map((worker: any, index) => {
            const status = String(worker.status || (worker.isActive ? 'running' : 'unknown'));
            return {
                id: String(worker.id || `worker-${index + 1}`),
                name: String(worker.name || worker.id || `Worker ${index + 1}`),
                status,
                isActive: Boolean(worker.isActive) || /queued|running|in progress|active/i.test(status),
                progress: typeof worker.progress === 'string' && worker.progress.trim()
                    ? worker.progress.trim()
                    : typeof worker.lastResult === 'string' && worker.lastResult.trim()
                        ? worker.lastResult.trim()
                        : undefined,
            };
        });
    }, [agentState.context.workers, explicitAgentRuntimeActive]);

    useEffect(() => {
        const unsubscribe = onMessage((message: any) => {
            if (message.type === 'request_permission') {
                console.log('[ChatView] Permission request received:', message.payload?.question?.slice(0, 50));
            } else if (message.type === 'workspace_state') {
                const name = typeof message.payload?.name === 'string' ? message.payload.name.trim() : '';
                setWorkspaceName(name || 'Project');
            }
        });
        postMessage({ type: 'get_workspace_state' });
        return () => { unsubscribe(); };
    }, [onMessage, postMessage]);

    useEffect(() => {
        if (!previousHadMessagesRef.current && hasVisibleMessages) {
            setEmptyStateExiting(true);
            const timeout = window.setTimeout(() => setEmptyStateExiting(false), 280);
            previousHadMessagesRef.current = hasVisibleMessages;
            return () => window.clearTimeout(timeout);
        }
        previousHadMessagesRef.current = hasVisibleMessages;
    }, [hasVisibleMessages]);

    useEffect(() => {
        if (!hasVisibleMessages) return;
        const frame = window.requestAnimationFrame(() => {
            const viewport = scrollViewportRef.current;
            if (!viewport) return;
            viewport.scrollTop = viewport.scrollHeight;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [hasVisibleMessages, messageRows.length, isLoading, activeWorkSummary?.turnId]);

    const handleSend = (text?: string, contextFiles?: ContextFilePayload[]) => {
        const msg = typeof text === 'string' ? text : inputValue;
        if (!msg.trim() && !(contextFiles?.length)) return;

        sendMessage(msg, contextFiles, mode === 'plan');
    };

    const handleStartAgent = (text?: string, contextFiles?: ContextFilePayload[]) => {
        const msg = typeof text === 'string' ? text : inputValue;
        if (!msg.trim() && !(contextFiles?.length)) return;

        agentState.send({ type: 'start_session', content: msg });
        postMessage({
            type: 'start_session',
            payload: {
                prompt: msg,
                model: model.id,
                provider: model.provider,
                session_id: currentSessionId || undefined,
                context_files: contextFiles || []
            }
        });
        setInputValue('');
    };

    const handleCancelRuntime = () => {
        cancelGeneration();
        if (agentState.uiState.isActive) {
            agentState.send({ type: 'cancel_session' });
        }
    };

    const runtimeActive = useMemo(() => {
        const activeWorker = taskRunWorkers.some((worker: any) => worker.isActive || worker.status === 'queued' || worker.status === 'running' || worker.status === 'In Progress');
        const now = Date.now();
        const runningTool = Object.values(agentState.context.activeToolCalls || {}).some((tool: any) => (
            tool.status === 'running' &&
            (!tool.updatedAt || now - tool.updatedAt < ACTIVE_TOOL_STALE_MS)
        ));
        const waitingForInput = Boolean(agentState.context.pendingChoice || agentState.context.pendingTool);
        const explicitMissionActive = Boolean(agentState.context.missionTitle) && agentState.uiState.isActive && agentState.context.missionStatus !== 'completed' && agentState.context.missionStatus !== 'failed' && agentState.context.missionStatus !== 'stopped';
        const workSummaryCanBlockInput = Boolean(activeWorkSummary) && (
            isLoading ||
            Boolean(taskProgress?.is_active) ||
            pendingInteractionList.length > 0 ||
            pendingEdits.length > 0
        );
        const scopedAgentRuntimeActive = explicitAgentRuntimeActive && (activeWorker || runningTool || waitingForInput || explicitMissionActive);

        return isLoading ||
            isStopping ||
            pendingInteractionList.length > 0 ||
            pendingEdits.length > 0 ||
            Boolean(taskProgress?.is_active) ||
            workSummaryCanBlockInput ||
            scopedAgentRuntimeActive;
    }, [
        agentState.context.activeToolCalls,
        agentState.context.missionStatus,
        agentState.context.missionTitle,
        agentState.context.pendingChoice,
        agentState.context.pendingTool,
        agentState.uiState.isActive,
        explicitAgentRuntimeActive,
        isLoading,
        isStopping,
        pendingInteractionList.length,
        pendingEdits.length,
        activeWorkSummary,
        taskProgress?.is_active,
        taskRunWorkers
    ]);
    const taskRun = useMemo(() => buildTaskRunViewModel({
        messages,
        todos,
        hubTasks,
        workers: taskRunWorkers,
        pendingPermissionCount: pendingInteractionList.length,
        taskProgress,
        workSummariesByTurn,
        usageSnapshot,
        contextStatus,
        isLoading: runtimeActive,
    }), [
        contextStatus,
        hubTasks,
        messages,
        pendingInteractionList.length,
        runtimeActive,
        taskProgress,
        taskRunWorkers,
        todos,
        usageSnapshot,
        workSummariesByTurn
    ]);
    const latestNetworkActivityAt = useMemo(() => {
        const timestamps: number[] = [];
        for (const message of visibleMessages) {
            if (message.timestamp) timestamps.push(message.timestamp);
        }
        for (const summary of Object.values(workSummariesByTurn)) {
            if (summary.startedAt) timestamps.push(summary.startedAt);
            if (summary.completedAt) timestamps.push(summary.completedAt);
            for (const item of summary.items || []) {
                if (item.timestamp) timestamps.push(item.timestamp);
            }
        }
        return timestamps.length > 0 ? Math.max(...timestamps) : null;
    }, [visibleMessages, workSummariesByTurn]);

    const networkStatus = useNetworkHealth({
        runtimeActive,
        lastActivityAt: latestNetworkActivityAt,
    });

    const composer = (
        <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStartAgent={handleStartAgent}
            onCancel={handleCancelRuntime}
            isLoading={runtimeActive}
            isStopping={isStopping}
            fileResults={fileResults}
            searchFiles={searchFiles}
            liveStatus={liveStatus}
            isLiveModeLoading={isLiveModeLoading}
            onToggleLiveMode={toggleLiveMode}
            onOpenSettings={onOpenSettings}
            onOpenAccount={onOpenAccount}
            currentMode={mode}
            onModeChange={onModeChange}
            currentModel={model}
            onModelChange={onModelChange}
            sessionId={currentSessionId || undefined}
            pendingEdits={pendingEdits}
            pendingChoice={null}
            onChoiceResponse={respondToPermission}
            contextStatus={contextStatus}
            usageSnapshot={usageSnapshot}
            networkStatus={networkStatus}
            grikAccount={grikAccount}
            missionStatus={(
                <MissionWidget
                    agentState={agentState}
                    onOpenDashboard={onOpenAgent}
                    inline
                    pendingEditCount={pendingEdits.length}
                    alwaysVisible
                />
            )}
            accountStatus={(
                <AccountBadge
                    account={grikAccount}
                    onOpenAccount={onOpenAccount}
                    compact
                />
            )}
        />
    );

    return (
        <div className="flex flex-col h-full bg-vscode-editor-background text-vscode-fg overflow-hidden selection:bg-vscode-editor-selectionBackground">
            <div className="flex-1 min-h-0 flex flex-col relative z-0">
                <CheckpointPanel onRestore={restoreCheckpoint} />
                <TaskRunHeader taskRun={taskRun} onOpenAgent={onOpenAgent} />
                {!taskRun && !taskProgress && !agentState.context.sessionId && <TodoTracker todos={todos} />}

                <div ref={scrollViewportRef} className="flex-1 min-h-0 custom-scrollbar overflow-y-auto">
                    {(!hasVisibleMessages || emptyStateExiting) && (
                        <div className={hasVisibleMessages ? 'ricochet-empty-exit' : 'ricochet-empty-enter'}>
                            <EmptyChatLauncher
                                workspaceName={workspaceName}
                                sessions={sessions}
                                onLoadSession={loadSession}
                                onOpenHistory={onOpenHistory}
                                onOpenAccount={onOpenAccount}
                                grikAccount={grikAccount}
                                composer={!hasVisibleMessages ? composer : null}
                            />
                        </div>
                    )}
                    {hasVisibleMessages && (
                        <div ref={scrollRef} className={`max-w-4xl mx-auto w-full px-4 space-y-2 py-8 ${emptyStateExiting ? 'ricochet-chat-start' : ''}`}>
                            {messageRows.map(({ message, workSummary, queuedTurn }) => {
                                const retryPrompt = message.errorInfo?.retryable
                                    ? findRetryPromptBefore(visibleMessages, message)
                                    : null;
                                return (
                                    <div key={message.id} className="ricochet-message-enter">
                                        <ChatMessage
                                            message={message}
                                            workSummary={workSummary}
                                            queuedTurn={queuedTurn}
                                            pendingEdits={[]}
                                            onRestore={restoreCheckpoint}
                                            onRetryMessage={retryPrompt ? () => sendMessage(retryPrompt) : undefined}
                                            onExecuteCommand={(cmd) => postMessage({ type: 'execute_command', payload: { command: cmd } })}
                                        />
                                    </div>
                                );
                            })}

                            {/* Thinking State */}
                            {isLoading && !hasVisibleWorkSummary && (!visibleMessages[visibleMessages.length - 1]?.isStreaming) && (
                                <div className="px-5 py-4 animate-pulse flex flex-col gap-3 group ricochet-message-enter">
                                    <div className="flex items-center gap-4">
                                        <div className="w-8 h-8 rounded-md bg-vscode-input-bg border border-vscode-border flex items-center justify-center shrink-0">
                                            <Loader2 className="w-4 h-4 text-vscode-fg/45 animate-spin" />
                                        </div>
                                        <div className="flex flex-col gap-0.5">
                                            <div className="text-[10px] font-medium text-vscode-fg/45">
                                                {taskProgress?.task_name || 'Autonomous Agent'}
                                            </div>
                                            {taskProgress?.status && (
                                                <div className="text-[11px] text-vscode-fg/55 truncate max-w-[400px]">
                                                    {taskProgress.status}...
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {hasVisibleMessages && (
                <div className={`p-3 bg-vscode-editor-background border-t border-vscode-border ${emptyStateExiting ? 'ricochet-composer-dock-enter' : ''}`}>
                    <div className="max-w-4xl mx-auto">
                        <PendingPlanDecisionSurface artifacts={pendingPlanArtifacts} />
                        <PendingApprovalSurface
                            requests={pendingApprovalList}
                            onResponse={respondToPermission}
                        />
                        <PendingReviewSurface edits={pendingEdits} />
                        {composer}
                    </div>
                </div>
            )}
        </div>
    );
};

function EmptyChatLauncher({
    workspaceName,
    sessions,
    onLoadSession,
    onOpenHistory,
    onOpenAccount,
    grikAccount,
    composer
}: {
    workspaceName: string;
    sessions: SessionMetadata[];
    onLoadSession: (id: string) => void;
    onOpenHistory: () => void;
    onOpenAccount: () => void;
    grikAccount: GrikAccountController;
    composer: ReactNode;
}) {
    const recentSessions = useMemo(
        () => [...sessions].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)).slice(0, 4),
        [sessions]
    );

    const getRelativeTime = (timestamp?: number) => {
        if (!timestamp) return '';
        const diff = Date.now() - timestamp;
        const hours = Math.floor(diff / 3600000);
        if (hours < 1) return 'Just now';
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    };

    return (
        <div className="min-h-full h-full px-4 py-3 flex flex-col gap-2">
            <div className="flex-1 min-h-[340px] flex items-center">
                <div className="w-full max-w-4xl mx-auto">
                    <div className="mb-2 flex items-end justify-between gap-3">
                        <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <h1 className="min-w-0 text-[21px] leading-tight font-semibold text-vscode-fg/88 tracking-normal truncate">
                                    {workspaceName || 'Project'}
                                </h1>
                                <AccountBadge account={grikAccount} onOpenAccount={onOpenAccount} />
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-[10.5px] leading-none text-vscode-fg/38">
                                <span>Ricochet</span>
                                <span className="text-vscode-fg/22">/</span>
                                <span className="truncate">{grikAccount.summary.detail}</span>
                            </div>
                        </div>
                    </div>

                    {composer}
                </div>
            </div>

            <div className="w-full max-w-4xl mx-auto shrink-0 pb-1">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-wide text-vscode-fg/36 font-medium">
                        <Clock3 className="w-3 h-3" />
                        Recent
                    </div>
                    <button
                        onClick={onOpenHistory}
                        className="h-5 px-1.5 inline-flex items-center gap-1 rounded hover:bg-vscode-list-hoverBackground text-[10px] text-vscode-fg/48 hover:text-vscode-fg/70 transition-colors"
                        title="Open full history"
                    >
                        <History className="w-3 h-3" />
                        History
                    </button>
                </div>

                {recentSessions.length > 0 ? (
                    <div className="space-y-0.5">
                        {recentSessions.map(session => (
                            <button
                                key={session.id}
                                onClick={() => onLoadSession(session.id)}
                                className="w-full min-h-[28px] flex items-center justify-between gap-3 px-1.5 py-0.5 rounded hover:bg-vscode-list-hoverBackground text-left group transition-colors"
                            >
                                <span className="flex items-center gap-2 min-w-0">
                                    <MessageSquare className="w-3 h-3 shrink-0 text-vscode-fg/30 group-hover:text-vscode-fg/55" />
                                    <span className="text-[11px] text-vscode-fg/58 truncate group-hover:text-vscode-fg/85 transition-colors">
                                        {session.title || 'Untitled chat'}
                                    </span>
                                </span>
                                <span className="flex items-center gap-2.5 shrink-0 text-[10px] leading-none text-vscode-fg/34">
                                    <span>{session.messageCount || 0} msgs</span>
                                    <span className="font-mono">{getRelativeTime(session.lastModified)}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="px-1.5 py-2 text-[11px] text-vscode-fg/38">
                        No previous sessions yet.
                    </div>
                )}
            </div>
        </div>
    );
}

function TodoTracker({ todos }: { todos: any[] }) {
    if (!todos || todos.length === 0) return null;
    return null;
}
