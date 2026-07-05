package workflow

import (
	"bufio"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

//go:embed bundled/*.md
var bundledWorkflowsFS embed.FS

// Workflow represents a user-defined automation workflow
type Workflow struct {
	Command            string          `json:"command"`     // e.g. "/release"
	Description        string          `json:"description"` // e.g. "Prepare release"
	Content            string          `json:"content"`     // Raw markdown content
	Version            string          `json:"version"`
	Name               string          `json:"name"`
	Risk               string          `json:"risk"`
	Inputs             []WorkflowInput `json:"inputs,omitempty"`
	Steps              []WorkflowStep  `json:"steps"`
	Verification       []string        `json:"verification"`
	ForbiddenActions   []string        `json:"forbidden_actions"`
	CompletionCriteria []string        `json:"completion_criteria"`
}

// Manager handles loading and retrieving workflows
type Manager struct {
	cwd       string
	mu        sync.RWMutex
	workflows map[string]Workflow
	Hooks     *HookManager
}

func NewManager(cwd string) *Manager {
	return &Manager{
		cwd:       cwd,
		workflows: make(map[string]Workflow),
		Hooks:     NewHookManager(cwd),
	}
}

// LoadWorkflows loads built-in workflows and project .agent/workflows/*.md overrides.
func (m *Manager) LoadWorkflows() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// reset
	m.workflows = make(map[string]Workflow)

	if err := m.loadBundledWorkflows(); err != nil {
		return err
	}

	workflowDir := filepath.Join(m.cwd, ".agent", "workflows")
	if _, err := os.Stat(workflowDir); os.IsNotExist(err) {
		return nil
	}

	return m.loadWorkflowDir(workflowDir, false)
}

func (m *Manager) loadBundledWorkflows() error {
	entries, err := bundledWorkflowsFS.ReadDir("bundled")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		path := filepath.Join("bundled", entry.Name())
		content, err := bundledWorkflowsFS.ReadFile(path)
		if err != nil {
			return err
		}
		wf, err := m.parseWorkflowContent(entry.Name(), content)
		if err != nil {
			return fmt.Errorf("parse bundled workflow %s: %w", entry.Name(), err)
		}
		m.workflows[wf.Command] = wf
	}
	return nil
}

func (m *Manager) loadWorkflowDir(workflowDir string, strict bool) error {
	entries, err := os.ReadDir(workflowDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}

		path := filepath.Join(workflowDir, entry.Name())
		wf, err := m.parseWorkflow(path)
		if err != nil {
			if strict {
				return err
			}
			// Log error but continue loading others
			fmt.Printf("Failed to parse workflow %s: %v\n", entry.Name(), err)
			continue
		}

		m.workflows[wf.Command] = wf
	}

	return nil
}

func (m *Manager) GetWorkflows() []Workflow {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var list []Workflow
	for _, wf := range m.workflows {
		list = append(list, wf)
	}
	return list
}

func (m *Manager) GetWorkflow(command string) (Workflow, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	wf, ok := m.workflows[command]
	return wf, ok
}

// parseWorkflow reads a markdown file and extracts v1 workflow metadata.
func (m *Manager) parseWorkflow(path string) (Workflow, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return Workflow{}, err
	}
	return m.parseWorkflowContent(filepath.Base(path), content)
}

func (m *Manager) parseWorkflowContent(filename string, content []byte) (Workflow, error) {
	basename := strings.TrimSuffix(filename, filepath.Ext(filename))
	command := "/" + basename

	wf := Workflow{
		Command: command,
		Content: string(content),
		Steps:   []WorkflowStep{},
	}

	if strings.Contains(wf.Content, " + \"`\" + ") {
		return Workflow{}, fmt.Errorf("contains broken template garbage")
	}

	// Parse Frontmatter
	scanner := bufio.NewScanner(strings.NewReader(string(content)))
	var frontmatter strings.Builder
	inFrontmatter := false
	lineNum := 0

	for scanner.Scan() {
		line := scanner.Text()
		lineNum++

		if lineNum == 1 && strings.TrimSpace(line) == "---" {
			inFrontmatter = true
			continue
		}

		if inFrontmatter {
			if strings.TrimSpace(line) == "---" {
				inFrontmatter = false
				break
			}
			frontmatter.WriteString(line + "\n")
		}
	}
	if inFrontmatter {
		return Workflow{}, fmt.Errorf("unterminated YAML frontmatter")
	}
	if strings.TrimSpace(frontmatter.String()) == "" {
		return Workflow{}, fmt.Errorf("missing YAML frontmatter")
	}

	// Unmarshal YAML frontmatter
	var def WorkflowDefinition
	if err := yaml.Unmarshal([]byte(frontmatter.String()), &def); err != nil {
		return Workflow{}, fmt.Errorf("parse YAML frontmatter for %s: %w", filename, err)
	}
	if err := validateWorkflowDefinition(basename, &def); err != nil {
		return Workflow{}, err
	}

	if def.Command != "" {
		command = def.Command
	}
	wf.Command = command
	wf.Name = def.Name
	wf.Description = def.Description
	wf.Version = def.Version
	wf.Risk = def.Risk
	wf.Inputs = def.Inputs
	wf.Steps = def.Steps
	wf.Verification = def.Verification
	wf.ForbiddenActions = def.ForbiddenActions
	wf.CompletionCriteria = def.CompletionCriteria

	return wf, nil
}

func validateWorkflowDefinition(basename string, def *WorkflowDefinition) error {
	if strings.TrimSpace(def.Name) == "" {
		return fmt.Errorf("workflow %s missing name", basename)
	}
	if strings.TrimSpace(def.Description) == "" {
		return fmt.Errorf("workflow %s missing description", basename)
	}
	if strings.TrimSpace(def.Version) != "1" {
		return fmt.Errorf("workflow %s must declare version: \"1\"", basename)
	}
	if strings.TrimSpace(def.Command) != "" && !strings.HasPrefix(strings.TrimSpace(def.Command), "/") {
		return fmt.Errorf("workflow %s command must start with /", basename)
	}
	if strings.TrimSpace(def.Risk) == "" {
		return fmt.Errorf("workflow %s missing risk", basename)
	}
	if len(def.Steps) == 0 {
		return fmt.Errorf("workflow %s must define at least one structured step", basename)
	}
	if len(def.Verification) == 0 {
		return fmt.Errorf("workflow %s missing verification criteria", basename)
	}
	if len(def.ForbiddenActions) == 0 {
		return fmt.Errorf("workflow %s missing forbidden_actions", basename)
	}
	if len(def.CompletionCriteria) == 0 {
		return fmt.Errorf("workflow %s missing completion_criteria", basename)
	}
	for i := range def.Steps {
		if err := validateWorkflowStep(basename, &def.Steps[i]); err != nil {
			return err
		}
	}
	return nil
}

func validateWorkflowStep(workflowName string, step *WorkflowStep) error {
	if strings.TrimSpace(step.ID) == "" {
		return fmt.Errorf("workflow %s has a step without id", workflowName)
	}
	stepType := strings.TrimSpace(step.Type)
	if stepType == "" {
		step.Type = "agent"
		stepType = "agent"
	}
	switch stepType {
	case "agent":
		if strings.TrimSpace(step.Action) == "" {
			return fmt.Errorf("workflow %s step %s missing action", workflowName, step.ID)
		}
	case "parallel":
		if len(step.Parallel) == 0 {
			return fmt.Errorf("workflow %s step %s has no parallel substeps", workflowName, step.ID)
		}
		for i := range step.Parallel {
			if err := validateWorkflowStep(workflowName, &step.Parallel[i]); err != nil {
				return err
			}
		}
	case "user_input":
		return fmt.Errorf("workflow %s step %s uses unsupported user_input step type", workflowName, step.ID)
	default:
		return fmt.Errorf("workflow %s step %s has unsupported type %q", workflowName, step.ID, step.Type)
	}
	return nil
}
