package context

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestBuildContextReportTopContributorsAndWarnings(t *testing.T) {
	large := strings.Repeat("large output ", 5000)
	report := BuildContextReport("system", []protocol.Message{
		{Role: "user", Content: "small task"},
		{Role: "user", ToolResults: []protocol.ToolResultBlock{{ToolUseID: "tool_1", Content: large}}},
	}, 2000, 200)

	if len(report.TopContributors) == 0 {
		t.Fatal("expected top contributors")
	}
	if report.TopContributors[0].Type != "tool_result" {
		t.Fatalf("expected tool result to be top contributor, got %s", report.TopContributors[0].Type)
	}
	if len(report.Warnings) == 0 {
		t.Fatal("expected warning for large context fragment")
	}
	if len(report.Suggestions) == 0 {
		t.Fatal("expected context suggestions")
	}
}

func TestNewContextFragmentTruncatesByBudget(t *testing.T) {
	fragment := NewContextFragment("memory", "memory", "project", strings.Repeat("x", 2000), 1, 100)
	if !fragment.Truncated {
		t.Fatal("expected fragment to be truncated")
	}
	if fragment.Tokens > 150 {
		t.Fatalf("fragment remained too large: %d tokens", fragment.Tokens)
	}
}

func TestContextCompressorStoresAndRetrievesOriginal(t *testing.T) {
	original := strings.Repeat("line with important command output\n", 5000)
	compressor := NewContextCompressor(t.TempDir())
	compressor.MinTokens = 200
	compressor.PreviewLines = 4
	compressor.PreviewTail = 2

	messages, report := compressor.CompressMessages([]protocol.Message{
		{
			Role:    "assistant",
			ToolUse: []protocol.ToolUseBlock{{ID: "tool_1", Name: "execute_command"}},
		},
		{
			Role:        "user",
			ToolResults: []protocol.ToolResultBlock{{ToolUseID: "tool_1", Content: original}},
		},
	})

	if report == nil || report.SavedTokens <= 0 {
		t.Fatalf("expected compression savings, got %+v", report)
	}
	if len(report.Fragments) != 1 || report.Fragments[0].Type != "command_log" {
		t.Fatalf("unexpected compression fragments: %+v", report.Fragments)
	}
	if !strings.Contains(messages[1].ToolResults[0].Content, "retrieve_context_original") {
		t.Fatalf("expected retrieval hint, got %s", messages[1].ToolResults[0].Content[:120])
	}
	recovered, err := RetrieveContextOriginal(compressor.StoreDir, report.Fragments[0].Hash, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if recovered != "line with important command output\nline with important command output" {
		t.Fatalf("unexpected recovered range: %q", recovered)
	}
}

func TestInjectSyntheticToolResults(t *testing.T) {
	messages := []protocol.Message{
		{Role: "user", Content: "start"},
		{Role: "assistant", ToolUse: []protocol.ToolUseBlock{{ID: "missing", Name: "read_file"}}},
	}
	repaired := InjectSyntheticToolResults(messages)
	if len(repaired) != 3 {
		t.Fatalf("expected synthetic result message, got %d messages", len(repaired))
	}
	if len(repaired[2].ToolResults) != 1 || repaired[2].ToolResults[0].ToolUseID != "missing" {
		t.Fatalf("unexpected synthetic tool result: %+v", repaired[2])
	}
}

func TestFileTrackerRecentOrdering(t *testing.T) {
	tracker := NewFileTracker()
	tracker.AddFile("old.go")
	time.Sleep(time.Millisecond)
	tracker.AddFile("new.go")

	recent := tracker.GetRecentFiles(1)
	if len(recent) != 1 || recent[0] != "new.go" {
		t.Fatalf("expected newest file first, got %+v", recent)
	}
}

func TestBuildFoldedFileContext(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "main.go")
	if err := os.WriteFile(path, []byte("package main\n\nimport \"fmt\"\n\nfunc hello() { fmt.Println(\"hi\") }\n"), 0600); err != nil {
		t.Fatal(err)
	}

	folded := BuildFoldedFileContext(context.Background(), dir, []string{"main.go"}, 4000)
	if folded.Content == "" {
		t.Fatal("expected folded context content")
	}
	if !strings.Contains(folded.Content, "hello") {
		t.Fatalf("expected function outline, got %s", folded.Content)
	}
}
