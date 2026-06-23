package main

import (
	"strings"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/tui"
)

func TestTerminalLabSnapshotContainsTypedTimeline(t *testing.T) {
	events, err := tui.TerminalLabFixture("all")
	if err != nil {
		t.Fatal(err)
	}
	frame, err := renderTerminalLabSnapshot("/tmp", events, 100, 120)
	if err != nil {
		t.Fatal(err)
	}
	frame = stripANSI(frame)

	for _, want := range []string{"Explored", "Ran", "Edited", "Review", "Approvals", "Artifacts", "Created Hub Tasks", "All terminal timeline events fixture complete"} {
		if !strings.Contains(frame, want) {
			t.Fatalf("snapshot missing %q:\n%s", want, frame)
		}
	}
	for _, hidden := range []string{"Planning task", "Running task", "task_boundary", "{\"mode\":\"code\"}"} {
		if strings.Contains(frame, hidden) {
			t.Fatalf("snapshot leaked %q:\n%s", hidden, frame)
		}
	}
}

func TestTerminalLabSlashMenuSnapshot(t *testing.T) {
	events, err := tui.TerminalLabFixture("slash-menu")
	if err != nil {
		t.Fatal(err)
	}
	frame, err := renderTerminalLabSnapshot("/tmp", events, 100, 120)
	if err != nil {
		t.Fatal(err)
	}
	frame = stripANSI(frame)

	for _, want := range []string{"Slash menu fixture complete", "Idle / popup", "Active run / popup", "/help", "/status", "/model", "/provider", "Typed advanced search /ver", "/version", "Command /review is unavailable", "/help all"} {
		if !strings.Contains(frame, want) {
			t.Fatalf("slash menu snapshot missing %q:\n%s", want, frame)
		}
	}
}
