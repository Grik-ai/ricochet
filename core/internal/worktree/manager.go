package worktree

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Worktree struct {
	ID           string `json:"id"`
	Branch       string `json:"branch"`
	Path         string `json:"path"`
	ParentBranch string `json:"parent_branch"`
	Remote       string `json:"remote,omitempty"`
	Label        string `json:"label,omitempty"`
	GroupID      string `json:"group_id,omitempty"`
	RunStatus    string `json:"run_status,omitempty"`
	CreatedAt    string `json:"created_at"`
}

type ManagedSession struct {
	ID         string `json:"id"`
	WorktreeID string `json:"worktree_id,omitempty"`
	CreatedAt  string `json:"created_at"`
}

type State struct {
	Worktrees map[string]Worktree       `json:"worktrees"`
	Sessions  map[string]ManagedSession `json:"sessions"`
}

type Manager struct {
	mu    sync.RWMutex
	file  string
	state State
}

func NewManager(storageDir string) (*Manager, error) {
	if storageDir == "" {
		return nil, fmt.Errorf("worktree storage dir is required")
	}
	if err := os.MkdirAll(storageDir, 0755); err != nil {
		return nil, err
	}
	m := &Manager{
		file: filepath.Join(storageDir, "worktrees.json"),
		state: State{
			Worktrees: map[string]Worktree{},
			Sessions:  map[string]ManagedSession{},
		},
	}
	if err := m.Load(); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return m, nil
}

func (m *Manager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	raw, err := os.ReadFile(m.file)
	if err != nil {
		return err
	}
	var state State
	if err := json.Unmarshal(raw, &state); err != nil {
		return err
	}
	if state.Worktrees == nil {
		state.Worktrees = map[string]Worktree{}
	}
	if state.Sessions == nil {
		state.Sessions = map[string]ManagedSession{}
	}
	m.state = state
	return nil
}

func (m *Manager) Save() error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.saveLocked()
}

func (m *Manager) AddWorktree(w Worktree) (Worktree, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if w.ID == "" {
		w.ID = "wt_" + uuid.NewString()
	}
	if w.CreatedAt == "" {
		w.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if w.RunStatus == "" {
		w.RunStatus = "idle"
	}
	m.state.Worktrees[w.ID] = w
	return w, m.saveLocked()
}

func (m *Manager) LinkSession(sessionID, worktreeID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if worktreeID != "" {
		if _, ok := m.state.Worktrees[worktreeID]; !ok {
			return fmt.Errorf("worktree not found: %s", worktreeID)
		}
	}
	m.state.Sessions[sessionID] = ManagedSession{
		ID:         sessionID,
		WorktreeID: worktreeID,
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	return m.saveLocked()
}

func (m *Manager) SetRunStatus(worktreeID, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	w, ok := m.state.Worktrees[worktreeID]
	if !ok {
		return fmt.Errorf("worktree not found: %s", worktreeID)
	}
	w.RunStatus = status
	m.state.Worktrees[worktreeID] = w
	return m.saveLocked()
}

func (m *Manager) ListWorktrees() []Worktree {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]Worktree, 0, len(m.state.Worktrees))
	for _, w := range m.state.Worktrees {
		out = append(out, w)
	}
	return out
}

func (m *Manager) SessionWorktree(sessionID string) (Worktree, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	session, ok := m.state.Sessions[sessionID]
	if !ok || session.WorktreeID == "" {
		return Worktree{}, false
	}
	w, ok := m.state.Worktrees[session.WorktreeID]
	return w, ok
}

func (m *Manager) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(m.file), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.file, raw, 0644)
}
