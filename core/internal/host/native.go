package host

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// NativeHost implements Host using standard OS calls.
// This is used for local execution (CLI, sidecar).
type NativeHost struct {
	cwd          string
	orchestrator *CommandOrchestrator
}

func NewNativeHost(cwd string) *NativeHost {
	return &NativeHost{
		cwd:          cwd,
		orchestrator: NewCommandOrchestrator(cwd),
	}
}

func (h *NativeHost) SetCommandOutputLineLimit(limit int) {
	h.orchestrator.SetOutputLineLimit(limit)
}

func (h *NativeHost) GetCWD() string {
	return h.cwd
}

func (h *NativeHost) ReadFile(path string) ([]byte, error) {
	absPath := h.resolve(path)
	return os.ReadFile(absPath)
}

func (h *NativeHost) WriteFile(path string, data []byte) error {
	absPath := h.resolve(path)
	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(absPath, data, 0644)
}

func (h *NativeHost) ListDir(path string) ([]FileInfo, error) {
	absPath := h.resolve(path)
	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, err
	}

	var infos []FileInfo
	for _, entry := range entries {
		info, _ := entry.Info()
		infos = append(infos, FileInfo{
			Name:  entry.Name(),
			Size:  info.Size(),
			IsDir: entry.IsDir(),
		})
	}
	return infos, nil
}

func (h *NativeHost) ExecuteCommand(ctx context.Context, command string, background bool) (CommandResult, error) {
	state, err := h.orchestrator.Execute(ctx, command, background)
	if err != nil {
		return CommandResult{}, err
	}
	var durationMs int64
	if !state.EndTime.IsZero() {
		durationMs = state.EndTime.Sub(state.StartTime).Milliseconds()
	}

	return CommandResult{
		ID:          state.ID,
		Output:      state.Output,
		Status:      string(state.Status),
		ExitCode:    state.ExitCode,
		DurationMs:  durationMs,
		Cwd:         h.cwd,
		StartedAt:   state.StartTime,
		CompletedAt: state.EndTime,
		Truncated:   state.Truncated,
	}, nil
}

func (h *NativeHost) GetCommandStatus(id string) (CommandStatus, bool) {
	state, ok := h.orchestrator.GetStatus(id)
	if !ok {
		return CommandStatus{}, false
	}
	return CommandStatus{
		ID:      state.ID,
		Status:  string(state.Status),
		Output:  state.Output,
		Error:   state.Error,
		LogFile: state.LogFile,
	}, true
}

func (h *NativeHost) ShowMessage(level string, text string) {
	fmt.Printf("[%s] %s\n", level, text)
}

func (h *NativeHost) AskUser(sessionID string, question string) (string, error) {
	// Not implemented for native host (requires stdin interaction)
	return "", fmt.Errorf("AskUser not implemented for NativeHost")
}

func (h *NativeHost) AskUserChoice(sessionID string, question string, choices []string) (int, error) {
	return 0, fmt.Errorf("AskUserChoice not implemented for NativeHost")
}

func (h *NativeHost) SendMessage(msg protocol.RPCMessage) {
	fmt.Printf("[NOTIFICATION] Type: %s, Payload: %s\n", msg.Type, string(msg.Payload))
}

func (h *NativeHost) SendRequest(method string, payload interface{}) (interface{}, error) {
	return nil, fmt.Errorf("SendRequest not implemented for NativeHost")
}

func (h *NativeHost) resolve(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(h.cwd, path)
}
