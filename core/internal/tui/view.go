package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/lipgloss"
	"github.com/igoryan-dao/ricochet/internal/tui/keymap"
	"github.com/igoryan-dao/ricochet/internal/tui/style"
	"github.com/igoryan-dao/ricochet/internal/version"
)

func (m Model) View() string {
	if m.TerminalWidth <= 0 {
		return "Initializing..."
	}

	// 1. Header
	// 1. Header
	header := RenderDashboard(m)

	// 1.5 Mission Control (Dynamic Dashboard) - Rendered but composed later
	missionControl := RenderTaskDashboard(m)

	// 2. Viewport (Content)
	viewport := m.Viewport.View()

	// 3. Footer (Status + Mode)
	footer := RenderStatusBar(m)

	// 4. Input
	input := m.Textarea.View()
	if m.APIKeyPrompt != nil {
		input = m.Secret.View()
	}

	// Wrap Input in a Box
	input = style.BoxStyle.Width(m.TerminalWidth - 2).Render(input)

	// 5. Suggestions (Optional Overlay)
	suggestions := ""
	if m.ShowSuggestions {
		suggestions = m.renderSuggestions()
	}

	// Focus Styles
	if m.IsShellFocused {
		// Highlight Input Border when focused (if using box, border color changes)
		// We can change BoxStyle dynamically or just rely on focus indicator.
		// For now, let's keep it simple.
		// Dim Input
		input = lipgloss.NewStyle().Foreground(lipgloss.Color("240")).Render(input)
		// Highlight Viewport Border (if we had one) - Viewport is just text usually.
		viewport = lipgloss.NewStyle().Border(lipgloss.NormalBorder()).BorderForeground(style.Focus).Render(viewport)
	}

	// COMPOSITION:
	bottom := lipgloss.JoinVertical(lipgloss.Left, footer, input)

	if suggestions != "" {
		bottom = lipgloss.JoinVertical(lipgloss.Left, suggestions, bottom)
	}

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		viewport,
		missionControl, // Moved to bottom
		bottom,
	)
}

func (m *Model) UpdateViewport() {
	var sb strings.Builder

	// Plan Mode Override
	if m.IsPlanMode {
		m.Viewport.SetContent(RenderPlan(*m))
		m.Viewport.GotoBottom() // Optional: maybe GotoTop for plan is better? Let's default Plan to Top properly or Bottom.
		// Plans usually read from top.
		// But Viewport handles initialization.
		// If I switch views, I might want to reset scroll.
		// For now, let's just set content.
		return
	}

	// ========================
	// INTERLEAVED BLOCKS RENDERING (Claude Code-style)
	// ========================
	// Render blocks sequentially: User → Tree → Text → Tree
	// Each tree is isolated to its block, not a monolithic global tree.

	// Clean up empty blocks before rendering
	m.cleanupEmptyBlocks()

	if len(m.Blocks) > 0 {
		for _, block := range m.Blocks {
			switch block.Type {
			case BlockUserQuery:
				// User message block
				renderedContent, _ := m.Renderer.Render(block.Content)
				renderedContent = strings.TrimSpace(renderedContent)
				bulletStyle := style.UserStyle.Width(2).Align(lipgloss.Center)
				formattedMsg := lipgloss.JoinHorizontal(lipgloss.Top,
					bulletStyle.Render(style.BulletUser),
					" ",
					style.UserStyle.Render(renderedContent),
				)
				sb.WriteString(formattedMsg + "\n\n")

			case BlockAgentTree:
				// Tool execution tree block
				if len(block.TaskTree) > 0 {
					sb.WriteString(RenderTaskTree(block.TaskTree, "", m.Spinner, block.IsActive))
					sb.WriteString("\n")
				}

			case BlockAgentText:
				// Agent text response block
				hasContent := strings.TrimSpace(block.Content) != ""

				if hasContent {
					// Render content
					renderedContent, _ := m.Renderer.Render(block.Content)
					renderedContent = strings.TrimSpace(renderedContent)
					bulletStyle := style.AgentStyle.Width(2).Align(lipgloss.Center)
					formattedMsg := lipgloss.JoinHorizontal(lipgloss.Top,
						bulletStyle.Render(style.BulletAgent),
						" ",
						style.AgentStyle.Render(renderedContent),
					)
					sb.WriteString(formattedMsg + "\n\n")
				}
			}
		}

		// Active loading indicator if last block is active tree with no text following
		if m.IsLoading {
			lastBlock := m.Blocks[len(m.Blocks)-1]
			if lastBlock.Type == BlockAgentTree && lastBlock.IsActive {
				// Spinner is already in the tree via RenderTaskTree, we're good
			} else if lastBlock.Type == BlockAgentText && strings.TrimSpace(lastBlock.Content) == "" {
				// Empty text block while loading - show a concise action label.
				status := "Working..."
				if m.CurrentStatusStr != "" {
					status = m.CurrentStatusStr
				} else if m.CurrentAction != "" {
					status = m.CurrentAction
				}
				bullet := m.Spinner.View()
				bulletStyle := style.AgentStyle.Width(2).Align(lipgloss.Center)
				formattedMsg := lipgloss.JoinHorizontal(lipgloss.Top,
					bulletStyle.Render(bullet),
					" ",
					style.ThinkingStyle.Render(status),
				)
				sb.WriteString(formattedMsg + "\n")
			}
		}
	}

	if timeline := RenderTimeline(m.Timeline, m.TerminalWidth-4); timeline != "" {
		sb.WriteString(timeline + "\n")
	}

	if m.ShowShortcuts {
		sb.WriteString("\n" + style.BoxStyle.BorderForeground(style.Focus).Render(keymap.RenderHelp()) + "\n")
	}

	// (Legacy activeStream section removed - now handled by BlockAgentText)

	// 4. Pending Thoughts/Spinner/Gate (Bottom Overlay)
	if m.PendingChoice != nil {
		// BATCH CONFIRMATION / CHOICE UI
		var choices strings.Builder
		for i, c := range m.PendingChoice.Choices {
			cursor := " "
			styleOpt := style.SystemStyle
			if i == m.ConfirmationIdx {
				cursor = ">"
				styleOpt = style.UserStyle // Highlight
			}
			choices.WriteString(fmt.Sprintf("%s %s\n", cursor, styleOpt.Render(c)))
		}

		box := style.BoxStyle.BorderForeground(style.Focus).Render(
			style.UserStyle.Bold(true).Render("? "+m.PendingChoice.Question) + "\n\n" +
				choices.String() + "\n" +
				style.SystemStyle.Render("[Up/Down] Select  [Enter] Confirm  [Esc] Deny"),
		)
		sb.WriteString("\n" + box + "\n")
	} else if m.PendingApproval != nil {
		diffView := ""
		if m.PendingApproval.Diff != "" {
			diffView = "\n\n" + RenderDiff(m.PendingApproval.Diff)
		}

		box := style.BoxStyle.BorderForeground(style.Yellow).Render(
			style.WarningStyle.Render("⚠ INTERCEPTION: SENSITIVE ACTION") + "\n\n" +
				m.PendingApproval.Question +
				diffView + "\n\n" +
				style.SystemStyle.Render("[Y] Confirm  [N] Deny  [A] Always Allow"),
		)
		sb.WriteString("\n" + box + "\n")
	} else if m.IsLoading {
		// NOTE: Thinking status is now ONLY shown in StatusBar to prevent duplication.
		// Transient thoughts still render here if any.
		if m.Thoughts != "" {
			lines := strings.Split(m.Thoughts, "\n")
			for _, line := range lines {
				if line != "" {
					sb.WriteString(style.SystemStyle.Render("  │ "+line) + "\n")
				}
			}
		}
	}

	m.Viewport.SetContent(sb.String())
	m.Viewport.GotoBottom()
}

// -- Components --

func RenderDashboard(m Model) string {
	if m.TerminalWidth <= 0 {
		return ""
	}

	w := m.TerminalWidth - 10
	if w < 0 {
		w = 0
	}

	if w < 50 {
		return style.HeaderStyle.Width(w).Render("Ricochet " + version.Display() + " • " + m.ModelName)
	}

	logo := style.HeaderLabelStyle.Render("Ricochet " + version.Display())
	modelInfo := fmt.Sprintf("Model: %s", m.ModelName)

	separator := " • "
	if m.IsLoading {
		// Use Spinner as separator or prefix
		separator = fmt.Sprintf(" %s ", m.Spinner.View())
	}

	left := logo + separator + style.SystemStyle.Render(modelInfo)
	hints := []string{
		keymap.Shortcut(keymap.ContextGlobal, keymap.ActionTogglePlan, "ctrl+p") + " Plan",
		keymap.Shortcut(keymap.ContextGlobal, keymap.ActionToggleEther, "ctrl+e") + " Ether",
		keymap.Shortcut(keymap.ContextChat, keymap.ActionModelPicker, "alt+m") + " Model",
		"/help",
	}
	right := style.SystemStyle.Render(strings.Join(hints, " • "))

	spaceCount := w - lipgloss.Width(left) - lipgloss.Width(right)
	if spaceCount < 1 {
		spaceCount = 1
	}
	spacer := strings.Repeat(" ", spaceCount)

	// Add top padding/margin to prevent clipping (External)
	// We return a newline + the rendered box
	return "\n" + style.HeaderStyle.Width(w).Render(left+spacer+right)
}

// detectToolType returns whether a tool should be rendered as "Inline" or "Block"
func detectToolType(name string) string {
	// Block Tools: Produce heavy output or side effects worth showing in a box
	switch name {
	case "view_file", "write_to_file", "replace_file_content", "run_command", "view_code_item":
		return "block"
	}
	// Inline Tools: Quick status checks or lightweight ops
	return "inline"
}

func RenderTaskTree(nodes []*TaskNode, prefix string, spin spinner.Model, isLoading bool) string {
	var sb strings.Builder

	for i, node := range nodes {
		isRealLast := i == len(nodes)-1

		// Determine if we need to append a synthetic activity tail AFTER this node
		wantsTail := isRealLast && isLoading && node.Status != "running" && len(node.Children) == 0

		// 1. Connector
		connector := "├─ "
		childPrefix := "│  "

		if isRealLast && !wantsTail {
			connector = "└─ "
			childPrefix = "   "
		}

		// Tool Type Detection
		toolType := detectToolType(node.Name)

		// 2. Render Node based on Type
		if toolType == "inline" {
			sb.WriteString(RenderInlineTool(node, prefix, connector, spin))
		} else {
			sb.WriteString(RenderBlockTool(node, prefix, connector, spin))
		}

		// 3. Render Block Output (Command Output / File Content)
		// Only for Block tools usually, or if Result is present and significant.
		// For Inline tools, we might skip detailed result unless it's an error.
		if node.Result != "" && toolType == "block" {
			if node.Status == "done" || node.Status == "completed" || node.Status == "failed" {
				sb.WriteString(RenderTerminalOutput(node.Result, prefix+childPrefix, node.Expanded))
			}
		}

		// 4. Recurse or Synthetic Tail
		if len(node.Children) > 0 {
			if node.Expanded {
				sb.WriteString(RenderTaskTree(node.Children, prefix+childPrefix, spin, isLoading))
			}
		} else if wantsTail {
			// Render the activity tail as a SIBLING (Same prefix)
			tailConnector := "└─ "
			sb.WriteString(fmt.Sprintf("%s%s%s %s\n",
				style.SystemStyle.Render(prefix),
				style.SystemStyle.Render(tailConnector),
				style.TreeActiveStyle.Render(spin.View()),
				style.ThinkingStyle.Render("Working..."),
			))
		}
	}
	return sb.String()
}

func RenderInlineTool(node *TaskNode, prefix, connector string, spin spinner.Model) string {
	icon := "○"
	s := style.TreeStyle
	textStyle := style.SystemStyle // Default dim

	switch node.Status {
	case "running":
		icon = spin.View()
		s = style.TreeActiveStyle
		textStyle = style.UserStyle // Highlight running
	case "completed", "done":
		icon = "✓"
		s = lipgloss.NewStyle().Foreground(style.Green)
		textStyle = style.SystemStyle // Dim completed inline tools to reduce noise
	case "failed":
		icon = "x"
		s = style.ErrorStyle
	}

	meta := ""
	if node.Meta != "" {
		meta = " " + style.MetaStyle.Render(node.Meta)
	}

	// Format: [Prefix][Connector][Icon] [Badge] [Name] [Meta]
	badge := ""
	if node.AgentName != "" {
		bg := lipgloss.Color(node.AgentColor)
		if node.AgentColor == "" {
			bg = style.Focus
		}
		badgeStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFFFF")).
			Background(bg).
			Padding(0, 1).
			Bold(true).
			MarginRight(1)
		badge = badgeStyle.Render(node.AgentName)
	}

	return fmt.Sprintf("%s%s%s %s%s%s\n",
		style.SystemStyle.Render(prefix),
		style.SystemStyle.Render(connector),
		s.Render(icon),
		badge,
		textStyle.Render(node.Name),
		meta,
	)
}

func RenderBlockTool(node *TaskNode, prefix, connector string, spin spinner.Model) string {
	// Block tools get a more prominent header
	// [Prefix][Connector] [Icon] [Name]

	icon := "□" // Box icon for blocks
	s := style.TreeStyle
	textStyle := style.UserStyle // Blocks are usually important

	switch node.Status {
	case "running":
		icon = spin.View()
		s = style.TreeActiveStyle
	case "completed", "done":
		icon = "■"
		s = lipgloss.NewStyle().Foreground(style.Green)
	case "failed":
		icon = "x"
		s = style.ErrorStyle
	}

	meta := ""
	if node.Meta != "" {
		meta = " " + style.MetaStyle.Render(node.Meta)
	}

	badge := ""
	if node.AgentName != "" {
		bg := lipgloss.Color(node.AgentColor)
		if node.AgentColor == "" {
			bg = style.Focus
		}
		badgeStyle := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFFFF")).
			Background(bg).
			Padding(0, 1).
			Bold(true).
			MarginRight(1)
		badge = badgeStyle.Render(node.AgentName)
	}

	return fmt.Sprintf("%s%s%s %s%s%s\n",
		style.SystemStyle.Render(prefix),
		style.SystemStyle.Render(connector),
		s.Render(icon),
		badge,
		textStyle.Render(node.Name),
		meta,
	)
}

func RenderStatusBar(m Model) string {
	w := m.TerminalWidth
	s := style.FooterStyle

	mode := "ACT"
	modeStyle := style.ActStyle
	if m.IsPlanMode {
		mode = "PLAN"
		modeStyle = style.PlanStyle
	}

	modeIndicator := fmt.Sprintf("[%s]", mode)

	statusText := "Ready"
	if m.IsLoading {
		statusText = "Working"
		if m.CurrentStatusStr != "" {
			statusText = m.CurrentStatusStr
		} else if m.CurrentAction != "" {
			statusText = m.CurrentAction
		}
	} else if m.PendingApproval != nil || m.PendingChoice != nil {
		statusText = "Waiting approval"
	} else if m.APIKeyPrompt != nil {
		statusText = "Waiting API key"
	}

	// Use ThinkingStyle for loading state to verify visibility
	var left string
	if m.IsLoading {
		left = style.ThinkingStyle.Render(fmt.Sprintf(" %s ", statusText))
	} else {
		left = s.Render(fmt.Sprintf(" %s ", statusText))
	}

	etherProps := ""
	if m.IsEtherMode {
		etherStyle := style.MutedStyle
		if m.IsEtherActive {
			etherStyle = style.FocusStyle.Bold(true)
		}
		etherProps = etherStyle.Render("[LIVE] ")
	}

	autoBadge := ""
	if m.AutoStepsRemaining > 0 {
		// Purple badge
		autoBadge = lipgloss.NewStyle().Foreground(lipgloss.Color("#9D65FF")).Bold(true).Render(fmt.Sprintf("[AUTO: %d] ", m.AutoStepsRemaining))
	}

	right := modeStyle.Render(modeIndicator + " ")

	spacer := strings.Repeat(" ", max(0, w-lipgloss.Width(left)-lipgloss.Width(right)-lipgloss.Width(etherProps)-lipgloss.Width(autoBadge)))

	return lipgloss.JoinHorizontal(lipgloss.Bottom, left, spacer, autoBadge, etherProps, right)
}

func (m Model) renderSuggestions() string {
	if len(m.Suggestions) == 0 {
		return ""
	}
	s := ""
	for i, sug := range m.Suggestions {
		if i == m.SelectedSuggestion {
			s += style.SelectionStyle.Render("> "+sug) + "\n"
		} else {
			s += style.SystemStyle.Render("  "+sug) + "\n"
		}
	}
	return style.BoxStyle.Render(s)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func RenderWelcomeContent(modelName, cwd string) (string, string) {
	logoStyle := style.HeaderLabelStyle

	textContent := fmt.Sprintf(`
Welcome to **Ricochet** (%s)
Model: *%s*
CWD: %s

Type **/help** for commands.
Type **?** for shortcuts.
`, version.Display(), modelName, cwd)

	return logoStyle.Render("Ricochet"), textContent
}

func RenderDiff(diff string) string {
	var sb strings.Builder
	lines := strings.Split(diff, "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "+") {
			sb.WriteString(lipgloss.NewStyle().Foreground(style.Green).Render(line) + "\n")
		} else if strings.HasPrefix(line, "-") {
			sb.WriteString(lipgloss.NewStyle().Foreground(style.Red).Render(line) + "\n")
		} else {
			sb.WriteString(style.SystemStyle.Render(line) + "\n")
		}
	}
	return sb.String()
}

func RenderTerminalOutput(text string, indent string, expanded bool) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) == 0 {
		return ""
	}

	// Style: Dim Gray (#767676)
	termStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#767676"))
	borderStyle := style.SystemStyle // Use system style for borders

	var sb strings.Builder

	// Truncation logic (Vertical)
	displayLines := lines
	truncated := false
	if !expanded && len(lines) > 5 {
		displayLines = lines[:5]
		truncated = true
	}

	// Top Border
	sb.WriteString(borderStyle.Render(indent+"┌"+strings.Repeat("─", 60)) + "\n")

	for _, line := range displayLines {
		// Truncation logic (Horizontal - prevent overflow)
		safeLine := truncateString(line, 500)
		sb.WriteString(borderStyle.Render(indent+"│ ") + termStyle.Render(safeLine) + "\n")
	}

	if truncated {
		msg := fmt.Sprintf("... (%d lines hidden, ctrl+r to expand)", len(lines)-5)
		sb.WriteString(borderStyle.Render(indent+"│ ") + style.MetaStyle.Render(msg) + "\n")
	}

	// Bottom Border
	sb.WriteString(borderStyle.Render(indent+"└"+strings.Repeat("─", 60)) + "\n")

	return sb.String()
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "... (truncated)"
}

// RenderTaskDashboard renders the "Master Plan" roadmap above the logs
func RenderTaskDashboard(m Model) string {
	w := m.TerminalWidth - 4 // Padding
	if w < 10 {
		return ""
	}
	if m.Controller == nil {
		return ""
	}

	pm := m.Controller.GetPlanManager()
	if pm == nil || len(pm.GetTasks()) == 0 {
		return "" // No tasks, hide dashboard
	}

	tasks := pm.GetTasks()

	// Box Style
	boxStyle := style.BoxStyle.
		Border(lipgloss.RoundedBorder()).
		BorderForeground(style.Border).
		Width(w).
		Padding(0, 1)

	var sb strings.Builder
	sb.WriteString(style.HeaderLabelStyle.Render("🧭 SWARM MISSION CONTROL") + "\n\n")

	for _, task := range tasks {
		icon := "[ ]"
		lineColor := style.SystemStyle
		statusText := ""

		// Check for active assignments in m.Tasks
		activeProg := m.Tasks[task.Title]

		// Determine visual state
		switch task.Status {
		case "done", "completed":
			icon = "[✓]"
			lineColor = lipgloss.NewStyle().Foreground(style.Green)
			statusText = lineColor.Render("(Completed)")

		case "active", "in_progress", "running":
			icon = "[⠋]"
			// If we have an active agent, show it
			if activeProg != nil && activeProg.AgentIdentifier != "" {
				badge := lipgloss.NewStyle().
					Foreground(lipgloss.Color("#000000")).
					Background(lipgloss.Color(activeProg.AgentColor)).
					Bold(true).
					Padding(0, 1).
					Render(activeProg.AgentIdentifier)
				statusText = badge
			} else {
				statusText = style.ActStyle.Render("(Running)")
			}
			lineColor = style.ActStyle // Highlight active task title
			// Use the model's spinner for animation?
			// We can't easily animate the text string here without state,
			// so we use a static char or simply depend on redraws.
			// The user asked for a spinner, but a text spinner requires frame tracking.
			// View() is re-called on tick, so if we use m.Spinner.View() it will animate!
			if m.IsLoading {
				icon = fmt.Sprintf("[%s]", m.Spinner.View())
			}

		case "failed":
			icon = "[x]"
			lineColor = style.ErrorStyle
			statusText = style.ErrorStyle.Render("(Failed)")

		case "pending":
			// Check blockage
			if len(task.Dependencies) > 0 {
				icon = "[🔒]"
				lineColor = lipgloss.NewStyle().Foreground(lipgloss.Color("#555555")) // Dim
				// Find dependency names/IDs
				deps := strings.Join(task.Dependencies, ", ")
				statusText = lineColor.Render(fmt.Sprintf("(waits for #%s)", deps))
			} else {
				icon = "[ ]"
				lineColor = style.SystemStyle
			}
		}

		// Render Line: [Icon] ID. Title ........ [Status/Badge]
		// Truncate title if needed
		title := task.Title

		// Calculate padding for right-alignment of status
		// This is tricky with simple string builder, so we just append.

		row := fmt.Sprintf("%s %s. %s", lineColor.Render(icon), task.ID, lineColor.Render(title))

		// Pad with dots? "Title ............ [Badge]"
		if statusText != "" {
			// Naive padding
			// Just space it out a bit
			row += fmt.Sprintf(" %s", statusText)
		}

		sb.WriteString(row + "\n")
	}

	return boxStyle.Render(sb.String())
}
