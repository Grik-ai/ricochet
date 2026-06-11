package safeguard

import (
	"path/filepath"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/config"
)

// ApprovalManager checks if tools can auto-execute based on settings
type ApprovalManager struct {
	settings     *config.AutoApprovalSettings
	workspaceDir string
}

// NewApprovalManager creates a new approval manager
func NewApprovalManager(settings *config.AutoApprovalSettings, workspaceDir string) *ApprovalManager {
	return &ApprovalManager{
		settings:     settings,
		workspaceDir: workspaceDir,
	}
}

// ToolCategory represents the type of action a tool performs
type ToolCategory string

const (
	CategoryRead    ToolCategory = "read"
	CategoryEdit    ToolCategory = "edit"
	CategoryCommand ToolCategory = "command"
	CategoryBrowser ToolCategory = "browser"
	CategoryMCP     ToolCategory = "mcp"
)

// SafeCommands that don't modify anything
var SafeCommands = map[string]bool{
	"ls": true, "cat": true, "head": true, "tail": true, "wc": true,
	"find": true, "grep": true, "awk": true, "sed": true, "sort": true,
	"pwd": true, "whoami": true, "date": true, "echo": true,
	"which": true, "type": true, "file": true, "stat": true,
	"go": true, "npm": true, "node": true, "python": true, "python3": true,
	"git": true, "diff": true, "tree": true,
}

// GetToolCategory returns the category for a given tool name
func GetToolCategory(toolName string) ToolCategory {
	switch toolName {
	case "read_file", "view_file", "list_directory", "search_files", "grep_search":
		return CategoryRead
	case "write_to_file", "write_file", "apply_diff", "replace_in_file", "delete_file", "create_directory":
		return CategoryEdit
	case "execute_command", "run_command":
		return CategoryCommand
	case "browser_action", "navigate_browser", "click", "screenshot":
		return CategoryBrowser
	default:
		if strings.HasPrefix(toolName, "mcp_") {
			return CategoryMCP
		}
		return CategoryRead // Default to read (safe)
	}
}

// CanAutoApprove checks if a tool can run without user approval
func (am *ApprovalManager) CanAutoApprove(toolName string, args map[string]interface{}) (bool, string) {
	if am.settings == nil || !am.settings.Enabled {
		return false, "Auto-approval disabled"
	}

	category := GetToolCategory(toolName)

	if toolName == "delete_file" {
		if path, ok := args["path"].(string); ok {
			if am.isExternalPath(path) {
				if am.settings.DeleteFilesExternal {
					return true, ""
				}
				return false, "Deleting external files requires approval"
			}
		}
		if am.settings.DeleteFiles {
			return true, ""
		}
		return false, "Deleting files requires approval"
	}

	switch category {
	case CategoryRead:
		// Check if file is internal or external
		if path, ok := args["path"].(string); ok {
			if am.isExternalPath(path) {
				if am.settings.ReadFilesExternal {
					return true, ""
				}
				return false, "Reading external files requires approval"
			}
		}
		if am.settings.ReadFiles {
			return true, ""
		}
		return false, "Reading files requires approval"

	case CategoryEdit:
		// Check if file is internal or external
		if path, ok := args["path"].(string); ok {
			if am.isExternalPath(path) {
				if am.settings.EditFilesExternal {
					return true, ""
				}
				return false, "Editing external files requires approval"
			}
		}
		if path, ok := args["TargetFile"].(string); ok {
			if am.isExternalPath(path) {
				if am.settings.EditFilesExternal {
					return true, ""
				}
				return false, "Editing external files requires approval"
			}
		}
		if am.settings.EditFiles {
			return true, ""
		}
		return false, "Editing files requires approval"

	case CategoryCommand:
		// Check if command is safe
		if cmd, ok := args["command"].(string); ok {
			if am.isSafeCommand(cmd) && am.settings.ExecuteSafeCommands {
				return true, ""
			}
		}
		if am.settings.ExecuteAllCommands {
			return true, ""
		}
		return false, "Command execution requires approval"

	case CategoryBrowser:
		if am.settings.UseBrowser {
			return true, ""
		}
		return false, "Browser automation requires approval"

	case CategoryMCP:
		if am.settings.UseMCP {
			return true, ""
		}
		return false, "MCP tool requires approval"
	}

	return false, "Unknown tool category"
}

// isExternalPath checks if path is outside workspace
func (am *ApprovalManager) isExternalPath(path string) bool {
	if am.workspaceDir == "" {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return true // Treat errors as external (safer)
	}
	return !strings.HasPrefix(absPath, am.workspaceDir)
}

func (am *ApprovalManager) isSafeCommand(cmd string) bool {
	return IsSafeCommand(cmd)
}
