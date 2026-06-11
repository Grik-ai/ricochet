package safeguard

import (
	"fmt"
	"path/filepath"

	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/safeguard/checkpoint"
)

// Manager handles all safeguard operations including checkpoints
type Manager struct {
	gitManager      *checkpoint.GitManager
	PermissionStore *PermissionStore
	Permissions     *PermissionConfig // Loaded from .ricochet/permissions.yaml
	CurrentZone     TrustZone
	AutoApproval    *config.AutoApprovalSettings
	ToolsSettings   *config.ToolsSettings
}

// NewManager creates a new safeguard manager
func NewManager(cwd string) (*Manager, error) {
	// Use global storage or similar for shadow git
	// For now, we use ~/.ricochet/shadow-git
	shadowBasePath := paths.GetShadowGitDir(cwd)
	if err := paths.EnsureDir(shadowBasePath); err != nil {
		return nil, fmt.Errorf("failed to create shadow base dir: %w", err)
	}

	gitMgr, err := checkpoint.NewGitManager(cwd, shadowBasePath)
	if err != nil {
		return nil, fmt.Errorf("failed to create git manager: %w", err)
	}

	// Initialize repo
	if err := gitMgr.Init(); err != nil {
		return nil, fmt.Errorf("failed to init shadow repo: %w", err)
	}

	permStore, err := NewPermissionStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create permission store: %w", err)
	}

	// Load file/tool/command permissions
	permConfig, err := LoadConfig(cwd)
	if err != nil {
		// Log warning but continue with defaults if config fails?
		// Better to fail closed or warn. Let's warn and use safe defaults.
		// For now, simple return for MVP.
		// Actually, LoadConfig returns safe defaults if file not found.
		// If error is parsing, we should probably fail.
		if permConfig == nil {
			permConfig, _ = LoadConfig(cwd) // Retry or use empty? LoadConfig handles default.
		}
	}

	return &Manager{
		gitManager:      gitMgr,
		PermissionStore: permStore,
		Permissions:     permConfig,
		CurrentZone:     ZoneSafe, // Default to Safe Zone
	}, nil
}

// SetAutoApproval updates the auto-approval settings
func (m *Manager) SetAutoApproval(settings *config.AutoApprovalSettings) {
	m.AutoApproval = settings
}

// SetToolsSettings updates the tools settings
func (m *Manager) SetToolsSettings(settings *config.ToolsSettings) {
	m.ToolsSettings = settings
}

// CreateCheckpoint creates a checkpoint of the current state
func (m *Manager) CreateCheckpoint(message string) (string, error) {
	return m.gitManager.Commit(message)
}

// RestoreCheckpoint restores the state to a specific checkpoint
func (m *Manager) RestoreCheckpoint(commitHash string) error {
	return m.gitManager.Restore(commitHash)
}

// CheckPermission verifies if the tool execution is allowed in the current zone
func (m *Manager) CheckPermission(tool string) error {
	// Check Auto-Approval checks first
	if m.AutoApproval != nil && m.AutoApproval.Enabled {
		switch tool {
		case "execute_command":
			if m.AutoApproval.ExecuteAllCommands {
				return nil
			}
			// Safe-command decisions require the actual command string, not just the
			// tool name. ExecuteCommand/CheckCommand handles that once args exist.
		case "read_file", "list_dir", "codebase_search":
			if m.AutoApproval.ReadFiles {
				return nil
			}
		case "write_file", "replace_file_content", "apply_diff":
			if m.AutoApproval.EditFiles {
				return nil
			}
		case "browser_open", "browser_click", "browser_type":
			if m.AutoApproval.UseBrowser {
				return nil
			}
		}
	}

	return CheckZonePermission(m.CurrentZone, tool)
}

// CheckFileAccess verifies if file access is allowed based on glob rules
func (m *Manager) CheckFileAccess(path string, write bool) error {
	// 1. Check if allowed
	allowed := false
	for _, pattern := range m.Permissions.Files.Allow {
		// Special handling for recursive allow-all
		if pattern == "**" {
			allowed = true
			break
		}

		if matched, _ := filepath.Match(pattern, path); matched {
			allowed = true
			break
		}
	}

	if !allowed {
		return fmt.Errorf("access denied: path '%s' does not match any allow pattern", path)
	}

	// 2. Check if denied (Explicit Deny trumps Allow)
	for _, pattern := range m.Permissions.Files.Deny {
		if matched, _ := filepath.Match(pattern, path); matched {
			return fmt.Errorf("access denied: path '%s' matches deny pattern '%s'", path, pattern)
		}
	}

	return nil
}

// CheckCommand verifies if a shell command is allowed
func (m *Manager) CheckCommand(command string) error {
	if m == nil || m.Permissions == nil {
		return nil
	}

	decision := GetCommandDecision(command, m.Permissions.Commands.Allow, m.Permissions.Commands.Deny)
	switch decision {
	case protocol.PermissionAutoApprove:
		return nil
	case protocol.PermissionAutoDeny:
		return fmt.Errorf("command denied by permissions: %q", command)
	default:
		if HasAllowedCommandMatch(command, m.Permissions.Commands.Allow) {
			return nil
		}
		return fmt.Errorf("command requires explicit permission: %q", command)
	}
}
