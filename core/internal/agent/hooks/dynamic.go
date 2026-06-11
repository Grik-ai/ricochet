package hooks

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// DynamicHookConfig represents the structure of a hook rule file
type DynamicHookConfig struct {
	Name       string      `yaml:"name"`
	Enabled    bool        `yaml:"enabled"`
	Event      string      `yaml:"event"`
	Action     string      `yaml:"action"`  // warn, block
	Matcher    string      `yaml:"matcher"` // Bash, Write, Edit, or tool name
	Pattern    string      `yaml:"pattern"`
	Conditions []Condition `yaml:"conditions"`
	Message    string      `yaml:"message"` // Detailed message to show
	Script     string      `yaml:"script"`  // Path to executable script
}

type Condition struct {
	Field    string `yaml:"field"`
	Operator string `yaml:"operator"` // regex_match, contains, etc
	Pattern  string `yaml:"pattern"`
}

type DynamicHookManager struct {
	hooks []DynamicHookConfig
	cwd   string
}

// Event constants matching Claude Code for interoperability
const (
	EventPreToolUse      = "PreToolUse"
	EventPostToolUse     = "PostToolUse"
	EventTaskCompleted   = "TaskCompleted"
	EventFileChanged     = "FileChanged"
	EventCwdChanged      = "CwdChanged"
	EventTaskCreated     = "TaskCreated"
	EventStop            = "Stop" // Deprecated in favor of TaskCompleted
)

func NewDynamicHookManager(cwd string) *DynamicHookManager {
	return &DynamicHookManager{
		cwd: cwd,
	}
}

func (m *DynamicHookManager) LoadHooks() error {
	hooksDir := filepath.Join(m.cwd, ".ricochet", "hooks")
	if _, err := os.Stat(hooksDir); os.IsNotExist(err) {
		return nil
	}

	entries, err := os.ReadDir(hooksDir)
	if err != nil {
		return err
	}

	m.hooks = []DynamicHookConfig{}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		// Support .yaml and .md (with frontmatter)
		if strings.HasSuffix(entry.Name(), ".yaml") || strings.HasSuffix(entry.Name(), ".yml") || strings.HasSuffix(entry.Name(), ".md") {
			path := filepath.Join(hooksDir, entry.Name())
			hookList, err := m.loadHookFile(path)
			if err != nil {
				fmt.Printf("Error loading hook %s: %v\n", entry.Name(), err)
				continue
			}
			for _, h := range hookList {
				if h.Enabled {
					m.hooks = append(m.hooks, h)
				}
			}
		}
	}
	return nil
}

func (m *DynamicHookManager) loadHookFile(path string) ([]DynamicHookConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var yamlContent []byte
	var bodyMessage string

	if strings.HasSuffix(path, ".md") {
		// Parse frontmatter
		contentStr := string(data)
		if strings.HasPrefix(contentStr, "---\n") {
			parts := strings.SplitN(contentStr, "---\n", 3)
			if len(parts) >= 3 {
				yamlContent = []byte(parts[1])
				bodyMessage = strings.TrimSpace(parts[2])
			}
		}
	} else {
		yamlContent = data
	}

	if len(yamlContent) == 0 {
		return nil, nil
	}

	// Try unmarshaling as a list first
	var list []DynamicHookConfig
	if err := yaml.Unmarshal(yamlContent, &list); err == nil && len(list) > 0 {
		// If it's an MD file, apply the body message to each if they don't have one
		for i := range list {
			if list[i].Message == "" && bodyMessage != "" {
				list[i].Message = bodyMessage
			}
		}
		return list, nil
	}

	// Try unmarshaling as a single object
	var single DynamicHookConfig
	if err := yaml.Unmarshal(yamlContent, &single); err != nil {
		return nil, err
	}

	if single.Message == "" && bodyMessage != "" {
		single.Message = bodyMessage
	}

	return []DynamicHookConfig{single}, nil
}

// ListHooks returns all currently loaded and enabled hooks
func (m *DynamicHookManager) ListHooks() []DynamicHookConfig {
	return m.hooks
}

// TriggerHooks is the universal entry point for lifecycle events.
// It executes matching hooks and returns a consolidated warning message or a blocking error.
func (m *DynamicHookManager) TriggerHooks(ctx context.Context, event string, args map[string]interface{}) (string, error) {
	// Re-load hooks to ensure we pick up changes without restarting
	_ = m.LoadHooks()

	var warnings []string

	for _, hook := range m.hooks {
		// 1. Event Matching
		if !m.eventMatches(hook, event, args) {
			continue
		}

		// 2. Logic-based Matching (Pattern/Conditions) - only for block/warn actions
		if hook.Pattern != "" || len(hook.Conditions) > 0 {
			matched := m.evaluateConditions(hook, args)
			if matched {
				if hook.Action == "block" {
					return "", fmt.Errorf("Hook '%s' blocked execution: %s", hook.Name, hook.Message)
				}
				if hook.Action == "warn" {
					warnings = append(warnings, fmt.Sprintf("Hook Warning (%s): %s", hook.Name, hook.Message))
				}
			}
		}

		// 3. Script-based Matching
		if hook.Script != "" {
			msg, err := m.executeHookScript(ctx, hook, event, args)
			if err != nil {
				return "", err // Return blocking error (Exit 2)
			}
			if msg != "" {
				warnings = append(warnings, msg)
			}
		}
	}

	if len(warnings) > 0 {
		return strings.Join(warnings, "\n"), nil
	}
	return "", nil
}

// CheckPreToolUse maintains backward compatibility for existing controller calls
func (m *DynamicHookManager) CheckPreToolUse(ctx context.Context, toolName string, args map[string]interface{}) (string, error) {
	// Map internal tool name to event data
	payload := make(map[string]interface{})
	for k, v := range args {
		payload[k] = v
	}
	payload["tool"] = toolName

	return m.TriggerHooks(ctx, EventPreToolUse, payload)
}

func (m *DynamicHookManager) eventMatches(hook DynamicHookConfig, event string, args map[string]interface{}) bool {
	// 1. Check Event
	if hook.Event != "all" && hook.Event != event {
		return false
	}

	// 2. Check Matcher (if specified)
	if hook.Matcher == "" || hook.Matcher == "*" {
		return true
	}

	toolName, _ := args["tool"].(string)

	// Built-in Matchers (Claude Style)
	switch strings.ToLower(hook.Matcher) {
	case "bash":
		return toolName == "execute_command" || toolName == "run_command"
	case "write":
		return toolName == "write_file" || toolName == "write_to_file"
	case "edit":
		return toolName == "replace_file_content" || toolName == "edit_file" || toolName == "apply_diff"
	case "file":
		return toolName == "write_file" || toolName == "write_to_file" || toolName == "replace_file_content" || toolName == "read_file" || toolName == "view_file"
	default:
		// Exact tool name match
		return strings.EqualFold(toolName, hook.Matcher)
	}
}

func (m *DynamicHookManager) evaluateConditions(hook DynamicHookConfig, args map[string]interface{}) bool {
	toolName, _ := args["tool"].(string)

	matched := false
	if hook.Pattern != "" {
		if toolName == "execute_command" {
			if cmd, ok := args["command"].(string); ok {
				if ruleMatches(cmd, "regex_match", hook.Pattern) {
					matched = true
				}
			}
		}
	}

	// check conditions
	for _, cond := range hook.Conditions {
		val := getFieldVal(toolName, args, cond.Field)
		if ruleMatches(val, cond.Operator, cond.Pattern) {
			matched = true
		} else {
			return false // All conditions must match
		}
	}
	return matched
}

func (m *DynamicHookManager) executeHookScript(ctx context.Context, hook DynamicHookConfig, event string, args map[string]interface{}) (string, error) {
	scriptPath := hook.Script
	if !filepath.IsAbs(scriptPath) {
		scriptPath = filepath.Join(m.cwd, scriptPath)
	}

	payload := map[string]interface{}{
		"event": event,
		"tool":  args["tool"],
		"input": args,
	}
	jsonData, _ := json.Marshal(payload)

	cmd := exec.CommandContext(ctx, scriptPath)
	cmd.Stdin = strings.NewReader(string(jsonData))
	cmd.Dir = m.cwd

	var stdErr strings.Builder
	cmd.Stderr = &stdErr
	var stdOut strings.Builder
	cmd.Stdout = &stdOut

	err := cmd.Run()
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			// exit 2 is blocking
			if exitError.ExitCode() == 2 {
				return "", fmt.Errorf("Hook '%s' (Script) BLOCKED execution: %s", hook.Name, strings.TrimSpace(stdErr.String()))
			}
			// other exit codes are treated as warnings
			return fmt.Sprintf("Hook Warning (%s Script): %s", hook.Name, strings.TrimSpace(stdErr.String())), nil
		}
		return "", fmt.Errorf("failed to execute hook script: %w", err)
	}

	return strings.TrimSpace(stdOut.String()), nil
}

func getFieldVal(_ string, args map[string]interface{}, field string) string {
	// Map conceptual fields to actual args
	if field == "command" {
		if v, ok := args["command"].(string); ok {
			return v
		}
		if v, ok := args["CommandLine"].(string); ok {
			return v
		}
	}
	if field == "file_path" {
		if v, ok := args["file_path"].(string); ok {
			return v
		}
		if v, ok := args["TargetFile"].(string); ok {
			return v
		}
		if v, ok := args["AbsolutePath"].(string); ok {
			return v
		}
	}
	return ""
}

func ruleMatches(val string, op string, pattern string) bool {
	switch op {
	case "contains":
		return strings.Contains(val, pattern)
	case "regex_match":
		r, err := regexp.Compile(pattern)
		if err != nil {
			return false
		}
		return r.MatchString(val)
	default: // default to regex
		r, err := regexp.Compile(pattern)
		if err != nil {
			return false
		}
		return r.MatchString(val)
	}
}
