package git

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Manager handles git operations
type Manager struct {
	cwd string
}

// NewManager creates a new git manager
func NewManager(cwd string) *Manager {
	return &Manager{cwd: cwd}
}

// execute runs a git command
func (m *Manager) execute(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = m.cwd
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %v\nOutput: %s", args[0], err, string(out))
	}
	return strings.TrimSpace(string(out)), nil
}

func (m *Manager) executeRaw(args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = m.cwd
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("git %s failed: %v\nOutput: %s", args[0], err, string(out))
	}
	return out, nil
}

// IsRepo checks if the current directory is a git repository
func (m *Manager) IsRepo() bool {
	_, err := m.execute("rev-parse", "--is-inside-work-tree")
	return err == nil
}

// HasValidHead reports whether the repository has at least one commit.
func (m *Manager) HasValidHead() bool {
	_, err := m.execute("rev-parse", "--verify", "HEAD")
	return err == nil
}

// Status returns the current git status
func (m *Manager) Status() (string, error) {
	return m.execute("status", "--short")
}

// Diff returns the staged and unstaged changes
func (m *Manager) Diff() (string, error) {
	// combine staged and unstaged diffs
	// staged
	staged, err := m.execute("diff", "--cached")
	if err != nil {
		return "", err
	}
	// unstaged
	unstaged, err := m.execute("diff")
	if err != nil {
		return "", err
	}

	if staged == "" && unstaged == "" {
		return "", nil
	}

	return fmt.Sprintf("=== Staged ===\n%s\n\n=== Unstaged ===\n%s", staged, unstaged), nil
}

// StageAll stages all changes
func (m *Manager) StageAll() error {
	_, err := m.execute("add", ".")
	return err
}

// Commit commits staged changes with a message
func (m *Manager) Commit(msg string) error {
	_, err := m.execute("commit", "-m", msg)
	return err
}

// CreateWorktree creates a new git worktree at the given path
func (m *Manager) CreateWorktree(path string, args ...string) error {
	fullArgs := append([]string{"worktree", "add"}, args...)
	fullArgs = append(fullArgs, path, "HEAD")
	_, err := m.execute(fullArgs...)
	return err
}

// SyncDirtyFilesToWorktree copies the current uncommitted workspace state into
// a freshly-created worktree so workers see the same code the user sees.
func (m *Manager) SyncDirtyFilesToWorktree(worktreePath string) error {
	out, err := m.executeRaw("status", "--porcelain=v1", "-z")
	if err != nil {
		return err
	}
	if len(out) == 0 {
		return nil
	}

	entries := strings.Split(string(out), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}

		status := entry[:2]
		relPath := entry[3:]

		if status[0] == 'R' || status[1] == 'R' || status[0] == 'C' || status[1] == 'C' {
			if i+1 < len(entries) && entries[i+1] != "" {
				oldPath := entries[i+1]
				_ = os.RemoveAll(filepath.Join(worktreePath, oldPath))
				i++
			}
		}

		src := filepath.Join(m.cwd, relPath)
		dst := filepath.Join(worktreePath, relPath)

		if _, statErr := os.Stat(src); statErr != nil {
			if os.IsNotExist(statErr) {
				if removeErr := os.RemoveAll(dst); removeErr != nil {
					return removeErr
				}
				continue
			}
			return statErr
		}

		if err := copyPath(src, dst); err != nil {
			return err
		}
	}

	return nil
}

// RemoveWorktree removes a git worktree at the given path
func (m *Manager) RemoveWorktree(path string) error {
	_, err := m.execute("worktree", "remove", "--force", path)
	return err
}

func copyPath(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			rel, err := filepath.Rel(src, path)
			if err != nil {
				return err
			}
			target := filepath.Join(dst, rel)
			if d.IsDir() {
				if d.Name() == ".git" {
					return filepath.SkipDir
				}
				return os.MkdirAll(target, 0755)
			}
			return copyFile(path, target)
		})
	}
	return copyFile(src, dst)
}

func copyFile(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
