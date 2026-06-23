package skills

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
	"gopkg.in/yaml.v3"
)

// SkillRule defines when to trigger a specific skill
type SkillRule struct {
	Name               string        `json:"name"`
	DisplayName        string        `json:"display_name,omitempty"`
	Type               string        `json:"type"`
	Enforcement        string        `json:"enforcement"` // suggest, force
	Priority           string        `json:"priority"`
	PromptTriggers     TriggerConfig `json:"promptTriggers"`
	FileTriggers       TriggerConfig `json:"fileTriggers"`
	Content            string        `json:"-"`
	ContentPath        string        `json:"content_path,omitempty"`
	Description        string        `json:"description,omitempty"`
	WhenToUse          string        `json:"when_to_use,omitempty"`
	ArgumentHint       string        `json:"argument_hint,omitempty"`
	ArgumentNames      []string      `json:"argument_names,omitempty"`
	AllowedTools       []string      `json:"allowedTools,omitempty"`
	Model              string        `json:"model,omitempty"`
	Effort             string        `json:"effort,omitempty"`
	ExecutionContext   string        `json:"context,omitempty"` // inline, fork
	Source             string        `json:"source,omitempty"`
	Enabled            bool          `json:"enabled"`
	enabledConfigured  bool          `json:"-"`
	UserInvocable      bool          `json:"user_invocable,omitempty"`
	Author             string        `json:"author,omitempty"`
	Version            string        `json:"version,omitempty"`
	Icon               string        `json:"icon,omitempty"`
	DocumentationURL   string        `json:"documentation_url,omitempty"`
	LoadStatus         string        `json:"load_status,omitempty"`
	ValidationErrors   []string      `json:"validation_errors,omitempty"`
	Scope              string        `json:"scope,omitempty"`
	Visibility         string        `json:"visibility,omitempty"`
	ImplicitInvocation bool          `json:"implicit_invocation,omitempty"`
}

type TriggerConfig struct {
	Keywords        []string `json:"keywords,omitempty"`
	IntentPatterns  []string `json:"intentPatterns,omitempty"`
	PathPatterns    []string `json:"pathPatterns,omitempty"`
	ContentPatterns []string `json:"contentPatterns,omitempty"`
}

type Manager struct {
	mu     sync.RWMutex
	cwd    string
	skills map[string]*SkillRule
	scopes map[string]SkillScope
}

type SkillOverride struct {
	Name        string
	ContentPath string
	Enabled     *bool
	Visibility  string
}

var (
	projectSkillNamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)
	skillNameInvalidChars   = regexp.MustCompile(`[^a-z0-9-]+`)
)

func NewManager(cwd string) *Manager {
	return &Manager{
		cwd:    cwd,
		skills: make(map[string]*SkillRule),
		scopes: make(map[string]SkillScope),
	}
}

type skillFrontmatter struct {
	Name                  string   `yaml:"name"`
	DisplayName           string   `yaml:"displayName"`
	DisplayNameSnake      string   `yaml:"display_name"`
	Description           string   `yaml:"description"`
	WhenToUse             string   `yaml:"whenToUse"`
	WhenToUseSnake        string   `yaml:"when_to_use"`
	ArgumentHint          string   `yaml:"argumentHint"`
	ArgumentHintSnake     string   `yaml:"argument_hint"`
	ArgumentNames         []string `yaml:"argumentNames"`
	ArgumentNamesSnake    []string `yaml:"argument_names"`
	Type                  string   `yaml:"type"`
	Enforcement           string   `yaml:"enforcement"`
	Priority              string   `yaml:"priority"`
	Model                 string   `yaml:"model"`
	Effort                string   `yaml:"effort"`
	Context               string   `yaml:"context"`
	ExecutionContext      string   `yaml:"executionContext"`
	ExecutionContextSnake string   `yaml:"execution_context"`
	Source                string   `yaml:"source"`
	Enabled               *bool    `yaml:"enabled"`
	UserInvocable         *bool    `yaml:"userInvocable"`
	UserInvocableSnake    *bool    `yaml:"user_invocable"`
	Author                string   `yaml:"author,omitempty"`
	Version               string   `yaml:"version,omitempty"`
	Icon                  string   `yaml:"icon,omitempty"`
	DocumentationURL      string   `yaml:"documentation_url,omitempty"`
	Triggers              struct {
		Keywords        []string `yaml:"keywords,omitempty"`
		IntentPatterns  []string `yaml:"intentPatterns,omitempty"`
		PathPatterns    []string `yaml:"pathPatterns,omitempty"`
		ContentPatterns []string `yaml:"contentPatterns,omitempty"`
	} `yaml:"triggers"`
	AllowedTools      []string `yaml:"allowedTools,omitempty"`
	AllowedToolsSnake []string `yaml:"allowed_tools,omitempty"`
}

type SkillScope struct {
	SessionID    string    `json:"session_id"`
	SkillName    string    `json:"skill_name"`
	AllowedTools []string  `json:"allowed_tools,omitempty"`
	ActivatedAt  time.Time `json:"activated_at"`
}

// LoadSkills loads the skill-rules.json and associated markdown files
func (m *Manager) LoadSkills() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.skills = make(map[string]*SkillRule)
	rulesPath := filepath.Join(m.cwd, ".agent", "skills", "skill-rules.json")
	if data, err := os.ReadFile(rulesPath); err == nil {
		var rulesMap map[string]*SkillRule
		if err := json.Unmarshal(data, &rulesMap); err != nil {
			return fmt.Errorf("parse skill rules: %w", err)
		}

		for name, rule := range rulesMap {
			rule.Name = name
			applySkillDefaults(rule, "legacy")

			// Load the actual skill content (e.g., .agent/skills/backend-dev-guidelines.md)
			// We assume the skill name maps to a markdown file
			skillPath := filepath.Join(m.cwd, ".agent", "skills", name+".md")
			if content, err := os.ReadFile(skillPath); err == nil {
				rule.Content = string(content)
				rule.ContentPath = skillPath
			} else {
				// If no specific file, maybe content is in description or just a stub
				rule.Content = rule.Description
			}

			m.skills[name] = rule
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("read skill rules: %w", err)
	}

	// Load embedded skills
	for _, skill := range PluginDevSkills() {
		rule := &SkillRule{
			Name:             skill.Name,
			DisplayName:      skill.DisplayName,
			Description:      skill.Description,
			Type:             "embedded",
			Enforcement:      skill.Enforcement,
			Content:          skill.Content,
			WhenToUse:        skill.WhenToUse,
			ArgumentHint:     skill.ArgumentHint,
			ArgumentNames:    skill.ArgumentNames,
			AllowedTools:     skill.AllowedTools,
			Model:            skill.Model,
			Effort:           skill.Effort,
			ExecutionContext: skill.ExecutionContext,
			Source:           "bundled",
			Enabled:          true,
			UserInvocable:    true,
			PromptTriggers:   skill.Triggers,
		}
		applySkillDefaults(rule, "bundled")
		m.skills[rule.Name] = rule
	}

	// ─── Phase 19: Dynamic Project Skills ───
	m.loadRootRules()
	m.loadDynamicSkills()

	return nil
}

func (m *Manager) LoadSkillsWithOverrides(overrides []SkillOverride) error {
	if err := m.LoadSkills(); err != nil {
		return err
	}
	m.ApplyOverrides(overrides)
	return nil
}

func (m *Manager) ApplyOverrides(overrides []SkillOverride) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.applyOverridesLocked(overrides)
}

func (m *Manager) applyOverridesLocked(overrides []SkillOverride) {
	byPath := make(map[string]SkillOverride, len(overrides))
	byName := make(map[string]SkillOverride, len(overrides))
	for _, override := range overrides {
		override.Name = strings.TrimSpace(override.Name)
		override.ContentPath = strings.TrimSpace(override.ContentPath)
		override.Visibility = normalizeSkillVisibility(override.Visibility)
		if override.ContentPath != "" {
			byPath[cleanPathKey(override.ContentPath)] = override
		}
		if override.Name != "" {
			byName[strings.ToLower(override.Name)] = override
		}
	}

	for _, rule := range m.skills {
		if rule == nil {
			continue
		}
		if rule.LoadStatus == "" {
			rule.LoadStatus = "ok"
		}
		rule.Scope = skillScope(rule)
		rule.Visibility = normalizeSkillVisibility(rule.Visibility)
		if rule.Visibility == "" {
			rule.Visibility = "on"
		}
		if isDiagnosticSkill(rule) {
			rule.Enabled = false
			rule.Visibility = "off"
			rule.ImplicitInvocation = false
			continue
		}

		var override SkillOverride
		var ok bool
		if rule.ContentPath != "" {
			override, ok = byPath[cleanPathKey(rule.ContentPath)]
		}
		if !ok {
			override, ok = byName[strings.ToLower(rule.Name)]
		}
		if ok {
			if override.Enabled != nil {
				rule.Enabled = *override.Enabled
				rule.enabledConfigured = true
			}
			if override.Visibility != "" {
				rule.Visibility = override.Visibility
			}
		}
		if rule.Visibility == "off" {
			rule.Enabled = false
		}
		rule.ImplicitInvocation = rule.Enabled && rule.Visibility != "off" && rule.Visibility != "user-invocable-only"
	}
}

func (m *Manager) loadRootRules() {
	files := []struct {
		name        string
		path        string
		description string
	}{
		{"Project Rules", ".ricochet-rules.md", "Global rules for this project (from .ricochet-rules.md)"},
		{"RICOCHET.md", "RICOCHET.md", "Project instructions for Ricochet agents"},
		{"AGENTS.md", "AGENTS.md", "Project instructions shared with coding agents"},
	}

	for _, file := range files {
		rulesPath := filepath.Join(m.cwd, file.path)
		data, err := os.ReadFile(rulesPath)
		if err != nil {
			continue
		}

		rule := &SkillRule{
			Name:        file.name,
			Description: file.description,
			Type:        "root_rule",
			Enforcement: "force",
			Content:     string(data),
			ContentPath: rulesPath,
			WhenToUse:   "Always apply these project-level instructions when working inside this repository.",
			Source:      "project",
			Enabled:     true,
		}
		rule.PromptTriggers.IntentPatterns = []string{".*"}
		applySkillDefaults(rule, "project")
		m.skills["_root_rules_"+strings.ToLower(strings.TrimSuffix(file.path, filepath.Ext(file.path)))] = rule
	}
}

func (m *Manager) loadDynamicSkills() {
	skillsDir := filepath.Join(m.cwd, ".ricochet", "skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return // Directory might not exist, that's fine
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			if strings.EqualFold(filepath.Ext(entry.Name()), ".md") {
				path := filepath.Join(skillsDir, entry.Name())
				m.addSkillDiagnostic(
					"_diagnostic_misplaced_"+sanitizeSkillName(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))),
					"Misplaced skill file: "+entry.Name(),
					path,
					[]string{
						"Project skills must live at .ricochet/skills/<name>/SKILL.md.",
						"Move this file into .ricochet/skills/" + strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())) + "/SKILL.md to load it.",
					},
				)
			}
			continue
		}

		skillName := entry.Name()
		skillPath := filepath.Join(skillsDir, skillName, "SKILL.md")
		data, err := os.ReadFile(skillPath)
		if err != nil {
			if os.IsNotExist(err) {
				m.addSkillDiagnostic(
					"_diagnostic_missing_"+sanitizeSkillName(skillName),
					"Invalid project skill: "+skillName,
					skillPath,
					[]string{"Missing SKILL.md. Project skills must use .ricochet/skills/<name>/SKILL.md."},
				)
			} else {
				m.addSkillDiagnostic(
					"_diagnostic_read_"+sanitizeSkillName(skillName),
					"Unreadable project skill: "+skillName,
					skillPath,
					[]string{"Could not read SKILL.md: " + err.Error()},
				)
			}
			continue
		}

		content := string(data)
		rule := &SkillRule{
			Name:          skillName,
			DisplayName:   skillName,
			Type:          "dynamic",
			Source:        "project",
			Enabled:       true,
			UserInvocable: true,
			ContentPath:   skillPath,
		}

		// Check for YAML frontmatter
		if strings.HasPrefix(content, "---") {
			parts := strings.SplitN(content, "---", 3)
			if len(parts) >= 3 {
				var fm skillFrontmatter
				if err := yaml.Unmarshal([]byte(parts[1]), &fm); err != nil {
					m.addSkillDiagnostic(
						"_diagnostic_yaml_"+sanitizeSkillName(skillName),
						"Invalid project skill: "+skillName,
						skillPath,
						[]string{"Invalid SKILL.md YAML frontmatter: " + err.Error()},
					)
					continue
				}
				if fm.Name != "" {
					rule.Name = fm.Name
				}
				rule.DisplayName = firstNonEmpty(fm.DisplayNameSnake, fm.DisplayName, rule.DisplayName)
				rule.Description = fm.Description
				rule.WhenToUse = firstNonEmpty(fm.WhenToUseSnake, fm.WhenToUse)
				rule.ArgumentHint = firstNonEmpty(fm.ArgumentHintSnake, fm.ArgumentHint)
				rule.ArgumentNames = firstNonEmptySlice(fm.ArgumentNamesSnake, fm.ArgumentNames)
				rule.Enforcement = fm.Enforcement
				rule.Priority = fm.Priority
				rule.Model = fm.Model
				rule.Effort = fm.Effort
				rule.ExecutionContext = firstNonEmpty(fm.Context, fm.ExecutionContextSnake, fm.ExecutionContext)
				rule.Source = firstNonEmpty(fm.Source, rule.Source)
				if fm.Enabled != nil {
					rule.Enabled = *fm.Enabled
					rule.enabledConfigured = true
				}
				if fm.UserInvocable != nil {
					rule.UserInvocable = *fm.UserInvocable
				}
				if fm.UserInvocableSnake != nil {
					rule.UserInvocable = *fm.UserInvocableSnake
				}
				rule.PromptTriggers.Keywords = fm.Triggers.Keywords
				rule.PromptTriggers.IntentPatterns = fm.Triggers.IntentPatterns
				rule.FileTriggers.PathPatterns = fm.Triggers.PathPatterns
				rule.FileTriggers.ContentPatterns = fm.Triggers.ContentPatterns
				rule.DocumentationURL = fm.DocumentationURL
				rule.Author = fm.Author
				rule.Version = fm.Version
				rule.Icon = fm.Icon
				rule.Content = strings.TrimSpace(parts[2])
				rule.AllowedTools = firstNonEmptySlice(fm.AllowedToolsSnake, fm.AllowedTools)
			} else {
				m.addSkillDiagnostic(
					"_diagnostic_frontmatter_"+sanitizeSkillName(skillName),
					"Invalid project skill: "+skillName,
					skillPath,
					[]string{"SKILL.md starts with frontmatter but does not include a closing --- marker."},
				)
				continue
			}
		}

		if rule.Content == "" {
			rule.Content = content
		}
		applySkillDefaults(rule, "project")

		m.skills[rule.Name] = rule
	}
}

// FindApplicableSkills returns skills that match the context
func (m *Manager) FindApplicableSkills(prompt string, activeFiles []string) []*SkillRule {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var matches []*SkillRule
	seen := make(map[string]bool)

	for _, rule := range m.skills {
		if !rule.Enabled {
			continue
		}
		if isDiagnosticSkill(rule) || rule.Visibility == "off" || rule.Visibility == "user-invocable-only" {
			continue
		}
		if seen[rule.Name] {
			continue
		}

		matched := false

		// 1. Check Keywords
		for _, kw := range rule.PromptTriggers.Keywords {
			if strings.Contains(strings.ToLower(prompt), strings.ToLower(kw)) {
				matched = true
				break
			}
		}

		// 2. Check Intent Patterns (Regex)
		if !matched {
			for _, pat := range rule.PromptTriggers.IntentPatterns {
				if re, err := regexp.Compile("(?i)" + pat); err == nil {
					if re.MatchString(prompt) {
						matched = true
						break
					}
				}
			}
		}

		// 3. Check File Paths
		if !matched && len(activeFiles) > 0 {
			for _, pat := range rule.FileTriggers.PathPatterns {
				for _, file := range activeFiles {
					// Handle ** prefix manually since filepath.Match doesn't support it
					checkPat := pat
					if strings.HasPrefix(pat, "**/") {
						checkPat = strings.TrimPrefix(pat, "**/")
						// If file base matches the pattern
						// e.g. **/*.go matches /foo/bar/baz.go if baz.go matches *.go
						if match, _ := filepath.Match(checkPat, filepath.Base(file)); match {
							matched = true
							break
						}
					}

					// Standard glob matching
					if match, _ := filepath.Match(pat, file); match {
						matched = true
						break
					}
					// Also try matching relative path if pattern contains /
					rel, _ := filepath.Rel(m.cwd, file)
					if match, _ := filepath.Match(pat, rel); match {
						matched = true
						break
					}
				}
				if matched {
					break
				}
			}
		}

		if matched {
			matches = append(matches, rule)
			seen[rule.Name] = true
		}
	}

	return matches
}

// GetSkill returns a skill by name
func (m *Manager) GetSkill(name string) (*SkillRule, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.skills[name]
	return s, ok
}

// SkillHeader represents a summary of a skill for discovery
type SkillHeader struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	TriggerHint  []string `json:"trigger_hint,omitempty"`
	WhenToUse    string   `json:"when_to_use,omitempty"`
	AllowedTools []string `json:"allowed_tools,omitempty"`
	Context      string   `json:"context,omitempty"`
	Source       string   `json:"source,omitempty"`
	Enabled      bool     `json:"enabled"`
}

// GetAvailableSkillHeaders returns headers for skills that match the context
func (m *Manager) GetAvailableSkillHeaders(prompt string, activeFiles []string) []SkillHeader {
	applicable := m.FindApplicableSkills(prompt, activeFiles)
	var headers []SkillHeader
	for _, s := range applicable {
		headers = append(headers, SkillHeader{
			Name:         s.Name,
			Description:  s.Description,
			TriggerHint:  triggerHint(s),
			WhenToUse:    s.WhenToUse,
			AllowedTools: append([]string(nil), s.AllowedTools...),
			Context:      s.ExecutionContext,
			Source:       s.Source,
			Enabled:      s.Enabled,
		})
	}
	return headers
}

// ListSkillHeaders returns compact metadata for enabled non-root skills without
// exposing full skill instructions.
func (m *Manager) ListSkillHeaders() []SkillHeader {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var headers []SkillHeader
	for _, s := range m.skills {
		if s == nil || !s.Enabled || s.Type == "root_rule" {
			continue
		}
		if isDiagnosticSkill(s) || s.Visibility == "off" {
			continue
		}
		headers = append(headers, SkillHeader{
			Name:         s.Name,
			Description:  s.Description,
			TriggerHint:  triggerHint(s),
			WhenToUse:    s.WhenToUse,
			AllowedTools: append([]string(nil), s.AllowedTools...),
			Context:      s.ExecutionContext,
			Source:       s.Source,
			Enabled:      s.Enabled,
		})
	}
	sort.Slice(headers, func(i, j int) bool {
		if headers[i].Source != headers[j].Source {
			return headers[i].Source < headers[j].Source
		}
		return strings.ToLower(headers[i].Name) < strings.ToLower(headers[j].Name)
	})
	return headers
}

// ListAllSkills returns all registered skills
func (m *Manager) ListAllSkills() []*SkillRule {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var list []*SkillRule
	for _, s := range m.skills {
		list = append(list, s)
	}
	sort.Slice(list, func(i, j int) bool {
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})
	return list
}

func (m *Manager) ListSkillManifests() []protocol.SkillManifest {
	m.mu.RLock()
	defer m.mu.RUnlock()

	manifests := make([]protocol.SkillManifest, 0, len(m.skills))
	for _, s := range m.skills {
		manifests = append(manifests, skillManifest(s))
	}
	sort.Slice(manifests, func(i, j int) bool {
		if manifests[i].Source != manifests[j].Source {
			return manifests[i].Source < manifests[j].Source
		}
		return strings.ToLower(manifests[i].Name) < strings.ToLower(manifests[j].Name)
	})
	return manifests
}

func (m *Manager) ActivateSkillScope(sessionID, skillName string) (SkillScope, bool) {
	if strings.TrimSpace(sessionID) == "" || strings.TrimSpace(skillName) == "" {
		return SkillScope{}, false
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	skill, ok := m.skills[skillName]
	if !ok || len(skill.AllowedTools) == 0 {
		delete(m.scopes, sessionID)
		return SkillScope{}, false
	}

	scope := SkillScope{
		SessionID:    sessionID,
		SkillName:    skill.Name,
		AllowedTools: normalizedToolList(skill.AllowedTools),
		ActivatedAt:  time.Now(),
	}
	m.scopes[sessionID] = scope
	return scope, true
}

func (m *Manager) ClearSkillScope(sessionID string) {
	if strings.TrimSpace(sessionID) == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.scopes, sessionID)
}

func (m *Manager) SetEnabled(name string, enabled bool) error {
	return m.SetEnabledBySelector(name, "", enabled)
}

func (m *Manager) SetEnabledBySelector(name, contentPath string, enabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	skill, ok := m.skillBySelectorLocked(name, contentPath)
	if !ok || isDiagnosticSkill(skill) {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("skill not found: %s", contentPath)
		}
		return fmt.Errorf("skill not found: %s", name)
	}
	skill.Enabled = enabled
	skill.enabledConfigured = true
	if enabled {
		if skill.Visibility == "" || skill.Visibility == "off" {
			skill.Visibility = "on"
		}
	} else {
		skill.Visibility = "off"
	}
	skill.ImplicitInvocation = skill.Enabled && skill.Visibility != "off" && skill.Visibility != "user-invocable-only"
	return nil
}

func (m *Manager) CreateProjectSkill(name, description string) (string, error) {
	name = sanitizeProjectSkillName(name)
	if name == "" {
		return "", fmt.Errorf("skill name must use lowercase letters, numbers, and hyphens")
	}
	description = strings.TrimSpace(description)
	if description == "" {
		description = "Project-specific Ricochet skill."
	}

	dir := filepath.Join(m.cwd, ".ricochet", "skills", name)
	path := filepath.Join(dir, "SKILL.md")
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("project skill already exists: %s", name)
	} else if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}

	title := strings.ReplaceAll(name, "-", " ")
	content := fmt.Sprintf(`---
name: %s
display_name: %s
description: %s
when_to_use: %s
allowed_tools:
  - read_file
context: inline
enabled: true
triggers:
  keywords:
    - %s
---
# %s

Describe the workflow, constraints, examples, and edge cases this skill should handle.
`, name, yamlSingleQuote(title), yamlSingleQuote(description), yamlSingleQuote("Use when the user asks for "+title+" work in this repository."), name, title)

	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return "", err
	}
	return path, nil
}

func (m *Manager) DeleteProjectSkill(name, contentPath string) error {
	m.mu.RLock()
	skill, ok := m.skillBySelectorLocked(name, contentPath)
	if !ok {
		m.mu.RUnlock()
		return fmt.Errorf("skill not found: %s", firstNonEmpty(name, contentPath))
	}
	path := skill.ContentPath
	canDelete := canDeleteSkill(m.cwd, skill)
	m.mu.RUnlock()

	if !canDelete {
		return fmt.Errorf("only project skills under .ricochet/skills/<name>/SKILL.md can be deleted")
	}
	return os.RemoveAll(filepath.Dir(path))
}

func (m *Manager) ActiveSkillScope(sessionID string) (SkillScope, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	scope, ok := m.scopes[sessionID]
	return scope, ok
}

func (m *Manager) ToolAllowedInActiveScope(sessionID, toolName string) (bool, SkillScope) {
	scope, ok := m.ActiveSkillScope(sessionID)
	if !ok || len(scope.AllowedTools) == 0 {
		return true, SkillScope{}
	}
	toolName = strings.TrimSpace(toolName)
	switch toolName {
	case "", "invoke_skill", "list_available_skills", "update_todos", "task_boundary":
		return true, scope
	}
	for _, allowed := range scope.AllowedTools {
		if allowed == "*" || allowed == toolName {
			return true, scope
		}
	}
	return false, scope
}

func applySkillDefaults(rule *SkillRule, source string) {
	if rule == nil {
		return
	}
	rule.Name = strings.TrimSpace(rule.Name)
	if rule.DisplayName == "" {
		rule.DisplayName = rule.Name
	}
	if rule.Source == "" {
		rule.Source = source
	}
	if rule.ExecutionContext == "" {
		rule.ExecutionContext = "inline"
	}
	if rule.Type == "" {
		rule.Type = source
	}
	if !rule.Enabled && !rule.enabledConfigured {
		rule.Enabled = true
	}
	rule.AllowedTools = normalizedToolList(rule.AllowedTools)
	if rule.LoadStatus == "" {
		rule.LoadStatus = "ok"
	}
	rule.Scope = skillScope(rule)
	rule.Visibility = normalizeSkillVisibility(rule.Visibility)
	if rule.Visibility == "" {
		rule.Visibility = "on"
	}
	if isDiagnosticSkill(rule) {
		rule.Enabled = false
		rule.Visibility = "off"
	}
	rule.ImplicitInvocation = rule.Enabled && rule.Visibility != "off" && rule.Visibility != "user-invocable-only" && !isDiagnosticSkill(rule)
}

func skillManifest(s *SkillRule) protocol.SkillManifest {
	return protocol.SkillManifest{
		Name:               s.Name,
		DisplayName:        s.DisplayName,
		Description:        s.Description,
		WhenToUse:          s.WhenToUse,
		ArgumentHint:       s.ArgumentHint,
		ArgumentNames:      append([]string(nil), s.ArgumentNames...),
		AllowedTools:       append([]string(nil), s.AllowedTools...),
		Model:              s.Model,
		Effort:             s.Effort,
		Context:            s.ExecutionContext,
		Source:             s.Source,
		Enabled:            s.Enabled,
		UserInvocable:      s.UserInvocable,
		Type:               s.Type,
		Enforcement:        s.Enforcement,
		Author:             s.Author,
		Version:            s.Version,
		Icon:               s.Icon,
		DocumentationURL:   s.DocumentationURL,
		TriggerHint:        triggerHint(s),
		ContentPath:        s.ContentPath,
		Path:               s.ContentPath,
		LoadStatus:         firstNonEmpty(s.LoadStatus, "ok"),
		ValidationErrors:   append([]string(nil), s.ValidationErrors...),
		CanEdit:            canEditSkill(s),
		CanDelete:          canDeleteSkill("", s),
		Scope:              firstNonEmpty(s.Scope, skillScope(s)),
		Visibility:         firstNonEmpty(s.Visibility, "on"),
		ImplicitInvocation: s.ImplicitInvocation,
	}
}

func triggerHint(s *SkillRule) []string {
	var hints []string
	hints = append(hints, s.PromptTriggers.Keywords...)
	hints = append(hints, s.PromptTriggers.IntentPatterns...)
	hints = append(hints, s.FileTriggers.PathPatterns...)
	if len(hints) > 6 {
		hints = hints[:6]
	}
	return hints
}

func (m *Manager) addSkillDiagnostic(name, displayName, contentPath string, errors []string) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "_diagnostic_skill"
	}
	if _, exists := m.skills[name]; exists {
		name = fmt.Sprintf("%s_%d", name, len(m.skills)+1)
	}
	description := "Skill could not be loaded."
	if len(errors) > 0 {
		description = errors[0]
	}
	rule := &SkillRule{
		Name:              name,
		DisplayName:       displayName,
		Type:              "diagnostic",
		Enforcement:       "suggest",
		Priority:          "low",
		ContentPath:       contentPath,
		Description:       description,
		WhenToUse:         strings.Join(errors, " "),
		Source:            "project",
		Enabled:           false,
		enabledConfigured: true,
		UserInvocable:     false,
		LoadStatus:        "warning",
		ValidationErrors:  append([]string(nil), errors...),
		Scope:             "project",
		Visibility:        "off",
	}
	m.skills[name] = rule
}

func (m *Manager) skillBySelectorLocked(name, contentPath string) (*SkillRule, bool) {
	contentPath = cleanPathKey(contentPath)
	if contentPath != "" {
		for _, skill := range m.skills {
			if cleanPathKey(skill.ContentPath) == contentPath {
				return skill, true
			}
		}
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, false
	}
	if skill, ok := m.skills[name]; ok {
		return skill, true
	}
	lowerName := strings.ToLower(name)
	for _, skill := range m.skills {
		if strings.ToLower(skill.Name) == lowerName {
			return skill, true
		}
	}
	return nil, false
}

func cleanPathKey(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	return filepath.Clean(path)
}

func skillScope(skill *SkillRule) string {
	if skill == nil {
		return ""
	}
	if skill.Type == "root_rule" {
		return "root_rule"
	}
	switch skill.Source {
	case "bundled":
		return "bundled"
	case "legacy":
		return "legacy"
	case "project":
		if skill.Type == "dynamic" || skill.Type == "diagnostic" {
			return "project"
		}
	}
	if skill.Source != "" {
		return skill.Source
	}
	return skill.Type
}

func normalizeSkillVisibility(value string) string {
	switch strings.TrimSpace(value) {
	case "", "on", "name-only", "user-invocable-only", "off":
		return strings.TrimSpace(value)
	default:
		return ""
	}
}

func isDiagnosticSkill(skill *SkillRule) bool {
	return skill != nil && (skill.Type == "diagnostic" || (skill.LoadStatus != "" && skill.LoadStatus != "ok"))
}

func canEditSkill(skill *SkillRule) bool {
	return skill != nil && skill.Source == "project" && skill.Type == "dynamic" && strings.HasSuffix(filepath.Clean(skill.ContentPath), string(filepath.Separator)+"SKILL.md")
}

func canDeleteSkill(cwd string, skill *SkillRule) bool {
	if !canEditSkill(skill) {
		return false
	}
	path := filepath.Clean(skill.ContentPath)
	if !strings.HasSuffix(path, string(filepath.Separator)+"SKILL.md") {
		return false
	}
	if cwd == "" {
		return strings.Contains(path, string(filepath.Separator)+filepath.Join(".ricochet", "skills")+string(filepath.Separator))
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	skillsDir, err := filepath.Abs(filepath.Join(cwd, ".ricochet", "skills"))
	if err != nil {
		return false
	}
	skillDir := filepath.Dir(absPath)
	if !strings.HasPrefix(skillDir, skillsDir+string(filepath.Separator)) {
		return false
	}
	return filepath.Base(absPath) == "SKILL.md"
}

func sanitizeProjectSkillName(value string) string {
	value = sanitizeSkillName(value)
	if !projectSkillNamePattern.MatchString(value) {
		return ""
	}
	return value
}

func sanitizeSkillName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "_", "-")
	value = strings.ReplaceAll(value, " ", "-")
	value = skillNameInvalidChars.ReplaceAllString(value, "-")
	for strings.Contains(value, "--") {
		value = strings.ReplaceAll(value, "--", "-")
	}
	value = strings.Trim(value, "-")
	if value == "" {
		return "skill"
	}
	if len(value) > 64 {
		value = strings.Trim(value[:64], "-")
	}
	if value == "" {
		return "skill"
	}
	return value
}

func yamlSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstNonEmptySlice(values ...[]string) []string {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return nil
}

func normalizedToolList(tools []string) []string {
	seen := make(map[string]bool, len(tools))
	out := make([]string, 0, len(tools))
	for _, tool := range tools {
		tool = strings.TrimSpace(tool)
		if tool == "" || seen[tool] {
			continue
		}
		seen[tool] = true
		out = append(out, tool)
	}
	sort.Strings(out)
	return out
}
