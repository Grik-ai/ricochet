package rules

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// RuleConfig represents the frontmatter and body of a rule file
type RuleConfig struct {
	Name    string   `yaml:"name"`
	Paths   []string `yaml:"paths"`
	Enabled bool     `yaml:"enabled"`
	Body    string   // Loaded from markdown below frontmatter
}

// Manager handles project-specific rules discovery and loading
type Manager struct {
	cwd string
}

func NewManager(cwd string) *Manager {
	return &Manager{cwd: cwd}
}

// GetRulesForFiles loads rules from .ricochet/rules/ and filters them by active paths.
func (m *Manager) GetRulesForFiles(activeFiles []string) string {
	rulesDir := filepath.Join(m.cwd, ".ricochet", "rules")
	files, err := os.ReadDir(rulesDir)
	if err != nil {
		return ""
	}

	var sb strings.Builder
	hasRules := false

	for _, f := range files {
		if f.IsDir() || filepath.Ext(f.Name()) != ".md" {
			continue
		}

		path := filepath.Join(rulesDir, f.Name())
		rule, err := m.loadRuleFile(path)
		if err != nil {
			fmt.Printf("Error loading rule %s: %v\n", f.Name(), err)
			continue
		}

		// Filter by path if RuleConfig.Paths is present
		if !m.ruleMatchesPaths(rule, activeFiles) {
			continue
		}

		if !hasRules {
			sb.WriteString("\n\n### Project-Specific Rules\n")
			hasRules = true
		}
		sb.WriteString(fmt.Sprintf("\n#### Rule: %s\n%s\n", f.Name(), rule.Body))
	}
	return sb.String()
}

// GetScopedInstructions loads AGENTS.md/RICOCHET.md files that apply to the active files.
func (m *Manager) GetScopedInstructions(activeFiles []string) string {
	dirs := m.scopedDirs(activeFiles)
	var sb strings.Builder
	hasInstructions := false

	for _, dir := range dirs {
		for _, name := range []string{"AGENTS.md", "RICOCHET.md"} {
			path := filepath.Join(dir, name)
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			body := strings.TrimSpace(m.stripHTMLComments(string(data)))
			if body == "" {
				continue
			}
			if !hasInstructions {
				sb.WriteString("\n\n### Scoped Project Instructions\n")
				sb.WriteString("Instructions are ordered from broadest to nearest scope; later sections take precedence when they conflict.\n")
				hasInstructions = true
			}
			rel, _ := filepath.Rel(m.cwd, path)
			if rel == "" {
				rel = path
			}
			sb.WriteString(fmt.Sprintf("\n#### %s\n%s\n", rel, body))
		}
	}
	return sb.String()
}

func (m *Manager) loadRuleFile(path string) (*RuleConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	content := string(data)
	rule := &RuleConfig{Enabled: true}

	if strings.HasPrefix(content, "---\n") {
		parts := strings.SplitN(content, "---\n", 3)
		if len(parts) >= 3 {
			if err := yaml.Unmarshal([]byte(parts[1]), rule); err != nil {
				return nil, fmt.Errorf("invalid YAML frontmatter: %w", err)
			}
			rule.Body = m.stripHTMLComments(strings.TrimSpace(parts[2]))
		}
	} else {
		rule.Body = m.stripHTMLComments(content)
	}

	return rule, nil
}

func (m *Manager) stripHTMLComments(text string) string {
	// regex to find <!-- ... -->
	re := regexp.MustCompile(`(?s)<!--.*?-->`)
	return re.ReplaceAllString(text, "")
}

func (m *Manager) ruleMatchesPaths(rule *RuleConfig, activeFiles []string) bool {
	// If no paths specified, rule is global
	if len(rule.Paths) == 0 {
		return true
	}

	// Rule is local: check if any active file matches any rule path
	for _, pattern := range rule.Paths {
		for _, file := range activeFiles {
			// Basic glob matching
			if matched, _ := filepath.Match(pattern, filepath.Base(file)); matched {
				return true
			}
			// Recursive check? E.g. "core/**/*.go"
			if strings.Contains(pattern, "**") {
				// Naive match for subdirectories
				basePattern := strings.ReplaceAll(pattern, "**/", "")
				if matched, _ := filepath.Match(basePattern, filepath.Base(file)); matched {
					return true
				}
			}
		}
	}
	return false
}

func (m *Manager) scopedDirs(activeFiles []string) []string {
	seen := map[string]bool{}
	var dirs []string
	add := func(dir string) {
		dir = filepath.Clean(dir)
		if seen[dir] {
			return
		}
		seen[dir] = true
		dirs = append(dirs, dir)
	}

	add(m.cwd)
	for _, file := range activeFiles {
		if strings.TrimSpace(file) == "" {
			continue
		}
		abs := file
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(m.cwd, file)
		}
		dir := filepath.Dir(abs)
		var chain []string
		for {
			rel, err := filepath.Rel(m.cwd, dir)
			if err != nil || strings.HasPrefix(rel, "..") {
				break
			}
			chain = append([]string{dir}, chain...)
			if dir == m.cwd {
				break
			}
			next := filepath.Dir(dir)
			if next == dir {
				break
			}
			dir = next
		}
		for _, scoped := range chain {
			add(scoped)
		}
	}
	return dirs
}

// Deprecated: use GetRulesForFiles
func (m *Manager) GetRules() string {
	return m.GetScopedInstructions(nil) + m.GetRulesForFiles(nil)
}
