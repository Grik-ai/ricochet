package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/browser"
	"github.com/igoryan-dao/ricochet/internal/codegraph"
	contextPkg "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/context/parser"
	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/index"
	mcpHubPkg "github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/memory"
	"github.com/igoryan-dao/ricochet/internal/modes"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
	"github.com/igoryan-dao/ricochet/internal/workflow"
)

// Tool execution interface
type Executor interface {
	Execute(ctx context.Context, name string, args json.RawMessage) (string, error)
	GetDefinitions() []ToolDefinition
}

// ToolDefinition for LLM
type ToolDefinition struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
}

// LiveModeProvider is an interface for checking live mode status and asking remote user
type LiveModeProvider interface {
	IsEnabled() bool
	AskUserRemote(ctx context.Context, question string) (string, error)
}

// ActionAuditor interface for post-execution verification (Shadow Agent)
type ActionAuditor interface {
	AuditAction(ctx context.Context, goal string, toolName string, args string, result string, expectedOutcome string) (bool, string, error)
}

// SessionProvider interface to access session-specific data
type SessionProvider interface {
	GetFileTracker(sessionID string) *contextPkg.FileTracker
}

// SwarmProvider allows the executor to check status of autonomous sub-agents
type SwarmProvider interface {
	GetSubtaskStatus(id string) (string, bool)
}

// NativeExecutor implements Executor using a Host for OS operations and ModeManager for permissions
type NativeExecutor struct {
	host            host.Host
	modes           *modes.Manager
	safeguard       *safeguard.Manager
	browser         *browser.BrowserManager
	mcpHub          *mcpHubPkg.Hub
	indexer         *index.Indexer
	codegraph       *codegraph.Service
	workflows       *workflow.Manager
	livemode        LiveModeProvider
	auditor         ActionAuditor
	sessionProvider SessionProvider
	shadowVerifier  *safeguard.ShadowVerifier
	ptyManager      *host.PTYManager
	memory          *memory.Manager
	ignoreMatcher   *safeguard.IgnoreMatcher
	dynamicTools    map[string]ToolDefinition // Support for dynamic tools (e.g. subtask)
	dynamicHandlers map[string]interface {
		Execute(context.Context, json.RawMessage) (string, error)
	}
	swarmProvider SwarmProvider
}

func NewNativeExecutor(h host.Host, m *modes.Manager, sg *safeguard.Manager, mcpHub *mcpHubPkg.Hub, idx *index.Indexer, cg *codegraph.Service, wm *workflow.Manager) *NativeExecutor {
	return &NativeExecutor{
		host:           h,
		modes:          m,
		safeguard:      sg,
		browser:        browser.NewBrowserManager(os.Getenv("RICOCHET_BROWSER_URL")),
		mcpHub:         mcpHub,
		indexer:        idx,
		codegraph:      cg,
		workflows:      wm,
		shadowVerifier: safeguard.NewShadowVerifier(),
		ptyManager:     host.NewPTYManager(),
		memory:         mustCreateMemory(h.GetCWD()),
		ignoreMatcher:  safeguard.NewIgnoreMatcher(h.GetCWD()),
		dynamicTools:   make(map[string]ToolDefinition),
		dynamicHandlers: make(map[string]interface {
			Execute(context.Context, json.RawMessage) (string, error)
		}),
	}
}

// RegisterTool allows registering implementation-specific tools at runtime
func (e *NativeExecutor) RegisterTool(t interface {
	Definition() protocol.Tool
	Execute(context.Context, json.RawMessage) (string, error)
}) {
	def := t.Definition()
	e.dynamicTools[def.Name] = ToolDefinition{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
	e.dynamicHandlers[def.Name] = t
}

// SetLiveMode sets the live mode provider for remote approval routing
func (e *NativeExecutor) SetLiveMode(lm LiveModeProvider) {
	e.livemode = lm
}

func (e *NativeExecutor) SetAuditor(a ActionAuditor) {
	e.auditor = a
}

func (e *NativeExecutor) SetSessionProvider(sp SessionProvider) {
	e.sessionProvider = sp
}

func (e *NativeExecutor) SetSwarmProvider(sp SwarmProvider) {
	e.swarmProvider = sp
}

// Hook interface for intercepting tool execution
type ToolHook interface {
	Name() string
	PreExecute(ctx context.Context, toolName string, args map[string]interface{}) error
}

// BashValidator hook to enforce best practices
type BashValidator struct{}

func (h *BashValidator) Name() string { return "BashValidator" }

func (h *BashValidator) PreExecute(ctx context.Context, toolName string, args map[string]interface{}) error {
	if toolName != "execute_command" {
		return nil
	}

	cmd, ok := args["command"].(string)
	if !ok {
		return nil
	}

	// 1. Block 'grep' without 'ripgrep' suggestion
	if strings.HasPrefix(cmd, "grep ") && !strings.Contains(cmd, "|") {
		return fmt.Errorf("⚠️ Safety Hook: Use 'rg' (ripgrep) instead of 'grep' for better performance and respect for .gitignore. If you must use grep, pipe it or use 'git grep'.")
	}

	// 2. Block 'find -name' without 'fd' suggestion
	if strings.HasPrefix(cmd, "find ") && strings.Contains(cmd, " -name ") {
		return fmt.Errorf("⚠️ Safety Hook: Use 'fd' instead of 'find' for faster searching. Example: 'fd pattern'.")
	}

	return nil
}

func (e *NativeExecutor) Execute(ctx context.Context, name string, args json.RawMessage) (string, error) {
	// 0. Parse args into map for hooks (optimization: only if hooks exist)
	// For now, we only have one hardcoded hook, so let's check it.
	// In the future, e.hooks would determine this.
	// Just unmarshal once for generic usage if needed.
	var argsMap map[string]interface{}
	if err := json.Unmarshal(args, &argsMap); err == nil {
		hook := &BashValidator{}
		if err := hook.PreExecute(ctx, name, argsMap); err != nil {
			return "", err
		}
	}

	// 1. Enforce Trust Zones
	if e.safeguard != nil {
		if err := e.safeguard.CheckPermission(name); err != nil {
			return "", fmt.Errorf("safeguard violation: %w", err)
		}
	}

	switch name {
	case "ask_user_choice":
		var payload struct {
			Question string   `json:"question"`
			Choices  []string `json:"choices"`
		}
		if err := json.Unmarshal(args, &payload); err != nil {
			return "", err
		}
		index, err := e.host.AskUserChoice(protocol.GetSessionID(ctx), payload.Question, payload.Choices)
		if err != nil {
			if strings.Contains(err.Error(), "not implemented") {
				return fmt.Sprintf(
					"Interactive choice is not available in this execution host. Do not assume approval. Present the question and choices to the user in the final response and wait for an explicit follow-up.\n\nQuestion: %s\nChoices: %s",
					payload.Question,
					strings.Join(payload.Choices, ", "),
				), nil
			}
			return "", err
		}
		return fmt.Sprintf("User selected choice %d: %s", index+1, payload.Choices[index]), nil

	case "list_dir":
		return e.ListDir(ctx, args)
	case "read_file":
		return e.ReadFile(ctx, args)
	case "write_file":
		return e.WriteFile(ctx, args)
	case "execute_command":
		return e.ExecuteCommand(ctx, args)
	case "codebase_search":
		return e.CodebaseSearch(ctx, args)
	case "command_status":
		return e.GetCommandStatus(ctx, args)
	case "restore_checkpoint":
		return e.RestoreCheckpoint(ctx, args)
	case "read_definitions":
		return e.ReadDefinitions(ctx, args)
	case "browser_open":
		return e.BrowserOpen(ctx, args)
	case "browser_screenshot":
		return e.BrowserScreenshot(ctx, args)
	case "browser_click":
		return e.BrowserClick(ctx, args)
	case "browser_type":
		return e.BrowserType(ctx, args)
	case "get_diagnostics":
		return e.GetDiagnostics(ctx, args)
	case "get_definitions":
		return e.GetDefinitionsLSP(ctx, args)
	case "get_references":
		return e.GetReferencesLSP(ctx, args)
	case "get_symbols":
		return e.GetSymbolsLSP(ctx, args)
	case "get_implementations":
		return e.GetImplementationsLSP(ctx, args)
	case "switch_mode":
		return e.SwitchMode(ctx, args)
	case "update_todos", "task_boundary", "update_plan", "submit_plan":
		return "Interpreted by controller", nil
	case "get_workflows":
		return e.GetWorkflows(ctx, args)
	case "subagent":
		return "DELEGATED_TO_CONTROLLER", nil
	case "read_scratchpad", "write_scratchpad":
		return "DELEGATED_TO_CONTROLLER", nil

	case "replace_file_content":
		// This method is defined in fs_tools.go but called on NativeExecutor
		return e.ReplaceFileContent(ctx, args)
	case "batch_edit":
		return e.BatchEdit(ctx, args)

	case "execute_python":
		return e.ExecutePythonTool(ctx, args)

	case "create_checkpoint":
		return e.CreateCheckpoint(ctx, args)

	case "start_terminal":
		return e.StartTerminal(ctx, args)
	case "send_input":
		return e.SendTerminalInput(ctx, args)
	case "read_terminal":
		return e.ReadTerminalOutput(ctx, args)
	case "remember":
		return e.Remember(ctx, args)
	case "recall":
		return e.Recall(ctx, args)
	case "web_search":
		wst := &WebSearchTool{}
		return wst.Execute(ctx, args)

	default:
		// Check Dynamic Tools (Subtasks etc)
		if handler, ok := e.dynamicHandlers[name]; ok {
			return handler.Execute(ctx, args)
		}

		// Check MCP tools
		if e.mcpHub != nil {
			// argsMap is already parsed above if successful, or we re-parse
			if argsMap == nil {
				if err := json.Unmarshal(args, &argsMap); err != nil {
					return "", fmt.Errorf("invalid arguments for MCP tool: %w", err)
				}
			}

			result, err := e.mcpHub.CallTool(ctx, name, argsMap)
			if err != nil {
				return "", fmt.Errorf("mcp tool error: %w", err)
			}

			// Format result
			var sb strings.Builder

			// Marshal/Unmarshal result content to inspect it generically
			contentBytes, _ := json.Marshal(result.Content)
			var contentList []map[string]interface{}
			_ = json.Unmarshal(contentBytes, &contentList)

			for _, content := range contentList {
				switch content["type"].(string) {
				case "text":
					if text, ok := content["text"].(string); ok {
						sb.WriteString(text)
						sb.WriteString("\n")
					}
				case "image":
					sb.WriteString("[Image returned]\n")
				case "resource":
					sb.WriteString("[Resource returned]\n")
				}
			}

			if result.IsError {
				return "", fmt.Errorf("tool execution failed: %s", sb.String())
			}
			return sb.String(), nil
		}

		return "", fmt.Errorf("unknown tool: %s", name)
	}
}

func (e *NativeExecutor) GetDefinitions() []ToolDefinition {
	defs := []ToolDefinition{
		{
			Name:        "list_dir",
			Description: "List files in a directory",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{
						"type":        "string",
						"description": "Directory path (absolute or relative to cwd)",
					},
				},
				"required": []string{"path"},
			},
		},
		{
			Name:        "read_file",
			Description: "Read file content",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{
						"type":        "string",
						"description": "File path (absolute or relative to cwd)",
					},
				},
				"required": []string{"path"},
			},
		},
		{
			Name:        "write_file",
			Description: "ONLY for creating NEW files. ⚠️ CRITICAL: Do NOT use this to edit existing files! Use 'replace_file_content' instead. Using write_file on existing files DESTROYS diff history and prevents users from seeing changes.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{
						"type":        "string",
						"description": "File path to write",
					},
					"content": map[string]interface{}{
						"type":        "string",
						"description": "Content to write",
					},
					"overwrite": map[string]interface{}{
						"type":        "boolean",
						"description": "Set to true to overwrite existing file (WARNING: Destroys history).",
					},
				},
				"required": []string{"path", "content"},
			},
		},
		{
			Name:        "replace_file_content",
			Description: "✅ REQUIRED tool for editing files. Replaces specific text with new content. Shows diff to user. ALWAYS use this instead of write_file for any existing file modifications.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{
						"type":        "string",
						"description": "File path to edit",
					},
					"TargetContent": map[string]interface{}{
						"type":        "string",
						"description": "The exact text chunk to verify and replace (must match exactly)",
					},
					"ReplacementContent": map[string]interface{}{
						"type":        "string",
						"description": "The new content to write",
					},
				},
				"required": []string{"path", "TargetContent", "ReplacementContent"},
			},
		},
		{
			Name:        "execute_command",
			Description: "Execute a shell command. Supports background execution.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"command": map[string]interface{}{
						"type":        "string",
						"description": "Command to execute",
					},
					"background": map[string]interface{}{
						"type":        "boolean",
						"description": "Whether to run the command in the background",
					},
				},
				"required": []string{"command"},
			},
		},
		{
			Name:        "command_status",
			Description: "Check the status of a background command or subagent worker",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"id": map[string]interface{}{
						"type":        "string",
						"description": "Command ID returned by execute_command, or subagent worker ID with or without the agent- prefix",
					},
				},
				"required": []string{"id"},
			},
		},
		{
			Name:        "switch_mode",
			Description: "Switch the agent's operating mode (persona).",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"mode": map[string]interface{}{
						"type":        "string",
						"description": "Mode slug to switch to (e.g., 'architect', 'code', 'test')",
					},
					"handoff": map[string]interface{}{
						"type":        "boolean",
						"description": "If true, triggers 'Intelligent Handoff' (summarizes context to SPEC.md before switching).",
					},
				},
				"required": []string{"mode"},
			},
		},
		{
			Name:        "update_todos",
			Description: "Update the visible checklist for the current session. For complex work, keep 3-6 short milestones, mark one item current, and mark all items completed before the final answer.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"todos": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"text":   map[string]interface{}{"type": "string", "description": "Description of the task"},
								"status": map[string]interface{}{"type": "string", "enum": []string{"pending", "current", "completed"}},
							},
							"required": []string{"text", "status"},
						},
					},
				},
				"required": []string{"todos"},
			},
		},
		{
			Name:        "codebase_search",
			Description: "Perform semantic search over the codebase using embeddings. Returns relevant code snippets.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{
						"type":        "string",
						"description": "Natural language search query",
					},
					"limit": map[string]interface{}{
						"type":        "integer",
						"description": "Number of results to return (default: 5)",
					},
				},
				"required": []string{"query"},
			},
		},
		{
			Name:        "execute_python",
			Description: "Execute a Python script. Use this to analyze files, perform math, or automate tasks instead of making multiple tool calls. Stdout/stderr are captured.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"script": map[string]interface{}{
						"type":        "string",
						"description": "The valid Python script to execute.",
					},
				},
				"required": []string{"script"},
			},
		},
	}

	if e.safeguard != nil {
		defs = append(defs, ToolDefinition{
			Name:        "restore_checkpoint",
			Description: "Restore the workspace to a previous checkpoint (Undo changes)",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"hash": map[string]interface{}{
						"type":        "string",
						"description": "Commit hash to restore to. Use 'HEAD' for latest.",
					},
				},
				"required": []string{"hash"},
			},
		})
	}

	// Add read_definitions tool
	defs = append(defs, ToolDefinition{
		Name:        "read_definitions",
		Description: "Read code definitions (functions, structs) from a file. Currently supports .go files.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{
					"type":        "string",
					"description": "File path to parse",
				},
			},
			"required": []string{"path"},
		},
	})

	// Add ask_user_choice tool
	defs = append(defs, ToolDefinition{
		Name:        "ask_user_choice",
		Description: "Ask the user to choose from a list of options. Use this for clarification.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"question": map[string]interface{}{"type": "string", "description": "The question to ask"},
				"choices":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
			},
			"required": []string{"question", "choices"},
		},
	})

	defs = append(defs, ToolDefinition{
		Name:        "submit_plan",
		Description: "Submit a first-class implementation plan artifact for user review. Use this instead of write_file for requested plans, planning-mode output, implementation plans, or plan-of-work deliverables. This does not edit the user's workspace.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"title": map[string]interface{}{
					"type":        "string",
					"description": "Short plan title. Defaults to Implementation Plan.",
				},
				"summary": map[string]interface{}{
					"type":        "string",
					"description": "One or two sentence summary shown in the plan card.",
				},
				"content": map[string]interface{}{
					"type":        "string",
					"description": "Full markdown plan content.",
				},
				"kind": map[string]interface{}{
					"type":        "string",
					"description": "Artifact kind. Use implementation_plan for implementation plans.",
				},
			},
			"required": []string{"content"},
		},
	})

	// Add LSP tools
	defs = append(defs, ToolDefinition{
		Name:        "get_diagnostics",
		Description: "Get diagnostics (errors/warnings) for a file from the IDE.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{
					"type":        "string",
					"description": "File path to check",
				},
			},
			"required": []string{"path"},
		},
	}, ToolDefinition{
		Name:        "get_definitions",
		Description: "Get symbol definitions via LSP (Go to Definition). Preferred over read_definitions for precise lookups.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{
					"type":        "string",
					"description": "File path",
				},
				"line": map[string]interface{}{
					"type":        "integer",
					"description": "Line number (1-indexed)",
				},
				"character": map[string]interface{}{
					"type":        "integer",
					"description": "Character position (0-indexed)",
				},
			},
			"required": []string{"path", "line", "character"},
		},
	}, ToolDefinition{
		Name:        "get_references",
		Description: "Find all references to a symbol via LSP.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":      map[string]interface{}{"type": "string", "description": "File path"},
				"line":      map[string]interface{}{"type": "integer", "description": "Line number (1-indexed)"},
				"character": map[string]interface{}{"type": "integer", "description": "Character position (0-indexed)"},
			},
			"required": []string{"path", "line", "character"},
		},
	}, ToolDefinition{
		Name:        "get_symbols",
		Description: "Get all symbols (functions, classes, variables) in a file via LSP.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path": map[string]interface{}{"type": "string", "description": "File path"},
			},
			"required": []string{"path"},
		},
	}, ToolDefinition{
		Name:        "get_implementations",
		Description: "Find implementations of an interface or abstract method via LSP.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":      map[string]interface{}{"type": "string", "description": "File path"},
				"line":      map[string]interface{}{"type": "integer", "description": "Line number (1-indexed)"},
				"character": map[string]interface{}{"type": "integer", "description": "Character position (0-indexed)"},
			},
			"required": []string{"path", "line", "character"},
		},
	}, ToolDefinition{
		Name:        "get_workflows",
		Description: "Get list of available workflow commands defined in .agent/workflows. Used for autocomplete.",
		InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	})

	// Add Task Workspace tools
	// StartSwarmTool and UpdatePlanTool are registered dynamically in Controller, so we don't add them here to avoid duplicates.
	defs = append(defs, TaskBoundaryTool)

	// Add browser tools
	defs = append(defs, ToolDefinition{
		Name:        "browser_open",
		Description: "Open a URL in the browser",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"url": map[string]interface{}{"type": "string"},
			},
			"required": []string{"url"},
		},
	}, ToolDefinition{
		Name:        "browser_screenshot",
		Description: "Capture a screenshot of a URL",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"url": map[string]interface{}{"type": "string"},
			},
			"required": []string{"url"},
		},
	}, ToolDefinition{
		Name:        "browser_click",
		Description: "Click an element by selector",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"url":      map[string]interface{}{"type": "string"},
				"selector": map[string]interface{}{"type": "string"},
			},
			"required": []string{"url", "selector"},
		},
	}, ToolDefinition{
		Name:        "browser_type",
		Description: "Type text into an element",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"url":      map[string]interface{}{"type": "string"},
				"selector": map[string]interface{}{"type": "string"},
				"text":     map[string]interface{}{"type": "string"},
			},
			"required": []string{"url", "selector", "text"},
		},
	})

	// Add MCP tools
	if e.mcpHub != nil {
		mcpTools := e.mcpHub.GetTools()
		for _, t := range mcpTools {
			// Convert InputSchema using JSON marshaling for safety
			var schema map[string]interface{}
			schemaBytes, _ := json.Marshal(t.InputSchema)
			_ = json.Unmarshal(schemaBytes, &schema)

			defs = append(defs, ToolDefinition{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: schema,
			})
		}
	}

	// Add Dynamic Tools
	for _, tool := range e.dynamicTools {
		defs = append(defs, tool)
	}

	// Add Terminal Tools (Phase 12)
	defs = append(defs, ToolDefinition{
		Name:        "start_terminal",
		Description: "Start a persistent terminal session (PTY). Use this for interactive commands or multiple commands in the same shell (retains env/alias).",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"command": map[string]interface{}{"type": "string", "description": "Command to start (e.g. /bin/zsh, python3, top). Default: /bin/sh"},
				"cwd":     map[string]interface{}{"type": "string", "description": "Working directory"},
			},
		},
	}, ToolDefinition{
		Name:        "send_input",
		Description: "Send text input to a running terminal session.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id":   map[string]interface{}{"type": "string", "description": "Terminal ID"},
				"text": map[string]interface{}{"type": "string", "description": "Text to send (e.g. 'ls\\n')"},
			},
			"required": []string{"id", "text"},
		},
	}, ToolDefinition{
		Name:        "read_terminal",
		Description: "Read output from a terminal session.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{"type": "string", "description": "Terminal ID"},
			},
			"required": []string{"id"},
		},
	}, ToolDefinition{
		Name:        "create_checkpoint",
		Description: "Create a backup checkpoint of the entire workspace. Use before making risky changes.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"message": map[string]interface{}{"type": "string", "description": "Reason for checkpoint"},
			},
			"required": []string{"message"},
		},
	})

	// Add Memory Tools (Phase 15)
	defs = append(defs, ToolDefinition{
		Name:        "remember",
		Description: "Store a permanent fact or lesson learned in the project memory.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"key":   map[string]interface{}{"type": "string", "description": "Key/Topic (e.g. 'deploy_cmd')"},
				"value": map[string]interface{}{"type": "string", "description": "Information to store"},
			},
			"required": []string{"key", "value"},
		},
	}, ToolDefinition{
		Name:        "recall",
		Description: "Search persistent memories by query.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string", "description": "Search text"},
			},
			"required": []string{"query"},
		},
	})

	// Add Web Search tool
	defs = append(defs, ToolDefinition{
		Name:        "web_search",
		Description: "Search the web for information. Use this to find documentation, APIs, solutions to errors, or any external information needed.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{
					"type":        "string",
					"description": "Search query",
				},
				"max_results": map[string]interface{}{
					"type":        "integer",
					"description": "Maximum number of results (1-10, default 5)",
				},
			},
			"required": []string{"query"},
		},
	})

	// Add Batch Edit tool
	defs = append(defs, ToolDefinition{
		Name:        "batch_edit",
		Description: "Apply multiple file edits (write or search/replace) in a single atomic-like operation. This is efficient for large-scale changes.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"edits": map[string]interface{}{
					"type": "array",
					"items": map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"path":                map[string]interface{}{"type": "string", "description": "File path"},
							"type":                map[string]interface{}{"type": "string", "enum": []string{"write", "replace"}, "description": "Type of edit"},
							"content":             map[string]interface{}{"type": "string", "description": "New content for type='write'"},
							"target_content":      map[string]interface{}{"type": "string", "description": "Target content to find for type='replace'"},
							"replacement_content": map[string]interface{}{"type": "string", "description": "Replacement content for type='replace'"},
						},
						"required": []string{"path", "type"},
					},
				},
			},
			"required": []string{"edits"},
		},
	})

	// Add Subagent tool
	defs = append(defs, ToolDefinition{
		Name:        "subagent",
		Description: "Delegate a complex task to a background worker agent. The worker operates autonomously and reports back once finished. Use this for parallel research or large-scale implementation.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"prompt": map[string]interface{}{
					"type":        "string",
					"description": "The detailed instructions for the worker agent.",
				},
				"description": map[string]interface{}{
					"type":        "string",
					"description": "Brief description of the task (for TUI).",
				},
				"task_id": map[string]interface{}{
					"type":        "string",
					"description": "Optional: Link to a task ID from the Master Plan.",
				},
			},
			"required": []string{"prompt"},
		},
	})

	// Add Scratchpad tools
	defs = append(defs, ToolDefinition{
		Name:        "write_scratchpad",
		Description: "Write or update a note in the shared scratchpad. Use this to share findings with other agents.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name": map[string]interface{}{
					"type":        "string",
					"description": "The name of the note (e.g. 'research_findings').",
				},
				"content": map[string]interface{}{
					"type":        "string",
					"description": "The content of the note.",
				},
			},
			"required": []string{"name", "content"},
		},
	})

	defs = append(defs, ToolDefinition{
		Name:        "read_scratchpad",
		Description: "Read all current notes from the shared scratchpad.",
		InputSchema: map[string]interface{}{
			"type": "object",
		},
	})

	return defs
}

// Helper for memory init
func mustCreateMemory(cwd string) *memory.Manager {
	m, _ := memory.NewManager(cwd) // Swallow error for MVP, just returns nil or empty
	return m
}

func (e *NativeExecutor) Remember(ctx context.Context, args json.RawMessage) (string, error) {
	if e.memory == nil {
		return "", fmt.Errorf("memory manager not initialized")
	}
	var payload struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := e.memory.Set(payload.Key, payload.Value); err != nil {
		return "", fmt.Errorf("failed to save memory: %w", err)
	}
	return fmt.Sprintf("Remembered: %s = %s", payload.Key, payload.Value), nil
}

func (e *NativeExecutor) Recall(ctx context.Context, args json.RawMessage) (string, error) {
	if e.memory == nil {
		return "", fmt.Errorf("memory manager not initialized")
	}
	var payload struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	items := e.memory.Search(payload.Query, 10)
	if len(items) == 0 {
		return "No relevant memories found.", nil
	}

	var sb strings.Builder
	sb.WriteString("Found memories:\n")
	for _, item := range items {
		sb.WriteString(fmt.Sprintf("- %s: %s\n", item.Key, item.Value))
	}
	return sb.String(), nil
}

func (e *NativeExecutor) StartTerminal(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Command string `json:"command"`
		Cwd     string `json:"cwd"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	cmd := payload.Command
	if cmd == "" {
		cmd = "/bin/sh"
	}

	cwd := payload.Cwd
	if cwd == "" {
		cwd = e.host.GetCWD()
	} else {
		cwd = filepath.Join(e.host.GetCWD(), cwd) // Resolve relative
	}

	session, err := e.ptyManager.Start(cmd, nil, cwd, nil)
	if err != nil {
		return "", fmt.Errorf("failed to start terminal: %w", err)
	}

	return fmt.Sprintf("Terminal started. ID: %s. Use send_input/read_terminal to interact.", session.ID), nil
}

func (e *NativeExecutor) SendTerminalInput(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	err := e.ptyManager.WriteInput(payload.ID, payload.Text)
	if err != nil {
		return "", fmt.Errorf("failed to send input: %w", err)
	}
	// Auto-read after input?
	// Let's verify output immediately for better feedback loop.
	// Give it a tiny delay for processing?
	// For now, return confirmation.
	return "Input sent.", nil
}

func (e *NativeExecutor) ReadTerminalOutput(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	output, err := e.ptyManager.ReadOutput(payload.ID)
	if err != nil {
		return "", fmt.Errorf("failed to read output: %w", err)
	}

	if output == "" {
		return "(No new output)", nil
	}
	return output, nil
}

func (e *NativeExecutor) ExecutePythonTool(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Script string `json:"script"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	return ExecutePython(ctx, payload.Script)
}

func (e *NativeExecutor) SwitchMode(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := e.modes.SetMode(payload.Mode); err != nil {
		return "", err
	}

	mode := e.modes.GetActiveMode()
	return fmt.Sprintf("Successfully switched to %s mode. Current role: %s", mode.Name, mode.RoleDefinition), nil
}

func (e *NativeExecutor) CreateCheckpoint(ctx context.Context, args json.RawMessage) (string, error) {
	if e.safeguard == nil {
		return "", fmt.Errorf("safeguard not initialized")
	}

	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	hash, err := e.safeguard.CreateCheckpoint(payload.Message)
	if err != nil {
		return "", fmt.Errorf("checkpoint failed: %w", err)
	}

	return fmt.Sprintf("Checkpoint created. Hash: %s", hash), nil
}

func (e *NativeExecutor) RestoreCheckpoint(ctx context.Context, args json.RawMessage) (string, error) {
	if e.safeguard == nil {
		return "", fmt.Errorf("safeguard not initialized")
	}

	var payload struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := e.safeguard.RestoreCheckpoint(payload.Hash); err != nil {
		return "", fmt.Errorf("restore failed: %w", err)
	}

	return fmt.Sprintf("Successfully restored to checkpoint %s", payload.Hash), nil
}

func (e *NativeExecutor) ReadDefinitions(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if e.ignoreMatcher != nil {
		if err := e.ignoreMatcher.CheckPath(payload.Path); err != nil {
			return "", fmt.Errorf("ricochetignore: %w", err)
		}
	}

	targetPath, err := e.resolvePath(ctx, payload.Path)
	if err != nil {
		return "", err
	}

	// Read content
	content, err := os.ReadFile(targetPath)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
	}

	ext := filepath.Ext(targetPath)
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Definitions in %s:\n", filepath.Base(targetPath)))

	// Use native Go parser for .go files
	if ext == ".go" {
		defs, err := parser.ParseGo(content)
		if err != nil {
			return "", fmt.Errorf("parse error: %w", err)
		}
		if len(defs) == 0 {
			return "No definitions found.", nil
		}
		for _, d := range defs {
			sb.WriteString(fmt.Sprintf("- [%s] %s (Lines %d-%d)\n", d.Type, d.Name, d.LineStart, d.LineEnd))
		}
		return sb.String(), nil
	}

	// Use Tree-sitter for other languages
	supportedExts := map[string]bool{
		".js": true, ".jsx": true, ".mjs": true,
		".ts": true, ".tsx": true,
		".py": true,
		".rs": true,
		".go": true,
	}

	if !supportedExts[ext] {
		return "", fmt.Errorf("unsupported file type: %s (supported: .go, .js, .ts, .py, .rs)", ext)
	}

	langParser := contextPkg.NewLanguageParser()
	defer langParser.Close()

	analysis, err := langParser.ParseDefinitions(ctx, targetPath, content)
	if err != nil {
		return "", fmt.Errorf("tree-sitter parse error: %w", err)
	}

	if len(analysis.Definitions) == 0 {
		return "No definitions found.", nil
	}

	for _, d := range analysis.Definitions {
		sb.WriteString(fmt.Sprintf("- [%s] %s (Lines %d-%d)\n", d.Type, d.Name, d.LineStart, d.LineEnd))
	}

	return sb.String(), nil
}

// IsSafeCommand returns true if the command is a read-only or safe operation
func IsSafeCommand(command string) bool {
	command = strings.TrimSpace(command)
	if command == "" {
		return true
	}

	parts := strings.Fields(command)
	if len(parts) == 0 {
		return true
	}
	base := parts[0]

	// Strip path if present in base (e.g. /bin/ls -> ls)
	if lastSlash := strings.LastIndex(base, "/"); lastSlash != -1 {
		base = base[lastSlash+1:]
	}

	safeCommands := map[string]bool{
		"pwd":    true,
		"ls":     true,
		"dir":    true,
		"echo":   true,
		"cat":    true,
		"head":   true,
		"tail":   true,
		"grep":   true,
		"find":   true,
		"date":   true,
		"whoami": true,
		"df":     true,
		"du":     true,
		"ps":     true,
		"uname":  true,
		"file":   true,
		"type":   true,
		"which":  true,
		"top":    true,
	}

	if safeCommands[base] {
		return true
	}

	// Special cases for git read-only commands
	if base == "git" && len(parts) > 1 {
		sub := parts[1]
		gitSafe := map[string]bool{
			"status":    true,
			"diff":      true,
			"log":       true,
			"branch":    true,
			"remote":    true,
			"show":      true,
			"rev-parse": true,
			"ls-files":  true,
			"config":    true, // Usually safe to read
			"tag":       true,
			"describe":  true,
		}
		if gitSafe[sub] {
			return true
		}
	}

	return false
}

// Helper methods from fs_tools.go need to be accessible. They are methods on NativeExecutor.
// I will assume ListDir, ReadFile etc are correctly defined in fs_tools.go.
// I see I added ListDir implementation at bottom of my previous code block...
// Wait, I see `d.ListDir(args)` in switch...
// Ah, `e.ListDir` is method in `fs_tools.go`.
// So I don't need to implement it here.
// BUT, `ReadDefinitions` IS in `executor.go`.
// So I must include `ReadDefinitions`, `SwitchMode`, `RestoreCheckpoint`.
// And I must NOT include `ListDir` etc if they are in `fs_tools.go`.
// I will double check Step 2869 content.
// Yes, ListDir is NOT in executor.go.
// So my content above includes `ReadDefinitions`, `SwitchMode`, `RestoreCheckpoint` and calls `e.ListDir`.
// Wait, I added `ListDir` stub at the bottom of the rewrite block in `task_boundary` thought? No.
// I added `ListDir` implementation in the code block above?
// NO, I added func `(e *NativeExecutor) ListDir...`.
// THIS IS WRONG if it is already in `fs_tools.go`.
// I should REMOVE `ListDir` from my overwrite content if it conflicts.
// I'll check `fs_tools.go` again.
