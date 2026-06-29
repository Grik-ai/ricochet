package agent

import (
	"strings"
	"testing"
)

func TestOpenAIStreamParsesUsageChunk(t *testing.T) {
	provider := NewOpenAIProvider("test", "deepseek-chat", "https://api.deepseek.com/v1", "", "", 0)
	stream := `data: {"id":"1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":80,"completion_tokens_details":{"reasoning_tokens":5}}}
data: [DONE]
`
	var usage Usage
	err := provider.processStream(strings.NewReader(stream), func(chunk *StreamChunk) error {
		if chunk.Usage != nil {
			usage = mergeUsage(usage, *chunk.Usage)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if usage.InputTokens != 100 || usage.OutputTokens != 20 || usage.CachedInputTokens != 80 || usage.ReasoningOutputTokens != 5 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
}

func TestOpenAIHeadersOmitAuthorizationWhenAPIKeyEmpty(t *testing.T) {
	provider := NewOpenAIProvider("", "qwen/qwen3-coder:free", "https://grik.io/api/v1/ricochet/openai/v1", "", "", 0)
	headers := provider.headers()
	if _, ok := headers["Authorization"]; ok {
		t.Fatalf("Authorization header should be omitted when API key is empty: %#v", headers)
	}
}

func TestGeminiStreamParsesUsageMetadata(t *testing.T) {
	provider := &GeminiProvider{apiKey: "test", model: "gemini-test"}
	stream := `data: {"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":30,"totalTokenCount":150},"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}
`
	var usage Usage
	err := provider.processStream(strings.NewReader(stream), func(chunk *StreamChunk) error {
		if chunk.Usage != nil {
			usage = mergeUsage(usage, *chunk.Usage)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if usage.InputTokens != 120 || usage.OutputTokens != 30 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
}

func TestAnthropicStreamParsesUsageEvents(t *testing.T) {
	provider := &AnthropicProvider{apiKey: "test", model: "claude-test"}
	stream := `data: {"type":"message_start","message":{"usage":{"input_tokens":200,"output_tokens":0,"cache_read_input_tokens":150}}}
data: {"type":"message_delta","delta":{"usage":{"output_tokens":40},"stop_reason":"end_turn"}}
data: {"type":"message_stop"}
`
	var usage Usage
	err := provider.processStream(strings.NewReader(stream), func(chunk *StreamChunk) error {
		if chunk.Usage != nil {
			usage = mergeUsage(usage, *chunk.Usage)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if usage.InputTokens != 200 || usage.OutputTokens != 40 || usage.CachedInputTokens != 150 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
}
