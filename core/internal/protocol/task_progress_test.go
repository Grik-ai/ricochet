package protocol

import (
	"encoding/json"
	"testing"
)

func TestTaskProgressSerializesTodosAndCompletionMetadata(t *testing.T) {
	progress := TaskProgress{
		SessionID:   "session-1",
		RunID:       "run-1",
		Sequence:    3,
		SegmentID:   "run-1-progress-3",
		TaskName:    "Analyze project",
		Status:      "Summarize findings",
		Todos:       []Todo{{Text: "Summarize findings", Status: "current"}},
		CompletedAt: 1710000000000,
	}

	raw, err := json.Marshal(progress)
	if err != nil {
		t.Fatalf("marshal task progress: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal task progress: %v", err)
	}

	if decoded["segment_id"] != "run-1-progress-3" {
		t.Fatalf("segment_id = %v", decoded["segment_id"])
	}
	if decoded["completed_at"] != float64(1710000000000) {
		t.Fatalf("completed_at = %v", decoded["completed_at"])
	}
	todos, ok := decoded["todos"].([]any)
	if !ok || len(todos) != 1 {
		t.Fatalf("todos = %#v", decoded["todos"])
	}
}
