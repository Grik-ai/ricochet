package host

import (
	"context"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type commandEventSinkKey struct{}

// Host defines the interface for environment-specific operations.
// This allows Ricochet to run in different hosts (VSCode, JetBrains, Terminal)
// by providing a consistent interface for OS and UI interactions.
type Host interface {
	// File System operations
	GetCWD() string
	ReadFile(path string) ([]byte, error)
	WriteFile(path string, data []byte) error
	ListDir(path string) ([]FileInfo, error)

	// Terminal operations
	ExecuteCommand(ctx context.Context, command string, background bool, timeoutSeconds ...int) (CommandResult, error)
	GetCommandStatus(id string) (CommandStatus, bool)
	StopCommand(ctx context.Context, id string, force bool) (CommandStatus, bool)

	// UI / Interaction
	ShowMessage(level string, text string)
	AskUser(sessionID string, question string) (string, error)
	AskUserChoice(sessionID string, question string, choices []string) (int, error)
	SendMessage(msg protocol.RPCMessage)
	SendRequest(method string, payload interface{}) (interface{}, error)
}

// CommandStatus represents the current state of a command
type CommandStatus struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	Output      string `json:"output,omitempty"`
	Error       string `json:"error,omitempty"`
	LogFile     string `json:"log_file,omitempty"`
	ExitCode    int    `json:"exit_code,omitempty"`
	DurationMs  int64  `json:"duration_ms,omitempty"`
	StartedAt   int64  `json:"started_at,omitempty"`
	CompletedAt int64  `json:"completed_at,omitempty"`
	Truncated   bool   `json:"truncated,omitempty"`
	ProcessID   int    `json:"process_id,omitempty"`
	Background  bool   `json:"background,omitempty"`
	Shell       string `json:"shell,omitempty"`
	ExitSignal  string `json:"exit_signal,omitempty"`
}

// FileInfo represents basic file metadata
type FileInfo struct {
	Name  string
	Size  int64
	IsDir bool
}

// CommandResult represents the outcome of a command execution
type CommandResult struct {
	ID          string // Unique ID for the command
	Output      string // Immediate output (if not background)
	Status      string
	Error       error
	ExitCode    int
	DurationMs  int64
	Cwd         string
	Shell       string
	LogFile     string
	ProcessID   int
	Background  bool
	ExitSignal  string
	StartedAt   time.Time
	CompletedAt time.Time
	Truncated   bool
}

// CommandOutputEvent is emitted by the command runner while stdout/stderr is streaming.
type CommandOutputEvent struct {
	ID            string
	Command       string
	Cwd           string
	Shell         string
	Stream        string
	Sequence      int64
	Source        string
	Background    bool
	ProcessID     int
	TerminalID    string
	LogFile       string
	Output        string
	ResultPreview string
	StdoutPreview string
	StderrPreview string
	Status        CommandLabel
	Error         string
	ExitCode      int
	ExitSignal    string
	StartTime     time.Time
	EndTime       time.Time
	Truncated     bool
	Started       bool
}

type CommandEventSink func(CommandOutputEvent)

func WithCommandEventSink(ctx context.Context, sink CommandEventSink) context.Context {
	return context.WithValue(ctx, commandEventSinkKey{}, sink)
}

func CommandEventSinkFromContext(ctx context.Context) CommandEventSink {
	if sink, ok := ctx.Value(commandEventSinkKey{}).(CommandEventSink); ok {
		return sink
	}
	return nil
}

func unixMillis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func durationMsBetween(start, end time.Time) int64 {
	if start.IsZero() || end.IsZero() {
		return 0
	}
	return end.Sub(start).Milliseconds()
}
