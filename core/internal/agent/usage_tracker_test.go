package agent

import (
	"fmt"
	"testing"
)

func TestUsageTrackerDedupesTurnAndAggregatesModels(t *testing.T) {
	tracker := NewUsageTracker(nil)
	event := UsageEvent{
		SessionID:        "s1",
		RunID:            "r1",
		TurnID:           "t1",
		Provider:         "deepseek",
		Model:            "deepseek-chat",
		InputTokens:      1000,
		OutputTokens:     100,
		EstimatedCostUSD: 0.001,
		Source:           UsageSourceActual,
		Operation:        UsageOperationChat,
	}

	first := tracker.Track(event)
	second := tracker.Track(event)

	if first.InputTokens != 1000 || second.InputTokens != 1000 {
		t.Fatalf("expected deduped input tokens, got first=%d second=%d", first.InputTokens, second.InputTokens)
	}
	if second.RequestCount != 1 {
		t.Fatalf("expected one request after duplicate event, got %d", second.RequestCount)
	}
	if len(second.Models) != 1 {
		t.Fatalf("expected one model total, got %d", len(second.Models))
	}
	if second.Models[0].ActualCount != 1 {
		t.Fatalf("expected actual count to aggregate, got %d", second.Models[0].ActualCount)
	}
}

func TestUsageTrackerCalculatesCachedInputDiscountEstimate(t *testing.T) {
	tracker := NewUsageTracker(nil)
	cost := tracker.CalculateCost("deepseek", "deepseek-chat", 10_000, 1_000, 9_000)
	fullInputCost := (float64(10_000) / 1_000_000) * 0.27
	if cost >= fullInputCost {
		t.Fatalf("expected cached input discount to reduce cost, got cost=%f fullInputCost=%f", cost, fullInputCost)
	}
}

func TestUsageTrackerCapsRecentEventsAndPreservesLastEvent(t *testing.T) {
	tracker := NewUsageTracker(nil)

	var snapshot UsageSnapshot
	for i := 0; i < maxRecentUsageEvents+5; i++ {
		snapshot = tracker.Track(UsageEvent{
			SessionID:   "s1",
			TurnID:      fmt.Sprintf("t-%03d", i),
			Provider:    "deepseek",
			Model:       "deepseek-chat",
			InputTokens: i + 1,
			Source:      UsageSourceActual,
			Operation:   UsageOperationChat,
			Timestamp:   int64(i),
		})
	}

	if len(snapshot.Events) != maxRecentUsageEvents {
		t.Fatalf("expected %d recent events, got %d", maxRecentUsageEvents, len(snapshot.Events))
	}
	if snapshot.Events[0].TurnID != "t-005" {
		t.Fatalf("expected oldest retained event t-005, got %q", snapshot.Events[0].TurnID)
	}
	if snapshot.LastEvent == nil || snapshot.LastEvent.TurnID != "t-104" {
		t.Fatalf("expected last event t-104, got %#v", snapshot.LastEvent)
	}

	snapshot.Events[0].TurnID = "mutated"
	fresh := tracker.GetSessionUsage("s1")
	if fresh.Events[0].TurnID != "t-005" {
		t.Fatalf("expected cloned events to be isolated, got %q", fresh.Events[0].TurnID)
	}
}

func TestUsageTrackerAggregatesCacheReasoningAndEstimatedCounts(t *testing.T) {
	tracker := NewUsageTracker(nil)
	snapshot := tracker.Track(UsageEvent{
		SessionID:             "s1",
		TurnID:                "estimated",
		Provider:              "openai",
		Model:                 "gpt-4o",
		InputTokens:           100,
		OutputTokens:          40,
		CachedInputTokens:     30,
		CacheCreationTokens:   20,
		ReasoningOutputTokens: 10,
		EstimatedCostUSD:      0.002,
		Source:                UsageSourceEstimated,
		Operation:             UsageOperationChat,
	})
	snapshot = tracker.Track(UsageEvent{
		SessionID:             "s1",
		TurnID:                "actual",
		Provider:              "openai",
		Model:                 "gpt-4o",
		InputTokens:           200,
		OutputTokens:          80,
		CachedInputTokens:     50,
		CacheCreationTokens:   25,
		ReasoningOutputTokens: 15,
		EstimatedCostUSD:      0.004,
		Source:                UsageSourceActual,
		Operation:             UsageOperationWorker,
	})

	if snapshot.CachedInputTokens != 80 || snapshot.CacheCreationTokens != 45 || snapshot.ReasoningOutputTokens != 25 {
		t.Fatalf("unexpected token breakdown: cached=%d cacheWrite=%d reasoning=%d", snapshot.CachedInputTokens, snapshot.CacheCreationTokens, snapshot.ReasoningOutputTokens)
	}
	if snapshot.EstimatedCount != 1 || snapshot.ActualCount != 1 {
		t.Fatalf("expected one estimated and one actual event, got estimated=%d actual=%d", snapshot.EstimatedCount, snapshot.ActualCount)
	}
	if len(snapshot.Models) != 1 {
		t.Fatalf("expected one model total, got %d", len(snapshot.Models))
	}
	model := snapshot.Models[0]
	if model.EstimatedCount != 1 || model.ActualCount != 1 {
		t.Fatalf("expected model counts to increment once, got estimated=%d actual=%d", model.EstimatedCount, model.ActualCount)
	}
	if model.CachedInputTokens != 80 || model.CacheCreationTokens != 45 || model.ReasoningOutputTokens != 25 {
		t.Fatalf("unexpected model token breakdown: cached=%d cacheWrite=%d reasoning=%d", model.CachedInputTokens, model.CacheCreationTokens, model.ReasoningOutputTokens)
	}
}
