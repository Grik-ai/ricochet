// Package tools provides tool definitions and execution logic.
// This file defines the Category-Based Permission System for tools.
package tools

// ToolCategory defines the permission category for a tool.
// This replaces hardcoded tool name lists for auto-approval decisions.
type ToolCategory string

const (
	// CategoryRead - Safe read-only operations. Always auto-approved.
	// Examples: list_dir, read_file, grep_search, lsp_*, codebase_search
	CategoryRead ToolCategory = "read"

	// CategoryWrite - Side-effect operations that modify files.
	// Plan Mode: BLOCKED (must switch to Act mode)
	// Act Mode: Requires user approval
	CategoryWrite ToolCategory = "write"

	// CategoryExecute - Shell commands and external processes.
	// Plan Mode: BLOCKED
	// Act Mode: Requires user approval (unless whitelisted safe commands)
	CategoryExecute ToolCategory = "execute"

	// CategoryMeta - Internal tools with no side effects (task_boundary, update_todos).
	// Always auto-approved silently.
	CategoryMeta ToolCategory = "meta"

	// CategoryBrowser - Browser automation tools.
	// Requires specific browser permission.
	CategoryBrowser ToolCategory = "browser"

	// CategoryMCP - External MCP tools (unknown category by default).
	// Requires explicit approval unless configured otherwise.
	CategoryMCP ToolCategory = "mcp"
)

// toolCategoryRegistry maps tool names to their categories.
// This is the single source of truth for tool classifications.
var toolCategoryRegistry = map[string]ToolCategory{
	// ─── READ TOOLS (Always Auto-Approved) ───
	"list_dir":                  CategoryRead,
	"read_file":                 CategoryRead,
	"read_definitions":          CategoryRead,
	"codebase_search":           CategoryRead,
	"grep_search":               CategoryRead,
	"find_by_name":              CategoryRead,
	"view_file":                 CategoryRead,
	"view_file_outline":         CategoryRead,
	"view_code_item":            CategoryRead,
	"get_diagnostics":           CategoryRead,
	"get_definitions":           CategoryRead, // LSP go-to-definition
	"lsp_goto_definition":       CategoryRead,
	"lsp_hover":                 CategoryRead,
	"lsp_references":            CategoryRead,
	"lsp_completions":           CategoryRead,
	"command_status":            CategoryRead, // Check status of bg command (read-only)
	"read_terminal":             CategoryRead,
	"get_workflows":             CategoryRead,
	"get_context_stats":         CategoryRead,
	"web_search":                CategoryRead,
	"list_available_skills":     CategoryRead,
	"retrieve_context_original": CategoryRead,
	"graph_status":              CategoryRead,
	"graph_explore":             CategoryRead,
	"route_lookup":              CategoryRead,
	"dependency_trace":          CategoryRead,
	"symbol_impact":             CategoryRead,
	"research_doctor":           CategoryRead,
	"document_parse":            CategoryRead,

	// ─── WRITE TOOLS (Require Approval in Act Mode, Blocked in Plan) ───
	"write_file":           CategoryWrite,
	"write_to_file":        CategoryWrite,
	"replace_file_content": CategoryWrite,
	"replace_in_file":      CategoryWrite,
	"apply_diff":           CategoryWrite,
	"delete_file":          CategoryWrite,
	"move_file":            CategoryWrite,
	"create_directory":     CategoryWrite,
	"batch_edit":           CategoryWrite,

	// ─── EXECUTE TOOLS (Require Approval) ───
	"execute_command": CategoryExecute,
	"run_command":     CategoryExecute,
	"execute_python":  CategoryExecute,
	"start_terminal":  CategoryExecute,
	"send_input":      CategoryExecute,
	"command_stop":    CategoryExecute,
	"terminal_close":  CategoryExecute,

	// ─── META TOOLS (Always Silent Auto-Approve) ───
	"task_boundary":    CategoryMeta,
	"update_todos":     CategoryMeta,
	"update_plan":      CategoryMeta,
	"list_tasks":       CategoryMeta,
	"create_task":      CategoryMeta,
	"next_task":        CategoryMeta,
	"complete_task":    CategoryMeta,
	"add_subtask":      CategoryMeta,
	"switch_mode":      CategoryMeta,
	"ask_user_choice":  CategoryMeta, // User interaction tool
	"submit_plan":      CategoryMeta,
	"start_swarm":      CategoryMeta,
	"subagent":         CategoryMeta,
	"write_scratchpad": CategoryMeta,
	"read_scratchpad":  CategoryMeta,
	"invoke_skill":     CategoryMeta,

	// ─── BROWSER TOOLS ───
	"browser_open":       CategoryBrowser,
	"browser_click":      CategoryBrowser,
	"browser_type":       CategoryBrowser,
	"browser_screenshot": CategoryBrowser,
	"browser_navigate":   CategoryBrowser,

	// ─── SAFEGUARD TOOLS ───
	"restore_checkpoint": CategoryWrite, // Modifies workspace state
}

// GetToolCategory returns the category for a tool.
// Unknown tools default to CategoryMCP (requires approval).
func GetToolCategory(toolName string) ToolCategory {
	if cat, ok := toolCategoryRegistry[toolName]; ok {
		return cat
	}
	// Unknown tools (likely MCP) require explicit approval
	return CategoryMCP
}

// IsReadOnlyTool returns true if the tool has no side effects.
func IsReadOnlyTool(toolName string) bool {
	cat := GetToolCategory(toolName)
	return cat == CategoryRead || cat == CategoryMeta
}

// IsWriteTool returns true if the tool modifies files.
func IsWriteTool(toolName string) bool {
	return GetToolCategory(toolName) == CategoryWrite
}

// IsExecuteTool returns true if the tool runs shell commands.
func IsExecuteTool(toolName string) bool {
	return GetToolCategory(toolName) == CategoryExecute
}

// IsBrowserTool returns true if the tool requires browser.
func IsBrowserTool(toolName string) bool {
	return GetToolCategory(toolName) == CategoryBrowser
}

// RegisterToolCategory allows registering new tools at runtime (e.g., from MCP).
// This enables dynamic tool registration without code changes.
func RegisterToolCategory(toolName string, category ToolCategory) {
	toolCategoryRegistry[toolName] = category
}
