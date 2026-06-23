export const DEFAULT_PERMISSION_CHOICES = ['Yes', 'Always Allow', 'No'] as const;

export type ExtensionMessage<TPayload = unknown> = {
    type: string;
    payload?: TPayload;
    id?: string;
};

export type InteractionRequestKind = 'permission' | 'choice';

export interface InteractionRequestPayload {
    id: string;
    sessionId?: string;
    runId?: string;
    run_id?: string;
    toolName?: string;
    tool_name?: string;
    question: string;
    choices: string[];
    choiceMetadata?: ChoiceMetadata[];
    kind: InteractionRequestKind;
}

export interface ChoiceMetadata {
    value: string;
    label?: string;
    description?: string;
    recommended?: boolean;
    danger?: boolean;
}

export interface ChatUpdatePayload {
    session_id?: string;
    run_id?: string;
    message?: any;
    usage?: UsageSnapshot;
    done?: boolean;
}

export interface ContextFilePayload {
    path: string;
    name?: string;
    kind?: 'file' | 'folder' | string;
    size?: number;
    source?: 'workspace' | 'attachment' | string;
    mime?: string;
    stagedPath?: string;
    previewUrl?: string;
    status?: 'staging' | 'ready' | 'error';
    error?: string;
    id?: string;
    requestId?: string;
}

export type ChatErrorKind = 'network' | 'provider_config' | 'rate_limit' | 'provider_server' | 'session' | 'unknown';

export interface ChatErrorInfo {
    kind: ChatErrorKind;
    title: string;
    message: string;
    provider?: string;
    retryable: boolean;
    rawMessage?: string;
    diagnosticCode?: string;
    timestamp: number;
}

export interface ContextStatus {
    session_id?: string;
    run_id?: string;
    tokens_used: number;
    tokens_max: number;
    percentage: number;
    was_condensed?: boolean;
    was_truncated?: boolean;
    cumulative_cost?: number;
    report?: ContextBuildReport;
    warnings?: string[];
    suggestions?: string[];
    effective_policy?: ContextEffectivePolicy;
    condense_threshold?: number;
    fallback_window?: number;
    compression_saved_tokens?: number;
    can_manual_compact?: boolean;
    last_compaction?: ContextCompactionEventPayload;
    checkpoint_status?: CheckpointStatus;
}

export interface ContextEffectivePolicy {
    auto_condense: boolean;
    condense_threshold: number;
    sliding_window_size: number;
    show_context_indicator: boolean;
    show_contributor_panel: boolean;
}

export interface CheckpointStatus {
    enabled: boolean;
    checkpoint_on_writes: boolean;
    initialized: boolean;
    base_hash?: string;
    last_checkpoint_hash?: string;
    last_checkpoint_at?: number;
    checkpoint_count?: number;
    error?: string;
    warning?: string;
    slow?: boolean;
}

export interface ContextContributor {
    id: string;
    type: string;
    source?: string;
    tokens: number;
    percent?: number;
}

export interface ContextCompressionFragment {
    id: string;
    type: 'tool_output' | 'command_log' | 'file_snippet' | 'rag_chunk' | 'history' | string;
    source?: string;
    hash: string;
    original_tokens: number;
    compressed_tokens: number;
    saved_tokens: number;
    store_key?: string;
}

export interface ContextCompressionReport {
    enabled: boolean;
    original_tokens?: number;
    compressed_tokens?: number;
    saved_tokens?: number;
    fragments?: ContextCompressionFragment[];
    generated_at?: number;
}

export interface ContextBuildReport {
    session_id?: string;
    run_id?: string;
    tokens_used: number;
    tokens_max: number;
    percentage: number;
    fragments?: ContextContributor[];
    top_contributors?: ContextContributor[];
    warnings?: string[];
    suggestions?: string[];
    compression?: ContextCompressionReport;
    generated_at?: number;
}

export interface WorkspaceFileRecord {
    path: string;
    language?: string;
    size?: number;
    hash?: string;
    modified_at?: number;
    indexed_at?: number;
    definitions?: number;
    imports?: string[];
    stale?: boolean;
    ignored?: boolean;
    error?: string;
}

export interface WorkspaceIndexStatus {
    workspace_root?: string;
    status: 'disabled' | 'indexing' | 'clean' | 'stale' | 'error' | string;
    enabled: boolean;
    files_total?: number;
    files_indexed?: number;
    definitions?: number;
    bytes_indexed?: number;
    last_indexed_at?: number;
    duration_ms?: number;
    error?: string;
    sample_files?: WorkspaceFileRecord[];
}

export type UsageSource = 'actual' | 'estimated' | 'unconfirmed';

export interface UsageModelTotal {
    provider: string;
    model: string;
    keySource?: 'server' | 'user' | 'none' | string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
    reasoningOutputTokens?: number;
    estimatedCostUsd: number;
    requestCount: number;
    actualCount: number;
    estimatedCount: number;
    source: UsageSource;
}

export interface UsageEvent {
    sessionId: string;
    runId?: string;
    turnId?: string;
    provider: string;
    model: string;
    keySource?: 'server' | 'user' | 'none' | string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
    reasoningOutputTokens?: number;
    contextTokens?: number;
    contextWindow?: number;
    estimatedCostUsd: number;
    source: UsageSource;
    operation: 'chat' | 'worker' | 'condense' | 'embedding' | string;
    timestamp?: number;
}

export interface UsageSnapshot {
    sessionId?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
    reasoningOutputTokens?: number;
    contextTokens?: number;
    contextWindow?: number;
    estimatedCostUsd: number;
    requestCount: number;
    actualCount: number;
    estimatedCount: number;
    source: UsageSource;
    models?: UsageModelTotal[];
    events?: UsageEvent[];
    lastEvent?: UsageEvent;
}

export type TodoStatusPayload = 'pending' | 'current' | 'completed' | 'cancelled';

export interface TodoPayload {
    text: string;
    status: TodoStatusPayload;
    priority?: 'high' | 'medium' | 'low' | string;
    changed?: boolean;
}

export interface TodoViewPayload {
    mode: 'full' | 'compact' | string;
    todos: TodoPayload[];
    hidden_before?: number;
    hidden_after?: number;
    changed?: number;
}

export interface TaskProgressPayload {
    session_id?: string;
    run_id?: string;
    turn_id?: string;
    sequence?: number;
    segment_id?: string;
    parent_segment_id?: string;
    event?: 'mission_progress' | 'worker_spawned' | 'worker_running' | 'worker_completed' | 'worker_failed' | 'mission_timed_out' | string;
    agent_identifier?: string;
    task_name?: string;
    status?: string;
    summary?: string;
    mode?: 'planning' | 'execution' | 'verification' | string;
    steps?: string[];
    files?: string[];
    todos?: TodoPayload[];
    todo_view?: TodoViewPayload;
    checklist_source?: 'todo' | 'provisional' | 'step' | 'none' | string;
    is_active?: boolean;
    completed_at?: number;
    agent_color?: string;
    result?: string;
    worker_queued?: number;
    worker_running?: number;
    tool_count?: number;
    token_count?: number;
}

export interface ToolLifecycleEventPayload {
    session_id?: string;
    run_id?: string;
    turn_id?: string;
    tool_use_id?: string;
    tool_name: string;
    source?: string;
    status: 'running' | 'completed' | 'failed' | 'aborted' | string;
    event: 'tool_started' | 'tool_finished' | 'tool_failed' | 'tool_aborted' | string;
    started_at?: number;
    completed_at?: number;
    duration_ms?: number;
    args_summary?: string;
    affected_files?: string[];
    lineRange?: string;
    line_range?: string;
    readLineStart?: number | string;
    readLineEnd?: number | string;
    read_line_start?: number | string;
    read_line_end?: number | string;
    startLine?: number | string;
    endLine?: number | string;
    start_line?: number | string;
    end_line?: number | string;
    error?: string;
    output_preview?: string;
    timestamp?: number;
}

export interface ContextCompactionEventPayload {
    session_id?: string;
    run_id?: string;
    event: 'context_condensed' | 'context_truncated' | 'context_compaction_failed' | string;
    tokens_before?: number;
    tokens_after?: number;
    tokens_max?: number;
    percentage?: number;
    summary?: string;
    error?: string;
    timestamp?: number;
}

export interface CheckpointEventPayload {
    session_id?: string;
    run_id?: string;
    event: 'checkpoint_initialized' | 'checkpoint_saved' | 'checkpoint_restored' | 'checkpoint_failed' | string;
    hash?: string;
    base_hash?: string;
    message?: string;
    tool_name?: string;
    duration_ms?: number;
    error?: string;
    timestamp?: number;
}

export interface CheckpointFileChangePayload {
    path: string;
    old_path?: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed' | string;
    additions?: number;
    deletions?: number;
    binary?: boolean;
    large?: boolean;
    ignored?: boolean;
    preview?: string;
    error?: string;
}

export interface CheckpointRestorePreviewPayload {
    checkpoint_hash: string;
    current_hash?: string;
    safety_required: boolean;
    summary: string;
    files: CheckpointFileChangePayload[];
    warnings?: string[];
    restore_modes: string[];
    diff_stat?: string;
    generated_at: number;
}

export interface CheckpointRestoreResultPayload {
    restored_hash?: string;
    safety_checkpoint_hash?: string;
    files_restored?: string[];
    skipped_files?: string[];
    patch_path?: string;
    export_path?: string;
    mode: string;
    duration_ms?: number;
}

export interface BatchArtifactPayload {
    type: string;
    path: string;
    size?: number;
}

export interface BatchTestResultPayload {
    command?: string;
    status?: string;
    log_path?: string;
    exit_code?: number;
}

export interface BatchWorkerPayload {
    id: string;
    run_id: string;
    title: string;
    status: string;
    worktree_id?: string;
    branch?: string;
    path?: string;
    agent_session_id?: string;
    scope_paths?: string[];
    attempt?: number;
    summary?: string;
    artifact_dir?: string;
    verification_commands?: string[];
    verification_status?: string;
    output_preview?: string;
    permissions?: string[];
    diff_stat?: string;
    tests?: BatchTestResultPayload[];
    artifacts?: BatchArtifactPayload[];
    error?: string;
    started_at?: number;
    completed_at?: number;
}

export interface BatchMergePlanPayload {
    status?: string;
    apply_order?: string[];
    conflicts?: string[];
    warnings?: string[];
    selected?: string[];
}

export interface BatchRunPayload {
    id: string;
    session_id?: string;
    goal: string;
    status: string;
    max_workers: number;
    base_branch?: string;
    base_commit?: string;
    base_checkpoint_hash?: string;
    workers?: BatchWorkerPayload[];
    merge_plan?: BatchMergePlanPayload;
    created_at?: number;
    updated_at?: number;
}

export interface BatchEventPayload {
    event: string;
    run_id: string;
    worker_id?: string;
    status?: string;
    run?: BatchRunPayload;
    worker?: BatchWorkerPayload;
    message?: string;
    timestamp: number;
}

export interface QueuedMessagePayload {
    session_id?: string;
    sessionId?: string;
    run_id?: string;
    runId?: string;
    message_id?: string;
    queue_length?: number;
    status?: string;
    text?: string;
    error?: string;
    message?: {
        id?: string;
        session_id?: string;
        run_id?: string;
        text?: string;
        via?: string;
        delivery?: string;
        timestamp?: number;
        updated_at?: number;
    };
}

export type NetworkHealthState = 'unknown' | 'online' | 'degraded' | 'reconnecting' | 'offline';
export type NetworkHealthScope = 'webview' | 'core' | 'provider' | 'internet' | 'agent';

export interface NetworkScopeStatus {
    state: NetworkHealthState;
    pingMs?: number;
    lastCheckedAt?: number;
    lastSuccessAt?: number;
    lastActivityAt?: number;
    message?: string;
    errorCode?: string;
    rawMessage?: string;
    diagnosticCode?: string;
}

export interface NetworkStatusPayload {
    state: NetworkHealthState;
    scope: NetworkHealthScope;
    provider?: string;
    model?: string;
    pingMs?: number;
    lastCheckedAt: number;
    lastSuccessAt?: number;
    lastActivityAt?: number;
    attempt?: number;
    maxAttempts?: number;
    message?: string;
    errorCode?: string;
    details?: Partial<Record<NetworkHealthScope, NetworkScopeStatus>>;
}

export function normalizeInteractionRequest(message: ExtensionMessage): InteractionRequestPayload | null {
    if (message.type !== 'request_permission' && message.type !== 'ask_user_choice') {
        return null;
    }

    const payload = (message.payload || {}) as Partial<InteractionRequestPayload> & {
        id?: string;
        choices?: string[];
        choiceMetadata?: ChoiceMetadata[];
        question?: string;
        sessionId?: string;
        runId?: string;
        run_id?: string;
        toolName?: string;
        tool_name?: string;
        kind?: InteractionRequestKind;
    };
    const id = payload.id || message.id;
    if (!id || !payload.question) {
        return null;
    }

    const isPermission = message.type === 'request_permission';
    return {
        id,
        sessionId: payload.sessionId,
        runId: payload.runId || payload.run_id,
        run_id: payload.run_id || payload.runId,
        toolName: payload.toolName || payload.tool_name,
        tool_name: payload.tool_name || payload.toolName,
        question: payload.question,
        choices: payload.choices?.length ? payload.choices : [...DEFAULT_PERMISSION_CHOICES],
        choiceMetadata: payload.choiceMetadata,
        kind: payload.kind || (isPermission ? 'permission' : 'choice'),
    };
}

export function normalizeChatUpdate(message: ExtensionMessage): ChatUpdatePayload | null {
    if (message.type !== 'chat_update') {
        return null;
    }
    const payload = message.payload as ChatUpdatePayload | undefined;
    if (!payload?.message && !payload?.usage) {
        return null;
    }
    return payload;
}

export function normalizeTaskProgress(message: ExtensionMessage): TaskProgressPayload | null {
    if (message.type !== 'task_progress') {
        return null;
    }
    return (message.payload || null) as TaskProgressPayload | null;
}
