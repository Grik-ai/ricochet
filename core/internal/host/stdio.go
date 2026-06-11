package host

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// StdioHost implements Host by communicating with a parent process over stdio.
// This is used when Ricochet runs as a VSCode extension sidecar.
type StdioHost struct {
	cwd             string
	orchestrator    *CommandOrchestrator
	outputMu        sync.Mutex
	pendingRequests map[string]chan json.RawMessage
	mu              sync.Mutex
}

func NewStdioHost(cwd string) *StdioHost {
	return &StdioHost{
		cwd:             cwd,
		orchestrator:    NewCommandOrchestrator(cwd),
		pendingRequests: make(map[string]chan json.RawMessage),
	}
}

func (h *StdioHost) SetCommandOutputLineLimit(limit int) {
	h.orchestrator.SetOutputLineLimit(limit)
}

func (h *StdioHost) GetCWD() string {
	return h.cwd
}

func (h *StdioHost) ReadFile(path string) ([]byte, error) {
	// Local file system access is still fine for sidecar
	return os.ReadFile(h.resolve(path))
}

func (h *StdioHost) WriteFile(path string, data []byte) error {
	return os.WriteFile(h.resolve(path), data, 0644)
}

func (h *StdioHost) ListDir(path string) ([]FileInfo, error) {
	entries, err := os.ReadDir(h.resolve(path))
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

func (h *StdioHost) ExecuteCommand(ctx context.Context, command string, background bool) (CommandResult, error) {
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

func (h *StdioHost) GetCommandStatus(id string) (CommandStatus, bool) {
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

func (h *StdioHost) ShowMessage(level string, text string) {
	h.sendNotification("show_message", map[string]string{
		"level": level,
		"text":  text,
	})
}

func (h *StdioHost) AskUser(sessionID string, question string) (string, error) {
	id := fmt.Sprintf("req-%d", time.Now().UnixNano()) // Simple unique ID
	return h.AskUserWithID(sessionID, question, id)
}

func (h *StdioHost) AskUserChoice(sessionID string, question string, choices []string) (int, error) {
	id := fmt.Sprintf("choice-%d", time.Now().UnixNano())
	return h.AskUserChoiceWithID(sessionID, question, choices, id)
}

func (h *StdioHost) AskUserWithID(sessionID string, question string, id string) (string, error) {
	ch := make(chan json.RawMessage, 1)
	h.mu.Lock()
	h.pendingRequests[id] = ch
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.pendingRequests, id)
		h.mu.Unlock()
	}()

	h.sendRequest("ask_user", id, map[string]string{
		"session_id": sessionID,
		"question":   question,
	})

	select {
	case responseBytes := <-ch:
		var response string
		if err := json.Unmarshal(responseBytes, &response); err != nil {
			return "", fmt.Errorf("failed to parse response: %w", err)
		}
		return response, nil
	case <-time.After(24 * time.Hour):
		return "", fmt.Errorf("user response timeout")
	}
}

func (h *StdioHost) AskUserChoiceWithID(sessionID string, question string, choices []string, id string) (int, error) {
	ch := make(chan json.RawMessage, 1)
	h.mu.Lock()
	h.pendingRequests[id] = ch
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.pendingRequests, id)
		h.mu.Unlock()
	}()

	h.sendRequest("ask_user_choice", id, map[string]interface{}{
		"session_id": sessionID,
		"question":   question,
		"choices":    choices,
	})

	select {
	case responseBytes := <-ch:
		var response int
		if err := json.Unmarshal(responseBytes, &response); err != nil {
			return 0, fmt.Errorf("failed to parse choice response: %w", err)
		}
		return response, nil
	case <-time.After(24 * time.Hour):
		return 0, fmt.Errorf("user choice response timeout")
	}
}

func (h *StdioHost) SendRequest(method string, payload interface{}) (interface{}, error) {
	id := fmt.Sprintf("req-%d", time.Now().UnixNano())
	ch := make(chan json.RawMessage, 1)

	h.mu.Lock()
	h.pendingRequests[id] = ch
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.pendingRequests, id)
		h.mu.Unlock()
	}()

	h.sendRequest(method, id, payload)

	timeout := 5 * time.Minute
	if method == "propose_edit" {
		timeout = 24 * time.Hour
	}

	select {
	case responseBytes := <-ch:
		// Return RawMessage so caller can unmarshal into desired type
		return responseBytes, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("request timeout")
	}
}

func (h *StdioHost) HandleResponse(id string, payload json.RawMessage) {
	h.mu.Lock()
	ch, ok := h.pendingRequests[id]
	h.mu.Unlock()

	if ok {
		select {
		case ch <- payload:
		default:
			// No one is listening, drop the response instead of blocking the main thread
		}
	}
}

func (h *StdioHost) resolve(path string) string {
	if os.IsPathSeparator(path[0]) {
		return path
	}
	return h.cwd + "/" + path
}

func (h *StdioHost) sendNotification(msgType string, payload interface{}) {
	h.send(msgType, "", payload)
}

func (h *StdioHost) sendRequest(msgType string, id string, payload interface{}) {
	h.send(msgType, id, payload)
}

func (h *StdioHost) SendMessage(msg protocol.RPCMessage) {
	h.outputMu.Lock()
	defer h.outputMu.Unlock()

	data, _ := json.Marshal(msg)
	fmt.Println(string(data))
}

func (h *StdioHost) send(msgType string, id string, payload interface{}) {
	// Note: Standard RPC uses 'id' to distinguish requests from notifications.
	msg := protocol.RPCMessage{
		ID:      id,
		Type:    msgType,
		Payload: protocol.EncodeRPC(payload),
	}

	h.SendMessage(msg)
}
