package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/grikauth"
	"github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/tui/keymap"
	"github.com/igoryan-dao/ricochet/internal/tui/style"
	"github.com/igoryan-dao/ricochet/internal/version"
)

// handleSlashCommand processes commands like /help, /status, /permissions
func (m *Model) handleSlashCommand(input string) (string, tea.Cmd) {
	input = strings.TrimSpace(input)
	parts := strings.Fields(input)
	if len(parts) == 0 {
		return "", nil
	}
	cmd := parts[0]
	spec, ok := FindSlashCommand(cmd)
	if !ok || !spec.Implemented || spec.DevOnly && m.ModelName != "terminal-lab" {
		return fmt.Sprintf("Command `%s` is not available in this TUI build. Type `/help` to list working commands.", cmd), nil
	}
	cmd = spec.Name
	if reason := m.slashCommandDisabledReason(spec); reason != "" {
		return fmt.Sprintf("Command `%s` is unavailable: %s", cmd, reason), nil
	}

	switch cmd {
	case "/help", "?":
		target := ""
		if len(parts) > 1 {
			target = parts[1]
		}
		return RenderSlashHelp(target), nil

	case "/shortcuts", "/keymap":
		m.ShowShortcuts = true
		return keymap.RenderHelp(), nil

	case "/version":
		info := version.Get()
		return fmt.Sprintf("**Ricochet Core**\n- Version: `%s`\n- Commit: `%s`\n- Build time: `%s`\n- Executable: `%s`", info.Version, info.Commit, info.BuildTime, info.ExecutablePath), nil

	case "/model":
		return m.handleModelCommand(cmd, parts)

	case "/models":
		return "Use `/model` to list or select models. Use `/model refresh` to sync OpenRouter free models.", nil

	case "/provider":
		return m.handleProviderCommand(parts)

	case "/providers":
		return "Use `/provider` to list or select providers.", nil

	case "/apikey":
		return m.handleAPIKeyCommand(parts)

	case "/login":
		return "Starting Ricochet Cloud login...", m.loginCommand()

	case "/logout":
		if err := grikauth.ClearTokens(m.SettingsStore); err != nil {
			return fmt.Sprintf("Logout failed: %v", err), nil
		}
		if m.Controller != nil {
			if pm := m.Controller.GetProvidersManager(); pm != nil {
				pm.SetUserKey("grik", "")
			}
		} else if pm := m.providersManager(); pm != nil {
			pm.SetUserKey("grik", "")
		}
		return "Signed out of Ricochet Cloud/Grik.", nil

	case "/account", "/billing":
		return m.handleAccountCommand(cmd, parts)

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
		if len(parts) > 2 && parts[1] == "mode" {
			if m.SettingsStore == nil {
				return "Settings store unavailable.", nil
			}
			mode := parts[2]
			err := m.SettingsStore.Update(func(s *config.Settings) {
				applyTUIApprovalMode(s, mode)
			})
			if err != nil {
				return fmt.Sprintf("Failed to update approval mode: %v", err), nil
			}
			return fmt.Sprintf("Permission mode set to `%s`.", normalizeApprovalModeName(mode)), nil
		}

		if m.Controller == nil {
			return "Safeguard not initialized. Start a normal Ricochet session to inspect live permission rules.", nil
		}
		sg := m.Controller.GetSafeguard()
		if sg == nil || sg.PermissionStore == nil {
			return "Safeguard not initialized.", nil
		}

		rules := sg.PermissionStore.ListRules()
		audit := sg.PermissionStore.ListAudit()
		var sb strings.Builder
		sb.WriteString("**Security Status**\n")
		sb.WriteString("- Modes: `/permissions mode ask`, `/permissions mode auto`, `/permissions mode full`\n")
		sb.WriteString(fmt.Sprintf("- Auto-Approval: %v\n", sg.AutoApproval != nil && sg.AutoApproval.Enabled))
		sb.WriteString(fmt.Sprintf("- Rules: %d\n", len(rules)))
		sb.WriteString(fmt.Sprintf("- Audit entries: %d\n", len(audit)))
		for i, rule := range rules {
			if i >= 8 {
				sb.WriteString(fmt.Sprintf("- ...and %d more rules\n", len(rules)-i))
				break
			}
			target := firstNonEmpty(rule.CommandPrefix, rule.Path, "*")
			sb.WriteString(fmt.Sprintf("- `%s` %s `%s` (%s)\n", rule.Action, rule.Tool, target, rule.Scope))
		}
		return sb.String(), nil

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
		if m.Controller == nil {
			return "Plan Manager not available in this terminal-lab session.", nil
		}
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

	case "/extensions", "/mcp":
		if len(parts) < 2 {
			return "Usage:\n- /mcp list\n- /mcp discover\n- /mcp install <name> <command> [args...]\n- /mcp uninstall <name>\n\n`/extensions` is kept as an alias.", nil
		}

		action := parts[1]
		mgr := mcp.NewManager(paths.GetGlobalDir())

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
		if m.Controller == nil {
			return fmt.Sprintf("**Session ID**: %s\n**Model**: %s\n**Agent**: unavailable in terminal-lab", m.SessionID, m.ModelName), nil
		}
		usage := m.Controller.GetUsageSnapshot(m.SessionID)
		contextStatus := m.Controller.GetContextStatus(m.SessionID)
		liveStatus := "disabled"
		if m.LiveCtrl != nil {
			status := m.LiveCtrl.GetStatus()
			liveStatus = fmt.Sprintf("enabled=%v via=%s daemon=%v", status.Enabled, status.ConnectedVia, status.IsDaemon)
		}
		return fmt.Sprintf("**Session ID**: %s\n**Model**: %s\n**Tokens**: %d / %d (%.1f%%)\n**Cost**: $%.4f\n**Live/Ether**: %s",
			m.SessionID,
			m.ModelName,
			contextStatus.TokensUsed,
			contextStatus.TokensMax,
			contextStatus.Percentage,
			usage.EstimatedCostUSD,
			liveStatus,
		), nil

	case "/ps":
		activeCommands := 0
		for _, item := range m.Timeline {
			if item.Kind == "command" && item.Status == "running" {
				activeCommands++
			}
		}
		return fmt.Sprintf("**Agent State**\n- Active: `%v`\n- Current action: `%s`\n- Timeline items: `%d`\n- Running commands: `%d`", m.IsLoading, firstNonEmpty(m.CurrentAction, "idle"), len(m.Timeline), activeCommands), nil

	case "/stop":
		if m.Controller != nil && m.IsLoading {
			m.Controller.AbortCurrentSession()
			m.IsLoading = false
			m.CurrentAction = ""
			m.finishActiveBlocks()
			return "Active run aborted.", nil
		}
		return "No active run.", nil

	case "/transcript":
		return "Transcript view is the main scrollback. Use mouse/PageUp/PageDown to inspect history and `ctrl+r` to expand the latest command output.", nil

	case "/raw":
		m.ShowRawTimeline = !m.ShowRawTimeline
		return fmt.Sprintf("Raw timeline debug: `%v`.", m.ShowRawTimeline), nil

	case "/copy":
		return "Copy integration depends on the host terminal. Select text normally, or use `ctrl+r` to expand command output before copying.", nil

	case "/config":
		if m.SettingsStore == nil {
			return "Settings store unavailable.", nil
		}
		s := m.SettingsStore.Get()
		return fmt.Sprintf("**Settings**\n- Provider: `%s`\n- Model: `%s`\n- Auto-Approval: `%v`\n- Context auto-condense: `%v` at `%d%%`\n- Checkpoints: `%v`\n- Terminal output line limit: `%d`\n- Settings path: `%s`",
			s.Provider.Provider,
			s.Provider.Model,
			s.AutoApproval.Enabled,
			s.Context.AutoCondense,
			s.Context.CondenseThreshold,
			s.Context.EnableCheckpoints,
			s.Terminal.OutputLineLimit,
			filepath.Join(paths.GetGlobalDir(), "settings.json"),
		), nil

	case "/sessions":
		if m.Controller == nil {
			return "Session controller unavailable in this terminal-lab session.", nil
		}
		sessions := m.Controller.ListSessions()
		if len(sessions) == 0 {
			return "No sessions yet.", nil
		}
		var sb strings.Builder
		sb.WriteString("**Sessions**\n")
		for i, session := range sessions {
			if i >= 12 {
				sb.WriteString(fmt.Sprintf("- ...and %d more\n", len(sessions)-i))
				break
			}
			marker := " "
			if session.ID == m.SessionID {
				marker = "*"
			}
			messageCount := 0
			if session.StateHandler != nil {
				messageCount = len(session.StateHandler.GetMessages())
			}
			sb.WriteString(fmt.Sprintf("%s `%s` - messages=%d cost=$%.4f\n", marker, session.ID, messageCount, session.TotalCost))
		}
		return sb.String(), nil

	case "/resume":
		if m.Controller == nil {
			return "Session controller unavailable in this terminal-lab session.", nil
		}
		if len(parts) < 2 {
			return "Usage: /resume <session-id>", nil
		}
		session := m.Controller.CreateSessionWithID(parts[1])
		m.SessionID = session.ID
		m.Controller.SetMainSessionID(session.ID)
		if m.LiveCtrl != nil {
			m.LiveCtrl.SetMainSessionID(session.ID)
		}
		return fmt.Sprintf("Resumed session `%s`.", session.ID), nil

	case "/new":
		if m.Controller == nil {
			return "Session controller unavailable in this terminal-lab session.", nil
		}
		session := m.Controller.CreateSession()
		m.SessionID = session.ID
		m.Controller.SetMainSessionID(session.ID)
		if m.LiveCtrl != nil {
			m.LiveCtrl.SetMainSessionID(session.ID)
		}
		return fmt.Sprintf("New session `%s`.", session.ID), nil

	case "/usage":
		if m.Controller == nil {
			return "Usage data unavailable in this terminal-lab session.", nil
		}
		usage := m.Controller.GetUsageSnapshot(m.SessionID)
		data, _ := json.MarshalIndent(usage, "", "  ")
		return "```json\n" + string(data) + "\n```", nil

	case "/compact":
		if m.Controller == nil {
			return "Context compaction unavailable in this terminal-lab session.", nil
		}
		return "Compacting context...", func() tea.Msg {
			status, event, err := m.Controller.CompactContextNow(context.Background(), m.SessionID)
			if err != nil {
				return SlashCmdResMsg{Command: "/compact", Response: fmt.Sprintf("Context compaction failed: %v", err)}
			}
			return SlashCmdResMsg{Command: "/compact", Response: fmt.Sprintf("Context compacted: %.1f%% (%d/%d tokens). Event: `%s`", status.Percentage, status.TokensUsed, status.TokensMax, event.Event)}
		}

	case "/live", "/ether":
		if m.LiveCtrl == nil {
			return "Live/Ether is not initialized. Configure a Telegram token in settings, then restart Ricochet.", nil
		}
		if len(parts) > 1 {
			switch parts[1] {
			case "on", "enable", "start":
				return "Enabling Live/Ether...", func() tea.Msg {
					status, err := m.LiveCtrl.Enable(context.Background())
					if err != nil {
						return SlashCmdResMsg{Command: cmd, Response: err.Error()}
					}
					return SlashCmdResMsg{Command: cmd, Response: fmt.Sprintf("Live/Ether enabled via `%s`.", status.ConnectedVia)}
				}
			case "off", "disable", "stop":
				return "Disabling Live/Ether...", func() tea.Msg {
					status, err := m.LiveCtrl.Disable(context.Background())
					if err != nil {
						return SlashCmdResMsg{Command: cmd, Response: err.Error()}
					}
					return SlashCmdResMsg{Command: cmd, Response: fmt.Sprintf("Live/Ether enabled=%v.", status.Enabled)}
				}
			}
		}
		status := m.LiveCtrl.GetStatus()
		return fmt.Sprintf("**Live/Ether**\n- Enabled: `%v`\n- Transport: `%s`\n- Session: `%s`\n- Daemon: `%v`\n\nUsage: `/live enable` or `/live disable`", status.Enabled, status.ConnectedVia, status.SessionID, status.IsDaemon), nil

	case "/checkpoint":
		if m.Controller == nil {
			return "Checkpoint manager unavailable in this terminal-lab session.", nil
		}
		if len(parts) > 1 && parts[1] == "list" {
			checkpoints, err := m.Controller.ListCheckpoints()
			if err != nil {
				return fmt.Sprintf("Checkpoint list failed: %v", err), nil
			}
			if len(checkpoints) == 0 {
				return "No checkpoints yet.", nil
			}
			var sb strings.Builder
			sb.WriteString("**Checkpoints**\n")
			for _, checkpoint := range checkpoints {
				sb.WriteString(fmt.Sprintf("- `%s` %s\n", checkpoint.ID, checkpoint.Name))
			}
			return strings.TrimSpace(sb.String()), nil
		}
		name := "manual"
		if len(parts) > 1 {
			name = strings.Join(parts[1:], " ")
		}
		hash, err := m.Controller.SaveCheckpoint(name, nil)
		if err != nil {
			return fmt.Sprintf("Checkpoint failed: %v", err), nil
		}
		return fmt.Sprintf("Checkpoint saved: `%s`", hash), nil

	case "/restore":
		if m.Controller == nil {
			return "Checkpoint manager unavailable in this terminal-lab session.", nil
		}
		if len(parts) < 2 {
			return "Usage: `/restore <checkpoint-hash>`\nUse `/checkpoint list` to inspect checkpoints.", nil
		}
		if err := m.Controller.RestoreCheckpoint(parts[1]); err != nil {
			return fmt.Sprintf("Restore failed: %v", err), nil
		}
		return fmt.Sprintf("Restored checkpoint `%s`.", parts[1]), nil

	case "/diff":
		return renderLocalGitDiff(m.Cwd), nil

	case "/doctor":
		if m.SettingsStore == nil {
			return "Settings store unavailable.", nil
		}
		s := m.SettingsStore.Get()
		var sb strings.Builder
		sb.WriteString("**Ricochet Doctor**\n")
		sb.WriteString(fmt.Sprintf("- Settings: `%s`\n", filepath.Join(paths.GetGlobalDir(), "settings.json")))
		sb.WriteString(fmt.Sprintf("- Provider: `%s`\n", s.Provider.Provider))
		sb.WriteString(fmt.Sprintf("- Model: `%s`\n", s.Provider.Model))
		keyStatus := "missing"
		if s.Provider.APIKey != "" || s.Provider.APIKeys[s.Provider.Provider] != "" {
			keyStatus = "configured"
		}
		sb.WriteString(fmt.Sprintf("- Provider key: `%s`\n", keyStatus))
		sb.WriteString(fmt.Sprintf("- MCP settings: `%s`\n", filepath.Join(paths.GetGlobalDir(), "mcp_settings.json")))
		sb.WriteString(fmt.Sprintf("- Permissions: `%s`\n", filepath.Join(paths.GetGlobalDir(), "permissions.json")))
		return sb.String(), nil

	case "/review":
		if m.MsgChan == nil {
			return "Review command unavailable: TUI message channel is not initialized.", nil
		}
		scope := strings.TrimSpace(strings.TrimPrefix(input, "/review"))
		if scope == "" {
			scope = "the current workspace changes"
		}
		return "", func() tea.Msg {
			m.MsgChan <- RemoteInputMsg{Content: "Review " + scope + ". Prioritize bugs, regressions, security risks, and missing tests. Return findings first with file and line references where possible."}
			return nil
		}

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

	case "/theme":
		if m.SettingsStore == nil {
			return "Settings store unavailable.", nil
		}
		if len(parts) < 2 {
			current := m.SettingsStore.Get().Theme
			if current == "" {
				current = "dark"
			}
			return fmt.Sprintf("Current theme: `%s`\nUsage: `/theme dark`, `/theme mono`, or `/theme classic`.", current), nil
		}
		theme := strings.ToLower(strings.TrimSpace(parts[1]))
		switch theme {
		case "dark", "mono", "classic":
		default:
			return "Unknown theme. Use `dark`, `mono`, or `classic`.", nil
		}
		if err := m.SettingsStore.Update(func(s *config.Settings) { s.Theme = theme }); err != nil {
			return fmt.Sprintf("Failed to save theme: %v", err), nil
		}
		style.SetTheme(theme)
		m.UpdateViewport()
		return fmt.Sprintf("Theme set to `%s`.", theme), nil

	case "/exit":
		return "Goodbye!", tea.Quit

	case "/demo":
		fixture := "all"
		if len(parts) > 1 {
			fixture = parts[1]
		}
		if _, err := TerminalLabFixture(fixture); err != nil {
			return fmt.Sprintf("Unknown demo fixture `%s`. Available: %s", fixture, strings.Join(TerminalLabFixtureNames(), ", ")), nil
		}
		return fmt.Sprintf("Starting terminal dev lab fixture `%s`...", fixture), func() tea.Msg {
			return DemoUpdateMsg(func(m *Model) {
				m.Blocks = nil
				m.Timeline = nil
				m.CommandItems = make(map[string]*TimelineItem)
				m.ToolItems = make(map[string]*TimelineItem)
				m.RenderedSteps = make(map[string]int)
				m.Blocks = append(m.Blocks, &HistoryBlock{
					Type:    BlockAgentText,
					Content: fmt.Sprintf("Initializing terminal dev lab fixture `%s`...", fixture),
				})
				m.recalculateViewportHeight()

				go func() {
					if err := ReplayTerminalLabFixture(m.MsgChan, fixture, 1); err != nil {
						m.MsgChan <- LogMsg{Level: "error", Text: err.Error()}
					}
				}()
			})
		}
	}

	return fmt.Sprintf("Unknown command: %s", cmd), nil
}

func (m *Model) slashCommandDisabledReason(spec SlashCommandSpec) string {
	if spec.Name == "/stop" && !m.IsLoading {
		return "no active run."
	}
	if m.IsLoading && !spec.AvailableDuringRun {
		return "wait for the active run to finish, or use `/stop` first."
	}
	if m.Controller == nil {
		switch spec.Name {
		case "/sessions", "/new", "/resume":
			return "session controller is not initialized."
		case "/compact":
			return "context controller is not initialized."
		case "/plan":
			return "plan manager is not initialized."
		}
	}
	if spec.Name == "/review" && m.MsgChan == nil {
		return "TUI message channel is not initialized."
	}
	return ""
}

func (m *Model) handleModelCommand(cmd string, parts []string) (string, tea.Cmd) {
	if len(parts) > 1 && parts[1] == "refresh" {
		return "Refreshing OpenRouter free model catalog...", func() tea.Msg {
			pm := m.providersManager()
			if pm == nil {
				return SlashCmdResMsg{Command: cmd, Response: "Provider catalog unavailable."}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := pm.RefreshOpenRouterFreeModels(ctx); err != nil {
				return SlashCmdResMsg{Command: cmd, Response: fmt.Sprintf("Model refresh skipped: %v", err)}
			}
			return SlashCmdResMsg{Command: cmd, Response: m.renderModelPicker(pm.GetAvailableProviders())}
		}
	}

	if len(parts) < 2 {
		return m.renderModelPicker(m.availableProviders(false)), nil
	}

	if m.SettingsStore == nil {
		return "Configuration store unreachable.", nil
	}

	provider, modelName := parseProviderModel(parts[1])
	if modelName == "" {
		modelName = parts[1]
	}
	if provider == "" && len(parts) > 2 {
		provider = parts[2]
	}
	if provider == "" {
		provider = m.SettingsStore.Get().Provider.Provider
	}

	err := m.SettingsStore.Update(func(s *config.Settings) {
		s.Provider.Provider = provider
		s.Provider.Model = modelName
		if key, ok := s.Provider.APIKeys[provider]; ok && key != "" {
			s.Provider.APIKey = key
		}
	})
	if err != nil {
		return fmt.Sprintf("Failed to update settings: %v", err), nil
	}

	m.ModelName = modelName
	return fmt.Sprintf("Model saved: `%s:%s`.\nActive runs may need restart/reload to use provider changes.", provider, modelName), nil
}

func (m *Model) handleProviderCommand(parts []string) (string, tea.Cmd) {
	if len(parts) < 2 || parts[1] == "list" {
		return m.renderProviderPicker(m.availableProviders(false)), nil
	}
	if m.SettingsStore == nil {
		return "Settings store unavailable.", nil
	}

	switch parts[1] {
	case "set":
		if len(parts) < 3 {
			return "Usage: `/provider set <provider>`", nil
		}
		providerID := parts[2]
		modelID := ""
		for _, provider := range m.availableProviders(false) {
			if provider.ID != providerID {
				continue
			}
			modelID = preferredModel(provider)
			break
		}
		if modelID == "" {
			return fmt.Sprintf("Provider `%s` not found or has no models.", providerID), nil
		}
		if err := m.SettingsStore.Update(func(s *config.Settings) {
			s.Provider.Provider = providerID
			s.Provider.Model = modelID
			if key, ok := s.Provider.APIKeys[providerID]; ok {
				s.Provider.APIKey = key
			} else {
				s.Provider.APIKey = ""
			}
		}); err != nil {
			return fmt.Sprintf("Failed to update provider: %v", err), nil
		}
		m.ModelName = modelID
		return fmt.Sprintf("Provider saved: `%s`\nDefault model: `%s`", providerID, modelID), nil

	case "test", "doctor":
		if len(parts) < 3 {
			return "Usage: `/provider test <provider>`", nil
		}
		return m.renderProviderDoctor(parts[2]), nil

	case "models":
		if len(parts) < 3 {
			return "Usage: `/provider models <provider>`", nil
		}
		for _, provider := range m.availableProviders(false) {
			if provider.ID == parts[2] {
				return m.renderModelPicker([]config.AvailableProvider{provider}), nil
			}
		}
		return fmt.Sprintf("Provider `%s` not found.", parts[2]), nil
	}

	providerID := parts[1]
	return m.handleProviderCommand([]string{"/provider", "set", providerID})
}

func (m *Model) handleAPIKeyCommand(parts []string) (string, tea.Cmd) {
	if m.SettingsStore == nil {
		return "Settings store unavailable.", nil
	}
	if len(parts) < 2 || parts[1] == "status" {
		settings := m.SettingsStore.Get()
		var sb strings.Builder
		sb.WriteString("**BYOK key status**\n")
		for _, provider := range m.availableProviders(false) {
			status := "missing"
			if settings.Provider.APIKeys[provider.ID] != "" || (settings.Provider.Provider == provider.ID && settings.Provider.APIKey != "") {
				status = "configured"
			}
			sb.WriteString(fmt.Sprintf("- `%s`: %s\n", provider.ID, status))
		}
		sb.WriteString("\nUse `/apikey set <provider> <key>` or `/apikey remove <provider>`.")
		return strings.TrimSpace(sb.String()), nil
	}

	switch parts[1] {
	case "set":
		if len(parts) < 3 {
			return "Usage: `/apikey set <provider> [key]`", nil
		}
		if len(parts) < 4 {
			providerID := parts[2]
			m.APIKeyPrompt = &APIKeyPrompt{Provider: providerID}
			m.Secret.Reset()
			m.Secret.Placeholder = "Enter API key for " + providerID
			m.Secret.Focus()
			m.Textarea.Blur()
			return fmt.Sprintf("Enter API key for `%s`. Input is masked. Press Enter to save or Esc to cancel.", providerID), nil
		}
		providerID := parts[2]
		key := strings.Join(parts[3:], "")
		if err := m.saveProviderAPIKey(providerID, key); err != nil {
			return fmt.Sprintf("Failed to save API key: %v", err), nil
		}
		return fmt.Sprintf("API key saved for `%s`.", providerID), nil

	case "remove", "delete", "unset":
		if len(parts) < 3 {
			return "Usage: `/apikey remove <provider>`", nil
		}
		providerID := parts[2]
		if err := m.SettingsStore.Update(func(s *config.Settings) {
			delete(s.Provider.APIKeys, providerID)
			if s.Provider.Provider == providerID {
				s.Provider.APIKey = ""
			}
		}); err != nil {
			return fmt.Sprintf("Failed to remove API key: %v", err), nil
		}
		if pm := m.providersManager(); pm != nil {
			pm.SetUserKey(providerID, "")
		}
		return fmt.Sprintf("API key removed for `%s`.", providerID), nil
	}

	return "Usage: `/apikey status`, `/apikey set <provider> <key>`, or `/apikey remove <provider>`.", nil
}

func (m *Model) saveProviderAPIKey(providerID, key string) error {
	if m.SettingsStore == nil {
		return fmt.Errorf("settings store unavailable")
	}
	if err := m.SettingsStore.Update(func(s *config.Settings) {
		if s.Provider.APIKeys == nil {
			s.Provider.APIKeys = make(map[string]string)
		}
		s.Provider.APIKeys[providerID] = key
		if s.Provider.Provider == providerID {
			s.Provider.APIKey = key
		}
	}); err != nil {
		return err
	}
	if pm := m.providersManager(); pm != nil {
		pm.SetUserKey(providerID, key)
	}
	return nil
}

func (m *Model) handleAccountCommand(cmd string, parts []string) (string, tea.Cmd) {
	if cmd == "/billing" || len(parts) > 1 && parts[1] == "billing" {
		return "Fetching billing state...", func() tea.Msg {
			store := m.SettingsStore
			if store == nil {
				return SlashCmdResMsg{Command: cmd, Response: "Settings store unavailable."}
			}
			token, _ := grikauth.AccessToken(store.Get())
			if token == "" {
				return SlashCmdResMsg{Command: cmd, Response: "Not signed in. Run `/login` first."}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			billing, err := grikauth.NewClient().Billing(ctx, token)
			if err != nil {
				return SlashCmdResMsg{Command: cmd, Response: fmt.Sprintf("Billing unavailable: %v", err)}
			}
			data, _ := json.MarshalIndent(billing, "", "  ")
			return SlashCmdResMsg{Command: cmd, Response: "```json\n" + string(data) + "\n```"}
		}
	}

	if len(parts) > 1 && parts[1] == "models" {
		for _, provider := range m.availableProviders(false) {
			if provider.ID == "grik" {
				return m.renderModelPicker([]config.AvailableProvider{provider}), nil
			}
		}
		return "Subscription provider `grik` is not configured.", nil
	}

	if m.SettingsStore == nil {
		return "Settings store unavailable.", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	status := grikauth.Status(ctx, m.SettingsStore)
	var sb strings.Builder
	sb.WriteString("**Ricochet Cloud Account**\n")
	sb.WriteString(fmt.Sprintf("- Authenticated: `%v`\n", status.Authenticated))
	sb.WriteString(fmt.Sprintf("- Token source: `%s`\n", firstNonEmpty(status.TokenSource, "none")))
	sb.WriteString(fmt.Sprintf("- API: `%s`\n", status.APIBaseURL))
	if len(status.User) > 0 {
		if email := firstInterfaceString(status.User, "email", "username", "name", "id"); email != "" {
			sb.WriteString(fmt.Sprintf("- User: `%s`\n", email))
		}
	}
	sb.WriteString("\nCommands: `/login`, `/logout`, `/account billing`, `/account models`.")
	return sb.String(), nil
}

func (m *Model) loginCommand() tea.Cmd {
	return func() tea.Msg {
		store := m.SettingsStore
		if store == nil {
			return SlashCmdResMsg{Command: "/login", Response: "Settings store unavailable."}
		}
		client := grikauth.NewClient()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		defer cancel()
		code, err := client.StartDeviceLogin(ctx, "ricochet-tui")
		if err != nil {
			return SlashCmdResMsg{Command: "/login", Response: fmt.Sprintf("Login failed: %v", err)}
		}
		if m.MsgChan != nil {
			m.MsgChan <- SlashCmdResMsg{
				Command: "/login",
				Response: fmt.Sprintf("Open `%s`, continue with Google, and approve code `%s`.\nWaiting for approval until %s. Never share this code.",
					code.VerificationURL,
					code.UserCode,
					code.ExpiresAt.Format(time.Kitchen),
				),
			}
		}
		tokens, err := client.WaitForDeviceToken(ctx, code)
		if err != nil {
			return SlashCmdResMsg{Command: "/login", Response: fmt.Sprintf("Login failed: %v", err)}
		}
		if err := grikauth.SaveTokens(store, tokens); err != nil {
			return SlashCmdResMsg{Command: "/login", Response: fmt.Sprintf("Login succeeded but token save failed: %v", err)}
		}
		if pm := m.providersManager(); pm != nil {
			pm.SetUserKey("grik", tokens.AccessToken)
		}
		return SlashCmdResMsg{Command: "/login", Response: "Signed in to Ricochet Cloud/Grik. Subscription models are now available through `grik`."}
	}
}

func (m *Model) providersManager() *config.ProvidersManager {
	if m.Controller != nil {
		if pm := m.Controller.GetProvidersManager(); pm != nil {
			if m.SettingsStore != nil {
				settings := m.SettingsStore.Get()
				for providerID, key := range settings.Provider.APIKeys {
					pm.SetUserKey(providerID, key)
				}
			}
			return pm
		}
	}
	pm, err := config.NewProvidersManager(config.FindConfigFile())
	if err != nil {
		return nil
	}
	if m.SettingsStore != nil {
		settings := m.SettingsStore.Get()
		for providerID, key := range settings.Provider.APIKeys {
			pm.SetUserKey(providerID, key)
		}
	}
	return pm
}

func (m *Model) availableProviders(syncFree bool) []config.AvailableProvider {
	pm := m.providersManager()
	if pm == nil {
		return nil
	}
	if syncFree {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = pm.RefreshOpenRouterFreeModels(ctx)
		cancel()
	}
	return pm.GetAvailableProviders()
}

func (m *Model) renderProviderPicker(providers []config.AvailableProvider) string {
	settings := config.Settings{}
	if m.SettingsStore != nil {
		settings = m.SettingsStore.Get()
	}
	var sb strings.Builder
	sb.WriteString("**Providers**\n")
	sb.WriteString("Use `/provider set <provider>`, `/provider models <provider>`, `/provider test <provider>`, or `/apikey set <provider> <key>`.\n\n")
	for _, provider := range providers {
		marker := " "
		if settings.Provider.Provider == provider.ID {
			marker = "*"
		}
		status := "unavailable"
		if provider.Available {
			status = "available"
		}
		sb.WriteString(fmt.Sprintf("%s `%s` - %s, key=%s, access=%s, models=%d\n",
			marker,
			provider.ID,
			status,
			firstNonEmpty(provider.KeySource, "none"),
			firstNonEmpty(provider.AccessMode, "byok"),
			len(provider.Models),
		))
	}
	return strings.TrimSpace(sb.String())
}

func (m *Model) renderProviderDoctor(providerID string) string {
	for _, provider := range m.availableProviders(false) {
		if provider.ID != providerID {
			continue
		}
		status := "unavailable"
		if provider.Available {
			status = "available"
		}
		return fmt.Sprintf("**Provider `%s`**\n- Status: `%s`\n- Key source: `%s`\n- Access: `%s`\n- Has BYOK: `%v`\n- Models: `%d`",
			provider.ID,
			status,
			firstNonEmpty(provider.KeySource, "none"),
			firstNonEmpty(provider.AccessMode, "byok"),
			provider.HasUserKey,
			len(provider.Models),
		)
	}
	return fmt.Sprintf("Provider `%s` not found.", providerID)
}

func (m *Model) renderModelPicker(providers []config.AvailableProvider) string {
	settings := config.Settings{}
	if m.SettingsStore != nil {
		settings = m.SettingsStore.Get()
	}
	groups := []string{"Free", "BYOK", "Subscription", "Limited", "Deprecated"}
	byGroup := map[string][]string{}
	for _, provider := range providers {
		for _, model := range provider.Models {
			group := modelGroup(provider, model)
			marker := " "
			if settings.Provider.Provider == provider.ID && settings.Provider.Model == model.ID {
				marker = "*"
			}
			label := model.ID
			if model.Name != "" {
				label += " - " + model.Name
			}
			meta := []string{fmt.Sprintf("provider=%s", provider.ID)}
			if model.ContextWindow > 0 {
				meta = append(meta, fmt.Sprintf("ctx=%d", model.ContextWindow))
			}
			if model.SupportsTools {
				meta = append(meta, "tools")
			}
			if provider.KeySource != "" {
				meta = append(meta, "key="+provider.KeySource)
			}
			if provider.AccessMode != "" {
				meta = append(meta, "access="+provider.AccessMode)
			}
			if !provider.Available {
				meta = append(meta, "unavailable")
			}
			line := fmt.Sprintf("%s `%s:%s` %s (%s)", marker, provider.ID, model.ID, label, strings.Join(meta, ", "))
			byGroup[group] = append(byGroup[group], line)
		}
	}

	var sb strings.Builder
	sb.WriteString("**Model Picker**\n")
	sb.WriteString("Use `/model <provider>:<model>` to select. Use `/model refresh` to sync OpenRouter free models.\n\n")
	for _, group := range groups {
		lines := byGroup[group]
		if len(lines) == 0 {
			continue
		}
		sb.WriteString(fmt.Sprintf("**%s**\n", group))
		limit := len(lines)
		if limit > 12 {
			limit = 12
		}
		for _, line := range lines[:limit] {
			sb.WriteString(line + "\n")
		}
		if len(lines) > limit {
			sb.WriteString(fmt.Sprintf("- ...and %d more\n", len(lines)-limit))
		}
		sb.WriteString("\n")
	}
	return strings.TrimSpace(sb.String())
}

func modelGroup(provider config.AvailableProvider, model config.AvailableModel) string {
	switch {
	case model.Deprecated:
		return "Deprecated"
	case model.Limited:
		return "Limited"
	case model.RequiresSubscription || model.AccessMode == "subscription" || provider.AccessMode == "subscription":
		return "Subscription"
	case model.IsFree || model.AccessMode == "free":
		return "Free"
	default:
		return "BYOK"
	}
}

func preferredModel(provider config.AvailableProvider) string {
	if len(provider.Models) == 0 {
		return ""
	}
	for _, model := range provider.Models {
		if model.Recommended && !model.Deprecated && !model.Limited {
			return model.ID
		}
	}
	for _, model := range provider.Models {
		if !model.Deprecated && !model.Limited {
			return model.ID
		}
	}
	return provider.Models[0].ID
}

func parseProviderModel(value string) (string, string) {
	provider, model, ok := strings.Cut(value, ":")
	if !ok || strings.TrimSpace(provider) == "" || strings.TrimSpace(model) == "" {
		return "", ""
	}
	return strings.TrimSpace(provider), strings.TrimSpace(model)
}

func applyTUIApprovalMode(s *config.Settings, mode string) {
	switch normalizeApprovalModeName(mode) {
	case "ask":
		s.AutoApproval.Enabled = false
		s.AutoApproval.ExecuteAllCommands = false
	case "auto":
		s.AutoApproval.Enabled = true
		s.AutoApproval.ReadFiles = true
		s.AutoApproval.ExecuteSafeCommands = true
		s.AutoApproval.ExecuteAllCommands = false
	case "full":
		s.AutoApproval.Enabled = true
		s.AutoApproval.ReadFiles = true
		s.AutoApproval.EditFiles = true
		s.AutoApproval.ExecuteSafeCommands = true
		s.AutoApproval.ExecuteAllCommands = true
		s.AutoApproval.UseMCP = true
	}
}

func normalizeApprovalModeName(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "auto", "safe":
		return "auto"
	case "full", "danger", "dangerous", "full-access":
		return "full"
	default:
		return "ask"
	}
}

func firstInterfaceString(data map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := data[key]; ok {
			return strings.TrimSpace(fmt.Sprint(value))
		}
	}
	return ""
}

func renderLocalGitDiff(cwd string) string {
	if strings.TrimSpace(cwd) == "" {
		return "Cannot render diff: current working directory is unknown."
	}
	if err := exec.Command("git", "-C", cwd, "rev-parse", "--is-inside-work-tree").Run(); err != nil {
		return "Current directory is not a git repository."
	}

	stat, statErr := exec.Command("git", "-C", cwd, "diff", "--stat").CombinedOutput()
	diff, diffErr := exec.Command("git", "-C", cwd, "diff", "--", ".").CombinedOutput()
	if statErr != nil {
		return fmt.Sprintf("Git diff stat failed: %v\n%s", statErr, strings.TrimSpace(string(stat)))
	}
	if diffErr != nil {
		return fmt.Sprintf("Git diff failed: %v\n%s", diffErr, strings.TrimSpace(string(diff)))
	}

	statText := strings.TrimSpace(string(stat))
	diffText := strings.TrimSpace(string(diff))
	if statText == "" && diffText == "" {
		return "No unstaged git diff."
	}

	var sb strings.Builder
	sb.WriteString("**Git Diff**\n")
	if statText != "" {
		sb.WriteString("```text\n")
		sb.WriteString(limitLines(statText, 80))
		sb.WriteString("\n```\n")
	}
	if diffText != "" {
		sb.WriteString("\n```diff\n")
		sb.WriteString(limitLines(diffText, 220))
		sb.WriteString("\n```")
	}
	return sb.String()
}

func limitLines(value string, maxLines int) string {
	lines := strings.Split(value, "\n")
	if maxLines <= 0 || len(lines) <= maxLines {
		return value
	}
	omitted := len(lines) - maxLines
	trimmed := append([]string{}, lines[:maxLines]...)
	trimmed = append(trimmed, fmt.Sprintf("... %d more lines omitted", omitted))
	return strings.Join(trimmed, "\n")
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
