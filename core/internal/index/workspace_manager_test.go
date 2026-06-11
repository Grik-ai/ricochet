package index

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceIndexManagerRebuild(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc run() {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "node_modules"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "skip.js"), []byte("function skip() {}\n"), 0600); err != nil {
		t.Fatal(err)
	}

	manager := NewWorkspaceIndexManager(dir)
	defer manager.Close()
	if err := manager.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}

	status := manager.Status()
	if status.Status != "clean" {
		t.Fatalf("expected clean status, got %s", status.Status)
	}
	if status.FilesIndexed != 1 {
		t.Fatalf("expected one indexed file, got %d", status.FilesIndexed)
	}
	if status.Definitions == 0 {
		t.Fatal("expected definition count")
	}
	if len(status.SampleFiles) != 1 || status.SampleFiles[0].Path != "main.go" {
		t.Fatalf("unexpected sample files: %+v", status.SampleFiles)
	}
}

func TestWorkspaceIndexGraphLookupAndTrace(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "pkg"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nimport \"example.com/app/pkg\"\n\nfunc main() { pkg.Run() }\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pkg", "pkg.go"), []byte("package pkg\n\nfunc Run() {}\n"), 0600); err != nil {
		t.Fatal(err)
	}

	manager := NewWorkspaceIndexManager(dir)
	defer manager.Close()
	if err := manager.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}

	results := manager.RouteLookup("pkg", 10)
	if len(results) == 0 {
		t.Fatal("expected route lookup results")
	}
	foundPkg := false
	for _, result := range results {
		if strings.Contains(result.Path, "pkg") {
			foundPkg = true
		}
	}
	if !foundPkg {
		t.Fatalf("expected pkg file in lookup results: %+v", results)
	}

	trace := manager.DependencyTrace("pkg", 10)
	if len(trace["dependents"]) == 0 {
		t.Fatalf("expected dependent file for pkg import, got %+v", trace)
	}
}
