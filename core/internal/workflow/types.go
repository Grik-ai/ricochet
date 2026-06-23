package workflow

// WorkflowDefinition represents the structured definition of a workflow
type WorkflowDefinition struct {
	Name               string          `json:"name" yaml:"name"`
	Description        string          `json:"description" yaml:"description"`
	Version            string          `json:"version" yaml:"version"`
	Command            string          `json:"command,omitempty" yaml:"command,omitempty"`
	Risk               string          `json:"risk" yaml:"risk"`
	Inputs             []WorkflowInput `json:"inputs,omitempty" yaml:"inputs,omitempty"`
	Steps              []WorkflowStep  `json:"steps" yaml:"steps"`
	Verification       []string        `json:"verification" yaml:"verification"`
	ForbiddenActions   []string        `json:"forbidden_actions" yaml:"forbidden_actions"`
	CompletionCriteria []string        `json:"completion_criteria" yaml:"completion_criteria"`
}

// WorkflowInput documents a user-provided workflow variable.
type WorkflowInput struct {
	Name        string `json:"name" yaml:"name"`
	Description string `json:"description" yaml:"description"`
	Required    bool   `json:"required" yaml:"required"`
}

// WorkflowStep represents a single unit of work in the orchestration engine
type WorkflowStep struct {
	ID                    string         `json:"id" yaml:"id"`
	Description           string         `json:"description" yaml:"description"`
	Action                string         `json:"action" yaml:"action"` // Prompt for the agent
	Type                  string         `json:"type" yaml:"type"`     // "agent", "user_input", "parallel"
	Interactive           bool           `json:"interactive" yaml:"interactive"`
	Parallel              []WorkflowStep `json:"parallel" yaml:"parallel"`
	Timeout               int            `json:"timeout" yaml:"timeout"`
	AllowCommandInjection bool           `json:"allow_command_injection" yaml:"allow_command_injection"`
}

// ExecutionContext holds the runtime state of a workflow execution
type ExecutionContext struct {
	WorkflowID string                 `json:"workflow_id"`
	Variables  map[string]interface{} `json:"variables"`
	History    []StepResult           `json:"history"`
}

// StepResult captures the output of a step
type StepResult struct {
	StepID  string      `json:"step_id"`
	Output  string      `json:"output"`
	Status  string      `json:"status"` // "success", "failed", "skipped"
	Context interface{} `json:"context,omitempty"`
}
