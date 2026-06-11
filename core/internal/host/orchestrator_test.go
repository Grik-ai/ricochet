package host

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandOrchestratorPipefailFailsPipeline(t *testing.T) {
	shellPath, _ := commandShellArgs("true")
	if filepath.Base(shellPath) == "sh" {
		t.Skip("bash is not available; pipefail fallback cannot be enforced")
	}

	orchestrator := NewCommandOrchestrator(t.TempDir())
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
	orchestrator := NewCommandOrchestrator(t.TempDir())
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
	orchestrator := NewCommandOrchestrator(t.TempDir())
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
