import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, BellRing, Boxes, Brain, CheckCircle2, ChevronDown, ChevronLeft, CircleDot, Cpu, FileText, LayoutGrid, MessageSquare, RefreshCw, StopCircle, Terminal, Users } from 'lucide-react';
import { useAgentStateMachine } from '../../hooks/useAgentStateMachine';
import { SessionState, type AgentLogEntry, type SessionContext, type WorkerState } from '../../services/state-machine/sessionStateMachine';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { useUsage } from '../../hooks/useUsage';
import { AgentLog } from './AgentLog';
import { ModelPickerModal } from '../chat/ModelPickerModal';
import { BatchDashboard } from './BatchDashboard';
import { deriveMissionRuntime } from '../../utils/missionRuntime';
import { KanbanBoard } from '../kanban/KanbanBoard';

export interface AgentViewProps {
    agentState: ReturnType<typeof useAgentStateMachine>;
    mode: 'plan' | 'act' | 'mission';
    onModeChange: (mode: 'plan' | 'act' | 'mission') => void;
    model: { id: string; name: string; provider: string };
    onModelChange: (model: { id: string; name: string; provider: string }) => void;
    onBack: () => void;
}

export type MissionDashboardTab = 'tasks' | 'events' | 'hub' | 'batch';
export const DEFAULT_MISSION_DASHBOARD_TAB: MissionDashboardTab = 'tasks';

export function AgentView({
    agentState,
    model,
    onModelChange,
    onBack
}: AgentViewProps) {
    const { state, uiState, context, send, reset } = agentState;
    const { postMessage } = useVSCodeApi();
    const [prompt, setPrompt] = useState('');
    const [showModelPicker, setShowModelPicker] = useState(false);
    const [activeTab, setActiveTab] = useState<MissionDashboardTab>(DEFAULT_MISSION_DASHBOARD_TAB);
    const { usageSnapshot, contextStatus } = useUsage(context.sessionId || null);
    const runtime = deriveMissionRuntime(context, state, uiState);

    const workers = Object.values(context.workers);
    const missionTitle = prompt || context.missionTitle || context.logs.find(log => log.type === 'assistant_text')?.content || 'Active mission';
    const contextTokens = usageSnapshot?.contextTokens || contextStatus?.tokens_used || 0;
    const contextWindow = usageSnapshot?.contextWindow || contextStatus?.tokens_max || 0;
    const contextPercent = contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 100) : Math.round(contextStatus?.percentage || 0);
    const hasUsageTotals = Boolean(usageSnapshot && (usageSnapshot.requestCount > 0 || usageSnapshot.inputTokens > 0 || usageSnapshot.outputTokens > 0 || usageSnapshot.estimatedCostUsd > 0));
    const hubSections = buildMissionHubSections(context);

    const handleStart = () => {
        if (!prompt.trim()) return;
        send({ type: 'start_session', content: prompt });
        postMessage({
            type: 'start_session',
            payload: {
                prompt,
                model: model.id,
                provider: model.provider
            }
        });
    };

    const handleCancel = () => {
        send({ type: 'cancel_session' });
        postMessage({ type: 'cancel_session' });
    };

    return (
        <div className="h-full flex flex-col bg-sidebar-background text-foreground selection:bg-selection/30 overflow-hidden">
            <header className="shrink-0 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <button onClick={onBack} className="p-1 hover:bg-list-background-hover rounded text-foreground/55 hover:text-foreground transition-colors" title="Back to chat">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <h1 className="text-[12px] font-medium text-foreground/80 truncate">
                            {state === SessionState.idle ? 'Mission Dashboard' : missionTitle}
                        </h1>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                        {state !== SessionState.idle && (
                            <span className={`rounded-md px-2 py-1 text-[10px] font-medium ${runtime.hasActiveWork ? 'bg-button-background text-button-foreground' : 'bg-vscode-border/20 text-foreground/60'}`}>
                                {runtime.displayStatus}
                            </span>
                        )}
                        {state === SessionState.idle ? (
                            <button onClick={() => setShowModelPicker(true)} className="flex items-center gap-2 px-2 py-1 bg-transparent hover:bg-list-background-hover rounded transition-colors">
                                <Brain className="w-3 h-3 text-foreground/45" />
                                <span className="text-[10px] font-medium text-foreground/70 truncate max-w-[96px]">{model.name}</span>
                                <ChevronDown className="w-3 h-3 opacity-35" />
                            </button>
                        ) : (
                            <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-foreground/50" title="Model used for this mission">
                                <Brain className="w-3 h-3" />
                                <span className="max-w-[120px] truncate">{model.name}</span>
                            </div>
                        )}
                    </div>
                </div>

                {state !== SessionState.idle && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-foreground/45">
                        <MetricPill icon={<Activity className="h-3 w-3" />} text={runtime.detail} strong />
                        <MetricPill text={contextWindow > 0 ? `${formatAgentUsageTokens(contextTokens)} / ${formatAgentUsageTokens(contextWindow)} ctx${contextPercent > 0 ? ` · ${contextPercent}%` : ''}` : 'Context pending'} />
                        <MetricPill text={hasUsageTotals
                            ? `${formatAgentUsageTokens(usageSnapshot?.inputTokens)} in · ${formatAgentUsageTokens(usageSnapshot?.outputTokens)} out · ${formatAgentUsageCost(usageSnapshot?.estimatedCostUsd)} ${usageSnapshot?.source === 'actual' ? 'actual' : 'est'}`
                            : runtime.hasActiveWork ? 'Usage pending' : 'No model usage yet'}
                        />
                        {runtime.hasWorkers && <MetricPill icon={<Users className="h-3 w-3" />} text={`${runtime.activeWorkerCount} running · ${runtime.queuedWorkerCount} queued · ${runtime.completedWorkerCount} done`} />}
                    </div>
                )}
            </header>

            <AnimatePresence mode="wait">
                {state === SessionState.idle ? (
                    <motion.div key="setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col items-center justify-center p-6 max-w-lg mx-auto w-full gap-6">
                        <div className="w-full space-y-4">
                            <div className="space-y-1">
                                <h2 className="text-sm font-semibold text-foreground/80">Autonomous Goal</h2>
                                <p className="text-[11px] text-foreground/45">Define what the agent should accomplish autonomously.</p>
                            </div>

                            <div className="relative bg-input-background border border-input-border rounded p-3">
                                <textarea
                                    className="w-full bg-transparent p-0 text-[13px] text-input-foreground focus:outline-none min-h-[120px] resize-none placeholder:text-input-placeholder"
                                    placeholder="e.g., Analyze the project and run specialized agents..."
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                />
                                <div className="flex items-center justify-between mt-3 pt-3 border-t border-vscode-border/30">
                                    <div className="flex items-center gap-1.5 px-2 py-0.5 bg-vscode-border/5 rounded">
                                        <Cpu className="w-3 h-3 text-foreground/25" />
                                        <span className="text-[9px] font-medium text-foreground/40">Autonomous mission</span>
                                    </div>
                                </div>
                            </div>

                            <button
                                className="w-full h-10 bg-button-background hover:bg-button-background-hover text-button-foreground rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                onClick={handleStart}
                                disabled={!prompt.trim()}
                            >
                                <Activity className="w-3.5 h-3.5" />
                                <span className="text-[11px] font-medium">Start Mission</span>
                            </button>
                        </div>
                    </motion.div>
                ) : (
                    <motion.div key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex-1 flex flex-col min-h-0">
                        {runtime.hasActiveWork && (
                            <div className="h-0.5 w-full overflow-hidden bg-vscode-border/20">
                                <motion.div
                                    className="h-full bg-button-background"
                                    initial={{ width: 0 }}
                                    animate={{ width: '72%' }}
                                    transition={{ duration: 1.4, repeat: Infinity }}
                                />
                            </div>
                        )}

                        <div className="flex gap-2 px-3 py-1.5 bg-sidebar-background/60">
                            <button
                                onClick={() => setActiveTab('tasks')}
                                className={`relative flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${activeTab === 'tasks' ? 'text-button-background bg-button-background/10' : 'text-foreground/45 hover:bg-list-background-hover/45 hover:text-foreground/70'}`}
                            >
                                <FileText className="w-3 h-3" />
                                Tasks
                            </button>
                            <button
                                onClick={() => setActiveTab('events')}
                                className={`relative flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${activeTab === 'events' ? 'text-button-background bg-button-background/10' : 'text-foreground/45 hover:bg-list-background-hover/45 hover:text-foreground/70'}`}
                            >
                                <MessageSquare className="w-3 h-3" />
                                Event Log
                            </button>
                            <button
                                onClick={() => setActiveTab('hub')}
                                className={`relative flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${activeTab === 'hub' ? 'text-button-background bg-button-background/10' : 'text-foreground/45 hover:bg-list-background-hover/45 hover:text-foreground/70'}`}
                            >
                                <LayoutGrid className="w-3 h-3" />
                                Hub
                            </button>
                            <button
                                onClick={() => setActiveTab('batch')}
                                className={`relative flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${activeTab === 'batch' ? 'text-button-background bg-button-background/10' : 'text-foreground/45 hover:bg-list-background-hover/45 hover:text-foreground/70'}`}
                            >
                                <Boxes className="w-3 h-3" />
                                Batch
                            </button>
                        </div>

                        {activeTab === 'tasks' ? (
                            <KanbanBoard />
                        ) : activeTab === 'events' ? (
                            <div className="flex-1 flex flex-col lg:flex-row min-h-0 bg-sidebar-background">
                                <div className={`flex flex-col min-h-0 ${workers.length > 0 ? 'flex-[3]' : 'flex-1'}`}>
                                    <AgentLog
                                        logs={context.logs}
                                        state={state}
                                        pendingToolId={context.pendingTool?.id}
                                        pendingChoiceId={context.pendingChoice?.id}
                                        onResponse={(id, answer) => {
                                            send({ type: 'submit_input' });
                                            postMessage({
                                                type: 'permission_response',
                                                payload: { id, answer }
                                            });
                                        }}
                                    />
                                </div>

                                {workers.length > 0 && (
                                    <div className="flex-[1] min-w-[220px] overflow-y-auto px-2 pb-2">
                                        <div className="sticky top-0 bg-sidebar-background/95 px-1 py-2 text-[11px] font-medium text-foreground/55">Workers</div>
                                        <div className="space-y-1">
                                            {workers.map(worker => (
                                                <div key={worker.id} className="rounded-md border border-vscode-border/25 bg-input-background/25 px-2.5 py-2">
                                                    <div className="mb-1 flex items-center justify-between gap-2">
                                                        <span className="truncate text-[11px] font-medium text-foreground/80">{worker.name}</span>
                                                        <WorkerStatus status={worker.status} active={worker.isActive} />
                                                    </div>
                                                    <div className="mb-1 font-mono text-[9px] text-foreground/35">{worker.id}</div>
                                                    {worker.progress && (
                                                        <div className="line-clamp-3 text-[10px] leading-relaxed text-foreground/50">{stripTaskNotification(worker.progress)}</div>
                                                    )}
                                                    {worker.lastResult && worker.status === 'completed' && (
                                                        <div className="mt-1 flex items-center gap-1 text-[10px] text-emerald-400/65">
                                                            <CheckCircle2 className="h-3 w-3" />
                                                            Result available
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : activeTab === 'hub' ? (
                            <MissionHub sections={hubSections} />
                        ) : (
                            <BatchDashboard sessionId={context.sessionId} defaultGoal={missionTitle} />
                        )}

                        {(runtime.canAbort || runtime.isParentOnlyComplete || state === SessionState.completed || state === SessionState.stopped || state === SessionState.error) && (
                            <div className="flex shrink-0 items-center justify-between border-t border-vscode-border/35 bg-sidebar-background px-4 py-3">
                                <div className="text-[10px] text-foreground/35">
                                    {runtime.footerText}
                                </div>
                                <div className="flex gap-2">
                                    {runtime.canAbort && (
                                        <button
                                            className="h-7 px-3 bg-error/10 border border-error/20 text-error text-[10px] font-medium rounded hover:bg-error hover:text-white transition-colors flex items-center gap-1.5"
                                            onClick={handleCancel}
                                        >
                                            <StopCircle className="w-3 h-3" />
                                            Abort
                                        </button>
                                    )}
                                    {(state === SessionState.completed || state === SessionState.stopped || state === SessionState.error) && (
                                        <button
                                            className="h-7 px-3 bg-button-background text-button-foreground text-[10px] font-medium rounded hover:bg-button-background-hover transition-colors flex items-center gap-1.5"
                                            onClick={reset}
                                        >
                                            <RefreshCw className="w-3 h-3" />
                                            Reset Mission
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {showModelPicker && state === SessionState.idle && (
                <ModelPickerModal
                    isOpen={showModelPicker}
                    onClose={() => setShowModelPicker(false)}
                    currentModel={model}
                    onSelectModel={(m) => {
                        onModelChange(m);
                        setShowModelPicker(false);
                        postMessage({ type: 'save_settings', payload: { provider: m.provider, model: m.id } });
                    }}
                />
            )}
        </div>
    );
}

export interface MissionHubItem {
    id: string;
    group: 'pending' | 'workers' | 'tools' | 'activity';
    title: string;
    subtitle?: string;
    status?: string;
    tone?: 'neutral' | 'active' | 'success' | 'warning' | 'error';
}

export interface MissionHubSection {
    id: MissionHubItem['group'];
    title: string;
    items: MissionHubItem[];
}

export function buildMissionHubSections(context: SessionContext): MissionHubSection[] {
    const pendingItems: MissionHubItem[] = [];
    if (context.pendingChoice) {
        pendingItems.push({
            id: `choice-${context.pendingChoice.id}`,
            group: 'pending',
            title: 'User decision required',
            subtitle: context.pendingChoice.question,
            status: 'Waiting',
            tone: 'warning',
        });
    }
    if (context.pendingTool) {
        pendingItems.push({
            id: `tool-approval-${context.pendingTool.id}`,
            group: 'pending',
            title: `Approval: ${formatHubToolName(context.pendingTool.name)}`,
            subtitle: formatHubToolTarget(context.pendingTool.args),
            status: 'Waiting',
            tone: 'warning',
        });
    }

    const workerItems = Object.values(context.workers || {}).map(workerToHubItem);
    const toolItems = Object.values(context.activeToolCalls || {})
        .filter(tool => tool.status === 'running' || tool.status === 'failed')
        .map(tool => ({
            id: `active-tool-${tool.id}`,
            group: 'tools' as const,
            title: formatHubToolName(tool.name),
            subtitle: formatHubToolTarget(tool.args),
            status: tool.status === 'failed' ? 'Failed' : 'Running',
            tone: tool.status === 'failed' ? 'error' as const : 'active' as const,
        }));
    const recentItems = recentActivityItems(context.logs || [], new Set([
        ...pendingItems.map(item => item.title),
        ...workerItems.map(item => item.title),
        ...toolItems.map(item => item.title),
    ]));

    return [
        { id: 'pending', title: 'Pending', items: pendingItems },
        { id: 'workers', title: 'Workers', items: workerItems },
        { id: 'tools', title: 'Active tools', items: toolItems },
        { id: 'activity', title: 'Recent activity', items: recentItems },
    ];
}

function MissionHub({ sections }: { sections: MissionHubSection[] }) {
    const visibleSections = sections.filter(section => section.items.length > 0);
    if (visibleSections.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <div className="max-w-sm rounded-lg border border-vscode-border/25 bg-input-background/20 px-5 py-4 text-center">
                    <LayoutGrid className="mx-auto mb-2 h-5 w-5 text-foreground/35" />
                    <div className="text-[13px] font-medium text-foreground/75">No hub items yet</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-foreground/40">
                        Workers, active tools, approvals, and mission resources will appear here as the run produces them.
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto p-3">
            <div className="grid gap-3 lg:grid-cols-2">
                {visibleSections.map(section => (
                    <section key={section.id} className="min-w-0 rounded-lg bg-input-background/20 p-2.5">
                        <div className="mb-2 flex items-center justify-between">
                            <h2 className="text-[11px] font-medium text-foreground/60">{section.title}</h2>
                            <span className="rounded bg-vscode-border/20 px-1.5 py-0.5 text-[9px] text-foreground/40">{section.items.length}</span>
                        </div>
                        <div className="space-y-1">
                            {section.items.map(item => (
                                <MissionHubRow key={item.id} item={item} />
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}

function MissionHubRow({ item }: { item: MissionHubItem }) {
    return (
        <div className="group flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-list-background-hover/35">
            <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded ${hubToneClass(item.tone)}`}>
                <HubIcon group={item.group} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[12px] font-medium text-foreground/80">{item.title}</span>
                    {item.status && <span className={`shrink-0 text-[10px] ${hubStatusClass(item.tone)}`}>{item.status}</span>}
                </div>
                {item.subtitle && (
                    <div className="mt-0.5 truncate text-[10px] leading-4 text-foreground/40">{item.subtitle}</div>
                )}
            </div>
        </div>
    );
}

function MetricPill({ icon, text, strong = false }: { icon?: ReactNode; text: string; strong?: boolean }) {
    return (
        <span className={`inline-flex min-w-0 items-center gap-1.5 rounded-md bg-input-background/25 px-2 py-1 ${strong ? 'text-foreground/70' : 'text-foreground/45'}`}>
            {icon}
            <span className="truncate">{text}</span>
        </span>
    );
}

function HubIcon({ group }: { group: MissionHubItem['group'] }) {
    switch (group) {
        case 'pending':
            return <BellRing className="h-3 w-3" />;
        case 'workers':
            return <Users className="h-3 w-3" />;
        case 'tools':
            return <Terminal className="h-3 w-3" />;
        case 'activity':
            return <FileText className="h-3 w-3" />;
        default:
            return <CircleDot className="h-3 w-3" />;
    }
}

function workerToHubItem(worker: WorkerState): MissionHubItem {
    const normalized = worker.status.toLowerCase();
    const active = worker.isActive || normalized === 'running' || normalized === 'queued' || normalized === 'in progress';
    return {
        id: `worker-${worker.id}`,
        group: 'workers',
        title: worker.name || worker.id,
        subtitle: stripTaskNotification(worker.progress || worker.lastResult || worker.id),
        status: normalized === 'completed' ? 'Done' : normalized === 'failed' ? 'Failed' : active ? 'Running' : worker.status,
        tone: normalized === 'completed' ? 'success' : normalized === 'failed' ? 'error' : active ? 'active' : 'neutral',
    };
}

function recentActivityItems(logs: AgentLogEntry[], excludeTitles: Set<string>): MissionHubItem[] {
    const seen = new Set<string>();
    const items: MissionHubItem[] = [];
    [...logs].reverse().forEach(log => {
        if (items.length >= 8) return;
        const item = logToHubItem(log);
        if (!item || excludeTitles.has(item.title) || seen.has(`${item.group}:${item.title}:${item.subtitle || ''}`)) return;
        seen.add(`${item.group}:${item.title}:${item.subtitle || ''}`);
        items.push(item);
    });
    return items;
}

function logToHubItem(log: AgentLogEntry): MissionHubItem | null {
    if (log.type === 'tool_started') {
        const name = log.metadata?.name ? formatHubToolName(log.metadata.name) : firstLine(log.content);
        return {
            id: `activity-${log.id}`,
            group: 'activity',
            title: name,
            subtitle: formatHubToolTarget(log.metadata?.args) || firstLine(log.content),
            status: 'Tool',
            tone: 'neutral',
        };
    }
    if (log.type === 'worker_spawned' || log.type === 'worker_running' || log.type === 'worker_completed') {
        return {
            id: `activity-${log.id}`,
            group: 'activity',
            title: firstLine(log.content),
            status: log.type === 'worker_completed' ? 'Done' : 'Worker',
            tone: log.type === 'worker_completed' ? 'success' : 'active',
        };
    }
    if (log.type === 'permission_requested' || log.type === 'choice') {
        return {
            id: `activity-${log.id}`,
            group: 'activity',
            title: firstLine(log.content),
            status: 'Waiting',
            tone: 'warning',
        };
    }
    if (log.type === 'error' || log.type === 'mission_failed') {
        return {
            id: `activity-${log.id}`,
            group: 'activity',
            title: firstLine(log.content),
            status: 'Error',
            tone: 'error',
        };
    }
    return null;
}

function formatHubToolName(name: string): string {
    if (name === 'read_file') return 'Read file';
    if (name === 'list_dir') return 'Explore folder';
    if (name === 'execute_command' || name === 'run_command' || name === 'shell') return 'Run command';
    if (name === 'execute_python') return 'Run Python script';
    if (name === 'write_scratchpad') return 'Save notes';
    if (name === 'start_swarm' || name === 'subagent') return 'Start worker';
    return name.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function formatHubToolTarget(args: any): string {
    if (!args || typeof args !== 'object') return '';
    const target = args.path || args.file || args.dir || args.command || args.query || args.pattern || args.description || args.goal || args.name;
    return target ? String(target) : '';
}

function firstLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function hubToneClass(tone: MissionHubItem['tone']) {
    switch (tone) {
        case 'active':
            return 'bg-button-background/10 text-button-background';
        case 'success':
            return 'bg-emerald-500/10 text-emerald-400/80';
        case 'warning':
            return 'bg-amber-500/10 text-amber-300/85';
        case 'error':
            return 'bg-rose-500/10 text-rose-300/85';
        default:
            return 'bg-vscode-border/20 text-foreground/45';
    }
}

function hubStatusClass(tone: MissionHubItem['tone']) {
    switch (tone) {
        case 'active':
            return 'text-button-background/80';
        case 'success':
            return 'text-emerald-400/75';
        case 'warning':
            return 'text-amber-300/75';
        case 'error':
            return 'text-rose-300/80';
        default:
            return 'text-foreground/35';
    }
}

function formatAgentUsageTokens(tokens?: number): string {
    const value = tokens || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
    return String(value);
}

function formatAgentUsageCost(cost?: number): string {
    const value = cost || 0;
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
}

function WorkerStatus({ status, active }: { status: string; active?: boolean }) {
    const normalized = status.toLowerCase();
    const color = normalized === 'completed'
        ? 'text-emerald-400/75'
        : normalized === 'failed'
            ? 'text-red-400'
            : active || normalized === 'running'
                ? 'text-button-background'
                : 'text-foreground/45';
    return <span className={`shrink-0 text-[9px] font-medium ${color}`}>{status}</span>;
}

function stripTaskNotification(text: string) {
    return text
        .replace(/<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/task-notification>/i, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
