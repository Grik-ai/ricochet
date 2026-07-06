package tools

import "testing"

func TestTerminalToolCategories(t *testing.T) {
	tests := map[string]ToolCategory{
		"command_status": CategoryRead,
		"read_terminal":  CategoryRead,
		"start_terminal": CategoryExecute,
		"send_input":     CategoryExecute,
		"command_stop":   CategoryExecute,
	}
	for name, want := range tests {
		if got := GetToolCategory(name); got != want {
			t.Fatalf("GetToolCategory(%q) = %q, want %q", name, got, want)
		}
	}
}
