package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestOpenAINewProviderUsesResponsesForGPT55(t *testing.T) {
	provider, err := NewProvider(ProviderConfig{Provider: "openai", Model: "gpt-5.5", APIKey: "test"})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	if _, ok := provider.(*OpenAIResponsesProvider); !ok {
		t.Fatalf("provider type = %T, want *OpenAIResponsesProvider", provider)
	}
}

func TestNewProviderHonorsResponsesAPITypeForCustomProvider(t *testing.T) {
	provider, err := NewProvider(ProviderConfig{
		Provider: "xai",
		Model:    "grok-4.3",
		APIKey:   "test",
		APIType:  "responses",
		BaseURL:  "https://api.x.ai/v1",
	})
	if err != nil {
		t.Fatalf("NewProvider: %v", err)
	}
	responsesProvider, ok := provider.(*OpenAIResponsesProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *OpenAIResponsesProvider", provider)
	}
	if responsesProvider.baseURL != "https://api.x.ai/v1/responses" {
		t.Fatalf("responses baseURL = %q", responsesProvider.baseURL)
	}
}

func TestNewProviderUsesOfficialZAIBaseURLs(t *testing.T) {
	provider, err := NewProvider(ProviderConfig{Provider: "zhipu", Model: "glm-5.2", APIKey: "test"})
	if err != nil {
		t.Fatalf("NewProvider zhipu: %v", err)
	}
	openAIProvider, ok := provider.(*OpenAIProvider)
	if !ok {
		t.Fatalf("zhipu provider type = %T, want *OpenAIProvider", provider)
	}
	if openAIProvider.baseURL != "https://api.z.ai/api/paas/v4/chat/completions" {
		t.Fatalf("zhipu baseURL = %q", openAIProvider.baseURL)
	}

	provider, err = NewProvider(ProviderConfig{Provider: "zhipu-coding", Model: "glm-5.2", APIKey: "test"})
	if err != nil {
		t.Fatalf("NewProvider zhipu-coding: %v", err)
	}
	openAIProvider, ok = provider.(*OpenAIProvider)
	if !ok {
		t.Fatalf("zhipu-coding provider type = %T, want *OpenAIProvider", provider)
	}
	if openAIProvider.baseURL != "https://api.z.ai/api/coding/paas/v4/chat/completions" {
		t.Fatalf("zhipu-coding baseURL = %q", openAIProvider.baseURL)
	}
}

func TestOpenAIResponsesBuildsFunctionToolRequest(t *testing.T) {
	provider := NewOpenAIResponsesProvider("test", "gpt-5.5", "", "", "", 0)
	req := provider.buildRequest(&ChatRequest{
		SystemPrompt: "system",
		Messages: []protocol.Message{
			{Role: "user", Content: "hello"},
			{
				Role: "assistant",
				ToolUse: []protocol.ToolUseBlock{{
					ID:    "call_1",
					Name:  "run_command",
					Input: json.RawMessage(`{"cmd":"pwd"}`),
				}},
			},
			{Role: "user", ToolResults: []protocol.ToolResultBlock{{ToolUseID: "call_1", Content: "/repo"}}},
		},
		Tools: []protocol.Tool{{Name: "run_command", Description: "Run command", InputSchema: map[string]interface{}{"type": "object"}}},
	}, true)

	if req.Model != "gpt-5.5" || req.Instructions != "system" || !req.Stream {
		t.Fatalf("unexpected request metadata: %#v", req)
	}
	if len(req.Tools) != 1 || req.Tools[0].Type != "function" {
		t.Fatalf("function tool missing: %#v", req.Tools)
	}
	if len(req.Input) != 3 {
		t.Fatalf("input len = %d, want 3: %#v", len(req.Input), req.Input)
	}
	if req.Input[1].Type != "function_call" || req.Input[2].Type != "function_call_output" {
		t.Fatalf("tool call/result not mapped: %#v", req.Input)
	}
}

func TestOpenAIResponsesStreamParserEmitsTextToolAndUsage(t *testing.T) {
	provider := NewOpenAIResponsesProvider("test", "gpt-5.5", "", "", "", 0)
	stream := strings.Join([]string{
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":"hi"}`,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"run_command","arguments":"{\"cmd\":\"pwd\"}"}}`,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":1}}}}`,
		``,
	}, "\n")

	var chunks []*StreamChunk
	err := provider.processStream(strings.NewReader(stream), func(chunk *StreamChunk) error {
		chunks = append(chunks, chunk)
		return nil
	})
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if len(chunks) != 4 {
		t.Fatalf("chunks len = %d, want 4: %#v", len(chunks), chunks)
	}
	if chunks[0].Delta != "hi" {
		t.Fatalf("text delta = %q", chunks[0].Delta)
	}
	if chunks[1].ToolUse == nil || chunks[1].ToolUse.ID != "call_1" {
		t.Fatalf("tool chunk missing: %#v", chunks[1])
	}
	if chunks[2].Usage == nil || chunks[2].Usage.InputTokens != 10 || chunks[2].Usage.CachedInputTokens != 3 {
		t.Fatalf("usage chunk wrong: %#v", chunks[2].Usage)
	}
	if chunks[3].Type != "message_stop" {
		t.Fatalf("last chunk = %#v", chunks[3])
	}
}

func TestOpenAIResponsesParserDoesNotDuplicateOutputText(t *testing.T) {
	resp := parseResponsesResponse(&responsesResponse{
		ID:         "resp_1",
		Model:      "gpt-5.5",
		Status:     "completed",
		OutputText: "hello",
		Output: []responsesOutputItem{{
			Type: "message",
			Role: "assistant",
			Content: []responsesContentPart{{
				Type: "output_text",
				Text: "hello",
			}},
		}},
	})
	if resp.Content != "hello" {
		t.Fatalf("content = %q, want single output_text", resp.Content)
	}
}

func TestOpenAIResponsesEmbedDelegates(t *testing.T) {
	provider := NewOpenAIResponsesProvider("test", "gpt-5.5", "", "", "", 0)
	_, err := provider.Embed(context.Background(), nil)
	if err != nil {
		t.Fatalf("empty embed should not call network: %v", err)
	}
}

func TestOpenAIResponsesProviderUsesCustomBaseURL(t *testing.T) {
	provider := NewOpenAIResponsesProvider("test", "grok-4.3", "https://api.x.ai/v1", "", "", 0)
	if provider.baseURL != "https://api.x.ai/v1/responses" {
		t.Fatalf("baseURL = %q, want xAI responses endpoint", provider.baseURL)
	}
	if got := provider.Name(); got != "xai" {
		t.Fatalf("Name() = %q, want xai", got)
	}
}
