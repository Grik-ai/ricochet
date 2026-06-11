package protocol

import "testing"

func TestNormalizeTodoListAcceptsAliases(t *testing.T) {
	todos := NormalizeTodoList([]Todo{
		{Text: "  Read files  ", Status: "in_progress", Priority: "HIGH"},
		{Text: "Skip noisy branch", Status: "canceled", Priority: "urgent"},
	})

	if todos[0].Text != "Read files" || todos[0].Status != TodoCurrent || todos[0].Priority != "high" {
		t.Fatalf("first todo not normalized: %#v", todos[0])
	}
	if todos[1].Status != TodoCancelled || todos[1].Priority != "" {
		t.Fatalf("second todo not normalized: %#v", todos[1])
	}
}

func TestCalculateTodoViewCompact(t *testing.T) {
	before := []Todo{
		{Text: "one", Status: TodoCompleted},
		{Text: "two", Status: TodoCurrent},
		{Text: "three", Status: TodoPending},
		{Text: "four", Status: TodoPending},
		{Text: "five", Status: TodoPending},
	}
	after := []Todo{
		{Text: "one", Status: TodoCompleted},
		{Text: "two", Status: TodoCompleted},
		{Text: "three", Status: TodoCurrent},
		{Text: "four", Status: TodoPending},
		{Text: "five", Status: TodoPending},
	}

	view := CalculateTodoView(before, after)
	if view.Mode != "compact" {
		t.Fatalf("mode = %s, want compact", view.Mode)
	}
	if view.HiddenBefore != 0 || view.HiddenAfter != 1 {
		t.Fatalf("hidden before/after = %d/%d", view.HiddenBefore, view.HiddenAfter)
	}
	if view.Changed != 2 {
		t.Fatalf("changed = %d, want 2", view.Changed)
	}
	if len(view.Todos) != 4 {
		t.Fatalf("todos len = %d, want 4", len(view.Todos))
	}
}
