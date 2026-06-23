package rules

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGetScopedInstructionsOrdersBroadToNearest(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "core", "internal")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("root rules"), 0644); err != nil {
		t.Fatalf("write root agents: %v", err)
	}
	if err := os.WriteFile(filepath.Join(nested, "RICOCHET.md"), []byte("nested rules"), 0644); err != nil {
		t.Fatalf("write nested ricochet: %v", err)
	}

	manager := NewManager(root)
	got := manager.GetScopedInstructions([]string{filepath.Join(nested, "file.go")})

	rootIdx := strings.Index(got, "root rules")
	nestedIdx := strings.Index(got, "nested rules")
	if rootIdx == -1 || nestedIdx == -1 {
		t.Fatalf("missing instructions:\n%s", got)
	}
	if rootIdx > nestedIdx {
		t.Fatalf("instructions out of order:\n%s", got)
	}
}

func TestGetRulesForFilesFiltersByPath(t *testing.T) {
	root := t.TempDir()
	rulesDir := filepath.Join(root, ".ricochet", "rules")
	if err := os.MkdirAll(rulesDir, 0755); err != nil {
		t.Fatalf("mkdir rules: %v", err)
	}
	rule := `---
name: go rules
paths:
  - "*.go"
enabled: true
---
Use Go-specific checks.
`
	if err := os.WriteFile(filepath.Join(rulesDir, "go.md"), []byte(rule), 0644); err != nil {
		t.Fatalf("write rule: %v", err)
	}

	manager := NewManager(root)
	if got := manager.GetRulesForFiles([]string{filepath.Join(root, "main.go")}); !strings.Contains(got, "Go-specific checks") {
		t.Fatalf("expected Go rule to apply:\n%s", got)
	}
	if got := manager.GetRulesForFiles([]string{filepath.Join(root, "README.md")}); strings.Contains(got, "Go-specific checks") {
		t.Fatalf("Go rule should not apply to markdown:\n%s", got)
	}
}
