package checkpoints

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestFindNestedGitRepository(t *testing.T) {
	workspace := t.TempDir()
	nestedGit := filepath.Join(workspace, "modules", "dep", ".git")
	if err := os.MkdirAll(nestedGit, 0755); err != nil {
		t.Fatalf("mkdir nested git: %v", err)
	}

	service := NewCheckpointService("task", workspace, t.TempDir())
	found, err := service.findNestedGitRepository()
	if err != nil {
		t.Fatalf("findNestedGitRepository: %v", err)
	}
	if found != nestedGit {
		t.Fatalf("found = %q, want %q", found, nestedGit)
	}
}

func TestPreviewRestoreAndSelectedRestore(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "app.txt"), []byte("one\n"), 0644); err != nil {
		t.Fatalf("write app: %v", err)
	}

	service := NewCheckpointService("task", workspace, t.TempDir())
	if err := service.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	baseHash := service.BaseHash()

	if err := os.WriteFile(filepath.Join(workspace, "app.txt"), []byte("two\n"), 0644); err != nil {
		t.Fatalf("modify app: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "extra.txt"), []byte("new\n"), 0644); err != nil {
		t.Fatalf("write extra: %v", err)
	}

	preview, err := service.PreviewRestore(baseHash)
	if err != nil {
		t.Fatalf("PreviewRestore: %v", err)
	}
	if !preview.SafetyRequired {
		t.Fatalf("expected safety checkpoint to be required")
	}
	if len(preview.Files) != 2 {
		t.Fatalf("preview files = %d, want 2: %#v", len(preview.Files), preview.Files)
	}

	patchPath, err := service.CreatePatch(baseHash)
	if err != nil {
		t.Fatalf("CreatePatch: %v", err)
	}
	if _, err := os.Stat(patchPath); err != nil {
		t.Fatalf("patch not written: %v", err)
	}

	result, err := service.RestoreWithOptions(protocol.CheckpointRestoreRequest{
		CheckpointHash:         baseHash,
		Mode:                   "selected_files",
		Paths:                  []string{"app.txt", "extra.txt"},
		CreateSafetyCheckpoint: true,
	})
	if err != nil {
		t.Fatalf("RestoreWithOptions selected: %v", err)
	}
	if result.SafetyCheckpointHash == "" {
		t.Fatalf("expected safety checkpoint hash")
	}
	raw, err := os.ReadFile(filepath.Join(workspace, "app.txt"))
	if err != nil {
		t.Fatalf("read restored app: %v", err)
	}
	if string(raw) != "one\n" {
		t.Fatalf("app content = %q, want one", string(raw))
	}
	if _, err := os.Stat(filepath.Join(workspace, "extra.txt")); !os.IsNotExist(err) {
		t.Fatalf("extra.txt should have been removed, stat err=%v", err)
	}
	if !contains(result.FilesRestored, "app.txt") || !contains(result.FilesRestored, "extra.txt") {
		t.Fatalf("unexpected restored files: %#v", result.FilesRestored)
	}
}

func TestInitAllowsNestedGitWithWarningInPreview(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "app.txt"), []byte("one\n"), 0644); err != nil {
		t.Fatalf("write app: %v", err)
	}
	nestedGit := filepath.Join(workspace, "modules", "dep", ".git")
	if err := os.MkdirAll(nestedGit, 0755); err != nil {
		t.Fatalf("mkdir nested git: %v", err)
	}

	service := NewCheckpointService("task", workspace, t.TempDir())
	if err := service.Init(); err != nil {
		t.Fatalf("Init should warn, not fail: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "app.txt"), []byte("two\n"), 0644); err != nil {
		t.Fatalf("modify app: %v", err)
	}
	preview, err := service.PreviewRestore(service.BaseHash())
	if err != nil {
		t.Fatalf("PreviewRestore: %v", err)
	}
	if len(preview.Warnings) == 0 || !strings.Contains(preview.Warnings[0], "Nested git repository") {
		t.Fatalf("expected nested git warning, got %#v", preview.Warnings)
	}
}

func TestExcludeFileSkipsRicochetRuntimeFiles(t *testing.T) {
	workspace := t.TempDir()
	service := NewCheckpointService("task", workspace, t.TempDir())
	if err := service.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(service.dotGitDir, "info", "exclude"))
	if err != nil {
		t.Fatalf("read exclude: %v", err)
	}
	exclude := string(raw)
	for _, pattern := range []string{".ricochet/", "task_progress_current.md"} {
		if !strings.Contains(exclude, pattern) {
			t.Fatalf("exclude missing %q:\n%s", pattern, exclude)
		}
	}
}

func TestInitRefreshesExcludeForExistingShadowRepo(t *testing.T) {
	workspace := t.TempDir()
	storage := t.TempDir()
	service := NewCheckpointService("task", workspace, storage)
	if err := service.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	excludePath := filepath.Join(service.dotGitDir, "info", "exclude")
	if err := os.WriteFile(excludePath, []byte("node_modules/\n"), 0644); err != nil {
		t.Fatalf("overwrite exclude: %v", err)
	}

	service = NewCheckpointService("task", workspace, storage)
	if err := service.Init(); err != nil {
		t.Fatalf("second Init: %v", err)
	}

	raw, err := os.ReadFile(excludePath)
	if err != nil {
		t.Fatalf("read refreshed exclude: %v", err)
	}
	if !strings.Contains(string(raw), ".ricochet/") || !strings.Contains(string(raw), "task_progress_current.md") {
		t.Fatalf("exclude was not refreshed:\n%s", string(raw))
	}
}

func TestStatusTracksLatestCheckpoint(t *testing.T) {
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspace, "app.txt"), []byte("one\n"), 0644); err != nil {
		t.Fatalf("write app: %v", err)
	}
	service := NewCheckpointService("task", workspace, t.TempDir())
	if err := service.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "app.txt"), []byte("two\n"), 0644); err != nil {
		t.Fatalf("modify app: %v", err)
	}
	hash, err := service.Save("after edit")
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	status := service.Status(true, true)
	if !status.Enabled || !status.CheckpointOnWrites || !status.Initialized {
		t.Fatalf("unexpected status flags: %#v", status)
	}
	if status.CheckpointCount != 1 {
		t.Fatalf("CheckpointCount = %d, want 1", status.CheckpointCount)
	}
	if status.LastCheckpointHash != hash {
		t.Fatalf("LastCheckpointHash = %q, want %q", status.LastCheckpointHash, hash)
	}
	if status.LastCheckpointAt == 0 {
		t.Fatalf("LastCheckpointAt should be set")
	}
}

func contains(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}
