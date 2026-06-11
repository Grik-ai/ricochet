package host

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/igoryan-dao/ricochet/internal/format"
	"github.com/igoryan-dao/ricochet/internal/paths"
)

type CommandLabel string

const (
	StatusRunning   CommandLabel = "running"
	StatusCompleted CommandLabel = "completed"
	StatusFailed    CommandLabel = "failed"
)

const (
	// MaxBufferSize is the maximum amount of output we'll keep in memory for the chat.
	// If output exceeds this, it is truncated in the response, but the full output remains in the log file.
	MaxBufferSize = 10 * 1024 // 10KB (reduced from 5MB for better chat performance, matching Cline's philosophy)
)

type CommandState struct {
	ID        string       `json:"id"`
	Command   string       `json:"command"`
	Status    CommandLabel `json:"status"`
	Output    string       `json:"output,omitempty"`
	Error     string       `json:"error,omitempty"`
	ExitCode  int          `json:"exit_code,omitempty"`
	Truncated bool         `json:"truncated,omitempty"`
	LogFile   string       `json:"log_file,omitempty"`
	StartTime time.Time    `json:"start_time"`
	EndTime   time.Time    `json:"end_time,omitempty"`
}

type CommandOrchestrator struct {
	cwd             string
	commands        map[string]*CommandState
	outputLineLimit int
	mu              sync.RWMutex
}

func NewCommandOrchestrator(cwd string) *CommandOrchestrator {
	return &CommandOrchestrator{
		cwd:             cwd,
		commands:        make(map[string]*CommandState),
		outputLineLimit: 500,
	}
}

func (o *CommandOrchestrator) SetOutputLineLimit(limit int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if limit <= 0 {
		limit = 500
	}
	o.outputLineLimit = limit
}

func (o *CommandOrchestrator) Execute(ctx context.Context, shellCmd string, background bool) (*CommandState, error) {
	id := uuid.New().String()
	startedAt := time.Now()
	state := &CommandState{
		ID:        id,
		Command:   shellCmd,
		Status:    StatusRunning,
		StartTime: startedAt,
	}
	sink := CommandEventSinkFromContext(ctx)

	o.mu.Lock()
	o.commands[id] = state
	o.mu.Unlock()

	// Ensure log directory exists in the global storage
	logDir := paths.GetLogDir(o.cwd)
	if err := paths.EnsureDir(logDir); err != nil {
		return nil, fmt.Errorf("failed to create log directory: %w", err)
	}

	logFilePath := filepath.Join(logDir, fmt.Sprintf("%s.log", id))
	state.LogFile = logFilePath

	// Start command
	// Note: We don't use CommandContext for background tasks if we want them to outlive the tool call context,
	// but usually tool calls have a reasonable timeout. For background, we might want a separate context.
	var cmdCtx context.Context
	var cancel context.CancelFunc
	if background {
		// For background commands, we use a background context to avoid being killed when the tool call returns.
		cmdCtx, cancel = context.WithCancel(context.Background())
		_ = cancel // In a real system, we'd store cancel to allow killing the process
	} else {
		cmdCtx = ctx
	}

	shellPath, shellArgs := commandShellArgs(shellCmd)
	cmd := exec.CommandContext(cmdCtx, shellPath, shellArgs...)
	cmd.Dir = o.cwd

	if background {
		go o.runCommand(cmd, state, sink)
		return state, nil
	}

	o.runCommand(cmd, state, sink)
	return state, nil
}

func commandShellArgs(shellCmd string) (string, []string) {
	if _, err := os.Stat("/bin/bash"); err == nil {
		return "/bin/bash", []string{"-o", "pipefail", "-c", shellCmd}
	}
	if bashPath, err := exec.LookPath("bash"); err == nil {
		return bashPath, []string{"-o", "pipefail", "-c", shellCmd}
	}
	return "sh", []string{"-c", shellCmd}
}

type commandOutputWriter struct {
	writer io.Writer
	sink   CommandEventSink
	state  *CommandState
	cwd    string
	mu     sync.Mutex
}

func (w *commandOutputWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	n, err := w.writer.Write(p)
	w.mu.Unlock()

	if w.sink != nil && len(p) > 0 {
		w.sink(CommandOutputEvent{
			ID:        w.state.ID,
			Command:   w.state.Command,
			Cwd:       w.cwd,
			Output:    format.ProcessTerminalOutput(string(p)),
			Status:    StatusRunning,
			StartTime: w.state.StartTime,
		})
	}
	return n, err
}

func (o *CommandOrchestrator) runCommand(cmd *exec.Cmd, state *CommandState, sink CommandEventSink) {
	logFile, err := os.Create(state.LogFile)
	if err != nil {
		o.mu.Lock()
		state.Status = StatusFailed
		state.Error = fmt.Sprintf("failed to create log file: %v", err)
		o.mu.Unlock()
		if sink != nil {
			now := time.Now()
			sink(CommandOutputEvent{
				ID:        state.ID,
				Command:   state.Command,
				Cwd:       o.cwd,
				Status:    StatusFailed,
				Error:     state.Error,
				ExitCode:  state.ExitCode,
				StartTime: state.StartTime,
				EndTime:   now,
			})
		}
		return
	}
	defer logFile.Close()

	var buf bytes.Buffer
	// MultiWriter to handle both in-memory buffer (for chat) and file log
	mw := io.MultiWriter(logFile, &buf)
	streamWriter := &commandOutputWriter{
		writer: mw,
		sink:   sink,
		state:  state,
		cwd:    o.cwd,
	}

	cmd.Stdout = streamWriter
	cmd.Stderr = streamWriter

	err = cmd.Run()

	o.mu.Lock()
	defer o.mu.Unlock()

	state.EndTime = time.Now()
	if err != nil {
		state.Status = StatusFailed
		state.Error = err.Error()
		state.ExitCode = -1
		if exitErr, ok := err.(*exec.ExitError); ok {
			state.ExitCode = exitErr.ExitCode()
		}
	} else {
		state.Status = StatusCompleted
		state.ExitCode = 0
	}

	output := buf.String()
	// Apply terminal output polish for chat display
	cleanOutput := format.ProcessTerminalOutput(output)
	cleanOutput, lineTruncated := truncateCommandOutputLines(cleanOutput, o.outputLineLimit)

	if len(cleanOutput) > MaxBufferSize {
		state.Output = cleanOutput[:MaxBufferSize] + "\n... (output truncated, see log file for full output: " + state.LogFile + ")"
		state.Truncated = true
	} else {
		state.Output = cleanOutput
		state.Truncated = lineTruncated
	}

	if sink != nil {
		sink(CommandOutputEvent{
			ID:        state.ID,
			Command:   state.Command,
			Cwd:       o.cwd,
			Status:    state.Status,
			Error:     state.Error,
			ExitCode:  state.ExitCode,
			StartTime: state.StartTime,
			EndTime:   state.EndTime,
			Truncated: state.Truncated,
		})
	}
}

func truncateCommandOutputLines(output string, limit int) (string, bool) {
	if limit <= 0 || strings.TrimSpace(output) == "" {
		return output, false
	}
	lines := strings.Split(output, "\n")
	if len(lines) <= limit {
		return output, false
	}
	head := limit / 2
	tail := limit - head
	if head <= 0 {
		head = 1
		tail = limit - head
	}
	omitted := len(lines) - head - tail
	truncated := make([]string, 0, limit+1)
	truncated = append(truncated, lines[:head]...)
	truncated = append(truncated, fmt.Sprintf("... (%d lines omitted; see command log for full output)", omitted))
	truncated = append(truncated, lines[len(lines)-tail:]...)
	return strings.Join(truncated, "\n"), true
}

func (o *CommandOrchestrator) GetStatus(id string) (*CommandState, bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	state, ok := o.commands[id]
	return state, ok
}

func (o *CommandOrchestrator) ListCommands() []*CommandState {
	o.mu.RLock()
	defer o.mu.RUnlock()
	res := make([]*CommandState, 0, len(o.commands))
	for _, v := range o.commands {
		res = append(res, v)
	}
	return res
}
