package agent

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// SubTask represents a smaller step within a major task
type SubTask struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"` // "pending", "done"
}

// TaskItem represents a single step in the agent's plan
type TaskItem struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	Description     string    `json:"description,omitempty"`
	Status          string    `json:"status"`                 // "pending", "active", "done", "failed"
	Priority        int       `json:"priority"`               // 0=low, 1=medium, 2=high, 3=critical
	Column          string    `json:"column,omitempty"`       // backlog, in_progress, review, done, deferred
	Dependencies    []string  `json:"dependencies,omitempty"` // IDs of tasks that block this one
	Subtasks        []SubTask `json:"subtasks,omitempty"`
	AssignedTo      string    `json:"assigned_to,omitempty"` // agent ID or "user"
	ExternalID      string    `json:"external_id,omitempty"` // YouTrack/Notion ID
	ExternalURL     string    `json:"external_url,omitempty"`
	CreatedBy       string    `json:"created_by,omitempty"` // "agent" or "user"
	Context         string    `json:"context,omitempty"`
	Output          string    `json:"output,omitempty"`
	Preconditions   []string  `json:"preconditions,omitempty"`    // Commands or checks that must pass
	ExpectedOutcome string    `json:"expected_outcome,omitempty"` // Semantic anchor for the auditor
	RetryCount      int       `json:"retry_count"`
	MaxRetries      int       `json:"max_retries"`
	TimeoutSeconds  int       `json:"timeout_seconds"` // 0 = no timeout
}

// PlanManager handles the agent's long-term plan
type PlanManager struct {
	mu        sync.RWMutex
	Tasks     []TaskItem `json:"tasks"`
	Cwd       string     `json:"-"`
	FilePath  string     `json:"-"`
	OnChanged func()     `json:"-"`
}

// NewPlanManager creates a new plan manager associated with a specific directory
func NewPlanManager(cwd string) *PlanManager {
	return &PlanManager{
		Tasks: make([]TaskItem, 0),
		Cwd:   cwd,
		// Default to legacy path until Session ID is set
		FilePath: filepath.Join(cwd, "task_plan.json"),
	}
}

// SetSessionID scopes the plan to a specific session
func (pm *PlanManager) SetSessionID(sessionID string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	// New Path: .ricochet/sessions/{sessionID}/plan.json
	sessionDir := filepath.Join(os.Getenv("HOME"), ".ricochet", "sessions", sessionID)
	if err := os.MkdirAll(sessionDir, 0755); err != nil {
		return fmt.Errorf("failed to create session dir: %w", err)
	}

	pm.FilePath = filepath.Join(sessionDir, "plan.json")

	// Reset tasks (Clean Slate) because we are switching to a specific session context
	// Unless the file already exists (Resume case)
	pm.Tasks = make([]TaskItem, 0)

	// Try loading if exists
	if _, err := os.Stat(pm.FilePath); err == nil {
		data, err := os.ReadFile(pm.FilePath)
		if err == nil {
			json.Unmarshal(data, &pm.Tasks)
			log.Printf("[Plan] Loaded existing session plan: %s", pm.FilePath)
		}
	} else {
		log.Printf("[Plan] Initialized fresh plan for session: %s", sessionID)
	}

	return nil
}

// Load reads the plan from disk
func (pm *PlanManager) Load() error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	data, err := os.ReadFile(pm.FilePath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("[Plan] No existing plan found at %s", pm.FilePath)
			return nil // No plan yet
		}
		return err
	}

	log.Printf("[Plan] Loaded plan from %s (%d bytes)", pm.FilePath, len(data))
	return json.Unmarshal(data, &pm.Tasks)
}

// Save writes the plan to disk
func (pm *PlanManager) Save() error {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	return pm.saveInternal()
}

// saveInternal writes to disk without locking (caller must hold lock)
func (pm *PlanManager) saveInternal() error {
	data, err := json.MarshalIndent(pm.Tasks, "", "  ")
	if err != nil {
		return err
	}
	err = os.WriteFile(pm.FilePath, data, 0644)
	if err != nil {
		log.Printf("[Plan] Failed to save plan to %s: %v", pm.FilePath, err)
		return err
	}
	log.Printf("[Plan] Saved plan to %s (%d tasks)", pm.FilePath, len(pm.Tasks))
	if pm.OnChanged != nil {
		pm.OnChanged()
	}
	return nil
}

// GenerateContext creates the pinned context string for the system prompt
func (pm *PlanManager) GenerateContext() string {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	if len(pm.Tasks) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("\n=== 🧭 MASTER PLAN (AUTONOMOUS MODE) ===\n")

	for _, task := range pm.Tasks {
		icon := "[ ]"
		suffix := ""

		switch task.Status {
		case "done", "completed":
			icon = "[x]"
		case "active", "in_progress":
			icon = "[>]"
			suffix = " (CURRENT FOCUS)"
		case "failed":
			icon = "[!]"
		}

		desc := ""
		if task.Description != "" {
			firstLine := strings.Split(task.Description, "\n")[0]
			if len(firstLine) > 60 {
				firstLine = firstLine[:57] + "..."
			}
			desc = fmt.Sprintf(" - %s", firstLine)
		}

		priorityStr := ""
		if task.Priority > 1 {
			priorityStr = " [HIGH]"
		}

		sb.WriteString(fmt.Sprintf("%s %s. %s%s%s%s\n", icon, task.ID, task.Title, desc, suffix, priorityStr))
	}
	sb.WriteString("========================================\n")

	return sb.String()
}

// UpdateTaskStatus updates the status of a specific task
func (pm *PlanManager) UpdateTaskStatus(id string, status string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	found := false
	for i, task := range pm.Tasks {
		if task.ID == id {
			pm.Tasks[i].Status = status
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("task ID '%s' not found", id)
	}

	return pm.saveInternal()
}

// SetDependencies updates the dependencies for a specific task
func (pm *PlanManager) SetDependencies(id string, dependencies []string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	found := false
	for i, task := range pm.Tasks {
		if task.ID == id {
			pm.Tasks[i].Dependencies = dependencies
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("task ID '%s' not found", id)
	}

	return pm.saveInternal()
}

// SetPlan replaces the entire plan
func (pm *PlanManager) SetPlan(tasks []TaskItem) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.Tasks = tasks
	return pm.saveInternal()
}

// AddTask adds a new task to the plan
func (pm *PlanManager) AddTask(title string, contextInfo string) (string, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	id := fmt.Sprintf("%d", len(pm.Tasks)+1)
	newTask := TaskItem{
		ID:      id,
		Title:   title,
		Status:  "pending",
		Context: contextInfo,
	}

	pm.Tasks = append(pm.Tasks, newTask)
	return id, pm.saveInternal()
}

// RemoveTask removes a task from the plan by ID
func (pm *PlanManager) RemoveTask(id string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	newTasks := make([]TaskItem, 0, len(pm.Tasks))
	found := false
	for _, task := range pm.Tasks {
		if task.ID == id {
			found = true
			continue
		}
		newTasks = append(newTasks, task)
	}

	if !found {
		return fmt.Errorf("task ID '%s' not found", id)
	}

	pm.Tasks = newTasks
	// Re-assign IDs to maintain sequence
	for i := range pm.Tasks {
		pm.Tasks[i].ID = fmt.Sprintf("%d", i+1)
	}

	return pm.saveInternal()
}

// GetTasks safely returns the current list of tasks
func (pm *PlanManager) GetTasks() []TaskItem {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	// Return a copy to avoid race conditions on slice
	tasks := make([]TaskItem, len(pm.Tasks))
	copy(tasks, pm.Tasks)
	return tasks
}

// CreateTask adds a new task to the plan with more details
func (pm *PlanManager) CreateTask(title, description string, priority int, dependencies []string, preconditions []string, expectedOutcome string) (string, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	id := fmt.Sprintf("%d", len(pm.Tasks)+1)
	newTask := TaskItem{
		ID:              id,
		Title:           title,
		Description:     description,
		Status:          "pending",
		Priority:        priority,
		Column:          "backlog",
		Dependencies:    dependencies,
		CreatedBy:       "agent",
		Preconditions:   preconditions,
		ExpectedOutcome: expectedOutcome,
	}

	pm.Tasks = append(pm.Tasks, newTask)
	return id, pm.saveInternal()
}

// GetNextTask returns the highest priority unblocked task
func (pm *PlanManager) GetNextTask() (*TaskItem, error) {
	runnable := pm.GetRunnableTasks()
	if len(runnable) == 0 {
		return nil, fmt.Errorf("no runnable tasks found")
	}
	// runnable is already sorted by priority in GetRunnableTasks()
	return &runnable[0], nil
}

// CompleteTask marks a task as done and sets its output
func (pm *PlanManager) CompleteTask(id, output string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for i, t := range pm.Tasks {
		if t.ID == id {
			pm.Tasks[i].Status = "done"
			pm.Tasks[i].Column = "done"
			pm.Tasks[i].Output = output
			return pm.saveInternal()
		}
	}
	return fmt.Errorf("task %s not found", id)
}

// AddSubtask adds a subtask to an existing task
func (pm *PlanManager) AddSubtask(taskID, title string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for i, t := range pm.Tasks {
		if t.ID == taskID {
			subID := fmt.Sprintf("%s.%d", taskID, len(t.Subtasks)+1)
			pm.Tasks[i].Subtasks = append(pm.Tasks[i].Subtasks, SubTask{
				ID:     subID,
				Title:  title,
				Status: "pending",
			})
			return pm.saveInternal()
		}
	}
	return fmt.Errorf("parent task %s not found", taskID)
}

// ListTasks returns tasks filtered by status or column
func (pm *PlanManager) ListTasks(filter string) []TaskItem {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	if filter == "" {
		return pm.GetTasks()
	}

	var filtered []TaskItem
	for _, t := range pm.Tasks {
		if t.Status == filter || t.Column == filter {
			filtered = append(filtered, t)
		}
	}
	return filtered
}

// SetColumn moves a task to a different Kanban column
func (pm *PlanManager) SetColumn(id, column string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for i, t := range pm.Tasks {
		if t.ID == id {
			pm.Tasks[i].Column = column
			// Also sync status if moving to done
			switch column {
			case "done":
				pm.Tasks[i].Status = "done"
			case "in_progress":
				pm.Tasks[i].Status = "active"
			}
			return pm.saveInternal()
		}
	}
	return fmt.Errorf("task %s not found", id)
}

// DeleteTask removes a task from the plan
func (pm *PlanManager) DeleteTask(id string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	idx := -1
	for i, t := range pm.Tasks {
		if t.ID == id {
			idx = i
			break
		}
	}

	if idx == -1 {
		return fmt.Errorf("task %s not found", id)
	}

	pm.Tasks = append(pm.Tasks[:idx], pm.Tasks[idx+1:]...)
	return pm.saveInternal()
}

// UpdateTask updates basic task metadata
func (pm *PlanManager) UpdateTask(id, title, description string, priority int, preconditions []string, expectedOutcome string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for i, t := range pm.Tasks {
		if t.ID == id {
			pm.Tasks[i].Title = title
			pm.Tasks[i].Description = description
			pm.Tasks[i].Priority = priority
			pm.Tasks[i].Preconditions = preconditions
			pm.Tasks[i].ExpectedOutcome = expectedOutcome
			return pm.saveInternal()
		}
	}
	return fmt.Errorf("task %s not found", id)
}
