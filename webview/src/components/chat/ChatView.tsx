import { useRef, useMemo, useEffect, useState, type ReactNode } from 'react';
import { buildTaskRunViewModel, useChat } from '../../hooks/useChat';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { useLiveMode } from '../../hooks/useLiveMode';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { useSessions } from '../../hooks/useSessions';
import { MissionWidget } from './MissionWidget';
import { useAgentStateMachine } from '../../hooks/useAgentStateMachine';
import { SessionState } from '../../services/state-machine/sessionStateMachine';
import { useNetworkHealth } from '../../hooks/useNetworkHealth';
import { Clock3, History, Loader2, MessageSquare, UserCircle } from 'lucide-react';
import { PermissionRequestPanel } from './PermissionRequestPanel';
import { cleanAssistantVisibleText, isRenderableChatMessage } from '../../utils/chatVisibility';
import { findRetryPromptBefore } from '../../utils/chatErrors';
import { TaskRunHeader } from './TaskRunHeader';
import { CheckpointPanel } from '../checkpoints/CheckpointPanel';
import { deriveMissionRuntime } from '../../utils/missionRuntime';
import type { ContextFilePayload } from '../../types/protocol';
import type { SessionMetadata } from '../../types/session';

export interface ChatViewProps {
    onOpenHistory: () => void;
    onOpenAgent: () => void;
    onOpenAccount: () => void;
    agentState: ReturnType<typeof useAgentStateMachine>;
    mode: 'plan' | 'act' | 'mission';
    onModeChange: (mode: 'plan' | 'act' | 'mission') => void;
    model: { id: string; name: string; provider: string };
    onModelChange: (model: { id: string; name: string; provider: string }) => void;
}

export function ChatView({
    onOpenHistory,
    onOpenAgent,
    onOpenAccount,
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
        fileResults,
        searchFiles,
        pendingPermissions,
        pendingEdits,
        respondToPermission,
        restoreCheckpoint
    } = useChat(currentSessionId);

    const { status: liveStatus, toggleLiveMode } = useLiveMode();
    const scrollRef = useRef<HTMLDivElement>(null);
    const { onMessage, postMessage } = useVSCodeApi();
    const [workspaceName, setWorkspaceName] = useState('Project');
    const visibleMessages = useMemo(() => messages.filter(isRenderableChatMessage), [messages]);
    const messageRows = useMemo(() => {
        const renderedSummaryKeys = new Set<string>();

        const rows = visibleMessages.flatMap((message) => {
            let workSummary: (typeof workSummariesByTurn)[string] | undefined;

            if (message.role === 'assistant') {
                const summaryKey = message.run_id || message.turn_id || message.id;
                const candidate = workSummariesByTurn[summaryKey];
                if (candidate && !renderedSummaryKeys.has(summaryKey)) {
                    workSummary = candidate;
                    renderedSummaryKeys.add(summaryKey);
                }

                const hasVisibleAssistantContent = Boolean(
                    cleanAssistantVisibleText(message.content || '') ||
                    message.errorInfo ||
                    message.checkpointHash ||
                    (Array.isArray((message as any).artifacts) && (message as any).artifacts.length > 0)
                );

                if (!hasVisibleAssistantContent && !workSummary) {
                    return [];
                }
            }

            return [{ message, workSummary }];
        });

        Object.values(workSummariesByTurn)
            .filter(summary => !renderedSummaryKeys.has(summary.turnId))
            .sort((a, b) => a.startedAt - b.startedAt)
            .forEach(summary => {
                renderedSummaryKeys.add(summary.turnId);
                rows.push({
                    message: {
                        id: `work-summary-${summary.turnId}`,
                        role: 'assistant' as const,
                        content: '',
                        timestamp: summary.startedAt,
                        run_id: summary.turnId,
                        turn_id: summary.turnId,
                    },
                    workSummary: summary,
                });
            });

        return rows;
    }, [visibleMessages, workSummariesByTurn]);

    const pendingInteractionList = useMemo(() => Object.values(pendingPermissions), [pendingPermissions]);
    const hasInlineEditApproval = pendingEdits.length > 0;
    const pendingPermissionList = useMemo(
        () => pendingInteractionList.filter((request: any) => request.kind !== 'choice' && !(hasInlineEditApproval && /edit|file|write|save|apply|diff/i.test(request.question || ''))),
        [hasInlineEditApproval, pendingInteractionList]
    );
    const pendingChoice = useMemo(
        () => pendingInteractionList.find((request: any) => request.kind === 'choice') || null,
        [pendingInteractionList]
    );
    const activeWorkSummary = useMemo(() => {
        return Object.values(workSummariesByTurn).find(summary => summary.status === 'running' || summary.status === 'waiting') || null;
    }, [workSummariesByTurn]);
    const taskRunWorkers = useMemo(() => {
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
    }, [agentState.context.workers]);

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

    const handleSend = (text?: string, contextFiles?: ContextFilePayload[]) => {
        const msg = typeof text === 'string' ? text : inputValue;
        if (!msg.trim()) return;

        sendMessage(msg, contextFiles, mode === 'plan');
    };

    const handleStartAgent = (text?: string, contextFiles?: ContextFilePayload[]) => {
        const msg = typeof text === 'string' ? text : inputValue;
        if (!msg.trim()) return;

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
        const runningTool = Object.values(agentState.context.activeToolCalls || {}).some((tool: any) => tool.status === 'running');
        const waitingForInput = Boolean(agentState.context.pendingChoice || agentState.context.pendingTool);
        const explicitMissionActive = Boolean(agentState.context.missionTitle) && agentState.uiState.isActive && agentState.context.missionStatus !== 'completed' && agentState.context.missionStatus !== 'failed' && agentState.context.missionStatus !== 'stopped';

        return isLoading ||
            isStopping ||
            pendingInteractionList.length > 0 ||
            Boolean(taskProgress?.is_active) ||
            Boolean(activeWorkSummary) ||
            activeWorker ||
            runningTool ||
            waitingForInput ||
            explicitMissionActive;
    }, [
        agentState.context.activeToolCalls,
        agentState.context.missionStatus,
        agentState.context.missionTitle,
        agentState.context.pendingChoice,
        agentState.context.pendingTool,
        agentState.uiState.isActive,
        isLoading,
        isStopping,
        pendingInteractionList.length,
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
    const missionRuntime = useMemo(
        () => deriveMissionRuntime(agentState.context, agentState.state, agentState.uiState),
        [agentState.context, agentState.state, agentState.uiState]
    );

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
            onToggleLiveMode={toggleLiveMode}
            currentMode={mode}
            onModeChange={onModeChange}
            currentModel={model}
            onModelChange={onModelChange}
            sessionId={currentSessionId || undefined}
            pendingEdits={activeWorkSummary ? [] : pendingEdits}
            pendingChoice={pendingChoice}
            onChoiceResponse={respondToPermission}
            contextStatus={taskRun ? null : contextStatus}
            usageSnapshot={taskRun ? null : usageSnapshot}
            networkStatus={networkStatus}
            missionStatus={missionRuntime.shouldShowPill && agentState.state !== SessionState.idle ? (
                <MissionWidget agentState={agentState} onOpenDashboard={onOpenAgent} inline />
            ) : null}
        />
    );

    return (
            <div className="flex flex-col h-full bg-vscode-editor-background text-vscode-fg overflow-hidden selection:bg-vscode-editor-selectionBackground">
            <div className="flex-1 min-h-0 flex flex-col relative z-0">
                <CheckpointPanel onRestore={restoreCheckpoint} />
                <TaskRunHeader taskRun={taskRun} onOpenAgent={onOpenAgent} />
                {!taskRun && !taskProgress && !agentState.context.sessionId && <TodoTracker todos={todos} />}
                {pendingPermissionList.length > 0 && (
                    <div className="shrink-0" data-ricochet-permission-list>
                        {pendingPermissionList.map((request: any) => (
                            <PermissionRequestPanel
                                key={request.id}
                                request={request}
                                onResponse={respondToPermission}
                                inline
                            />
                        ))}
                    </div>
                )}

                <div className="flex-1 min-h-0 custom-scrollbar overflow-y-auto">
                    {visibleMessages.length === 0 ? (
                        <EmptyChatLauncher
                            workspaceName={workspaceName}
                            sessions={sessions}
                            onLoadSession={loadSession}
                            onOpenHistory={onOpenHistory}
                            onOpenAccount={onOpenAccount}
                            composer={composer}
                        />
                    ) : (
                        <div ref={scrollRef} className="max-w-4xl mx-auto w-full px-4 space-y-2 py-8">
                            {messageRows.map(({ message, workSummary }) => {
                                const retryPrompt = message.errorInfo?.retryable
                                    ? findRetryPromptBefore(visibleMessages, message)
                                    : null;
                                return (
                                    <div key={message.id} className="animate-in fade-in duration-500 slide-in-from-bottom-2">
                                        <ChatMessage
                                            message={message}
                                            workSummary={workSummary}
                                            pendingPermissions={pendingPermissions}
                                            pendingEdits={pendingEdits}
                                            onRespondToPermission={respondToPermission}
                                            onRestore={restoreCheckpoint}
                                            onRetryMessage={retryPrompt ? () => sendMessage(retryPrompt) : undefined}
                                            onExecuteCommand={(cmd) => postMessage({ type: 'execute_command', payload: { command: cmd } })}
                                            onSendMessage={(content) => sendMessage(content)}
                                        />
                                    </div>
                                );
                            })}

                            {/* Thinking State */}
                            {isLoading && !activeWorkSummary && (!visibleMessages[visibleMessages.length - 1]?.isStreaming) && (
                                <div className="px-5 py-4 animate-pulse flex flex-col gap-3 group">
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
                                    <div className="ml-12 h-[1px] w-32 bg-vscode-border" />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {visibleMessages.length > 0 && (
            <div className="p-3 bg-vscode-editor-background border-t border-vscode-border">
                <div className="max-w-4xl mx-auto">
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
    composer
}: {
    workspaceName: string;
    sessions: SessionMetadata[];
    onLoadSession: (id: string) => void;
    onOpenHistory: () => void;
    onOpenAccount: () => void;
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
                            <h1 className="text-[21px] leading-tight font-semibold text-vscode-fg/88 tracking-normal truncate">
                                {workspaceName || 'Project'}
                            </h1>
                            <div className="mt-1 text-[10.5px] leading-none text-vscode-fg/38">
                                Ricochet
                            </div>
                        </div>
                        <button
                            onClick={onOpenAccount}
                            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-vscode-border bg-vscode-input-bg hover:bg-vscode-list-hoverBackground text-vscode-fg/65 transition-colors"
                            title="Open Grik account"
                            aria-label="Open Grik account"
                        >
                            <UserCircle className="w-3.5 h-3.5" />
                        </button>
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
