package agent

import (
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// MessageStateHandler manages the state of conversation messages with thread safety.
// It decouples message tracking from the main controller loop.
type MessageStateHandler struct {
	mu        sync.RWMutex
	messages  []protocol.Message
	sessionID string
	updatedAt time.Time
	OnChanged func() `json:"-"`
}

func (h *MessageStateHandler) SetOnChanged(cb func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.OnChanged = cb
}

// NewMessageStateHandler creates a new handler
func NewMessageStateHandler(sessionID string) *MessageStateHandler {
	return &MessageStateHandler{
		messages:  make([]protocol.Message, 0),
		sessionID: sessionID,
		updatedAt: time.Now(),
	}
}

// AddMessage appends a new message
func (h *MessageStateHandler) AddMessage(msg protocol.Message) {
	h.mu.Lock()
	h.messages = append(h.messages, msg)
	h.updatedAt = time.Now()
	cb := h.OnChanged
	h.mu.Unlock()
	if cb != nil {
		cb()
	}
}

// SetMessages replaces all messages (e.g. for context pruning)
func (h *MessageStateHandler) SetMessages(msgs []protocol.Message) {
	h.mu.Lock()
	h.messages = msgs
	h.updatedAt = time.Now()
	cb := h.OnChanged
	h.mu.Unlock()
	if cb != nil {
		cb()
	}
}

// UpdateMessage updates a message at a specific index (useful for streaming partial updates)
func (h *MessageStateHandler) UpdateMessage(index int, msg protocol.Message) {
	h.mu.Lock()
	if index >= 0 && index < len(h.messages) {
		h.messages[index] = msg
		h.updatedAt = time.Now()
	}
	cb := h.OnChanged
	h.mu.Unlock()
	if cb != nil {
		cb()
	}
}

// GetMessages returns a copy of the messages
func (h *MessageStateHandler) GetMessages() []protocol.Message {
	h.mu.RLock()
	defer h.mu.RUnlock()
	// Return a copy to avoid race conditions if caller modifies slice
	msgs := make([]protocol.Message, len(h.messages))
	copy(msgs, h.messages)
	return msgs
}

// GetLastMessage returns the last message
func (h *MessageStateHandler) GetLastMessage() (protocol.Message, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if len(h.messages) == 0 {
		return protocol.Message{}, false
	}
	return h.messages[len(h.messages)-1], true
}

// Count returns the number of messages
func (h *MessageStateHandler) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.messages)
}

// UpdatedAt returns the last update time
func (h *MessageStateHandler) UpdatedAt() time.Time {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.updatedAt
}
