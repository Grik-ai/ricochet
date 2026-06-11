package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/tools"
)

// CreateTaskToolImpl implements create_task logic
type CreateTaskToolImpl struct {
	Plan   *PlanManager
	Events *EventEmitter
}

func (t *CreateTaskToolImpl) Definition() protocol.Tool {
	def := tools.CreateTaskTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *CreateTaskToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		Title        string   `json:"title"`
		Description  string   `json:"description"`
		Priority     int      `json:"priority"`
		Dependencies    []string `json:"dependencies"`
		Preconditions   []string `json:"preconditions"`
		ExpectedOutcome string   `json:"expected_outcome"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	id, err := t.Plan.CreateTask(input.Title, input.Description, input.Priority, input.Dependencies, input.Preconditions, input.ExpectedOutcome)
	if err != nil {
		return "", err
	}

	// Emit EventTaskStarted
	if t.Events != nil {
		t.Events.Emit(Event{
			Type: EventTaskStarted,
			Payload: map[string]interface{}{
				"id":    id,
				"title": input.Title,
			},
		})
	}

	return fmt.Sprintf("✅ Task created with ID: %s", id), nil
}

// NextTaskToolImpl implements next_task logic
type NextTaskToolImpl struct {
	Plan *PlanManager
}

func (t *NextTaskToolImpl) Definition() protocol.Tool {
	def := tools.NextTaskTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *NextTaskToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	task, err := t.Plan.GetNextTask()
	if err != nil {
		return "No runnable tasks found in the plan. Consider creating one or updating dependencies.", nil
	}

	res, _ := json.MarshalIndent(task, "", "  ")
	return fmt.Sprintf("Next recommended task:\n%s", string(res)), nil
}

// CompleteTaskToolImpl implements complete_task logic
type CompleteTaskToolImpl struct {
	Plan     *PlanManager
	Events   *EventEmitter
	Provider Provider
	Model    string
}

func (t *CompleteTaskToolImpl) Definition() protocol.Tool {
	def := tools.CompleteTaskTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *CompleteTaskToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		TaskID string `json:"task_id"`
		Output string `json:"output"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	// Fetch task details before completion for the event
	var taskTitle string
	tasks := t.Plan.ListTasks("")
	for _, task := range tasks {
		if task.ID == input.TaskID {
			taskTitle = task.Title
			break
		}
	}

	if err := t.Plan.CompleteTask(input.TaskID, input.Output); err != nil {
		return "", err
	}

	// Summarize output if it's long
	summary := input.Output
	if len(summary) > 500 && t.Provider != nil {
		req := &ChatRequest{
			Model: t.Model,
			Messages: []protocol.Message{
				{Role: "system", Content: "Summarize the technical output of the completed task into 2-3 concise sentences for a Telegram notification. Focus on what was achieved."},
				{Role: "user", Content: input.Output},
			},
		}
		resp, err := t.Provider.Chat(ctx, req)
		if err == nil {
			summary = resp.Content
		} else {
			log.Printf("Warning: Failed to summarize task output: %v", err)
		}
	}

	// Emit EventTaskFinished
	if t.Events != nil {
		t.Events.Emit(Event{
			Type: EventTaskFinished,
			Payload: map[string]interface{}{
				"id":      input.TaskID,
				"title":   taskTitle,
				"summary": summary,
			},
		})
	}

	return fmt.Sprintf("✅ Task %s marked as complete.", input.TaskID), nil
}

// ... (remaining tools)

// ListTasksToolImpl implements list_tasks logic
type ListTasksToolImpl struct {
	Plan *PlanManager
}

func (t *ListTasksToolImpl) Definition() protocol.Tool {
	def := tools.ListTasksTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *ListTasksToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		Filter string `json:"filter"`
	}
	_ = json.Unmarshal(args, &input)

	tasks := t.Plan.ListTasks(input.Filter)
	res, _ := json.MarshalIndent(tasks, "", "  ")
	return fmt.Sprintf("Current tasks (Filter: %s):\n%s", input.Filter, string(res)), nil
}

// AddSubtaskToolImpl implements add_subtask logic
type AddSubtaskToolImpl struct {
	Plan *PlanManager
}

func (t *AddSubtaskToolImpl) Definition() protocol.Tool {
	def := tools.AddSubtaskTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *AddSubtaskToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		TaskID string `json:"task_id"`
		Title  string `json:"title"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := t.Plan.AddSubtask(input.TaskID, input.Title); err != nil {
		return "", err
	}
	return fmt.Sprintf("✅ Subtask '%s' added to parent task %s.", input.Title, input.TaskID), nil
}

// DeleteTaskToolImpl implements delete_task logic
type DeleteTaskToolImpl struct {
	Plan *PlanManager
}

func (t *DeleteTaskToolImpl) Definition() protocol.Tool {
	def := tools.DeleteTaskTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *DeleteTaskToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := t.Plan.DeleteTask(input.TaskID); err != nil {
		return "", err
	}
	return fmt.Sprintf("✅ Task %s deleted.", input.TaskID), nil
}

// UpdateTaskToolImpl implements update_task logic
type UpdateTaskToolImpl struct {
	Plan *PlanManager
}

func (t *UpdateTaskToolImpl) Definition() protocol.Tool {
	def := tools.UpdateTaskTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *UpdateTaskToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		TaskID      string `json:"task_id"`
		Title       string `json:"title"`
		Description string `json:"description"`
		Priority        *int     `json:"priority"`
		Preconditions   []string `json:"preconditions"`
		ExpectedOutcome string   `json:"expected_outcome"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	// Fetch existing values if not provided
	existing := t.Plan.ListTasks("")
	var task *TaskItem
	for _, it := range existing {
		if it.ID == input.TaskID {
			task = &it
			break
		}
	}
	if task == nil {
		return "", fmt.Errorf("task %s not found", input.TaskID)
	}

	title := input.Title
	if title == "" {
		title = task.Title
	}
	desc := input.Description
	if desc == "" {
		desc = task.Description
	}
	prio := task.Priority
	if input.Priority != nil {
		prio = *input.Priority
	}

	preconditions := input.Preconditions
	if preconditions == nil {
		preconditions = task.Preconditions
	}
	expectedOutcome := input.ExpectedOutcome
	if expectedOutcome == "" {
		expectedOutcome = task.ExpectedOutcome
	}

	if err := t.Plan.UpdateTask(input.TaskID, title, desc, prio, preconditions, expectedOutcome); err != nil {
		return "", err
	}
	return fmt.Sprintf("✅ Task %s updated.", input.TaskID), nil
}
