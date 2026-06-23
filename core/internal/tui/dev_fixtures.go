package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/igoryan-dao/ricochet/internal/agent"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type FixtureEvent struct {
	Delay      time.Duration
	Message    tea.Msg
	RPCMessage *protocol.RPCMessage
}

func TerminalLabFixture(name string) ([]FixtureEvent, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "all":
		return allTimelineFixture(), nil
	case "polybot":
		return polybotFixture(), nil
	case "failed":
		return failedCommandFixture(), nil
	case "slash-menu", "slash":
		return slashMenuFixture(), nil
	default:
		return nil, fmt.Errorf("unknown terminal lab fixture %q", name)
	}
}

func TerminalLabFixtureNames() []string {
	return []string{"all", "polybot", "failed", "slash-menu"}
}

func ReplayTerminalLabFixture(msgChan chan tea.Msg, name string, speed float64) error {
	events, err := TerminalLabFixture(name)
	if err != nil {
		return err
	}
	if speed <= 0 {
		speed = 1
	}
	for _, event := range events {
		if event.Delay > 0 {
			time.Sleep(time.Duration(float64(event.Delay) / speed))
		}
		if event.Message != nil {
			msgChan <- event.Message
		}
	}
	return nil
}

func allTimelineFixture() []FixtureEvent {
	const sessionID = "terminal-lab"
	const runID = "run-terminal-all"
	now := time.Now().UnixMilli()
	return []FixtureEvent{
		userEvent(sessionID, runID, "Run the full terminal timeline fixture", now),
		progressEvent(sessionID, runID, "Planning task", "Preparing raw boundary fixture", true, now+50),
		progressEvent(sessionID, runID, "Terminal Dev Lab", "Exploring project", true, now+100, "Inspect workspace", "Read source files"),
		toolEvent(sessionID, runID, "tool-list", "list_dir", "path=Polybot", "completed", []string{"Polybot"}, "12 files, 8 folders", now+200),
		toolEvent(sessionID, runID, "tool-search", "search_files", "query=useChat path=webview/src", "completed", []string{"webview/src/hooks/useChat.ts"}, "8 matches", now+300),
		toolEvent(sessionID, runID, "tool-read", "read_file", "path=src/main.rs L1-L150", "completed", []string{"src/main.rs"}, "Read 150 lines", now+400),
		commandStarted(sessionID, runID, "cmd-check", "cargo check", "/workspace/Polybot", now+500),
		commandOutput(sessionID, runID, "cmd-check", "Checking polybot v0.1.0\n", now+620),
		commandFinished(sessionID, runID, "cmd-check", "cargo check", "completed", "Finished dev target(s) in 1.24s\n", 0, 1240, now+1740),
		toolEvent(sessionID, runID, "tool-edit", "apply_patch", "path=src/error.rs", "completed", []string{"src/error.rs"}, "+12 -4", now+1900),
		toolEvent(sessionID, runID, "tool-review", "audit_reject", "path=src/main.rs", "failed", []string{"src/main.rs"}, "Verification rejected the edit", now+2050),
		toolEvent(sessionID, runID, "tool-approval", "request_permission", "execute brew install xgboost", "completed", nil, "Approval requested and denied in fixture", now+2200),
		toolEvent(sessionID, runID, "tool-artifact", "artifact", "implementation_plan", "completed", nil, "Created implementation plan artifact", now+2350),
		toolEvent(sessionID, runID, "tool-task", "create_task", "Hub task: Fix terminal renderer", "completed", nil, "Created Hub Tasks: Fix terminal renderer", now+2500),
		contextEvent(sessionID, runID, 11000, 128000, now+2650),
		checkpointEvent(sessionID, runID, "checkpoint_saved", "abc123timeline", "Saved terminal fixture checkpoint", now+2800),
		assistantEvent(sessionID, runID, "Draft result: terminal fixture has exercised project exploration, file reads, commands, edits, review, approvals, artifacts, and Hub Tasks.", true, now+3000),
		progressEvent(sessionID, runID, "Verification completed", "All terminal event families were emitted.", false, now+3300),
		assistantEvent(sessionID, runID, "All terminal timeline events fixture complete. The transcript should show Explored, Ran, Edited, Review, Approvals, Artifacts, Created Hub Tasks, and a final answer without raw system leftovers.", false, now+3400),
	}
}

func polybotFixture() []FixtureEvent {
	const sessionID = "terminal-lab"
	const runID = "run-terminal-polybot"
	now := time.Now().UnixMilli()
	return []FixtureEvent{
		userEvent(sessionID, runID, "проанализируй проект", now),
		progressEvent(sessionID, runID, "Polybot analysis", "Exploring project structure", true, now+100, "List project directory", "Read config"),
		toolEvent(sessionID, runID, "poly-list", "list_dir", "path=Polybot", "completed", []string{"Polybot"}, "12 files, 8 folders", now+200),
		toolEvent(sessionID, runID, "poly-src", "list_dir", "path=src", "completed", []string{"src"}, "analysis, execution, config", now+260),
		toolEvent(sessionID, runID, "poly-config", "read_file", "path=src/config.rs L1-L150", "completed", []string{"src/config.rs"}, "Read config module", now+320),
		commandStarted(sessionID, runID, "poly-check", "cargo check", "/workspace/Polybot", now+400),
		commandFinished(sessionID, runID, "poly-check", "cargo check", "completed", "Finished dev target(s) in 1.24s\n", 0, 1240, now+1640),
		commandStarted(sessionID, runID, "poly-test", "cargo test", "/workspace/Polybot", now+1800),
		commandFinished(sessionID, runID, "poly-test", "cargo test", "failed", "error: failed to run custom build command for `xgboost-sys`\n", 101, 2100, now+3900),
		commandStarted(sessionID, runID, "poly-brew", "brew install xgboost", "/workspace/Polybot", now+4100),
		commandFinished(sessionID, runID, "poly-brew", "brew install xgboost", "failed", "Error: Cannot install in fixture mode\n", 1, 420, now+4520),
		toolEvent(sessionID, runID, "poly-review", "audit_reject", "path=src/error.rs", "failed", []string{"src/error.rs"}, "File updated, but verification rejected the edit", now+4700),
		progressEvent(sessionID, runID, "Analysis completed", "Polybot analysis completed with local dependency blockers.", false, now+5000),
		assistantEvent(sessionID, runID, "Polybot analysis complete. The project compiles with cargo check; tests are blocked locally by the native XGBoost dependency.", false, now+5200),
	}
}

func failedCommandFixture() []FixtureEvent {
	const sessionID = "terminal-lab"
	const runID = "run-terminal-failed"
	now := time.Now().UnixMilli()
	return []FixtureEvent{
		userEvent(sessionID, runID, "исправь ошибки и покажи review state", now),
		progressEvent(sessionID, runID, "Risky edit", "Applying a risky edit fixture", true, now+100, "Patch file", "Run verification"),
		toolEvent(sessionID, runID, "failed-edit", "apply_patch", "path=src/main.rs", "failed", []string{"src/main.rs"}, "Failed edit: verification rejected", now+250),
		commandStarted(sessionID, runID, "failed-cmd", "brew install xgboost", "/workspace/Polybot", now+400),
		commandFinished(sessionID, runID, "failed-cmd", "brew install xgboost", "failed", "Error: Cannot install in fixture mode\n", 1, 420, now+820),
		toolEvent(sessionID, runID, "failed-review", "audit_reject", "path=src/main.rs", "failed", []string{"src/main.rs"}, "Audit rejected unsafe edit", now+900),
		assistantEvent(sessionID, runID, "The edit was rejected by verification, and the install command failed. Review and Errors should stay visible.", false, now+1000),
	}
}

func slashMenuFixture() []FixtureEvent {
	const sessionID = "terminal-lab"
	const runID = "run-terminal-slash-menu"
	now := time.Now().UnixMilli()
	return []FixtureEvent{
		userEvent(sessionID, runID, "show slash menu audit", now),
		assistantEvent(sessionID, runID, slashMenuFixtureContent(), false, now+100),
	}
}

func slashMenuFixtureContent() string {
	idleModel := Model{Controller: &agent.Controller{}, MsgChan: make(chan tea.Msg, 1)}
	defaultMenu := idleModel.enabledSlashCommandSuggestions("/")
	activeModel := idleModel
	activeModel.IsLoading = true
	activeMenu := activeModel.enabledSlashCommandSuggestions("/")
	advancedSearch := SlashCommandSuggestions("/ver", false)
	aliasSearch := SlashCommandSuggestions("/models", false)
	extensionAliasSearch := SlashCommandSuggestions("/ext", false)

	disabledModel := Model{IsLoading: true}
	reviewSpec, _ := FindSlashCommand("/review")
	disabledReason := disabledModel.slashCommandDisabledReason(reviewSpec)

	var sb strings.Builder
	sb.WriteString("Slash menu fixture complete.\n\n")
	sb.WriteString("Idle `/` popup:\n")
	sb.WriteString("`" + strings.Join(defaultMenu, "`, `") + "`\n\n")
	sb.WriteString("Active run `/` popup:\n")
	sb.WriteString("`" + strings.Join(activeMenu, "`, `") + "`\n\n")
	sb.WriteString("Typed advanced search `/ver`:\n")
	sb.WriteString("`" + strings.Join(advancedSearch, "`, `") + "`\n\n")
	sb.WriteString("Alias search stays canonical:\n")
	sb.WriteString(fmt.Sprintf("- `/models` -> `%s`\n", strings.Join(aliasSearch, "`, `")))
	sb.WriteString(fmt.Sprintf("- `/ext` -> `%s`\n\n", strings.Join(extensionAliasSearch, "`, `")))
	sb.WriteString("Disabled reason:\n")
	sb.WriteString(fmt.Sprintf("Command `/review` is unavailable: %s\n\n", disabledReason))
	sb.WriteString("Default `/help`:\n")
	sb.WriteString(RenderSlashHelp(""))
	sb.WriteString("\n\n`/help all` includes advanced commands such as `/version`, `/usage`, `/checkpoint`, `/restore`, `/raw`, and `/ps`.")
	return sb.String()
}

func userEvent(sessionID, runID, content string, timestamp int64) FixtureEvent {
	msg := agent.ChatMessage{ID: "user-" + runID, Role: "user", Content: content, Timestamp: timestamp, RunID: runID, TurnID: runID}
	return FixtureEvent{
		Message: RemoteChatMsg{Message: msg},
		RPCMessage: rpc("chat_update", agent.ChatUpdate{
			SessionID: sessionID,
			RunID:     runID,
			Message:   &msg,
		}),
	}
}

func assistantEvent(sessionID, runID, content string, streaming bool, timestamp int64) FixtureEvent {
	msg := agent.ChatMessage{ID: fmt.Sprintf("assistant-%s-%d", runID, timestamp), Role: "assistant", Content: content, Timestamp: timestamp, IsStreaming: streaming, RunID: runID, TurnID: runID}
	return FixtureEvent{
		Delay:   100 * time.Millisecond,
		Message: RemoteChatMsg{Message: msg},
		RPCMessage: rpc("chat_update", agent.ChatUpdate{
			SessionID: sessionID,
			RunID:     runID,
			Message:   &msg,
		}),
	}
}

func progressEvent(sessionID, runID, task, status string, active bool, timestamp int64, steps ...string) FixtureEvent {
	progress := protocol.TaskProgress{
		SessionID:   sessionID,
		RunID:       runID,
		TurnID:      runID,
		Event:       "mission_progress",
		TaskName:    task,
		Status:      status,
		Summary:     status,
		Steps:       steps,
		IsActive:    active,
		CompletedAt: terminalIf(!active, timestamp),
	}
	return FixtureEvent{Delay: 100 * time.Millisecond, Message: progress, RPCMessage: rpc("task_progress", progress)}
}

func toolEvent(sessionID, runID, id, name, args, status string, files []string, output string, timestamp int64) FixtureEvent {
	event := protocol.ToolLifecycleEvent{
		SessionID:     sessionID,
		RunID:         runID,
		TurnID:        runID,
		ToolUseID:     id,
		ToolName:      name,
		Status:        status,
		Event:         "tool_finished",
		ArgsSummary:   args,
		AffectedFiles: files,
		OutputPreview: output,
		Timestamp:     timestamp,
		DurationMs:    120,
	}
	if status == "failed" {
		event.Event = "tool_failed"
		event.Error = output
	}
	return FixtureEvent{Delay: 100 * time.Millisecond, Message: ToolLifecycleMsg{Event: event}, RPCMessage: rpc("tool_lifecycle", event)}
}

func commandStarted(sessionID, runID, id, command, cwd string, timestamp int64) FixtureEvent {
	event := protocol.CommandEvent{SessionID: sessionID, RunID: runID, TurnID: runID, CommandID: id, Event: "command_started", Command: command, Cwd: cwd, Shell: "zsh", Status: "running", StartedAt: timestamp, Timestamp: timestamp}
	return FixtureEvent{Delay: 100 * time.Millisecond, Message: CommandEventMsg{Event: event}, RPCMessage: rpc("command_event", event)}
}

func commandOutput(sessionID, runID, id, output string, timestamp int64) FixtureEvent {
	event := protocol.CommandEvent{SessionID: sessionID, RunID: runID, TurnID: runID, CommandID: id, Event: "command_output", OutputChunk: output, Status: "running", Timestamp: timestamp}
	return FixtureEvent{Delay: 100 * time.Millisecond, Message: CommandEventMsg{Event: event}, RPCMessage: rpc("command_event", event)}
}

func commandFinished(sessionID, runID, id, command, status, preview string, exitCode int, durationMs int64, timestamp int64) FixtureEvent {
	eventName := "command_succeeded"
	if status == "failed" || exitCode != 0 {
		eventName = "command_failed"
	}
	event := protocol.CommandEvent{SessionID: sessionID, RunID: runID, TurnID: runID, CommandID: id, Event: eventName, Command: command, Status: status, ResultPreview: preview, ExitCode: exitCode, DurationMs: durationMs, CompletedAt: timestamp, Timestamp: timestamp}
	return FixtureEvent{Delay: 100 * time.Millisecond, Message: CommandEventMsg{Event: event}, RPCMessage: rpc("command_event", event)}
}

func contextEvent(sessionID, runID string, used, max int, timestamp int64) FixtureEvent {
	status := protocol.ContextStatus{SessionID: sessionID, RunID: runID, TokensUsed: used, TokensMax: max, Percentage: float64(used) / float64(max) * 100}
	return FixtureEvent{
		Delay:      100 * time.Millisecond,
		Message:    TimelineNoticeMsg{Kind: "Context", Title: "Context", Status: "completed", Detail: fmt.Sprintf("%.1f%% (%d/%d tokens)", status.Percentage, used, max), Timestamp: timestamp},
		RPCMessage: rpc("context_status", status),
	}
}

func checkpointEvent(sessionID, runID, event, hash, message string, timestamp int64) FixtureEvent {
	checkpoint := protocol.CheckpointEvent{SessionID: sessionID, RunID: runID, Event: event, Hash: hash, Message: message, Timestamp: timestamp, DurationMs: 90}
	return FixtureEvent{
		Delay:      100 * time.Millisecond,
		Message:    TimelineNoticeMsg{Kind: "Checkpoint", Title: "Checkpoint", Status: event, Detail: message + " " + hash, DurationMs: 90, Timestamp: timestamp},
		RPCMessage: rpc("checkpoint_event", checkpoint),
	}
}

func rpc(kind string, payload interface{}) *protocol.RPCMessage {
	return &protocol.RPCMessage{Type: kind, Payload: protocol.EncodeRPC(payload)}
}

func terminalIf(ok bool, value int64) int64 {
	if ok {
		return value
	}
	return 0
}
