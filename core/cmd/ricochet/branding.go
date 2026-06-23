package main

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/igoryan-dao/ricochet/internal/version"
)

// ASCII Logo for Ricochet CLI
var RicochetLogo = `
██████╗ ██╗ ██████╗ ██████╗  ██████╗██╗  ██╗███████╗████████╗
██╔══██╗██║██╔════╝██╔═══██╗██╔════╝██║  ██║██╔════╝╚══██╔══╝
██████╔╝██║██║     ██║   ██║██║     ███████║█████╗     ██║
██╔══██╗██║██║     ██║   ██║██║     ██╔══██║██╔══╝     ██║
██║  ██║██║╚██████╗╚██████╔╝╚██████╗██║  ██║███████╗   ██║
╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝
`

// Mini Logo for header bar
var RicochetMiniLogo = `◉ Ricochet`

// Styles
var (
	// Colors
	primaryColor   = lipgloss.Color("#5EEAD4") // Teal
	secondaryColor = lipgloss.Color("#38BDF8") // Cyan
	accentColor    = lipgloss.Color("#22C55E") // Green
	dimColor       = lipgloss.Color("#8A929E") // Gray

	// Header Style
	headerStyle = lipgloss.NewStyle().
			Foreground(primaryColor).
			Bold(true)

	// Version Badge
	versionStyle = lipgloss.NewStyle().
			Foreground(secondaryColor).
			Background(lipgloss.Color("#2D2D2D")).
			Padding(0, 1)

	// Model Badge
	modelStyle = lipgloss.NewStyle().
			Foreground(accentColor).
			Background(lipgloss.Color("#2D2D2D")).
			Padding(0, 1)

	// CWD Style
	cwdStyle = lipgloss.NewStyle().
			Foreground(dimColor).
			Italic(true)

	// Hint Style (footer)
	hintStyle = lipgloss.NewStyle().
			Foreground(dimColor).
			Italic(true)
)

// RenderWelcomeContent returns the initial chat history content
func RenderWelcomeContent(model string, cwd string) string {
	logo := RicochetLogo

	tips := `
> [!TIP]
> **Getting Started**
> - Type **/** to see available commands (autocomplete)
> - Type **@** to mention files in your messages
> - Use **Ctrl+P** to toggle **Plan Mode**
> - Use **Ctrl+E** to toggle **Live/Ether Mode**
> - Type **/help** for a full list of capabilities
`

	header := fmt.Sprintf("# Ricochet CLI %s\n**Model**: `%s` | **Cwd**: `%s`\n---\n", version.Display(), model, cwd)

	return "```\n" + logo + "\n```\n" + header + "\n" + tips + "\n\n"
}

// RenderHeader renders the top bar during chat
func RenderHeader(model string, cwd string) string {
	versionBadge := versionStyle.Render(version.Display())
	modelBadge := modelStyle.Render(model)
	cwdText := cwdStyle.Render(cwd)

	return lipgloss.JoinHorizontal(lipgloss.Center,
		headerStyle.Render(RicochetMiniLogo),
		" ",
		versionBadge,
		" | ",
		modelBadge,
		" | ",
		cwdText,
	)
}

// RenderFooter renders the bottom hints bar
func RenderFooter() string {
	return hintStyle.Render("? for shortcuts | / for commands | Ctrl+C to quit")
}
