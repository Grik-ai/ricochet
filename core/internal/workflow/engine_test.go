package workflow

import (
	"context"
	"strings"
	"testing"
)

// MockExecutor implements AgentExecutor for testing
type MockExecutor struct{}

func (m *MockExecutor) Execute(ctx context.Context, prompt string) (string, error) {
	return "Mock response for: " + prompt, nil
}

// MockCommandExecutor implements CommandExecutor for testing
type MockCommandExecutor struct{}

func (m *MockCommandExecutor) Execute(command string) (string, error) {
	return "Mock command output: " + command, nil
}

func TestEngine_Sequential(t *testing.T) {
	engine := NewEngine(&MockExecutor{}, &MockCommandExecutor{})

	wf := WorkflowDefinition{
		Name: "test-seq",
		Steps: []WorkflowStep{
			{ID: "step1", Action: "Do A"},
			{ID: "step2", Action: "Do B"},
		},
	}

	ctx := context.Background()
	res, err := engine.Execute(ctx, wf, nil)
	if err != nil {
		t.Fatalf("Execute failed: %v", err)
	}

	if len(res.History) != 2 {
		t.Errorf("Expected 2 steps, got %d", len(res.History))
	}

	if !strings.Contains(res.History[0].Output, "Do A") {
		t.Errorf("Step 1 output mismatch: %s", res.History[0].Output)
	}
	if got := res.Variables["step.step1.output"]; got == nil {
		t.Fatalf("expected first step output to be available to later steps")
	}
}

func TestEngine_Parallel(t *testing.T) {
	engine := NewEngine(&MockExecutor{}, &MockCommandExecutor{})

	wf := WorkflowDefinition{
		Name: "test-parallel",
		Steps: []WorkflowStep{
			{
				ID:   "par-step",
				Type: "parallel",
				Parallel: []WorkflowStep{
					{ID: "p1", Action: "Parallel 1"},
					{ID: "p2", Action: "Parallel 2"},
				},
			},
		},
	}

	ctx := context.Background()
	res, err := engine.Execute(ctx, wf, map[string]interface{}{"input": "test"})
	if err != nil {
		t.Fatalf("Execute failed: %v", err)
	}

	if len(res.History) != 1 {
		t.Errorf("Expected 1 main step, got %d", len(res.History))
	}

	output := res.History[0].Output
	if !strings.Contains(output, "Parallel 1") || !strings.Contains(output, "Parallel 2") {
		t.Errorf("Parallel output missing results: %s", output)
	}
}

func TestEngine_ContextPassesBetweenSteps(t *testing.T) {
	engine := NewEngine(&MockExecutor{}, &MockCommandExecutor{})
	wf := WorkflowDefinition{
		Name: "test-context",
		Steps: []WorkflowStep{
			{ID: "first", Action: "Alpha"},
			{ID: "second", Action: "Saw {{step.first.output}} and {{last_output}}"},
		},
	}

	res, err := engine.Execute(context.Background(), wf, nil)
	if err != nil {
		t.Fatalf("Execute failed: %v", err)
	}
	if len(res.History) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(res.History))
	}
	if !strings.Contains(res.History[1].Output, "Alpha") {
		t.Fatalf("expected second step to receive first step output: %s", res.History[1].Output)
	}
}

func TestEngine_CommandInjectionBlockedByDefault(t *testing.T) {
	engine := NewEngine(&MockExecutor{}, &MockCommandExecutor{})
	wf := WorkflowDefinition{
		Name: "test-command-block",
		Steps: []WorkflowStep{
			{ID: "cmd", Action: "Run !`date`"},
		},
	}

	res, err := engine.Execute(context.Background(), wf, nil)
	if err == nil {
		t.Fatalf("expected command injection to be blocked")
	}
	if len(res.History) != 1 || res.History[0].Status != "failed" {
		t.Fatalf("expected failed history entry, got %#v", res.History)
	}
}

func TestEngine_CommandInjectionAllowedPerStep(t *testing.T) {
	engine := NewEngine(&MockExecutor{}, &MockCommandExecutor{})
	wf := WorkflowDefinition{
		Name: "test-command-allow",
		Steps: []WorkflowStep{
			{ID: "cmd", Action: "Run !`date`", AllowCommandInjection: true},
		},
	}

	res, err := engine.Execute(context.Background(), wf, nil)
	if err != nil {
		t.Fatalf("Execute failed: %v", err)
	}
	if !strings.Contains(res.History[0].Output, "Mock command output: date") {
		t.Fatalf("expected command output injection, got %s", res.History[0].Output)
	}
}
