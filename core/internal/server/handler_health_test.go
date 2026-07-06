package server

import (
	"strings"
	"testing"
	"time"

	"github.com/igoryan-dao/ricochet/internal/agent"
)

func TestHealthSnapshotIncludesCoreAndProviderState(t *testing.T) {
	h := &Handler{
		Config: &agent.Config{
			Provider: agent.ProviderConfig{
				Provider: "zhipu",
				Model:    "glm-4.5",
				BaseURL:  "https://api.z.ai/api/paas/v4",
			},
		},
		StartedAt: time.Now().Add(-time.Second),
	}
	h.setActiveChat(true)
	h.recordProviderEvent(agent.Event{
		Type: agent.EventProviderRequestFailed,
		Payload: map[string]interface{}{
			"timestamp":  int64(123),
			"latency_ms": int64(456),
			"error":      "can't assign requested address",
		},
	})

	snapshot := h.healthSnapshot()
	if snapshot["active_chat"] != true {
		t.Fatalf("expected active_chat=true, got %+v", snapshot["active_chat"])
	}
	if snapshot["provider"] != "zhipu" || snapshot["model"] != "glm-4.5" {
		t.Fatalf("expected provider/model in health snapshot, got %+v", snapshot)
	}
	if !strings.Contains(snapshot["last_provider_error"].(string), "can't assign requested address") {
		t.Fatalf("expected last provider error, got %+v", snapshot["last_provider_error"])
	}
	if snapshot["last_provider_latency_ms"] != int64(456) {
		t.Fatalf("expected provider latency, got %+v", snapshot["last_provider_latency_ms"])
	}
}
