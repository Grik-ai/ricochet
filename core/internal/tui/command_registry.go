package tui

import (
	"fmt"
	"strings"
)

type SlashCommandSpec struct {
	Name               string
	Aliases            []string
	Usage              string
	Description        string
	Category           string
	Tier               SlashCommandTier
	AvailableDuringRun bool
	RemoteSafe         bool
	BridgeSafe         bool
	Source             string
	Implemented        bool
	Hidden             bool
	DevOnly            bool
}

type SlashCommandTier string

const (
	SlashCommandPrimary  SlashCommandTier = "primary"
	SlashCommandAdvanced SlashCommandTier = "advanced"
)

var slashCommandRegistry = []SlashCommandSpec{
	{Name: "/help", Aliases: []string{"?"}, Usage: "/help [all|command]", Description: "Show commands or details for one command.", Category: "Core", Tier: SlashCommandPrimary, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/shortcuts", Usage: "/shortcuts", Description: "Show configured keyboard shortcuts.", Category: "Core", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/keymap", Usage: "/keymap", Description: "Show keymap contexts and bindings.", Category: "Core", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/version", Usage: "/version", Description: "Show core version and executable diagnostics.", Category: "Core", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/status", Usage: "/status", Description: "Show session, model, usage, provider key, and Live/Ether state.", Category: "Core", Tier: SlashCommandPrimary, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/usage", Usage: "/usage", Description: "Show usage snapshot.", Category: "Core", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/doctor", Usage: "/doctor", Description: "Check local configuration health.", Category: "Core", Tier: SlashCommandAdvanced, Source: "builtin", Implemented: true},
	{Name: "/login", Usage: "/login", Description: "Sign in to Grik in your browser with Google-backed device approval.", Category: "Account", Tier: SlashCommandAdvanced, Source: "builtin", Implemented: true},
	{Name: "/logout", Usage: "/logout", Description: "Remove the saved Ricochet Cloud/Grik token.", Category: "Account", Tier: SlashCommandAdvanced, Source: "builtin", Implemented: true},
	{Name: "/account", Usage: "/account [billing|models]", Description: "Show cloud account, billing, and subscription models.", Category: "Account", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/billing", Usage: "/billing", Description: "Show cloud credits and entitlements.", Category: "Account", Tier: SlashCommandAdvanced, Source: "builtin", Implemented: true},
	{Name: "/provider", Aliases: []string{"/providers"}, Usage: "/provider [set|test|models] [provider]", Description: "Choose or inspect the default provider.", Category: "Models", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/model", Aliases: []string{"/models"}, Usage: "/model [provider:model|model provider]", Description: "Choose or inspect the default model.", Category: "Models", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/apikey", Usage: "/apikey <status|set|remove> [provider] [key]", Description: "Manage BYOK provider keys.", Category: "Models", Tier: SlashCommandAdvanced, Source: "builtin", Implemented: true},
	{Name: "/permissions", Usage: "/permissions [mode ask|auto|full]", Description: "Show permission rules or set approval mode.", Category: "Security", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/config", Usage: "/config", Description: "Show active settings summary.", Category: "Settings", Tier: SlashCommandAdvanced, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true, Hidden: true},
	{Name: "/mcp", Aliases: []string{"/extensions"}, Usage: "/mcp [list|discover|install|uninstall]", Description: "Manage MCP servers.", Category: "Integrations", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/ether", Aliases: []string{"/live"}, Usage: "/ether [enable|disable|status]", Description: "Manage Live/Ether remote control.", Category: "Integrations", Tier: SlashCommandPrimary, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/sessions", Usage: "/sessions", Description: "List local sessions.", Category: "Session", Tier: SlashCommandPrimary, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/new", Usage: "/new", Description: "Create a new session.", Category: "Session", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/resume", Usage: "/resume <session-id>", Description: "Switch to an existing session.", Category: "Session", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/clear", Usage: "/clear", Description: "Clear the TUI history.", Category: "Session", Tier: SlashCommandPrimary, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/compact", Usage: "/compact", Description: "Compact current context now.", Category: "Session", Tier: SlashCommandPrimary, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/checkpoint", Usage: "/checkpoint [list|name]", Description: "Save or list workspace checkpoints.", Category: "Workspace", Tier: SlashCommandAdvanced, Source: "builtin", Implemented: true},
	{Name: "/restore", Usage: "/restore <hash>", Description: "Restore to a checkpoint.", Category: "Workspace", Tier: SlashCommandAdvanced, Source: "builtin", Implemented: true},
	{Name: "/diff", Usage: "/diff", Description: "Show local git diff.", Category: "Workspace", Tier: SlashCommandPrimary, RemoteSafe: true, Source: "builtin", Implemented: true},
	{Name: "/review", Usage: "/review [scope]", Description: "Ask Ricochet to review a scope.", Category: "Agent", Tier: SlashCommandPrimary, Source: "builtin", Implemented: true},
	{Name: "/plan", Usage: "/plan [add|done|rm]", Description: "Toggle or manage Plan Mode.", Category: "Agent", Tier: SlashCommandPrimary, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/transcript", Usage: "/transcript", Description: "Show transcript/output view hint.", Category: "View", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/raw", Usage: "/raw", Description: "Toggle raw timeline/debug view.", Category: "View", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/copy", Usage: "/copy", Description: "Show copy shortcut for last assistant response/output.", Category: "View", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/ps", Usage: "/ps", Description: "Show active agent/task state.", Category: "Agent", Tier: SlashCommandAdvanced, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/stop", Usage: "/stop", Description: "Abort the active agent run.", Category: "Agent", Tier: SlashCommandPrimary, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/theme", Usage: "/theme [dark|mono|classic]", Description: "Switch the TUI color theme.", Category: "Settings", Tier: SlashCommandPrimary, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
	{Name: "/demo", Usage: "/demo [all|polybot|failed|slash-menu]", Description: "Replay terminal dev lab fixtures.", Category: "View", Tier: SlashCommandAdvanced, AvailableDuringRun: true, Source: "builtin", Implemented: true, DevOnly: true},
	{Name: "/exit", Usage: "/exit", Description: "Quit Ricochet.", Category: "Core", Tier: SlashCommandPrimary, AvailableDuringRun: true, RemoteSafe: true, BridgeSafe: true, Source: "builtin", Implemented: true},
}

func SlashCommandNames() []string {
	return SlashCommandNamesForContext(false)
}

func SlashCommandNamesForContext(includeDev bool) []string {
	names := make([]string, 0, len(slashCommandRegistry))
	for _, spec := range slashCommandRegistry {
		if !spec.visibleInContext(includeDev) {
			continue
		}
		if spec.Tier != SlashCommandPrimary && !(includeDev && spec.DevOnly) {
			continue
		}
		names = append(names, spec.Name)
	}
	return names
}

func SlashCommandNamesForTier(includeDev bool, tier SlashCommandTier) []string {
	names := make([]string, 0, len(slashCommandRegistry))
	for _, spec := range slashCommandRegistry {
		if !spec.visibleInContext(includeDev) {
			continue
		}
		if tier != "" && spec.Tier != tier {
			continue
		}
		names = append(names, spec.Name)
	}
	return names
}

func (spec SlashCommandSpec) visibleInContext(includeDev bool) bool {
	if !spec.Implemented || spec.Hidden {
		return false
	}
	return !spec.DevOnly || includeDev
}

func SlashCommandSuggestions(input string, includeDev bool) []string {
	input = strings.TrimSpace(input)
	if input == "/" || input == "" {
		return SlashCommandNamesForContext(includeDev)
	}
	if !strings.HasPrefix(input, "/") && !strings.HasPrefix(input, "?") {
		return nil
	}

	seen := map[string]bool{}
	names := make([]string, 0, len(slashCommandRegistry))
	for _, spec := range slashCommandRegistry {
		if !spec.visibleInContext(includeDev) {
			continue
		}
		if slashCommandMatchesInput(spec, input) && !seen[spec.Name] {
			names = append(names, spec.Name)
			seen[spec.Name] = true
		}
	}
	return names
}

func slashCommandMatchesInput(spec SlashCommandSpec, input string) bool {
	if strings.HasPrefix(spec.Name, input) {
		return true
	}
	for _, alias := range spec.Aliases {
		if strings.HasPrefix(alias, input) {
			return true
		}
	}
	return false
}

func FindSlashCommand(name string) (SlashCommandSpec, bool) {
	for _, spec := range slashCommandRegistry {
		if spec.Name == name {
			return spec, true
		}
		for _, alias := range spec.Aliases {
			if alias == name {
				return spec, true
			}
		}
	}
	return SlashCommandSpec{}, false
}

func RenderSlashHelp(command string) string {
	command = strings.TrimSpace(command)
	if command != "" && (command == "all" || command == "--all" || command == "-a") {
		return renderSlashHelpList(true)
	}
	if command != "" {
		if spec, ok := FindSlashCommand(command); ok {
			if !spec.Implemented {
				return fmt.Sprintf("Command `%s` is not available in this TUI build. Type `/help` to list working commands.", command)
			}
			aliases := ""
			if len(spec.Aliases) > 0 {
				aliases = fmt.Sprintf("\nAliases: `%s`", strings.Join(spec.Aliases, "`, `"))
			}
			return fmt.Sprintf("**%s**\nUsage: `%s`%s\n\n%s", spec.Name, spec.Usage, aliases, spec.Description)
		}
		return fmt.Sprintf("Unknown command `%s`. Type `/help` to list available commands.", command)
	}

	return renderSlashHelpList(false)
}

func renderSlashHelpList(includeAdvanced bool) string {
	var sb strings.Builder
	sb.WriteString("**Available Commands**\n")
	currentCategory := ""
	for _, spec := range slashCommandRegistry {
		if !spec.visibleInContext(false) {
			continue
		}
		if !includeAdvanced && spec.Tier != SlashCommandPrimary {
			continue
		}
		if spec.Category != "" && spec.Category != currentCategory {
			if currentCategory != "" {
				sb.WriteString("\n")
			}
			currentCategory = spec.Category
			sb.WriteString(fmt.Sprintf("**%s**\n", currentCategory))
		}
		sb.WriteString(fmt.Sprintf("- `%s` - %s\n", spec.Usage, spec.Description))
	}
	if !includeAdvanced {
		sb.WriteString("\nType `/help all` to show advanced commands.")
	}
	return strings.TrimSpace(sb.String())
}
