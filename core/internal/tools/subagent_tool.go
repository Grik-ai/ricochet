package tools

import (
	"context"
	"encoding/json"
	"fmt"
)

// SubagentTool allows the agent to delegate work to a child agent.
type SubagentTool struct {
	executor *NativeExecutor
}

type subagentArgs struct {
	Description string `json:"description"` // For TUI/logs
	Prompt      string `json:"prompt"`      // Task for the worker
	ParentID    string `json:"parent_id,omitempty"`
}

// Execute spawns a background worker
func (t *SubagentTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var payload subagentArgs
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if payload.Prompt == "" {
		return "", fmt.Errorf("prompt is required")
	}

	if payload.Description == "" {
		payload.Description = "Subtask delegation"
	}

	// Delegate to Controller's SwarmOrchestrator
	// We need to access sub-services from the executor's host or controller reference.
	// NativeExecutor doesn't have a direct Swarm pointer, but the Controller (which implements ToolExecutor) does.

	// This tool will be handled by the Controller's dispatcher.
	return "DELEGATED_TO_CONTROLLER", nil
}
