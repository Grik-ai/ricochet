package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	agentLessons "github.com/igoryan-dao/ricochet/internal/agent/memory"
	context_manager "github.com/igoryan-dao/ricochet/internal/context"
	legacyMemory "github.com/igoryan-dao/ricochet/internal/memory"
	"github.com/igoryan-dao/ricochet/internal/modes"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/rules"
	"github.com/igoryan-dao/ricochet/internal/tools"
)

type completionFakeProvider struct {
	chunks []StreamChunk
}

func (p *completionFakeProvider) Chat(context.Context, *ChatRequest) (*ChatResponse, error) {
	return &ChatResponse{Content: ""}, nil
}

func (p *completionFakeProvider) ChatStream(_ context.Context, _ *ChatRequest, callback StreamCallback) error {
	for i := range p.chunks {
		chunk := p.chunks[i]
		if err := callback(&chunk); err != nil {
			return err
		}
	}
	return nil
}

func (p *completionFakeProvider) Embed(context.Context, []string) ([][]float32, error) {
	return nil, nil
}

func (p *completionFakeProvider) Name() string {
	return "fake"
}

type completionFakeExecutor struct{}

func (completionFakeExecutor) Execute(context.Context, string, json.RawMessage) (string, error) {
	return "", nil
}

func (completionFakeExecutor) GetDefinitions() []tools.ToolDefinition {
	return nil
}

func newCompletionTestController(t *testing.T, provider Provider) *Controller {
	t.Helper()

	cwd := t.TempDir()
	memoryManager, err := legacyMemory.NewManager(cwd)
	if err != nil {
		t.Fatalf("memory manager: %v", err)
	}
	scratchpad, err := NewScratchpadManager(cwd)
	if err != nil {
		t.Fatalf("scratchpad manager: %v", err)
	}

	c := &Controller{
		provider:            provider,
		sessionManager:      NewSessionManager(""),
		config:              &Config{Provider: ProviderConfig{Provider: "fake", Model: "fake"}, SystemPrompt: "You are a test agent.", MaxTokens: 1024, ContextWindow: 8192},
		executor:            completionFakeExecutor{},
		envTracker:          context_manager.NewEnvironmentTracker(cwd),
		modes:               modes.NewManager(cwd),
		rules:               rules.NewManager(cwd),
		cwd:                 cwd,
		memoryManager:       memoryManager,
		intelligenceManager: agentLessons.NewManager(cwd),
		planManager:         NewPlanManager(cwd),
		helpAgent:           NewHelpAgent(),
		scratchpad:          scratchpad,
		loopDetector:        NewLoopDetector(3),
		injectionProcessor:  NewInjectionProcessor(cwd),
		events:              NewEventEmitter(),
		lastContextStatus:   make(map[string]*protocol.ContextStatus),
		lastCompaction:      make(map[string]*protocol.ContextCompactionEvent),
	}
	c.CreateSessionWithID("session-completion")
	return c
}

func TestChatNoToolFinalTurnEmitsCompletedProgress(t *testing.T) {
	controller := newCompletionTestController(t, &completionFakeProvider{chunks: []StreamChunk{
		{Type: "content_block_delta", Delta: "Done."},
		{Type: "message_stop"},
	}})

	var progress []protocol.TaskProgress
	err := controller.Chat(context.Background(), ChatRequestInput{
		SessionID: "session-completion",
		RunID:     "run-completion",
		Content:   "hello",
		MaxTurns:  1,
	}, func(update interface{}) {
		if p, ok := update.(protocol.TaskProgress); ok {
			progress = append(progress, p)
		}
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}
	if len(progress) == 0 {
		t.Fatal("expected task progress updates")
	}
	last := progress[len(progress)-1]
	if last.Result != "COMPLETED" || last.Status != "Mission Accomplished" || last.IsActive {
		t.Fatalf("expected terminal completed progress, got %#v", last)
	}
}

func TestChatEmptyFinalTurnEmitsFallbackAndCompletes(t *testing.T) {
	controller := newCompletionTestController(t, &completionFakeProvider{chunks: []StreamChunk{
		{Type: "message_stop"},
	}})

	var assistantMessages []ChatMessage
	var progress []protocol.TaskProgress
	err := controller.Chat(context.Background(), ChatRequestInput{
		SessionID: "session-completion",
		RunID:     "run-empty-final",
		Content:   "проанализируй проект",
		MaxTurns:  1,
	}, func(update interface{}) {
		switch u := update.(type) {
		case ChatUpdate:
			if u.Message != nil && u.Message.Role == "assistant" {
				assistantMessages = append(assistantMessages, *u.Message)
			}
		case protocol.TaskProgress:
			progress = append(progress, u)
		}
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}

	var fallbackFound bool
	for _, msg := range assistantMessages {
		if !msg.IsStreaming && strings.Contains(msg.Content, "without a visible final response") {
			fallbackFound = true
		}
	}
	if !fallbackFound {
		t.Fatalf("expected fallback assistant message, got %#v", assistantMessages)
	}
	if len(progress) == 0 || progress[len(progress)-1].Result != "COMPLETED" {
		t.Fatalf("expected completed progress, got %#v", progress)
	}
}

func TestChatToolTurnMarksVisibleReportIntermediate(t *testing.T) {
	report := strings.Repeat("Polybot Project Comprehensive Analysis\n\n", 8)
	controller := newCompletionTestController(t, &completionFakeProvider{chunks: []StreamChunk{
		{Type: "content_block_delta", Delta: report},
		{Type: "tool_use", ToolUse: &protocol.ToolUseBlock{
			ID:    "tool-boundary",
			Name:  "task_boundary",
			Input: json.RawMessage(`{"TaskName":"Polybot Project Analysis","Mode":"PLANNING","TaskStatus":"Exploring project structure","PredictedTaskSize":8}`),
		}},
		{Type: "message_stop"},
	}})

	var toolBearingMessages []ChatMessage
	var finalMessages []ChatMessage
	err := controller.Chat(context.Background(), ChatRequestInput{
		SessionID: "session-completion",
		RunID:     "run-intermediate",
		Content:   "проанализируй проект",
		MaxTurns:  1,
	}, func(update interface{}) {
		u, ok := update.(ChatUpdate)
		if !ok || u.Message == nil || u.Message.Role != "assistant" {
			return
		}
		if len(u.Message.ToolCalls) > 0 {
			toolBearingMessages = append(toolBearingMessages, *u.Message)
		}
		if u.Message.Metadata != nil && u.Message.Metadata.RunPhase == "final" {
			finalMessages = append(finalMessages, *u.Message)
		}
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}
	if len(toolBearingMessages) == 0 {
		t.Fatal("expected a visible tool-bearing assistant draft")
	}
	lastToolMessage := toolBearingMessages[len(toolBearingMessages)-1]
	if lastToolMessage.Metadata == nil || lastToolMessage.Metadata.RunPhase != "intermediate" {
		t.Fatalf("expected tool-bearing report to be intermediate, got %#v", lastToolMessage.Metadata)
	}
	if len(finalMessages) == 0 {
		t.Fatal("expected turn-limit fallback to emit a final completion")
	}
}

func TestCompletionBoundaryAddsSoftBudgetNudge(t *testing.T) {
	report := strings.Repeat("Polybot Project Comprehensive Analysis\n\n", 8)
	controller := newCompletionTestController(t, &completionFakeProvider{chunks: []StreamChunk{
		{Type: "content_block_delta", Delta: report},
		{Type: "tool_use", ToolUse: &protocol.ToolUseBlock{
			ID:    "tool-boundary",
			Name:  "task_boundary",
			Input: json.RawMessage(`{"TaskName":"Polybot Project Analysis","Mode":"VERIFICATION","TaskStatus":"Analysis completed and documented","PredictedTaskSize":8}`),
		}},
		{Type: "message_stop"},
	}})

	err := controller.Chat(context.Background(), ChatRequestInput{
		SessionID: "session-completion",
		RunID:     "run-completion-boundary",
		Content:   "проанализируй проект",
		MaxTurns:  1,
	}, func(update interface{}) {})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}

	var foundNudge bool
	for _, msg := range controller.GetSession("session-completion").StateHandler.GetMessages() {
		if msg.Role == "user" && strings.Contains(msg.Content, "already produced a substantial visible result") {
			foundNudge = true
			break
		}
	}
	if !foundNudge {
		t.Fatal("expected completion boundary to add a soft budget nudge")
	}
}

func TestHardBudgetCompletesWithLastSubstantialDraft(t *testing.T) {
	report := "# Polybot Project Comprehensive Analysis\n\n" +
		"## Executive Summary\nPolybot is a Rust trading bot with exchange, signal, and execution modules.\n\n" +
		"## Architecture\nThe project includes configuration, ingestion, analysis, and execution layers.\n\n" +
		"## Recommendations\nFinish the report instead of continuing to inspect files."
	controller := newCompletionTestController(t, &completionFakeProvider{chunks: []StreamChunk{
		{Type: "content_block_delta", Delta: report},
		{Type: "tool_use", ToolUse: &protocol.ToolUseBlock{
			ID:    "tool-boundary",
			Name:  "task_boundary",
			Input: json.RawMessage(`{"TaskName":"Polybot Project Analysis","Mode":"PLANNING","TaskStatus":"Exploring project structure","PredictedTaskSize":1}`),
		}},
		{Type: "message_stop"},
	}})

	var finalMessages []ChatMessage
	var progress []protocol.TaskProgress
	err := controller.Chat(context.Background(), ChatRequestInput{
		SessionID: "session-completion",
		RunID:     "run-hard-budget",
		Content:   "проанализируй проект",
		MaxTurns:  20,
	}, func(update interface{}) {
		switch u := update.(type) {
		case ChatUpdate:
			if u.Message != nil && u.Message.Role == "assistant" && u.Message.Metadata != nil && u.Message.Metadata.RunPhase == "final" {
				finalMessages = append(finalMessages, *u.Message)
			}
		case protocol.TaskProgress:
			progress = append(progress, u)
		}
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}
	if len(finalMessages) == 0 {
		t.Fatal("expected hard budget to emit a final assistant message")
	}
	final := finalMessages[len(finalMessages)-1]
	if !strings.Contains(final.Content, "Polybot Project Comprehensive Analysis") {
		t.Fatalf("expected final to use last substantial draft, got %q", final.Content)
	}
	if len(progress) == 0 || progress[len(progress)-1].Result != "BUDGET_EXCEEDED" {
		t.Fatalf("expected budget-exceeded stopped progress, got %#v", progress)
	}
}

func TestHubTaskCreationRequestWithoutCreateTaskEmitsError(t *testing.T) {
	controller := newCompletionTestController(t, &completionFakeProvider{chunks: []StreamChunk{
		{Type: "content_block_delta", Delta: "I analyzed the project but did not create Hub Tasks."},
		{Type: "message_stop"},
	}})

	var progress []protocol.TaskProgress
	err := controller.Chat(context.Background(), ChatRequestInput{
		SessionID: "session-completion",
		RunID:     "run-hub-task-missing",
		Content:   "проанализируй проект и создай задачи в Hub",
		MaxTurns:  1,
	}, func(update interface{}) {
		if p, ok := update.(protocol.TaskProgress); ok {
			progress = append(progress, p)
		}
	})
	if err != nil {
		t.Fatalf("Chat failed: %v", err)
	}
	if len(progress) == 0 {
		t.Fatal("expected task progress updates")
	}
	last := progress[len(progress)-1]
	if last.Result != "ERROR" || !strings.Contains(last.Status, "no Hub Tasks were created") || last.IsActive {
		t.Fatalf("expected missing Hub Task creation error, got %#v", last)
	}
}

func TestHubTaskCreationIntentDetector(t *testing.T) {
	cases := []string{
		"создай задачи в Hub после анализа",
		"переведи в задачи",
		"Create Hub Tasks from this plan",
		"turn this into tasks",
	}
	for _, input := range cases {
		if !isHubTaskCreationRequest(input) {
			t.Fatalf("expected %q to request Hub Task creation", input)
		}
	}
	if isHubTaskCreationRequest("проверь проект") {
		t.Fatal("analysis-only request should not require Hub Task creation")
	}
	if isHubTaskCreationRequest("проанализируй проект, но не создавай задачи") {
		t.Fatal("negative task creation request should not require Hub Task creation")
	}
}

func TestRepeatedReadGuardNudgesOnceAtThreshold(t *testing.T) {
	guard := newRepeatedReadGuard()
	call := ToolCallInfo{Name: "read_file", Arguments: `{"path":"/repo/src/lib.rs"}`}

	for i := 0; i < repeatedReadNudgeThreshold-1; i++ {
		if nudge := guard.Observe(call); nudge != "" {
			t.Fatalf("unexpected early nudge at read %d: %s", i+1, nudge)
		}
	}

	nudge := guard.Observe(call)
	if !strings.Contains(nudge, "Stop rereading") || !strings.Contains(nudge, "/repo/src/lib.rs") {
		t.Fatalf("expected repeated-read nudge, got %q", nudge)
	}
	if again := guard.Observe(call); again != "" {
		t.Fatalf("expected only one nudge per file, got %q", again)
	}
}
