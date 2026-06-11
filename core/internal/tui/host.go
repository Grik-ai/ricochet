package tui

import (
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
	// For now, just log notifications
}
