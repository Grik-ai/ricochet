package workflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagerLoadsStructuredWorkflowFromFrontmatter(t *testing.T) {
	root := t.TempDir()
	workflowDir := filepath.Join(root, ".agent", "workflows")
	if err := os.MkdirAll(workflowDir, 0755); err != nil {
		t.Fatal(err)
	}

	content := `---
name: review
description: Review focused changes.
version: "1"
command: /review
risk: low
inputs:
  - name: input
    description: Review target.
    required: false
steps:
  - id: scope
    description: Determine scope.
    type: agent
    action: |-
      Review {{input}} carefully.
  - id: report
    description: Report findings.
    type: agent
    action: |-
      Findings first.
verification:
  - Inspect the review target.
forbidden_actions:
  - Do not edit files.
completion_criteria:
  - Findings are reported or no findings is stated.
---

# Review
`
	if err := os.WriteFile(filepath.Join(workflowDir, "review.md"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(root)
	if err := mgr.LoadWorkflows(); err != nil {
		t.Fatalf("LoadWorkflows failed: %v", err)
	}

	wf, ok := mgr.GetWorkflow("/review")
	if !ok {
		t.Fatalf("expected slash command fallback from filename")
	}
	if wf.Description != "Review focused changes." {
		t.Fatalf("unexpected description %q", wf.Description)
	}
	if wf.Version != "1" || wf.Risk != "low" {
		t.Fatalf("unexpected schema metadata: %#v", wf)
	}
	if len(wf.Steps) != 2 {
		t.Fatalf("expected 2 structured steps, got %d", len(wf.Steps))
	}
	if wf.Steps[0].ID != "scope" || !strings.Contains(wf.Steps[0].Action, "{{input}}") {
		t.Fatalf("unexpected first step: %#v", wf.Steps[0])
	}
	if len(wf.Verification) == 0 || len(wf.ForbiddenActions) == 0 || len(wf.CompletionCriteria) == 0 {
		t.Fatalf("expected full workflow contract: %#v", wf)
	}
}

func TestManagerRejectsIncompleteWorkflow(t *testing.T) {
	root := t.TempDir()
	workflowDir := filepath.Join(root, ".agent", "workflows")
	if err := os.MkdirAll(workflowDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := `---
name: incomplete
description: Missing schema fields.
steps: []
---
`
	if err := os.WriteFile(filepath.Join(workflowDir, "incomplete.md"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(root)
	if err := mgr.LoadWorkflows(); err != nil {
		t.Fatalf("LoadWorkflows should skip invalid workflows without failing the load: %v", err)
	}
	if _, ok := mgr.GetWorkflow("/incomplete"); ok {
		t.Fatalf("incomplete workflow should not be loaded")
	}
}

func TestBundledWorkflowsAreStructuredAndClean(t *testing.T) {
	repoRoot := findRepositoryRoot(t)
	coreRoot := filepath.Join(repoRoot, "core")
	workflowDir := filepath.Join(coreRoot, ".agent", "workflows")

	entries, err := os.ReadDir(workflowDir)
	if err != nil {
		t.Fatalf("read bundled workflows: %v", err)
	}

	if len(entries) == 0 {
		t.Fatalf("expected bundled workflows")
	}

	badTemplate := " + \"`\" + "
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
			continue
		}
		path := filepath.Join(workflowDir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		content := string(data)
		if strings.Contains(content, badTemplate) {
			t.Fatalf("%s contains broken template garbage %q", entry.Name(), badTemplate)
		}
		if strings.Contains(content, "git add .") {
			t.Fatalf("%s contains unsafe whole-tree staging guidance", entry.Name())
		}
	}

	mgr := NewManager(coreRoot)
	if err := mgr.LoadWorkflows(); err != nil {
		t.Fatalf("LoadWorkflows failed: %v", err)
	}

	for _, command := range []string{"/feature-dev", "/code-review", "/commit-push-pr", "/issue-triage", "/create-plugin", "/dedupe"} {
		wf, ok := mgr.GetWorkflow(command)
		if !ok {
			t.Fatalf("missing bundled workflow %s", command)
		}
		if wf.Version != "1" {
			t.Fatalf("bundled workflow %s must declare schema version 1", command)
		}
		if strings.TrimSpace(wf.Risk) == "" {
			t.Fatalf("bundled workflow %s must declare risk", command)
		}
		if len(wf.Inputs) == 0 {
			t.Fatalf("bundled workflow %s must declare inputs", command)
		}
		if len(wf.Steps) == 0 {
			t.Fatalf("bundled workflow %s has no structured steps", command)
		}
		if len(wf.Verification) == 0 || len(wf.ForbiddenActions) == 0 || len(wf.CompletionCriteria) == 0 {
			t.Fatalf("bundled workflow %s has incomplete execution contract", command)
		}
		for _, step := range wf.Steps {
			if strings.TrimSpace(step.ID) == "" || strings.TrimSpace(step.Action) == "" {
				t.Fatalf("bundled workflow %s has incomplete step: %#v", command, step)
			}
		}
	}
}

func findRepositoryRoot(t *testing.T) string {
	t.Helper()

	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}

	for {
		if _, err := os.Stat(filepath.Join(dir, "core", ".agent", "workflows")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not locate repository root from %s", dir)
		}
		dir = parent
	}
}
