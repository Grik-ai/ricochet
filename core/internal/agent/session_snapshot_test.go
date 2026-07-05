package agent

import (
	"testing"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestGetSessionSnapshotReturnsRawMessages(t *testing.T) {
	c := &Controller{sessionManager: NewSessionManager(t.TempDir())}
	session := c.CreateSessionWithID("session-snapshot")
	rawMessages := []protocol.Message{
		{ID: "u1", Role: "user", Content: "hello"},
		{
			ID:      "a1",
			Role:    "assistant",
			Content: "hi",
			ToolUse: []protocol.ToolUseBlock{{
				ID:   "tool-1",
				Name: "read_file",
			}},
		},
		{
			ID:      "u2",
			Role:    "user",
			Content: "",
			ToolResults: []protocol.ToolResultBlock{{
				ToolUseID: "tool-1",
				Content:   "file contents",
			}},
		},
	}
	session.StateHandler.SetMessages(rawMessages)
	session.Todos = []protocol.Todo{{Text: "check history", Status: protocol.TodoPending}}

	snapshot := c.GetSessionSnapshot("session-snapshot")
	if snapshot["session_id"] != "session-snapshot" {
		t.Fatalf("unexpected session id: %#v", snapshot["session_id"])
	}

	messages, ok := snapshot["messages"].([]protocol.Message)
	if !ok {
		t.Fatalf("snapshot messages should be []protocol.Message, got %T", snapshot["messages"])
	}
	if len(messages) != len(rawMessages) {
		t.Fatalf("expected %d raw messages, got %d", len(rawMessages), len(messages))
	}
	for i := range rawMessages {
		if messages[i].Role != rawMessages[i].Role || messages[i].Content != rawMessages[i].Content {
			t.Fatalf("raw message %d mismatch: got %#v want %#v", i, messages[i], rawMessages[i])
		}
	}
	if len(messages[1].ToolUse) != 1 || len(messages[2].ToolResults) != 1 {
		t.Fatalf("raw tool-use/tool-result structure was not preserved: %#v", messages)
	}
}

func TestGetSessionSnapshotMissingSessionReturnsEmptyMessages(t *testing.T) {
	c := &Controller{sessionManager: NewSessionManager(t.TempDir())}

	snapshot := c.GetSessionSnapshot("missing-session")
	if snapshot["session_id"] != "missing-session" {
		t.Fatalf("unexpected session id: %#v", snapshot["session_id"])
	}

	messages, ok := snapshot["messages"].([]protocol.Message)
	if !ok {
		t.Fatalf("snapshot messages should be []protocol.Message, got %T", snapshot["messages"])
	}
	if len(messages) != 0 {
		t.Fatalf("missing session should return no messages, got %#v", messages)
	}
}
