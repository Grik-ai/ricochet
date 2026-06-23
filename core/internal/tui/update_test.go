package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/igoryan-dao/ricochet/internal/agent"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestUpdate_TabToggle(t *testing.T) {
	// Initialize minimal model
	m := Model{
		Textarea:        textarea.New(),
		Viewport:        viewport.New(80, 20),
		IsShellFocused:  false, // Start focused on Input
		ShowSuggestions: false,
	}

	// 1. Send Tab -> Should toggle to Shell Focus
	msg := tea.KeyMsg{Type: tea.KeyTab}
	newM, _ := m.Update(msg)
	newModel := newM.(Model)

	if !newModel.IsShellFocused {
		t.Error("Expected IsShellFocused to be true after Tab")
	}
	if newModel.Textarea.Focused() {
		t.Error("Expected Textarea to be blurred (not Focused) when Shell is focused")
	}

	// 2. Send Tab again -> Should toggle back to Input Focus
	newM2, _ := newModel.Update(msg)
	newModel2 := newM2.(Model)

	if newModel2.IsShellFocused {
		t.Error("Expected IsShellFocused to be false after second Tab")
	}
	if !newModel2.Textarea.Focused() {
		t.Error("Expected Textarea to be Focused when Input is focused")
	}
}

func TestUpdate_TabSelectsSuggestion(t *testing.T) {
	// Initialize model with suggestions open
	ta := textarea.New()
	ta.SetValue("/") // Vital: Set value so updateSuggestions doesn't clear suggestions

	m := Model{
		Textarea:           ta,
		Viewport:           viewport.New(80, 20),
		IsShellFocused:     false,
		ShowSuggestions:    true,
		AllCommands:        []string{"/help", "/exit"}, // Vital for updateSuggestions
		Suggestions:        []string{"/help", "/exit"},
		SelectedSuggestion: 0,
	}

	// 1. Send Tab -> Should NOT toggle focus, should select suggestion
	msg := tea.KeyMsg{Type: tea.KeyTab}
	newM, _ := m.Update(msg)
	newModel := newM.(Model)

	// Focus should remain unchanged
	if newModel.IsShellFocused {
		t.Error("Expected IsShellFocused to be false (unchanged) when suggestions handle Tab")
	}

	// Textarea should contain suggestion
	if newModel.Textarea.Value() != "/help" { // /help is auto-exec, no space
		t.Errorf("Expected Textarea value to be '/help', got '%s'", newModel.Textarea.Value())
	}
}

func testModelForInput() Model {
	ta := textarea.New()
	ta.Focus()
	ta.SetHeight(1)
	renderer, _ := glamour.NewTermRenderer(glamour.WithWordWrap(80))
	return Model{
		Textarea:          ta,
		Viewport:          viewport.New(80, 20),
		Renderer:          renderer,
		AllCommands:       SlashCommandNames(),
		SlashHistoryIndex: -1,
		Blocks:            []*HistoryBlock{{Type: BlockAgentText}},
		MsgChan:           make(chan tea.Msg, 8),
		RenderedSteps:     map[string]int{},
		Tasks:             map[string]*protocol.TaskProgress{},
		CommandItems:      map[string]*TimelineItem{},
		ToolItems:         map[string]*TimelineItem{},
		TerminalWidth:     80,
		TerminalHeight:    24,
		IsShellFocused:    false,
		ShowSuggestions:   false,
	}
}

func TestUpdate_EnterSubmitsHelpWithoutNewline(t *testing.T) {
	m := testModelForInput()
	m.Textarea.SetValue("/help")

	newM, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	newModel := newM.(Model)

	if strings.Contains(newModel.Textarea.Value(), "\n") {
		t.Fatalf("enter should submit, not insert newline: %q", newModel.Textarea.Value())
	}
	content := ""
	for _, block := range newModel.Blocks {
		content += block.Content
	}
	if !strings.Contains(content, "Available Commands") {
		t.Fatalf("/help did not render registry help, content=%q", content)
	}
}

func TestUpdate_EnterOnSlashOpensSuggestions(t *testing.T) {
	m := testModelForInput()
	m.Textarea.SetValue("/")

	newM, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	newModel := newM.(Model)

	if !newModel.ShowSuggestions {
		t.Fatal("single / should open suggestions instead of executing")
	}
	content := ""
	for _, block := range newModel.Blocks {
		content += block.Content
	}
	if strings.Contains(content, "Unknown command") {
		t.Fatalf("single / should not produce Unknown command, content=%q", content)
	}
}

func TestIsCompleteSlashCommand(t *testing.T) {
	if !isCompleteSlashCommand("/provider") {
		t.Fatal("/provider should be treated as a complete command")
	}
	if !isCompleteSlashCommand("/model openrouter:qwen/qwen3-coder:free") {
		t.Fatal("/model with args should be treated as a complete command")
	}
	if isCompleteSlashCommand("/pro") {
		t.Fatal("/pro should remain an autocomplete prefix")
	}
	if isCompleteSlashCommand("/") {
		t.Fatal("single / should not be treated as a complete command")
	}
}

func TestSlashSuggestionsUsePrimaryByDefaultAndAdvancedOnSearch(t *testing.T) {
	m := testModelForInput()
	m.Controller = nil
	m.SettingsStore = nil

	got := m.enabledSlashCommandSuggestions("/")
	for _, advanced := range []string{"/version", "/usage", "/checkpoint"} {
		if containsString(got, advanced) {
			t.Fatalf("default suggestions should not include advanced %s: %v", advanced, got)
		}
	}
	for _, disabled := range []string{"/stop", "/sessions", "/new", "/resume"} {
		if containsString(got, disabled) {
			t.Fatalf("suggestions should not include disabled %s: %v", disabled, got)
		}
	}

	got = m.enabledSlashCommandSuggestions("/ver")
	if !containsString(got, "/version") {
		t.Fatalf("advanced command should be searchable by typed prefix, got %v", got)
	}
}

func TestSlashAliasSearchSuggestsCanonicalCommand(t *testing.T) {
	m := testModelForInput()

	got := m.enabledSlashCommandSuggestions("/models")
	if !containsString(got, "/model") || containsString(got, "/models") {
		t.Fatalf("alias search should suggest canonical /model only, got %v", got)
	}

	got = m.enabledSlashCommandSuggestions("/ext")
	if !containsString(got, "/mcp") || containsString(got, "/extensions") {
		t.Fatalf("alias search should suggest canonical /mcp only, got %v", got)
	}
}

func TestSlashCommandHistoryReplay(t *testing.T) {
	m := testModelForInput()
	m.recordSlashHistory("/status")
	m.recordSlashHistory("/model")

	if !m.recallSlashHistory(-1) {
		t.Fatal("expected history recall to succeed")
	}
	if got := m.Textarea.Value(); got != "/model" {
		t.Fatalf("expected latest slash command, got %q", got)
	}

	if !m.recallSlashHistory(-1) {
		t.Fatal("expected second history recall to succeed")
	}
	if got := m.Textarea.Value(); got != "/status" {
		t.Fatalf("expected previous slash command, got %q", got)
	}

	if !m.recallSlashHistory(1) {
		t.Fatal("expected forward history recall to succeed")
	}
	if got := m.Textarea.Value(); got != "/model" {
		t.Fatalf("expected next slash command, got %q", got)
	}
}

func TestHandleSlashCommandRejectsHiddenCommands(t *testing.T) {
	m := testModelForInput()

	res, cmd := m.handleSlashCommand("/auto 5")

	if cmd != nil {
		t.Fatal("hidden command should not return an executable command")
	}
	if m.AutoStepsRemaining != 0 {
		t.Fatalf("hidden command executed side effect, AutoStepsRemaining=%d", m.AutoStepsRemaining)
	}
	if !strings.Contains(res, "not available") {
		t.Fatalf("hidden command should return not available, got %q", res)
	}
}

func TestForwardChatUpdateIgnoresNilMessage(t *testing.T) {
	m := Model{MsgChan: make(chan tea.Msg, 1)}
	fullResponse := ""

	m.forwardChatUpdate(agent.ChatUpdate{}, &fullResponse)

	if fullResponse != "" {
		t.Fatalf("nil message update should not change response, got %q", fullResponse)
	}
	select {
	case msg := <-m.MsgChan:
		t.Fatalf("nil message update should not emit TUI message, got %#v", msg)
	default:
	}
}
