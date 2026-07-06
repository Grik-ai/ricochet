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
	"sync/atomic"
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
	StatusKilled    CommandLabel = "killed"
	StatusAborted   CommandLabel = "aborted"
	StatusTimeout   CommandLabel = "timeout"
)

const (
	// MaxBufferSize is the maximum amount of output we'll keep in memory for the chat.
	// If output exceeds this, it is truncated in the response, but the full output remains in the log file.
	MaxBufferSize = 10 * 1024 // 10KB (reduced from 5MB for better chat performance, matching Cline's philosophy)
)

type CommandState struct {
	ID            string       `json:"id"`
	Command       string       `json:"command"`
	Status        CommandLabel `json:"status"`
	Output        string       `json:"output,omitempty"`
	StdoutPreview string       `json:"stdout_preview,omitempty"`
	StderrPreview string       `json:"stderr_preview,omitempty"`
	Error         string       `json:"error,omitempty"`
	ExitCode      int          `json:"exit_code,omitempty"`
	ExitSignal    string       `json:"exit_signal,omitempty"`
	Truncated     bool         `json:"truncated,omitempty"`
	LogFile       string       `json:"log_file,omitempty"`
	Shell         string       `json:"shell,omitempty"`
	ProcessID     int          `json:"process_id,omitempty"`
	Background    bool         `json:"background,omitempty"`
	StartTime     time.Time    `json:"start_time"`
	EndTime       time.Time    `json:"end_time,omitempty"`

	cancel   context.CancelFunc
	running  bool
	sequence atomic.Int64
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

func (o *CommandOrchestrator) Execute(ctx context.Context, shellCmd string, background bool, timeoutSeconds ...int) (*CommandState, error) {
	id := uuid.New().String()
	startedAt := time.Now()
	timeout := firstPositive(timeoutSeconds...)
	shellPath, shellArgs, shellName := commandShell(shellCmd)

	baseCtx := ctx
	if background {
		baseCtx = context.Background()
	}
	var cmdCtx context.Context
	var cancel context.CancelFunc
	if timeout > 0 {
		cmdCtx, cancel = context.WithTimeout(baseCtx, time.Duration(timeout)*time.Second)
	} else {
		cmdCtx, cancel = context.WithCancel(baseCtx)
	}

	state := &CommandState{
		ID:         id,
		Command:    shellCmd,
		Status:     StatusRunning,
		Shell:      shellName,
		Background: background,
		StartTime:  startedAt,
		cancel:     cancel,
	}
	sink := CommandEventSinkFromContext(ctx)

	o.mu.Lock()
	o.commands[id] = state
	o.mu.Unlock()

	logDir := paths.GetLogDir(o.cwd)
	if err := paths.EnsureDir(logDir); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create log directory: %w", err)
	}

	state.LogFile = filepath.Join(logDir, fmt.Sprintf("%s.log", id))

	cmd := exec.Command(shellPath, shellArgs...)
	cmd.Dir = o.cwd
	configureCommandProcess(cmd)

	if background {
		started := make(chan error, 1)
		go o.runCommand(cmdCtx, cancel, cmd, state, sink, started)
		if err := <-started; err != nil {
			return state, err
		}
		return state, nil
	}

	o.runCommand(cmdCtx, cancel, cmd, state, sink, nil)
	return state, nil
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func commandShellArgs(shellCmd string) (string, []string) {
	path, args, _ := commandShell(shellCmd)
	return path, args
}

func commandShell(shellCmd string) (string, []string, string) {
	if _, err := os.Stat("/bin/bash"); err == nil {
		return "/bin/bash", []string{"-o", "pipefail", "-c", shellCmd}, "bash"
	}
	if bashPath, err := exec.LookPath("bash"); err == nil {
		return bashPath, []string{"-o", "pipefail", "-c", shellCmd}, "bash"
	}
	return "sh", []string{"-c", shellCmd}, "sh"
}

type commandOutputWriter struct {
	writer io.Writer
	sink   CommandEventSink
	state  *CommandState
	cwd    string
	stream string
	mu     *sync.Mutex
}

func (w *commandOutputWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	n, err := w.writer.Write(p)
	w.mu.Unlock()

	if w.sink != nil && len(p) > 0 {
		w.sink(CommandOutputEvent{
			ID:         w.state.ID,
			Command:    w.state.Command,
			Cwd:        w.cwd,
			Shell:      w.state.Shell,
			Stream:     w.stream,
			Sequence:   w.state.sequence.Add(1),
			Source:     "execute_command",
			Background: w.state.Background,
			ProcessID:  w.state.ProcessID,
			LogFile:    w.state.LogFile,
			Output:     format.ProcessTerminalOutput(string(p)),
			Status:     StatusRunning,
			StartTime:  w.state.StartTime,
		})
	}
	return n, err
}

func (o *CommandOrchestrator) runCommand(cmdCtx context.Context, cancel context.CancelFunc, cmd *exec.Cmd, state *CommandState, sink CommandEventSink, started chan<- error) {
	defer cancel()

	logFile, err := os.Create(state.LogFile)
	if err != nil {
		notifyCommandStarted(started, err)
		o.finishCommand(state, nil, nil, nil, fmt.Errorf("failed to create log file: %w", err), context.Canceled, sink)
		return
	}
	defer logFile.Close()

	var aggregateBuf bytes.Buffer
	var stdoutBuf bytes.Buffer
	var stderrBuf bytes.Buffer
	writeMu := &sync.Mutex{}
	cmd.Stdout = &commandOutputWriter{
		writer: io.MultiWriter(logFile, &aggregateBuf, &stdoutBuf),
		sink:   sink,
		state:  state,
		cwd:    o.cwd,
		stream: "stdout",
		mu:     writeMu,
	}
	cmd.Stderr = &commandOutputWriter{
		writer: io.MultiWriter(logFile, &aggregateBuf, &stderrBuf),
		sink:   sink,
		state:  state,
		cwd:    o.cwd,
		stream: "stderr",
		mu:     writeMu,
	}

	if err := cmd.Start(); err != nil {
		notifyCommandStarted(started, err)
		o.finishCommand(state, &aggregateBuf, &stdoutBuf, &stderrBuf, err, context.Canceled, sink)
		return
	}

	o.mu.Lock()
	state.ProcessID = cmd.Process.Pid
	state.running = true
	o.mu.Unlock()

	if sink != nil {
		sink(CommandOutputEvent{
			ID:         state.ID,
			Command:    state.Command,
			Cwd:        o.cwd,
			Shell:      state.Shell,
			Stream:     "system",
			Sequence:   state.sequence.Add(1),
			Source:     "execute_command",
			Background: state.Background,
			ProcessID:  state.ProcessID,
			LogFile:    state.LogFile,
			Status:     StatusRunning,
			StartTime:  state.StartTime,
			Started:    true,
		})
	}
	notifyCommandStarted(started, nil)

	done := make(chan struct{})
	go func() {
		select {
		case <-cmdCtx.Done():
			o.markContextExit(state, cmdCtx.Err())
			terminateCommandProcess(state.ProcessID, false)
			select {
			case <-done:
			case <-time.After(1200 * time.Millisecond):
				terminateCommandProcess(state.ProcessID, true)
			}
		case <-done:
		}
	}()

	waitErr := cmd.Wait()
	close(done)
	o.finishCommand(state, &aggregateBuf, &stdoutBuf, &stderrBuf, waitErr, cmdCtx.Err(), sink)
}

func notifyCommandStarted(started chan<- error, err error) {
	if started != nil {
		started <- err
	}
}

func (o *CommandOrchestrator) markContextExit(state *CommandState, ctxErr error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if state.ExitSignal != "" {
		return
	}
	if ctxErr == context.DeadlineExceeded {
		state.ExitSignal = "timeout"
		return
	}
	state.ExitSignal = "aborted"
}

func (o *CommandOrchestrator) finishCommand(state *CommandState, aggregateBuf, stdoutBuf, stderrBuf *bytes.Buffer, err error, ctxErr error, sink CommandEventSink) {
	o.mu.Lock()
	defer o.mu.Unlock()

	state.running = false
	state.EndTime = time.Now()
	state.cancel = nil

	state.ExitCode = 0
	if err != nil {
		state.ExitCode = -1
		if exitErr, ok := err.(*exec.ExitError); ok {
			state.ExitCode = exitErr.ExitCode()
		}
	}

	switch {
	case state.ExitSignal == "timeout" || ctxErr == context.DeadlineExceeded:
		state.Status = StatusTimeout
		state.Error = "command timed out"
		state.ExitSignal = "timeout"
	case state.ExitSignal == "killed":
		state.Status = StatusKilled
		state.Error = "command killed"
	case state.ExitSignal == "aborted":
		state.Status = StatusAborted
		state.Error = "command aborted"
	case err != nil:
		state.Status = StatusFailed
		state.Error = err.Error()
	default:
		state.Status = StatusCompleted
	}

	state.Output, state.StdoutPreview, state.StderrPreview, state.Truncated = o.commandPreviews(aggregateBuf, stdoutBuf, stderrBuf)

	if sink != nil {
		sink(CommandOutputEvent{
			ID:            state.ID,
			Command:       state.Command,
			Cwd:           o.cwd,
			Shell:         state.Shell,
			Stream:        "system",
			Sequence:      state.sequence.Add(1),
			Source:        "execute_command",
			Background:    state.Background,
			ProcessID:     state.ProcessID,
			LogFile:       state.LogFile,
			ResultPreview: state.Output,
			StdoutPreview: state.StdoutPreview,
			StderrPreview: state.StderrPreview,
			Status:        state.Status,
			Error:         state.Error,
			ExitCode:      state.ExitCode,
			ExitSignal:    state.ExitSignal,
			StartTime:     state.StartTime,
			EndTime:       state.EndTime,
			Truncated:     state.Truncated,
		})
	}
}

func (o *CommandOrchestrator) commandPreviews(aggregateBuf, stdoutBuf, stderrBuf *bytes.Buffer) (string, string, string, bool) {
	aggregate := processCommandBuffer(aggregateBuf)
	stdout := processCommandBuffer(stdoutBuf)
	stderr := processCommandBuffer(stderrBuf)

	var lineTruncated bool
	aggregate, lineTruncated = truncateCommandOutputLines(aggregate, o.outputLineLimit)
	stdout, _ = truncateCommandOutputLines(stdout, o.outputLineLimit)
	stderr, _ = truncateCommandOutputLines(stderr, o.outputLineLimit)

	output, outputTruncated := capCommandOutput(aggregate, MaxBufferSize)
	stdoutPreview, stdoutTruncated := capCommandOutput(stdout, MaxBufferSize)
	stderrPreview, stderrTruncated := capCommandOutput(stderr, MaxBufferSize)
	return output, stdoutPreview, stderrPreview, lineTruncated || outputTruncated || stdoutTruncated || stderrTruncated
}

func processCommandBuffer(buf *bytes.Buffer) string {
	if buf == nil {
		return ""
	}
	return format.ProcessTerminalOutput(buf.String())
}

func capCommandOutput(output string, limit int) (string, bool) {
	if limit <= 0 || len(output) <= limit {
		return output, false
	}
	return output[:limit] + "\n... (output truncated, see command log for full output)", true
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

func (o *CommandOrchestrator) StopCommand(ctx context.Context, id string, force bool) (*CommandState, bool) {
	o.mu.Lock()
	state, ok := o.commands[id]
	if !ok {
		o.mu.Unlock()
		return nil, false
	}
	if !state.running || state.EndTime.After(time.Time{}) {
		o.mu.Unlock()
		return state, true
	}
	if force {
		state.ExitSignal = "killed"
	} else if state.ExitSignal == "" {
		state.ExitSignal = "aborted"
	}
	processID := state.ProcessID
	cancel := state.cancel
	o.mu.Unlock()

	if processID > 0 {
		terminateCommandProcess(processID, force)
	}
	if cancel != nil {
		cancel()
	}

	deadline := time.After(1500 * time.Millisecond)
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		o.mu.RLock()
		done := !state.running || !state.EndTime.IsZero()
		o.mu.RUnlock()
		if done {
			return state, true
		}
		select {
		case <-ctx.Done():
			return state, true
		case <-deadline:
			return state, true
		case <-ticker.C:
		}
	}
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
