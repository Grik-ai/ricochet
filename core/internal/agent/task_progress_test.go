package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPersistTaskProgressDebugFileDisabledByDefault(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("RICOCHET_TASK_PROGRESS_DEBUG_FILE", "")

	if err := persistTaskProgressDebugFile(dir, "Working", "Summary", []string{"Read README.md"}); err != nil {
		t.Fatalf("persist debug file: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, "task_progress_current.md")); !os.IsNotExist(err) {
		t.Fatalf("task_progress_current.md should not exist by default, stat err = %v", err)
	}
}

func TestPersistTaskProgressDebugFileEnabled(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("RICOCHET_TASK_PROGRESS_DEBUG_FILE", "true")

	if err := persistTaskProgressDebugFile(dir, "Working", "Summary", []string{"Read README.md"}); err != nil {
		t.Fatalf("persist debug file: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "task_progress_current.md"))
	if err != nil {
		t.Fatalf("read debug file: %v", err)
	}
	if string(raw) == "" || !taskProgressDebugFileEnabled() {
		t.Fatalf("debug file was not written correctly")
	}
}
