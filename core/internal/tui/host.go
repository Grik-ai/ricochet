package tui

import (
	"encoding/json"
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// -- TuiHost --

type TuiHost struct {
	*host.NativeHost
	msgChan chan tea.Msg
}

func NewTuiHost(cwd string, msgChan chan tea.Msg) *TuiHost {
	return &TuiHost{
		NativeHost: host.NewNativeHost(cwd),
		msgChan:    msgChan,
	}
}

func (h *TuiHost) AskUser(sessionID string, question string) (string, error) {
	respChan := make(chan string)
	h.msgChan <- AskUserMsg{Question: question, RespChan: respChan, IsInput: true}
	return <-respChan, nil
}

func (h *TuiHost) AskUserChoice(sessionID string, question string, choices []string) (int, error) {
	respChan := make(chan int)
	h.msgChan <- AskUserChoiceMsg{Question: question, Choices: choices, RespChan: respChan}
	return <-respChan, nil
}

func (h *TuiHost) ShowMessage(level string, text string) {
	h.msgChan <- LogMsg{Level: level, Text: text}
}

func (h *TuiHost) SendMessage(msg protocol.RPCMessage) {
	switch msg.Type {
	case "command_event":
		var event protocol.CommandEvent
		if err := json.Unmarshal(msg.Payload, &event); err == nil {
			h.msgChan <- CommandEventMsg{Event: event}
		}
	case "tool_lifecycle":
		var event protocol.ToolLifecycleEvent
		if err := json.Unmarshal(msg.Payload, &event); err == nil {
			h.msgChan <- ToolLifecycleMsg{Event: event}
		}
	case "context_status":
		var status protocol.ContextStatus
		if err := json.Unmarshal(msg.Payload, &status); err == nil && status.TokensMax > 0 {
			h.msgChan <- TimelineNoticeMsg{
				Kind:   "Context",
				Title:  "Context",
				Status: "completed",
				Detail: formatContextNotice(status),
			}
		}
	case "usage_update":
		h.msgChan <- TimelineNoticeMsg{Kind: "Usage", Title: "Usage", Status: "completed", Detail: "Usage updated"}
	case "checkpoint_event":
		var event protocol.CheckpointEvent
		if err := json.Unmarshal(msg.Payload, &event); err == nil {
			h.msgChan <- TimelineNoticeMsg{
				Kind:       "Checkpoint",
				Title:      "Checkpoint",
				Status:     firstNonEmpty(event.Event, "completed"),
				Detail:     firstNonEmpty(event.Message, event.Hash),
				Error:      event.Error,
				DurationMs: event.DurationMs,
				Timestamp:  event.Timestamp,
			}
		}
	case "message_queued":
		h.msgChan <- TimelineNoticeMsg{Kind: "Queue", Title: "Queue", Status: "waiting", Detail: "Message queued for the active run"}
	case "queued_message_error":
		h.msgChan <- TimelineNoticeMsg{Kind: "Errors", Title: "Errors", Status: "failed", Error: msg.Error}
	}
}

func formatContextNotice(status protocol.ContextStatus) string {
	return fmt.Sprintf("%.1f%% (%d/%d tokens)", status.Percentage, status.TokensUsed, status.TokensMax)
}
