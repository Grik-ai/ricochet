package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/mcp"
)

// handleSlashCommand processes commands like /help, /status, /permissions
func (m *Model) handleSlashCommand(input string) (string, tea.Cmd) {
	parts := strings.Fields(input)
	if len(parts) == 0 {
		return "", nil
	}
	cmd := parts[0]
	// args := parts[1:]

	switch cmd {
	case "/help", "?":
		helpText := `
**Available Commands:**
- **/help** or **?**: Show this help
- **/model <name> [provider] [key]**: Switch AI model (Configures settings.json)
- **/auto <N>**: Engage Auto-Pilot for N steps
- **/status**: Show current session insights
- **/init**: Initialize a new project (scan codebase)
- **/permissions**: Manage security permissions
- **/checkpoint**: Save current state
- **/restore <hash>**: Restore to a checkpoint
- **/memory**: Show long-term memory stats
- **/hooks**: List active hooks
- **/extensions**: Manage MCP extensions (install, uninstall, list)
- **/ether**: Remote control (Telegram)
- **/demo**: Run feature demo
- **/clear**: Clear screen
- **/exit**: Quit
`
		return helpText, nil

	case "/model":
		if len(parts) < 2 {
			current := fmt.Sprintf("Current Model: **%s**", m.ModelName)
			if m.SettingsStore != nil {
				s := m.SettingsStore.Get()
				current += fmt.Sprintf("\nProvider: **%s**", s.Provider.Provider)
			}
			return current + "\nUsage: `/model <name> [provider] [key]`\nExample: `/model gemini-pro gemini`", nil
		}

		modelName := parts[1]
		provider := ""
		key := ""
		if len(parts) > 2 {
			provider = parts[2]
		}
		if len(parts) > 3 {
			key = parts[3]
		}

		if m.SettingsStore == nil {
			return "Configuration store unreachable.", nil
		}

		err := m.SettingsStore.Update(func(s *config.Settings) {
			s.Provider.Model = modelName
			if provider != "" {
				s.Provider.Provider = provider
			}
			if key != "" {
				s.Provider.APIKey = key
			}
		})

		if err != nil {
			return fmt.Sprintf("Failed to update settings: %v", err), nil
		}

		// Update local state for immediate visual feedback (though effective change needs restart for provider)
		m.ModelName = modelName
		return fmt.Sprintf("✅ Configuration saved.\nModel: **%s**\n\n> ⚠️ Please restart Ricochet to apply provider changes.", modelName), nil

	case "/auto":
		if len(parts) < 2 {
			return "Usage: /auto <N> (e.g., /auto 5)", nil
		}
		var n int
		if _, err := fmt.Sscanf(parts[1], "%d", &n); err != nil {
			return "Invalid number.", nil
		}
		m.AutoStepsRemaining = n
		return fmt.Sprintf("🟣 Auto-Pilot Engaged: %d steps allowed.", n), nil

	case "/permissions":
		// NEW FEATURE: Verify permissions
		sg := m.Controller.GetSafeguard()
		if sg == nil || sg.PermissionStore == nil {
			return "Safeguard not initialized.", nil
		}

		// rules := sg.PermissionStore.ExportRules() // Pending implementation access

		status := fmt.Sprintf("**Security Status**:\n- Auto-Approval: %v\n", sg.AutoApproval != nil && sg.AutoApproval.Enabled)

		// For now, let's just show a placeholder if we can't reach internal state.
		return status + "\n(Detailed rule listing coming soon)", nil

	case "/commit":
		gitMgr := m.Controller.GetGitManager()
		if !gitMgr.IsRepo() {
			return "Current directory is not a git repository.", nil
		}

		status, err := gitMgr.Status()
		if err != nil {
			return fmt.Sprintf("Git status error: %v", err), nil
		}
		if status == "" {
			return "Nothing to commit (working directory clean).", nil
		}

		// If message provided, clean and commit
		if len(parts) > 1 {
			msg := strings.Join(parts[1:], " ")
			if err := gitMgr.StageAll(); err != nil {
				return fmt.Sprintf("Failed to stage changes: %v", err), nil
			}
			if err := gitMgr.Commit(msg); err != nil {
				return fmt.Sprintf("Commit failed: %v", err), nil
			}
			return fmt.Sprintf("✅ Committed: %s", msg), nil
		}

		// Otherwise, generate message suggestions
		diff, err := gitMgr.Diff()
		if err != nil {
			return fmt.Sprintf("Git diff error: %v", err), nil
		}

		return "Generating commit message...", func() tea.Msg {
			// Run generation in background
			res, err := m.Controller.GenerateCommitMessage(context.Background(), diff)
			if err != nil {
				return SlashCmdResMsg{Command: "/commit", Response: fmt.Sprintf("Error generating message: %v", err)}
			}
			response := fmt.Sprintf("**Suggested Commit Message**:\n```\n%s\n```\nRun `/commit <message>` to confirm.", res)
			return SlashCmdResMsg{Command: "/commit", Response: response}
		}

	case "/plan":
		pm := m.Controller.GetPlanManager()
		if pm == nil {
			return "Plan Manager not available.", nil
		}

		if len(parts) == 1 {
			// Toggle Plan Mode
			m.IsPlanMode = !m.IsPlanMode
			m.UpdateViewport() // Force refresh
			state := "ENABLED"
			if !m.IsPlanMode {
				state = "DISABLED"
			}
			return fmt.Sprintf("Plan Mode %s", state), nil
		}

		action := parts[1]
		switch action {
		case "add":
			if len(parts) < 3 {
				return "Usage: /plan add <title>", nil
			}
			title := strings.Join(parts[2:], " ")
			id, err := pm.AddTask(title, title)
			if err != nil {
				return fmt.Sprintf("Error adding task: %v", err), nil
			}
			m.UpdateViewport()
			return fmt.Sprintf("✅ Added task %s: \"%s\"", id, title), nil

		case "done", "finish":
			if len(parts) < 3 {
				return "Usage: /plan done <id>", nil
			}
			id := parts[2]
			if err := pm.UpdateTaskStatus(id, "done"); err != nil {
				return fmt.Sprintf("Error updating task: %v", err), nil
			}
			m.UpdateViewport()
			return fmt.Sprintf("✅ Task %s marked as done", id), nil

		case "rm", "remove":
			if len(parts) < 3 {
				return "Usage: /plan rm <id>", nil
			}
			id := parts[2]
			if err := pm.RemoveTask(id); err != nil {
				return fmt.Sprintf("Error removing task: %v", err), nil
			}
			m.UpdateViewport()
			return fmt.Sprintf("🗑️ Task %s removed", id), nil

		default:
			return "Unknown plan action. Use add, done, or rm.", nil
		}

	case "/extensions":
		if len(parts) < 2 {
			return "Usage:\n- /extensions list\n- /extensions discover\n- /extensions install <name> <command> [args...]\n- /extensions uninstall <name>", nil
		}

		action := parts[1]
		mgr := m.Controller.GetMcpManager()

		switch action {
		case "discover":
			recs, err := mcp.Detect(m.Cwd, mgr)
			if err != nil {
				return fmt.Sprintf("Error detecting extensions: %v", err), nil
			}
			if len(recs) == 0 {
				return "No new extensions recommended based on your workspace.", nil
			}
			var sb strings.Builder
			sb.WriteString("**Recommended Extensions** (found via Auto-LSP):\n")
			for _, item := range recs {
				sb.WriteString(fmt.Sprintf("\n**%s**\n", item.Name))
				sb.WriteString(fmt.Sprintf("  - Description: %s\n", item.Description))
				sb.WriteString(fmt.Sprintf("  - Install: `/extensions install %s %s %s`\n", item.Name, item.Command, strings.Join(item.Args, " ")))
			}
			return sb.String(), nil

		case "list":
			servers, err := mgr.ListServers()
			if err != nil {
				return fmt.Sprintf("Error listing servers: %v", err), nil
			}
			if len(servers) == 0 {
				return "No extensions installed.", nil
			}
			var sb strings.Builder
			sb.WriteString("**Installed Extensions**:\n")
			for name, cfg := range servers {
				status := "Enabled"
				if cfg.Disabled {
					status = "Disabled"
				}
				sb.WriteString(fmt.Sprintf("- **%s**: %s (%s %v)\n", name, status, cfg.Command, cfg.Args))
			}
			return sb.String(), nil

		case "install":
			if len(parts) < 4 {
				return "Usage: /extensions install <name> <command> [args...]", nil
			}
			name := parts[2]
			cmd := parts[3]
			args := parts[4:]

			config := mcp.McpServerConfig{
				Command: cmd,
				Args:    args,
			}

			if err := mgr.AddServer(name, config); err != nil {
				return fmt.Sprintf("Error installing extension: %v", err), nil
			}
			return fmt.Sprintf("✅ Extension **%s** installed successfully.", name), nil

		case "uninstall":
			if len(parts) < 3 {
				return "Usage: /extensions uninstall <name>", nil
			}
			name := parts[2]
			if err := mgr.RemoveServer(name); err != nil {
				return fmt.Sprintf("Error uninstalling extension: %v", err), nil
			}
			return fmt.Sprintf("🗑️ Extension **%s** uninstalled.", name), nil

		default:
			return "Unknown action. Use list, install, or uninstall.", nil
		}

	case "/status":
		// ... (Implementation from existing tui.go)
		return fmt.Sprintf("**Session ID**: %s\n**Model**: %s\n**Tokens Used**: ???", m.SessionID, m.ModelName), nil

	case "/clear":
		// Reset to initial state
		welcome, _ := RenderWelcomeContent(m.ModelName, m.Cwd)
		m.Blocks = []*HistoryBlock{
			{
				Type:    BlockAgentText,
				Content: welcome,
			},
		}
		m.Viewport.SetContent(welcome)
		return "Cleared history.", nil

	case "/exit":
		return "Goodbye!", tea.Quit

	case "/ether":
		// ... (Ether logic)
		return "", nil // Silent success

	case "/demo":
		return "Starting Demo Sequence (Debug Mode)...", func() tea.Msg {
			return DemoUpdateMsg(func(m *Model) {
				// Initialize demo with a system message block
				m.Blocks = append(m.Blocks, &HistoryBlock{
					Type:    BlockAgentText,
					Content: "Initializing Demo Sequence...",
				})
				m.recalculateViewportHeight()

				// Start the sequence runner
				go runDemoSequence(m.MsgChan)
			})
		}
	}

	return fmt.Sprintf("Unknown command: %s", cmd), nil
}

func runDemoSequence(msgChan chan tea.Msg) {
	// Step 1: Syntax Highlighting & Diff
	time.Sleep(500 * time.Millisecond)
	msgChan <- DemoUpdateMsg(func(m *Model) {
		m.appendUserBlock("Fix the concurrency bug in `main.go`.")

		// Agent Text Block
		textBlock := m.getOrCreateTextBlock()
		textBlock.Content = "I will modify `main.go` to fix the race condition.\n\n"
		diff := "```diff\n- func process() { time.Sleep(1) }\n+ func process() { time.Sleep(1 * time.Second) }\n```"
		textBlock.Content += diff

		// Tree Block
		m.Blocks = append(m.Blocks, &HistoryBlock{
			Type: BlockAgentTree,
			TaskTree: []*TaskNode{
				{ID: "1", Name: "Refactoring `main.go`", Status: "running", Expanded: true},
			},
			IsActive: true,
		})

		m.Thoughts = "Analyzing AST..."
		m.recalculateViewportHeight()
	})

	// Step 2: Error Recovery
	time.Sleep(800 * time.Millisecond)
	msgChan <- DemoUpdateMsg(func(m *Model) {
		// Update the active tree block
		block := m.ensureActiveTreeBlock()
		if len(block.TaskTree) > 0 {
			block.TaskTree[0].Children = append(block.TaskTree[0].Children, &TaskNode{ID: "2", Name: "Running tests...", Status: "failed", Meta: "Error"})
		}

		msgChan <- StreamMsg{Content: "\n\nStep 2: Error Simulated\nApologies, I missed an import. Fixing now...", Done: false}
		m.recalculateViewportHeight()
	})

	// Step 3: Token Limit Warning
	time.Sleep(800 * time.Millisecond)
	msgChan <- DemoUpdateMsg(func(m *Model) {
		// Just a text update
		msgChan <- StreamMsg{Content: "\n\n— Context compacted: 12k tokens removed —", Done: false}
		m.TokenUsage = 120000
		m.recalculateViewportHeight()
	})

	// Step 4: Autocomplete
	time.Sleep(800 * time.Millisecond)
	msgChan <- DemoUpdateMsg(func(m *Model) {
		m.Textarea.SetValue("/")
		m.Suggestions = []string{"/compact", "/help", "/cost"}
		m.ShowSuggestions = true
		msgChan <- StreamMsg{Content: "\n\nDemo Complete.", Done: true} // Finishes blocks
		m.recalculateViewportHeight()
	})
}

// runAsync wrapper for command execution (moved from tui.go)
func (m *Model) runAsync(input string, fn func() (string, error)) tea.Cmd {
	return func() tea.Msg {
		res, err := fn()
		return SlashCmdResMsg{Command: input, Response: res, Error: err}
	}
}
