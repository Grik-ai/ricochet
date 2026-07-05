package agent

import (
	"testing"

	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
	"github.com/igoryan-dao/ricochet/internal/tools"
)

func TestAutoApprovalDeleteRequiresDeleteSetting(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{
				Enabled:   true,
				EditFiles: true,
			},
		},
	}

	tc := ToolCallInfo{Name: "delete_file", Arguments: `{"path":"README.md"}`}
	if c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("delete_file was auto-approved by edit_files without delete_files")
	}

	c.config.AutoApproval.DeleteFiles = true
	if !c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("delete_file was not auto-approved when delete_files is enabled")
	}
}

func TestAutoApprovalExternalEditRequiresExternalSetting(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{
				Enabled:   true,
				EditFiles: true,
			},
		},
	}

	tc := ToolCallInfo{Name: "write_file", Arguments: `{"path":"/tmp/outside.txt"}`}
	if c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("external write was auto-approved by edit_files without edit_files_external")
	}

	c.config.AutoApproval.EditFilesExternal = true
	if !c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("external write was not auto-approved when edit_files_external is enabled")
	}
}

func TestAutoApprovalExternalReadRequiresExternalSetting(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{
				Enabled:   true,
				ReadFiles: true,
			},
		},
	}

	if !c.isToolAutoApproved(nil, ToolCallInfo{Name: "read_file", Arguments: `{"path":"README.md"}`}, false) {
		t.Fatal("workspace read should stay silently allowed")
	}

	tc := ToolCallInfo{Name: "read_file", Arguments: `{"path":"/tmp/outside.txt"}`}
	if c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("external read was auto-approved without read_files_external")
	}

	c.config.AutoApproval.ReadFilesExternal = true
	if !c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("external read was not auto-approved when read_files_external is enabled")
	}
}

func TestAskApprovalModeOnlyAllowsReadAndMetaTools(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{Enabled: false},
		},
	}

	if !c.isToolAutoApproved(nil, ToolCallInfo{Name: "read_file", Arguments: `{"path":"README.md"}`}, false) {
		t.Fatal("read_file should stay silently allowed in ask mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "write_file", Arguments: `{"path":"README.md"}`}, false) {
		t.Fatal("write_file should require approval in ask mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "execute_command", Arguments: `{"command":"ls"}`}, false) {
		t.Fatal("execute_command should require approval in ask mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "browser_open", Arguments: `{"url":"https://example.com"}`}, false) {
		t.Fatal("browser_open should require approval in ask mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "unknown_mcp_tool", Arguments: `{}`}, false) {
		t.Fatal("MCP/unknown tools should require approval in ask mode")
	}
}

func TestPersistentPermissionAllowBypassesApprovalGate(t *testing.T) {
	store, err := safeguard.NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}
	if err := store.AddRule(safeguard.PermissionRule{
		Tool:    "write_file",
		Path:    "README.md",
		Action:  "allow",
		Scope:   safeguard.ScopeProject,
		Project: "/repo",
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}

	c := &Controller{
		cwd:       "/repo",
		config:    &Config{AutoApproval: &config.AutoApprovalSettings{Enabled: false}},
		safeguard: &safeguard.Manager{PermissionStore: store},
	}

	tc := ToolCallInfo{Name: "write_file", Arguments: `{"path":"README.md"}`}
	if got := c.persistentPermissionDecision(nil, tc, tools.GetToolCategory(tc.Name)); got != safeguard.PermissionAllow {
		t.Fatalf("expected persistent allow, got %s", got)
	}
	if !c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("persistent allow should bypass the first approval gate")
	}
}

func TestPersistentPermissionDenyBlocksApprovalGate(t *testing.T) {
	store, err := safeguard.NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}
	if err := store.AddRule(safeguard.PermissionRule{
		Tool:   "execute_command",
		Path:   "npm install",
		Action: "deny",
		Scope:  safeguard.ScopeGlobal,
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}

	c := &Controller{
		cwd:       "/repo",
		config:    &Config{AutoApproval: &config.AutoApprovalSettings{Enabled: true, ExecuteAllCommands: true}},
		safeguard: &safeguard.Manager{PermissionStore: store},
	}

	tc := ToolCallInfo{Name: "execute_command", Arguments: `{"command":"npm install"}`}
	if got := c.persistentPermissionDecision(nil, tc, tools.GetToolCategory(tc.Name)); got != safeguard.PermissionDeny {
		t.Fatalf("expected persistent deny, got %s", got)
	}
	if c.isToolAutoApproved(nil, tc, false) {
		t.Fatal("persistent deny should not be auto-approved")
	}
}

func TestPersistentPermissionCommandPrefixAndMCPRules(t *testing.T) {
	store, err := safeguard.NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}
	for _, rule := range []safeguard.PermissionRule{
		{Tool: "execute_command", CommandPrefix: "git status", Action: "allow", Scope: safeguard.ScopeGlobal},
		{Tool: "mcp", Path: "custom_tool", Action: "allow", Scope: safeguard.ScopeGlobal},
		{Tool: "dangerous_mcp_tool", Action: "deny", Scope: safeguard.ScopeGlobal},
	} {
		if err := store.AddRule(rule); err != nil {
			t.Fatalf("AddRule(%+v): %v", rule, err)
		}
	}

	c := &Controller{
		cwd:       "/repo",
		config:    &Config{AutoApproval: &config.AutoApprovalSettings{Enabled: false}},
		safeguard: &safeguard.Manager{PermissionStore: store},
	}

	command := ToolCallInfo{Name: "execute_command", Arguments: `{"command":"git status --short"}`}
	if !c.isToolAutoApproved(nil, command, false) {
		t.Fatal("command prefix allow should bypass approval")
	}

	mcpTool := ToolCallInfo{Name: "custom_tool", Arguments: `{}`}
	if !c.isToolAutoApproved(nil, mcpTool, false) {
		t.Fatal("generic mcp rule should bypass approval for matching MCP tool")
	}

	deniedMCP := ToolCallInfo{Name: "dangerous_mcp_tool", Arguments: `{}`}
	if got := c.persistentPermissionDecision(nil, deniedMCP, tools.GetToolCategory(deniedMCP.Name)); got != safeguard.PermissionDeny {
		t.Fatalf("expected exact MCP deny, got %s", got)
	}
}

func TestAutoSafeApprovesSafeCommandsOnly(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{
				Enabled:             true,
				ReadFiles:           true,
				ExecuteSafeCommands: true,
			},
		},
	}

	if !c.isToolAutoApproved(nil, ToolCallInfo{Name: "execute_command", Arguments: `{"command":"ls -la"}`}, false) {
		t.Fatal("safe command should be auto-approved in auto-safe mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "execute_command", Arguments: `{"command":"rm -rf /tmp/ricochet-danger"}`}, false) {
		t.Fatal("unsafe command should not be auto-approved in auto-safe mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "write_file", Arguments: `{"path":"README.md"}`}, false) {
		t.Fatal("edits should not be auto-approved in auto-safe mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "browser_open", Arguments: `{"url":"https://example.com"}`}, false) {
		t.Fatal("browser tools should not be auto-approved in auto-safe mode")
	}
	if c.isToolAutoApproved(nil, ToolCallInfo{Name: "unknown_mcp_tool", Arguments: `{}`}, false) {
		t.Fatal("MCP/unknown tools should not be auto-approved in auto-safe mode")
	}
}

func TestFullAccessAutoApprovesWriteExecuteBrowserAndMCP(t *testing.T) {
	c := &Controller{
		cwd: "/repo",
		config: &Config{
			AutoApproval: &config.AutoApprovalSettings{
				Enabled:             true,
				ReadFiles:           true,
				ReadFilesExternal:   true,
				EditFiles:           true,
				EditFilesExternal:   true,
				DeleteFiles:         true,
				DeleteFilesExternal: true,
				ExecuteSafeCommands: true,
				ExecuteAllCommands:  true,
				UseBrowser:          true,
				UseMCP:              true,
			},
		},
	}

	cases := []ToolCallInfo{
		{Name: "write_file", Arguments: `{"path":"README.md"}`},
		{Name: "delete_file", Arguments: `{"path":"README.md"}`},
		{Name: "execute_command", Arguments: `{"command":"npm test"}`},
		{Name: "execute_python", Arguments: `{"script":"print(\"analysis\")"}`},
		{Name: "browser_open", Arguments: `{"url":"https://example.com"}`},
		{Name: "unknown_mcp_tool", Arguments: `{}`},
	}

	for _, tc := range cases {
		if !c.isToolAutoApproved(nil, tc, false) {
			t.Fatalf("%s was not auto-approved in full access mode", tc.Name)
		}
	}
}
