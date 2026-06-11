package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
)

func (e *NativeExecutor) resolvePath(ctx context.Context, path string) (string, error) {
	basename := filepath.Base(path)
	lowerBasename := strings.ToLower(basename)
	isMarkdownPlan := strings.HasSuffix(lowerBasename, ".md") &&
		(strings.Contains(lowerBasename, "plan") || strings.Contains(lowerBasename, "analysis") || strings.Contains(lowerBasename, "report"))
	isArtifact := isMarkdownPlan ||
		strings.Contains(lowerBasename, "implementation_plan") ||
		strings.Contains(lowerBasename, "walkthrough") ||
		strings.Contains(lowerBasename, "task.md") ||
		strings.HasSuffix(lowerBasename, ".resolved")

	if isArtifact {
		sid := protocol.GetSessionID(ctx)
		artifactDir := filepath.Join(e.host.GetCWD(), ".ricochet", "artifacts", sid)
		if err := os.MkdirAll(artifactDir, 0755); err != nil {
			return "", fmt.Errorf("failed to create artifact dir: %w", err)
		}
		return filepath.Join(artifactDir, basename), nil
	}

	if filepath.IsAbs(path) {
		return path, nil
	}
	return filepath.Join(e.host.GetCWD(), path), nil
}

func (e *NativeExecutor) ListDir(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if e.ignoreMatcher != nil {
		if err := e.ignoreMatcher.CheckPath(payload.Path); err != nil {
			return "", fmt.Errorf("ricochetignore: %w", err)
		}
	}

	infos, err := e.host.ListDir(payload.Path)
	if err != nil {
		return "", fmt.Errorf("list dir: %w", err)
	}

	var result string
	for _, info := range infos {
		typeStr := "file"
		if info.IsDir {
			typeStr = "dir"
		}
		result += fmt.Sprintf("%s (%s)\n", info.Name, typeStr)
	}

	if result == "" {
		return "(empty directory)", nil
	}
	return result, nil
}

func (e *NativeExecutor) ReadFile(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if e.ignoreMatcher != nil {
		if err := e.ignoreMatcher.CheckPath(payload.Path); err != nil {
			return "", fmt.Errorf("ricochetignore: %w", err)
		}
	}

	// Granular Check (Phase 13)
	if e.safeguard != nil && e.safeguard.Permissions != nil {
		if err := e.safeguard.CheckFileAccess(payload.Path, false); err != nil {
			return "", fmt.Errorf("safeguard: %w", err)
		}
	}

	content, err := e.host.ReadFile(payload.Path)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
	}

	return string(content), nil
}

func (e *NativeExecutor) WriteFile(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path      string `json:"path"`
		Content   string `json:"content"`
		Overwrite bool   `json:"overwrite"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if e.ignoreMatcher != nil {
		if err := e.ignoreMatcher.CheckPath(payload.Path); err != nil {
			return "", fmt.Errorf("ricochetignore: %w", err)
		}
	}

	// CRITICAL: Check if file already exists - block write_file for existing files
	// Agent MUST use replace_file_content for editing existing files to preserve diff history
	// UNLESS overwrite is explicitly set to true.
	absPath, _ := e.resolvePath(ctx, payload.Path)
	if _, err := os.Stat(absPath); err == nil {
		if !payload.Overwrite {
			return "", fmt.Errorf("ERROR: File exists. STOP. Do not try to write this file again. Use replace_file_content OR skip this step.")
		}
	}

	// Dynamic Mode check
	if allowed, msg := e.modes.CanAccessFile(payload.Path); !allowed {
		return "", fmt.Errorf("permission denied: %s", msg)
	}

	// Granular Check (Phase 13)
	if e.safeguard != nil && e.safeguard.Permissions != nil {
		if err := e.safeguard.CheckFileAccess(payload.Path, true); err != nil {
			return "", fmt.Errorf("safeguard: %w", err)
		}
	}

	originalContent := ""
	if existing, err := e.host.ReadFile(payload.Path); err == nil {
		originalContent = string(existing)
	}

	if err := e.createEditCheckpoint(payload.Path, "writing to"); err != nil {
		return "", err
	}

	applied, err := e.reviewProposedEdit(ctx, "write_file", payload.Path, fmt.Sprintf("Write to file: %s", payload.Path), originalContent, payload.Content)
	if err != nil {
		return "", err
	}

	if !applied {
		if err := e.host.WriteFile(payload.Path, []byte(payload.Content)); err != nil {
			return "", fmt.Errorf("write file: %w", err)
		}
	}

	// PHASE 11: Shadow Workspace (Linter Loop)
	// Verify the written file immediately
	bypassCorrection := false
	if e.safeguard != nil && e.safeguard.ToolsSettings != nil {
		bypassCorrection = e.safeguard.ToolsSettings.DisableLLMCorrection
	}

	if e.shadowVerifier != nil && !bypassCorrection {
		if err := e.shadowVerifier.Verify(ctx, payload.Path); err != nil {
			// We return an error to force the agent to fix it.
			// But we clarify that the file WAS written.
			return "", fmt.Errorf("file written, but failed verification: %w. Please fix the code", err)
		}
	}

	return "File written successfully", nil
}

type editReviewResponse struct {
	Decision string `json:"decision"`
	Applied  bool   `json:"applied"`
	Reason   string `json:"reason"`
}

func (e *NativeExecutor) reviewProposedEdit(ctx context.Context, tool, path, description, originalContent, newContent string) (bool, error) {
	if e.canAutoApproveAction(tool, path) {
		e.auditPermissionDecision(ctx, tool, path, "allow", "auto_approval", "")
		return false, nil
	}

	if e.safeguard != nil && e.safeguard.PermissionStore != nil {
		check := safeguard.PermissionCheck{
			Tool:      tool,
			Target:    path,
			Project:   e.host.GetCWD(),
			SessionID: protocol.GetSessionID(ctx),
		}
		switch e.safeguard.PermissionStore.Decide(check) {
		case safeguard.PermissionDeny:
			e.auditPermissionDecision(ctx, tool, path, "deny", "permission_rule", "matched deny rule")
			return false, fmt.Errorf("action denied by persistent permission rule: %s", description)
		case safeguard.PermissionAllow:
			e.auditPermissionDecision(ctx, tool, path, "allow", "permission_rule", "")
			return false, nil
		}
	}

	if e.livemode != nil && e.livemode.IsEnabled() {
		if err := e.ensureConsent(ctx, tool, path, description); err != nil {
			return false, err
		}
		return false, nil
	}

	resp, err := e.host.SendRequest("propose_edit", map[string]interface{}{
		"proposal_id":      fmt.Sprintf("edit-%d", time.Now().UnixNano()),
		"session_id":       protocol.GetSessionID(ctx),
		"tool":             tool,
		"path":             path,
		"description":      description,
		"original_content": originalContent,
		"new_content":      newContent,
	})
	if err != nil {
		if fallbackErr := e.ensureConsent(ctx, tool, path, description); fallbackErr != nil {
			return false, fallbackErr
		}
		return false, nil
	}

	var review editReviewResponse
	switch v := resp.(type) {
	case json.RawMessage:
		if err := json.Unmarshal(v, &review); err != nil {
			return false, fmt.Errorf("failed to parse proposed edit response: %w", err)
		}
	case []byte:
		if err := json.Unmarshal(v, &review); err != nil {
			return false, fmt.Errorf("failed to parse proposed edit response: %w", err)
		}
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return false, fmt.Errorf("failed to encode proposed edit response: %w", err)
		}
		if err := json.Unmarshal(raw, &review); err != nil {
			return false, fmt.Errorf("failed to parse proposed edit response: %w", err)
		}
	}

	if strings.EqualFold(review.Decision, "accepted") {
		e.auditPermissionDecision(ctx, tool, path, "allow", "inline_review", "")
		return review.Applied, nil
	}

	reason := review.Decision
	if review.Reason != "" {
		reason = review.Reason
	}
	e.auditPermissionDecision(ctx, tool, path, "deny", "inline_review", reason)
	if review.Reason != "" {
		return false, fmt.Errorf("action was not applied: %s", review.Reason)
	}
	return false, fmt.Errorf("action was rejected by user")
}

func (e *NativeExecutor) createEditCheckpoint(path, action string) error {
	if e.safeguard != nil {
		msg := fmt.Sprintf("Checkpoint before %s %s", action, path)
		if _, err := e.safeguard.CreateCheckpoint(msg); err != nil {
			return fmt.Errorf("failed to create safeguard checkpoint: %w", err)
		}
		return nil
	}

	if err := safeguard.Backup(filepath.Join(e.host.GetCWD(), path)); err != nil {
		return fmt.Errorf("safeguard backup failed: %w", err)
	}
	return nil
}

func (e *NativeExecutor) ensureConsent(ctx context.Context, tool, path, description string) error {
	if e.canAutoApproveAction(tool, path) {
		e.auditPermissionDecision(ctx, tool, path, "allow", "auto_approval", "")
		return nil
	}

	// 1. Check persistent permissions (Phase 15)
	if e.safeguard != nil && e.safeguard.PermissionStore != nil {
		check := safeguard.PermissionCheck{
			Tool:      tool,
			Target:    path,
			Project:   e.host.GetCWD(),
			SessionID: protocol.GetSessionID(ctx),
		}
		switch e.safeguard.PermissionStore.Decide(check) {
		case safeguard.PermissionDeny:
			e.auditPermissionDecision(ctx, tool, path, "deny", "permission_rule", "matched deny rule")
			return fmt.Errorf("action denied by persistent permission rule: %s", description)
		case safeguard.PermissionAllow:
			e.auditPermissionDecision(ctx, tool, path, "allow", "permission_rule", "")
			return nil
		}
	}

	// 2. Check mode context
	mode := e.modes.GetActiveMode()
	question := fmt.Sprintf("Mode: %s\n\nDo you allow Ricochet to perform the following action?\n\n%s", mode.Name, description)

	// 3. Ask User (Dual-Channel if Live Mode enabled)
	var response string
	var err error

	if e.livemode != nil && e.livemode.IsEnabled() {
		// Ether Mode: Ask via Telegram ONLY
		response, err = e.livemode.AskUserRemote(ctx, question)
	} else {
		// IDE Mode - ask via host popup only
		response, err = e.host.AskUser(protocol.GetSessionID(ctx), question)
	}

	if err != nil {
		return fmt.Errorf("failed to get user consent: %w", err)
	}

	// 4. Handle Response
	resp := strings.ToLower(strings.TrimSpace(response))

	// Handle various positive responses
	if resp == "yes" || resp == "y" || resp == "approve" || resp == "ok" {
		e.auditPermissionDecision(ctx, tool, path, "allow", "user_once", "")
		return nil
	}

	// Handle "Always" variations
	if strings.Contains(resp, "always") {
		// "always allow", "always proceed", "always"
		if e.safeguard != nil && e.safeguard.PermissionStore != nil {
			if tool == "execute_command" && e.safeguard.AutoApproval != nil {
				e.safeguard.AutoApproval.Enabled = true
				e.safeguard.AutoApproval.ExecuteAllCommands = true
			}
			err := e.safeguard.PermissionStore.AddRule(safeguard.PermissionRule{
				Tool:    tool,
				Path:    path,
				Action:  "allow",
				Scope:   safeguard.ScopeProject,
				Project: e.host.GetCWD(),
			})
			if err != nil {
				// Log but allow once
				fmt.Printf("Warning: failed to save permission: %v\n", err)
			}
		}
		e.auditPermissionDecision(ctx, tool, path, "allow", "user_always", "")
		return nil
	}

	e.auditPermissionDecision(ctx, tool, path, "deny", "user", resp)
	return fmt.Errorf("action was rejected by user")
}

func (e *NativeExecutor) canAutoApproveAction(tool, target string) bool {
	if e.safeguard == nil || e.safeguard.AutoApproval == nil || !e.safeguard.AutoApproval.Enabled {
		return false
	}

	settings := e.safeguard.AutoApproval
	switch tool {
	case "execute_command":
		if settings.ExecuteAllCommands {
			return true
		}
		return settings.ExecuteSafeCommands && safeguard.IsSafeCommand(target)
	case "delete_file":
		if e.isExternalPath(target) {
			return settings.DeleteFilesExternal
		}
		return settings.DeleteFiles
	case "write_file", "replace_file_content", "batch_edit", "apply_diff":
		if e.isExternalPath(target) {
			return settings.EditFilesExternal
		}
		return settings.EditFiles
	case "read_file", "list_dir", "codebase_search":
		if e.isExternalPath(target) {
			return settings.ReadFilesExternal
		}
		return settings.ReadFiles
	case "browser_open", "browser_click", "browser_type", "browser_screenshot", "browser_navigate":
		return settings.UseBrowser
	default:
		return false
	}
}

func (e *NativeExecutor) isExternalPath(path string) bool {
	if path == "" || path == "multiple_files" {
		return false
	}
	if !filepath.IsAbs(path) {
		return false
	}
	cwd := e.host.GetCWD()
	if cwd == "" {
		return true
	}
	rel, err := filepath.Rel(cwd, path)
	if err != nil {
		return true
	}
	return rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (e *NativeExecutor) auditPermissionDecision(ctx context.Context, tool, target, decision, source, reason string) {
	if e.safeguard == nil || e.safeguard.PermissionStore == nil {
		return
	}
	_ = e.safeguard.PermissionStore.AppendAudit(safeguard.PermissionAuditEntry{
		Tool:      tool,
		Target:    target,
		Project:   e.host.GetCWD(),
		SessionID: protocol.GetSessionID(ctx),
		Decision:  decision,
		Source:    source,
		Reason:    reason,
	})
}

func (e *NativeExecutor) CodebaseSearch(ctx context.Context, args json.RawMessage) (string, error) {
	if e.indexer == nil {
		return "", fmt.Errorf("code indexing is not enabled or indexer not initialized")
	}

	var payload struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if payload.Limit <= 0 {
		payload.Limit = 5
	}

	results, err := e.indexer.Search(ctx, payload.Query, payload.Limit)
	if err != nil {
		return "", fmt.Errorf("search failed: %w", err)
	}

	if len(results) == 0 {
		return "No relevant code sections found.", nil
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Semantic search results for '%s':\n\n", payload.Query))
	for _, res := range results {
		if e.ignoreMatcher != nil {
			if ignored, _ := e.ignoreMatcher.IsIgnored(res.Document.FilePath); ignored {
				continue
			}
		}
		sb.WriteString(fmt.Sprintf("--- %s (Lines %d-%d, Score: %.2f) ---\n",
			res.Document.FilePath, res.Document.LineStart, res.Document.LineEnd, res.Score))
		sb.WriteString(res.Document.Content)
		sb.WriteString("\n\n")
	}

	// Use NativeExecutor as receiver to access host methods
	return sb.String(), nil
}

func (e *NativeExecutor) ReplaceFileContent(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Path               string `json:"path"`
		TargetContent      string `json:"TargetContent"`
		ReplacementContent string `json:"ReplacementContent"`
		// Aliases for compatibility
		TargetFile string `json:"TargetFile"`
	}
	// Try parsing both casings to be safe
	if err := json.Unmarshal(args, &payload); err != nil {
		// Fallback for lowerCamelCase args
		var payloadLower struct {
			Path               string `json:"path"`
			TargetContent      string `json:"targetContent"`
			ReplacementContent string `json:"replacementContent"`
			TargetFile         string `json:"targetFile"`
		}
		if err2 := json.Unmarshal(args, &payloadLower); err2 != nil {
			return "", fmt.Errorf("invalid arguments: %w", err)
		}
		payload.Path = payloadLower.Path
		if payload.Path == "" {
			payload.Path = payloadLower.TargetFile
		}
		payload.TargetContent = payloadLower.TargetContent
		payload.ReplacementContent = payloadLower.ReplacementContent
	}

	// Handle alias if Path is empty
	if payload.Path == "" {
		payload.Path = payload.TargetFile
	}

	if payload.Path == "" {
		return "", fmt.Errorf("Path or TargetFile is required")
	}
	if e.ignoreMatcher != nil {
		if err := e.ignoreMatcher.CheckPath(payload.Path); err != nil {
			return "", fmt.Errorf("ricochetignore: %w", err)
		}
	}

	if payload.TargetContent == "" {
		return "", fmt.Errorf("TargetContent cannot be empty")
	}

	// Dynamic Mode check
	if allowed, msg := e.modes.CanAccessFile(payload.Path); !allowed {
		return "", fmt.Errorf("permission denied: %s", msg)
	}

	// Granular Check (Phase 13)
	if e.safeguard != nil && e.safeguard.Permissions != nil {
		if err := e.safeguard.CheckFileAccess(payload.Path, true); err != nil {
			return "", fmt.Errorf("safeguard: %w", err)
		}
	}

	// PHASE 5: Read-before-Edit Enforcement
	if e.sessionProvider != nil {
		sid := protocol.GetSessionID(ctx)
		tracker := e.sessionProvider.GetFileTracker(sid)
		if tracker != nil {
			if !tracker.HasRead(payload.Path) {
				return "", fmt.Errorf("SAFETY VIOLATION: You are attempting to edit '%s' without reading it first in this session. This is forbidden to prevent hallucinations. Please use 'read_file' to examine the content before editing.", payload.Path)
			}
		}
	}

	// Verify file exists and read it
	contentBytes, err := e.host.ReadFile(payload.Path)
	if err != nil {
		return "", fmt.Errorf("read file failed: %w", err)
	}
	content := string(contentBytes)

	// Check if target exists
	if !strings.Contains(content, payload.TargetContent) {
		return "", fmt.Errorf("TargetContent not found in file. Please ensure exact match including whitespace.")
	}

	// Verify uniqueness
	if strings.Count(content, payload.TargetContent) > 1 {
		return "", fmt.Errorf("TargetContent found multiple times. Please provide more context to make it unique.")
	}

	// Perform replacement
	newContent := strings.Replace(content, payload.TargetContent, payload.ReplacementContent, 1)

	// Delegate to WriteFile logic to handle consents and checkpoints
	// We call WriteFile but we must be careful about double-consent?
	// WriteFile asks for consent.
	// But ReplaceFileContent invocation implies we want to perform this specific action.
	// We can manually call ensuresConset here with "replace_file_content" tool name.
	// BUT WriteFile calls ensureConsent for "write_file".
	// If we call e.WriteFile, it will ask for "write_file" permission.
	// It's better to implement the logic here directly or refactor.
	// Let's implement directly to use correct tool name "replace_file_content".

	if err := e.createEditCheckpoint(payload.Path, "replace_file_content in"); err != nil {
		return "", err
	}

	applied, err := e.reviewProposedEdit(ctx, "replace_file_content", payload.Path, fmt.Sprintf("Replace content in file: %s", payload.Path), content, newContent)
	if err != nil {
		return "", err
	}

	if !applied {
		if err := e.host.WriteFile(payload.Path, []byte(newContent)); err != nil {
			return "", fmt.Errorf("write file failed: %w", err)
		}
	}

	// PHASE 5: Shadow Audit
	if e.auditor != nil {
		// Heuristic: Use the last turn's goal/context from ctx if available
		// or just audit the specific replacement.
		approved, feedback, err := e.auditor.AuditAction(ctx, "Edit file "+payload.Path, "replace_file_content", string(args), "File updated successfully", "File content should be correctly updated")
		if err == nil && !approved {
			// If rejected, we notify the agent but the file IS written.
			// This forces the agent to self-correct.
			return "File updated, but VERIFICATION REJECTED: " + feedback + ". Please review your changes and fix any errors.", nil
		}
	}

	return "File updated successfully", nil
}
