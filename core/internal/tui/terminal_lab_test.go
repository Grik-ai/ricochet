package tui

import (
	"strings"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestTerminalLabFixtureCoversEventFamilies(t *testing.T) {
	events, err := TerminalLabFixture("all")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range events {
		switch msg := event.Message.(type) {
		case protocol.TaskProgress:
			if !shouldHideTaskProgress(msg) {
				seen["progress"] = true
			}
		case CommandEventMsg:
			seen["command"] = true
		case ToolLifecycleMsg:
			section, _, _ := classifyToolLifecycleEvent(msg.Event, &TimelineItem{})
			seen[section] = true
		case TimelineNoticeMsg:
			seen[msg.Title] = true
		case RemoteChatMsg:
			seen["chat"] = true
		}
	}
	for _, family := range []string{"progress", "command", "Explored", "Edited", "Review", "Approvals", "Artifacts", "Created Hub Tasks", "Context", "Checkpoint", "chat"} {
		if !seen[family] {
			t.Fatalf("fixture did not cover %s; seen=%v", family, seen)
		}
	}
}

func TestTerminalLabFixtureRendersTypedTimelineWithoutRawLeftovers(t *testing.T) {
	m := testModelForInput()
	events, err := TerminalLabFixture("all")
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Message == nil {
			continue
		}
		next, _ := m.Update(event.Message)
		m = next.(Model)
	}

	rendered := RenderTimeline(m.Timeline, 100)
	for _, want := range []string{"Explored", "Ran", "Edited", "Review", "Approvals", "Artifacts", "Created Hub Tasks", "L1-L150"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered timeline missing %q:\n%s", want, rendered)
		}
	}
	for _, hidden := range []string{"Planning task", "Running task", "task_boundary", "{\"mode\":\"code\"}"} {
		if strings.Contains(rendered, hidden) {
			t.Fatalf("rendered timeline leaked %q:\n%s", hidden, rendered)
		}
	}
}

func TestTerminalLabSlashMenuFixtureDocumentsCommandMenu(t *testing.T) {
	events, err := TerminalLabFixture("slash-menu")
	if err != nil {
		t.Fatal(err)
	}
	var content string
	for _, event := range events {
		if msg, ok := event.Message.(RemoteChatMsg); ok && msg.Message.Role == "assistant" {
			content += msg.Message.Content
		}
	}
	for _, want := range []string{"Idle `/` popup", "Active run `/` popup", "`/help`", "`/status`", "`/model`", "`/provider`", "Typed advanced search `/ver`", "`/version`", "Alias search stays canonical", "`/models` -> `/model`", "Disabled reason", "Command `/review` is unavailable", "`/help all` includes advanced commands"} {
		if !strings.Contains(content, want) {
			t.Fatalf("slash menu fixture missing %q:\n%s", want, content)
		}
	}
	for _, hidden := range []string{"`/models`, `/providers`", "`/demo`"} {
		if strings.Contains(content, hidden) {
			t.Fatalf("slash menu fixture leaked hidden/default duplicate %q:\n%s", hidden, content)
		}
	}
}

func TestRenderTimelineShowsCommandExitDurationAndOutput(t *testing.T) {
	item := &TimelineItem{
		Kind:        "command",
		Status:      "failed",
		Command:     "cargo test",
		ExitCode:    101,
		DurationMs:  2100,
		CompletedAt: 200,
		Output:      "error: failed to run custom build command\n",
		Expanded:    true,
	}

	rendered := RenderTimeline([]*TimelineItem{item}, 100)
	for _, want := range []string{"Failed", "cargo test", "exit=101", "2.1s", "error: failed"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("command timeline missing %q:\n%s", want, rendered)
		}
	}
}
