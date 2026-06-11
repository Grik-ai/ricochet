package agent

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func (c *Controller) EnqueueUserMessage(sessionID, runID, text, via string) (protocol.QueuedMessage, bool) {
	return c.enqueueUserMessage(sessionID, runID, text, via, "queue", nil)
}

func (c *Controller) EnqueueUserMessageWithContextFiles(sessionID, runID, text, via string, contextFiles []protocol.ContextFileAttachment) (protocol.QueuedMessage, bool) {
	return c.enqueueUserMessage(sessionID, runID, text, via, "queue", contextFiles)
}

func (c *Controller) SteerQueuedMessage(sessionID, runID, text, via string) (protocol.QueuedMessage, bool) {
	return c.enqueueUserMessage(sessionID, runID, text, via, "steer", nil)
}

func (c *Controller) SteerQueuedMessageWithContextFiles(sessionID, runID, text, via string, contextFiles []protocol.ContextFileAttachment) (protocol.QueuedMessage, bool) {
	return c.enqueueUserMessage(sessionID, runID, text, via, "steer", contextFiles)
}

func (c *Controller) enqueueUserMessage(sessionID, runID, text, via, delivery string, contextFiles []protocol.ContextFileAttachment) (protocol.QueuedMessage, bool) {
	if strings.TrimSpace(text) == "" {
		return protocol.QueuedMessage{}, false
	}
	session := c.GetSession(sessionID)
	if session == nil {
		session = c.CreateSessionWithID(sessionID)
	}
	msg := protocol.QueuedMessage{
		ID:           uuid.New().String(),
		SessionID:    sessionID,
		RunID:        runID,
		Text:         text,
		Via:          via,
		ContextFiles: append([]protocol.ContextFileAttachment(nil), contextFiles...),
		Delivery:     normalizeQueuedMessageDelivery(delivery),
		Timestamp:    time.Now().UnixMilli(),
	}
	session.MessageQueue = append(session.MessageQueue, msg)
	_ = c.sessionManager.Save(sessionID)
	return msg, true
}

func (c *Controller) UpdateQueuedMessage(sessionID, messageID, text string) (protocol.QueuedMessage, bool) {
	if strings.TrimSpace(messageID) == "" || strings.TrimSpace(text) == "" {
		return protocol.QueuedMessage{}, false
	}
	session := c.GetSession(sessionID)
	if session == nil {
		return protocol.QueuedMessage{}, false
	}
	for i := range session.MessageQueue {
		if session.MessageQueue[i].ID != messageID {
			continue
		}
		session.MessageQueue[i].Text = text
		session.MessageQueue[i].UpdatedAt = time.Now().UnixMilli()
		_ = c.sessionManager.Save(sessionID)
		return session.MessageQueue[i], true
	}
	return protocol.QueuedMessage{}, false
}

func (c *Controller) DeleteQueuedMessage(sessionID, messageID string) bool {
	if strings.TrimSpace(messageID) == "" {
		return false
	}
	session := c.GetSession(sessionID)
	if session == nil {
		return false
	}
	for i := range session.MessageQueue {
		if session.MessageQueue[i].ID != messageID {
			continue
		}
		session.MessageQueue = append(session.MessageQueue[:i], session.MessageQueue[i+1:]...)
		_ = c.sessionManager.Save(sessionID)
		return true
	}
	return false
}

func (c *Controller) DrainQueuedMessages(sessionID string) []protocol.QueuedMessage {
	session := c.GetSession(sessionID)
	if session == nil || len(session.MessageQueue) == 0 {
		return nil
	}
	messages := make([]protocol.QueuedMessage, len(session.MessageQueue))
	copy(messages, session.MessageQueue)
	session.MessageQueue = nil
	_ = c.sessionManager.Save(sessionID)
	return orderQueuedMessagesForDelivery(messages)
}

func orderQueuedMessagesForDelivery(messages []protocol.QueuedMessage) []protocol.QueuedMessage {
	if len(messages) < 2 {
		return messages
	}
	ordered := make([]protocol.QueuedMessage, 0, len(messages))
	for _, msg := range messages {
		if normalizeQueuedMessageDelivery(msg.Delivery) == "steer" {
			ordered = append(ordered, msg)
		}
	}
	for _, msg := range messages {
		if normalizeQueuedMessageDelivery(msg.Delivery) != "steer" {
			ordered = append(ordered, msg)
		}
	}
	return ordered
}

func normalizeQueuedMessageDelivery(delivery string) string {
	switch strings.ToLower(strings.TrimSpace(delivery)) {
	case "steer":
		return "steer"
	default:
		return "queue"
	}
}
