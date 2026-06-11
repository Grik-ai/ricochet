package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/safeguard"
)

// BatchEditTool handles multiple file operations in a single atomic-like batch.
// It creates a single checkpoint for the entire operation.
type BatchEditTool struct {
	executor *NativeExecutor
}

type fileEdit struct {
	Path               string `json:"path"`
	Type               string `json:"type"`                          // "write" or "replace"
	Content            string `json:"content,omitempty"`             // for type="write"
	TargetContent      string `json:"target_content,omitempty"`      // for type="replace"
	ReplacementContent string `json:"replacement_content,omitempty"` // for type="replace"
}

type batchEditArgs struct {
	Edits []fileEdit `json:"edits"`
}

// BatchEdit performs multiple file operations.
func (e *NativeExecutor) BatchEdit(ctx context.Context, args json.RawMessage) (string, error) {
	var payload batchEditArgs
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if len(payload.Edits) == 0 {
		return "No edits provided", nil
	}

	// 1. Validation Phase
	for _, edit := range payload.Edits {
		if edit.Path == "" {
			return "", fmt.Errorf("missing path in edit")
		}
		if edit.Type != "write" && edit.Type != "replace" {
			return "", fmt.Errorf("invalid edit type: %s (must be 'write' or 'replace')", edit.Type)
		}
		if e.ignoreMatcher != nil {
			if err := e.ignoreMatcher.CheckPath(edit.Path); err != nil {
				return "", fmt.Errorf("ricochetignore error for %s: %w", edit.Path, err)
			}
		}

		// Permission Check
		if allowed, msg := e.modes.CanAccessFile(edit.Path); !allowed {
			return "", fmt.Errorf("permission denied for %s: %s", edit.Path, msg)
		}

		if e.safeguard != nil && e.safeguard.Permissions != nil {
			if err := e.safeguard.CheckFileAccess(edit.Path, true); err != nil {
				return "", fmt.Errorf("safeguard error for %s: %w", edit.Path, err)
			}
		}
	}

	// 2. Consent Phase (Single consent for the whole batch)
	description := fmt.Sprintf("Perform batch edit on %d files:\n", len(payload.Edits))
	for _, edit := range payload.Edits {
		description += fmt.Sprintf("- %s (%s)\n", edit.Path, edit.Type)
	}

	if err := e.ensureConsent(ctx, "batch_edit", "multiple_files", description); err != nil {
		return "", err
	}

	// 3. Checkpoint Phase (Single checkpoint for the whole batch)
	if e.safeguard != nil {
		msg := fmt.Sprintf("Checkpoint before batch edit of %d files", len(payload.Edits))
		if _, err := e.safeguard.CreateCheckpoint(msg); err != nil {
			return "", fmt.Errorf("failed to create safeguard checkpoint: %w", err)
		}
	} else {
		// Fallback: backup individual files
		for _, edit := range payload.Edits {
			absPath, _ := e.resolvePath(ctx, edit.Path)
			if _, err := os.Stat(absPath); err == nil {
				if err := safeguard.Backup(absPath); err != nil {
					return "", fmt.Errorf("backup failed for %s: %w", edit.Path, err)
				}
			}
		}
	}

	// 4. Execution Phase
	var summary []string
	for i, edit := range payload.Edits {
		var err error
		switch edit.Type {
		case "write":
			err = e.host.WriteFile(edit.Path, []byte(edit.Content))
		case "replace":
			err = e.applyReplace(edit)
		}

		if err != nil {
			return "", fmt.Errorf("failed edit #%d (%s): %w", i+1, edit.Path, err)
		}
		summary = append(summary, fmt.Sprintf("✅ %s: %s", edit.Type, edit.Path))
	}

	return "Batch edit completed successfully:\n" + strings.Join(summary, "\n"), nil
}

func (e *NativeExecutor) applyReplace(edit fileEdit) error {
	contentBytes, err := e.host.ReadFile(edit.Path)
	if err != nil {
		return fmt.Errorf("read failed: %w", err)
	}
	content := string(contentBytes)

	if !strings.Contains(content, edit.TargetContent) {
		return fmt.Errorf("TargetContent not found")
	}

	if strings.Count(content, edit.TargetContent) > 1 {
		return fmt.Errorf("TargetContent found multiple times (not unique)")
	}

	newContent := strings.Replace(content, edit.TargetContent, edit.ReplacementContent, 1)
	return e.host.WriteFile(edit.Path, []byte(newContent))
}
