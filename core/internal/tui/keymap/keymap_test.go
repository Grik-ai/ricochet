package keymap

import "testing"

func TestDefaultKeymapHasNoConflicts(t *testing.T) {
	if err := Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestShortcutDisplayUsesConfiguredBinding(t *testing.T) {
	if got := Shortcut(ContextGlobal, ActionTogglePlan, "fallback"); got != "ctrl+p" {
		t.Fatalf("toggle plan shortcut = %q", got)
	}
	if got := Shortcut(ContextChat, ActionModelPicker, "fallback"); got != "alt+m" {
		t.Fatalf("model picker shortcut = %q", got)
	}
}
