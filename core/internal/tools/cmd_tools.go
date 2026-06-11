package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// Pattern to detect sed/awk commands that modify files
var fileModifyPattern = regexp.MustCompile(`(?i)^(sed|awk|perl)\s+.*[>|]\s*\S+\.`)

func (e *NativeExecutor) ExecuteCommand(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Command    string `json:"command"`
		Background bool   `json:"background"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	// Check for file modification commands (sed, awk) - redirect to replace_file_content
	cmd := strings.TrimSpace(payload.Command)
	if fileModifyPattern.MatchString(cmd) ||
		(strings.HasPrefix(cmd, "sed") && (strings.Contains(cmd, ">") || strings.Contains(cmd, "-i"))) {
		return "", fmt.Errorf("❌ DO NOT use sed/awk to modify files. Use 'replace_file_content' tool instead. This ensures proper diff visualization, checkpoints, and undo capability")
	}
	if e.ignoreMatcher != nil {
		if err := e.ignoreMatcher.CheckCommand(cmd); err != nil {
			return "", fmt.Errorf("ricochetignore: %w", err)
		}
	}

	// INTERACTIVE CONSENT (Phase 11)
	actionDesc := fmt.Sprintf("Execute command: %s", payload.Command)
	if payload.Background {
		actionDesc += " (in background)"
	}

	// 1. Granular Permission Check (Phase 13)
	if e.safeguard != nil && e.safeguard.Permissions != nil {
		if err := e.safeguard.CheckCommand(payload.Command); err != nil {
			return "", fmt.Errorf("safeguard: %w", err)
		}
	}

	if err := e.ensureConsent(ctx, "execute_command", payload.Command, actionDesc); err != nil {
		return "", err
	}

	startedAt := time.Now()
	e.emitCommandLifecycleEvent(ctx, protocol.CommandEvent{
		Event:     "command_started",
		Command:   cmd,
		Cwd:       e.host.GetCWD(),
		Shell:     "sh",
		Status:    "running",
		StartedAt: startedAt.UnixMilli(),
	})

	var finalEmitted atomic.Bool
	execCtx := host.WithCommandEventSink(ctx, func(ev host.CommandOutputEvent) {
		event := "command_output"
		status := "running"
		completedAt := int64(0)
		durationMs := int64(0)
		if ev.Status == host.StatusCompleted {
			event = "command_succeeded"
			status = "completed"
			finalEmitted.Store(true)
		} else if ev.Status == host.StatusFailed {
			event = "command_failed"
			status = "failed"
			finalEmitted.Store(true)
		}
		if !ev.EndTime.IsZero() {
			completedAt = ev.EndTime.UnixMilli()
			durationMs = ev.EndTime.Sub(ev.StartTime).Milliseconds()
		}
		if event == "command_output" && ev.Output == "" {
			return
		}
		e.emitCommandLifecycleEvent(ctx, protocol.CommandEvent{
			CommandID:   ev.ID,
			Event:       event,
			Command:     cmd,
			Cwd:         ev.Cwd,
			Shell:       "sh",
			Status:      status,
			OutputChunk: ev.Output,
			Error:       ev.Error,
			ExitCode:    ev.ExitCode,
			DurationMs:  durationMs,
			StartedAt:   ev.StartTime.UnixMilli(),
			CompletedAt: completedAt,
			Truncated:   ev.Truncated,
		})
	})

	res, err := e.host.ExecuteCommand(execCtx, payload.Command, payload.Background)
	if err != nil {
		if !finalEmitted.Load() {
			e.emitCommandLifecycleEvent(ctx, protocol.CommandEvent{
				Event:       "command_failed",
				Command:     cmd,
				Cwd:         e.host.GetCWD(),
				Shell:       "sh",
				Status:      "failed",
				Error:       err.Error(),
				StartedAt:   startedAt.UnixMilli(),
				CompletedAt: time.Now().UnixMilli(),
			})
		}
		return "", fmt.Errorf("execution failed: %w", err)
	}

	if payload.Background {
		return fmt.Sprintf("Command started in background. ID: %s\nUse command_status to check progress.", res.ID), nil
	}

	return res.Output, nil
}

func (e *NativeExecutor) emitCommandLifecycleEvent(ctx context.Context, event protocol.CommandEvent) {
	now := time.Now().UnixMilli()
	if event.SessionID == "" {
		event.SessionID = protocol.GetSessionID(ctx)
	}
	if event.RunID == "" {
		event.RunID = protocol.GetRunID(ctx)
	}
	if event.TurnID == "" {
		event.TurnID = event.RunID
	}
	if event.ToolUseID == "" {
		event.ToolUseID = protocol.GetToolUseID(ctx)
	}
	if event.Timestamp == 0 {
		event.Timestamp = now
	}
	if event.StartedAt == 0 {
		event.StartedAt = now
	}
	e.host.SendMessage(protocol.RPCMessage{
		Type:    "command_event",
		Payload: protocol.EncodeRPC(event),
	})
}

func (e *NativeExecutor) GetCommandStatus(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	workerID := payload.ID
	if !strings.HasPrefix(workerID, "agent-") {
		workerID = "agent-" + workerID
	}
	if e.swarmProvider != nil {
		status, ok := e.swarmProvider.GetSubtaskStatus(workerID)
		if ok {
			return status, nil
		}
	}

	if strings.HasPrefix(payload.ID, "agent-") {
		if e.swarmProvider != nil {
			status, ok := e.swarmProvider.GetSubtaskStatus(payload.ID)
			if ok {
				return status, nil
			}
		}
		return "", fmt.Errorf("swarm worker not found: %s", payload.ID)
	}

	status, ok := e.host.GetCommandStatus(payload.ID)
	if !ok {
		return "", fmt.Errorf("command not found: %s", payload.ID)
	}

	res, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal status: %w", err)
	}

	return string(res), nil
}
