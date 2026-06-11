import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useVSCodeApi } from './useVSCodeApi';
import {
    ChatErrorInfo,
    ContextFilePayload,
    ContextStatus,
    ToolLifecycleEventPayload,
    TodoViewPayload,
    UsageSnapshot,
    normalizeChatUpdate,
    normalizeInteractionRequest,
    normalizeTaskProgress
} from '../types/protocol';
import { useUsage } from './useUsage';
import { cleanAssistantVisibleText, isRenderableChatMessage } from '../utils/chatVisibility';
import { chatErrorInfoFromRaw } from '../utils/chatErrors';

export type { ChatErrorInfo, ContextFilePayload, ContextStatus } from '../types/protocol';

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    isStreaming?: boolean;
    run_id?: string;
    turn_id?: string;
    sequence?: number;
    segment_id?: string;
    reasoning?: string; // DeepSeek/R1 reasoning content
    toolCalls?: ToolCall[];
    activities?: ActivityItem[]; // Files analyzed, edited, searched
    steps?: ProgressStep[]; // Granular agent activity
    metadata?: TaskMetadata; // Usage stats (tokens, cost)
    via?: 'telegram' | 'discord' | 'ide';  // Ether: message source
    remoteUsername?: string;  // Ether: remote user name
    checkpointHash?: string;  // Workspace checkpoint for restore
    errorInfo?: ChatErrorInfo;
    artifacts?: Artifact[];
}

export interface Artifact {
    id?: string;
    type: 'implementation_plan' | 'walkthrough' | 'task' | 'report' | 'other' | string;
    title: string;
    summary?: string;
    path?: string;
    content?: string;
    session_id?: string;
    status?: string;
}

export type WorkSummaryStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'rejected';
export type WorkEventType = 'commentary' | 'read' | 'search' | 'command' | 'edit' | 'worker' | 'approval' | 'artifact' | 'error';

export interface ActivityCounts {
    files?: number;
    folders?: number;
    results?: number;
}

export interface ActivityEntry {
    name: string;
    type: 'file' | 'dir' | 'result' | string;
    path?: string;
}

export interface WorkEvent {
    id: string;
    type: WorkEventType;
    label: string;
    target?: string;
    path?: string;
    status?: 'running' | 'completed' | 'failed' | 'waiting';
    additions?: number;
    deletions?: number;
    artifactType?: string;
    command?: string;
    resultPreview?: string;
    exitCode?: number;
    durationMs?: number;
    cwd?: string;
    shell?: string;
    script?: string;
    startedAt?: number;
    completedAt?: number;
    entries?: ActivityEntry[];
    counts?: ActivityCounts;
    error?: string;
    timestamp: number;
}

export interface EditApprovalResolvedPayload {
    decision?: 'accepted' | 'rejected' | string;
    files?: string[];
    filePaths?: string[];
    session_id?: string;
    sessionId?: string;
    run_id?: string;
    runId?: string;
    timestamp?: number;
}

export interface CommandEvent {
    session_id?: string;
    run_id?: string;
    turn_id?: string;
    tool_use_id?: string;
    command_id?: string;
    event?: string;
    command?: string;
    cwd?: string;
    shell?: string;
    status?: string;
    outputChunk?: string;
    resultPreview?: string;
    error?: string;
    exitCode?: number;
    durationMs?: number;
    startedAt?: number;
    completedAt?: number;
    truncated?: boolean;
    timestamp?: number;
}

const MAX_COMMAND_PREVIEW_CHARS = 120_000;

export interface WorkSummary {
    turnId: string;
    sessionId?: string;
    status: WorkSummaryStatus;
    activityHint?: 'hidden_reasoning' | 'unassociated_tool' | 'none';
    startedAt: number;
    completedAt?: number;
    durationMs?: number;
    counts: {
        filesRead: number;
        filesExplored: number;
        foldersExplored: number;
        searches: number;
        commands: number;
        edits: number;
        workers: number;
        approvals: number;
    };
    items: WorkEvent[];
}

export interface TaskMetadata {
    tokensIn: number;
    tokensOut: number;
    totalCost: number;
    contextLimit: number;
    timeSpent?: number;   // in seconds
    thoughtTime?: number; // in seconds
}

export interface ProgressStep {
    id: string;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'error';
    details?: string[]; // Sub-items like "Analyzed file.ts", "Edited main.go"
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: string;
    status: 'pending' | 'running' | 'completed' | 'error';
    timestamp?: number;
    exitCode?: number;
    durationMs?: number;
    cwd?: string;
    shell?: string;
    startedAt?: number;
    completedAt?: number;
}

export interface ActivityItem {
    type: 'search' | 'analyze' | 'edit' | 'command' | 'list_dir';
    file?: string;
    lineRange?: string;    // "L16-815"
    results?: number;      // for search
    additions?: number;    // for edit
    deletions?: number;    // for edit
    query?: string;        // for search
    message?: string;
    command?: string;
    resultPreview?: string;
    entries?: ActivityEntry[];
    counts?: ActivityCounts;
    status?: 'running' | 'completed' | 'failed' | 'waiting' | string;
    error?: string;
    timestamp?: number;
    exitCode?: number;
    durationMs?: number;
    cwd?: string;
    shell?: string;
    script?: string;
    startedAt?: number;
    completedAt?: number;
}

export interface TaskProgress {
    session_id?: string;
    run_id?: string;
    turn_id?: string;
    sequence?: number;
    segment_id?: string;
    parent_segment_id?: string;
    event?: string;
    task_name: string;
    status: string;
    summary?: string;
    result?: string;
    mode?: 'planning' | 'execution' | 'verification';
    steps?: string[];
    files?: string[];
    todos?: Todo[];
    todo_view?: TodoViewPayload;
    checklist_source?: 'todo' | 'provisional' | 'step' | 'none' | string;
    is_active: boolean;
    timestamp?: number;
    completed_at?: number;
    tool_count?: number;
    token_count?: number;
}

export interface Todo {
    text: string;
    status: 'pending' | 'current' | 'completed' | 'cancelled';
    priority?: 'high' | 'medium' | 'low' | string;
    changed?: boolean;
}

export interface HubSubtask {
    id?: string;
    title?: string;
    text?: string;
    status?: string;
}

export interface HubTask {
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    column?: string;
    priority?: number | string;
    subtasks?: HubSubtask[];
    assigned_to?: string;
}

export interface TaskRunWorker {
    id: string;
    name: string;
    status: string;
    isActive?: boolean;
    progress?: string;
}

export interface TaskRunAttentionAction {
    kind: 'view_details' | 'open_agent' | 'review_request' | 'retry';
    label: string;
}

export interface TaskRunChecklistItem {
    text: string;
    status: Todo['status'];
    source: 'todo' | 'step' | 'provisional' | 'hub' | 'edit';
}

export interface TaskRunTokenUsage {
    used: number;
    max: number;
    percent: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    source?: string;
}

export interface TaskRunViewModel {
    title: string;
    status: 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'rejected';
    statusText: string;
    mode: TaskProgress['mode'];
    isActive: boolean;
    checklist: TaskRunChecklistItem[];
    completedChecklistCount: number;
    totalChecklistCount: number;
    checklistSource: 'todo' | 'provisional' | 'step' | 'none' | string;
    tokenUsage: TaskRunTokenUsage;
    workers?: TaskRunWorker[];
    workerSummary?: string;
    attentionReason?: string;
    attentionAction?: TaskRunAttentionAction;
    workSummary?: WorkSummary;
    reasoningText?: string;
    completionText?: string;
    completedAt?: number;
}

const GENERIC_TASK_TITLE_PATTERN = /^(agent activity|autonomous agent|working|processing request|idle)$/i;

function trimTaskTitle(raw?: string): string {
    const firstLine = (raw || '').trim().split(/\r?\n/)[0]?.trim() || '';
    if (!firstLine || GENERIC_TASK_TITLE_PATTERN.test(firstLine)) return '';
    return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

function latestUserPrompt(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
            return trimTaskTitle(messages[i].content);
        }
    }
    return '';
}

function latestAssistantCompletion(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role !== 'assistant' || message.isStreaming || message.errorInfo) continue;
        const content = cleanAssistantVisibleText(message.content || '').trim();
        if (content) return content;
    }
    return '';
}

function latestReasoningText(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message.role !== 'assistant' || !message.isStreaming) continue;
        if (message.reasoning?.trim()) return message.reasoning.trim();
        const match = (message.content || '').match(/<(?:thinking|think)>([\s\S]*?)(?:<\/(?:thinking|think)>|$)/i);
        if (match?.[1]?.trim()) return match[1].trim();
    }
    return '';
}

function isToolActivityText(text?: string): boolean {
    const normalized = (text || '').trim().toLowerCase();
    if (!normalized) return false;
    return normalized.startsWith('read file ') ||
        normalized.startsWith('list directory ') ||
        normalized.startsWith('write to file ') ||
        normalized.startsWith('edit file ') ||
        normalized.startsWith('edited ') ||
        normalized.startsWith('run command:') ||
        normalized.startsWith('search for ') ||
        normalized.startsWith('semantic search:') ||
        normalized.startsWith('search web:') ||
        normalized.startsWith('running tool ');
}

export function normalizeHubTasksPayload(payload: unknown): HubTask[] {
    const maybeTasks = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as any)?.tasks) ? (payload as any).tasks : [];
    return maybeTasks
        .filter((task: any) => task && typeof task === 'object')
        .map((task: any) => ({
            id: task.id ? String(task.id) : undefined,
            title: task.title ? String(task.title) : undefined,
            description: task.description ? String(task.description) : undefined,
            status: task.status ? String(task.status) : undefined,
            column: task.column ? String(task.column) : undefined,
            priority: task.priority,
            assigned_to: task.assigned_to ? String(task.assigned_to) : undefined,
            subtasks: Array.isArray(task.subtasks)
                ? task.subtasks
                    .filter((subtask: any) => subtask && typeof subtask === 'object')
                    .map((subtask: any) => ({
                        id: subtask.id ? String(subtask.id) : undefined,
                        title: subtask.title ? String(subtask.title) : undefined,
                        text: subtask.text ? String(subtask.text) : undefined,
                        status: subtask.status ? String(subtask.status) : undefined,
                    }))
                : undefined,
        }));
}

function normalizeHubTaskStatus(task: Pick<HubTask, 'status' | 'column'>): Todo['status'] {
    const status = `${task.status || ''} ${task.column || ''}`.toLowerCase();
    if (/done|complete|completed|closed|merged/.test(status)) return 'completed';
    if (/failed|blocked|cancel|defer|skipped|stopped/.test(status)) return 'cancelled';
    if (/active|current|in[_ -]?progress|running|review/.test(status)) return 'current';
    return 'pending';
}

function normalizeSubtaskStatus(status?: string): Todo['status'] {
    const normalized = (status || '').toLowerCase();
    if (/done|complete|completed/.test(normalized)) return 'completed';
    if (/failed|blocked|cancel|defer|skipped|stopped/.test(normalized)) return 'cancelled';
    if (/active|current|in[_ -]?progress|running|review/.test(normalized)) return 'current';
    return 'pending';
}

function hubPriorityValue(task: HubTask): number {
    if (typeof task.priority === 'number') return task.priority;
    const priority = String(task.priority || '').toLowerCase();
    if (priority === 'critical') return 3;
    if (priority === 'high') return 2;
    if (priority === 'medium') return 1;
    return 0;
}

function buildHubTaskChecklist(hubTasks: HubTask[]): TaskRunChecklistItem[] {
    return [...hubTasks]
        .sort((a, b) => hubPriorityValue(b) - hubPriorityValue(a))
        .flatMap((task): TaskRunChecklistItem[] => {
            const title = task.title?.trim() || task.description?.trim() || '';
            const rows: TaskRunChecklistItem[] = title
                ? [{ text: title, status: normalizeHubTaskStatus(task), source: 'hub' }]
                : [];
            const subtasks: TaskRunChecklistItem[] = (task.subtasks || [])
                .flatMap(subtask => {
                    const text = subtask.title?.trim() || subtask.text?.trim() || '';
                    if (!text) return [];
                    return [{
                        text,
                        status: normalizeSubtaskStatus(subtask.status),
                        source: 'hub' as const,
                    }];
                });
            return [...rows, ...subtasks];
        });
}

export function normalizeTaskRunWorkers(workers: TaskRunWorker[] = []): TaskRunWorker[] {
    return workers
        .filter(worker => worker && (worker.id || worker.name))
        .map((worker, index) => ({
            id: String(worker.id || worker.name || `worker-${index}`),
            name: String(worker.name || worker.id || `Worker ${index + 1}`),
            status: String(worker.status || (worker.isActive ? 'running' : 'unknown')),
            isActive: Boolean(worker.isActive),
            progress: worker.progress?.trim() || undefined,
        }));
}

function isWorkerRunning(worker: TaskRunWorker): boolean {
    return Boolean(worker.isActive) || /queued|running|in progress|active/i.test(worker.status);
}

function isWorkerQueued(worker: TaskRunWorker): boolean {
    return /queued|pending|waiting/i.test(worker.status) && !/running|active|in progress/i.test(worker.status);
}

function isWorkerDone(worker: TaskRunWorker): boolean {
    return /done|complete|completed|success|succeeded/i.test(worker.status);
}

function isWorkerFailed(worker: TaskRunWorker): boolean {
    return /failed|error|cancelled|stopped|timeout/i.test(worker.status);
}

function buildWorkerSummary(workers: TaskRunWorker[]): string {
    if (!workers.length) return '';
    const workerCount = (count: number) => `${count} ${count === 1 ? 'worker' : 'workers'}`;
    const running = workers.filter(worker => isWorkerRunning(worker) && !isWorkerQueued(worker)).length;
    const queued = workers.filter(isWorkerQueued).length;
    const done = workers.filter(isWorkerDone).length;
    const failed = workers.filter(isWorkerFailed).length;
    return [
        running ? `${workerCount(running)} running` : '',
        queued ? `${queued} queued` : '',
        done ? `${done} done` : '',
        failed ? `${failed} failed` : '',
    ].filter(Boolean).join(' · ');
}

const PROVISIONAL_MILESTONE_PATTERNS = [
    /understand project purpose/i,
    /map architecture and modules/i,
    /review key files and dependencies/i,
    /identify risks and gaps/i,
    /summarize findings/i,
    /clarify objective and scope/i,
    /inspect relevant project context/i,
    /plan the implementation path/i,
    /apply and verify changes/i,
    /summarize results/i,
    /examine project structure/i,
    /analy[sz]e core modules/i,
    /review mathematical|ml components/i,
    /examine monitoring|state management/i,
    /compile comprehensive analysis report/i,
    /summarize architecture/i,
];

function cleanProgressSteps(progress: TaskProgress | null): string[] {
    return (progress?.steps || [])
        .map(step => step?.trim())
        .filter((step): step is string => Boolean(step && !isToolActivityText(step)));
}

function isProvisionalMilestoneText(step: string): boolean {
    return PROVISIONAL_MILESTONE_PATTERNS.some(pattern => pattern.test(step));
}

function hasProvisionalProgressContext(progress: TaskProgress): boolean {
    return /planning task|project analysis|polybot|проанализ|анализ|analy[sz]e|analyse|codebase|кодовую баз|кодобаз|проект/i
        .test(`${progress.task_name || ''} ${progress.summary || ''} ${progress.status || ''}`);
}

function isLikelyProvisionalProgress(progress: TaskProgress | null): boolean {
    if (!progress) return false;
    if (progress.checklist_source === 'provisional') return true;

    const steps = cleanProgressSteps(progress);
    if (steps.length < 4) return false;

    const matchedSteps = steps.filter(isProvisionalMilestoneText).length;
    if (matchedSteps >= Math.min(4, steps.length)) return true;
    return matchedSteps >= 3 && hasProvisionalProgressContext(progress);
}

function inferredProgressChecklistSource(progress: TaskProgress | null): TaskRunViewModel['checklistSource'] | undefined {
    if (!progress) return undefined;
    if (isLikelyProvisionalProgress(progress)) return 'provisional';
    return progress.checklist_source;
}

export function buildTaskChecklist(progress: TaskProgress | null, todos: Todo[], hubTasks: HubTask[] = []): TaskRunChecklistItem[] {
    const sourceTodos = progress?.todos?.length ? progress.todos : todos;
    if (sourceTodos.length > 0) {
        return sourceTodos
            .filter(todo => todo.text?.trim())
            .map(todo => ({ text: todo.text.trim(), status: todo.status, source: 'todo' as const }));
    }

    const hubChecklist = buildHubTaskChecklist(hubTasks);
    if (hubChecklist.length > 0) {
        return hubChecklist;
    }

    const inferredSource = inferredProgressChecklistSource(progress);
    if (inferredSource === 'provisional') {
        return [];
    }

    const source = inferredSource === 'provisional' ? 'provisional' as const : 'step' as const;
    const milestoneSteps = cleanProgressSteps(progress);

    return milestoneSteps.map((step, index) => {
        const currentIndex = source === 'provisional' ? 0 : milestoneSteps.length - 1;
        const completed = source === 'step' && index < currentIndex;
        const current = source === 'provisional'
            ? index === currentIndex
            : Boolean(progress?.is_active && index === currentIndex);
        return {
            text: step,
            status: current ? 'current' : completed ? 'completed' : 'pending',
            source,
        };
    });
}

function editActionLabel(item: WorkEvent): string {
    const label = (item.label || '').toLowerCase();
    if (label.includes('created') || label.includes('create') || label.includes('write')) return 'Create';
    if (label.includes('modified') || label.includes('update')) return 'Update';
    return 'Edit';
}

function editStatusToChecklistStatus(status?: WorkEvent['status']): Todo['status'] {
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'cancelled';
    return 'current';
}

function buildEditChecklist(summary?: WorkSummary): TaskRunChecklistItem[] {
    if (!summary) return [];
    const seen = new Set<string>();
    return summary.items
        .filter(item => item.type === 'edit' && !isInternalWorkEvent(item))
        .flatMap(item => {
            const target = compactTarget(item.path || item.target || '');
            if (!target) return [];
            const key = target.toLowerCase();
            if (seen.has(key)) return [];
            seen.add(key);
            return [{
                text: `${editActionLabel(item)} ${target}`,
                status: editStatusToChecklistStatus(item.status),
                source: 'edit' as const,
            }];
        });
}

export function buildTaskTokenUsage(
    progress: TaskProgress | null,
    usageSnapshot: UsageSnapshot | null,
    contextStatus: ContextStatus | null,
): TaskRunTokenUsage {
    const used = usageSnapshot?.contextTokens || contextStatus?.tokens_used || progress?.token_count || 0;
    const max = usageSnapshot?.contextWindow || contextStatus?.tokens_max || 0;
    const inputTokens = usageSnapshot?.inputTokens || 0;
    const outputTokens = usageSnapshot?.outputTokens || 0;
    const totalTokens = inputTokens + outputTokens || progress?.token_count || used;
    const percent = max > 0
        ? Math.min(100, Math.max(0, Math.round((used / max) * 100)))
        : Math.min(100, Math.max(0, Math.round(contextStatus?.percentage || 0)));

    return {
        used,
        max,
        percent,
        inputTokens,
        outputTokens,
        totalTokens,
        costUsd: usageSnapshot?.estimatedCostUsd || contextStatus?.cumulative_cost || 0,
        source: usageSnapshot?.source,
    };
}

function chooseTaskWorkSummary(workSummariesByTurn: Record<string, WorkSummary>): WorkSummary | undefined {
    const summaries = Object.values(workSummariesByTurn).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return summaries.find(summary => summary.status === 'running' || summary.status === 'waiting') || summaries[0];
}

function statusFromTaskRun(progress: TaskProgress | null, summary?: WorkSummary, workers: TaskRunWorker[] = []): TaskRunViewModel['status'] {
    if (summary?.status === 'waiting') return 'waiting';
    if (summary?.status === 'failed') return 'failed';
    if (summary?.status === 'stopped') return 'stopped';
    if (summary?.status === 'rejected') return 'rejected';
    if (workers.some(isWorkerFailed)) return 'failed';
    if (workers.some(isWorkerRunning)) return 'running';
    if (progress) return statusFromProgress(progress);
    return summary?.status || 'completed';
}

function activeChecklistText(checklist: TaskRunChecklistItem[]): string {
    return checklist.find(item => item.status === 'current')?.text
        || checklist.find(item => item.status !== 'completed' && item.status !== 'cancelled')?.text
        || '';
}

function displayChecklistForStatus(
    checklist: TaskRunChecklistItem[],
    checklistSource: TaskRunViewModel['checklistSource'],
    status: TaskRunViewModel['status'],
): TaskRunChecklistItem[] {
    if (status !== 'completed' || checklistSource !== 'provisional') {
        return checklist;
    }
    return checklist.map(item => ({ ...item, status: 'completed' as const }));
}

function conciseWorkStatus(summary?: WorkSummary): string {
    if (!summary) return '';
    const running = summary.items.find(item => item.status === 'running');
    if (running) {
        if (running.type === 'read') return 'Reading project files';
        if (running.type === 'search') return 'Searching codebase';
        if (running.type === 'command') return 'Running command';
        if (running.type === 'edit') return 'Editing files';
        if (running.type === 'approval') return 'Waiting for approval';
        if (running.type === 'worker') return 'Running worker';
    }
    const waitingEdits = summary.items.filter(item => item.type === 'edit' && item.status === 'waiting').length;
    if (summary.status === 'waiting' && waitingEdits > 0) {
        return `${waitingEdits} ${waitingEdits === 1 ? 'file' : 'files'} waiting for approval`;
    }
    if (summary.status === 'waiting') return 'Waiting for approval';
    if (summary.status === 'failed') return 'Work needs attention';
    if (summary.status === 'completed') {
        const edits = summary.items.filter(item => item.type === 'edit').length;
        if (edits > 0) return `${edits} ${edits === 1 ? 'change' : 'changes'} applied`;
        return 'Work summary ready';
    }
    if (summary.status === 'rejected') {
        const edits = summary.items.filter(item => item.type === 'edit').length;
        if (edits > 0) return `${edits} ${edits === 1 ? 'change' : 'changes'} discarded`;
        return 'Changes discarded';
    }
    return '';
}

function lastErrorInfo(messages: ChatMessage[]): ChatErrorInfo | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].errorInfo) return messages[i].errorInfo;
    }
    return undefined;
}

function compactAttentionText(text?: string): string {
    const firstLine = (text || '').trim().split(/\r?\n/)[0]?.trim() || '';
    if (!firstLine) return '';
    return firstLine.length > 92 ? `${firstLine.slice(0, 89)}...` : firstLine;
}

function buildAttentionState({
    messages,
    progress,
    summary,
    workers,
    pendingPermissionCount,
}: {
    messages: ChatMessage[];
    progress: TaskProgress | null;
    summary?: WorkSummary;
    workers: TaskRunWorker[];
    pendingPermissionCount: number;
}): Pick<TaskRunViewModel, 'attentionReason' | 'attentionAction'> {
    const waitingEditCount = summary?.items.filter(item => item.type === 'edit' && item.status === 'waiting').length || 0;
    if (waitingEditCount > 0) {
        return {
            attentionReason: `${waitingEditCount} ${waitingEditCount === 1 ? 'file' : 'files'} waiting for approval`,
            attentionAction: { kind: 'review_request', label: 'Review request' },
        };
    }

    const waitingItem = summary?.items.find(item => item.type === 'approval' && item.status === 'waiting');
    if (pendingPermissionCount > 0 || summary?.status === 'waiting' || waitingItem) {
        return {
            attentionReason: 'Waiting for approval',
            attentionAction: { kind: 'review_request', label: 'Review request' },
        };
    }

    const failedWorker = workers.find(isWorkerFailed);
    if (failedWorker) {
        return {
            attentionReason: `Worker failed: ${failedWorker.name}`,
            attentionAction: { kind: 'open_agent', label: 'Open Agent' },
        };
    }

    const failedItem = summary?.items.find(item => item.status === 'failed' || item.type === 'error');
    if (failedItem) {
        const target = compactAttentionText(failedItem.error || failedItem.target || failedItem.resultPreview);
        return {
            attentionReason: target ? `${failedItem.label}: ${target}` : failedItem.label,
            attentionAction: { kind: 'view_details', label: 'View details' },
        };
    }

    if (progress && statusFromProgress(progress) === 'failed') {
        const reason = compactAttentionText(progress.result || progress.summary || progress.status);
        return {
            attentionReason: reason || 'Task failed',
            attentionAction: { kind: 'view_details', label: 'View details' },
        };
    }

    const errorInfo = lastErrorInfo(messages);
    if (errorInfo) {
        return {
            attentionReason: compactAttentionText(errorInfo.title || errorInfo.message) || 'Message failed',
            attentionAction: { kind: 'view_details', label: 'View details' },
        };
    }

    if (summary?.status === 'failed') {
        return {
            attentionReason: 'Work needs attention',
            attentionAction: { kind: 'view_details', label: 'View details' },
        };
    }

    return {};
}

function nonToolProgressText(progress: TaskProgress | null): string {
    if (!progress) return '';
    if (isLikelyProvisionalProgress(progress)) {
        return /проанализ|analy[sz]e|analyse|project|проект/i.test(`${progress.task_name} ${progress.summary} ${progress.status}`)
            ? 'Planning project analysis...'
            : 'Preparing task plan...';
    }
    if (progress.summary && !isToolActivityText(progress.summary)) return progress.summary;
    if (progress.status && !isToolActivityText(progress.status)) return progress.status;
    return '';
}

export function buildTaskRunViewModel({
    messages,
    todos,
    hubTasks = [],
    workers = [],
    pendingPermissionCount = 0,
    taskProgress,
    workSummariesByTurn,
    usageSnapshot,
    contextStatus,
    isLoading,
}: {
    messages: ChatMessage[];
    todos: Todo[];
    hubTasks?: HubTask[];
    workers?: TaskRunWorker[];
    pendingPermissionCount?: number;
    taskProgress: TaskProgress | null;
    workSummariesByTurn: Record<string, WorkSummary>;
    usageSnapshot: UsageSnapshot | null;
    contextStatus: ContextStatus | null;
    isLoading: boolean;
}): TaskRunViewModel | null {
    const workSummary = chooseTaskWorkSummary(workSummariesByTurn);
    const normalizedWorkers = normalizeTaskRunWorkers(workers);
    const rawChecklist = buildTaskChecklist(taskProgress, todos, hubTasks);
    const hasTaskSignal = Boolean(taskProgress || rawChecklist.length > 0 || workSummary || normalizedWorkers.length > 0);
    if (!hasTaskSignal) return null;

    let status = statusFromTaskRun(taskProgress, workSummary, normalizedWorkers);
    const editChecklist = rawChecklist.length > 0 ? [] : buildEditChecklist(workSummary);
    const inferredChecklistSource = inferredProgressChecklistSource(taskProgress);
    const checklistSource = taskProgress?.todos?.length || todos.length > 0
        ? 'todo'
        : rawChecklist[0]?.source || editChecklist[0]?.source || inferredChecklistSource || 'none';
    if (!taskProgress && !workSummary && rawChecklist.length > 0) {
        status = rawChecklist.some(item => item.status === 'pending' || item.status === 'current')
            ? 'running'
            : 'completed';
    }
    const attention = buildAttentionState({
        messages,
        progress: taskProgress,
        summary: workSummary,
        workers: normalizedWorkers,
        pendingPermissionCount,
    });
    const checklist = displayChecklistForStatus(rawChecklist.length > 0 ? rawChecklist : editChecklist, checklistSource, status);
    const completedChecklistCount = checklist.filter(item => item.status === 'completed' || item.status === 'cancelled').length;
    const totalChecklistCount = checklist.length;
    const isTerminal = status === 'completed' || status === 'failed' || status === 'stopped' || status === 'rejected';
    const isActive = isTerminal ? false : (isLoading || status === 'running' || status === 'waiting' || Boolean(taskProgress?.is_active));
    const title = trimTaskTitle(taskProgress?.task_name) || latestUserPrompt(messages) || 'Ricochet task';
    const workerSummary = buildWorkerSummary(normalizedWorkers);
    const workStatusText = conciseWorkStatus(workSummary);
    const statusText = status === 'completed'
        ? workStatusText || 'Task completed'
        : status === 'rejected'
            ? workStatusText || 'Changes discarded'
            : status === 'stopped'
                ? 'Stopped'
                : status === 'failed'
                    ? attention.attentionReason || 'Needs attention'
                    : status === 'waiting'
                        ? attention.attentionReason || workStatusText || 'Waiting for approval'
                        : activeChecklistText(checklist) || workerSummary || workStatusText || nonToolProgressText(taskProgress);

    return {
        title,
        status,
        statusText,
        mode: taskProgress?.mode || 'execution',
        isActive,
        checklist,
        completedChecklistCount,
        totalChecklistCount,
        checklistSource,
        tokenUsage: buildTaskTokenUsage(taskProgress, usageSnapshot, contextStatus),
        workers: normalizedWorkers,
        workerSummary,
        attentionReason: attention.attentionReason,
        attentionAction: attention.attentionAction,
        workSummary,
        reasoningText: latestReasoningText(messages),
        completionText: status === 'completed' ? latestAssistantCompletion(messages) : undefined,
        completedAt: taskProgress?.completed_at || workSummary?.completedAt,
    };
}

function mergeArrayByKey<T>(existing: T[] | undefined, incoming: T[] | undefined, keyOf: (item: T, index: number) => string): T[] | undefined {
    if (!existing?.length) return incoming;
    if (!incoming?.length) return existing;

    const merged = [...existing];
    const indexes = new Map<string, number>();
    merged.forEach((item, index) => indexes.set(keyOf(item, index), index));

    incoming.forEach((item, index) => {
        const key = keyOf(item, index);
        const existingIndex = indexes.get(key);
        if (existingIndex === undefined) {
            indexes.set(key, merged.length);
            merged.push(item);
        } else {
            merged[existingIndex] = { ...(merged[existingIndex] as any), ...(item as any) };
        }
    });

    return merged;
}

function mergeChatMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
    const existingAny = existing as any;
    const incomingAny = incoming as any;
    return {
        ...existing,
        ...incoming,
        content: incoming.content ? incoming.content : existing.content,
        reasoning: incoming.reasoning ? incoming.reasoning : existing.reasoning,
        checkpointHash: incoming.checkpointHash ?? existing.checkpointHash,
        metadata: incoming.metadata ?? existing.metadata,
        steps: mergeArrayByKey(existing.steps, incoming.steps, step => step.id),
        toolCalls: mergeArrayByKey(existing.toolCalls, incoming.toolCalls, (tool, index) => tool.id || `${tool.name}:${tool.timestamp ?? index}`),
        activities: mergeArrayByKey(existing.activities, incoming.activities, (activity, index) => [
            activity.type,
            activity.file || '',
            activity.query || '',
            activity.lineRange || '',
            activity.timestamp ?? index
        ].join(':')),
        ...(existingAny.artifacts || incomingAny.artifacts ? {
            artifacts: mergeArrayByKey(existingAny.artifacts, incomingAny.artifacts, (artifact: any, index) => artifact?.path || artifact?.uri || artifact?.title || `${artifact?.type || 'artifact'}:${index}`)
        } : {})
    };
}

const ACTIVITY_PLACEHOLDER_PREFIX = 'activity-placeholder-';

function isActivityPlaceholder(message: ChatMessage): boolean {
    return message.id.startsWith(ACTIVITY_PLACEHOLDER_PREFIX);
}

function findLastUserIndex(messages: ChatMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') return i;
    }
    return -1;
}

function upsertAssistantMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
    const existing = messages.find(message => message.id === incoming.id);
    if (existing) {
        return messages.map(message => message.id === incoming.id ? mergeChatMessage(message, incoming) : message);
    }

    if (!isRenderableChatMessage(incoming)) {
        return messages;
    }

    const lastUserIndex = findLastUserIndex(messages);
    const placeholderIndex = messages.findIndex((message, index) =>
        index > lastUserIndex &&
        message.role === 'assistant' &&
        isActivityPlaceholder(message) &&
        !(message.activities?.length || message.toolCalls?.length)
    );

    if (placeholderIndex !== -1) {
        const next = [...messages];
        next[placeholderIndex] = mergeChatMessage(next[placeholderIndex], incoming);
        return next;
    }

    return [...messages, incoming];
}

function filterRenderableMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter(isRenderableChatMessage);
}

function hasWorkPayload(message?: Partial<ChatMessage> | null): boolean {
    if (!message || message.role !== 'assistant') return false;
    return Boolean(
        message.toolCalls?.length ||
        message.activities?.length ||
        (Array.isArray((message as any).artifacts) && (message as any).artifacts.length > 0)
    );
}

export function hasPlanArtifact(message?: Partial<ChatMessage> | null): boolean {
    const artifacts = (message as any)?.artifacts;
    return Array.isArray(artifacts) && artifacts.some((artifact: any) => artifact?.type === 'implementation_plan');
}

export function shouldKeepAssistantBubble(message: ChatMessage, forceWorkCommentary = false): boolean {
    if (message.role !== 'assistant') return true;
    if (message.checkpointHash) return true;
    if (hasPlanArtifact(message)) return true;
    if (forceWorkCommentary) return false;
    if (!hasWorkPayload(message)) return true;
    return false;
}

const RAW_TOOL_ARGUMENT_KEYS = [
    'script',
    'command',
    'path',
    'query',
    'TaskName',
    'TaskStatus',
    'TaskSummary',
    'PredictedTaskSize',
    'mode',
    'plan_mode',
    'checklist_source',
    'content',
    'summary',
    'title',
    'kind',
    'arguments',
    'tool',
];

function containsRawToolArgumentKeys(text: string): boolean {
    return /"?(?:script|command|path|query|TaskName|TaskStatus|TaskSummary|PredictedTaskSize|mode|plan_mode|checklist_source|content|summary|title|kind|arguments|tool)"?\s*:/.test(text);
}

function isRawToolArgumentText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/^\{[\s\S]*\}$/.test(trimmed)) {
        try {
            const parsed = JSON.parse(trimmed);
            return Boolean(parsed && typeof parsed === 'object' && RAW_TOOL_ARGUMENT_KEYS.some(key => key in parsed));
        } catch {
            return containsRawToolArgumentKeys(trimmed);
        }
    }
    return false;
}

export function normalizeWorkCommentaryText(content: string): string {
    const visibleText = cleanAssistantVisibleText(content || '').trim();
    if (!visibleText) return '';
    if (isRawToolArgumentText(visibleText)) return '';

    const lines = visibleText.split(/\r?\n/);
    const rawJsonStart = lines.findIndex(line => line.trim().startsWith('{'));
    if (rawJsonStart >= 0 && containsRawToolArgumentKeys(lines.slice(rawJsonStart).join('\n'))) {
        return lines.slice(0, rawJsonStart).join('\n').trim();
    }

    return visibleText;
}

export function shouldCreateWorkCommentary(message: ChatMessage): boolean {
    return message.role === 'assistant' && Boolean(message.isStreaming) && hasWorkPayload(message) && Boolean(normalizeWorkCommentaryText(message.content || ''));
}

function messageToCommentaryEvent(message: ChatMessage, forceWorkCommentary = false): WorkEvent | null {
    if (message.role !== 'assistant') return null;
    if (!forceWorkCommentary && !hasWorkPayload(message)) return null;
    const visibleText = normalizeWorkCommentaryText(message.content || '');
    if (!visibleText) return null;

    return {
        id: `commentary-${message.id}`,
        type: 'commentary',
        label: 'Agent',
        target: visibleText,
        status: message.isStreaming ? 'running' : 'completed',
        timestamp: message.timestamp || Date.now(),
    };
}

function emptyWorkCounts(): WorkSummary['counts'] {
    return { filesRead: 0, filesExplored: 0, foldersExplored: 0, searches: 0, commands: 0, edits: 0, workers: 0, approvals: 0 };
}

function getTurnId(message?: Partial<ChatMessage> | null, fallback?: string | null): string {
    return message?.run_id || fallback || message?.turn_id || `turn-${Date.now()}`;
}

function getToolArgs(tool: ToolCall): Record<string, any> {
    try {
        return typeof tool.arguments === 'string'
            ? JSON.parse(tool.arguments)
            : (tool.arguments || {});
    } catch {
        return {};
    }
}

function toolStatusToWorkStatus(status?: string): WorkEvent['status'] {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'error' || normalized === 'failed' || normalized === 'aborted') return 'failed';
    if (normalized === 'completed' || normalized === 'success' || normalized === 'succeeded') return 'completed';
    return 'running';
}

function toolErrorText(tool: ToolCall): string | undefined {
    const result = typeof tool.result === 'string' ? tool.result.trim() : '';
    if (!result) return undefined;
    return /permission denied|error|failed|exception|denied|not allowed/i.test(result) ? result : undefined;
}

function commandMetadataFrom(source: Record<string, any>): Partial<WorkEvent> {
    const exitCode = source.exitCode ?? source.exit_code ?? source.code;
    const durationMs = source.durationMs ?? source.duration_ms;
    const startedAt = source.startedAt ?? source.started_at;
    const completedAt = source.completedAt ?? source.completed_at;
    const cwd = source.cwd ?? source.workingDirectory ?? source.working_directory;

    return {
        exitCode: typeof exitCode === 'number' ? exitCode : undefined,
        durationMs: typeof durationMs === 'number' ? durationMs : undefined,
        cwd: typeof cwd === 'string' ? cwd : undefined,
        shell: typeof source.shell === 'string' ? source.shell : undefined,
        startedAt: typeof startedAt === 'number' ? startedAt : undefined,
        completedAt: typeof completedAt === 'number' ? completedAt : undefined,
    };
}

function capCommandPreview(text: string): string {
    if (text.length <= MAX_COMMAND_PREVIEW_CHARS) return text;
    return `[output truncated in timeline; copy from the full command log if needed]\n${text.slice(-MAX_COMMAND_PREVIEW_CHARS)}`;
}

function compactTarget(path: string): string {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    const srcIndex = parts.lastIndexOf('src');
    if (srcIndex >= 0) return parts.slice(srcIndex).join('/');
    if (parts.length > 2) return parts.slice(-2).join('/');
    return parts.join('/') || path;
}

export function isInternalRicochetPath(path?: string): boolean {
    const normalized = (path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return /(^|\/)\.ricochet\/(?:artifacts|brain|checkpoints|runtime|sessions|tmp)\//.test(normalized)
        || /(^|\/)task_progress_current\.md$/.test(normalized);
}

function isRicochetArtifactPath(path?: string): boolean {
    const normalized = (path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return /(^|\/)\.ricochet\/artifacts\//.test(normalized);
}

function isFirstClassArtifact(artifact: any): boolean {
    if (!artifact || typeof artifact !== 'object') return false;
    const type = String(artifact.type || '').toLowerCase();
    if (type === 'implementation_plan' || type === 'walkthrough' || type === 'report' || type === 'task') {
        return true;
    }
    return isRicochetArtifactPath(artifact.path);
}

function isTimelineArtifact(artifact: any): boolean {
    return isFirstClassArtifact(artifact) && String(artifact.type || '').toLowerCase() !== 'implementation_plan';
}

function artifactDisplayTarget(artifact: any): string {
    if (artifact?.path) return compactTarget(String(artifact.path));
    return String(artifact?.title || artifact?.type || 'Artifact');
}

function isInternalWorkEvent(item: WorkEvent): boolean {
    const toolName = item.command || item.target || item.label;
    if (item.type === 'artifact' && isRicochetArtifactPath(item.path || item.target)) {
        return false;
    }
    return isInternalRicochetPath(item.path)
        || isInternalRicochetPath(item.target)
        || (item.label === 'Used tool' && isSilentMetaTool(toolName));
}

function isSilentMetaTool(toolName?: string): boolean {
    return /^(?:task_boundary|update_todos|update_plan|create_task|next_task|complete_task|list_tasks|add_subtask|delete_task|switch_mode|submit_plan|write_scratchpad|read_scratchpad)$/i.test((toolName || '').trim());
}

export function classifyTool(tool: ToolCall): WorkEvent | null {
    if (!tool.name || isSilentMetaTool(tool.name)) {
        return null;
    }

    const args = getToolArgs(tool);
    const filePath = args.path || args.AbsolutePath || args.TargetFile || args.file || args.SearchPath || args.DirectoryPath || '';
    const query = args.query || args.Query || args.pattern || args.Pattern || '';
    const status = toolStatusToWorkStatus(tool.status);
    const resultPreview = typeof tool.result === 'string' ? tool.result : undefined;
    const error = toolErrorText(tool);
    if (isInternalRicochetPath(filePath)) return null;

    if (tool.name === 'execute_python') {
        const script = typeof args.script === 'string' ? args.script.trim() : '';
        return {
            id: `tool-${tool.id}`,
            type: 'command',
            label: 'Ran Python script',
            target: 'Python script',
            command: 'python3 <script>',
            script: script || undefined,
            resultPreview,
            status,
            error,
            timestamp: tool.timestamp || Date.now(),
            ...commandMetadataFrom({ ...args, ...tool }),
            shell: 'python',
        };
    }

    if (tool.name === 'command_status') {
        const rawId = String(args.id || '');
        if (!rawId) return null;
        if (!rawId.startsWith('agent-')) {
            return {
                id: `tool-command-status-${rawId}`,
                type: 'command',
                label: 'Checked command',
                target: rawId,
                status,
                error,
                timestamp: tool.timestamp || Date.now(),
            };
        }
        return {
            id: `tool-worker-${rawId}`,
            type: 'worker',
            label: 'Checked worker',
            target: rawId,
            status,
            error,
            timestamp: tool.timestamp || Date.now(),
        };
    }

    if (tool.name.includes('read') || tool.name.includes('view') || tool.name.includes('list') || tool.name.startsWith('get_')) {
        return {
            id: `tool-${tool.id}`,
            type: 'read',
            label: tool.name.includes('list') ? 'Explored' : 'Read',
            target: compactTarget(filePath || tool.name),
            path: filePath || undefined,
            status,
            error,
            timestamp: tool.timestamp || Date.now(),
        };
    }

    if (tool.name.includes('search') || tool.name.includes('grep') || tool.name.includes('find')) {
        return {
            id: `tool-${tool.id}`,
            type: 'search',
            label: 'Searched',
            target: query || compactTarget(filePath) || tool.name,
            path: filePath || undefined,
            status,
            error,
            timestamp: tool.timestamp || Date.now(),
        };
    }

    if (tool.name.includes('write') || tool.name.includes('edit') || tool.name.includes('replace') || tool.name.includes('apply_diff')) {
        return {
            id: `tool-${tool.id}`,
            type: 'edit',
            label: status === 'running' ? 'Editing' : status === 'failed' ? 'Edit failed' : 'Edited',
            target: compactTarget(filePath || tool.name),
            path: filePath || undefined,
            status,
            error,
            resultPreview,
            timestamp: tool.timestamp || Date.now(),
        };
    }

    if (isCommandToolName(tool.name) || args.command || args.CommandLine || args.cmd || args.Cmd) {
        const command = String(args.command || args.CommandLine || args.cmd || args.Cmd || '').trim();
        if (!command || isGenericProgressText(command)) return null;
        if (args.background === true && typeof tool.result === 'string' && /command started in background/i.test(tool.result)) {
            return null;
        }
        return {
            id: `tool-${tool.id}`,
            type: 'command',
            label: 'Ran',
            target: command,
            command,
            resultPreview,
            status,
            error,
            timestamp: tool.timestamp || Date.now(),
            ...commandMetadataFrom({ ...args, ...tool }),
        };
    }

    if (tool.name === 'subagent' || tool.name === 'start_swarm') {
        return {
            id: `tool-${tool.id}`,
            type: 'worker',
            label: tool.name === 'start_swarm' ? 'Started workers' : 'Requested worker',
            target: String(args.description || args.goal || tool.name),
            status,
            error,
            timestamp: tool.timestamp || Date.now(),
        };
    }

    return {
        id: `tool-${tool.id}`,
        type: 'worker',
        label: 'Used tool',
        target: tool.name,
        status,
        error,
        timestamp: tool.timestamp || Date.now(),
    };
}

export function activityToWorkEvent(activity: ActivityItem, index: number): WorkEvent | null {
    const timestamp = activity.timestamp || Date.now();
    if (isInternalRicochetPath(activity.file)) return null;
    if (activity.type === 'analyze' || activity.type === 'list_dir') {
        return {
            id: `activity-${activity.type}-${activity.file || index}`,
            type: 'read',
            label: activity.type === 'list_dir' ? 'Explored' : 'Read',
            target: compactTarget(activity.file || ''),
            path: activity.file,
            status: activity.status === 'failed' ? 'failed' : activity.status === 'running' ? 'running' : 'completed',
            entries: activity.entries,
            counts: activity.counts,
            error: activity.error,
            timestamp,
        };
    }
    if (activity.type === 'search') {
        return {
            id: `activity-search-${activity.query || index}`,
            type: 'search',
            label: 'Searched',
            target: activity.query || `${activity.results || 0} results`,
            resultPreview: activity.resultPreview,
            counts: activity.counts || (activity.results ? { results: activity.results } : undefined),
            status: 'completed',
            timestamp,
        };
    }
    if (activity.type === 'edit') {
        return {
            id: `activity-edit-${activity.file || index}`,
            type: 'edit',
            label: 'Edited',
            target: compactTarget(activity.file || ''),
            path: activity.file,
            status: 'completed',
            timestamp,
        };
    }
    if (activity.type === 'command') {
        const isPython = activity.shell === 'python';
        return {
            id: `activity-command-${index}`,
            type: 'command',
            label: isPython ? 'Ran Python script' : 'Ran',
            target: isPython ? 'Python script' : activity.command,
            command: activity.command,
            script: activity.script,
            resultPreview: activity.resultPreview,
            status: activity.status === 'failed' ? 'failed' : activity.status === 'running' ? 'running' : 'completed',
            timestamp,
            ...commandMetadataFrom(activity as any),
        };
    }
    return null;
}

export function commandEventToWorkEvent(event: CommandEvent): WorkEvent | null {
    const command = (event.command || '').trim();
    if (!command || isGenericProgressText(command)) return null;

    const lifecycle = (event.event || '').toLowerCase();
    const status: WorkEvent['status'] = lifecycle === 'command_failed' || event.status === 'failed'
        ? 'failed'
        : lifecycle === 'command_succeeded' || event.status === 'completed'
            ? 'completed'
            : 'running';
    const output = event.outputChunk || event.resultPreview || '';

    return {
        id: event.tool_use_id ? `tool-${event.tool_use_id}` : `command-${event.command_id || command}`,
        type: 'command',
        label: status === 'running' ? 'Running' : 'Ran',
        target: command,
        command,
        resultPreview: output ? capCommandPreview(output) : undefined,
        status,
        error: event.error,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        cwd: event.cwd,
        shell: event.shell,
        startedAt: event.startedAt,
        completedAt: event.completedAt,
        timestamp: event.timestamp || event.startedAt || Date.now(),
    };
}

function toolLifecycleStatus(event: ToolLifecycleEventPayload): WorkEvent['status'] {
    const status = (event.status || '').toLowerCase();
    const lifecycle = (event.event || '').toLowerCase();
    if (status === 'failed' || lifecycle === 'tool_failed') return 'failed';
    if (status === 'aborted' || lifecycle === 'tool_aborted') return 'failed';
    if (status === 'completed' || lifecycle === 'tool_finished') return 'completed';
    return 'running';
}

function shouldHideLifecycleTool(toolName: string): boolean {
    return isSilentMetaTool(toolName);
}

function toolLifecycleSummaryStatus(event: ToolLifecycleEventPayload): WorkSummaryStatus {
    const status = (event.status || '').toLowerCase();
    const lifecycle = (event.event || '').toLowerCase();
    if (status === 'failed' || lifecycle === 'tool_failed') return 'failed';
    if (status === 'aborted' || lifecycle === 'tool_aborted') return 'stopped';
    if (status === 'completed' || lifecycle === 'tool_finished') return 'running';
    return 'running';
}

export function toolLifecycleEventToWorkEvent(event: ToolLifecycleEventPayload): WorkEvent | null {
    const toolName = (event.tool_name || '').trim();
    if (!toolName || shouldHideLifecycleTool(toolName)) return null;

    const normalized = toolName.toLowerCase();
    const status = toolLifecycleStatus(event);
    const timestamp = event.timestamp || event.started_at || Date.now();
    const firstFile = event.affected_files?.find(Boolean) || '';
    const summary = (event.args_summary || '').trim();
    const target = firstFile || summary || toolName;
    if (isInternalRicochetPath(firstFile) || isInternalRicochetPath(summary)) return null;
    const id = event.tool_use_id
        ? `tool-${event.tool_use_id}`
        : `tool-${toolName}-${event.started_at || event.timestamp || target}`;

    const common = {
        id,
        target: compactTarget(target),
        path: firstFile || undefined,
        status,
        resultPreview: event.output_preview ? capCommandPreview(event.output_preview) : undefined,
        error: event.error,
        durationMs: event.duration_ms,
        startedAt: event.started_at,
        completedAt: event.completed_at,
        timestamp,
    };

    if (normalized === 'execute_python') {
        return {
            ...common,
            type: 'command',
            label: status === 'running' ? 'Running Python' : 'Ran Python',
            target: 'Python script',
            command: 'python3 <script>',
            shell: 'python',
        };
    }

    if (isCommandToolName(toolName) || normalized.includes('command') || normalized.includes('shell') || normalized.includes('terminal')) {
        const command = summary || toolName;
        if (isGenericProgressText(command)) return null;
        return {
            ...common,
            type: 'command',
            label: status === 'running' ? 'Running' : status === 'failed' ? 'Command failed' : 'Ran',
            target: command,
            command,
        };
    }

    if (normalized.includes('read') || normalized.includes('view') || normalized.includes('list') || normalized.startsWith('get_')) {
        return {
            ...common,
            type: 'read',
            label: normalized.includes('list') ? 'Explored' : 'Read',
        };
    }

    if (normalized.includes('search') || normalized.includes('grep') || normalized.includes('find')) {
        return {
            ...common,
            type: 'search',
            label: 'Searched',
            target: summary || compactTarget(firstFile) || toolName,
        };
    }

    if (normalized.includes('write') || normalized.includes('edit') || normalized.includes('replace') || normalized.includes('apply_diff') || normalized.includes('delete')) {
        return {
            ...common,
            type: 'edit',
            label: status === 'running' ? 'Editing' : status === 'failed' ? 'Edit failed' : 'Edited',
        };
    }

    if (normalized.includes('approval') || normalized.includes('ask_user') || normalized.includes('permission')) {
        return {
            ...common,
            type: 'approval',
            label: status === 'running' ? 'Waiting for approval' : 'Approval handled',
            status: status === 'running' ? 'waiting' : status,
        };
    }

    if (normalized.includes('checkpoint')) {
        return {
            ...common,
            type: 'artifact',
            label: status === 'running' ? 'Checkpointing' : 'Checkpointed',
        };
    }

    if (normalized.includes('subagent') || normalized.includes('swarm') || normalized.includes('worker')) {
        return {
            ...common,
            type: 'worker',
            label: status === 'running' ? 'Worker running' : 'Worker finished',
        };
    }

    return {
        ...common,
        type: 'command',
        label: 'Used tool',
        target: toolName,
    };
}

function parseToolStatusArguments(raw: string): Record<string, any> {
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) return {};
    try {
        return JSON.parse(raw.slice(jsonStart));
    } catch {
        return {};
    }
}

function cleanProgressTarget(raw: string): string {
    const trimmed = raw
        .trim()
        .replace(/[.。]+$/g, '')
        .trim();
    if (/^["'`][^"'`]+["'`]$/.test(trimmed)) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function isGenericProgressText(raw?: string): boolean {
    const text = (raw || '').trim();
    return !text || /^(working|thinking|processing request|idle|running)$/i.test(text);
}

function isStructuredHeartbeatStatus(status: string): boolean {
    return /^(?:Изучен файл|Проверена папка|Проверен поиск|Команда `.*` завершена)/i.test(status.trim());
}

function isCommandToolName(toolName: string): boolean {
    const normalized = toolName.trim().toLowerCase();
    return /^(?:execute_command|run_command|terminal|shell|bash|cmd|command)$/.test(normalized);
}

export function parseProgressStatus(progress: TaskProgress): WorkEvent | null {
    const status = (progress.status || '').trim();
    const lower = status.toLowerCase();
    const event = (progress.event || '').trim().toLowerCase();
    const timestamp = progress.timestamp || Date.now();
    const baseId = progress.segment_id || `${progress.run_id || progress.turn_id || 'progress'}-${progress.sequence || timestamp}`;
    const genericTaskName = isGenericProgressText(progress.task_name) || /^agent activity$/i.test(progress.task_name || '');

    if (isGenericProgressText(status) && isGenericProgressText(progress.summary) && genericTaskName) {
        return null;
    }

    if (/^(mission accomplished|task complete|completed)$/i.test(status) || event === 'completed' || isStructuredHeartbeatStatus(status)) {
        return null;
    }

    if (status && isGenericProgressText(status)) {
        return null;
    }

    const fromTool = lower.match(/^running tool\s+([a-z0-9_:-]+)\s*:/i);
    const toolName = fromTool?.[1] || '';
    const args = fromTool ? parseToolStatusArguments(status) : {};
    const path = args.path || args.TargetFile || args.AbsolutePath || args.file || args.SearchPath || args.DirectoryPath || '';
    const query = args.query || args.Query || args.pattern || args.Pattern || '';

    if (lower.includes('waiting for approval')) {
        return {
            id: `${baseId}-approval`,
            type: 'approval',
            label: 'Waiting for approval',
            target: status,
            status: 'waiting',
            timestamp,
        };
    }

    if (lower.startsWith('approval received')) {
        return {
            id: `${baseId}-approval-resumed`,
            type: 'approval',
            label: 'Approval received',
            target: status,
            status: 'completed',
            timestamp,
        };
    }

    const readFileMatch = status.match(/^read(?:ing)?\s+(?:file\s+)?(.+)$/i);
    if (readFileMatch || lower.startsWith('reading ') || toolName.includes('read_file') || toolName.includes('view_file')) {
        const target = path || cleanProgressTarget(readFileMatch?.[1] || status.replace(/^reading\s+/i, ''));
        return {
            id: `${baseId}-read-${target}`,
            type: 'read',
            label: 'Read',
            target: compactTarget(target),
            path: target || undefined,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    const listDirectoryMatch = status.match(/^(?:list(?:ing)?\s+director(?:y|ies)|explored|exploring)\s+(.+)$/i);
    if (listDirectoryMatch || toolName.includes('list_dir')) {
        const target = path || cleanProgressTarget(listDirectoryMatch?.[1] || status.replace(/^explor(?:ed|ing)\s+/i, ''));
        return {
            id: `${baseId}-explore-${target}`,
            type: 'read',
            label: 'Explored',
            target: compactTarget(target),
            path: target || undefined,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    if (lower.startsWith('search') || toolName.includes('search') || toolName.includes('grep') || toolName.includes('find')) {
        const target = query || path || status;
        return {
            id: `${baseId}-search-${target}`,
            type: 'search',
            label: 'Searched',
            target: target ? compactTarget(target) : status,
            path: path || undefined,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    if (lower.startsWith('edited ') || toolName.includes('write') || toolName.includes('edit') || toolName.includes('replace') || toolName.includes('apply_diff')) {
        const target = path || status.replace(/^edited\s+/i, '');
        return {
            id: `${baseId}-edit-${target}`,
            type: 'edit',
            label: lower.startsWith('edited ') ? 'Edited' : 'Modified',
            target: compactTarget(target),
            path: path || undefined,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    const writeFileMatch = status.match(/^(?:write to file|edit file)\s+`?(.+?)`?$/i);
    if (writeFileMatch) {
        const target = cleanProgressTarget(writeFileMatch[1]);
        return {
            id: `${baseId}-edit-${target}`,
            type: 'edit',
            label: lower.startsWith('write') ? 'Write' : 'Edit',
            target: compactTarget(target),
            path: target || undefined,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    if (fromTool) {
        const command = args.command || args.Command || args.cmd || args.Cmd || '';
        if (!command && !isCommandToolName(toolName)) {
            return null;
        }
        const target = cleanProgressTarget(command || toolName || status);
        return {
            id: `${baseId}-command-${target}`,
            type: 'command',
            label: 'Ran',
            target: compactTarget(target),
            command: command || undefined,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
            ...commandMetadataFrom(args),
        };
    }

    const commandMatch = status.match(/^run command:\s*`?(.+?)`?$/i);
    if (commandMatch) {
        const command = cleanProgressTarget(commandMatch[1]);
        return {
            id: `${baseId}-command-${command}`,
            type: 'command',
            label: 'Ran',
            target: command,
            command,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    if (progress.summary?.toLowerCase().includes('worker') || progress.task_name?.toLowerCase().includes('worker')) {
        return {
            id: `${baseId}-worker-${progress.summary || status}`,
            type: 'worker',
            label: progress.task_name || 'Worker',
            target: progress.summary || status,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    if ((event === 'phase' || event === 'task_boundary' || event === 'mission_progress' || genericTaskName) && !fromTool && !isGenericProgressText(status)) {
        const target = cleanProgressTarget(status);
        return {
            id: `${baseId}-phase-${target}`,
            type: 'commentary',
            label: genericTaskName ? 'Progress' : progress.task_name,
            target,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    if (genericTaskName && isGenericProgressText(status)) {
        return null;
    }

    if (!fromTool && !isGenericProgressText(status)) {
        return {
            id: `${baseId}-phase-${status}`,
            type: 'commentary',
            label: progress.task_name || 'Progress',
            target: progress.summary || status,
            status: progress.is_active ? 'running' : 'completed',
            timestamp,
        };
    }

    return null;
}

function normalizedWorkTarget(item: WorkEvent): string {
    return compactTarget(item.path || item.target || '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/[.。]+$/g, '')
        .toLowerCase();
}

function basenameTarget(target: string): string {
    const parts = target.split('/').filter(Boolean);
    return parts[parts.length - 1] || target;
}

function isDuplicateWorkEvent(a: WorkEvent, b: WorkEvent): boolean {
    if (a.type !== b.type) return false;

    const aTarget = normalizedWorkTarget(a);
    const bTarget = normalizedWorkTarget(b);
    if (!aTarget || !bTarget) return a.id === b.id;
    if (aTarget === bTarget) return true;

    if (['read', 'search', 'edit'].includes(a.type)) {
        return basenameTarget(aTarget) === basenameTarget(bTarget);
    }

    return false;
}

function mergeWorkEvent(existing: WorkEvent, incoming: WorkEvent): WorkEvent {
    const statusRank = { failed: 4, waiting: 3, completed: 2, running: 1 } as const;
    const existingRank = existing.status ? statusRank[existing.status] : 0;
    const incomingRank = incoming.status ? statusRank[incoming.status] : 0;
    const mergedStatus = existing.type === 'approval' && incoming.type === 'approval'
        ? incoming.status || existing.status
        : incomingRank >= existingRank ? incoming.status : existing.status;
    const mergeResultPreview = () => {
        if (existing.type !== 'command' || incoming.type !== 'command') {
            return incoming.resultPreview || existing.resultPreview;
        }
        const current = existing.resultPreview || '';
        const next = incoming.resultPreview || '';
        if (!next) return current || undefined;
        if (!current) return capCommandPreview(next);
        if (next.startsWith(current)) return capCommandPreview(next);
        if (current.includes(next) || current.endsWith(next)) return capCommandPreview(current);
        if (incoming.status === 'running') return capCommandPreview(`${current}${next}`);
        return capCommandPreview(next);
    };
    return {
        ...existing,
        ...incoming,
        id: existing.id,
        label: existing.label !== 'Agent activity' ? existing.label : incoming.label,
        target: existing.target && existing.target.length >= (incoming.target || '').length ? existing.target : incoming.target || existing.target,
        path: existing.path || incoming.path,
        command: incoming.command || existing.command,
        script: incoming.script || existing.script,
        resultPreview: mergeResultPreview(),
        error: incoming.error || existing.error,
        exitCode: incoming.exitCode ?? existing.exitCode,
        durationMs: incoming.durationMs ?? existing.durationMs,
        cwd: incoming.cwd || existing.cwd,
        shell: incoming.shell || existing.shell,
        startedAt: incoming.startedAt ?? existing.startedAt,
        completedAt: incoming.completedAt ?? existing.completedAt,
        status: mergedStatus,
        timestamp: Math.min(existing.timestamp, incoming.timestamp),
    };
}

function recalculateWorkSummary(summary: WorkSummary): WorkSummary {
    const sortedItems = [...summary.items].sort((a, b) => a.timestamp - b.timestamp);
    const isTerminalSummary = ['completed', 'failed', 'stopped', 'rejected'].includes(summary.status);
    const latestRunningIndex = isTerminalSummary
        ? -1
        : sortedItems.reduce((latest, item, index) => item.status === 'running' ? index : latest, -1);
    const normalizedItems = sortedItems
        .map((item, index) => {
            if (item.type === 'approval' && item.status === 'waiting' && isTerminalSummary) {
                return { ...item, status: 'completed' as const };
            }
            if (item.status !== 'running') return item;
            if (isTerminalSummary || index !== latestRunningIndex) {
                return { ...item, status: 'completed' as const };
            }
            return item;
        })
        .filter(item => !isInternalWorkEvent(item))
        .filter(item => !(item.type === 'approval' && item.status === 'completed'));

    const seen = {
        read: new Set<string>(),
        search: new Set<string>(),
        command: new Set<string>(),
        edit: new Set<string>(),
        worker: new Set<string>(),
        approval: new Set<string>(),
    };

    let filesExplored = 0;
    let foldersExplored = 0;

    normalizedItems.forEach(item => {
        const key = item.path || item.target || item.id;
        if (item.type === 'read') {
            seen.read.add(key);
            filesExplored += item.counts?.files || 0;
            foldersExplored += item.counts?.folders || 0;
        }
        if (item.type === 'search') {
            seen.search.add(key);
        }
        if (item.type === 'command') seen.command.add(key);
        if (item.type === 'edit') seen.edit.add(key);
        if (item.type === 'worker') seen.worker.add(key);
        if (item.type === 'approval') seen.approval.add(key);
    });

    return {
        ...summary,
        durationMs: (summary.completedAt || Date.now()) - summary.startedAt,
        counts: {
            filesRead: seen.read.size,
            filesExplored,
            foldersExplored,
            searches: seen.search.size,
            commands: seen.command.size,
            edits: seen.edit.size,
            workers: seen.worker.size,
            approvals: seen.approval.size,
        },
        items: normalizedItems,
    };
}

export function markWorkSummaryActivityHint(
    summaries: Record<string, WorkSummary>,
    turnId: string,
    sessionId: string | undefined,
    hint: NonNullable<WorkSummary['activityHint']>,
    status: WorkSummaryStatus = 'running',
): Record<string, WorkSummary> {
    if (!turnId) return summaries;
    const now = Date.now();
    const current = summaries[turnId] || {
        turnId,
        sessionId,
        status: 'running' as WorkSummaryStatus,
        startedAt: now,
        counts: emptyWorkCounts(),
        items: [],
    };
    const nextStatus = status || current.status;
    const completedAt = ['completed', 'failed', 'stopped', 'rejected'].includes(nextStatus)
        ? current.completedAt || now
        : undefined;
    return {
        ...summaries,
        [turnId]: recalculateWorkSummary({
            ...current,
            sessionId: current.sessionId || sessionId,
            status: nextStatus,
            activityHint: current.activityHint || hint,
            completedAt,
        }),
    };
}

export function resolveRuntimeTurnIdForEvent({
    runId,
    turnId,
    activeRunId,
    messages,
    fallback,
}: {
    runId?: string;
    turnId?: string;
    activeRunId?: string | null;
    messages?: Pick<ChatMessage, 'id' | 'run_id' | 'turn_id'>[];
    fallback: string;
}): string {
    const candidate = runId || turnId;
    if (!activeRunId) return candidate || fallback;
    if (!candidate || candidate === activeRunId) return activeRunId;
    const hasCandidateMessage = Boolean(messages?.some(message =>
        message.id === candidate || message.run_id === candidate || message.turn_id === candidate
    ));
    return hasCandidateMessage ? candidate : activeRunId;
}

export function upsertWorkEvents(
    summaries: Record<string, WorkSummary>,
    turnId: string,
    sessionId: string | undefined,
    events: WorkEvent[],
    status?: WorkSummaryStatus
): Record<string, WorkSummary> {
    if (!events.length && !status) return summaries;
    const now = Date.now();
    const current = summaries[turnId] || {
        turnId,
        sessionId,
        status: 'running' as WorkSummaryStatus,
        startedAt: now,
        counts: emptyWorkCounts(),
        items: [],
    };
    const merged: WorkEvent[] = [...current.items];
    events.forEach(item => {
        const existingIndex = merged.findIndex(existing => existing.id === item.id || isDuplicateWorkEvent(existing, item));
        if (existingIndex === -1) {
            merged.push(item);
        } else {
            merged[existingIndex] = mergeWorkEvent(merged[existingIndex], item);
        }
    });
    const nextStatus = status || current.status;
    const completedAt = ['completed', 'failed', 'stopped', 'rejected'].includes(nextStatus)
        ? current.completedAt || now
        : undefined;
    return {
        ...summaries,
        [turnId]: recalculateWorkSummary({
            ...current,
            sessionId: sessionId || current.sessionId,
            status: nextStatus,
            completedAt,
            items: merged,
        }),
    };
}

export function closeEditRows(
    summaries: Record<string, WorkSummary>,
    files: string[] = [],
    decision: 'accepted' | 'rejected' = 'accepted',
): Record<string, WorkSummary> {
    const normalizedFiles = new Set(files.map(file => compactTarget(file).toLowerCase()).filter(Boolean));
    let changed = false;

    const next = Object.entries(summaries).reduce<Record<string, WorkSummary>>((acc, [turnId, summary]) => {
        const items = summary.items.map(item => {
            if (item.type !== 'edit' || item.status !== 'waiting') return item;
            const target = compactTarget(item.path || item.target || '').toLowerCase();
            if (normalizedFiles.size > 0 && !normalizedFiles.has(target)) return item;
            changed = true;
            return {
                ...item,
                label: decision === 'rejected' ? 'Changes discarded' : item.label,
                status: 'completed' as const,
                timestamp: Date.now(),
            };
        });

        const stillWaiting = items.some(item => item.status === 'waiting');
        const stillRunning = items.some(item => item.status === 'running');
        const nextStatus: WorkSummaryStatus = stillWaiting
            ? 'waiting'
            : stillRunning
                ? 'running'
                : decision === 'rejected'
                    ? 'rejected'
                    : summary.status === 'waiting'
                        ? 'completed'
                        : summary.status;

        acc[turnId] = recalculateWorkSummary({
            ...summary,
            status: nextStatus,
            completedAt: ['completed', 'failed', 'stopped', 'rejected'].includes(nextStatus) ? summary.completedAt || Date.now() : undefined,
            items,
        });
        return acc;
    }, {});

    return changed ? next : summaries;
}

function closeApprovalRows(
    summaries: Record<string, WorkSummary>,
    approvalId: string,
): Record<string, WorkSummary> {
    let changed = false;
    const next = Object.entries(summaries).reduce<Record<string, WorkSummary>>((acc, [turnId, summary]) => {
        if (!summary.items.some(item => item.id === approvalId)) {
            acc[turnId] = summary;
            return acc;
        }

        changed = true;
        const items = summary.items.map(item => item.id === approvalId
            ? { ...item, label: 'Approval received', status: 'completed' as const }
            : item
        );
        const stillWaiting = items.some(item => item.type === 'approval' && item.status === 'waiting');
        acc[turnId] = recalculateWorkSummary({
            ...summary,
            status: summary.status === 'waiting' && !stillWaiting ? 'running' : summary.status,
            items,
        });
        return acc;
    }, {});

    return changed ? next : summaries;
}

function statusFromProgress(progress: TaskProgress): WorkSummaryStatus {
    const status = (progress.status || '').toLowerCase();
    const event = (progress.event || '').toLowerCase();
    const result = (progress.result || '').toLowerCase();
    if (/waiting for approval/i.test(status)) return 'waiting';
    if (event === 'error' || result === 'error' || /failed|error/i.test(status)) return 'failed';
    if (/stopped|aborted|cancelled/i.test(status)) return 'stopped';
    if (event === 'completed' || result === 'completed' || /mission accomplished|task complete/i.test(status)) return 'completed';
    if (progress.is_active) return 'running';
    return 'completed';
}

function normalizeProgressPayload(progress: TaskProgress): TaskProgress {
    const status = progress.status || (progress.is_active ? 'Working' : 'Idle');
    const steps = Array.isArray(progress.steps)
        ? progress.steps
        : [status, progress.summary].filter(Boolean) as string[];
    const isWaitingForApproval = /waiting for approval/i.test(status);

    return {
        ...progress,
        task_name: progress.task_name || 'Agent activity',
        status,
        mode: progress.mode || 'execution',
        steps,
        files: Array.isArray(progress.files) ? progress.files : [],
        todos: Array.isArray(progress.todos) ? progress.todos : undefined,
        is_active: isWaitingForApproval ? false : progress.is_active,
        timestamp: progress.timestamp || Date.now()
    };
}

/**
 * Hook for managing chat state.
 * Handles message sending, receiving, and history.
 */
export function useChat(sessionId: string | null = null) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [todos, setTodos] = useState<Todo[]>([]);
    const [hubTasks, setHubTasks] = useState<HubTask[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const [currentMode, setCurrentMode] = useState<string>('code');
    const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);
    const [workSummariesByTurn, setWorkSummariesByTurn] = useState<Record<string, WorkSummary>>({});
    const [pendingPermissions, setPendingPermissions] = useState<Record<string, any>>({});
    const [pendingEdits, setPendingEdits] = useState<any[]>([]);
    const [isStopping, setIsStopping] = useState(false);
    const { postMessage, onMessage } = useVSCodeApi();
    const { contextStatus, usageSnapshot } = useUsage(sessionId);

    const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);

    // Debounce for streaming updates - max 5 updates per second
    const pendingUpdateRef = useRef<ChatMessage | null>(null);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const messagesRef = useRef<ChatMessage[]>([]);
    const activeRunIdRef = useRef<string | null>(null);
    const stoppedRunIdsRef = useRef<Set<string>>(new Set());
    const suppressUnscopedEventsUntilRef = useRef(0);
    const DEBOUNCE_MS = 400; // Aggressive debounce to prevent crash during heavy streaming

    const shouldIgnoreRuntimeEvent = useCallback((runId?: string) => {
        if (runId) return stoppedRunIdsRef.current.has(runId);
        return Date.now() < suppressUnscopedEventsUntilRef.current;
    }, []);

    const finishStoppedRun = useCallback((runId?: string | null) => {
        const id = runId || activeRunIdRef.current;
        if (id) stoppedRunIdsRef.current.add(id);
        suppressUnscopedEventsUntilRef.current = Date.now() + 15000;
        activeRunIdRef.current = null;
        pendingUpdateRef.current = null;
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        setIsStopping(false);
        setIsLoading(false);
        setTaskProgress(prev => prev ? { ...prev, is_active: false, status: 'Stopped' } : null);
        if (id) {
            setWorkSummariesByTurn(prev => upsertWorkEvents(prev, id, sessionId || undefined, [], 'stopped'));
        }
        setPendingPermissions({});
    }, [sessionId]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const flushPendingUpdate = useCallback(() => {
        debounceTimerRef.current = null;
        if (pendingUpdateRef.current) {
            const update = pendingUpdateRef.current;
            pendingUpdateRef.current = null;
            setMessages(prev => {
                if (update.role === 'assistant') {
                    return upsertAssistantMessage(prev, update);
                }
                const existing = prev.find(m => m.id === update.id);
                if (existing) return prev.map(m => m.id === update.id ? mergeChatMessage(m, update) : m);
                return [...prev, update];
            });
        }
    }, []);

    const respondToPermission = useCallback((id: string, answer: string) => {
        postMessage({ type: 'permission_response', payload: { id, answer } });
        // Optimistic UI cleanup
        setPendingPermissions(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        setWorkSummariesByTurn(prev => {
            const turnId = activeRunIdRef.current;
            if (!turnId) return prev;
            return upsertWorkEvents(prev, turnId, sessionId || undefined, [], 'running');
        });
    }, [postMessage, sessionId]);

    const finalizeStreamingMessages = useCallback(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }

        const pendingUpdate = pendingUpdateRef.current;
        pendingUpdateRef.current = null;

        setMessages(prev => {
            let next = prev;

            if (pendingUpdate) {
                next = pendingUpdate.role === 'assistant'
                    ? upsertAssistantMessage(next, pendingUpdate)
                    : next.find(m => m.id === pendingUpdate.id)
                        ? next.map(m => m.id === pendingUpdate.id ? mergeChatMessage(m, pendingUpdate) : m)
                        : isRenderableChatMessage(pendingUpdate) ? [...next, pendingUpdate] : next;
            }

            return filterRenderableMessages(next).map(message =>
                message.role === 'assistant' && message.isStreaming
                    ? { ...message, isStreaming: false }
                    : message
            );
        });
    }, []);

    // Listen for chat updates from extension
    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'chat_update':
                    const update = normalizeChatUpdate(message);
                    if (!update) return;
                    if (sessionId && update.session_id && update.session_id !== sessionId) return;
                    if (shouldIgnoreRuntimeEvent(update.run_id || update.message?.run_id)) return;
                    if (!update.message?.id || !update.message?.role) return; // Filter empty dummy messages
                    const incomingMessage = {
                        timestamp: Date.now(),
                        ...update.message,
                        run_id: update.message.run_id || update.run_id,
                        turn_id: getTurnId(update.message, update.run_id || activeRunIdRef.current)
                    } as ChatMessage;
                    const turnId = getTurnId(incomingMessage, update.run_id || activeRunIdRef.current);
                    const forceWorkCommentary = shouldCreateWorkCommentary(incomingMessage);
                    const commentaryEvent = messageToCommentaryEvent(incomingMessage, forceWorkCommentary);
                    const keepAssistantBubble = shouldKeepAssistantBubble(incomingMessage, forceWorkCommentary);
                    const workEvents: WorkEvent[] = [
                        ...(commentaryEvent ? [commentaryEvent] : []),
                        ...((incomingMessage.activities || [])
                            .map((activity, index) => activityToWorkEvent(activity, index))
                            .filter(Boolean) as WorkEvent[]),
                        ...((incomingMessage.toolCalls || [])
                            .map(classifyTool)
                            .filter(Boolean) as WorkEvent[]),
                        ...(((incomingMessage as any).artifacts || [])
                            .filter(isTimelineArtifact)
                            .map((artifact: any, index: number) => ({
                            id: `artifact-${artifact.path || artifact.title || index}`,
                            type: 'artifact' as const,
                            label: 'Document',
                            target: artifactDisplayTarget(artifact),
                            path: artifact.path,
                            artifactType: artifact.type,
                            status: 'completed' as const,
                            timestamp: incomingMessage.timestamp || Date.now(),
                        }))),
                    ];
                    if (workEvents.length > 0) {
                        setWorkSummariesByTurn(prev => upsertWorkEvents(
                            prev,
                            turnId,
                            update.session_id || sessionId || undefined,
                            workEvents,
                            incomingMessage.isStreaming ? 'running' : undefined
                        ));
                    } else if (
                        incomingMessage.role === 'assistant' &&
                        incomingMessage.isStreaming &&
                        incomingMessage.reasoning?.trim() &&
                        !normalizeWorkCommentaryText(incomingMessage.content || '') &&
                        !(incomingMessage.toolCalls?.length || incomingMessage.activities?.length || (incomingMessage as any).artifacts?.length)
                    ) {
                        setWorkSummariesByTurn(prev => markWorkSummaryActivityHint(
                            prev,
                            turnId,
                            update.session_id || sessionId || undefined,
                            'hidden_reasoning',
                            'running'
                        ));
                    }

                    // Final messages apply immediately
                    if (!incomingMessage.isStreaming) {
                        // Clear any pending debounce
                        if (debounceTimerRef.current) {
                            clearTimeout(debounceTimerRef.current);
                            debounceTimerRef.current = null;
                        }
                        pendingUpdateRef.current = null;
                        setMessages(prev => {
                            if (incomingMessage.role === 'assistant' && !keepAssistantBubble) {
                                return prev.filter(m => m.id !== incomingMessage.id);
                            }

                            if (incomingMessage.role === 'assistant') {
                                return upsertAssistantMessage(prev, incomingMessage);
                            }

                            const existing = prev.find(m => m.id === incomingMessage.id);
                            if (existing) {
                                return prev.map(m => m.id === incomingMessage.id ? mergeChatMessage(m, incomingMessage) : m);
                            }

                            // Deduplicate user echoes: if we receive a user message from backend that matches
                            // our local optimistic message, replace the local one to get correct ID and state.
                            if (incomingMessage.role === 'user') {
                                const optimisticMatchIdx = [...prev].reverse().findIndex(m =>
                                    m.role === 'user' &&
                                    m.id.startsWith('msg-') &&
                                    m.content.trim() === incomingMessage.content.trim()
                                );

                                if (optimisticMatchIdx !== -1) {
                                    const actualIdx = prev.length - 1 - optimisticMatchIdx;
                                    const next = [...prev];
                                    next[actualIdx] = incomingMessage;
                                    return next;
                                }
                            }

                            return [...prev, incomingMessage];
                        });
                        if (incomingMessage.role === 'assistant') {
                            setIsLoading(false);
                            if (!hasWorkPayload(incomingMessage)) {
                                setWorkSummariesByTurn(prev => upsertWorkEvents(
                                    prev,
                                    turnId,
                                    update.session_id || sessionId || undefined,
                                    [],
                                    incomingMessage.errorInfo ? 'failed' : 'completed'
                                ));
                            }
                        }
                    } else {
                        // Streaming: debounce updates (only update every 200ms)
                        if (incomingMessage.role === 'assistant' && !keepAssistantBubble) {
                            if (pendingUpdateRef.current?.id === incomingMessage.id) {
                                pendingUpdateRef.current = null;
                            }
                            setMessages(prev => prev.filter(m => m.id !== incomingMessage.id));
                        } else {
                            pendingUpdateRef.current = incomingMessage;
                            if (!debounceTimerRef.current) {
                                debounceTimerRef.current = setTimeout(flushPendingUpdate, DEBOUNCE_MS);
                            }
                        }
                        setIsLoading(true);
                    }
                    break;
                case 'ask_user_choice':
                case 'request_permission':
                    {
                        const request = normalizeInteractionRequest(message);
                        if (request) {
                            if (sessionId && request.sessionId && request.sessionId !== sessionId) return;
                            setPendingPermissions(prev => ({
                                ...prev,
                                [request.id]: request
                            }));
                            const turnId = activeRunIdRef.current || `turn-${request.id}`;
                            setWorkSummariesByTurn(prev => upsertWorkEvents(prev, turnId, request.sessionId || sessionId || undefined, [{
                                id: `approval-${request.id}`,
                                type: 'approval',
                                label: 'Waiting for approval',
                                target: request.question,
                                status: 'waiting',
                                timestamp: Date.now(),
                            }], 'waiting'));
                        }
                    }
                    setIsLoading(true); // Keep "Stop" button visible while waiting for choice
                    break;
                case 'permission_response_received': // Cleanup if handled elsewhere
                    const permPayload = message.payload as any;
                    setPendingPermissions(prev => {
                        const next = { ...prev };
                        delete next[permPayload.id];
                        return next;
                    });
                    if (permPayload?.id) {
                        setWorkSummariesByTurn(prev => closeApprovalRows(prev, `approval-${permPayload.id}`));
                    }
                    break;
                case 'edit_approval_resolved':
                    {
                        const payload = (message.payload || {}) as EditApprovalResolvedPayload;
                        const payloadSessionId = payload.session_id || payload.sessionId;
                        if (sessionId && payloadSessionId && payloadSessionId !== sessionId) return;
                        if (shouldIgnoreRuntimeEvent(payload.run_id || payload.runId)) return;
                        const files = payload.files || payload.filePaths || [];
                        const decision = payload.decision === 'rejected' ? 'rejected' : 'accepted';
                        setPendingEdits([]);
                        setWorkSummariesByTurn(prev => closeEditRows(prev, files, decision));
                    }
                    break;
                case 'ask_completion_result':
                    {
                        const payload = (message.payload || {}) as { session_id?: string; sessionId?: string; run_id?: string };
                        const payloadSessionId = payload.session_id || payload.sessionId;
                        if (sessionId && payloadSessionId && payloadSessionId !== sessionId) return;
                        if (shouldIgnoreRuntimeEvent(payload.run_id)) return;
                    }
                    finalizeStreamingMessages();
                    setIsLoading(false);
                    setIsStopping(false);
                    setTaskProgress(prev => prev ? { ...prev, is_active: false } : null);
                    setWorkSummariesByTurn(prev => {
                        const turnId = activeRunIdRef.current;
                        if (!turnId) return prev;
                        return upsertWorkEvents(prev, turnId, sessionId || undefined, [], 'completed');
                    });
                    break;
                case 'generation_cancelled':
                case 'run_aborted':
                    {
                        const payload = (message.payload || {}) as { session_id?: string; sessionId?: string; run_id?: string };
                        const payloadSessionId = payload.session_id || payload.sessionId;
                        if (sessionId && payloadSessionId && payloadSessionId !== sessionId) return;
                        finishStoppedRun(payload.run_id);
                    }
                    finalizeStreamingMessages();
                    break;
                case 'chat_cleared':
                    setMessages([]);
                    setWorkSummariesByTurn({});
                    setHubTasks([]);
                    break;
                case 'state':
                    // ... existing
                            const state = message.payload as { messages?: ChatMessage[]; mode?: string; todos?: Todo[]; session_id?: string };
                    if (state.messages) {
                        setMessages(filterRenderableMessages(state.messages));
                        setWorkSummariesByTurn({});
                    }
                    if (!activeRunIdRef.current) {
                        setTaskProgress(null);
                        setIsLoading(false);
                        setIsStopping(false);
                    }
                    if (state.mode) setCurrentMode(state.mode);
                    if (state.todos) setTodos(state.todos);
                    break;
                case 'session_loaded':
                    const loaded = message.payload as { messages?: ChatMessage[]; todos?: Todo[] };
                    setMessages(filterRenderableMessages(loaded.messages || []));
                    setWorkSummariesByTurn({});
                    if (!activeRunIdRef.current) {
                        setTaskProgress(null);
                    }
                    activeRunIdRef.current = null;
                    setTodos(loaded.todos || []);
                    setHubTasks([]);
                    setIsLoading(false);
                    setIsStopping(false);
                    break;
                case 'mode_changed':
                    // ... existing
                    const { mode } = message.payload as { mode: string };
                    setCurrentMode(mode);
                    break;
                case 'task_state_updated':
                    // ... existing
                    const taskState = message.payload as { todos: Todo[]; session_id?: string };
                    if (sessionId && taskState.session_id && taskState.session_id !== sessionId) return;
                    setTodos(taskState.todos);
                    break;
                case 'tasks_updated':
                    setHubTasks(normalizeHubTasksPayload(message.payload));
                    break;
                case 'file_search_results':
                    setFileResults(message.payload as FileSearchResult[]);
                    break;
                case 'command_event':
                    {
                        const payload = (message.payload || {}) as CommandEvent;
                        if (sessionId && payload.session_id && payload.session_id !== sessionId) return;
                        if (shouldIgnoreRuntimeEvent(payload.run_id)) return;
                        const workEvent = commandEventToWorkEvent(payload);
                        if (!workEvent) return;
                        const turnId = resolveRuntimeTurnIdForEvent({
                            runId: payload.run_id,
                            turnId: payload.turn_id,
                            activeRunId: activeRunIdRef.current,
                            messages: messagesRef.current,
                            fallback: `command-${payload.command_id || payload.timestamp || Date.now()}`,
                        });
                        setWorkSummariesByTurn(prev => upsertWorkEvents(
                            prev,
                            turnId,
                            payload.session_id || sessionId || undefined,
                            [workEvent],
                            'running'
                        ));
                        if (workEvent.status === 'running') {
                            setIsLoading(true);
                        }
                    }
                    break;
                case 'tool_lifecycle':
                    {
                        const payload = (message.payload || {}) as ToolLifecycleEventPayload;
                        if (sessionId && payload.session_id && payload.session_id !== sessionId) return;
                        if (shouldIgnoreRuntimeEvent(payload.run_id)) return;
                        const workEvent = toolLifecycleEventToWorkEvent(payload);
                        const turnId = resolveRuntimeTurnIdForEvent({
                            runId: payload.run_id,
                            turnId: payload.turn_id,
                            activeRunId: activeRunIdRef.current,
                            messages: messagesRef.current,
                            fallback: `tool-${payload.tool_use_id || payload.timestamp || Date.now()}`,
                        });
                        if (workEvent) {
                            setWorkSummariesByTurn(prev => upsertWorkEvents(
                                prev,
                                turnId,
                                payload.session_id || sessionId || undefined,
                                [workEvent],
                                toolLifecycleSummaryStatus(payload)
                            ));
                        }
                        if (payload.status === 'running' || payload.event === 'tool_started') {
                            setIsLoading(true);
                        }
                    }
                    break;
                case 'context_compaction':
                    {
                        const payload = (message.payload || {}) as {
                            session_id?: string;
                            run_id?: string;
                            event?: string;
                            summary?: string;
                            error?: string;
                            tokens_before?: number;
                            tokens_after?: number;
                            timestamp?: number;
                        };
                        if (sessionId && payload.session_id && payload.session_id !== sessionId) return;
                        if (shouldIgnoreRuntimeEvent(payload.run_id)) return;
                        const turnId = payload.run_id || activeRunIdRef.current || `context-${payload.timestamp || Date.now()}`;
                        const failed = /failed/i.test(payload.event || '') || Boolean(payload.error);
                        setWorkSummariesByTurn(prev => upsertWorkEvents(prev, turnId, payload.session_id || sessionId || undefined, [{
                            id: `context-${payload.event || 'compaction'}-${payload.timestamp || turnId}`,
                            type: failed ? 'error' : 'artifact',
                            label: failed ? 'Context compaction failed' : 'Context compacted',
                            target: payload.summary || [
                                payload.tokens_before ? `${payload.tokens_before} tokens` : '',
                                payload.tokens_after ? `-> ${payload.tokens_after}` : '',
                            ].filter(Boolean).join(' '),
                            status: failed ? 'failed' : 'completed',
                            error: payload.error,
                            timestamp: payload.timestamp || Date.now(),
                        }], failed ? 'failed' : 'running'));
                    }
                    break;
                case 'checkpoint_event':
                    {
                        const payload = (message.payload || {}) as {
                            session_id?: string;
                            run_id?: string;
                            event?: string;
                            hash?: string;
                            message?: string;
                            error?: string;
                            duration_ms?: number;
                            timestamp?: number;
                        };
                        if (sessionId && payload.session_id && payload.session_id !== sessionId) return;
                        if (shouldIgnoreRuntimeEvent(payload.run_id)) return;
                        const failed = /failed/i.test(payload.event || '') || Boolean(payload.error);
                        const turnId = payload.run_id || activeRunIdRef.current || `checkpoint-${payload.timestamp || Date.now()}`;
                        setWorkSummariesByTurn(prev => upsertWorkEvents(prev, turnId, payload.session_id || sessionId || undefined, [{
                            id: `checkpoint-${payload.hash || payload.event || payload.timestamp || turnId}`,
                            type: failed ? 'error' : 'artifact',
                            label: failed ? 'Checkpoint failed' : 'Checkpoint',
                            target: payload.message || payload.hash || payload.event,
                            status: failed ? 'failed' : 'completed',
                            durationMs: payload.duration_ms,
                            error: payload.error,
                            timestamp: payload.timestamp || Date.now(),
                        }], failed ? 'failed' : 'running'));
                    }
                    break;
                case 'message_queued':
                    setIsLoading(true);
                    break;
                case 'task_progress':
                    const progressPayload = normalizeTaskProgress(message) as TaskProgress | null;
                    if (!progressPayload) return;
                    if (shouldIgnoreRuntimeEvent(progressPayload.run_id)) return;
                    const progress = normalizeProgressPayload(progressPayload);
                    if (sessionId && progress.session_id && progress.session_id !== sessionId) return;
                    setTaskProgress(progress);
                    if (progress.todos?.length) {
                        setTodos(progress.todos);
                    }
                    {
                        const turnId = progress.run_id || activeRunIdRef.current || progress.turn_id || `progress-${progress.segment_id || Date.now()}`;
                        const workEvent = parseProgressStatus(progress);
                        setWorkSummariesByTurn(prev => upsertWorkEvents(
                            prev,
                            turnId,
                            progress.session_id || sessionId || undefined,
                            workEvent ? [workEvent] : [],
                            statusFromProgress(progress)
                        ));
                    }
                    if (progress.is_active) {
                        setIsLoading(true); // Keep UI in loading state while tools are running
                    } else if (!messagesRef.current.some(m => m.role === 'assistant' && m.isStreaming)) {
                        setIsLoading(false);
                    }
                    break;
                case 'pending_edits':
                    if (shouldIgnoreRuntimeEvent((message.payload as any)?.run_id)) return;
                    setPendingEdits(Array.isArray(message.payload) ? message.payload as any[] : []);
                    {
                        const edits = Array.isArray(message.payload) ? message.payload as any[] : [];
                        const turnId = (message.payload as any)?.run_id || activeRunIdRef.current;
                        if (turnId && edits.length > 0) {
                            setWorkSummariesByTurn(prev => upsertWorkEvents(prev, turnId, sessionId || undefined, edits.map(edit => ({
                                id: `pending-edit-${edit.filePath}`,
                                type: 'edit' as const,
                                label: edit.isNewFile ? 'Created' : 'Modified',
                                target: compactTarget(edit.filePath || ''),
                                path: edit.filePath,
                                additions: typeof edit.additions === 'number' ? edit.additions : undefined,
                                deletions: typeof edit.deletions === 'number' ? edit.deletions : undefined,
                                status: edit.status === 'conflicted' ? 'failed' as const : 'waiting' as const,
                                timestamp: Date.now(),
                            })), 'waiting'));
                        } else if (edits.length === 0) {
                            setWorkSummariesByTurn(prev => closeEditRows(prev, [], 'accepted'));
                        }
                    }
                    break;
                case 'error':
                    const errMsg = (message.payload as { message: string }).message;
                    setMessages(prev => [...prev, {
                        id: `err-${Date.now()}`,
                        role: 'assistant',
                        content: '',
                        errorInfo: chatErrorInfoFromRaw(errMsg),
                        timestamp: Date.now()
                    }]);
                    if (activeRunIdRef.current) {
                        setWorkSummariesByTurn(prev => upsertWorkEvents(
                            prev,
                            activeRunIdRef.current!,
                            sessionId || undefined,
                            [],
                            'failed'
                        ));
                    }
                    setIsLoading(false);
                    break;
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, sessionId, finalizeStreamingMessages, shouldIgnoreRuntimeEvent, finishStoppedRun]);

    // Request state when sessionId changes (restores history when switching sessions)
    useEffect(() => {
        // Clear messages first to prevent showing old session's messages
        setMessages([]);
        setTodos([]);
        setHubTasks([]);
        setWorkSummariesByTurn({});
        setTaskProgress(null);
        setPendingPermissions({});
        setPendingEdits([]);
        activeRunIdRef.current = null;
        pendingUpdateRef.current = null;
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        setIsLoading(false);
        setIsStopping(false);

        if (!sessionId) {
            return;
        }

        // Use a short timeout to ensure the clear completes before the new load happens
        // This prevents the 'flicker' where old messages might persist if get_state returns quickly
        const t = setTimeout(() => {
            postMessage({ type: 'get_state', payload: { sessionId } });
        }, 10);
        return () => clearTimeout(t);
    }, [postMessage, sessionId]);

    // ... existing initialization

    const sendMessage = useCallback((content: string, contextFiles: ContextFilePayload[] = [], planMode = false) => {
        // ... existing
        if (!content.trim()) return;

        // Slash Command Interception
        if (content.trim().startsWith('/')) {
            const [cmd] = content.trim().split(' ');
            if (cmd === '/clear' || cmd === '/reset') {
                postMessage({ type: 'clear_chat' });
                return;
            }
            // /mode is handled by backend text processing usually, or we can handle it here if we want explicit event.
            // For now, let other commands pass through to backend (e.g. /mode)
        }

        const userMessage: ChatMessage = {
            id: `msg-${Date.now()}`,
            role: 'user',
            content: content.trim(),
            timestamp: Date.now()
        };
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        activeRunIdRef.current = runId;
        stoppedRunIdsRef.current.delete(runId);
        suppressUnscopedEventsUntilRef.current = 0;

        setMessages(prev => [...prev, { ...userMessage, run_id: runId, turn_id: runId }]);
        setTaskProgress(null);
        setPendingPermissions({});
        setWorkSummariesByTurn(prev => upsertWorkEvents(prev, runId, sessionId || undefined, [], 'running'));
        setIsLoading(true);
        setIsStopping(false);
        setInputValue('');

        const contextPayload = contextFiles
            .filter(file => file?.path)
            .map(file => ({
                path: file.stagedPath || file.path,
                name: file.name,
                kind: file.kind || 'file',
                size: file.size,
                source: file.source,
                mime: file.mime,
                stagedPath: file.stagedPath,
            }));

        postMessage({
            type: 'send_message',
            payload: sessionId
                ? { content: content.trim(), session_id: sessionId, run_id: runId, context_files: contextPayload, plan_mode: planMode }
                : { content: content.trim(), run_id: runId, context_files: contextPayload, plan_mode: planMode }
        });
    }, [postMessage, sessionId]);

    const switchMode = useCallback((mode: string) => {
        postMessage({
            type: 'send_message',
            payload: { content: `/mode ${mode}` }
        });
    }, [postMessage]);

    const searchFiles = useCallback((query: string) => {
        postMessage({
            type: 'search_files',
            payload: { query }
        });
    }, [postMessage]);

    const executeCommand = useCallback((command: string) => {
        postMessage({
            type: 'execute_command',
            payload: { command }
        });
    }, [postMessage]);

    const saveCheckpoint = useCallback((message?: string) => {
        postMessage({
            type: 'save_checkpoint',
            payload: { message }
        });
    }, [postMessage]);

    const restoreCheckpoint = useCallback((hash: string) => {
        postMessage({
            type: 'restore_checkpoint',
            payload: { hash }
        });
    }, [postMessage]);

    const cancelGeneration = useCallback(() => {
        if (isStopping) return;
        setIsStopping(true);
        postMessage({ type: 'cancel_generation', payload: { run_id: activeRunIdRef.current, session_id: sessionId || undefined } });
    }, [isStopping, postMessage, sessionId]);

    const taskRun = useMemo(() => buildTaskRunViewModel({
        messages,
        todos,
        hubTasks,
        taskProgress,
        workSummariesByTurn,
        usageSnapshot,
        contextStatus,
        isLoading,
    }), [contextStatus, hubTasks, isLoading, messages, taskProgress, todos, usageSnapshot, workSummariesByTurn]);

    return {
        messages,
        todos,
        hubTasks,
        isLoading,
        isStopping,
        inputValue,
        currentMode,
        contextStatus,
        usageSnapshot,
        taskProgress,
        taskRun,
        workSummariesByTurn,
        fileResults,
        pendingPermissions,
        pendingEdits,
        setInputValue,
        sendMessage,
        switchMode,
        searchFiles,
        executeCommand,
        saveCheckpoint,
        restoreCheckpoint,
        cancelGeneration,
        respondToPermission
    };
}

export interface FileSearchResult {
    path: string;
    name: string;
    kind?: 'file' | 'folder' | string;
    size?: number;
}
