package agent

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/checkpoints"
	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// Checkpoint represents a workspace snapshot for legacy controller callers.
type Checkpoint struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Timestamp time.Time         `json:"timestamp"`
	Files     map[string]string `json:"files,omitempty"`
}

// CheckpointManager preserves the old agent API while using shadow git storage.
type CheckpointManager struct {
	projectRoot string
	service     *checkpoints.CheckpointService
	initErr     error
}

func NewCheckpointManager(projectRoot string) *CheckpointManager {
	taskID := paths.GetWorkspaceHash(projectRoot)
	storageDir := filepath.Join(paths.GetGlobalDir(), "checkpoints")
	service := checkpoints.NewCheckpointService(taskID, projectRoot, storageDir)
	manager := &CheckpointManager{
		projectRoot: projectRoot,
		service:     service,
	}
	manager.initErr = service.Init()
	return manager
}

func (m *CheckpointManager) Save(name string, _ []string) (string, error) {
	if m == nil || m.service == nil {
		return "", fmt.Errorf("checkpoint manager is not initialized")
	}
	if m.initErr != nil {
		return "", m.initErr
	}
	return m.service.Save(name)
}

func (m *CheckpointManager) List() ([]Checkpoint, error) {
	if m == nil || m.service == nil {
		return nil, fmt.Errorf("checkpoint manager is not initialized")
	}
	if m.initErr != nil {
		return nil, m.initErr
	}
	hashes := m.service.List()
	out := make([]Checkpoint, 0, len(hashes))
	for _, hash := range hashes {
		out = append(out, Checkpoint{
			ID:        hash,
			Name:      "checkpoint " + shortHash(hash),
			Timestamp: time.Now(),
		})
	}
	return out, nil
}

func (m *CheckpointManager) Restore(idOrName string) error {
	if m == nil || m.service == nil {
		return fmt.Errorf("checkpoint manager is not initialized")
	}
	if m.initErr != nil {
		return m.initErr
	}
	for _, hash := range m.service.List() {
		if hash == idOrName || strings.HasPrefix(hash, idOrName) || "checkpoint "+shortHash(hash) == idOrName {
			return m.service.Restore(hash)
		}
	}
	return fmt.Errorf("checkpoint not found: %s", idOrName)
}

func (m *CheckpointManager) Status(enabled bool, checkpointOnWrites bool) protocol.CheckpointStatus {
	if m == nil || m.service == nil {
		return protocol.CheckpointStatus{
			Enabled:            enabled,
			CheckpointOnWrites: checkpointOnWrites,
			Error:              "Checkpoint manager is not initialized.",
		}
	}
	status := m.service.Status(enabled, checkpointOnWrites)
	if m.initErr != nil {
		status.Initialized = false
		status.Error = m.initErr.Error()
	}
	return status
}

func shortHash(hash string) string {
	if len(hash) <= 8 {
		return hash
	}
	return hash[:8]
}
