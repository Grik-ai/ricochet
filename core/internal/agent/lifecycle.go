package agent

import (
	"bufio"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// LifecycleRecorder persists tool lifecycle events as an append-only JSONL log.
// The controller treats this as best-effort durability: failures must not break
// the active agent loop, but replay lets UI/audit code reconstruct recent runs.
type LifecycleRecorder struct {
	mu   sync.Mutex
	path string
}

func NewLifecycleRecorder(path string) *LifecycleRecorder {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	return &LifecycleRecorder{path: path}
}

func (c *Controller) emitToolLifecycle(input ChatRequestInput, tc ToolCallInfo, event string, startedAt time.Time, result string, err error, callback func(interface{})) {
	lifecycleEvent := buildToolLifecycleEvent(input, tc, event, startedAt, result, err)
	log.Printf("[ToolLifecycle] run=%s tool=%s status=%s files=%d error=%q",
		lifecycleEvent.RunID,
		lifecycleEvent.ToolName,
		lifecycleEvent.Status,
		len(lifecycleEvent.AffectedFiles),
		truncateString(lifecycleEvent.Error, 160),
	)
	if c != nil && c.lifecycleRecorder != nil {
		_ = c.lifecycleRecorder.Append(lifecycleEvent)
	}
	if callback != nil {
		callback(lifecycleEvent)
	}
}

func (c *Controller) ReplayToolLifecycleEvents(limit int) ([]protocol.ToolLifecycleEvent, error) {
	if c == nil || c.lifecycleRecorder == nil {
		return nil, nil
	}
	return c.lifecycleRecorder.Replay(limit)
}

func (r *LifecycleRecorder) Append(event protocol.ToolLifecycleEvent) error {
	if r == nil || strings.TrimSpace(r.path) == "" {
		return nil
	}
	if event.Timestamp == 0 {
		event.Timestamp = time.Now().UnixMilli()
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(r.path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := file.Write(append(raw, '\n')); err != nil {
		return err
	}
	return file.Sync()
}

func (r *LifecycleRecorder) Replay(limit int) ([]protocol.ToolLifecycleEvent, error) {
	if r == nil || strings.TrimSpace(r.path) == "" {
		return nil, nil
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	file, err := os.Open(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()

	events := []protocol.ToolLifecycleEvent{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event protocol.ToolLifecycleEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}
		events = append(events, event)
		if limit > 0 && len(events) > limit {
			events = events[len(events)-limit:]
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

func buildToolLifecycleEvent(input ChatRequestInput, tc ToolCallInfo, event string, startedAt time.Time, result string, err error) protocol.ToolLifecycleEvent {
	now := time.Now()
	status := "running"
	completedAt := int64(0)
	durationMs := int64(0)
	errorText := ""
	outputPreview := ""

	switch event {
	case "tool_finished":
		status = "completed"
		completedAt = now.UnixMilli()
		durationMs = now.Sub(startedAt).Milliseconds()
		outputPreview = truncateString(result, 1000)
	case "tool_failed":
		status = "failed"
		completedAt = now.UnixMilli()
		durationMs = now.Sub(startedAt).Milliseconds()
		if err != nil {
			errorText = err.Error()
		}
		outputPreview = truncateString(result, 1000)
	case "tool_aborted":
		status = "aborted"
		completedAt = now.UnixMilli()
		durationMs = now.Sub(startedAt).Milliseconds()
		if err != nil {
			errorText = err.Error()
		}
	}

	return protocol.ToolLifecycleEvent{
		SessionID:     input.SessionID,
		RunID:         input.RunID,
		TurnID:        input.RunID,
		ToolUseID:     tc.ID,
		ToolName:      tc.Name,
		Source:        toolLifecycleSource(input),
		Status:        status,
		Event:         event,
		StartedAt:     startedAt.UnixMilli(),
		CompletedAt:   completedAt,
		DurationMs:    durationMs,
		ArgsSummary:   summarizeToolArgs(tc.Name, tc.Arguments),
		AffectedFiles: extractAffectedFiles(tc.Arguments),
		Error:         errorText,
		OutputPreview: outputPreview,
		Timestamp:     now.UnixMilli(),
	}
}

func toolLifecycleSource(input ChatRequestInput) string {
	if strings.TrimSpace(input.Via) != "" {
		return input.Via
	}
	return "assistant"
}

func summarizeToolArgs(toolName, raw string) string {
	var args map[string]interface{}
	if json.Unmarshal([]byte(raw), &args) != nil {
		return truncateString(raw, 240)
	}

	for _, key := range []string{"command", "query", "path", "TargetFile", "AbsolutePath", "file_path", "pattern", "TaskName", "task_id"} {
		if val, ok := args[key]; ok {
			if text := strings.TrimSpace(toString(val)); text != "" {
				if key == "TargetFile" || key == "AbsolutePath" || key == "path" || key == "file_path" {
					text = filepath.Clean(text)
				}
				return truncateString(text, 240)
			}
		}
	}

	if len(args) == 0 {
		return toolName
	}
	encoded, _ := json.Marshal(args)
	return truncateString(string(encoded), 240)
}

func extractAffectedFiles(raw string) []string {
	var args map[string]interface{}
	if json.Unmarshal([]byte(raw), &args) != nil {
		return nil
	}

	seen := map[string]bool{}
	var files []string
	for _, key := range []string{"path", "TargetFile", "AbsolutePath", "file_path"} {
		if val, ok := args[key]; ok {
			addAffectedFile(&files, seen, toString(val))
		}
	}
	if vals, ok := args["files"].([]interface{}); ok {
		for _, val := range vals {
			addAffectedFile(&files, seen, toString(val))
		}
	}
	return files
}

func addAffectedFile(files *[]string, seen map[string]bool, raw string) {
	file := strings.TrimSpace(raw)
	if file == "" {
		return
	}
	file = filepath.Clean(file)
	if seen[file] {
		return
	}
	seen[file] = true
	*files = append(*files, file)
}

func toString(v interface{}) string {
	switch value := v.(type) {
	case string:
		return value
	default:
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
}
