package style

import (
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Colors
var (
	LegacyAccent = lipgloss.Color("#38BDF8")
	Foreground   = lipgloss.Color("#E6EAF0")
	MutedGray    = lipgloss.Color("#8A929E")
	Border       = lipgloss.Color("#2A2F35")
	Focus        = lipgloss.Color("#38BDF8")
	Accent       = lipgloss.Color("#5EEAD4")
	Warning      = lipgloss.Color("#FACC15")
	Danger       = lipgloss.Color("#EF4444")
	Success      = lipgloss.Color("#22C55E")
	Panel        = lipgloss.Color("#111827")
	Selection    = lipgloss.Color("#1F2937")
	White        = Foreground
	Black        = lipgloss.Color("#000000")
	Pink         = lipgloss.Color("#C084FC")
	Cyan         = Focus
	Red          = Danger
	Green        = Success
)

// Bullets
var (
	BulletUser   = ">" // Matches screenshot input history
	BulletAgent  = "●" // Matches screenshot agent message
	BulletSystem = "○"
	BulletError  = "x"
	BulletTask   = "●" // Root task icon
)

// Base Styles
var (
	UserStyle    lipgloss.Style
	AgentStyle   lipgloss.Style
	SystemStyle  lipgloss.Style
	ErrorStyle   lipgloss.Style
	TaskStyle    lipgloss.Style
	SpinnerStyle lipgloss.Style

	// Mode Styles
	PlanStyle lipgloss.Style
	ActStyle  lipgloss.Style

	// Thinking / Status
	ThinkingStyle lipgloss.Style
	MetaStyle     lipgloss.Style

	// Warning/Gate
	Yellow       = Warning
	WarningStyle lipgloss.Style
)

// Component Styles
var (
	HeaderStyle      lipgloss.Style
	HeaderLabelStyle lipgloss.Style
	FooterStyle      lipgloss.Style
	TreeStyle        lipgloss.Style
	TreeActiveStyle  lipgloss.Style

	// Box Styles
	BorderColor lipgloss.Style
	BoxStyle    lipgloss.Style

	TitleStyle lipgloss.Style

	// -- Added for Plan Editor --
	SubtleStyle    lipgloss.Style
	SuccessStyle   lipgloss.Style
	AccentStyle    lipgloss.Style
	FocusStyle     lipgloss.Style
	MutedStyle     lipgloss.Style
	DangerStyle    lipgloss.Style
	CommandStyle   lipgloss.Style
	SelectionStyle lipgloss.Style
	SelectedStyle  lipgloss.Style
)

func init() {
	SetTheme("dark")
}

// SetTheme applies the global TUI palette. The legacy "classic" option keeps
// the old contrast level while using the same cyan accent family.
func SetTheme(theme string) {
	theme = strings.ToLower(strings.TrimSpace(theme))
	if theme == "" {
		theme = "dark"
	}
	if os.Getenv("NO_COLOR") != "" || os.Getenv("RICOCHET_NO_COLOR") != "" {
		theme = "mono"
	}

	switch theme {
	case "classic":
		Foreground = lipgloss.Color("#FFFFFF")
		MutedGray = lipgloss.Color("245")
		Border = LegacyAccent
		Focus = LegacyAccent
		Accent = LegacyAccent
		Warning = lipgloss.Color("#FACC15")
		Danger = lipgloss.Color("196")
		Success = lipgloss.Color("#2E8B57")
		Selection = lipgloss.Color("236")
	case "mono":
		Foreground = lipgloss.Color("#FFFFFF")
		MutedGray = lipgloss.Color("245")
		Border = lipgloss.Color("238")
		Focus = lipgloss.Color("#FFFFFF")
		Accent = lipgloss.Color("#FFFFFF")
		Warning = lipgloss.Color("#FFFFFF")
		Danger = lipgloss.Color("#FFFFFF")
		Success = lipgloss.Color("#FFFFFF")
		Selection = lipgloss.Color("236")
	default:
		Foreground = lipgloss.Color("#E6EAF0")
		MutedGray = lipgloss.Color("#8A929E")
		Border = lipgloss.Color("#2A2F35")
		Focus = lipgloss.Color("#38BDF8")
		Accent = lipgloss.Color("#5EEAD4")
		Warning = lipgloss.Color("#FACC15")
		Danger = lipgloss.Color("#EF4444")
		Success = lipgloss.Color("#22C55E")
		Selection = lipgloss.Color("#1F2937")
	}

	White = Foreground
	Cyan = Focus
	Red = Danger
	Green = Success
	Yellow = Warning
	rebuildStyles()
}

func rebuildStyles() {
	UserStyle = lipgloss.NewStyle().Foreground(Foreground)
	AgentStyle = lipgloss.NewStyle().Foreground(Foreground)
	SystemStyle = lipgloss.NewStyle().Foreground(MutedGray)
	ErrorStyle = lipgloss.NewStyle().Foreground(Danger)
	TaskStyle = lipgloss.NewStyle().Foreground(MutedGray)
	SpinnerStyle = lipgloss.NewStyle().Foreground(Accent)

	PlanStyle = lipgloss.NewStyle().Foreground(Focus).Bold(true)
	ActStyle = lipgloss.NewStyle().Foreground(Success).Bold(true)
	ThinkingStyle = lipgloss.NewStyle().Foreground(Focus)
	MetaStyle = lipgloss.NewStyle().Foreground(MutedGray)
	WarningStyle = lipgloss.NewStyle().Foreground(Warning).Bold(true)

	HeaderStyle = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Border).
		Padding(0, 1).
		Foreground(Foreground)
	HeaderLabelStyle = lipgloss.NewStyle().Foreground(Accent).Bold(true)
	FooterStyle = lipgloss.NewStyle().Foreground(MutedGray)
	TreeStyle = lipgloss.NewStyle().Foreground(MutedGray)
	TreeActiveStyle = lipgloss.NewStyle().Foreground(Focus)

	BorderColor = lipgloss.NewStyle().Foreground(Border)
	BoxStyle = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(Border).
		Padding(0, 1)
	TitleStyle = lipgloss.NewStyle().Foreground(Accent).Bold(true)

	SubtleStyle = lipgloss.NewStyle().Foreground(MutedGray)
	SuccessStyle = lipgloss.NewStyle().Foreground(Success)
	AccentStyle = lipgloss.NewStyle().Foreground(Accent)
	FocusStyle = lipgloss.NewStyle().Foreground(Focus)
	MutedStyle = lipgloss.NewStyle().Foreground(MutedGray)
	DangerStyle = lipgloss.NewStyle().Foreground(Danger)
	CommandStyle = lipgloss.NewStyle().Foreground(Focus)
	SelectionStyle = lipgloss.NewStyle().Foreground(Foreground).Background(Selection)
	SelectedStyle = lipgloss.NewStyle().Foreground(Foreground).Bold(true).Background(Selection)
}
