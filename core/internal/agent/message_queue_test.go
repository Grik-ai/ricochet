package agent

import "testing"

func TestMessageQueueUpdateDeleteAndSteerOrdering(t *testing.T) {
	c := &Controller{sessionManager: NewSessionManager(t.TempDir())}
	sessionID := "s1"

	first, ok := c.EnqueueUserMessage(sessionID, "r1", "first", "ide")
	if !ok {
		t.Fatalf("expected first message to queue")
	}
	second, ok := c.EnqueueUserMessage(sessionID, "r1", "second", "ide")
	if !ok {
		t.Fatalf("expected second message to queue")
	}
	steer, ok := c.SteerQueuedMessage(sessionID, "r1", "steer", "ide")
	if !ok {
		t.Fatalf("expected steer message to queue")
	}

	updated, ok := c.UpdateQueuedMessage(sessionID, second.ID, "second updated")
	if !ok || updated.Text != "second updated" || updated.UpdatedAt == 0 {
		t.Fatalf("unexpected updated message: %#v ok=%v", updated, ok)
	}
	if !c.DeleteQueuedMessage(sessionID, first.ID) {
		t.Fatalf("expected first message to delete")
	}

	drained := c.DrainQueuedMessages(sessionID)
	if len(drained) != 2 {
		t.Fatalf("expected 2 drained messages, got %#v", drained)
	}
	if drained[0].ID != steer.ID || drained[0].Delivery != "steer" {
		t.Fatalf("steer message should be delivered first: %#v", drained)
	}
	if drained[1].ID != second.ID || drained[1].Text != "second updated" {
		t.Fatalf("queued message mismatch: %#v", drained[1])
	}
	if again := c.DrainQueuedMessages(sessionID); len(again) != 0 {
		t.Fatalf("queue should be empty after drain: %#v", again)
	}
}
