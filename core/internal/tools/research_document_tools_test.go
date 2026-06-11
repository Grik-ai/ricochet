package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResearchDoctorReportsOptInSources(t *testing.T) {
	out, err := (&ResearchDoctorTool{}).Execute(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "opt-in") || !strings.Contains(out, "web_search") {
		t.Fatalf("unexpected research doctor output: %s", out)
	}
}

func TestDocumentParseLocalTextAndRejectsOCRWithoutEngine(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("# Notes\nhello"), 0600); err != nil {
		t.Fatal(err)
	}
	tool := &DocumentParseTool{WorkspaceRoot: dir}
	out, err := tool.Execute(context.Background(), json.RawMessage(`{"path":"notes.md"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Parsed locally") || !strings.Contains(out, "# Notes") {
		t.Fatalf("unexpected document parse output: %s", out)
	}

	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"path":"image.png"}`)); err == nil || !strings.Contains(err.Error(), "OCR") {
		t.Fatalf("expected OCR configuration error, got %v", err)
	}
}
