package worktree

import "testing"

func TestManagerPersistsWorktreeAndSession(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewManager(dir)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	wt, err := manager.AddWorktree(Worktree{
		Branch:       "feature/task-ux",
		Path:         "/repo/worktrees/task-ux",
		ParentBranch: "main",
		Remote:       "origin",
		Label:        "Task UX",
	})
	if err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := manager.LinkSession("session-1", wt.ID); err != nil {
		t.Fatalf("LinkSession: %v", err)
	}
	if err := manager.SetRunStatus(wt.ID, "running"); err != nil {
		t.Fatalf("SetRunStatus: %v", err)
	}

	reloaded, err := NewManager(dir)
	if err != nil {
		t.Fatalf("reload NewManager: %v", err)
	}
	got, ok := reloaded.SessionWorktree("session-1")
	if !ok {
		t.Fatalf("session worktree missing")
	}
	if got.ID != wt.ID || got.RunStatus != "running" || got.ParentBranch != "main" {
		t.Fatalf("unexpected worktree: %#v", got)
	}
}
