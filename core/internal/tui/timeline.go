package tui

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/tui/style"
)

func (m *Model) applyCommandEvent(event protocol.CommandEvent) {
	id := firstNonEmpty(event.ToolUseID, event.CommandID, event.Command, fmt.Sprintf("command-%d", event.Timestamp))
	item := m.CommandItems[id]
	if item == nil {
		item = &TimelineItem{Kind: "command", ID: id, ToolUseID: event.ToolUseID, Expanded: false}
		m.CommandItems[id] = item
		m.Timeline = append(m.Timeline, item)
	}
	item.Title = "Command"
	item.Command = firstNonEmpty(event.Command, item.Command)
	item.Cwd = firstNonEmpty(event.Cwd, item.Cwd)
	item.Shell = firstNonEmpty(event.Shell, item.Shell)
	item.Error = firstNonEmpty(event.Error, item.Error)
	item.ExitCode = event.ExitCode
	item.Stream = firstNonEmpty(event.Stream, item.Stream)
	item.Sequence = firstNonZeroInt64(event.Sequence, item.Sequence)
	item.Source = firstNonEmpty(event.Source, item.Source)
	item.Background = item.Background || event.Background
	item.ProcessID = firstNonZeroInt(event.ProcessID, item.ProcessID)
	item.TerminalID = firstNonEmpty(event.TerminalID, item.TerminalID)
	item.LogFile = firstNonEmpty(event.LogFile, item.LogFile)
	item.StdoutPreview = firstNonEmpty(event.StdoutPreview, item.StdoutPreview)
	item.StderrPreview = firstNonEmpty(event.StderrPreview, item.StderrPreview)
	item.ExitSignal = firstNonEmpty(event.ExitSignal, item.ExitSignal)
	item.DurationMs = firstNonZeroInt64(event.DurationMs, item.DurationMs)
	item.StartedAt = firstNonZeroInt64(event.StartedAt, item.StartedAt)
	item.CompletedAt = firstNonZeroInt64(event.CompletedAt, item.CompletedAt)
	item.Truncated = item.Truncated || event.Truncated

	switch event.Event {
	case "command_started":
		item.Status = "running"
		m.IsLoading = true
		m.CurrentAction = "Running command"
	case "command_output":
		item.Status = firstNonEmpty(event.Status, item.Status, "running")
		item.Output += formatCommandOutputChunk(event)
		m.IsLoading = true
		m.CurrentAction = "Streaming command output"
	case "command_succeeded":
		item.Status = firstNonEmpty(event.Status, "succeeded")
		if item.Output == "" {
			item.Output = firstNonEmpty(event.ResultPreview, event.StdoutPreview, event.StderrPreview)
		}
		m.CurrentAction = "Command succeeded"
	case "command_failed":
		item.Status = firstNonEmpty(event.Status, "failed")
		if item.Output == "" {
			item.Output = firstNonEmpty(event.ResultPreview, event.StdoutPreview, event.StderrPreview)
		}
		m.CurrentAction = "Command failed"
	default:
		item.Status = firstNonEmpty(event.Status, item.Status)
	}
}

func formatCommandOutputChunk(event protocol.CommandEvent) string {
	if event.Stream != "stderr" || event.OutputChunk == "" {
		return event.OutputChunk
	}
	lines := strings.SplitAfter(event.OutputChunk, "\n")
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines[i] = "[stderr] " + line
	}
	return strings.Join(lines, "")
}

func (m *Model) applyTimelineNotice(msg TimelineNoticeMsg) {
	id := firstNonEmpty(msg.Kind, msg.Title, fmt.Sprintf("notice-%d", msg.Timestamp))
	if msg.Timestamp > 0 {
		id = fmt.Sprintf("%s-%d", id, msg.Timestamp)
	}
	item := &TimelineItem{
		Kind:       "event",
		ID:         id,
		Section:    firstNonEmpty(msg.Kind, msg.Title),
		Title:      firstNonEmpty(msg.Title, msg.Kind),
		Status:     msg.Status,
		Detail:     msg.Detail,
		Path:       msg.Path,
		LineRange:  normalizeLineRange(msg.LineRange),
		Output:     msg.Output,
		Error:      msg.Error,
		DurationMs: msg.DurationMs,
	}
	m.Timeline = append(m.Timeline, item)
	if msg.Status == "running" {
		m.IsLoading = true
		m.CurrentAction = msg.Title
	}
}

func (m *Model) applyToolLifecycleEvent(event protocol.ToolLifecycleEvent) {
	id := firstNonEmpty(event.ToolUseID, event.ToolName, fmt.Sprintf("tool-%d", event.Timestamp))
	item := m.ToolItems[id]
	if item == nil {
		item = &TimelineItem{Kind: "event", ID: id, ToolUseID: event.ToolUseID}
		m.ToolItems[id] = item
		m.Timeline = append(m.Timeline, item)
	}
	item.Section, item.Title, item.Detail = classifyToolLifecycleEvent(event, item)
	item.Status = firstNonEmpty(event.Status, item.Status)
	item.Error = firstNonEmpty(event.Error, item.Error)
	item.DurationMs = firstNonZeroInt64(event.DurationMs, item.DurationMs)
	item.StartedAt = firstNonZeroInt64(event.StartedAt, item.StartedAt)
	item.CompletedAt = firstNonZeroInt64(event.CompletedAt, item.CompletedAt)
	item.AffectedFiles = appendUniqueStrings(item.AffectedFiles, event.AffectedFiles...)
	if event.ArgsSummary != "" {
		item.Command = event.ArgsSummary
	}
	item.Path = firstNonEmpty(item.Path, firstAffectedFile(event.AffectedFiles), extractPath(event.ArgsSummary), extractPath(event.OutputPreview))
	item.LineRange = firstNonEmpty(item.LineRange, normalizeLineRange(event.ArgsSummary), normalizeLineRange(event.OutputPreview))
	if event.OutputPreview != "" {
		item.Output = event.OutputPreview
	}
	if event.Status == "running" {
		m.IsLoading = true
		m.CurrentAction = "Running " + item.Title
	}
}

func (m *Model) toggleLastTimelineExpansion() bool {
	for i := len(m.Timeline) - 1; i >= 0; i-- {
		item := m.Timeline[i]
		if item.Kind == "command" && strings.TrimSpace(item.Output) != "" {
			item.Expanded = !item.Expanded
			return true
		}
	}
	return false
}

func RenderTimeline(items []*TimelineItem, width int) string {
	if len(items) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, item := range items {
		switch item.Kind {
		case "command":
			sb.WriteString(renderCommandTimelineItem(item, width))
		case "event", "tool":
			sb.WriteString(renderEventTimelineItem(item))
		default:
			if strings.TrimSpace(item.Title) != "" {
				sb.WriteString(style.SystemStyle.Render(item.Title) + "\n")
			}
		}
	}
	return sb.String()
}

func renderEventTimelineItem(item *TimelineItem) string {
	icon := "•"
	iconStyle := style.MutedStyle
	switch item.Status {
	case "running":
		iconStyle = style.FocusStyle
	case "completed", "succeeded":
		icon = "✓"
		iconStyle = style.SuccessStyle
	case "failed", "aborted":
		icon = "x"
		iconStyle = style.DangerStyle
	}
	meta := []string{}
	if item.DurationMs > 0 {
		meta = append(meta, formatTimelineDuration(item.DurationMs))
	}
	if len(item.AffectedFiles) > 0 {
		meta = append(meta, fmt.Sprintf("%d files", len(item.AffectedFiles)))
	}
	title := firstNonEmpty(item.Title, item.Section, "Event")
	line := fmt.Sprintf("%s %s", iconStyle.Render(icon), style.UserStyle.Render(title))
	details := []string{}
	if item.Detail != "" {
		details = append(details, item.Detail)
	}
	if item.Path != "" {
		path := item.Path
		if item.LineRange != "" {
			path += " " + item.LineRange
		}
		details = append(details, path)
	} else if item.LineRange != "" {
		details = append(details, item.LineRange)
	}
	if item.Command != "" && item.Path == "" && !looksRawSystemText(item.Command) {
		details = append(details, item.Command)
	}
	if len(details) > 0 {
		line += " " + style.MetaStyle.Render(strings.Join(details, " "))
	}
	if len(meta) > 0 {
		line += " " + style.MetaStyle.Render(strings.Join(meta, " • "))
	}
	if item.Error != "" {
		line += "\n  " + style.DangerStyle.Render(item.Error)
	}
	if output := renderTimelineOutput(item); output != "" && item.Status == "failed" {
		line += "\n" + strings.TrimRight(output, "\n")
	}
	return line + "\n"
}

func renderCommandTimelineItem(item *TimelineItem, width int) string {
	statusStyle := style.FocusStyle
	icon := "•"
	status := firstNonEmpty(item.Status, "running")
	switch status {
	case "succeeded", "completed":
		statusStyle = style.SuccessStyle
		icon = "✓"
	case "failed", "killed", "timeout":
		statusStyle = style.DangerStyle
		icon = "x"
	case "aborted":
		statusStyle = style.WarningStyle
		icon = "!"
	}

	command := strings.TrimSpace(item.Command)
	if command == "" {
		command = "(command)"
	}
	if width > 40 {
		command = truncateRunes(command, width-18)
	}

	meta := []string{}
	if item.Cwd != "" {
		meta = append(meta, "cwd="+item.Cwd)
	}
	if item.Shell != "" {
		meta = append(meta, "shell="+item.Shell)
	}
	if item.Source != "" {
		meta = append(meta, "source="+item.Source)
	}
	if item.Stream != "" && item.Stream != "stdout" {
		meta = append(meta, "stream="+item.Stream)
	}
	if item.ProcessID > 0 {
		meta = append(meta, fmt.Sprintf("pid=%d", item.ProcessID))
	}
	if item.TerminalID != "" {
		meta = append(meta, "terminal="+truncateRunes(item.TerminalID, 12))
	}
	if item.DurationMs > 0 {
		meta = append(meta, formatTimelineDuration(item.DurationMs))
	}
	if item.CompletedAt > 0 && item.ExitCode != 0 {
		meta = append(meta, fmt.Sprintf("exit=%d", item.ExitCode))
	}
	if item.ExitSignal != "" {
		meta = append(meta, "signal="+item.ExitSignal)
	}
	if item.LogFile != "" {
		meta = append(meta, "log="+item.LogFile)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%s %s %s\n", statusStyle.Render(icon), style.CommandStyle.Render(statusLabel(status)), style.UserStyle.Render(command)))
	if len(meta) > 0 {
		sb.WriteString("  " + style.MetaStyle.Render(strings.Join(meta, " • ")) + "\n")
	}
	if item.Error != "" {
		sb.WriteString("  " + style.DangerStyle.Render(item.Error) + "\n")
	}

	output := renderTimelineOutput(item)
	if output != "" {
		sb.WriteString(output)
	}
	return sb.String()
}

func renderTimelineOutput(item *TimelineItem) string {
	raw := strings.TrimRight(item.Output, "\n")
	if raw == "" {
		if item.Status == "succeeded" || item.Status == "completed" {
			return "  " + style.MetaStyle.Render("(no output)") + "\n"
		}
		return ""
	}
	lines := strings.Split(raw, "\n")
	display := lines
	hidden := 0
	if !item.Expanded && len(lines) > 5 {
		if len(lines) > 10 {
			display = append(append([]string{}, lines[:3]...), lines[len(lines)-2:]...)
			hidden = len(lines) - 5
		} else {
			display = lines[:5]
			hidden = len(lines) - 5
		}
	}
	var sb strings.Builder
	border := style.BorderColor
	outStyle := style.MutedStyle
	if item.Status == "failed" || item.Status == "killed" || item.Status == "timeout" {
		outStyle = lipgloss.NewStyle().Foreground(style.Danger)
	}
	sb.WriteString(border.Render("  ┌ output") + "\n")
	for _, line := range display {
		sb.WriteString(border.Render("  │ ") + outStyle.Render(truncateRunes(line, 500)) + "\n")
	}
	if hidden > 0 || item.Truncated {
		msg := fmt.Sprintf("+%d lines hidden, ctrl+r to expand", hidden)
		if item.Truncated {
			msg += ", truncated"
		}
		sb.WriteString(border.Render("  │ ") + style.MetaStyle.Render(msg) + "\n")
	}
	sb.WriteString(border.Render("  └") + "\n")
	return sb.String()
}

func statusLabel(status string) string {
	switch status {
	case "running":
		return "Running"
	case "succeeded", "completed":
		return "Ran"
	case "failed":
		return "Failed"
	case "aborted":
		return "Aborted"
	case "killed":
		return "Killed"
	case "timeout":
		return "Timed out"
	case "waiting_input":
		return "Waiting"
	default:
		return status
	}
}

func formatTimelineDuration(ms int64) string {
	if ms <= 0 {
		return "0ms"
	}
	return (time.Duration(ms) * time.Millisecond).String()
}

func firstNonZeroInt64(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonZeroInt(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func classifyToolLifecycleEvent(event protocol.ToolLifecycleEvent, item *TimelineItem) (string, string, string) {
	name := strings.ToLower(strings.TrimSpace(event.ToolName))
	args := strings.ToLower(event.ArgsSummary)
	source := name + " " + args
	switch {
	case containsAny(source, "list_dir", "list directory", "read_dir", "analyze directory", "folder"):
		return "Explored", "Explored", "Analyzed"
	case containsAny(source, "search", "grep", "rg ", "file_search"):
		return "Explored", "Explored", "Searched"
	case containsAny(source, "read", "analyze", "cat ", "open file"):
		return "Explored", "Explored", "Read"
	case containsAny(source, "edit", "apply_patch", "write_file", "replace"):
		return "Edited", "Edited", firstNonEmpty(item.Detail, "Changed")
	case containsAny(source, "review", "audit", "reject", "verification"):
		return "Review", "Review", firstNonEmpty(item.Detail, "Verification")
	case containsAny(source, "approval", "permission", "request_permission"):
		return "Approvals", "Approvals", firstNonEmpty(item.Detail, "Permission")
	case containsAny(source, "artifact", "document", "plan artifact"):
		return "Artifacts", "Artifacts", firstNonEmpty(item.Detail, "Created")
	case containsAny(source, "create_task", "add_subtask", "tasks_updated", "hub task"):
		return "Created Hub Tasks", "Created Hub Tasks", item.Detail
	default:
		title := firstNonEmpty(item.Title, event.ToolName, "Tool")
		return title, title, firstNonEmpty(item.Detail, event.ArgsSummary)
	}
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func firstAffectedFile(files []string) string {
	for _, file := range files {
		if strings.TrimSpace(file) != "" {
			return file
		}
	}
	return ""
}

var (
	lineRangePattern = regexp.MustCompile(`(?i)\bL(\d+)\s*[-:]\s*L?(\d+)\b`)
	pathPattern      = regexp.MustCompile(`(?i)(?:path|file|dir|target)=?["']?([A-Za-z0-9_./-]+\.[A-Za-z0-9_./-]+|[A-Za-z0-9_./-]+)["']?`)
)

func normalizeLineRange(value string) string {
	match := lineRangePattern.FindStringSubmatch(value)
	if len(match) == 3 {
		return "L" + match[1] + "-L" + match[2]
	}
	return ""
}

func extractPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || looksRawSystemText(value) {
		return ""
	}
	if match := pathPattern.FindStringSubmatch(value); len(match) == 2 {
		return strings.Trim(match[1], "`\"'")
	}
	for _, field := range strings.Fields(value) {
		clean := strings.Trim(field, "`\"',;")
		if strings.Contains(clean, "/") || strings.Contains(clean, ".") {
			if !strings.Contains(clean, "{") && !strings.Contains(clean, "}") {
				return clean
			}
		}
	}
	return ""
}

func looksRawSystemText(value string) bool {
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

func appendUniqueStrings(base []string, values ...string) []string {
	seen := map[string]bool{}
	for _, value := range base {
		seen[value] = true
	}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		base = append(base, value)
		seen[value] = true
	}
	return base
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	if limit <= 1 {
		return "…"
	}
	return string(runes[:limit-1]) + "…"
}
