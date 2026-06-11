package tools

// TaskBoundaryTool updates the current task state following the Antigravity pattern
var TaskBoundaryTool = ToolDefinition{
	Name:        "task_boundary",
	Description: "Update the current task state (Mode, Name, Status, Summary). This tool controls the UI progress card and synchronizes the agent's internal state with the user's view.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"TaskName": map[string]interface{}{
				"type":        "string",
				"description": "Name of the current major task (e.g., 'Implementing Auth')",
			},
			"Mode": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"PLANNING", "EXECUTION", "VERIFICATION"},
				"description": "The current phase of work",
			},
			"TaskSummary": map[string]interface{}{
				"type":        "string",
				"description": "Concise summary of what has been accomplished so far",
			},
			"TaskStatus": map[string]interface{}{
				"type":        "string",
				"description": "What you are about to do next (displayed as active status)",
			},
			"PredictedTaskSize": map[string]interface{}{
				"type":        "integer",
				"description": "Estimated remaining tool calls for this task",
			},
		},
		"required": []string{"TaskName", "Mode", "TaskSummary", "TaskStatus", "PredictedTaskSize"},
	},
}

// UpdatePlanTool updates the persistent task list (PlanManager)
var UpdatePlanTool = ToolDefinition{
	Name:        "update_plan",
	Description: "Update the status of a task in the Master Plan. Use this to mark tasks as 'active' or 'done', and set dependencies.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"task_id": map[string]interface{}{
				"type":        "string",
				"description": "The ID of the task to update (e.g. '1', '2')",
			},
			"status": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"pending", "active", "done", "failed"},
				"description": "The new status of the task",
			},
			"dependencies": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "List of task IDs that must complete before this task starts.",
			},
		},
		"required": []string{"task_id", "status"},
	},
}

var StartSwarmTool = ToolDefinition{
	Name:        "start_swarm",
	Description: "REQUIRED: Activate Swarm Mode. Use THIS TOOL to actually spawn background sub-agents. If the Master Plan has runnable tasks, this starts workers for them in parallel; otherwise it starts a default multi-agent project-analysis swarm.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"confirm": map[string]interface{}{
				"type":        "boolean",
				"description": "Set to true to confirm swarm activation.",
			},
			"goal": map[string]interface{}{
				"type":        "string",
				"description": "Optional concise user goal for the swarm when no runnable Master Plan tasks exist.",
			},
			"min_workers": map[string]interface{}{
				"type":        "integer",
				"description": "Optional minimum number of specialized workers to launch for deep analysis.",
			},
			"depth": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"fast", "deep"},
				"description": "Optional swarm depth. Default is fast: one bounded read-only worker. Deep queues multiple workers and may run longer.",
			},
		},
		"required": []string{"confirm"},
	},
}
