package protocol

import (
	"context"
	"encoding/json"
)

type contextKey string

const SessionIDKey contextKey = "session_id"
const RunIDKey contextKey = "run_id"
const ToolUseIDKey contextKey = "tool_use_id"

// WithSessionID adds a session ID to the context
func WithSessionID(ctx context.Context, sessionID string) context.Context {
	return context.WithValue(ctx, SessionIDKey, sessionID)
}

// GetSessionID retrieves the session ID from the context
func GetSessionID(ctx context.Context) string {
	if sid, ok := ctx.Value(SessionIDKey).(string); ok {
		return sid
	}
	return "default"
}

// WithRunID adds a runtime ID to the context.
func WithRunID(ctx context.Context, runID string) context.Context {
	return context.WithValue(ctx, RunIDKey, runID)
}

// GetRunID retrieves the current runtime ID from the context.
func GetRunID(ctx context.Context) string {
	if rid, ok := ctx.Value(RunIDKey).(string); ok {
		return rid
	}
	return ""
}

// WithToolUseID adds the current tool call ID to the context.
func WithToolUseID(ctx context.Context, toolUseID string) context.Context {
	return context.WithValue(ctx, ToolUseIDKey, toolUseID)
}

// GetToolUseID retrieves the current tool call ID from the context.
func GetToolUseID(ctx context.Context) string {
	if id, ok := ctx.Value(ToolUseIDKey).(string); ok {
		return id
	}
	return ""
}

// Message represents a chat message
type Message struct {
	ID               string            `json:"id,omitempty"`
	Role             string            `json:"role"` // user, assistant, system
	Content          string            `json:"content"`
	ReasoningContent string            `json:"reasoning_content,omitempty"` // DeepSeek R1 reasoning
	ToolUse          []ToolUseBlock    `json:"tool_use,omitempty"`
	ToolResults      []ToolResultBlock `json:"tool_results,omitempty"`
	Via              string            `json:"via,omitempty"` // Message source
}

// ToolUseBlock represents a tool call by the assistant
type ToolUseBlock struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// ToolResultBlock represents the result of a tool execution
type ToolResultBlock struct {
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error,omitempty"`
}

type ContextFileAttachment struct {
	Path       string `json:"path"`
	Name       string `json:"name,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Size       int64  `json:"size,omitempty"`
	Source     string `json:"source,omitempty"`
	Mime       string `json:"mime,omitempty"`
	StagedPath string `json:"stagedPath,omitempty"`
}

type QueuedMessage struct {
	ID           string                  `json:"id"`
	SessionID    string                  `json:"session_id,omitempty"`
	RunID        string                  `json:"run_id,omitempty"`
	Text         string                  `json:"text"`
	Via          string                  `json:"via,omitempty"`
	Images       []string                `json:"images,omitempty"`
	ContextFiles []ContextFileAttachment `json:"context_files,omitempty"`
	Delivery     string                  `json:"delivery,omitempty"` // queue, steer
	Timestamp    int64                   `json:"timestamp"`
	UpdatedAt    int64                   `json:"updated_at,omitempty"`
}

// Tool represents a tool definition
type Tool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
}

// TodoStatus represents the status of a task
type TodoStatus string

const (
	TodoPending   TodoStatus = "pending"
	TodoCurrent   TodoStatus = "current"
	TodoCompleted TodoStatus = "completed"
	TodoCancelled TodoStatus = "cancelled"
)

// Todo represents a single unit of work in a task
type Todo struct {
	Text     string     `json:"text"`
	Status   TodoStatus `json:"status"`
	Priority string     `json:"priority,omitempty"` // high, medium, low
	Changed  bool       `json:"changed,omitempty"`  // UI hint used by compact todo diffs
}

// TodoView is a compact diff-friendly projection of a todo list.
type TodoView struct {
	Mode         string `json:"mode"` // full, compact
	Todos        []Todo `json:"todos"`
	HiddenBefore int    `json:"hidden_before,omitempty"`
	HiddenAfter  int    `json:"hidden_after,omitempty"`
	Changed      int    `json:"changed,omitempty"`
}

// ContextStatus represents context window usage for UI display
type ContextStatus struct {
	SessionID      string              `json:"session_id,omitempty"`
	RunID          string              `json:"run_id,omitempty"`
	TokensUsed     int                 `json:"tokens_used"`
	TokensMax      int                 `json:"tokens_max"`
	Percentage     float64             `json:"percentage"`
	WasCondensed   bool                `json:"was_condensed,omitempty"`
	WasTruncated   bool                `json:"was_truncated,omitempty"`
	Summary        string              `json:"summary,omitempty"`
	CumulativeCost float64             `json:"cumulative_cost,omitempty"`
	Report         *ContextBuildReport `json:"report,omitempty"`
	Warnings       []string            `json:"warnings,omitempty"`
	Suggestions    []string            `json:"suggestions,omitempty"`

	EffectivePolicy        *ContextEffectivePolicy `json:"effective_policy,omitempty"`
	CondenseThreshold      int                     `json:"condense_threshold,omitempty"`
	FallbackWindow         int                     `json:"fallback_window,omitempty"`
	CompressionSavedTokens int                     `json:"compression_saved_tokens,omitempty"`
	CanManualCompact       bool                    `json:"can_manual_compact,omitempty"`
	LastCompaction         *ContextCompactionEvent `json:"last_compaction,omitempty"`
	Checkpoint             *CheckpointStatus       `json:"checkpoint_status,omitempty"`
}

type ContextEffectivePolicy struct {
	AutoCondense         bool `json:"auto_condense"`
	CondenseThreshold    int  `json:"condense_threshold"`
	SlidingWindowSize    int  `json:"sliding_window_size"`
	ShowContextIndicator bool `json:"show_context_indicator"`
	ShowContributorPanel bool `json:"show_contributor_panel"`
}

type CheckpointStatus struct {
	Enabled            bool   `json:"enabled"`
	CheckpointOnWrites bool   `json:"checkpoint_on_writes"`
	Initialized        bool   `json:"initialized"`
	BaseHash           string `json:"base_hash,omitempty"`
	LastCheckpointHash string `json:"last_checkpoint_hash,omitempty"`
	LastCheckpointAt   int64  `json:"last_checkpoint_at,omitempty"`
	CheckpointCount    int    `json:"checkpoint_count,omitempty"`
	Error              string `json:"error,omitempty"`
	Warning            string `json:"warning,omitempty"`
	Slow               bool   `json:"slow,omitempty"`
}

type ContextFragment struct {
	ID        string `json:"id"`
	Type      string `json:"type"` // system, message, tool_result, memory, skill, file, workspace_map
	Source    string `json:"source,omitempty"`
	Priority  int    `json:"priority,omitempty"`
	Tokens    int    `json:"tokens"`
	MaxTokens int    `json:"max_tokens,omitempty"`
	Hash      string `json:"hash,omitempty"`
	Content   string `json:"content,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

type ContextContributor struct {
	ID      string  `json:"id"`
	Type    string  `json:"type"`
	Source  string  `json:"source,omitempty"`
	Tokens  int     `json:"tokens"`
	Percent float64 `json:"percent,omitempty"`
}

type ContextCompressionFragment struct {
	ID               string `json:"id"`
	Type             string `json:"type"` // tool_output, command_log, file_snippet, rag_chunk, history
	Source           string `json:"source,omitempty"`
	Hash             string `json:"hash"`
	OriginalTokens   int    `json:"original_tokens"`
	CompressedTokens int    `json:"compressed_tokens"`
	SavedTokens      int    `json:"saved_tokens"`
	StoreKey         string `json:"store_key,omitempty"`
}

type ContextCompressionReport struct {
	Enabled          bool                         `json:"enabled"`
	OriginalTokens   int                          `json:"original_tokens,omitempty"`
	CompressedTokens int                          `json:"compressed_tokens,omitempty"`
	SavedTokens      int                          `json:"saved_tokens,omitempty"`
	Fragments        []ContextCompressionFragment `json:"fragments,omitempty"`
	GeneratedAt      int64                        `json:"generated_at,omitempty"`
}

type ContextBuildReport struct {
	SessionID       string                    `json:"session_id,omitempty"`
	RunID           string                    `json:"run_id,omitempty"`
	TokensUsed      int                       `json:"tokens_used"`
	TokensMax       int                       `json:"tokens_max"`
	Percentage      float64                   `json:"percentage"`
	Fragments       []ContextContributor      `json:"fragments,omitempty"`
	TopContributors []ContextContributor      `json:"top_contributors,omitempty"`
	Warnings        []string                  `json:"warnings,omitempty"`
	Suggestions     []string                  `json:"suggestions,omitempty"`
	Compression     *ContextCompressionReport `json:"compression,omitempty"`
	GeneratedAt     int64                     `json:"generated_at,omitempty"`
}

// ContextCompactionEvent describes a context condense/truncation operation.
type ContextCompactionEvent struct {
	SessionID      string   `json:"session_id,omitempty"`
	RunID          string   `json:"run_id,omitempty"`
	Event          string   `json:"event"` // context_condensed, context_truncated, context_compaction_failed
	TokensBefore   int      `json:"tokens_before,omitempty"`
	TokensAfter    int      `json:"tokens_after,omitempty"`
	TokensMax      int      `json:"tokens_max,omitempty"`
	Percentage     float64  `json:"percentage,omitempty"`
	Summary        string   `json:"summary,omitempty"`
	PreservedItems []string `json:"preserved_items,omitempty"`
	ActiveCommands []string `json:"active_commands,omitempty"`
	Error          string   `json:"error,omitempty"`
	Timestamp      int64    `json:"timestamp,omitempty"`
}

type WorkspaceFileRecord struct {
	Path        string   `json:"path"`
	Language    string   `json:"language,omitempty"`
	Size        int64    `json:"size,omitempty"`
	Hash        string   `json:"hash,omitempty"`
	ModifiedAt  int64    `json:"modified_at,omitempty"`
	IndexedAt   int64    `json:"indexed_at,omitempty"`
	Definitions int      `json:"definitions,omitempty"`
	Imports     []string `json:"imports,omitempty"`
	Stale       bool     `json:"stale,omitempty"`
	Ignored     bool     `json:"ignored,omitempty"`
	Error       string   `json:"error,omitempty"`
}

type WorkspaceIndexStatus struct {
	WorkspaceRoot string                `json:"workspace_root,omitempty"`
	Status        string                `json:"status"` // disabled, indexing, clean, stale, error
	Enabled       bool                  `json:"enabled"`
	FilesTotal    int                   `json:"files_total,omitempty"`
	FilesIndexed  int                   `json:"files_indexed,omitempty"`
	Definitions   int                   `json:"definitions,omitempty"`
	BytesIndexed  int64                 `json:"bytes_indexed,omitempty"`
	LastIndexedAt int64                 `json:"last_indexed_at,omitempty"`
	DurationMs    int64                 `json:"duration_ms,omitempty"`
	Error         string                `json:"error,omitempty"`
	SampleFiles   []WorkspaceFileRecord `json:"sample_files,omitempty"`
}

type FoldedFileSummary struct {
	Path        string   `json:"path"`
	Language    string   `json:"language,omitempty"`
	Definitions []string `json:"definitions,omitempty"`
	Imports     []string `json:"imports,omitempty"`
	Truncated   bool     `json:"truncated,omitempty"`
	Error       string   `json:"error,omitempty"`
}

type FoldedFileContext struct {
	Root        string              `json:"root,omitempty"`
	Files       []FoldedFileSummary `json:"files,omitempty"`
	Content     string              `json:"content,omitempty"`
	MaxChars    int                 `json:"max_chars,omitempty"`
	Truncated   bool                `json:"truncated,omitempty"`
	GeneratedAt int64               `json:"generated_at,omitempty"`
}

type MemorySearchResult struct {
	Scope     string  `json:"scope"` // session, project, user
	Key       string  `json:"key,omitempty"`
	Path      string  `json:"path,omitempty"`
	LineStart int     `json:"line_start,omitempty"`
	LineEnd   int     `json:"line_end,omitempty"`
	Snippet   string  `json:"snippet"`
	Score     float64 `json:"score,omitempty"`
	Source    string  `json:"source,omitempty"`
	Timestamp int64   `json:"timestamp,omitempty"`
}

// Checkpoint represents a workspace snapshot for undo/restore functionality
type Checkpoint struct {
	Hash      string `json:"hash"`
	Message   string `json:"message,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
	ToolName  string `json:"tool_name,omitempty"` // Which tool triggered this checkpoint
}

// CheckpointEvent describes checkpoint initialization, save, restore, and diff events.
type CheckpointEvent struct {
	SessionID  string `json:"session_id,omitempty"`
	RunID      string `json:"run_id,omitempty"`
	Event      string `json:"event"` // checkpoint_initialized, checkpoint_saved, checkpoint_restored, checkpoint_failed
	Hash       string `json:"hash,omitempty"`
	BaseHash   string `json:"base_hash,omitempty"`
	Message    string `json:"message,omitempty"`
	ToolName   string `json:"tool_name,omitempty"`
	DurationMs int64  `json:"duration_ms,omitempty"`
	Error      string `json:"error,omitempty"`
	Timestamp  int64  `json:"timestamp,omitempty"`
}

type CheckpointFileChange struct {
	Path      string `json:"path"`
	OldPath   string `json:"old_path,omitempty"`
	Status    string `json:"status"` // added, modified, deleted, renamed, copied, changed
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
	Large     bool   `json:"large,omitempty"`
	Ignored   bool   `json:"ignored,omitempty"`
	Preview   string `json:"preview,omitempty"`
	Error     string `json:"error,omitempty"`
}

type CheckpointRestorePreview struct {
	CheckpointHash string                 `json:"checkpoint_hash"`
	CurrentHash    string                 `json:"current_hash,omitempty"`
	SafetyRequired bool                   `json:"safety_required"`
	Summary        string                 `json:"summary"`
	Files          []CheckpointFileChange `json:"files"`
	Warnings       []string               `json:"warnings,omitempty"`
	RestoreModes   []string               `json:"restore_modes"`
	DiffStat       string                 `json:"diff_stat,omitempty"`
	GeneratedAt    int64                  `json:"generated_at"`
}

type CheckpointRestoreRequest struct {
	CheckpointHash         string   `json:"checkpoint_hash"`
	Mode                   string   `json:"mode"` // full, selected_files, patch_only, export_snapshot
	Paths                  []string `json:"paths,omitempty"`
	CreateSafetyCheckpoint bool     `json:"create_safety_checkpoint"`
}

type CheckpointRestoreResult struct {
	RestoredHash         string   `json:"restored_hash,omitempty"`
	SafetyCheckpointHash string   `json:"safety_checkpoint_hash,omitempty"`
	FilesRestored        []string `json:"files_restored,omitempty"`
	SkippedFiles         []string `json:"skipped_files,omitempty"`
	PatchPath            string   `json:"patch_path,omitempty"`
	ExportPath           string   `json:"export_path,omitempty"`
	Mode                 string   `json:"mode"`
	DurationMs           int64    `json:"duration_ms,omitempty"`
}

type BatchArtifact struct {
	Type string `json:"type"` // summary, patch, test_log, worker_result
	Path string `json:"path"`
	Size int64  `json:"size,omitempty"`
}

type BatchTestResult struct {
	Command  string `json:"command,omitempty"`
	Status   string `json:"status,omitempty"` // passed, failed, skipped, unknown
	LogPath  string `json:"log_path,omitempty"`
	ExitCode int    `json:"exit_code,omitempty"`
}

type BatchWorker struct {
	ID                   string            `json:"id"`
	RunID                string            `json:"run_id"`
	Title                string            `json:"title"`
	Status               string            `json:"status"` // queued, running, completed, failed, timeout, interrupted, aborted, applied
	WorktreeID           string            `json:"worktree_id,omitempty"`
	Branch               string            `json:"branch,omitempty"`
	Path                 string            `json:"path,omitempty"`
	AgentSessionID       string            `json:"agent_session_id,omitempty"`
	ScopePaths           []string          `json:"scope_paths,omitempty"`
	Attempt              int               `json:"attempt,omitempty"`
	Summary              string            `json:"summary,omitempty"`
	ArtifactDir          string            `json:"artifact_dir,omitempty"`
	VerificationCommands []string          `json:"verification_commands,omitempty"`
	VerificationStatus   string            `json:"verification_status,omitempty"`
	OutputPreview        string            `json:"output_preview,omitempty"`
	Permissions          []string          `json:"permissions,omitempty"`
	DiffStat             string            `json:"diff_stat,omitempty"`
	Tests                []BatchTestResult `json:"tests,omitempty"`
	Artifacts            []BatchArtifact   `json:"artifacts,omitempty"`
	Error                string            `json:"error,omitempty"`
	StartedAt            int64             `json:"started_at,omitempty"`
	CompletedAt          int64             `json:"completed_at,omitempty"`
}

type BatchMergePlan struct {
	Status     string   `json:"status,omitempty"` // pending, clean, conflicts, applied
	ApplyOrder []string `json:"apply_order,omitempty"`
	Conflicts  []string `json:"conflicts,omitempty"`
	Warnings   []string `json:"warnings,omitempty"`
	Selected   []string `json:"selected,omitempty"`
}

type BatchRun struct {
	ID                 string         `json:"id"`
	SessionID          string         `json:"session_id,omitempty"`
	Goal               string         `json:"goal"`
	Status             string         `json:"status"` // draft, queued, running, completed, failed, interrupted, aborted, applying
	MaxWorkers         int            `json:"max_workers"`
	BaseBranch         string         `json:"base_branch,omitempty"`
	BaseCommit         string         `json:"base_commit,omitempty"`
	BaseCheckpointHash string         `json:"base_checkpoint_hash,omitempty"`
	Workers            []BatchWorker  `json:"workers,omitempty"`
	MergePlan          BatchMergePlan `json:"merge_plan,omitempty"`
	CreatedAt          int64          `json:"created_at,omitempty"`
	UpdatedAt          int64          `json:"updated_at,omitempty"`
}

type BatchEvent struct {
	Event     string       `json:"event"`
	RunID     string       `json:"run_id"`
	WorkerID  string       `json:"worker_id,omitempty"`
	Status    string       `json:"status,omitempty"`
	Run       *BatchRun    `json:"run,omitempty"`
	Worker    *BatchWorker `json:"worker,omitempty"`
	Message   string       `json:"message,omitempty"`
	Timestamp int64        `json:"timestamp"`
}

type RemoteApprovalEvent struct {
	SessionID     string   `json:"session_id,omitempty"`
	RunID         string   `json:"run_id,omitempty"`
	ApprovalID    string   `json:"approval_id"`
	Event         string   `json:"event"` // approval_requested, approval_accepted, approval_rejected, approval_cancelled
	Channel       string   `json:"channel,omitempty"`
	ToolName      string   `json:"tool_name,omitempty"`
	ArgsSummary   string   `json:"args_summary,omitempty"`
	AffectedFiles []string `json:"affected_files,omitempty"`
	OutputPreview string   `json:"output_preview,omitempty"`
	Decision      string   `json:"decision,omitempty"`
	Error         string   `json:"error,omitempty"`
	Timestamp     int64    `json:"timestamp,omitempty"`
}

// Diagnostic represents a compiler/linter error or warning
type Diagnostic struct {
	File     string `json:"file"`
	Line     int    `json:"line"`
	Message  string `json:"message"`
	Severity string `json:"severity"` // Error, Warning, Information
}

// DefinitionLocation represents a symbol definition
type DefinitionLocation struct {
	File      string `json:"file"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
}

// TaskProgress represents structured task progress for UI display
type TaskProgress struct {
	SessionID       string    `json:"session_id,omitempty"`
	RunID           string    `json:"run_id,omitempty"`
	TurnID          string    `json:"turn_id,omitempty"`
	Sequence        int64     `json:"sequence,omitempty"`
	SegmentID       string    `json:"segment_id,omitempty"`
	ParentSegmentID string    `json:"parent_segment_id,omitempty"`
	Event           string    `json:"event,omitempty"`     // worker_spawned, worker_running, worker_completed, mission_progress
	TaskName        string    `json:"task_name"`           // Header title
	Status          string    `json:"status"`              // Current step description
	Summary         string    `json:"summary,omitempty"`   // Overall summary
	Result          string    `json:"result,omitempty"`    // Result of the last step (e.g. tool output)
	Mode            string    `json:"mode,omitempty"`      // planning, execution, verification
	Steps           []string  `json:"steps,omitempty"`     // Progress history
	Files           []string  `json:"files,omitempty"`     // Files modified during task
	Todos           []Todo    `json:"todos,omitempty"`     // Visible task checklist for task header
	TodoView        *TodoView `json:"todo_view,omitempty"` // Compact diff projection for checklist updates
	ChecklistSource string    `json:"checklist_source,omitempty"`
	IsActive        bool      `json:"is_active,omitempty"` // Whether task is still in progress
	CompletedAt     int64     `json:"completed_at,omitempty"`
	ParentTaskID    string    `json:"parent_task_id,omitempty"`
	ToolCount       int       `json:"tool_count,omitempty"`
	TokenCount      int       `json:"token_count,omitempty"`
	AgentIdentifier string    `json:"agent_identifier,omitempty"` // Name of the agent performing the task (e.g. "Swarm-1")
	AgentColor      string    `json:"agent_color,omitempty"`      // Hex color for the agent badge
	WorkerQueued    int       `json:"worker_queued,omitempty"`    // Workers queued for this swarm/mission
	WorkerRunning   int       `json:"worker_running,omitempty"`   // Max concurrent workers for this swarm/mission
}

// CommandEvent represents the lifecycle of a shell command for timeline UI.
type CommandEvent struct {
	SessionID     string `json:"session_id,omitempty"`
	RunID         string `json:"run_id,omitempty"`
	TurnID        string `json:"turn_id,omitempty"`
	ToolUseID     string `json:"tool_use_id,omitempty"`
	CommandID     string `json:"command_id,omitempty"`
	Event         string `json:"event"` // command_started, command_output, command_succeeded, command_failed
	Command       string `json:"command,omitempty"`
	Cwd           string `json:"cwd,omitempty"`
	Shell         string `json:"shell,omitempty"`
	Status        string `json:"status,omitempty"` // running, completed, failed
	Stream        string `json:"stream,omitempty"` // stdout, stderr, pty, system
	Sequence      int64  `json:"sequence,omitempty"`
	Source        string `json:"source,omitempty"` // execute_command, pty, vscode_terminal
	Background    bool   `json:"background,omitempty"`
	ProcessID     int    `json:"processId,omitempty"`
	TerminalID    string `json:"terminalId,omitempty"`
	LogFile       string `json:"logFile,omitempty"`
	OutputChunk   string `json:"outputChunk,omitempty"`
	ResultPreview string `json:"resultPreview,omitempty"`
	StdoutPreview string `json:"stdoutPreview,omitempty"`
	StderrPreview string `json:"stderrPreview,omitempty"`
	Error         string `json:"error,omitempty"`
	ExitCode      int    `json:"exitCode,omitempty"`
	ExitSignal    string `json:"exitSignal,omitempty"`
	DurationMs    int64  `json:"durationMs,omitempty"`
	StartedAt     int64  `json:"startedAt,omitempty"`   // ms since epoch
	CompletedAt   int64  `json:"completedAt,omitempty"` // ms since epoch
	Truncated     bool   `json:"truncated,omitempty"`
	Timestamp     int64  `json:"timestamp,omitempty"` // ms since epoch
}

// ToolLifecycleEvent is the common event contract for every tool invocation.
type ToolLifecycleEvent struct {
	SessionID     string   `json:"session_id,omitempty"`
	RunID         string   `json:"run_id,omitempty"`
	TurnID        string   `json:"turn_id,omitempty"`
	ToolUseID     string   `json:"tool_use_id,omitempty"`
	ToolName      string   `json:"tool_name"`
	Source        string   `json:"source,omitempty"` // assistant, subagent, system
	Status        string   `json:"status"`           // running, completed, failed, aborted
	Event         string   `json:"event"`            // tool_started, tool_finished, tool_failed, tool_aborted
	StartedAt     int64    `json:"started_at,omitempty"`
	CompletedAt   int64    `json:"completed_at,omitempty"`
	DurationMs    int64    `json:"duration_ms,omitempty"`
	ArgsSummary   string   `json:"args_summary,omitempty"`
	AffectedFiles []string `json:"affected_files,omitempty"`
	Error         string   `json:"error,omitempty"`
	OutputPreview string   `json:"output_preview,omitempty"`
	Timestamp     int64    `json:"timestamp,omitempty"`
}

type PermissionDecision string

const (
	PermissionAutoApprove PermissionDecision = "auto_approve"
	PermissionAutoDeny    PermissionDecision = "auto_deny"
	PermissionAskUser     PermissionDecision = "ask_user"
)

// SkillManifest is the public, metadata-only view of a skill. Full skill bodies
// are loaded through invoke_skill so discovery stays cheap.
type SkillManifest struct {
	Name               string   `json:"name"`
	DisplayName        string   `json:"display_name,omitempty"`
	Description        string   `json:"description,omitempty"`
	WhenToUse          string   `json:"when_to_use,omitempty"`
	ArgumentHint       string   `json:"argument_hint,omitempty"`
	ArgumentNames      []string `json:"argument_names,omitempty"`
	AllowedTools       []string `json:"allowed_tools,omitempty"`
	Model              string   `json:"model,omitempty"`
	Effort             string   `json:"effort,omitempty"`
	Context            string   `json:"context,omitempty"` // inline, fork
	Source             string   `json:"source,omitempty"`  // bundled, project, user, global, legacy
	Enabled            bool     `json:"enabled"`
	UserInvocable      bool     `json:"user_invocable,omitempty"`
	Type               string   `json:"type,omitempty"`
	Enforcement        string   `json:"enforcement,omitempty"`
	Author             string   `json:"author,omitempty"`
	Version            string   `json:"version,omitempty"`
	Icon               string   `json:"icon,omitempty"`
	DocumentationURL   string   `json:"documentation_url,omitempty"`
	TriggerHint        []string `json:"trigger_hint,omitempty"`
	ContentPath        string   `json:"content_path,omitempty"`
	Path               string   `json:"path,omitempty"`
	LoadStatus         string   `json:"load_status,omitempty"`
	ValidationErrors   []string `json:"validation_errors,omitempty"`
	CanEdit            bool     `json:"can_edit,omitempty"`
	CanDelete          bool     `json:"can_delete,omitempty"`
	Scope              string   `json:"scope,omitempty"`
	Visibility         string   `json:"visibility,omitempty"`
	ImplicitInvocation bool     `json:"implicit_invocation,omitempty"`
}

// Artifact represents an assistant-generated document like a plan or walkthrough
type Artifact struct {
	ID        string `json:"id,omitempty"`
	Type      string `json:"type"` // implementation_plan, walkthrough, task, other
	Title     string `json:"title"`
	Summary   string `json:"summary"`
	Path      string `json:"path"`
	Content   string `json:"content,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Status    string `json:"status,omitempty"` // proposed, final, applied
}
