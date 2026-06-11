export interface ChatUpdatePayload {
    session_id?: string;
    run_id?: string;
    message?: ChatMessagePayload;
    usage?: UsageSnapshot;
    done?: boolean;
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

export interface ChatMessagePayload {
    id?: string;
    role?: string;
    content?: string;
    errorInfo?: ChatErrorInfo;
    reasoning?: string;
    timestamp?: number;
    isStreaming?: boolean;
    toolCalls?: ToolCallPayload[];
    activities?: ActivityItemPayload[];
    artifacts?: unknown[];
    steps?: ProgressStepPayload[];
    metadata?: unknown;
    run_id?: string;
    turn_id?: string;
    sequence?: number;
    segment_id?: string;
    checkpointHash?: string;
    via?: string;
    sessionId?: string;
    username?: string;
}

export interface ToolCallPayload {
    id?: string;
    name?: string;
    arguments?: unknown;
    result?: string;
    status?: string;
    timestamp?: number;
    exitCode?: number;
    durationMs?: number;
    cwd?: string;
    shell?: string;
    script?: string;
    startedAt?: number;
    completedAt?: number;
}

export interface ActivityCountsPayload {
    files?: number;
    folders?: number;
    results?: number;
}

export interface ActivityEntryPayload {
    name?: string;
    type?: 'file' | 'dir' | 'result' | string;
    path?: string;
}

export interface ActivityItemPayload {
    type?: string;
    file?: string;
    lineRange?: string;
    results?: number;
    additions?: number;
    deletions?: number;
    query?: string;
    message?: string;
    command?: string;
    resultPreview?: string;
    entries?: ActivityEntryPayload[];
    counts?: ActivityCountsPayload;
    status?: string;
    error?: string;
    timestamp?: number;
    exitCode?: number;
    durationMs?: number;
    cwd?: string;
    shell?: string;
    startedAt?: number;
    completedAt?: number;
}

export interface ProgressStepPayload {
    id?: string;
    label?: string;
    status?: string;
    details?: string[];
}

export type UsageSource = 'actual' | 'estimated' | 'unconfirmed';

export interface UsageModelTotal {
    provider: string;
    model: string;
    keySource?: string;
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
    keySource?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
    reasoningOutputTokens?: number;
    contextTokens?: number;
    contextWindow?: number;
    estimatedCostUsd: number;
    source: UsageSource;
    operation: string;
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
    priority?: string;
    changed?: boolean;
}

export interface TodoViewPayload {
    mode: 'full' | 'compact' | string;
    todos: TodoPayload[];
    hidden_before?: number;
    hidden_after?: number;
    changed?: number;
}

export interface AskUserPayload {
    question: string;
    session_id?: string;
}

export interface AskUserChoicePayload extends AskUserPayload {
    choices: string[];
    choiceMetadata?: Array<{
        value: string;
        label?: string;
        description?: string;
        recommended?: boolean;
        danger?: boolean;
    }>;
}

export interface ProposedEditPayload {
    proposal_id?: string;
    session_id?: string;
    tool?: string;
    path?: string;
    original_content?: string;
    new_content?: string;
}

export interface TaskProgressPayload {
    session_id?: string;
    run_id?: string;
    turn_id?: string;
    sequence?: number;
    segment_id?: string;
    parent_segment_id?: string;
    event?: string;
    agent_identifier?: string;
    task_name?: string;
    status?: string;
    summary?: string;
    mode?: string;
    steps?: string[];
    files?: string[];
    todos?: TodoPayload[];
    todo_view?: TodoViewPayload;
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
    preserved_items?: string[];
    active_commands?: string[];
    error?: string;
    timestamp?: number;
}

export interface ContextContributorPayload {
    id: string;
    type: string;
    source?: string;
    tokens: number;
    percent?: number;
}

export interface ContextBuildReportPayload {
    session_id?: string;
    run_id?: string;
    tokens_used: number;
    tokens_max: number;
    percentage: number;
    fragments?: ContextContributorPayload[];
    top_contributors?: ContextContributorPayload[];
    warnings?: string[];
    suggestions?: string[];
    generated_at?: number;
}

export interface WorkspaceFileRecordPayload {
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

export interface WorkspaceIndexStatusPayload {
    workspace_root?: string;
    status: string;
    enabled: boolean;
    files_total?: number;
    files_indexed?: number;
    definitions?: number;
    bytes_indexed?: number;
    last_indexed_at?: number;
    duration_ms?: number;
    error?: string;
    sample_files?: WorkspaceFileRecordPayload[];
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
    message_id?: string;
    queue_length?: number;
    status?: string;
}

export interface CommandEventPayload {
    session_id?: string;
    run_id?: string;
    turn_id?: string;
    tool_use_id?: string;
    command_id?: string;
    event?: 'command_started' | 'command_output' | 'command_succeeded' | 'command_failed' | string;
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

export type NetworkHealthState = 'unknown' | 'online' | 'degraded' | 'reconnecting' | 'offline';
export type NetworkHealthScope = 'webview' | 'core' | 'provider' | 'internet' | 'agent';

export interface NetworkScopeStatusPayload {
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
    details?: Partial<Record<NetworkHealthScope, NetworkScopeStatusPayload>>;
}

export interface ProviderNetworkEventPayload {
    type?: string;
    provider?: string;
    model?: string;
    session_id?: string;
    run_id?: string;
    method?: string;
    url?: string;
    status_code?: number;
    attempt?: number;
    max_attempts?: number;
    delay_ms?: number;
    latency_ms?: number;
    error?: string;
    category?: string;
    timestamp?: number;
}

export interface CoreNotificationPayloads {
    ready: Record<string, never>;
    chat_update: ChatUpdatePayload;
    task_progress: TaskProgressPayload;
    command_event: CommandEventPayload;
    tool_lifecycle: ToolLifecycleEventPayload;
    context_compaction: ContextCompactionEventPayload;
    checkpoint_event: CheckpointEventPayload;
    batch_event: BatchEventPayload;
    message_queued: QueuedMessagePayload;
    usage_update: UsageSnapshot;
    context_status: unknown;
    live_mode_status: unknown;
    ether_activity: unknown;
    show_message: { level?: string; text?: string };
    mode_changed: unknown;
    tasks_updated: unknown;
    plan_updated: unknown;
    provider_request_started: ProviderNetworkEventPayload;
    provider_request_retrying: ProviderNetworkEventPayload;
    provider_request_succeeded: ProviderNetworkEventPayload;
    provider_request_failed: ProviderNetworkEventPayload;
}

export interface CoreRequestPayloads {
    ask_user: AskUserPayload;
    ask_user_choice: AskUserChoicePayload;
    propose_edit: ProposedEditPayload;
    get_diagnostics: unknown;
    get_definitions: unknown;
    get_references: unknown;
    get_symbols: unknown;
    get_implementations: unknown;
}
