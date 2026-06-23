package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/igoryan-dao/ricochet/internal/agent"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type streamRenderOptions struct {
	jsonOut bool
	jsonl   bool
	noColor bool
}

func streamChat(ctx context.Context, c *rpcClient, w io.Writer, requestID string, opts streamRenderOptions) error {
	var events []protocol.RPCMessage
	var lastAssistantLen int
	var assistant strings.Builder

	renderer, _ := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(100),
	)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-c.messages:
			if !ok {
				return fmt.Errorf("daemon connection closed before response")
			}

			if opts.jsonOut {
				events = append(events, msg)
			}
			if opts.jsonl {
				data, _ := json.Marshal(msg)
				fmt.Fprintln(w, string(data))
			}
			if !opts.jsonOut && !opts.jsonl {
				renderTimelineEvent(w, msg, &assistant, &lastAssistantLen)
			}

			if rpcIDEqual(msg.ID, requestID) {
				if msg.Error != "" {
					if opts.jsonOut {
						writeJSON(w, events)
					}
					return errors.New(msg.Error)
				}
				if opts.jsonOut {
					writeJSON(w, events)
					return nil
				}
				if opts.jsonl {
					return nil
				}
				if strings.TrimSpace(assistant.String()) != "" {
					if out, err := renderer.Render(assistant.String()); err == nil {
						fmt.Fprintf(w, "\n%s\n%s", strings.Repeat("-", 64), out)
					}
				}
				fmt.Fprintf(w, "\n%s\n", strings.Repeat("-", 64))
				return nil
			}
		}
	}
}

func renderTimelineEvent(w io.Writer, msg protocol.RPCMessage, assistant *strings.Builder, lastAssistantLen *int) {
	switch msg.Type {
	case "chat_update":
		var payload struct {
			Message *agent.ChatMessage `json:"message"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.Message == nil {
			return
		}
		if payload.Message.Role != "assistant" {
			return
		}
		content := payload.Message.Content
		if len(content) > *lastAssistantLen {
			chunk := content[*lastAssistantLen:]
			fmt.Fprint(w, chunk)
			assistant.WriteString(chunk)
			*lastAssistantLen = len(content)
		}
	case "command_event":
		var event protocol.CommandEvent
		if err := json.Unmarshal(msg.Payload, &event); err != nil {
			return
		}
		renderCommandEvent(w, event)
	case "tool_lifecycle":
		var event protocol.ToolLifecycleEvent
		if err := json.Unmarshal(msg.Payload, &event); err != nil {
			return
		}
		renderToolLifecycleEvent(w, event)
	case "task_progress":
		var progress protocol.TaskProgress
		if err := json.Unmarshal(msg.Payload, &progress); err != nil {
			return
		}
		if cliLooksRawSystemText(progress.Event) || cliLooksRawSystemText(progress.TaskName) || cliLooksRawSystemText(progress.Status) || cliLooksRawSystemText(progress.Summary) {
			return
		}
		title := firstNonEmptyString(progress.TaskName, progress.Summary, "task")
		status := firstNonEmptyString(progress.Status, progress.Event)
		fmt.Fprintf(w, "\n[progress] %s", title)
		if status != "" {
			fmt.Fprintf(w, " - %s", status)
		}
		fmt.Fprintln(w)
	case "context_status":
		var status protocol.ContextStatus
		if err := json.Unmarshal(msg.Payload, &status); err != nil {
			return
		}
		if status.TokensMax > 0 {
			fmt.Fprintf(w, "\n[context] %.1f%% (%d/%d tokens)\n", status.Percentage, status.TokensUsed, status.TokensMax)
		}
	case "usage_update":
		var payload map[string]interface{}
		if err := json.Unmarshal(msg.Payload, &payload); err == nil {
			if cost, ok := payload["total_cost"].(float64); ok && cost > 0 {
				fmt.Fprintf(w, "\n[usage] $%.4f\n", cost)
			}
		}
	case "checkpoint_event":
		var event protocol.CheckpointEvent
		if err := json.Unmarshal(msg.Payload, &event); err != nil {
			return
		}
		label := firstNonEmptyString(event.Event, "checkpoint")
		if event.Hash != "" {
			fmt.Fprintf(w, "\n[checkpoint] %s %s\n", label, event.Hash)
		} else {
			fmt.Fprintf(w, "\n[checkpoint] %s\n", label)
		}
	case "message_queued":
		fmt.Fprintln(w, "\n[queue] Message queued for the active run.")
	case "queued_message_error":
		if msg.Error != "" {
			fmt.Fprintf(w, "\n[queue] %s\n", msg.Error)
		}
	}
}

func renderToolLifecycleEvent(w io.Writer, event protocol.ToolLifecycleEvent) {
	title, detail := classifyCLIToolEvent(event)
	if title == "" {
		return
	}
	status := firstNonEmptyString(event.Status, event.Event)
	path := firstNonEmptyString(firstCLIFile(event.AffectedFiles), extractCLIPath(event.ArgsSummary), extractCLIPath(event.OutputPreview))
	lineRange := normalizeCLILineRange(firstNonEmptyString(event.ArgsSummary, event.OutputPreview))
	meta := []string{}
	if detail != "" {
		meta = append(meta, detail)
	}
	if path != "" {
		if lineRange != "" {
			path += " " + lineRange
		}
		meta = append(meta, path)
	}
	if event.DurationMs > 0 {
		meta = append(meta, formatDurationMs(event.DurationMs))
	}
	if status != "" {
		meta = append(meta, status)
	}
	fmt.Fprintf(w, "\n[%s]", title)
	if len(meta) > 0 {
		fmt.Fprintf(w, " %s", strings.Join(meta, " • "))
	}
	fmt.Fprintln(w)
	if event.Error != "" {
		fmt.Fprintf(w, "[error] %s\n", event.Error)
	}
}

func renderCommandEvent(w io.Writer, event protocol.CommandEvent) {
	switch event.Event {
	case "command_started":
		fmt.Fprintf(w, "\n[command] %s\n", event.Command)
		if event.Cwd != "" || event.Shell != "" {
			fmt.Fprintf(w, "          cwd=%s shell=%s\n", event.Cwd, event.Shell)
		}
	case "command_output":
		if event.OutputChunk != "" {
			fmt.Fprint(w, event.OutputChunk)
		}
	case "command_succeeded", "command_failed":
		status := "ok"
		if event.Event == "command_failed" || event.Status == "failed" || event.ExitCode != 0 {
			status = "failed"
		}
		if event.ResultPreview != "" {
			fmt.Fprint(w, event.ResultPreview)
			if !strings.HasSuffix(event.ResultPreview, "\n") {
				fmt.Fprintln(w)
			}
		}
		fmt.Fprintf(w, "[command:%s] exit=%d duration=%s\n", status, event.ExitCode, formatDurationMs(event.DurationMs))
		if event.Error != "" {
			fmt.Fprintf(w, "[command:error] %s\n", event.Error)
		}
	}
}

func writeJSON(w io.Writer, value interface{}) {
	data, _ := json.MarshalIndent(value, "", "  ")
	fmt.Fprintln(w, string(data))
}

func firstMapString(payload map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func classifyCLIToolEvent(event protocol.ToolLifecycleEvent) (string, string) {
	source := strings.ToLower(strings.TrimSpace(event.ToolName + " " + event.ArgsSummary))
	switch {
	case strings.Contains(source, "list_dir") || strings.Contains(source, "folder"):
		return "Explored", "Analyzed"
	case strings.Contains(source, "search") || strings.Contains(source, "grep") || strings.Contains(source, "rg "):
		return "Explored", "Searched"
	case strings.Contains(source, "read") || strings.Contains(source, "analyze"):
		return "Explored", "Read"
	case strings.Contains(source, "edit") || strings.Contains(source, "apply_patch") || strings.Contains(source, "write_file"):
		return "Edited", "Changed"
	case strings.Contains(source, "review") || strings.Contains(source, "audit") || strings.Contains(source, "reject") || strings.Contains(source, "verification"):
		return "Review", "Verification"
	case strings.Contains(source, "approval") || strings.Contains(source, "permission"):
		return "Approvals", "Permission"
	case strings.Contains(source, "artifact"):
		return "Artifacts", "Created"
	case strings.Contains(source, "create_task") || strings.Contains(source, "add_subtask") || strings.Contains(source, "hub task"):
		return "Created Hub Tasks", ""
	default:
		return firstNonEmptyString(event.ToolName, "Tool"), event.ArgsSummary
	}
}

func firstCLIFile(files []string) string {
	for _, file := range files {
		if strings.TrimSpace(file) != "" {
			return file
		}
	}
	return ""
}

var cliLineRangePattern = regexp.MustCompile(`(?i)\bL(\d+)\s*[-:]\s*L?(\d+)\b`)

func normalizeCLILineRange(value string) string {
	match := cliLineRangePattern.FindStringSubmatch(value)
	if len(match) == 3 {
		return "L" + match[1] + "-L" + match[2]
	}
	return ""
}

func extractCLIPath(value string) string {
	if cliLooksRawSystemText(value) {
		return ""
	}
	for _, field := range strings.Fields(value) {
		clean := strings.Trim(field, "`\"',;")
		if strings.HasPrefix(clean, "path=") || strings.HasPrefix(clean, "file=") {
			return strings.TrimPrefix(strings.TrimPrefix(clean, "path="), "file=")
		}
		if strings.Contains(clean, "/") || strings.Contains(clean, ".") {
			return clean
		}
	}
	return ""
}

func cliLooksRawSystemText(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	lower := strings.ToLower(value)
	if strings.Contains(lower, "planning task") || strings.Contains(lower, "running task") || strings.Contains(lower, "task_boundary") {
		return true
	}
	return strings.HasPrefix(value, "{") || strings.HasPrefix(value, "[")
}

func formatDurationMs(ms int64) string {
	if ms <= 0 {
		return "0ms"
	}
	return (time.Duration(ms) * time.Millisecond).String()
}
