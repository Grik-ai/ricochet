package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestReplayCommandEventsFiltersAndLimits(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	handler := &Handler{Host: host.NewStdioHost(cwd)}
	logDir := paths.GetLogDir(cwd)
	if err := paths.EnsureDir(logDir); err != nil {
		t.Fatalf("EnsureDir returned error: %v", err)
	}

	events := []protocol.CommandEvent{
		{SessionID: "s1", RunID: "r1", CommandID: "c1", Event: "command_started", Command: "one"},
		{SessionID: "s2", RunID: "r1", CommandID: "c2", Event: "command_started", Command: "two"},
		{SessionID: "s1", RunID: "r2", CommandID: "c3", Event: "command_output", Command: "three"},
		{SessionID: "s1", RunID: "r3", CommandID: "c4", Event: "command_succeeded", Command: "four"},
	}
	file, err := os.Create(filepath.Join(logDir, "command_events.jsonl"))
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	enc := json.NewEncoder(file)
	for _, event := range events {
		if err := enc.Encode(event); err != nil {
			t.Fatalf("Encode returned error: %v", err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}

	replayed, err := handler.replayCommandEvents(2, "s1", "")
	if err != nil {
		t.Fatalf("replayCommandEvents returned error: %v", err)
	}
	if len(replayed) != 2 {
		t.Fatalf("expected 2 limited events, got %d", len(replayed))
	}
	if replayed[0].CommandID != "c3" || replayed[1].CommandID != "c4" {
		t.Fatalf("expected latest s1 events c3/c4, got %+v", replayed)
	}

	runFiltered, err := handler.replayCommandEvents(0, "s1", "r2")
	if err != nil {
		t.Fatalf("run filtered replay returned error: %v", err)
	}
	if len(runFiltered) != 1 || runFiltered[0].CommandID != "c3" {
		t.Fatalf("expected only c3 for s1/r2, got %+v", runFiltered)
	}
}
