package ether

import (
	"sync"
	"time"
)

// EventType defines the type of event entering the agent's context from the environment
type EventType string

const (
	EventUserMessage EventType = "user_message"
	EventReaction    EventType = "reaction"
	EventFileChange  EventType = "file_change"
	EventSystem      EventType = "system_signal"
)

// Event represents a single event captured by the Ether buffer
type Event struct {
	Type      EventType         `json:"type"`
	Content   string            `json:"content"`
	Timestamp time.Time         `json:"timestamp"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

type sessionQueue struct {
	events []Event
	mu     sync.Mutex
}

// Buffer manages ephemeral, session-scoped event queues
type Buffer struct {
	queues map[string]*sessionQueue
	mu     sync.RWMutex
}

var (
	globalEther *Buffer
	etherOnce   sync.Once
)

// Get returns the global singleton instance of the Ether buffer
func Get() *Buffer {
	etherOnce.Do(func() {
		globalEther = &Buffer{
			queues: make(map[string]*sessionQueue),
		}
	})
	return globalEther
}

// Enqueue adds a new event to a session's Ether buffer
func (e *Buffer) Enqueue(sessionID string, evt Event) {
	if sessionID == "" {
		return
	}

	e.mu.RLock()
	q, ok := e.queues[sessionID]
	e.mu.RUnlock()

	if !ok {
		e.mu.Lock()
		// Double check after lock
		q, ok = e.queues[sessionID]
		if !ok {
			q = &sessionQueue{
				events: []Event{},
			}
			e.queues[sessionID] = q
		}
		e.mu.Unlock()
	}

	q.mu.Lock()
	defer q.mu.Unlock()

	// Enforce a limit on events in buffer (sliding window)
	if len(q.events) > 50 {
		q.events = q.events[1:]
	}

	if evt.Timestamp.IsZero() {
		evt.Timestamp = time.Now()
	}
	q.events = append(q.events, evt)
}

// Drain retrieves and clears all events for a session
func (e *Buffer) Drain(sessionID string) []Event {
	if sessionID == "" {
		return nil
	}

	e.mu.RLock()
	q, ok := e.queues[sessionID]
	e.mu.RUnlock()

	if !ok {
		return nil
	}

	q.mu.Lock()
	defer q.mu.Unlock()

	events := q.events
	q.events = []Event{}
	return events
}

// HasEvents checks if a session has pending events in the buffer
func (e *Buffer) HasEvents(sessionID string) bool {
	if sessionID == "" {
		return false
	}

	e.mu.RLock()
	q, ok := e.queues[sessionID]
	e.mu.RUnlock()

	if !ok {
		return false
	}

	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.events) > 0
}
