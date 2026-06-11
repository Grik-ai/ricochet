package agent

import (
	"context"
	"time"

	"github.com/igoryan-dao/ricochet/internal/config"
	context_manager "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func (c *Controller) effectiveContextConfig() config.ContextSettings {
	var settings config.ContextSettings
	if c != nil && c.config != nil {
		settings = c.config.Context
	}
	if settings.CondenseThreshold <= 0 {
		settings.CondenseThreshold = 70
	}
	if settings.SlidingWindowSize <= 0 {
		settings.SlidingWindowSize = 20
	}
	if settings.MaxFragmentTokens <= 0 {
		settings.MaxFragmentTokens = 10000
	}
	if !settings.AutoCondense && !settings.ShowContextIndicator && !settings.EnableCheckpoints && !settings.CheckpointOnWrites && !settings.EnableCodeIndex {
		settings.AutoCondense = true
		settings.ShowContextIndicator = true
		settings.EnableCheckpoints = true
		settings.CheckpointOnWrites = true
	}
	return settings
}

func (c *Controller) effectiveContextWindow() int {
	if c != nil && c.config != nil && c.config.ContextWindow > 0 {
		return c.config.ContextWindow
	}
	return 128000
}

func (c *Controller) contextCheckpointStatus(settings config.ContextSettings) *protocol.CheckpointStatus {
	if c == nil {
		return nil
	}
	if c.checkpointManager == nil {
		return &protocol.CheckpointStatus{
			Enabled:            settings.EnableCheckpoints,
			CheckpointOnWrites: settings.CheckpointOnWrites,
			Error:              "Checkpoint manager is not initialized.",
		}
	}
	status := c.checkpointManager.Status(settings.EnableCheckpoints, settings.CheckpointOnWrites)
	return &status
}

func (c *Controller) lastCompactionForSession(sessionID string) *protocol.ContextCompactionEvent {
	if c == nil {
		return nil
	}
	c.contextStatusMu.RLock()
	defer c.contextStatusMu.RUnlock()
	if c.lastCompaction == nil {
		return nil
	}
	event := c.lastCompaction[sessionID]
	if event == nil {
		return nil
	}
	clone := *event
	return &clone
}

func (c *Controller) rememberContextStatus(status *protocol.ContextStatus) {
	if c == nil || status == nil || status.SessionID == "" {
		return
	}
	c.contextStatusMu.Lock()
	defer c.contextStatusMu.Unlock()
	if c.lastContextStatus == nil {
		c.lastContextStatus = make(map[string]*protocol.ContextStatus)
	}
	clone := *status
	c.lastContextStatus[status.SessionID] = &clone
}

func (c *Controller) rememberContextCompaction(event *protocol.ContextCompactionEvent) {
	if c == nil || event == nil || event.SessionID == "" {
		return
	}
	c.contextStatusMu.Lock()
	defer c.contextStatusMu.Unlock()
	if c.lastCompaction == nil {
		c.lastCompaction = make(map[string]*protocol.ContextCompactionEvent)
	}
	clone := *event
	c.lastCompaction[event.SessionID] = &clone
}

func (c *Controller) contextStatusFromReport(sessionID, runID string, report *protocol.ContextBuildReport, wasCondensed bool, wasTruncated bool, cumulativeCost float64) *protocol.ContextStatus {
	settings := c.effectiveContextConfig()
	var lastCompaction *protocol.ContextCompactionEvent
	var checkpointStatus *protocol.CheckpointStatus
	if c != nil {
		lastCompaction = c.lastCompactionForSession(sessionID)
		checkpointStatus = c.contextCheckpointStatus(settings)
	}
	status := &protocol.ContextStatus{
		SessionID:              sessionID,
		RunID:                  runID,
		WasCondensed:           wasCondensed,
		WasTruncated:           wasTruncated,
		CumulativeCost:         cumulativeCost,
		Report:                 report,
		Warnings:               contextWarnings(report),
		Suggestions:            contextSuggestions(report),
		CondenseThreshold:      settings.CondenseThreshold,
		FallbackWindow:         settings.SlidingWindowSize,
		CanManualCompact:       c != nil && c.provider != nil,
		LastCompaction:         lastCompaction,
		Checkpoint:             checkpointStatus,
		CompressionSavedTokens: 0,
		EffectivePolicy: &protocol.ContextEffectivePolicy{
			AutoCondense:         settings.AutoCondense,
			CondenseThreshold:    settings.CondenseThreshold,
			SlidingWindowSize:    settings.SlidingWindowSize,
			ShowContextIndicator: settings.ShowContextIndicator,
			ShowContributorPanel: settings.ShowContributorPanel,
		},
	}
	if report != nil {
		status.TokensUsed = report.TokensUsed
		status.TokensMax = report.TokensMax
		status.Percentage = report.Percentage
		if report.Compression != nil {
			status.CompressionSavedTokens = report.Compression.SavedTokens
		}
	}
	c.rememberContextStatus(status)
	return status
}

func (c *Controller) contextStatusFromResult(sessionID, runID string, result *context_manager.ContextResult, cumulativeCost float64) *protocol.ContextStatus {
	if result == nil {
		return c.GetContextStatus(sessionID)
	}
	status := c.contextStatusFromReport(sessionID, runID, result.Report, result.WasCondensed, result.WasTruncated, cumulativeCost)
	status.TokensUsed = result.TokensUsed
	status.TokensMax = result.TokensMax
	status.Percentage = result.Percentage
	return status
}

func (c *Controller) GetContextStatus(sessionID string) *protocol.ContextStatus {
	settings := c.effectiveContextConfig()
	contextLimit := c.effectiveContextWindow()
	systemPrompt := ""
	if c != nil && c.config != nil {
		systemPrompt = c.config.SystemPrompt
	}

	var messages []protocol.Message
	var cumulativeCost float64
	if c != nil && c.sessionManager != nil && sessionID != "" {
		if session := c.sessionManager.GetSession(sessionID); session != nil {
			messages = session.StateHandler.GetMessages()
			cumulativeCost = session.TotalCost
		}
	}

	report := context_manager.BuildContextReport(systemPrompt, messages, contextLimit, settings.MaxFragmentTokens)
	return c.contextStatusFromReport(sessionID, "", &report, false, false, cumulativeCost)
}

func (c *Controller) CompactContextNow(ctx context.Context, sessionID string) (*protocol.ContextStatus, *protocol.ContextCompactionEvent, error) {
	if c == nil || c.sessionManager == nil || sessionID == "" {
		return c.GetContextStatus(sessionID), nil, nil
	}
	session := c.sessionManager.GetSession(sessionID)
	if session == nil {
		return c.GetContextStatus(sessionID), nil, nil
	}
	messages := session.StateHandler.GetMessages()
	statusBefore := c.GetContextStatus(sessionID)
	if len(messages) <= 3 || c.provider == nil {
		return statusBefore, nil, nil
	}

	contextLimit := c.effectiveContextWindow()
	settings := c.effectiveContextConfig()
	model := ""
	systemPrompt := ""
	if c.config != nil {
		model = c.config.Provider.Model
		systemPrompt = c.config.SystemPrompt
	}
	manager := context_manager.NewCondenseManager(contextLimit, settings.CondenseThreshold, &condenseAdapter{
		p:     c.provider,
		model: model,
	})

	result, err := manager.Condense(ctx, messages, systemPrompt)
	if err != nil {
		event := &protocol.ContextCompactionEvent{
			SessionID:    sessionID,
			Event:        "context_compaction_failed",
			TokensBefore: statusBefore.TokensUsed,
			TokensAfter:  statusBefore.TokensUsed,
			TokensMax:    statusBefore.TokensMax,
			Percentage:   statusBefore.Percentage,
			Error:        err.Error(),
			Timestamp:    time.Now().UnixMilli(),
		}
		c.rememberContextCompaction(event)
		status := c.GetContextStatus(sessionID)
		return status, event, nil
	}
	if result == nil || !result.WasCondensed {
		return statusBefore, nil, nil
	}

	session.StateHandler.SetMessages(result.Messages)
	_ = c.sessionManager.Save(sessionID)

	report := context_manager.BuildContextReport(systemPrompt, result.Messages, contextLimit, settings.MaxFragmentTokens)
	contextResult := &context_manager.ContextResult{
		Messages:     result.Messages,
		WasCondensed: true,
		Summary:      result.Summary,
		SystemPrompt: systemPrompt,
		TokensBefore: result.TokensBefore,
		TokensUsed:   result.TokensAfter,
		TokensMax:    contextLimit,
		Percentage:   float64(result.TokensAfter) / float64(contextLimit) * 100,
		Report:       &report,
	}
	event := &protocol.ContextCompactionEvent{
		SessionID:      sessionID,
		Event:          "context_condensed",
		TokensBefore:   result.TokensBefore,
		TokensAfter:    result.TokensAfter,
		TokensMax:      contextLimit,
		Percentage:     contextResult.Percentage,
		Summary:        result.Summary,
		PreservedItems: session.FileTracker.GetRecentFiles(20),
		ActiveCommands: context_manager.ExtractActiveCommandBlocks(result.Messages),
		Timestamp:      time.Now().UnixMilli(),
	}
	c.rememberContextCompaction(event)
	if result.Summary != "" {
		_ = appendSessionMemory(c.cwd, sessionID, "", event.Event, result.Summary)
	}
	status := c.contextStatusFromResult(sessionID, "", contextResult, session.TotalCost)
	return status, event, nil
}
