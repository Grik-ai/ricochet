import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Circle, Gauge, Loader2 } from 'lucide-react';
import type { TaskRunViewModel } from '../../hooks/useChat';

export function formatTaskTokens(value?: number): string {
    const safe = Math.max(0, value || 0);
    if (safe >= 1_000_000) {
        const rounded = safe / 1_000_000;
        return `${rounded >= 10 ? rounded.toFixed(0) : rounded.toFixed(1)}m`;
    }
    if (safe >= 1_000) {
        const rounded = safe / 1_000;
        return `${rounded >= 100 ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
    }
    return String(safe);
}

function taskStatusTone(status: TaskRunViewModel['status']) {
    if (status === 'completed') return 'text-emerald-300/90 bg-emerald-500/10 border-emerald-400/20';
    if (status === 'waiting') return 'text-amber-200/90 bg-amber-500/10 border-amber-400/20';
    if (status === 'failed') return 'text-rose-200/90 bg-rose-500/10 border-rose-400/20';
    if (status === 'stopped') return 'text-vscode-fg/55 bg-vscode-input-bg/70 border-vscode-border';
    if (status === 'rejected') return 'text-vscode-fg/55 bg-vscode-input-bg/70 border-vscode-border';
    return 'text-blue-200/90 bg-blue-500/10 border-blue-400/20';
}

function taskStatusLabel(status: TaskRunViewModel['status']) {
    switch (status) {
        case 'completed': return 'Completed';
        case 'waiting': return 'Waiting';
        case 'failed': return 'Attention';
        case 'stopped': return 'Stopped';
        case 'rejected': return 'Rejected';
        default: return 'Working';
    }
}

function modeLabel(mode: TaskRunViewModel['mode']) {
    switch (mode) {
        case 'planning': return 'Planning';
        case 'verification': return 'Verifying';
        default: return 'Implementing';
    }
}

function modeTitle(mode: TaskRunViewModel['mode']) {
    return `Runtime mode: ${mode || 'execution'}`;
}

function workerStatusTone(status: string) {
    if (/failed|error|cancelled|stopped|timeout/i.test(status)) return 'text-rose-300/80';
    if (/done|complete|completed|success|succeeded/i.test(status)) return 'text-emerald-300/80';
    if (/queued|pending|waiting/i.test(status)) return 'text-amber-200/80';
    return 'text-blue-300/80';
}

function workerStatusLabel(status: string) {
    const normalized = (status || '').replace(/[_-]+/g, ' ').trim();
    if (!normalized) return 'Unknown';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function TaskRunHeader({
    taskRun,
    onOpenAgent,
}: {
    taskRun: TaskRunViewModel | null;
    onOpenAgent?: () => void;
}) {
    const [expanded, setExpanded] = useState(taskRun?.status !== 'completed');
    const [workersOpen, setWorkersOpen] = useState(Boolean(taskRun?.workers?.length && taskRun.status === 'failed'));
    const [thinkingOpen, setThinkingOpen] = useState(false);

    useEffect(() => {
        if (taskRun?.status === 'completed' || taskRun?.status === 'rejected') {
            setExpanded(false);
            setWorkersOpen(false);
            setThinkingOpen(false);
        } else if (taskRun?.status === 'failed' && taskRun.workers?.length) {
            setWorkersOpen(true);
        }
    }, [taskRun?.status, taskRun?.title, taskRun?.workers?.length]);

    const tokenLabel = useMemo(() => {
        if (!taskRun) return '';
        const { tokenUsage } = taskRun;
        if (tokenUsage.max > 0) {
            return `${formatTaskTokens(tokenUsage.used)} / ${formatTaskTokens(tokenUsage.max)}`;
        }
        if (tokenUsage.totalTokens > 0) {
            return `${formatTaskTokens(tokenUsage.totalTokens)} tokens`;
        }
        return taskRun.isActive ? 'tokens pending' : '';
    }, [taskRun]);

    if (!taskRun) return null;

    const hasChecklist = taskRun.totalChecklistCount > 0;
    const workers = taskRun.workers || [];
    const hasWorkers = workers.length > 0;
    const isAllDone = taskRun.status === 'completed' && hasChecklist && taskRun.completedChecklistCount === taskRun.totalChecklistCount;
    const progressLabel = hasChecklist
        ? `${taskRun.completedChecklistCount}/${taskRun.totalChecklistCount}`
        : taskStatusLabel(taskRun.status);
    const barPercent = taskRun.tokenUsage.percent > 0
        ? taskRun.tokenUsage.percent
        : taskRun.isActive ? 4 : 0;
    const statusTone = taskStatusTone(taskRun.status);
    const displayStatusText = taskRun.attentionReason || taskRun.statusText || (taskRun.isActive ? 'Reading project context...' : '');
    const showSourceHint = Boolean((import.meta as any).env?.DEV) && taskRun.checklistSource !== 'none';
    const handleAttentionAction = () => {
        const action = taskRun.attentionAction;
        if (!action) return;
        if (action.kind === 'open_agent') {
            onOpenAgent?.();
            if (!onOpenAgent) setWorkersOpen(true);
            return;
        }
        if (action.kind === 'review_request') {
            document
                .querySelector('[data-ricochet-permission-list], [data-ricochet-inline-edit-approval]')
                ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
        }
        if (hasChecklist) setExpanded(true);
        if (hasWorkers) setWorkersOpen(true);
        if (taskRun.reasoningText) setThinkingOpen(true);
    };

    return (
        <div className="shrink-0 border-b border-vscode-border bg-vscode-editor-background/96 px-3 py-2">
            <div className="mx-auto max-w-4xl">
                <div className="px-1 py-1">
                    <div className="flex min-w-0 items-start gap-2.5">
                        <div className={`mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-full border px-1.5 text-[11px] font-semibold ${statusTone}`}>
                            {hasChecklist ? progressLabel : taskRun.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : progressLabel}
                        </div>

                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <h2 className="min-w-0 truncate text-[13px] font-semibold leading-5 text-vscode-fg/86">
                                    {taskRun.title}
                                </h2>
                                <span
                                    className="rounded border border-vscode-border bg-vscode-editor-background/55 px-1.5 py-0.5 text-[9.5px] font-medium tracking-normal text-vscode-fg/42"
                                    title={modeTitle(taskRun.mode)}
                                >
                                    {modeLabel(taskRun.mode)}
                                </span>
                                {isAllDone && (
                                    <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-300/80">
                                        <Check className="h-3 w-3" />
                                        All tasks completed
                                    </span>
                                )}
                                {showSourceHint && (
                                    <span className="text-[9.5px] text-vscode-fg/24">
                                        source: {taskRun.checklistSource === 'todo' ? 'agent todos' : taskRun.checklistSource}
                                    </span>
                                )}
                            </div>
                            {displayStatusText && (
                                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-5 text-vscode-fg/48">
                                    {taskRun.isActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400/75 animate-pulse" />}
                                    <span className="min-w-0 truncate">{displayStatusText}</span>
                                </div>
                            )}
                        </div>

                        <div className="flex min-w-[128px] max-w-[190px] shrink-0 flex-col items-end gap-1 pt-0.5">
                            <div className="flex w-full items-center justify-end gap-1.5 font-mono text-[10.5px] text-vscode-fg/58">
                                <Gauge className="h-3 w-3 shrink-0 text-vscode-fg/38" />
                                <span className="truncate">{tokenLabel || 'no usage yet'}</span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-vscode-editor-background">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${taskRun.status === 'completed' ? 'bg-emerald-400/65' : 'bg-blue-400/70'}`}
                                    style={{ width: `${Math.max(0, Math.min(100, barPercent))}%` }}
                                />
                            </div>
                        </div>
                    </div>

                    {(hasChecklist || hasWorkers || taskRun.reasoningText || taskRun.attentionAction) && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            {taskRun.attentionAction && (
                                <button
                                    type="button"
                                    onClick={handleAttentionAction}
                                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-blue-300/80 hover:bg-vscode-list-hoverBackground/45 hover:text-blue-200"
                                >
                                    {taskRun.attentionAction.label}
                                </button>
                            )}
                            {hasChecklist && (
                                <button
                                    type="button"
                                    onClick={() => setExpanded(open => !open)}
                                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] font-medium text-vscode-fg/48 hover:bg-vscode-list-hoverBackground/45 hover:text-vscode-fg/72"
                                >
                                    {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                    Task steps
                                </button>
                            )}
                            {hasWorkers && (
                                <button
                                    type="button"
                                    onClick={() => setWorkersOpen(open => !open)}
                                    className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[10.5px] font-medium text-vscode-fg/48 hover:bg-vscode-list-hoverBackground/45 hover:text-vscode-fg/72"
                                >
                                    {workersOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                                    <span className="min-w-0 truncate">{taskRun.workerSummary || `${workers.length} workers`}</span>
                                </button>
                            )}
                            {taskRun.reasoningText && (
                                <button
                                    type="button"
                                    onClick={() => setThinkingOpen(open => !open)}
                                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] font-medium text-vscode-fg/48 hover:bg-vscode-list-hoverBackground/45 hover:text-vscode-fg/72"
                                >
                                    {thinkingOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                    Thinking
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {hasChecklist && expanded && (
                    <div className="mt-1 border-t border-vscode-border/55 px-1 py-2">
                        <div className="grid gap-1">
                            {taskRun.checklist.map((item, index) => {
                                const done = item.status === 'completed';
                                const skipped = item.status === 'cancelled';
                                const current = item.status === 'current';
                                return (
                                    <div key={`${item.text}-${index}`} className="flex min-w-0 items-start gap-2 rounded px-1 py-0.5 text-[11.5px] leading-5">
                                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${done ? 'text-emerald-300/80' : current ? 'text-blue-300/85' : skipped ? 'text-vscode-fg/30' : 'text-vscode-fg/30'}`}>
                                            {done ? <Check className="h-3.5 w-3.5" /> : current ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Circle className="h-3 w-3" />}
                                        </span>
                                        <span className={`min-w-0 ${done ? 'text-vscode-fg/43 line-through decoration-vscode-fg/30' : skipped ? 'text-vscode-fg/35 line-through decoration-vscode-fg/20' : current ? 'text-vscode-fg/82 font-medium' : 'text-vscode-fg/56'}`}>
                                            {item.text}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        {isAllDone && (
                            <div className="mt-2 text-[10.5px] font-medium text-vscode-fg/38">
                                New steps will be generated if the task continues.
                            </div>
                        )}
                    </div>
                )}

                {hasWorkers && workersOpen && (
                    <div className="mt-1 border-t border-vscode-border/55 px-1 py-2">
                        <div className="grid gap-1">
                            {workers.map((worker) => {
                                const status = worker.status || 'unknown';
                                const failed = /failed|error|cancelled|stopped|timeout/i.test(status);
                                const done = /done|complete|completed|success|succeeded/i.test(status);
                                const active = worker.isActive || /queued|running|in progress|active/i.test(status);
                                return (
                                    <div key={worker.id} className="flex min-w-0 items-start gap-2 rounded px-1 py-0.5 text-[11.5px] leading-5">
                                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${workerStatusTone(status)}`}>
                                            {done ? <Check className="h-3.5 w-3.5" /> : active && !failed ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Circle className="h-3 w-3" />}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-vscode-fg/74">
                                            {worker.name}
                                        </span>
                                        <span className={`shrink-0 text-[10.5px] ${workerStatusTone(status)}`}>
                                            {workerStatusLabel(status)}
                                        </span>
                                        {worker.progress && (
                                            <span className="min-w-0 flex-[2] truncate text-[10.5px] text-vscode-fg/42">
                                                {worker.progress}
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {taskRun.reasoningText && thinkingOpen && (
                    <div className="mt-1 border-t border-vscode-border/55 px-1 py-3">
                        <pre className="custom-scrollbar max-h-[180px] overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.55] text-vscode-fg/58">
                            {taskRun.reasoningText}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}
