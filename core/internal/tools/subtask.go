package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// SubtaskTool allows the agent to spawn a sub-agent for a specific goal
type SubtaskTool struct {
	Executor SubtaskExecutor
}

// SubtaskResult represents the structured outcome of a subtask
type SubtaskResult struct {
	Status       string   `json:"status"` // success, failed
	Summary      string   `json:"summary,omitempty"`
	Error        string   `json:"error,omitempty"`
	Artifacts    []string `json:"artifacts,omitempty"`
	RecoveryHint string   `json:"recovery_hint,omitempty"`
}

// SubtaskExecutor interface allows the tool to call back into the controller/engine
type SubtaskExecutor interface {
	RunSubtask(ctx context.Context, parentSessionID string, goal string, contextInfo string, role string, preconditions []string, expectedOutcome string) (string, error)
}

func (t *SubtaskTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "start_subtask",
		Description: "Spawn a sub-agent to handle a complex, multi-step task in isolation. Use this for research, heavy refactoring, or exploration to keep the main context clean. Returns a summary of the work done.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"goal": map[string]interface{}{
					"type":        "string",
					"description": "The specific goal for the sub-agent (e.g., 'Research grep implementation' or 'Fix bug in auth.go').",
				},
				"context": map[string]interface{}{
					"type":        "string",
					"description": "Any necessary context, file paths, or constraints the sub-agent needs to know.",
				},
				"role": map[string]interface{}{
					"type":        "string",
					"description": "Specialized role for the sub-agent: 'general', 'architect', 'qa', 'researcher'. Default: 'general'.",
					"enum":        []string{"general", "architect", "qa", "researcher"},
				},
			},
			"required": []string{"goal"},
		},
	}
}

func (t *SubtaskTool) Execute(ctx context.Context, input json.RawMessage) (string, error) {
	var args struct {
		Goal    string `json:"goal"`
		Context string `json:"context"`
		Role    string `json:"role"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return "", fmt.Errorf("invalid arguments: %v", err)
	}

	if t.Executor == nil {
		return "", fmt.Errorf("subtask executor not initialized")
	}

	// Retrieve Parent Session ID from context
	parentID, _ := ctx.Value("session_id").(string)
	if parentID == "" {
		// Log warning or default?
		// For now, allow empty, Controller handles it (root task).
	}

	return t.Executor.RunSubtask(ctx, parentID, args.Goal, args.Context, args.Role, nil, "")
}
