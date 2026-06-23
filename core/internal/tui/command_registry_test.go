package tui

import (
	"strings"
	"testing"
)

func TestSlashCommandNamesReturnPrimaryCommandsOnly(t *testing.T) {
	names := map[string]bool{}
	for _, name := range SlashCommandNames() {
		names[name] = true
	}

	for _, hidden := range []string{"/init", "/shell", "/memory", "/hooks", "/mode", "/models", "/providers", "/extensions", "/live", "/config", "/auto", "/commit", "/demo", "/usage", "/doctor", "/billing", "/apikey", "/shortcuts", "/keymap", "/checkpoint", "/restore", "/transcript", "/raw", "/copy", "/ps", "/version"} {
		if names[hidden] {
			t.Fatalf("non-primary command %s should not be visible by default", hidden)
		}
	}

	for _, visible := range []string{"/help", "/status", "/account", "/provider", "/model", "/permissions", "/mcp", "/theme", "/ether", "/sessions", "/new", "/resume", "/clear", "/compact", "/diff", "/review", "/plan", "/stop", "/exit"} {
		if !names[visible] {
			t.Fatalf("primary command %s should be visible", visible)
		}
	}
}

func TestFindSlashCommandAliases(t *testing.T) {
	if spec, ok := FindSlashCommand("/live"); !ok || spec.Name != "/ether" {
		t.Fatalf("/live should resolve to /ether, got spec=%+v ok=%v", spec, ok)
	}
	if spec, ok := FindSlashCommand("/models"); !ok || spec.Name != "/model" {
		t.Fatalf("/models should resolve to /model, got spec=%+v ok=%v", spec, ok)
	}
	if spec, ok := FindSlashCommand("/providers"); !ok || spec.Name != "/provider" {
		t.Fatalf("/providers should resolve to /provider, got spec=%+v ok=%v", spec, ok)
	}
	if spec, ok := FindSlashCommand("/extensions"); !ok || spec.Name != "/mcp" {
		t.Fatalf("/extensions should resolve to /mcp, got spec=%+v ok=%v", spec, ok)
	}
	if spec, ok := FindSlashCommand("?"); !ok || spec.Name != "/help" {
		t.Fatalf("? should resolve to /help, got spec=%+v ok=%v", spec, ok)
	}
}

func TestSlashHelpDoesNotRenderHiddenAliasesOrDevCommands(t *testing.T) {
	help := RenderSlashHelp("")
	for _, hidden := range []string{"/models", "/providers", "/extensions", "/live", "/demo", "/usage", "/apikey", "/checkpoint", "/raw"} {
		if strings.Contains(help, hidden) {
			t.Fatalf("default help should not expose hidden or advanced command %s: %s", hidden, help)
		}
	}
	if !strings.Contains(help, "/help all") {
		t.Fatalf("default help should advertise /help all: %s", help)
	}
}

func TestSlashHelpAllRendersAdvancedCommands(t *testing.T) {
	help := RenderSlashHelp("all")
	for _, advanced := range []string{"/usage", "/doctor", "/billing", "/apikey", "/shortcuts", "/keymap", "/checkpoint", "/restore", "/transcript", "/raw", "/copy", "/ps", "/version"} {
		if !strings.Contains(help, advanced) {
			t.Fatalf("/help all should expose advanced command %s: %s", advanced, help)
		}
	}
	for _, hidden := range []string{"/models", "/providers", "/extensions", "/live", "/demo"} {
		if strings.Contains(help, hidden) {
			t.Fatalf("/help all should not expose alias/dev command %s: %s", hidden, help)
		}
	}
}

func TestDevSlashCommandNamesExposeDemo(t *testing.T) {
	names := map[string]bool{}
	for _, name := range SlashCommandNamesForContext(true) {
		names[name] = true
	}
	if !names["/demo"] {
		t.Fatalf("/demo should be visible in terminal-lab/dev context")
	}
}

func TestVisibleSlashCommandsAreExecutable(t *testing.T) {
	m := testModelForInput()
	for _, name := range SlashCommandNamesForContext(false) {
		res, _ := m.handleSlashCommand(name)
		if strings.Contains(res, "not available in this TUI build") {
			t.Fatalf("visible command %s returned not available: %q", name, res)
		}
	}
}

func TestAdvancedSlashCommandsAreSearchableButNotDefault(t *testing.T) {
	defaultSuggestions := SlashCommandSuggestions("/", false)
	for _, hiddenByDefault := range []string{"/version", "/usage", "/checkpoint"} {
		if containsString(defaultSuggestions, hiddenByDefault) {
			t.Fatalf("%s should not be in default / suggestions: %v", hiddenByDefault, defaultSuggestions)
		}
	}

	for input, want := range map[string]string{
		"/ver":    "/version",
		"/api":    "/apikey",
		"/che":    "/checkpoint",
		"/mod":    "/model",
		"/models": "/model",
		"/ext":    "/mcp",
	} {
		got := SlashCommandSuggestions(input, false)
		if !containsString(got, want) {
			t.Fatalf("suggestions for %q should include %s, got %v", input, want, got)
		}
	}
}

func TestSlashCommandDisabledReasons(t *testing.T) {
	m := testModelForInput()

	res, _ := m.handleSlashCommand("/stop")
	if !strings.Contains(res, "no active run") {
		t.Fatalf("/stop without active run should explain disabled state, got %q", res)
	}

	m.IsLoading = true
	res, _ = m.handleSlashCommand("/review")
	if !strings.Contains(res, "wait for the active run") {
		t.Fatalf("/review during active run should explain disabled state, got %q", res)
	}

	res, _ = m.handleSlashCommand("/status")
	if strings.Contains(res, "Command `/status` is unavailable") {
		t.Fatalf("/status should remain available during active run, got %q", res)
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
