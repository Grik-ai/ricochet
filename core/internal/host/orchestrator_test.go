package host

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCommandOrchestratorPipefailFailsPipeline(t *testing.T) {
	shellPath, _ := commandShellArgs("true")
	if filepath.Base(shellPath) == "sh" {
		t.Skip("bash is not available; pipefail fallback cannot be enforced")
	}

	orchestrator := newTestCommandOrchestrator(t)
	state, err := orchestrator.Execute(context.Background(), "definitely_missing_ricochet_command | wc -l", false)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if state.Status != StatusFailed {
		t.Fatalf("expected failed status for missing command pipeline, got %q with output %q", state.Status, state.Output)
	}
	if state.ExitCode == 0 {
		t.Fatalf("expected non-zero exit code for missing command pipeline")
	}
}

func TestCommandOrchestratorSuccessfulPipeline(t *testing.T) {
	orchestrator := newTestCommandOrchestrator(t)
	state, err := orchestrator.Execute(context.Background(), "printf 'a\\nb\\n' | wc -l", false)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if state.Status != StatusCompleted {
		t.Fatalf("expected completed status, got %q with error %q", state.Status, state.Error)
	}
	if state.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", state.ExitCode)
	}
	if !strings.Contains(state.Output, "2") {
		t.Fatalf("expected pipeline output to contain count 2, got %q", state.Output)
	}
}

func TestCommandOrchestratorOutputLineLimit(t *testing.T) {
	orchestrator := newTestCommandOrchestrator(t)
	orchestrator.SetOutputLineLimit(4)

	state, err := orchestrator.Execute(context.Background(), "printf '1\\n2\\n3\\n4\\n5\\n6\\n'", false)
	if err != nil {
		t.Fatalf("execute failed: %v", err)
	}
	if !state.Truncated {
		t.Fatal("expected output to be marked truncated")
	}
	if !strings.Contains(state.Output, "lines omitted") {
		t.Fatalf("expected omitted-lines marker, got %q", state.Output)
	}
	if strings.Contains(state.Output, "\n3\n") || strings.Contains(state.Output, "\n4\n") {
		t.Fatalf("expected middle lines to be omitted, got %q", state.Output)
	}
}

func TestCommandOrchestratorEmitsSplitStreamsAndFinalMetadata(t *testing.T) {
	orchestrator := newTestCommandOrchestrator(t)
	var mu sync.Mutex
	var events []CommandOutputEvent
	ctx := WithCommandEventSink(context.Background(), func(event CommandOutputEvent) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	})

	state, err := orchestrator.Execute(ctx, "printf 'out\\n'; printf 'err\\n' >&2", false)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if state.Status != StatusCompleted {
		t.Fatalf("expected completed status, got %q", state.Status)
	}
	if state.StdoutPreview != "out\n" {
		t.Fatalf("expected stdout preview, got %q", state.StdoutPreview)
	}
	if state.StderrPreview != "err\n" {
		t.Fatalf("expected stderr preview, got %q", state.StderrPreview)
	}
	if state.LogFile == "" {
		t.Fatal("expected log file path")
	}
	if _, err := os.Stat(state.LogFile); err != nil {
		t.Fatalf("expected log file to exist: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	var sawStarted, sawStdout, sawStderr, sawFinal bool
	sequences := map[int64]bool{}
	for _, event := range events {
		if event.Sequence <= 0 {
			t.Fatalf("expected positive event sequence, got %d", event.Sequence)
		}
		if sequences[event.Sequence] {
			t.Fatalf("expected unique event sequence, got duplicate %d", event.Sequence)
		}
		sequences[event.Sequence] = true
		if event.Started && event.ProcessID > 0 {
			sawStarted = true
		}
		if event.Stream == "stdout" && strings.Contains(event.Output, "out") {
			sawStdout = true
		}
		if event.Stream == "stderr" && strings.Contains(event.Output, "err") {
			sawStderr = true
		}
		if event.Status == StatusCompleted && event.ResultPreview != "" && event.LogFile == state.LogFile {
			sawFinal = true
		}
	}
	if !sawStarted || !sawStdout || !sawStderr || !sawFinal {
		t.Fatalf("missing expected events: started=%v stdout=%v stderr=%v final=%v events=%+v", sawStarted, sawStdout, sawStderr, sawFinal, events)
	}
}

func TestCommandOrchestratorTimeout(t *testing.T) {
	orchestrator := newTestCommandOrchestrator(t)
	state, err := orchestrator.Execute(context.Background(), "sleep 2", false, 1)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if state.Status != StatusTimeout {
		t.Fatalf("expected timeout status, got %q", state.Status)
	}
	if state.ExitSignal != "timeout" {
		t.Fatalf("expected timeout exit signal, got %q", state.ExitSignal)
	}
}

func TestCommandOrchestratorBackgroundStop(t *testing.T) {
	orchestrator := newTestCommandOrchestrator(t)
	state, err := orchestrator.Execute(context.Background(), "sleep 10", true)
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if !state.Background || state.ProcessID == 0 {
		t.Fatalf("expected background command with process id, got background=%v pid=%d", state.Background, state.ProcessID)
	}

	stopped, ok := orchestrator.StopCommand(context.Background(), state.ID, true)
	if !ok {
		t.Fatal("expected command to be stoppable")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		current, _ := orchestrator.GetStatus(state.ID)
		if current != nil && current.Status == StatusKilled {
			stopped = current
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if stopped.Status != StatusKilled {
		t.Fatalf("expected killed status, got %q", stopped.Status)
	}
	if stopped.ExitSignal != "killed" {
		t.Fatalf("expected killed exit signal, got %q", stopped.ExitSignal)
	}
}

func newTestCommandOrchestrator(t *testing.T) *CommandOrchestrator {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return NewCommandOrchestrator(t.TempDir())
}
