package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestIsPlanArtifactRequestDetectsNaturalPlanRequests(t *testing.T) {
	if !isPlanArtifactRequest("создай план работ") {
		t.Fatalf("expected Russian plan request to use plan artifact flow")
	}
	if !isPlanArtifactRequest("create a plan for the refactor") {
		t.Fatalf("expected English plan request to use plan artifact flow")
	}
	if isPlanArtifactRequest("create docs/implementation_plan.md") {
		t.Fatalf("explicit markdown file requests should keep normal file flow")
	}
	if isPlanArtifactRequest("создай файл с планом") {
		t.Fatalf("explicit file requests should keep normal file flow")
	}
}

func TestSubmitPlanArtifactPersistsInternalPlan(t *testing.T) {
	tempDir := t.TempDir()
	previousDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Chdir(previousDir); err != nil {
			t.Fatalf("restore cwd: %v", err)
		}
	}()

	var c Controller
	artifact, err := c.submitPlanArtifact("session-1", `{"title":"Implementation Plan","summary":"Plan summary","content":"# Plan\n\nDo this first."}`)
	if err != nil {
		t.Fatalf("submitPlanArtifact failed: %v", err)
	}

	if artifact.Type != "implementation_plan" {
		t.Fatalf("unexpected artifact type: %s", artifact.Type)
	}
	if artifact.Content != "# Plan\n\nDo this first." {
		t.Fatalf("artifact content was not preserved: %q", artifact.Content)
	}
	if !strings.Contains(filepath.ToSlash(artifact.Path), ".ricochet/artifacts/session-1/implementation_plan.md") {
		t.Fatalf("artifact path should be internal .ricochet artifact path, got %s", artifact.Path)
	}

	content, err := os.ReadFile(artifact.Path)
	if err != nil {
		t.Fatalf("expected artifact file to be written: %v", err)
	}
	if strings.TrimSpace(string(content)) != artifact.Content {
		t.Fatalf("persisted content mismatch: %q", string(content))
	}
}

func TestDeriveArtifactIgnoresOrdinaryWorkspaceWrites(t *testing.T) {
	var c Controller

	if artifact := c.deriveArtifact("session-1", "write_file", `{"path":"tests/math_tests.rs"}`); artifact != nil {
		t.Fatalf("ordinary Rust test files should not become artifacts: %#v", artifact)
	}

	report := c.deriveArtifact("session-1", "write_file", `{"path":"reports/project_report.md"}`)
	if report == nil {
		t.Fatalf("expected markdown report to become an artifact")
	}
	if report.Type != "report" {
		t.Fatalf("unexpected artifact type: %s", report.Type)
	}
	if !strings.Contains(filepath.ToSlash(report.Path), ".ricochet/artifacts/session-1/project_report.md") {
		t.Fatalf("report artifact path should be internal, got %s", report.Path)
	}
}

func TestProcessAssistantTurnRestoresSubmitPlanArtifact(t *testing.T) {
	tempDir := t.TempDir()
	previousDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Chdir(previousDir); err != nil {
			t.Fatalf("restore cwd: %v", err)
		}
	}()

	args := `{"title":"Implementation Plan","summary":"Plan summary","content":"# Plan\n\nDo this first.","kind":"implementation_plan"}`
	var c Controller
	_, _, artifacts := c.processAssistantTurn("session-1", []protocol.Message{
		{
			Role: "assistant",
			ToolUse: []protocol.ToolUseBlock{{
				ID:    "tool-submit-plan",
				Name:  "submit_plan",
				Input: json.RawMessage(args),
			}},
		},
		{
			Role: "user",
			ToolResults: []protocol.ToolResultBlock{{
				ToolUseID: "tool-submit-plan",
				Content:   "Implementation plan artifact submitted",
			}},
		},
	}, 0)

	if len(artifacts) != 1 {
		t.Fatalf("expected one restored plan artifact, got %d", len(artifacts))
	}
	artifact := artifacts[0]
	if artifact.Type != "implementation_plan" || artifact.Title != "Implementation Plan" {
		t.Fatalf("unexpected restored artifact: %#v", artifact)
	}
	if artifact.Content != "# Plan\n\nDo this first." {
		t.Fatalf("restored artifact content mismatch: %q", artifact.Content)
	}
	if _, err := os.Stat(artifact.Path); !os.IsNotExist(err) {
		t.Fatalf("history restoration should not rewrite artifact file, stat err: %v", err)
	}
}
