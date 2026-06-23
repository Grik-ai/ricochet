package bridge

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestCloudHandshakeIntegration(t *testing.T) {
	cloudURL := os.Getenv("RICOCHET_CLOUD_INTEGRATION_URL")
	if cloudURL == "" {
		t.Skip("RICOCHET_CLOUD_INTEGRATION_URL is not set")
	}
	if os.Getenv("GRIKAI_ACCESS_TOKEN") == "" && os.Getenv("RICOCHET_BRIDGE_SECRET") == "" {
		t.Skip("GRIKAI_ACCESS_TOKEN or RICOCHET_BRIDGE_SECRET is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	client := NewClient(cloudURL, "integration-smoke")
	if err := client.Start(ctx); err != nil {
		t.Fatalf("cloud bridge start: %v", err)
	}
	select {
	case <-time.After(500 * time.Millisecond):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	client.Close()
}
