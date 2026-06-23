package agent

import (
	"fmt"
	"sync"

	"github.com/igoryan-dao/ricochet/internal/config"
)

type UsageSource string
type UsageOperation string

const (
	UsageSourceActual      UsageSource = "actual"
	UsageSourceEstimated   UsageSource = "estimated"
	UsageSourceUnconfirmed UsageSource = "unconfirmed"

	UsageOperationChat      UsageOperation = "chat"
	UsageOperationWorker    UsageOperation = "worker"
	UsageOperationCondense  UsageOperation = "condense"
	UsageOperationEmbedding UsageOperation = "embedding"

	maxRecentUsageEvents = 100
)

// UsageEvent is the atomic token/cost record for a model operation.
type UsageEvent struct {
	ReservationID         string         `json:"reservationId,omitempty"`
	SessionID             string         `json:"sessionId"`
	RunID                 string         `json:"runId,omitempty"`
	TurnID                string         `json:"turnId,omitempty"`
	Provider              string         `json:"provider"`
	Model                 string         `json:"model"`
	KeySource             string         `json:"keySource,omitempty"`
	InputTokens           int            `json:"inputTokens"`
	OutputTokens          int            `json:"outputTokens"`
	CachedInputTokens     int            `json:"cachedInputTokens,omitempty"`
	CacheCreationTokens   int            `json:"cacheCreationTokens,omitempty"`
	ReasoningOutputTokens int            `json:"reasoningOutputTokens,omitempty"`
	ContextTokens         int            `json:"contextTokens,omitempty"`
	ContextWindow         int            `json:"contextWindow,omitempty"`
	EstimatedCostUSD      float64        `json:"estimatedCostUsd"`
	Source                UsageSource    `json:"source"`
	Operation             UsageOperation `json:"operation"`
	Timestamp             int64          `json:"timestamp,omitempty"`
}

type UsageModelTotal struct {
	Provider              string      `json:"provider"`
	Model                 string      `json:"model"`
	KeySource             string      `json:"keySource,omitempty"`
	InputTokens           int         `json:"inputTokens"`
	OutputTokens          int         `json:"outputTokens"`
	CachedInputTokens     int         `json:"cachedInputTokens,omitempty"`
	CacheCreationTokens   int         `json:"cacheCreationTokens,omitempty"`
	ReasoningOutputTokens int         `json:"reasoningOutputTokens,omitempty"`
	EstimatedCostUSD      float64     `json:"estimatedCostUsd"`
	RequestCount          int         `json:"requestCount"`
	ActualCount           int         `json:"actualCount"`
	EstimatedCount        int         `json:"estimatedCount"`
	Source                UsageSource `json:"source"`
}

type UsageSnapshot struct {
	SessionID             string            `json:"sessionId,omitempty"`
	InputTokens           int               `json:"inputTokens"`
	OutputTokens          int               `json:"outputTokens"`
	CachedInputTokens     int               `json:"cachedInputTokens,omitempty"`
	CacheCreationTokens   int               `json:"cacheCreationTokens,omitempty"`
	ReasoningOutputTokens int               `json:"reasoningOutputTokens,omitempty"`
	ContextTokens         int               `json:"contextTokens,omitempty"`
	ContextWindow         int               `json:"contextWindow,omitempty"`
	EstimatedCostUSD      float64           `json:"estimatedCostUsd"`
	RequestCount          int               `json:"requestCount"`
	ActualCount           int               `json:"actualCount"`
	EstimatedCount        int               `json:"estimatedCount"`
	Source                UsageSource       `json:"source"`
	Models                []UsageModelTotal `json:"models"`
	Events                []UsageEvent      `json:"events,omitempty"`
	LastEvent             *UsageEvent       `json:"lastEvent,omitempty"`
}

type usageAccumulator struct {
	snapshot UsageSnapshot
	byModel  map[string]*UsageModelTotal
	seen     map[string]bool
}

type UsageTracker struct {
	mu             sync.RWMutex
	sessions       map[string]*usageAccumulator
	global         *usageAccumulator
	providers      *config.ProvidersManager
	fallbackPrices map[string]ModelPricing
}

type ModelPricing struct {
	InputPrice  float64
	OutputPrice float64
	IsFree      bool
}

func NewUsageTracker(providers *config.ProvidersManager) *UsageTracker {
	return &UsageTracker{
		sessions:  make(map[string]*usageAccumulator),
		global:    newUsageAccumulator(""),
		providers: providers,
		fallbackPrices: map[string]ModelPricing{
			"deepseek-chat":                  {InputPrice: 0.27, OutputPrice: 1.10},
			"deepseek-reasoner":              {InputPrice: 0.55, OutputPrice: 2.19},
			"claude-sonnet-4-20250514":       {InputPrice: 3.0, OutputPrice: 15.0},
			"claude-3-5-sonnet-20241022":     {InputPrice: 3.0, OutputPrice: 15.0},
			"gpt-4.1":                        {InputPrice: 2.0, OutputPrice: 8.0},
			"gpt-4o":                         {InputPrice: 2.5, OutputPrice: 10.0},
			"gemini-3-flash":                 {IsFree: true},
			"gemini-2.5-flash":               {IsFree: true},
			"codestral-latest":               {IsFree: true},
			"ministral-8b-latest":            {IsFree: true},
			"qwen/qwen3-coder:free":          {IsFree: true},
			"minimax/minimax-m2.5:free":      {IsFree: true},
			"google/gemma-4-26b-a4b-it:free": {IsFree: true},
		},
	}
}

func newUsageAccumulator(sessionID string) *usageAccumulator {
	return &usageAccumulator{
		snapshot: UsageSnapshot{SessionID: sessionID, Source: UsageSourceEstimated},
		byModel:  make(map[string]*UsageModelTotal),
		seen:     make(map[string]bool),
	}
}

func (ut *UsageTracker) Track(event UsageEvent) UsageSnapshot {
	ut.mu.Lock()
	defer ut.mu.Unlock()

	if event.SessionID == "" {
		event.SessionID = "default"
	}
	if event.Operation == "" {
		event.Operation = UsageOperationChat
	}
	if event.Source == "" {
		event.Source = UsageSourceEstimated
	}
	if event.EstimatedCostUSD == 0 {
		event.EstimatedCostUSD = ut.CalculateCost(event.Provider, event.Model, event.InputTokens, event.OutputTokens, event.CachedInputTokens)
	}

	acc := ut.sessions[event.SessionID]
	if acc == nil {
		acc = newUsageAccumulator(event.SessionID)
		ut.sessions[event.SessionID] = acc
	}
	applyUsageEvent(acc, event)
	applyUsageEvent(ut.global, event)
	return cloneSnapshot(acc)
}

func (ut *UsageTracker) GetSessionUsage(sessionID string) UsageSnapshot {
	ut.mu.RLock()
	defer ut.mu.RUnlock()
	if acc := ut.sessions[sessionID]; acc != nil {
		return cloneSnapshot(acc)
	}
	return UsageSnapshot{SessionID: sessionID, Source: UsageSourceEstimated}
}

func (ut *UsageTracker) GetGlobalUsage() UsageSnapshot {
	ut.mu.RLock()
	defer ut.mu.RUnlock()
	return cloneSnapshot(ut.global)
}

func (ut *UsageTracker) CalculateCost(provider, model string, inputTokens, outputTokens, cachedInputTokens int) float64 {
	pricing, ok := ut.LookupPricing(provider, model)
	if !ok || pricing.IsFree {
		return 0
	}
	billableInput := inputTokens - cachedInputTokens
	if billableInput < 0 {
		billableInput = 0
	}
	cachedInputCost := (float64(cachedInputTokens) / 1_000_000) * pricing.InputPrice * 0.1
	return (float64(billableInput)/1_000_000)*pricing.InputPrice + cachedInputCost + (float64(outputTokens)/1_000_000)*pricing.OutputPrice
}

func (ut *UsageTracker) LookupPricing(provider, model string) (ModelPricing, bool) {
	if ut.providers != nil {
		for _, p := range ut.providers.GetAvailableProviders() {
			if provider != "" && p.ID != provider {
				continue
			}
			for _, m := range p.Models {
				if m.ID == model {
					return ModelPricing{InputPrice: m.InputPrice, OutputPrice: m.OutputPrice, IsFree: m.IsFree}, true
				}
			}
		}
	}
	if pricing, ok := ut.fallbackPrices[model]; ok {
		return pricing, true
	}
	return ModelPricing{}, false
}

func (ut *UsageTracker) KeySource(provider string) string {
	if ut.providers == nil {
		return ""
	}
	for _, p := range ut.providers.GetAvailableProviders() {
		if p.ID == provider {
			return p.KeySource
		}
	}
	return ""
}

func applyUsageEvent(acc *usageAccumulator, event UsageEvent) {
	key := event.TurnID
	if key == "" {
		key = fmt.Sprintf("%s:%s:%s:%d", event.RunID, event.Provider, event.Model, event.Timestamp)
	}
	if acc.seen[key] {
		return
	}
	acc.seen[key] = true

	acc.snapshot.InputTokens += event.InputTokens
	acc.snapshot.OutputTokens += event.OutputTokens
	acc.snapshot.CachedInputTokens += event.CachedInputTokens
	acc.snapshot.CacheCreationTokens += event.CacheCreationTokens
	acc.snapshot.ReasoningOutputTokens += event.ReasoningOutputTokens
	acc.snapshot.EstimatedCostUSD += event.EstimatedCostUSD
	acc.snapshot.RequestCount++
	acc.snapshot.ContextTokens = event.ContextTokens
	acc.snapshot.ContextWindow = event.ContextWindow
	if event.Source == UsageSourceActual {
		acc.snapshot.ActualCount++
	} else {
		acc.snapshot.EstimatedCount++
	}
	acc.snapshot.Source = mergeUsageSource(acc.snapshot.Source, event.Source)
	copiedEvent := event
	acc.snapshot.LastEvent = &copiedEvent
	acc.snapshot.Events = append(acc.snapshot.Events, copiedEvent)
	if len(acc.snapshot.Events) > maxRecentUsageEvents {
		acc.snapshot.Events = append([]UsageEvent(nil), acc.snapshot.Events[len(acc.snapshot.Events)-maxRecentUsageEvents:]...)
	}

	modelKey := event.Provider + ":" + event.Model + ":" + event.KeySource
	mt := acc.byModel[modelKey]
	if mt == nil {
		mt = &UsageModelTotal{Provider: event.Provider, Model: event.Model, KeySource: event.KeySource, Source: event.Source}
		acc.byModel[modelKey] = mt
	}
	mt.InputTokens += event.InputTokens
	mt.OutputTokens += event.OutputTokens
	mt.CachedInputTokens += event.CachedInputTokens
	mt.CacheCreationTokens += event.CacheCreationTokens
	mt.ReasoningOutputTokens += event.ReasoningOutputTokens
	mt.EstimatedCostUSD += event.EstimatedCostUSD
	mt.RequestCount++
	if event.Source == UsageSourceActual {
		mt.ActualCount++
	} else {
		mt.EstimatedCount++
	}
	mt.Source = mergeUsageSource(mt.Source, event.Source)
}

func mergeUsageSource(current, incoming UsageSource) UsageSource {
	if current == "" {
		return incoming
	}
	if current == incoming {
		return current
	}
	return UsageSourceEstimated
}

func cloneSnapshot(acc *usageAccumulator) UsageSnapshot {
	s := acc.snapshot
	s.Models = make([]UsageModelTotal, 0, len(acc.byModel))
	for _, total := range acc.byModel {
		s.Models = append(s.Models, *total)
	}
	if acc.snapshot.LastEvent != nil {
		eventCopy := *acc.snapshot.LastEvent
		s.LastEvent = &eventCopy
	}
	if acc.snapshot.Events != nil {
		s.Events = append([]UsageEvent(nil), acc.snapshot.Events...)
	}
	return s
}

func FormatCost(cost float64) string {
	if cost < 0.01 {
		return fmt.Sprintf("$%.4f", cost)
	}
	return fmt.Sprintf("$%.2f", cost)
}
