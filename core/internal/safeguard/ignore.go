package safeguard

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type IgnoreMatcher struct {
	mu       sync.RWMutex
	root     string
	path     string
	mtime    time.Time
	patterns []ignorePattern
}

type ignorePattern struct {
	raw   string
	regex *regexp.Regexp
}

func NewIgnoreMatcher(root string) *IgnoreMatcher {
	return &IgnoreMatcher{
		root: filepath.Clean(root),
		path: filepath.Join(root, ".ricochetignore"),
	}
}

func (m *IgnoreMatcher) CheckPath(path string) error {
	if ignored, pattern := m.IsIgnored(path); ignored {
		return fmt.Errorf("path %q is blocked by .ricochetignore pattern %q", path, pattern)
	}
	return nil
}

func (m *IgnoreMatcher) IsIgnored(path string) (bool, string) {
	if m == nil {
		return false, ""
	}
	_ = m.reloadIfNeeded()

	rel := m.normalize(path)
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, pattern := range m.patterns {
		if pattern.regex.MatchString(rel) {
			return true, pattern.raw
		}
	}
	return false, ""
}

func (m *IgnoreMatcher) CheckCommand(command string) error {
	if m == nil || strings.TrimSpace(command) == "" {
		return nil
	}
	_ = m.reloadIfNeeded()
	if len(m.patterns) == 0 {
		return nil
	}

	fields := splitCommandFields(command)
	if len(fields) == 0 {
		return nil
	}

	readCommands := map[string]bool{
		"awk": true, "cat": true, "grep": true, "head": true, "less": true,
		"more": true, "rg": true, "sed": true, "tail": true,
	}

	activeReadCommand := false
	for i, field := range fields {
		name := filepath.Base(field)
		if readCommands[name] {
			activeReadCommand = true
			continue
		}
		if !activeReadCommand || strings.HasPrefix(field, "-") {
			continue
		}
		if i == 0 || looksLikeSearchPattern(field) {
			continue
		}
		if ignored, pattern := m.IsIgnored(field); ignored {
			return fmt.Errorf("command reads ignored path %q blocked by .ricochetignore pattern %q", field, pattern)
		}
	}
	return nil
}

func (m *IgnoreMatcher) reloadIfNeeded() error {
	info, err := os.Stat(m.path)
	if err != nil {
		m.mu.Lock()
		m.patterns = nil
		m.mtime = time.Time{}
		m.mu.Unlock()
		return nil
	}

	m.mu.RLock()
	current := m.mtime.Equal(info.ModTime())
	m.mu.RUnlock()
	if current {
		return nil
	}

	data, err := os.ReadFile(m.path)
	if err != nil {
		return err
	}
	patterns := parseIgnorePatterns(string(data))

	m.mu.Lock()
	m.patterns = patterns
	m.mtime = info.ModTime()
	m.mu.Unlock()
	return nil
}

func (m *IgnoreMatcher) normalize(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(m.root, path)
	}
	path = filepath.Clean(path)
	rel, err := filepath.Rel(m.root, path)
	if err != nil {
		rel = path
	}
	return filepath.ToSlash(strings.TrimPrefix(rel, "./"))
}

func parseIgnorePatterns(content string) []ignorePattern {
	var patterns []ignorePattern
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "!") {
			continue
		}
		if regex := compileIgnorePattern(line); regex != nil {
			patterns = append(patterns, ignorePattern{raw: line, regex: regex})
		}
	}
	return patterns
}

func compileIgnorePattern(pattern string) *regexp.Regexp {
	pattern = filepath.ToSlash(strings.TrimSpace(pattern))
	pattern = strings.TrimPrefix(pattern, "./")
	dirOnly := strings.HasSuffix(pattern, "/")
	pattern = strings.TrimSuffix(pattern, "/")
	if pattern == "" {
		return nil
	}

	var b strings.Builder
	b.WriteString("^")
	if !strings.Contains(pattern, "/") {
		b.WriteString("(?:.*/)?")
	}
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		if ch == '*' {
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				b.WriteString(".*")
				i++
			} else {
				b.WriteString(`[^/]*`)
			}
			continue
		}
		if ch == '?' {
			b.WriteString(`[^/]`)
			continue
		}
		b.WriteString(regexp.QuoteMeta(string(ch)))
	}
	if dirOnly {
		b.WriteString("(?:/.*)?")
	}
	b.WriteString("$")

	regex, err := regexp.Compile(b.String())
	if err != nil {
		return nil
	}
	return regex
}

func splitCommandFields(command string) []string {
	fields := strings.FieldsFunc(command, func(r rune) bool {
		switch r {
		case ' ', '\t', '\n', '\r', ';', '|', '&':
			return true
		default:
			return false
		}
	})
	out := fields[:0]
	for _, field := range fields {
		field = strings.Trim(field, `"'`)
		if field != "" {
			out = append(out, field)
		}
	}
	return out
}

func looksLikeSearchPattern(field string) bool {
	if strings.ContainsAny(field, `/\`) {
		return false
	}
	if strings.ContainsAny(field, "*?[](){}^$+|") {
		return true
	}
	return !strings.Contains(field, ".")
}
