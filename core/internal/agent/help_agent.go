package agent

import (
	"strings"
)

// HelpAgent manages help-related queries
type HelpAgent struct {
	keywords []string
}

// NewHelpAgent creates a new help agent
func NewHelpAgent() *HelpAgent {
	return &HelpAgent{
		keywords: []string{
			"how do i", "how to", "what is", "help with",
			"/commands", "ricochet", "config", "settings",
			"usage", "tutorial", "guide",
		},
	}
}

// IsHelpQuery measures confidence that a query is a help request
func (h *HelpAgent) IsHelpQuery(input string) bool {
	lower := strings.ToLower(input)

	// Direct command
	if lower == "/help" || lower == "?" {
		return true
	}

	for _, kw := range h.keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// GetSystemPrompt returns the system prompt for the help agent
func (h *HelpAgent) GetSystemPrompt() string {
	return `You are the Ricochet CLI Help Agent.
Your goal is to assist users with using the Ricochet CLI tool, configuring it, and understanding its features.
You have access to the full documentation of Ricochet.

Key Features to explain if asked:
- **Modes**: Plan (read-only), Act (execution).
- **Commands**: /help, /status, /version, /login, /provider, /model, /apikey, /permissions, /mcp, /ether, /clear, /stop, /theme, /exit.
- **Workflow**: Auto-approval, safe guard, tool usage.
- **TUI**: ? shows shortcuts, Alt+M opens model selection, Alt+P opens provider selection, Ctrl+C interrupts an active run or exits when idle.

If the user asks about general coding or specific implementation similar to their project, politely inform them you are the Help Agent and switch context back to the main assistant if needed, or answer if it's about Ricochet's capabilities in that area.`
}
