package safeguard

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIgnoreMatcherBlocksPaths(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "ricochetignore_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	if err := os.WriteFile(filepath.Join(tmpDir, ".ricochetignore"), []byte("secrets/\n*.pem\n"), 0644); err != nil {
		t.Fatal(err)
	}

	matcher := NewIgnoreMatcher(tmpDir)
	if err := matcher.CheckPath("secrets/token.txt"); err == nil {
		t.Fatalf("expected secrets path to be blocked")
	}
	if err := matcher.CheckPath("keys/prod.pem"); err == nil {
		t.Fatalf("expected pem path to be blocked")
	}
	if err := matcher.CheckPath("src/main.go"); err != nil {
		t.Fatalf("expected normal path to be allowed: %v", err)
	}
}

func TestIgnoreMatcherBlocksReadCommands(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "ricochetignore_command_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	if err := os.WriteFile(filepath.Join(tmpDir, ".ricochetignore"), []byte("private.json\n"), 0644); err != nil {
		t.Fatal(err)
	}

	matcher := NewIgnoreMatcher(tmpDir)
	if err := matcher.CheckCommand("cat private.json"); err == nil {
		t.Fatalf("expected cat private.json to be blocked")
	}
	if err := matcher.CheckCommand("rg TODO src"); err != nil {
		t.Fatalf("expected ordinary rg command to be allowed: %v", err)
	}
}
