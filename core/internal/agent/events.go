package agent

import (
	"sync"
)

// EventType defines the category of an agent event
type EventType string

const (
	EventTaskStarted              EventType = "task_started"
	EventTaskFinished             EventType = "task_finished"
	EventVetoed                   EventType = "vetoed"
	EventFileChanged              EventType = "file_changed"
	EventMemoryUpdated            EventType = "memory_updated"
	EventPlanUpdated              EventType = "plan_updated"
	EventProviderRequestStarted   EventType = "provider_request_started"
	EventProviderRequestRetrying  EventType = "provider_request_retrying"
	EventProviderRequestSucceeded EventType = "provider_request_succeeded"
	EventProviderRequestFailed    EventType = "provider_request_failed"
)

// Event represents a single autonomous signal from the agent
type Event struct {
	Type      EventType              `json:"type"`
	SessionID string                 `json:"session_id,omitempty"`
	Payload   map[string]interface{} `json:"payload,omitempty"`
}

// EventListener is a callback function for agent events
type EventListener func(Event)

// EventEmitter manages subscriptions and dispatching of agent events
type EventEmitter struct {
	mu        sync.RWMutex
	listeners []EventListener
}

func NewEventEmitter() *EventEmitter {
	return &EventEmitter{
		listeners: []EventListener{},
	}
}

// Subscribe adds a new listener to the event bus
func (e *EventEmitter) Subscribe(l EventListener) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.listeners = append(e.listeners, l)
}

// Emit broadcasts an event to all subscribers
func (e *EventEmitter) Emit(evt Event) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	for _, l := range e.listeners {
		go l(evt) // Async dispatch to prevent blocking the agent
	}
}
