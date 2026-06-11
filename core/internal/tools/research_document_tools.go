package tools

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type ResearchDoctorTool struct{}

func (t *ResearchDoctorTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "research_doctor",
		Description: "Report which external research adapters are available. This does not scrape or open external platforms; use it before invoking research workflows.",
		InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	}
}

func (t *ResearchDoctorTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	result := map[string]interface{}{
		"status": "ok",
		"available_sources": []map[string]interface{}{
			{"source": "web", "tool": "web_search", "available": true, "permission": "explicit tool call"},
			{"source": "github", "tool": "web_search", "available": true, "permission": "explicit query/citation"},
		},
		"disabled_sources": []map[string]interface{}{
			{"source": "reddit", "reason": "adapter not configured; requires explicit connector or approved web workflow"},
			{"source": "youtube_transcripts", "reason": "adapter not configured; requires explicit connector or approved parser"},
			{"source": "x", "reason": "cookie/API scraping is opt-in only and not enabled"},
		},
		"policy": "Ricochet research is opt-in. Do not use cookies, logged-in sessions, or paid APIs without explicit user configuration.",
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	return string(data), nil
}

type DocumentParseTool struct {
	WorkspaceRoot string
}

func (t *DocumentParseTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "document_parse",
		Description: "Parse a local text/markdown/json document into bounded markdown/context blocks. PDF/image OCR is reported as unavailable unless an OCR engine is configured.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":      map[string]interface{}{"type": "string", "description": "Local document path relative to workspace or absolute inside workspace"},
				"max_chars": map[string]interface{}{"type": "integer", "description": "Maximum characters to return (default 12000)"},
			},
			"required": []string{"path"},
		},
	}
}

func (t *DocumentParseTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path     string `json:"path"`
		MaxChars int    `json:"max_chars"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", err
	}
	if payload.MaxChars <= 0 {
		payload.MaxChars = 12000
	}
	path, err := t.resolveWorkspacePath(payload.Path)
	if err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp":
		return "", fmt.Errorf("document_parse OCR for %s requires an OCR engine configuration; Ricochet will not auto-upload or auto-OCR sensitive files", ext)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	hash := sha1.Sum(content)
	text := string(content)
	truncated := false
	if len(text) > payload.MaxChars {
		text = text[:payload.MaxChars] + "\n\n[...document_parse truncated by max_chars...]"
		truncated = true
	}
	result := map[string]interface{}{
		"path":      filepath.ToSlash(payload.Path),
		"type":      "text",
		"hash":      hex.EncodeToString(hash[:8]),
		"chars":     len(content),
		"truncated": truncated,
		"blocks": []map[string]string{
			{"kind": "markdown", "content": text},
		},
		"note": "Parsed locally. Attach only bounded fragments to model context.",
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	return string(data), nil
}

func (t *DocumentParseTool) resolveWorkspacePath(input string) (string, error) {
	if strings.TrimSpace(input) == "" {
		return "", fmt.Errorf("path is required")
	}
	root := t.WorkspaceRoot
	if root == "" {
		root, _ = os.Getwd()
	}
	var path string
	if filepath.IsAbs(input) {
		path = filepath.Clean(input)
	} else {
		path = filepath.Join(root, input)
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("document path must be inside workspace")
	}
	return path, nil
}
