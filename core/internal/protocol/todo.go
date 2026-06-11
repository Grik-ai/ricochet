package protocol

import "strings"

// NormalizeTodoList keeps older clients compatible while accepting richer todo states.
func NormalizeTodoList(todos []Todo) []Todo {
	if len(todos) == 0 {
		return nil
	}

	normalized := make([]Todo, len(todos))
	for i, todo := range todos {
		text := strings.TrimSpace(todo.Text)
		status := NormalizeTodoStatus(todo.Status)
		priority := strings.ToLower(strings.TrimSpace(todo.Priority))
		switch priority {
		case "high", "medium", "low":
		default:
			priority = ""
		}

		normalized[i] = Todo{
			Text:     text,
			Status:   status,
			Priority: priority,
			Changed:  todo.Changed,
		}
	}
	return normalized
}

func NormalizeTodoStatus(status TodoStatus) TodoStatus {
	switch TodoStatus(strings.ToLower(strings.TrimSpace(string(status)))) {
	case TodoCurrent, "in_progress", "in-progress", "running":
		return TodoCurrent
	case TodoCompleted, "done":
		return TodoCompleted
	case TodoCancelled, "canceled", "skipped":
		return TodoCancelled
	default:
		return TodoPending
	}
}

func CalculateTodoView(before, after []Todo) TodoView {
	before = NormalizeTodoList(before)
	after = NormalizeTodoList(after)

	if len(after) == 0 {
		return TodoView{Mode: "full"}
	}

	changedIndexes := make([]int, 0)
	for i, todo := range after {
		if i >= len(before) || !sameTodo(before[i], todo) {
			changedIndexes = append(changedIndexes, i)
		}
	}

	if len(before) == 0 || len(before) != len(after) || structurallyChanged(before, after) || terminalTodos(after) || len(changedIndexes) == 0 {
		return fullTodoView(after, len(changedIndexes))
	}

	first := changedIndexes[0]
	last := changedIndexes[0]
	for _, idx := range changedIndexes[1:] {
		if idx < first {
			first = idx
		}
		if idx > last {
			last = idx
		}
	}
	if first > 0 {
		first--
	}
	if last < len(after)-1 {
		last++
	}

	hiddenBefore := first
	hiddenAfter := len(after) - last - 1
	if hiddenBefore == 0 && hiddenAfter == 0 {
		return fullTodoView(after, len(changedIndexes))
	}

	changedSet := make(map[int]bool, len(changedIndexes))
	for _, idx := range changedIndexes {
		changedSet[idx] = true
	}

	items := make([]Todo, 0, last-first+1)
	for i := first; i <= last; i++ {
		item := after[i]
		item.Changed = changedSet[i]
		items = append(items, item)
	}

	return TodoView{
		Mode:         "compact",
		Todos:        items,
		HiddenBefore: hiddenBefore,
		HiddenAfter:  hiddenAfter,
		Changed:      len(changedIndexes),
	}
}

func fullTodoView(todos []Todo, changed int) TodoView {
	items := make([]Todo, len(todos))
	copy(items, todos)
	return TodoView{
		Mode:    "full",
		Todos:   items,
		Changed: changed,
	}
}

func sameTodo(a, b Todo) bool {
	return strings.TrimSpace(a.Text) == strings.TrimSpace(b.Text) &&
		NormalizeTodoStatus(a.Status) == NormalizeTodoStatus(b.Status) &&
		strings.EqualFold(strings.TrimSpace(a.Priority), strings.TrimSpace(b.Priority))
}

func structurallyChanged(before, after []Todo) bool {
	for i := range after {
		if strings.TrimSpace(before[i].Text) != strings.TrimSpace(after[i].Text) {
			return true
		}
	}
	return false
}

func terminalTodos(todos []Todo) bool {
	for _, todo := range todos {
		status := NormalizeTodoStatus(todo.Status)
		if status != TodoCompleted && status != TodoCancelled {
			return false
		}
	}
	return true
}
