package agent

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestBuildToolLifecycleEventSummarizesArgsAndFiles(t *testing.T) {
	input := ChatRequestInput{SessionID: "s1", RunID: "r1", Via: "ide"}
	tc := ToolCallInfo{
		ID:        "tool-1",
		Name:      "read_file",
		Arguments: `{"path":"/repo/README.md"}`,
	}

	event := buildToolLifecycleEvent(input, tc, "tool_finished", time.Now().Add(-time.Second), "contents", nil)
	if event.Event != "tool_finished" || event.Status != "completed" {
		t.Fatalf("unexpected lifecycle status: %#v", event)
	}
	if event.ArgsSummary != "/repo/README.md" {
		t.Fatalf("ArgsSummary = %q", event.ArgsSummary)
	}
	if len(event.AffectedFiles) != 1 || event.AffectedFiles[0] != "/repo/README.md" {
		t.Fatalf("AffectedFiles = %#v", event.AffectedFiles)
	}
	if event.OutputPreview != "contents" {
		t.Fatalf("OutputPreview = %q", event.OutputPreview)
	}
}

func TestLifecycleRecorderAppendReplayAndLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events", "tool_lifecycle.jsonl")
	recorder := NewLifecycleRecorder(path)

	for _, id := range []string{"tool-1", "tool-2"} {
		if err := recorder.Append(protocol.ToolLifecycleEvent{
			SessionID: "s1",
			RunID:     "r1",
			ToolUseID: id,
			ToolName:  "read_file",
			Status:    "completed",
			Event:     "tool_finished",
		}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	events, err := recorder.Replay(1)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(events) != 1 || events[0].ToolUseID != "tool-2" {
		t.Fatalf("unexpected limited replay: %#v", events)
	}
	if events[0].Timestamp == 0 {
		t.Fatalf("expected recorder to stamp event timestamp")
	}
}
