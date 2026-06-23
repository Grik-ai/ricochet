import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Circle, Gauge, Loader2 } from 'lucide-react';
import type { TaskRunViewModel, WorkEvent } from '../../hooks/useChat';

export const REVIEW_REQUEST_TARGET_SELECTOR = [
    '[data-ricochet-pending-approval]',
    '[data-ricochet-permission-list]',
    '[data-ricochet-pending-edit-review]',
    '[data-ricochet-inline-edit-approval]',
].join(', ');

export function focusReviewRequestTarget(doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
    const target = doc?.querySelector(REVIEW_REQUEST_TARGET_SELECTOR) as HTMLElement | null | undefined;
    if (!target) return false;
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    target.focus?.({ preventScroll: true });
    return true;
}

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

function clampPercent(value?: number): number {
    return Math.max(0, Math.min(100, Math.round(value || 0)));
}

export function taskContextFillClass(percent: number): string {
    if (percent >= 90) return 'bg-rose-400/75';
    if (percent >= 70) return 'bg-amber-400/75';
    return 'bg-blue-400/60';
}

export function buildTaskContextDisplay(tokenUsage: TaskRunViewModel['tokenUsage'], isActive = false) {
    const percent = tokenUsage.max > 0
        ? clampPercent((tokenUsage.used / tokenUsage.max) * 100)
        : clampPercent(tokenUsage.percent);

    if (tokenUsage.max > 0) {
        const detail = `${formatTaskTokens(tokenUsage.used)} of ${formatTaskTokens(tokenUsage.max)} tokens`;
        return {
            label: `Run context · ${percent}%`,
            detail,
            percent,
            title: `Current run context window: ${detail}. This is request context usage, not monthly account usage or billing.`,
            ariaLabel: `Run context: ${percent}% used, ${detail}`,
            hasKnownContext: true,
        };
    }

    if (tokenUsage.totalTokens > 0) {
        const detail = `${formatTaskTokens(tokenUsage.totalTokens)} tokens`;
        return {
            label: 'Run context',
            detail,
            percent,
            title: `Current run token usage: ${detail}. This is request usage, not monthly account usage or billing.`,
            ariaLabel: `Run context: ${detail}`,
            hasKnownContext: true,
        };
    }

    return {
        label: isActive ? 'Run context pending' : 'Run context unavailable',
        detail: '',
        percent: 0,
        title: 'Current run context window. This is request context usage, not monthly account usage or billing.',
        ariaLabel: isActive ? 'Run context pending' : 'Run context unavailable',
        hasKnownContext: false,
    };
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

function isReadOnlyAnalysisRun(taskRun: TaskRunViewModel): boolean {
    const text = `${taskRun.title} ${taskRun.statusText} ${taskRun.checklistSource}`.toLowerCase();
    const hasAnalysisSignal = /project analysis|analy[sz]ing|analysis|анализ|проанализ|codebase|кодовую баз|кодовой базы|project files/.test(text);
    if (!hasAnalysisSignal) return false;

    const items = taskRun.workSummary?.items || [];
    const hasMutableActivity = items.some(item => item.type === 'edit'
        || item.type === 'review'
        || item.type === 'approval'
        || item.type === 'worker'
        || item.type === 'error'
        || item.status === 'failed'
        || (item.type === 'command' && !/^(rg|grep|find|ls|cat|sed|head|tail|wc)\b/i.test(item.command || ''))
    );

    return !hasMutableActivity;
}

function modeLabel(taskRun: TaskRunViewModel) {
    if (isReadOnlyAnalysisRun(taskRun)) return 'Analyzing';
    switch (taskRun.mode) {
        case 'planning': return 'Planning';
        case 'verification': return 'Verifying';
        default: return 'Implementing';
    }
}

function modeTitle(taskRun: TaskRunViewModel) {
    if (isReadOnlyAnalysisRun(taskRun)) return 'Runtime mode: analysis';
    return `Runtime mode: ${taskRun.mode || 'execution'}`;
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

export type ActivityTone = 'read' | 'search' | 'command' | 'edit' | 'review' | 'approval' | 'worker' | 'error' | 'other';

export interface ActivityBarView {
    id: string;
    tone: ActivityTone;
    glyph: 'folder' | 'file' | 'search' | 'command' | 'edit' | 'review' | 'approval' | 'worker' | 'error' | 'other';
    height: number;
    width: number;
    label: string;
    title: string;
    active?: boolean;
}

const ACTIVITY_TONE_CLASSES: Record<ActivityTone, string> = {
    read: 'bg-blue-300/55',
    search: 'bg-cyan-300/48',
    command: 'bg-vscode-fg/48',
    edit: 'bg-emerald-300/58',
    review: 'bg-amber-300/68',
    approval: 'bg-amber-300/62',
    worker: 'bg-vscode-fg/38',
    error: 'bg-rose-300/70',
    other: 'bg-vscode-fg/32',
};

export function classifyActivityTone(item: Pick<WorkEvent, 'type' | 'status' | 'error' | 'exitCode'>): ActivityTone {
    if (item.type === 'error' || item.status === 'failed' || item.error || (typeof item.exitCode === 'number' && item.exitCode !== 0)) return 'error';
    if (item.type === 'approval') return 'approval';
    if (item.type === 'worker') return 'worker';
    if (item.type === 'review') return 'review';
    if (item.type === 'edit') return 'edit';
    if (item.type === 'read') return 'read';
    if (item.type === 'search') return 'search';
    if (item.type === 'command' || item.type === 'artifact') return 'command';
    return 'other';
}

function activitySignal(item: WorkEvent): number {
    const durationSignal = typeof item.durationMs === 'number' && item.durationMs > 0 ? item.durationMs / 1000 : 0;
    const textSignal = Math.max(
        item.target?.length || 0,
        item.path?.length || 0,
        item.command?.length || 0,
        item.resultPreview?.length || 0,
        item.error?.length || 0,
    ) / 80;
    const editSignal = ((item.additions || 0) + (item.deletions || 0)) / 20;
    const countSignal = ((item.counts?.files || 0) + (item.counts?.folders || 0) + (item.counts?.results || 0)) / 5;
    return Math.max(durationSignal, textSignal, editSignal, countSignal, 1);
}

function activityBarHeight(signal: number): number {
    const bounded = Math.max(1, Math.min(64, signal));
    const ratio = Math.log1p(bounded) / Math.log1p(64);
    return Math.round(8 + ratio * 18);
}

function activityDurationMs(item: WorkEvent, next?: WorkEvent): number {
    if (typeof item.durationMs === 'number' && item.durationMs > 0) return item.durationMs;
    if (typeof item.startedAt === 'number' && typeof item.completedAt === 'number' && item.completedAt > item.startedAt) {
        return item.completedAt - item.startedAt;
    }
    if (next?.timestamp && item.timestamp && next.timestamp > item.timestamp) {
        return next.timestamp - item.timestamp;
    }
    return 1000;
}

function activityBarWidth(durationMs: number): number {
    void durationMs;
    return 10;
}

function activityGlyph(item: WorkEvent, tone: ActivityTone): ActivityBarView['glyph'] {
    if (tone === 'error') return 'error';
    if (item.type === 'search') return 'search';
    if (item.type === 'command' || item.type === 'artifact') return 'command';
    if (item.type === 'edit') return 'edit';
    if (item.type === 'review') return 'review';
    if (item.type === 'approval') return 'approval';
    if (item.type === 'worker') return 'worker';
    if (item.type === 'read' && (item.label === 'Explored' || item.entries?.length || item.counts?.folders)) return 'folder';
    if (item.type === 'read') return 'file';
    return 'other';
}

function formatDuration(ms?: number): string {
    if (!ms || ms <= 0) return '';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${remainder}s`;
}

function estimateTextTokens(text?: string): number {
    const normalized = (text || '').trim();
    if (!normalized) return 0;
    return Math.max(1, Math.round(normalized.length / 4));
}

function activitySizeLabel(item: WorkEvent): string {
    const tokenEstimate = estimateTextTokens([item.resultPreview, item.script, item.command, item.target, item.path].filter(Boolean).join('\n'));
    const countParts = [
        item.counts?.files ? `${item.counts.files} files` : '',
        item.counts?.folders ? `${item.counts.folders} folders` : '',
        item.counts?.results ? `${item.counts.results} results` : '',
    ].filter(Boolean);
    const editParts = [
        item.additions ? `+${item.additions}` : '',
        item.deletions ? `-${item.deletions}` : '',
    ].filter(Boolean);
    if (editParts.length) countParts.push(editParts.join(' / '));
    if (tokenEstimate > 0) countParts.push(`~${formatTaskTokens(tokenEstimate)} event size`);
    return countParts.join(' · ');
}

function activityTitle(item: WorkEvent, next?: WorkEvent): string {
    const duration = formatDuration(activityDurationMs(item, next));
    const size = activitySizeLabel(item);
    const target = item.path || item.target || '';
    const command = item.command && item.command !== target ? item.command : '';
    const details = [
        item.status && item.status !== 'completed' ? item.status : '',
        duration ? `duration ${duration}` : '',
        size,
    ].filter(Boolean).join(' · ');
    const secondary = [
        target ? `Path ${target}` : '',
        command ? `Command ${command}` : '',
        item.exitCode !== undefined ? `Exit ${item.exitCode}` : '',
        item.error ? `Error ${item.error}` : '',
    ].filter(Boolean);
    return [
        `${item.label || item.type}${details ? ` · ${details}` : ''}`,
        ...secondary,
    ].join('\n');
}

export function buildActivityBars(items: WorkEvent[], limit = 96): ActivityBarView[] {
    const scopedItems = items.slice(-limit);
    const latestActiveIndex = scopedItems.reduce((latest, item, index) => {
        const activeWaiting = item.status === 'waiting' && (item.type === 'approval' || item.type === 'edit' || item.type === 'review');
        if (item.status !== 'running' && !activeWaiting) return latest;
        return index;
    }, -1);
    return scopedItems.map((item, index) => {
        const label = item.label || item.type;
        const durationMs = activityDurationMs(item, scopedItems[index + 1]);
        return {
            id: item.id || `${item.type}-${item.timestamp || index}-${index}`,
            tone: classifyActivityTone(item),
            glyph: activityGlyph(item, classifyActivityTone(item)),
            height: activityBarHeight(activitySignal(item)),
            width: activityBarWidth(durationMs),
            label,
            title: activityTitle(item, scopedItems[index + 1]),
            active: index === latestActiveIndex,
        };
    });
}

function formatTaskCost(value?: number): string {
    const safe = Math.max(0, value || 0);
    if (safe === 0) return '$0.00';
    if (safe < 0.01) return `$${safe.toFixed(4)}`;
    return `$${safe.toFixed(2)}`;
}

function taskTokenBreakdown(tokenUsage: TaskRunViewModel['tokenUsage']): Array<{ label: string; value: string; hidden?: boolean }> {
    return [
        { label: 'Context', value: tokenUsage.max > 0 ? `${formatTaskTokens(tokenUsage.used)} / ${formatTaskTokens(tokenUsage.max)}` : formatTaskTokens(tokenUsage.used), hidden: tokenUsage.used <= 0 && tokenUsage.max <= 0 },
        { label: 'Available', value: formatTaskTokens(tokenUsage.availableTokens), hidden: tokenUsage.availableTokens === undefined },
        { label: 'Reserved output', value: formatTaskTokens(tokenUsage.reservedOutputTokens), hidden: tokenUsage.reservedOutputTokens === undefined },
        { label: 'Input', value: formatTaskTokens(tokenUsage.inputTokens), hidden: tokenUsage.inputTokens <= 0 },
        { label: 'Output', value: formatTaskTokens(tokenUsage.outputTokens), hidden: tokenUsage.outputTokens <= 0 },
        { label: 'Cache read', value: formatTaskTokens(tokenUsage.cachedInputTokens), hidden: !tokenUsage.cachedInputTokens },
        { label: 'Cache write', value: formatTaskTokens(tokenUsage.cacheCreationTokens), hidden: !tokenUsage.cacheCreationTokens },
        { label: 'Reasoning', value: formatTaskTokens(tokenUsage.reasoningOutputTokens), hidden: !tokenUsage.reasoningOutputTokens },
        { label: 'Cost', value: formatTaskCost(tokenUsage.costUsd), hidden: tokenUsage.costUsd <= 0 },
    ].filter(item => !item.hidden);
}

export type ActivityTooltipRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;

export function clampActivityTooltipPlacement(
    anchor: ActivityTooltipRect,
    tooltipSize: { width: number; height: number },
    viewport: { width: number; height: number },
    margin = 8,
) {
    const width = Math.min(Math.max(tooltipSize.width, 1), Math.max(viewport.width - margin * 2, 1));
    const height = Math.min(Math.max(tooltipSize.height, 1), Math.max(viewport.height - margin * 2, 1));
    const centeredLeft = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.max(margin, Math.min(viewport.width - width - margin, centeredLeft));
    const aboveTop = anchor.top - height - margin;
    const belowTop = anchor.bottom + margin;
    const preferBelow = aboveTop < margin && belowTop + height <= viewport.height - margin;
    const unclampedTop = preferBelow ? belowTop : aboveTop;
    const top = Math.max(margin, Math.min(viewport.height - height - margin, unclampedTop));

    return {
        left,
        top,
        placement: preferBelow ? 'below' as const : 'above' as const,
    };
}

function estimateTooltipSize(title: string) {
    const lines = title.split(/\r?\n/);
    const longest = Math.max(1, ...lines.map(line => line.length));
    return {
        width: Math.min(320, Math.max(120, longest * 6.4 + 20)),
        height: Math.max(24, lines.length * 16 + 10),
    };
}

export function ActivityStrip({
    items,
    tokenUsage,
}: {
    items: WorkEvent[];
    tokenUsage: TaskRunViewModel['tokenUsage'];
}) {
    const bars = buildActivityBars(items);
    const tokenRows = taskTokenBreakdown(tokenUsage);
    const [tooltip, setTooltip] = useState<{
        title: string;
        anchor: ActivityTooltipRect;
        position: ReturnType<typeof clampActivityTooltipPlacement>;
    } | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ startX: number; scrollLeft: number; pointerId: number } | null>(null);

    useEffect(() => {
        const node = scrollerRef.current;
        if (!node) return;
        const distanceFromRight = node.scrollWidth - node.clientWidth - node.scrollLeft;
        if (distanceFromRight < 48) {
            node.scrollLeft = node.scrollWidth;
        }
    }, [bars.length]);

    useEffect(() => {
        const tooltipNode = tooltipRef.current;
        if (!tooltip || !tooltipNode || typeof window === 'undefined') return;
        const measured = tooltipNode.getBoundingClientRect();
        const nextPosition = clampActivityTooltipPlacement(
            tooltip.anchor,
            { width: measured.width, height: measured.height },
            { width: window.innerWidth, height: window.innerHeight },
        );
        if (
            Math.abs(nextPosition.left - tooltip.position.left) > 0.5 ||
            Math.abs(nextPosition.top - tooltip.position.top) > 0.5 ||
            nextPosition.placement !== tooltip.position.placement
        ) {
            setTooltip(current => current ? { ...current, position: nextPosition } : current);
        }
    }, [tooltip]);

    const showTooltip = (event: { currentTarget: HTMLElement }, title: string) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
        const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
        const anchor = {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        };
        setTooltip({
            title,
            anchor,
            position: clampActivityTooltipPlacement(
                anchor,
                estimateTooltipSize(title),
                { width: viewportWidth, height: viewportHeight },
            ),
        });
    };

    return (
        <div className="mt-1 px-1 py-2" data-testid="task-activity-timeline">
            <div
                ref={scrollerRef}
                className="ricochet-activity-timeline flex h-8 min-w-0 cursor-grab items-end gap-1 overflow-x-auto overflow-y-hidden px-1 py-1 active:cursor-grabbing"
                onWheel={(event) => {
                    const node = scrollerRef.current;
                    if (!node) return;
                    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
                    event.preventDefault();
                    node.scrollLeft += event.deltaY;
                }}
                onPointerDown={(event) => {
                    const node = scrollerRef.current;
                    if (!node) return;
                    dragRef.current = {
                        startX: event.clientX,
                        scrollLeft: node.scrollLeft,
                        pointerId: event.pointerId,
                    };
                    node.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const node = scrollerRef.current;
                    const drag = dragRef.current;
                    if (!node || !drag || drag.pointerId !== event.pointerId) return;
                    node.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
                }}
                onPointerUp={(event) => {
                    const node = scrollerRef.current;
                    if (node?.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
                    dragRef.current = null;
                }}
                onPointerCancel={(event) => {
                    const node = scrollerRef.current;
                    if (node?.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
                    dragRef.current = null;
                }}
            >
                {bars.map(bar => (
                    <span
                        key={bar.id}
                        className={`ricochet-activity-bar shrink-0 rounded-[3px] ${ACTIVITY_TONE_CLASSES[bar.tone]} ${bar.active ? 'ricochet-activity-bar-active' : ''}`}
                        style={{ width: `${bar.width}px`, height: `${Math.max(8, Math.min(24, bar.height))}px` }}
                        aria-label={`${bar.tone}: ${bar.label}`}
                        onPointerEnter={(event) => showTooltip(event, bar.title)}
                        onPointerMove={(event) => showTooltip(event, bar.title)}
                        onPointerLeave={() => setTooltip(null)}
                        onFocus={(event) => showTooltip(event, bar.title)}
                        onBlur={() => setTooltip(null)}
                        tabIndex={0}
                    />
                ))}
            </div>
            {tooltip && typeof document !== 'undefined' ? createPortal((
                <div
                    ref={tooltipRef}
                    role="tooltip"
                    className="pointer-events-none fixed z-[2147483647] max-w-[320px] whitespace-pre-line rounded bg-vscode-editor-background px-2 py-1 text-[11px] leading-4 text-vscode-fg/86 shadow-lg"
                    data-placement={tooltip.position.placement}
                    style={{ left: tooltip.position.left, top: tooltip.position.top }}
                >
                    {tooltip.title}
                </div>
            ), document.body) : null}
            {tokenRows.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] leading-4 text-vscode-fg/45">
                    {tokenRows.map(row => (
                        <span key={row.label} className="inline-flex items-center gap-1">
                            <span className="text-vscode-fg/35">{row.label}</span>
                            <span className="font-mono text-vscode-fg/65">{row.value}</span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

export function TaskRunHeader({
    taskRun,
    onOpenAgent,
}: {
    taskRun: TaskRunViewModel | null;
    onOpenAgent?: () => void;
}) {
    const [expanded, setExpanded] = useState(Boolean(taskRun && (taskRun.status === 'waiting' || taskRun.status === 'failed')));
    const [workersOpen, setWorkersOpen] = useState(Boolean(taskRun?.workers?.length && taskRun.status === 'failed'));
    const [thinkingOpen, setThinkingOpen] = useState(false);
    const [activityOpen, setActivityOpen] = useState(false);

    useEffect(() => {
        if (taskRun?.status === 'completed' || taskRun?.status === 'rejected') {
            setExpanded(false);
            setWorkersOpen(false);
            setThinkingOpen(false);
            setActivityOpen(false);
        } else if (taskRun?.status === 'waiting' || taskRun?.status === 'failed') {
            setExpanded(true);
            if (taskRun.status === 'failed' && taskRun.workers?.length) {
                setWorkersOpen(true);
            }
        } else if (taskRun?.status === 'running') {
            setExpanded(false);
        }
    }, [taskRun?.status, taskRun?.title, taskRun?.workers?.length]);

    const contextDisplay = useMemo(() => (
        taskRun ? buildTaskContextDisplay(taskRun.tokenUsage, taskRun.isActive) : null
    ), [taskRun]);

    if (!taskRun) return null;

    const hasChecklist = taskRun.totalChecklistCount > 0;
    const workers = taskRun.workers || [];
    const hasWorkers = workers.length > 0;
    const activityItems = taskRun.activityItems?.length ? taskRun.activityItems : taskRun.workSummary?.items || [];
    const hasActivity = activityItems.length > 0;
    const isAllDone = taskRun.status === 'completed' && hasChecklist && taskRun.completedChecklistCount === taskRun.totalChecklistCount;
    const progressLabel = hasChecklist
        ? `${taskRun.completedChecklistCount}/${taskRun.totalChecklistCount}`
        : taskStatusLabel(taskRun.status);
    const showContextDisplay = Boolean(contextDisplay && (contextDisplay.hasKnownContext || taskRun.isActive));
    const barPercent = contextDisplay?.percent || 0;
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
            if (focusReviewRequestTarget()) return;
            if (hasChecklist) setExpanded(true);
            if (hasActivity) setActivityOpen(true);
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
                                    title={modeTitle(taskRun)}
                                >
                                    {modeLabel(taskRun)}
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

                        {showContextDisplay && (
                            <div
                                className="flex min-w-[132px] max-w-[196px] shrink-0 flex-col items-end gap-1 pt-0.5"
                                title={contextDisplay?.title}
                            >
                                <div className="flex w-full items-center justify-end gap-1.5 text-[10.5px] text-vscode-fg/58">
                                    <Gauge className="h-3 w-3 shrink-0 text-vscode-fg/38" />
                                    <span className="truncate font-medium">{contextDisplay?.label}</span>
                                </div>
                                {contextDisplay?.detail && (
                                    <div className="w-full truncate text-right font-mono text-[9.5px] leading-none text-vscode-fg/34">
                                        {contextDisplay.detail}
                                    </div>
                                )}
                                <div
                                    className="h-1.5 w-full overflow-hidden rounded-full bg-vscode-list-hoverBackground/35"
                                    role="progressbar"
                                    aria-label={contextDisplay?.ariaLabel}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={barPercent}
                                >
                                    <div
                                        className={`h-full rounded-full transition-all duration-500 ${taskContextFillClass(barPercent)}`}
                                        style={{ width: `${Math.max(0, Math.min(100, barPercent))}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {(hasChecklist || hasWorkers || hasActivity || taskRun.reasoningText || taskRun.attentionAction) && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            {taskRun.attentionAction && (
                                <button
                                    type="button"
                                    onClick={handleAttentionAction}
                                    aria-label={taskRun.attentionAction.kind === 'review_request' ? `Review pending approval: ${taskRun.attentionReason || taskRun.statusText}` : taskRun.attentionAction.label}
                                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
                                        taskRun.attentionAction.kind === 'review_request'
                                            ? 'border border-amber-400/20 bg-amber-400/10 text-amber-100/90 hover:bg-amber-400/15 hover:text-amber-50'
                                            : 'text-blue-300/80 hover:bg-vscode-list-hoverBackground/45 hover:text-blue-200'
                                    }`}
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
                                    <span className="min-w-0 truncate">{taskRun.workerSummary || `${workers.length} ${workers.length === 1 ? 'agent' : 'agents'}`}</span>
                                </button>
                            )}
                            {hasActivity && (
                                <button
                                    type="button"
                                    onClick={() => setActivityOpen(open => !open)}
                                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] font-medium text-vscode-fg/48 hover:bg-vscode-list-hoverBackground/45 hover:text-vscode-fg/72"
                                >
                                    {activityOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                    Activity
                                    {taskRun.activityHistoryCount ? (
                                        <span className="font-mono text-[9.5px] text-vscode-fg/35">{taskRun.activityHistoryCount}</span>
                                    ) : null}
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
                    <div className="mt-1 px-1 py-2">
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

                {hasActivity && activityOpen && (
                    <ActivityStrip items={activityItems} tokenUsage={taskRun.tokenUsage} />
                )}

                {hasWorkers && workersOpen && (
                    <div className="mt-1 px-1 py-2">
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
                    <div className="mt-1 px-1 py-3">
                        <pre className="custom-scrollbar max-h-[180px] overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.55] text-vscode-fg/58">
                            {taskRun.reasoningText}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}
