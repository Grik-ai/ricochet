package host

import (
	"context"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// ScopedHost runs filesystem and command operations in a different working
// directory while preserving the parent host for UI/RPC interactions.
type ScopedHost struct {
	parent Host
	local  *NativeHost
}

func NewScopedHost(parent Host, cwd string) *ScopedHost {
	return &ScopedHost{
		parent: parent,
		local:  NewNativeHost(cwd),
	}
}

func (h *ScopedHost) GetCWD() string {
	return h.local.GetCWD()
}

func (h *ScopedHost) ReadFile(path string) ([]byte, error) {
	return h.local.ReadFile(path)
}

func (h *ScopedHost) WriteFile(path string, data []byte) error {
	return h.local.WriteFile(path, data)
}

func (h *ScopedHost) ListDir(path string) ([]FileInfo, error) {
	return h.local.ListDir(path)
}

func (h *ScopedHost) ExecuteCommand(ctx context.Context, command string, background bool) (CommandResult, error) {
	return h.local.ExecuteCommand(ctx, command, background)
}

func (h *ScopedHost) GetCommandStatus(id string) (CommandStatus, bool) {
	return h.local.GetCommandStatus(id)
}

func (h *ScopedHost) ShowMessage(level string, text string) {
	h.parent.ShowMessage(level, text)
}

func (h *ScopedHost) AskUser(sessionID string, question string) (string, error) {
	return h.parent.AskUser(sessionID, question)
}

func (h *ScopedHost) AskUserChoice(sessionID string, question string, choices []string) (int, error) {
	return h.parent.AskUserChoice(sessionID, question, choices)
}

func (h *ScopedHost) SendMessage(msg protocol.RPCMessage) {
	h.parent.SendMessage(msg)
}

func (h *ScopedHost) SendRequest(method string, payload interface{}) (interface{}, error) {
	return h.parent.SendRequest(method, payload)
}
