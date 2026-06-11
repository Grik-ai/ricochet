package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCreateWorktreeAndSyncDirtyFiles(t *testing.T) {
	tmp := t.TempDir()
	repo := filepath.Join(tmp, "repo")
	if err := os.MkdirAll(filepath.Join(repo, "src"), 0755); err != nil {
		t.Fatal(err)
	}

	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.email", "test@example.com")
	runGit(t, repo, "config", "user.name", "Test User")

	if err := os.WriteFile(filepath.Join(repo, "src", "main.rs"), []byte("fn main() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", ".")
	runGit(t, repo, "commit", "-m", "initial")

	if err := os.WriteFile(filepath.Join(repo, "src", "main.rs"), []byte("fn main() { println!(\"dirty\"); }\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "src", "new.rs"), []byte("pub fn new_file() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(repo)
	worktree := filepath.Join(tmp, "worker")
	if err := mgr.CreateWorktree(worktree, "-b", "worker-test"); err != nil {
		t.Fatalf("CreateWorktree failed: %v", err)
	}
	defer mgr.RemoveWorktree(worktree)

	if _, err := os.Stat(filepath.Join(worktree, "src", "main.rs")); err != nil {
		t.Fatalf("worktree did not contain committed source tree: %v", err)
	}

	if err := mgr.SyncDirtyFilesToWorktree(worktree); err != nil {
		t.Fatalf("SyncDirtyFilesToWorktree failed: %v", err)
	}

	mainBytes, err := os.ReadFile(filepath.Join(worktree, "src", "main.rs"))
	if err != nil {
		t.Fatal(err)
	}
	if string(mainBytes) != "fn main() { println!(\"dirty\"); }\n" {
		t.Fatalf("dirty tracked file was not synced, got %q", string(mainBytes))
	}

	if _, err := os.Stat(filepath.Join(worktree, "src", "new.rs")); err != nil {
		t.Fatalf("untracked file was not synced: %v", err)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
	}
}
