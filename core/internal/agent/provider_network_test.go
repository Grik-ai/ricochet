package agent

import (
	"context"
	"errors"
	"testing"
)

func TestProviderNetworkCategoryClassifiesBigModelSocketError(t *testing.T) {
	err := errors.New(`Post "https://open.bigmodel.cn/api/paas/v4/chat/completions": read tcp 172.20.10.12:53725->60.205.172.105:443: read: can't assign requested address`)
	if got := providerNetworkCategoryFromError(context.Background(), err); got != "network" {
		t.Fatalf("expected network category, got %q", got)
	}
}

func TestProviderNetworkCategoryClassifiesConfigStatuses(t *testing.T) {
	for _, status := range []int{400, 401, 403} {
		if got := providerNetworkCategoryFromStatus(status); got != "config" {
			t.Fatalf("expected status %d to be config, got %q", status, got)
		}
	}
}

func TestProviderNetworkObserverAddsMetadata(t *testing.T) {
	var got ProviderNetworkEvent
	ctx := WithProviderNetworkMetadata(context.Background(), ProviderNetworkMetadata{
		Provider:  "zhipu",
		Model:     "glm-4.5",
		SessionID: "session-1",
		RunID:     "run-1",
	})
	ctx = WithProviderNetworkObserver(ctx, func(event ProviderNetworkEvent) {
		got = event
	})

	emitProviderNetworkEvent(ctx, ProviderNetworkEvent{Type: string(EventProviderRequestRetrying), Attempt: 2, MaxAttempts: 5})

	if got.Provider != "zhipu" || got.Model != "glm-4.5" || got.SessionID != "session-1" || got.RunID != "run-1" {
		t.Fatalf("metadata was not attached: %+v", got)
	}
	if got.Timestamp == 0 {
		t.Fatalf("expected timestamp to be populated")
	}
}
