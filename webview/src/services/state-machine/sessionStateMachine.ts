/**
 * Session State Machine
 *
 * Manages the lifecycle state of an agent session from creation to completion.
 */

// ============ States ============
export const SessionState = {
    idle: "idle",
    creating: "creating",
    streaming: "streaming",
    waiting_approval: "waiting_approval",
    waiting_input: "waiting_input",
    completed: "completed",
    paused: "paused",
    error: "error",
    stopped: "stopped",
} as const

export type SessionState = (typeof SessionState)[keyof typeof SessionState]

// ============ Events ============

type StartSessionEvent = { type: "start_session"; content?: string }
type SessionCreatedEvent = { type: "session_created"; sessionId: string }
type ApiReqStartedEvent = { type: "api_req_started" }
type SayTextEvent = { type: "say_text"; partial?: boolean; payload?: { text: string } }
type AskToolEvent = { type: "ask_tool"; partial?: boolean; payload?: { name: string; args: any; toolId: string } }
type AskCommandEvent = { type: "ask_command"; partial: boolean }
type AskBrowserActionLaunchEvent = { type: "ask_browser_action_launch"; partial: boolean }
type AskUseMcpServerEvent = { type: "ask_use_mcp_server"; partial: boolean }
type AskFollowupEvent = { type: "ask_followup"; partial: boolean }
type AskCompletionResultEvent = { type: "ask_completion_result"; payload?: any }
type SubmitInputEvent = { type: "submit_input" } // Optimistic transition
type ProcessErrorEvent = { type: "process_error"; error: string }
type ApproveActionEvent = { type: "approve_action" }
type RejectActionEvent = { type: "reject_action" }
type SendMessageEvent = { type: "send_message"; content: string }
type CancelSessionEvent = { type: "cancel_session" }
type ChatUpdateEvent = { type: "chat_update"; message: any }
type TaskProgressEvent = { type: "task_progress"; payload: any }
type RetryEvent = { type: "retry" }
type AskUserChoiceEvent = { type: "ask_user_choice"; payload: { id: string; choices: string[]; question: string; choiceMetadata?: any[] } }
type AskApiReqFailedEvent = { type: "ask_api_req_failed" }
type AskMistakeLimitReachedEvent = { type: "ask_mistake_limit_reached" }
type AskInvalidModelEvent = { type: "ask_invalid_model" }
type AskPaymentRequiredPromptEvent = { type: "ask_payment_required_prompt" }
type AskResumeTaskEvent = { type: "ask_resume_task" }

export type SessionEvent =
    | StartSessionEvent
    | SessionCreatedEvent
    | ApiReqStartedEvent
    | SayTextEvent
    | AskToolEvent
    | AskCommandEvent
    | AskBrowserActionLaunchEvent
    | AskUseMcpServerEvent
    | AskFollowupEvent
    | AskCompletionResultEvent
    | AskUserChoiceEvent
    | AskApiReqFailedEvent
    | AskMistakeLimitReachedEvent
    | AskInvalidModelEvent
    | AskPaymentRequiredPromptEvent
    | AskResumeTaskEvent
    | SubmitInputEvent
    | ProcessErrorEvent
    | ApproveActionEvent
    | RejectActionEvent
    | SendMessageEvent
    | CancelSessionEvent
    | ChatUpdateEvent
    | TaskProgressEvent
    | RetryEvent

export interface SessionUiState {
    showSpinner: boolean
    showCancelButton: boolean
    isActive: boolean
}

export interface SessionStateMachine {
    getState: () => SessionState
    send: (event: SessionEvent) => void
    getUiState: () => SessionUiState
    getContext: () => SessionContext
    reset: () => void
}

// ============ Context ============
export interface AgentLogEntry {
    id: string;
    timestamp: number;
    type: 'assistant_text' | 'tool_started' | 'tool_finished' | 'status_check' | 'worker_spawned' | 'worker_running' | 'worker_completed' | 'mission_completed' | 'mission_failed' | 'mission_timed_out' | 'permission_requested' | 'info' | 'tool_call' | 'tool_result' | 'error' | 'user' | 'step' | 'choice';
    content: string;
    metadata?: any;
}

export interface SessionContext {
    sessionId?: string
    errorMessage?: string
    missionStatus: 'idle' | 'creating' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'
    parentTurnStatus: 'idle' | 'running' | 'waiting' | 'completed' | 'failed'
    missionTitle?: string
    sawApiReqStarted: boolean
    sawSessionCreated: boolean
    logs: AgentLogEntry[]
    currentMessageId?: string // Track current streaming message to update logic
    workers: Record<string, WorkerState> // Track parallel swarm workers
    activeToolCalls: Record<string, { id: string; name: string; args?: any; status: 'running' | 'completed' | 'failed'; updatedAt: number }>
    lastEventAt?: number
    workerConcurrency?: number
    pendingChoice?: { id: string; choices: string[]; question: string; choiceMetadata?: any[] };
    pendingTool?: { id: string; name: string; args: any };
}


export interface WorkerState {
    id: string;
    name: string;
    status: string;
    isActive: boolean;
    progress?: string;
    color?: string;
    lastResult?: string;
    startedAt?: number;
    updatedAt?: number;
    completedAt?: number;
}

// ...

function createInitialContext(): SessionContext {
    return {
        sessionId: undefined,
        errorMessage: undefined,
        missionStatus: 'idle',
        parentTurnStatus: 'idle',
        missionTitle: undefined,
        sawApiReqStarted: false,
        sawSessionCreated: false,
        logs: [],
        workers: {},
        activeToolCalls: {},
        lastEventAt: undefined,
        workerConcurrency: undefined,
    }
}

function stripReasoningBlocks(text: string): string {
    return text
        .replace(/<(?:thinking|think)>[\s\S]*?(?:<\/(?:thinking|think)>|$)/gi, "")
        .replace(/<(?:thinking|think)\b[\s\S]*$/gi, "")
        .replace(/^\s*(?:thinking|think)>?[\s\S]*$/gi, "")
        .trim();
}

export function createSessionStateMachine(): SessionStateMachine {
    let state: SessionState = SessionState.idle
    let context: SessionContext = createInitialContext()

    const send = (event: SessionEvent): void => {
        const { nextState, contextUpdate } = transition(state, event, context)
        state = nextState
        if (contextUpdate) {
            // Merge simple fields
            const { logs, ...otherUpdates } = contextUpdate;
            context = { ...context, ...otherUpdates }

            // Intelligent Log Merging Logic
            if (logs) {
                const newLogs = [...context.logs];
                logs.forEach(incomingLog => {
                    if (!incomingLog.content.trim()) return;
                    if (incomingLog.type === 'mission_completed') {
                        const existingCompletionIdx = newLogs.findIndex(l => l.type === 'mission_completed');
                        if (existingCompletionIdx !== -1) {
                            newLogs[existingCompletionIdx] = incomingLog;
                            return;
                        }
                    }
                    const existingIdx = newLogs.findIndex(l => l.id === incomingLog.id);
                    if (existingIdx !== -1) {
                        newLogs[existingIdx] = incomingLog;
                    } else {
                        newLogs.push(incomingLog);
                    }
                });
                context.logs = newLogs.sort((a, b) => a.timestamp - b.timestamp);
            }
        }
    }

    const getState = (): SessionState => state

    const getUiState = (): SessionUiState => {
        const hasActiveWorkersValue = hasActiveWorkers(context.workers);
        const hasActiveTools = hasRunningTools(context.activeToolCalls);
        const hasPendingInput = Boolean(context.pendingChoice || context.pendingTool);
        const isRuntimeActive =
            hasActiveWorkersValue ||
            hasActiveTools ||
            hasPendingInput ||
            state === SessionState.creating ||
            state === SessionState.streaming ||
            state === SessionState.waiting_approval ||
            state === SessionState.waiting_input;

        return {
            showSpinner: isRuntimeActive,
            showCancelButton:
                isRuntimeActive &&
                state !== SessionState.completed &&
                state !== SessionState.stopped &&
                state !== SessionState.error,
            isActive: isRuntimeActive,
        }
    }

    const getContext = (): SessionContext => ({ ...context })

    const reset = (): void => {
        state = SessionState.idle
        context = createInitialContext()
    }

    return {
        getState,
        send,
        getUiState,
        getContext,
        reset,
    }
}

// ============ Transition Logic ============

interface TransitionResult {
    nextState: SessionState
    contextUpdate?: Partial<SessionContext>
}

function transition(currentState: SessionState, event: SessionEvent, context: SessionContext): TransitionResult {
    switch (currentState) {
        case SessionState.idle:
            return transitionFromIdle(event, context)

        case SessionState.creating:
            return transitionFromCreating(event, context)

        case SessionState.streaming:
            return transitionFromStreaming(event, context, currentState)

        case SessionState.waiting_approval:
            return transitionFromWaitingApproval(event, context)

        case SessionState.waiting_input:
            return transitionFromWaitingInput(event, context)

        case SessionState.completed:
            return transitionFromCompleted(event, context)

        case SessionState.paused:
            return transitionFromPaused(event, context)

        case SessionState.error:
            return transitionFromError(event, context)

        case SessionState.stopped:
            return transitionFromStopped(event, context)

        default:
            return { nextState: currentState }
    }
}

function transitionFromIdle(event: SessionEvent, context: SessionContext): TransitionResult {
    switch (event.type) {
        case "start_session":
            return {
                nextState: SessionState.creating,
                contextUpdate: {
                    missionStatus: 'creating',
                    parentTurnStatus: 'running',
                    missionTitle: event.content,
                    lastEventAt: Date.now(),
                    logs: [{
                        id: `mission-start-${Date.now()}`,
                        timestamp: Date.now(),
                        type: 'info',
                        content: 'Mission started.'
                    }]
                }
            }

        // Allow direct transition to streaming if we receive events that indicate
        // the session is already running
        case "session_created":
            return {
                nextState: SessionState.streaming,
                contextUpdate: {
                    sawSessionCreated: true,
                    sessionId: (event as SessionCreatedEvent).sessionId,
                },
            }

        case "api_req_started":
            return {
                nextState: SessionState.streaming,
                contextUpdate: { sawApiReqStarted: true },
            }

        // Handle activity events that can occur in Plan Mode or if a session
        // was started without an explicit start_session event
        case "chat_update":
        case "task_progress":
        case "ask_user_choice":
        case "ask_tool":
        case "say_text":
            // Directly transition via transitionFromStreaming to ensure context is updated
            return transitionFromStreaming(event, context, SessionState.idle)

        default:
            return { nextState: SessionState.idle }
    }
}

function transitionFromCreating(event: SessionEvent, context: SessionContext): TransitionResult {
    switch (event.type) {
        case "session_created": {
            const newContext: Partial<SessionContext> = {
                sawSessionCreated: true,
                sessionId: event.sessionId,
                missionStatus: 'running',
                parentTurnStatus: 'running',
                lastEventAt: Date.now(),
            }
            // Transition to streaming only if we've seen both events
            if (context.sawApiReqStarted) {
                return { nextState: SessionState.streaming, contextUpdate: newContext }
            }
            return { nextState: SessionState.creating, contextUpdate: newContext }
        }

        case "api_req_started": {
            const newContext: Partial<SessionContext> = { sawApiReqStarted: true }
            newContext.missionStatus = 'running';
            newContext.parentTurnStatus = 'running';
            newContext.lastEventAt = Date.now();
            // Transition to streaming only if we've seen both events
            if (context.sawSessionCreated) {
                return { nextState: SessionState.streaming, contextUpdate: newContext }
            }
            return { nextState: SessionState.creating, contextUpdate: newContext }
        }

        case "chat_update":
        case "task_progress":
        case "ask_user_choice":
            // Direct jump to streaming/active if we see real activity
            return transitionFromStreaming(event, context, SessionState.creating)

        case "process_error":
            return {
                nextState: SessionState.error,
                contextUpdate: {
                    errorMessage: event.error,
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingChoice: undefined,
                    pendingTool: undefined,
                    missionStatus: 'failed',
                    parentTurnStatus: 'failed',
                    lastEventAt: Date.now(),
                },
            }

        case "cancel_session":
            return {
                nextState: SessionState.stopped,
                contextUpdate: {
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingChoice: undefined,
                    pendingTool: undefined,
                    missionStatus: 'stopped',
                    parentTurnStatus: 'failed',
                    lastEventAt: Date.now(),
                },
            }

        default:
            return { nextState: SessionState.creating }
    }
}

function parseToolArgs(raw: any): any {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function normalizeWorkerId(id?: string): string {
    if (!id) return '';
    return id.startsWith('agent-') ? id : `agent-${id}`;
}

function hasActiveWorkers(workers: Record<string, WorkerState>): boolean {
    return Object.values(workers).some(worker => worker.isActive || worker.status === 'queued' || worker.status === 'running' || worker.status === 'In Progress');
}

function hasBlockingActiveWorkers(context: SessionContext): boolean {
    return Boolean(context.missionTitle) && hasActiveWorkers(context.workers);
}

function completeRuntimeWorkers(workers: Record<string, WorkerState>, timestamp = Date.now()): Record<string, WorkerState> {
    return Object.fromEntries(Object.entries(workers).map(([id, worker]) => {
        if (!worker.isActive && !/queued|running|in progress|active/i.test(worker.status || '')) {
            return [id, worker];
        }
        return [id, {
            ...worker,
            status: worker.status === 'failed' ? worker.status : 'completed',
            isActive: false,
            completedAt: worker.completedAt || timestamp,
            updatedAt: timestamp,
        }];
    }));
}

function hasRunningTools(activeToolCalls: SessionContext['activeToolCalls']): boolean {
    const now = Date.now();
    return Object.values(activeToolCalls).some(tool => (
        tool.status === 'running' &&
        (!tool.updatedAt || now - tool.updatedAt < 5 * 60 * 1000)
    ));
}

function clearActiveRuntimeCalls(): SessionContext['activeToolCalls'] {
    return {};
}

function completionContextUpdate(context: SessionContext, timestamp = Date.now()): Partial<SessionContext> {
    return {
        activeToolCalls: clearActiveRuntimeCalls(),
        pendingChoice: undefined,
        pendingTool: undefined,
        workers: completeRuntimeWorkers(context.workers, timestamp),
        missionStatus: 'completed',
        parentTurnStatus: 'completed',
        lastEventAt: timestamp,
        logs: [{
            id: `mission-completed-${timestamp}`,
            timestamp,
            type: 'mission_completed',
            content: 'Mission completed.',
        }],
    };
}

function waitingForBlockingWorkersContextUpdate(timestamp = Date.now()): Partial<SessionContext> {
    return {
        activeToolCalls: clearActiveRuntimeCalls(),
        pendingChoice: undefined,
        pendingTool: undefined,
        parentTurnStatus: 'completed',
        missionStatus: 'running',
        lastEventAt: timestamp,
        logs: [{
            id: 'parent-turn-completed-waiting-workers',
            timestamp,
            type: 'info',
            content: 'Parent turn finished; waiting for active workers.',
        }],
    };
}

function completionTransition(context: SessionContext, timestamp = Date.now()): TransitionResult {
    if (hasBlockingActiveWorkers(context)) {
        return {
            nextState: SessionState.streaming,
            contextUpdate: waitingForBlockingWorkersContextUpdate(timestamp),
        };
    }
    return {
        nextState: SessionState.completed,
        contextUpdate: completionContextUpdate(context, timestamp),
    };
}

function upsertWorkerState(
    workers: Record<string, WorkerState>,
    worker: Partial<WorkerState> & { id: string },
    timestamp: number
): Record<string, WorkerState> {
    const previous = workers[worker.id];
    return {
        ...workers,
        [worker.id]: {
            id: worker.id,
            name: worker.name || previous?.name || 'Worker',
            status: worker.status || previous?.status || 'running',
            isActive: worker.isActive ?? previous?.isActive ?? true,
            progress: worker.progress || previous?.progress,
            color: worker.color || previous?.color,
            lastResult: worker.lastResult || previous?.lastResult,
            startedAt: previous?.startedAt || worker.startedAt || timestamp,
            updatedAt: timestamp,
            completedAt: worker.completedAt || previous?.completedAt,
        }
    };
}

function workersFromSwarmResult(result?: string, timestamp = Date.now()): WorkerState[] {
    if (!result) return [];
    const workers: WorkerState[] = [];
    const regex = /(agent-[a-zA-Z0-9-]+)\s*->\s*([^\n\r]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(result)) !== null) {
        workers.push({
            id: match[1],
            name: match[2].trim() || 'Worker',
            status: 'running',
            isActive: true,
            progress: 'Worker running',
            startedAt: timestamp,
            updatedAt: timestamp,
        });
    }
    return workers;
}

function workerLogType(event?: string, status?: string): AgentLogEntry['type'] {
    if (event === 'worker_spawned' || status === 'queued') return 'worker_spawned';
    if (event === 'mission_timed_out' || status === 'timeout') return 'mission_timed_out';
    if (event === 'worker_completed' || status === 'completed') return 'worker_completed';
    if (event === 'worker_aborted' || status === 'aborted') return 'mission_failed';
    if (event === 'worker_failed' || status === 'failed') return 'mission_failed';
    return 'worker_running';
}

function workerLogContent(worker: WorkerState, event?: string): string {
    if (event === 'worker_spawned' || worker.status === 'queued') return `Queued worker ${worker.id}: ${worker.name}`;
    if (event === 'mission_timed_out' || worker.status === 'timeout') return `Worker ${worker.id} timed out; showing partial result.`;
    if (event === 'worker_completed' || worker.status === 'completed') return `Worker ${worker.id} completed: ${worker.name}`;
    if (event === 'worker_aborted' || worker.status === 'aborted') return `Worker ${worker.id} aborted: ${worker.name}`;
    if (event === 'worker_failed' || worker.status === 'failed') return `Worker ${worker.id} failed: ${worker.name}`;
    return `Worker ${worker.id} running: ${worker.name}`;
}

function toolDisplayName(name: string, args: any): string {
    if (name === 'read_file') return `Reading ${String(args.path || args.file || 'file')}`;
    if (name === 'list_dir') return `Exploring ${String(args.path || args.dir || 'folder')}`;
    if (name === 'write_scratchpad') return `Saving notes${args.name ? `: ${args.name}` : ''}`;
    if (name === 'read_scratchpad') return 'Reading shared notes';
    if (name === 'start_swarm') return 'Starting fast bounded swarm';
    return `Running ${name}`;
}

function isLowSignalInternalTool(name: string): boolean {
    return name === 'read_scratchpad';
}

function transitionFromStreaming(event: SessionEvent, context: SessionContext, currentState: SessionState): TransitionResult {
    const timestamp = Date.now();
    switch (event.type) {
        // Stay streaming on any say message
        case "say_text": {
            const visibleText = stripReasoningBlocks((event as SayTextEvent).payload?.text || "");
            if (!visibleText) {
                return { nextState: SessionState.streaming }
            }

            return {
                nextState: SessionState.streaming,
                contextUpdate: {
                    logs: [{
                        id: `log-${timestamp}`,
                        timestamp,
                        type: 'assistant_text',
                        content: visibleText,
                    }]
                    ,
                    missionStatus: 'running',
                    parentTurnStatus: 'running',
                    lastEventAt: timestamp,
                }
            }
        }

        // Stay streaming on api_req_started (new request)
        case "api_req_started":
            return {
                nextState: SessionState.streaming,
                contextUpdate: {
                    missionStatus: 'running',
                    parentTurnStatus: 'running',
                    lastEventAt: timestamp,
                }
            }

        // Approval-required asks (only on complete)
        case "ask_tool":
            return {
                nextState: event.partial ? SessionState.streaming : SessionState.waiting_approval,
                contextUpdate: event.partial ? undefined : {
                    pendingTool: {
                        id: (event as any).payload?.toolId,
                        name: (event as any).payload?.name,
                        args: (event as any).payload?.args
                    },
                    logs: [{
                        id: `log-${timestamp}`,
                        timestamp,
                        type: 'permission_requested',
                        content: (event as any).payload?.name || "Tool Call",
                        metadata: (event as any).payload
                    }]
                    ,
                    missionStatus: 'waiting',
                    parentTurnStatus: 'waiting',
                    lastEventAt: timestamp,
                }
            }

        case "ask_command":
        case "ask_browser_action_launch":
        case "ask_use_mcp_server":
            if (event.partial) {
                return { nextState: SessionState.streaming }
            }
            return { nextState: SessionState.waiting_approval }

        // Input-required asks (only on complete)
        case "ask_followup":
            return {
                nextState: SessionState.waiting_input,
                contextUpdate: event.partial ? undefined : {
                    logs: [{
                        id: `log-${timestamp}`,
                        timestamp,
                        type: 'info',
                        content: "Waiting for user input..."
                    }]
                }
            }

        // Completion
        case "ask_completion_result":
            return completionTransition(context, timestamp)

        // Errors
        case "ask_api_req_failed":
        case "ask_mistake_limit_reached":
        case "ask_invalid_model":
        case "ask_payment_required_prompt":
        case "process_error":
            return {
                nextState: SessionState.error,
                contextUpdate: {
                    logs: [{
                        id: `log-${timestamp}`,
                        timestamp,
                        type: 'mission_failed',
                        content: "An error occurred during execution."
                    }],
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingChoice: undefined,
                    pendingTool: undefined,
                    missionStatus: 'failed',
                    parentTurnStatus: 'failed',
                    lastEventAt: timestamp,
                }
            }

        // Paused
        case "ask_resume_task":
            return { nextState: SessionState.paused }

        // Cancel
        case "cancel_session":
            return {
                nextState: SessionState.stopped,
                contextUpdate: {
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingChoice: undefined,
                    pendingTool: undefined,
                    logs: [{
                        id: `log-${timestamp}`,
                        timestamp,
                        type: 'info',
                        content: "Session stopped by user."
                    }],
                    missionStatus: 'stopped',
                    parentTurnStatus: 'failed',
                    lastEventAt: timestamp,
                }
            }

        // Streaming updates from backend
        case "chat_update": {
            const msg = event.message;
            const newLogs: AgentLogEntry[] = [];
            const activeToolCalls = { ...context.activeToolCalls };
            let workers = { ...context.workers };
            const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
            const hasRunningToolCalls = toolCalls.some((tc: any) => tc.status !== 'completed' && tc.status !== 'error');
            const isFinalNoWorkUpdate = msg.isStreaming === false && !hasRunningToolCalls && !hasActiveWorkers(context.workers);

            // 1. Text Content
            if (msg.content) {
                const visibleContent = stripReasoningBlocks(msg.content);
                if (visibleContent) {
                    newLogs.push({
                        id: `log-${msg.id}-text`,
                        timestamp: msg.timestamp,
                        type: 'assistant_text',
                        content: visibleContent
                    });
                }
            }

            // 2. Tool Calls
            if (toolCalls.length > 0) {
                toolCalls.forEach((tc: any) => {
                    const args = parseToolArgs(tc.arguments);
                    const status = tc.status === 'error' ? 'failed' : tc.status === 'completed' ? 'completed' : 'running';
                    activeToolCalls[tc.id] = {
                        id: tc.id,
                        name: tc.name,
                        args,
                        status,
                        updatedAt: msg.timestamp || timestamp,
                    };

                    if (tc.name === 'command_status') {
                        const workerId = normalizeWorkerId(args.id);
                        if (workerId) {
                            workers = upsertWorkerState(workers, {
                                id: workerId,
                                status: status === 'completed' ? 'running' : status,
                                isActive: true,
                                progress: 'Worker status checked',
                            }, msg.timestamp || timestamp);
                            newLogs.push({
                                id: `worker-status-${workerId}`,
                                timestamp: msg.timestamp,
                                type: 'status_check',
                                content: `Checked worker ${workerId}`,
                                metadata: { workerId, args }
                            });
                        }
                        delete activeToolCalls[tc.id];
                        return;
                    }

	                    if (tc.name === 'subagent') {
                        newLogs.push({
                            id: `subagent-request-${tc.id}`,
                            timestamp: msg.timestamp,
                            type: 'worker_spawned',
                            content: `Requested worker: ${args.description || args.goal || 'Subtask'}`,
                            metadata: { args }
                        });
	                        return;
	                    }

	                    if (isLowSignalInternalTool(tc.name)) {
	                        return;
	                    }

	                    newLogs.push({
	                        id: `log-${tc.id}`, // Stable ID
	                        timestamp: msg.timestamp,
	                        type: 'tool_started',
	                        content: toolDisplayName(tc.name, args),
	                        metadata: {
	                            name: tc.name,
	                            args
                        }
                    });

                    // Create Tool Result Log (if completed)
	                    if (tc.status === 'completed' || tc.status === 'error') {
	                        const resultContent = tc.name === 'write_scratchpad'
	                            ? 'Saved notes'
	                            : tc.result || (tc.status === 'error' ? "Tool failed" : "Tool completed");
                            if (tc.name === 'start_swarm') {
                                workersFromSwarmResult(resultContent, msg.timestamp || timestamp).forEach(worker => {
                                    workers = upsertWorkerState(workers, worker, msg.timestamp || timestamp);
                                    newLogs.push({
                                        id: `worker-${worker.id}-fallback-running`,
                                        timestamp: msg.timestamp || timestamp,
                                        type: 'worker_running',
                                        content: `Worker ${worker.id} running: ${worker.name}`,
                                        metadata: { worker }
                                    });
                                });
                            }
	                        newLogs.push({
	                            id: `log-${tc.id}-result`,
	                            timestamp: msg.timestamp, // In real backend, this would be later
	                            type: tc.status === 'error' ? 'error' : 'tool_finished',
	                            content: resultContent
	                        });
	                    }
                });
            }

            if (isFinalNoWorkUpdate) {
                return {
                    nextState: SessionState.completed,
                    contextUpdate: {
                        logs: newLogs,
                        activeToolCalls: clearActiveRuntimeCalls(),
                        workers,
                        missionStatus: 'completed',
                        parentTurnStatus: 'completed',
                        lastEventAt: msg.timestamp || timestamp,
                    }
                }
            }

            return {
                nextState: SessionState.streaming,
                contextUpdate: {
                    logs: newLogs,
                    activeToolCalls,
                    workers,
                    missionStatus: hasActiveWorkers(workers) ? 'running' : 'running',
                    lastEventAt: msg.timestamp || timestamp,
                }
            }
        }

        case "task_progress": {
            const p = (event as TaskProgressEvent).payload;
            const workers = { ...context.workers };
            const logs: AgentLogEntry[] = [];
            const eventName = p.event || '';
            let missionStatus = context.missionStatus === 'idle' ? 'running' : context.missionStatus;
            let parentTurnStatus = context.parentTurnStatus === 'idle' ? 'running' : context.parentTurnStatus;
            let workerConcurrency = context.workerConcurrency;

            if (p.agent_identifier && String(p.agent_identifier).startsWith('agent-')) {
                const previous = workers[p.agent_identifier];
                const nextWorker: WorkerState = {
                    id: p.agent_identifier,
                    name: p.task_name || previous?.name || "Unknown Worker",
                    status: p.status || previous?.status || "active",
                    isActive: Boolean(p.is_active),
                    progress: p.summary || previous?.progress,
                    color: p.agent_color || previous?.color,
                    lastResult: p.result || previous?.lastResult,
                    startedAt: previous?.startedAt || timestamp,
                    updatedAt: timestamp,
                    completedAt: p.is_active === false ? timestamp : previous?.completedAt,
                };
                workers[p.agent_identifier] = nextWorker;

                logs.push({
                    id: `worker-${p.agent_identifier}-${eventName || nextWorker.status}`,
                    timestamp,
                    type: workerLogType(eventName, nextWorker.status),
                    content: workerLogContent(nextWorker, eventName),
                    metadata: { worker: nextWorker, progress: p }
                });

                missionStatus = hasActiveWorkers(workers) ? 'running' : missionStatus;
	                if (eventName === 'mission_timed_out' || nextWorker.status === 'timeout') {
	                    missionStatus = hasActiveWorkers(workers) ? 'running' : 'completed';
	                    parentTurnStatus = context.parentTurnStatus === 'completed' ? 'completed' : parentTurnStatus;
	                } else if (eventName === 'worker_aborted' || nextWorker.status === 'aborted') {
	                    missionStatus = hasActiveWorkers(workers) ? 'stopped' : 'stopped';
	                    parentTurnStatus = 'failed';
	                } else if (eventName === 'worker_failed' || nextWorker.status === 'failed') {
	                    missionStatus = 'failed';
	                    parentTurnStatus = 'failed';
	                }
	            } else if (p.status) {
	                const status = String(p.status).toLowerCase();
                    const result = String(p.result || '').toLowerCase();
	                if (status.includes('waiting for approval')) {
	                    missionStatus = 'waiting';
	                    parentTurnStatus = 'waiting';
	                    logs.push({
	                        id: `approval-waiting-${timestamp}`,
	                        timestamp,
	                        type: 'permission_requested',
	                        content: 'Waiting for approval.',
	                        metadata: p
	                    });
	                } else if (status.includes('loop warning')) {
	                    logs.push({
	                        id: 'loop-warning',
	                        timestamp,
	                        type: 'info',
	                        content: 'Loop warning: repeated narration detected; agent is changing strategy.',
	                        metadata: p
	                    });
	                } else if (result === 'budget_exceeded' || result === 'stopped' || status.includes('stopped')) {
	                    missionStatus = 'stopped';
	                    parentTurnStatus = 'failed';
	                    logs.push({
	                        id: `mission-stopped-${timestamp}`,
	                        timestamp,
	                        type: 'info',
	                        content: p.status || 'Run stopped.',
	                        metadata: p
	                    });
	                } else if (result === 'error' || status.includes('no hub tasks were created') || status.includes('failed') || status.includes('error')) {
	                    missionStatus = 'failed';
	                    parentTurnStatus = 'failed';
	                    logs.push({
	                        id: `mission-failed-${timestamp}`,
	                        timestamp,
	                        type: 'mission_failed',
	                        content: p.status || 'Mission needs attention.',
	                        metadata: p
	                    });
	                } else if (status.includes('mission accomplished') || status.includes('completed')) {
	                    missionStatus = hasActiveWorkers(workers) ? 'running' : 'completed';
                    parentTurnStatus = 'completed';
                    logs.push({
                        id: `mission-progress-${timestamp}`,
                        timestamp,
                        type: missionStatus === 'completed' ? 'mission_completed' : 'info',
                        content: missionStatus === 'completed' ? 'Mission completed.' : 'Parent turn completed; workers still active.',
                        metadata: p
                    });
                }
            }

            if (p.worker_running) {
                workerConcurrency = p.worker_running;
            }

            if (parentTurnStatus === 'completed' && !hasActiveWorkers(workers) && Object.keys(workers).length > 0 && missionStatus !== 'failed') {
                missionStatus = 'completed';
                logs.push({
                    id: 'mission-completed-after-workers',
                    timestamp,
                    type: 'mission_completed',
                    content: 'Mission completed after all workers finished.',
                    metadata: p
                });
            }

            const nextState = missionStatus === 'completed'
                ? SessionState.completed
                : missionStatus === 'stopped'
                    ? SessionState.stopped
                    : missionStatus === 'failed'
                        ? SessionState.error
                        : currentState === SessionState.creating
                            ? SessionState.streaming
                            : currentState;

            return {
                nextState,
                contextUpdate: {
                    workers,
                    logs,
                    missionStatus,
                    parentTurnStatus,
                    workerConcurrency,
                    lastEventAt: timestamp,
                }
            };
        }

        case "ask_user_choice":
            return {
                nextState: SessionState.waiting_input,
                contextUpdate: {
                    pendingChoice: event.payload,
                    logs: [{
                        id: `choice-${event.payload.id}`,
                        timestamp: Date.now(),
                        type: 'permission_requested',
                        content: event.payload.question,
                        metadata: event.payload
                    }],
                    missionStatus: 'waiting',
                    parentTurnStatus: 'waiting',
                    lastEventAt: timestamp,
                }
            }

        default:
            return { nextState: SessionState.streaming }
    }
}

function transitionFromWaitingApproval(event: SessionEvent, context?: SessionContext): TransitionResult {
    switch (event.type) {
        case "ask_completion_result":
            return completionTransition(context || createInitialContext())

        case "approve_action":
        case "reject_action":
        case "api_req_started": // Auto-approved
            return {
                nextState: SessionState.streaming,
                contextUpdate: { pendingTool: undefined, pendingChoice: undefined, missionStatus: 'running', parentTurnStatus: 'running', lastEventAt: Date.now() }
            }

        case "cancel_session":
            return {
                nextState: SessionState.stopped,
                contextUpdate: {
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingTool: undefined,
                    pendingChoice: undefined,
                    missionStatus: 'stopped',
                    parentTurnStatus: 'failed',
                    lastEventAt: Date.now(),
                },
            }

        case "chat_update":
        case "task_progress":
        case "say_text":
            return transitionFromStreaming(event, context || createInitialContext(), SessionState.waiting_approval)

        default:
            return { nextState: SessionState.waiting_approval }
    }
}

function transitionFromWaitingInput(event: SessionEvent, context?: SessionContext): TransitionResult {
    switch (event.type) {
        case "ask_completion_result":
            return completionTransition(context || createInitialContext())

        case "api_req_started":
        case "send_message":
        case "submit_input":
            return {
                nextState: SessionState.streaming,
                contextUpdate: { pendingChoice: undefined, pendingTool: undefined, missionStatus: 'running', parentTurnStatus: 'running', lastEventAt: Date.now() }
            }

        case "cancel_session":
            return {
                nextState: SessionState.stopped,
                contextUpdate: {
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingTool: undefined,
                    pendingChoice: undefined,
                    missionStatus: 'stopped',
                    parentTurnStatus: 'failed',
                    lastEventAt: Date.now(),
                },
            }

        case "chat_update":
        case "task_progress":
        case "say_text":
            return transitionFromStreaming(event, context || createInitialContext(), SessionState.waiting_input)

        default:
            return { nextState: SessionState.waiting_input }
    }
}

function transitionFromCompleted(event: SessionEvent, context?: SessionContext): TransitionResult {
    switch (event.type) {
        case "api_req_started":
            return { nextState: SessionState.streaming }

        case "ask_completion_result":
            return completionTransition(context || createInitialContext())

        case "chat_update": {
            const ctx = context || createInitialContext();
            const msg = event.message;
            const toolCalls = Array.isArray(msg?.toolCalls) ? msg.toolCalls : [];
            const hasRunningToolCalls = toolCalls.some((tc: any) => tc.status !== 'completed' && tc.status !== 'error');
            if (msg?.isStreaming === false && !hasRunningToolCalls && !hasBlockingActiveWorkers(ctx)) {
                return {
                    nextState: SessionState.completed,
                    contextUpdate: completionContextUpdate(ctx, msg.timestamp || Date.now())
                }
            }
            return transitionFromStreaming(event, ctx, SessionState.completed)
        }

        case "task_progress": {
            const ctx = context || createInitialContext();
            if (!hasBlockingActiveWorkers(ctx)) {
                return {
                    nextState: SessionState.completed,
                    contextUpdate: completionContextUpdate(ctx, Date.now())
                }
            }
            return transitionFromStreaming(event, ctx, SessionState.completed)
        }

        case "say_text":
            return { nextState: SessionState.completed }

        case "send_message": // Continue with follow-up
            return { nextState: SessionState.streaming }

        case "start_session": // New task
            return { nextState: SessionState.creating }

        default:
            return { nextState: SessionState.completed }
    }
}

function transitionFromPaused(event: SessionEvent, context?: SessionContext): TransitionResult {
    switch (event.type) {
        case "api_req_started":
            return { nextState: SessionState.streaming }

        case "ask_completion_result":
            return completionTransition(context || createInitialContext())

        case "chat_update":
        case "task_progress":
        case "say_text":
            return transitionFromStreaming(event, context || createInitialContext(), SessionState.paused)

        case "cancel_session":
            return {
                nextState: SessionState.stopped,
                contextUpdate: {
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingTool: undefined,
                    pendingChoice: undefined,
                    missionStatus: 'stopped',
                    parentTurnStatus: 'failed',
                    lastEventAt: Date.now(),
                },
            }

        default:
            return { nextState: SessionState.paused }
    }
}

function transitionFromError(event: SessionEvent, context?: SessionContext): TransitionResult {
    switch (event.type) {
        case "api_req_started":
            return { nextState: SessionState.streaming }

        case "chat_update":
        case "task_progress":
        case "say_text":
            return transitionFromStreaming(event, context || createInitialContext(), SessionState.error)

        case "retry":
            return { nextState: SessionState.streaming }

        case "cancel_session":
            return {
                nextState: SessionState.stopped,
                contextUpdate: {
                    activeToolCalls: clearActiveRuntimeCalls(),
                    pendingTool: undefined,
                    pendingChoice: undefined,
                    missionStatus: 'stopped',
                    parentTurnStatus: 'failed',
                    lastEventAt: Date.now(),
                },
            }

        default:
            return { nextState: SessionState.error }
    }
}

function transitionFromStopped(event: SessionEvent, context?: SessionContext): TransitionResult {
    switch (event.type) {
        case "api_req_started":
            return { nextState: SessionState.streaming }

        case "chat_update":
        case "task_progress":
        case "say_text":
            return transitionFromStreaming(event, context || createInitialContext(), SessionState.stopped)

        case "start_session": // New task
            return { nextState: SessionState.creating }

        default:
            return { nextState: SessionState.stopped }
    }
}
