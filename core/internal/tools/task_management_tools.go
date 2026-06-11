package tools

// CreateTaskTool creates a new task in the Master Plan
var CreateTaskTool = ToolDefinition{
	Name:        "create_task",
	Description: "Create a new task in the Master Plan with title, description, priority, and dependencies.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"title": map[string]interface{}{
				"type":        "string",
				"description": "Title of the task",
			},
			"description": map[string]interface{}{
				"type":        "string",
				"description": "Detailed description of the task",
			},
			"priority": map[string]interface{}{
				"type":        "integer",
				"description": "Priority (0=low, 1=medium, 2=high, 3=critical)",
			},
			"dependencies": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "IDs of tasks that block this one",
			},
			"preconditions": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Commands or checks that must pass before starting (e.g., 'ls file.go', 'go test')",
			},
			"expected_outcome": map[string]interface{}{
				"type":        "string",
				"description": "A specific semantic anchor or result that the Auditor will verify (e.g., 'Test pass', 'File created')",
			},
		},
		"required": []string{"title", "priority"},
	},
}

// NextTaskTool gets the next runnable task
var NextTaskTool = ToolDefinition{
	Name:        "next_task",
	Description: "Get the next unblocked, highest-priority task to work on.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{},
	},
}

// CompleteTaskTool marks a task as done
var CompleteTaskTool = ToolDefinition{
	Name:        "complete_task",
	Description: "Mark a task as completed and set its result output summary.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"task_id": map[string]interface{}{
				"type":        "string",
				"description": "ID of the task to complete",
			},
			"output": map[string]interface{}{
				"type":        "string",
				"description": "Summary of the work done and results achieved",
			},
		},
		"required": []string{"task_id", "output"},
	},
}

// ListTasksTool lists tasks with optional filtering
var ListTasksTool = ToolDefinition{
	Name:        "list_tasks",
	Description: "List all tasks in the plan, optionally filtered by status or column.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"filter": map[string]interface{}{
				"type":        "string",
				"description": "Optional status or column filter (e.g., 'backlog', 'done')",
			},
		},
	},
}

// AddSubtaskTool adds a subtask to a task
var AddSubtaskTool = ToolDefinition{
	Name:        "add_subtask",
	Description: "Add a smaller subtask step to an existing major task.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"task_id": map[string]interface{}{
				"type":        "string",
				"description": "ID of the parent task",
			},
			"title": map[string]interface{}{
				"type":        "string",
				"description": "Title of the subtask",
			},
		},
		"required": []string{"task_id", "title"},
	},
}

// DeleteTaskTool removes a task
var DeleteTaskTool = ToolDefinition{
	Name:        "delete_task",
	Description: "Remove a task from the plan entirely. Use this if a goal is no longer relevant.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"task_id": map[string]interface{}{
				"type":        "string",
				"description": "ID of the task to delete",
			},
		},
		"required": []string{"task_id"},
	},
}

// UpdateTaskTool updates task metadata
var UpdateTaskTool = ToolDefinition{
	Name:        "update_task",
	Description: "Update the title, description, or priority of an existing task.",
	InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"task_id": map[string]interface{}{
				"type":        "string",
				"description": "ID of the task to update",
			},
			"title": map[string]interface{}{
				"type":        "string",
				"description": "New title for the task (optional)",
			},
			"description": map[string]interface{}{
				"type":        "string",
				"description": "New description for the task (optional)",
			},
			"priority": map[string]interface{}{
				"type":        "integer",
				"description": "New priority (optional)",
			},
			"preconditions": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "New preconditions (optional)",
			},
			"expected_outcome": map[string]interface{}{
				"type":        "string",
				"description": "New expected outcome (optional)",
			},
		},
		"required": []string{"task_id"},
	},
}
