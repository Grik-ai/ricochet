import { SessionState, type SessionContext, type SessionUiState } from '../services/state-machine/sessionStateMachine';

export type MissionDisplayStatus = 'Idle' | 'Ready' | 'Waiting' | 'Running' | 'Agents' | 'Completed' | 'Failed' | 'Stopped';

export interface MissionRuntime {
    hasMissionResources: boolean;
    hasActiveWork: boolean;
    hasPendingInteraction: boolean;
    hasWorkers: boolean;
    activeWorkerCount: number;
    queuedWorkerCount: number;
    completedWorkerCount: number;
    activeToolCount: number;
    isParentOnlyComplete: boolean;
    shouldShowPill: boolean;
    canAbort: boolean;
    displayStatus: MissionDisplayStatus;
    pillLabel: string;
    title: string;
    detail: string;
    footerText: string;
    tone: 'idle' | 'active' | 'waiting' | 'success' | 'error';
}

const activeWorkerStatuses = new Set(['queued', 'running', 'in progress']);
const ACTIVE_TOOL_STALE_MS = 5 * 60 * 1000;

function isActiveWorker(status?: string, isActive?: boolean) {
    return Boolean(isActive) || activeWorkerStatuses.has((status || '').toLowerCase());
}

function isTerminalMission(context: SessionContext, state: SessionState) {
    return context.missionStatus === 'completed'
        || context.missionStatus === 'failed'
        || context.missionStatus === 'stopped'
        || state === SessionState.completed
        || state === SessionState.error
        || state === SessionState.stopped;
}

function isFreshRunningTool(tool: SessionContext['activeToolCalls'][string], context: SessionContext, now: number) {
    if (tool.status !== 'running') return false;
    const toolSessionId = (tool as any).session_id || (tool as any).sessionId;
    if (context.sessionId && toolSessionId && toolSessionId !== context.sessionId) return false;
    if (!tool.updatedAt) return true;
    return now - tool.updatedAt < ACTIVE_TOOL_STALE_MS;
}

function hasMissionLog(context: SessionContext) {
    return (context.logs || []).some(log => (
        log.type.startsWith('worker_') ||
        log.type.startsWith('mission_') ||
        log.type === 'permission_requested' ||
        log.type === 'choice'
    ));
}

export function deriveMissionRuntime(
    context: SessionContext,
    state: SessionState,
    uiState: SessionUiState
): MissionRuntime {
    const now = Date.now();
    const terminalMission = isTerminalMission(context, state);
    const workers = Object.values(context.workers || {});
    const activeWorkerCount = workers.filter(worker => isActiveWorker(worker.status, worker.isActive)).length;
    const queuedWorkerCount = workers.filter(worker => (worker.status || '').toLowerCase() === 'queued').length;
    const completedWorkerCount = workers.filter(worker => (worker.status || '').toLowerCase() === 'completed').length;
    const activeToolCount = terminalMission
        ? 0
        : Object.values(context.activeToolCalls || {}).filter(tool => isFreshRunningTool(tool, context, now)).length;
    const hasPendingInteraction = Boolean(context.pendingChoice || context.pendingTool || state === SessionState.waiting_input || state === SessionState.waiting_approval);
    const hasWorkers = workers.length > 0;
    const hasRuntimeTools = activeToolCount > 0;
    const hasMissionResources = hasWorkers || hasRuntimeTools || hasPendingInteraction || hasMissionLog(context);
    const hasActiveWork = activeWorkerCount > 0 || activeToolCount > 0 || hasPendingInteraction;
    const isParentOnlyComplete = context.parentTurnStatus === 'completed' && !hasActiveWork;
    const canAbort = hasActiveWork && uiState.showCancelButton && !isParentOnlyComplete;

    let displayStatus: MissionDisplayStatus = 'Idle';
    let pillLabel = 'Mission Dashboard';
    let detail = 'No active mission';
    let footerText: string = context.missionStatus || 'idle';
    let tone: MissionRuntime['tone'] = 'idle';

    if (context.missionStatus === 'failed' || state === SessionState.error) {
        displayStatus = 'Failed';
        pillLabel = 'Failed';
        detail = 'Mission failed';
        footerText = 'Failed';
        tone = 'error';
    } else if (context.missionStatus === 'stopped' || state === SessionState.stopped) {
        displayStatus = 'Stopped';
        pillLabel = 'Stopped';
        detail = 'Mission stopped';
        footerText = 'Stopped';
        tone = 'error';
    } else if (hasPendingInteraction) {
        displayStatus = 'Waiting';
        pillLabel = 'Approval';
        detail = 'Waiting for approval';
        footerText = 'Waiting for approval';
        tone = 'waiting';
    } else if (activeWorkerCount > 0) {
        displayStatus = 'Agents';
        pillLabel = `${activeWorkerCount} agent${activeWorkerCount === 1 ? '' : 's'}`;
        detail = `Agents ${activeWorkerCount} running, ${queuedWorkerCount} queued, ${completedWorkerCount} done`;
        footerText = context.parentTurnStatus === 'completed'
            ? 'Parent turn complete · waiting for agents'
            : detail;
        tone = 'active';
    } else if (activeToolCount > 0) {
        displayStatus = 'Running';
        pillLabel = activeToolCount === 1 ? 'Tool running' : `${activeToolCount} tools`;
        detail = activeToolCount === 1 ? 'Tool running' : `${activeToolCount} tools running`;
        footerText = detail;
        tone = 'active';
    } else if (context.missionStatus === 'completed' || state === SessionState.completed) {
        displayStatus = 'Completed';
        pillLabel = 'Done';
        detail = 'Mission completed';
        footerText = 'Completed';
        tone = 'success';
    } else if (isParentOnlyComplete) {
        displayStatus = hasMissionResources ? 'Completed' : 'Ready';
        pillLabel = hasMissionResources ? 'Done' : 'Mission Dashboard';
        detail = 'Parent turn complete';
        footerText = 'Parent turn complete';
        tone = hasMissionResources ? 'success' : 'idle';
    } else if (hasMissionResources && uiState.isActive) {
        displayStatus = 'Running';
        pillLabel = 'Running';
        detail = 'Mission running';
        footerText = 'Running';
        tone = 'active';
    } else if (hasMissionResources) {
        displayStatus = 'Ready';
        pillLabel = 'Mission Dashboard';
        detail = 'Mission resources ready';
        footerText = 'Ready';
        tone = 'idle';
    }

    return {
        hasMissionResources,
        hasActiveWork,
        hasPendingInteraction,
        hasWorkers,
        activeWorkerCount,
        queuedWorkerCount,
        completedWorkerCount,
        activeToolCount,
        isParentOnlyComplete,
        shouldShowPill: hasMissionResources,
        canAbort,
        displayStatus,
        pillLabel,
        title: displayStatus === 'Idle' ? 'Open Mission Dashboard' : `Open Mission Dashboard · ${detail.toLowerCase()}`,
        detail,
        footerText,
        tone,
    };
}
