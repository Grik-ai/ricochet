package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

const anthropicAPIURL = "https://api.anthropic.com/v1/messages"
const anthropicAPIVersion = "2023-06-01"

// AnthropicProvider implements Provider for Anthropic Claude
type AnthropicProvider struct {
	apiKey string
	model  string
}

// NewAnthropicProvider creates a new Anthropic provider
func NewAnthropicProvider(apiKey, model string) *AnthropicProvider {
	if model == "" {
		model = "claude-sonnet-4-20250514"
	}
	return &AnthropicProvider{
		apiKey: apiKey,
		model:  model,
	}
}

func (p *AnthropicProvider) Name() string {
	return "anthropic"
}

// anthropicRequest is the Anthropic API request format
type anthropicRequest struct {
	Model       string             `json:"model"`
	MaxTokens   int                `json:"max_tokens"`
	Messages    []anthropicMessage `json:"messages"`
	System      string             `json:"system,omitempty"`
	Tools       []anthropicTool    `json:"tools,omitempty"`
	Thinking    *anthropicThinking `json:"thinking,omitempty"`
	Temperature float64            `json:"temperature,omitempty"`
	TopP        float64            `json:"top_p,omitempty"`
	Stream      bool               `json:"stream,omitempty"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []anthropicContentBlock
}

type anthropicContentBlock struct {
	Type         string                 `json:"type"` // text, tool_use, tool_result
	Text         string                 `json:"text,omitempty"`
	ID           string                 `json:"id,omitempty"`
	Name         string                 `json:"name,omitempty"`
	Input        json.RawMessage        `json:"input,omitempty"`
	ToolUseID    string                 `json:"tool_use_id,omitempty"`
	Content      string                 `json:"content,omitempty"`
	IsError      bool                   `json:"is_error,omitempty"`
	CacheControl *anthropicCacheControl `json:"cache_control,omitempty"`
}

type anthropicTool struct {
	Name         string                 `json:"name"`
	Description  string                 `json:"description"`
	InputSchema  map[string]interface{} `json:"input_schema"`
	CacheControl *anthropicCacheControl `json:"cache_control,omitempty"`
}

type anthropicCacheControl struct {
	Type string `json:"type"`
}

type anthropicThinking struct {
	Type         string `json:"type"`
	BudgetTokens int    `json:"budget_tokens"`
}

// anthropicResponse is the Anthropic API response format
type anthropicResponse struct {
	ID           string                  `json:"id"`
	Type         string                  `json:"type"`
	Role         string                  `json:"role"`
	Content      []anthropicContentBlock `json:"content"`
	Model        string                  `json:"model"`
	StopReason   string                  `json:"stop_reason"`
	StopSequence string                  `json:"stop_sequence,omitempty"`
	Usage        struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// Chat performs a non-streaming chat completion
func (p *AnthropicProvider) Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	anthropicReq := p.buildRequest(req, false)

	body, err := json.Marshal(anthropicReq)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	resp, err := doRequest(ctx, "POST", anthropicAPIURL, p.headers(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}

	var anthropicResp anthropicResponse
	if err := json.Unmarshal(respBody, &anthropicResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	return p.parseResponse(&anthropicResp), nil
}

func (p *AnthropicProvider) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	return nil, fmt.Errorf("anthropic does not support native embeddings yet")
}

// ChatStream performs a streaming chat completion
func (p *AnthropicProvider) ChatStream(ctx context.Context, req *ChatRequest, callback StreamCallback) error {
	anthropicReq := p.buildRequest(req, true)

	body, err := json.Marshal(anthropicReq)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	resp, err := doRequest(ctx, "POST", anthropicAPIURL, p.headers(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}

	return p.processStream(resp.Body, callback)
}

func (p *AnthropicProvider) headers() map[string]string {
	return map[string]string{
		"Content-Type":      "application/json",
		"x-api-key":         p.apiKey,
		"anthropic-version": anthropicAPIVersion,
	}
}

func (p *AnthropicProvider) buildRequest(req *ChatRequest, stream bool) *anthropicRequest {
	messages := make([]anthropicMessage, 0, len(req.Messages))

	for _, msg := range req.Messages {
		if msg.Role == "system" {
			continue // System messages handled separately
		}

		// Handle tool results
		if len(msg.ToolResults) > 0 {
			blocks := make([]anthropicContentBlock, 0, len(msg.ToolResults))
			for _, tr := range msg.ToolResults {
				blocks = append(blocks, anthropicContentBlock{
					Type:      "tool_result",
					ToolUseID: tr.ToolUseID,
					Content:   tr.Content,
					IsError:   tr.IsError,
				})
			}
			messages = append(messages, anthropicMessage{
				Role:    "user",
				Content: blocks,
			})
			continue
		}

		// Handle tool use blocks
		if len(msg.ToolUse) > 0 {
			blocks := make([]anthropicContentBlock, 0, len(msg.ToolUse)+1)
			if msg.Content != "" {
				blocks = append(blocks, anthropicContentBlock{
					Type: "text",
					Text: msg.Content,
				})
			}
			for _, tu := range msg.ToolUse {
				blocks = append(blocks, anthropicContentBlock{
					Type:  "tool_use",
					ID:    tu.ID,
					Name:  tu.Name,
					Input: tu.Input,
				})
			}
			messages = append(messages, anthropicMessage{
				Role:    msg.Role,
				Content: blocks,
			})
			continue
		}

		// Simple text message
		messages = append(messages, anthropicMessage{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}

	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = 8192
	}

	tools := make([]anthropicTool, 0, len(req.Tools))
	for _, t := range req.Tools {
		tools = append(tools, anthropicTool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	// Cache the last tool to cache the system prompt and tools definitions
	if len(tools) > 0 {
		tools[len(tools)-1].CacheControl = &anthropicCacheControl{Type: "ephemeral"}
	}

	var thinking *anthropicThinking
	if strings.Contains(p.model, "claude-3-7") && maxTokens >= 4000 {
		thinking = &anthropicThinking{
			Type:         "enabled",
			BudgetTokens: 2048, // Default budget for reasoning
		}
	}

	return &anthropicRequest{
		Model:       p.model,
		MaxTokens:   maxTokens,
		Messages:    messages,
		System:      req.SystemPrompt,
		Tools:       tools,
		Thinking:    thinking,
		Temperature: req.Temperature,
		TopP:        req.TopP,
		Stream:      stream,
	}
}

func (p *AnthropicProvider) parseResponse(resp *anthropicResponse) *ChatResponse {
	var content strings.Builder
	var toolCalls []protocol.ToolUseBlock

	for _, block := range resp.Content {
		switch block.Type {
		case "text":
			content.WriteString(block.Text)
		case "tool_use":
			toolCalls = append(toolCalls, protocol.ToolUseBlock{
				ID:    block.ID,
				Name:  block.Name,
				Input: block.Input,
			})
		}
	}

	return &ChatResponse{
		ID:         resp.ID,
		Model:      resp.Model,
		Content:    content.String(),
		ToolCalls:  toolCalls,
		StopReason: resp.StopReason,
		Usage: Usage{
			InputTokens:         resp.Usage.InputTokens,
			OutputTokens:        resp.Usage.OutputTokens,
			CachedInputTokens:   resp.Usage.CacheReadInputTokens,
			CacheCreationTokens: resp.Usage.CacheCreationInputTokens,
		},
	}
}

// anthropicStreamEvent represents an SSE event
type anthropicStreamEvent struct {
	Type         string                 `json:"type"`
	Index        int                    `json:"index,omitempty"`
	Delta        json.RawMessage        `json:"delta,omitempty"`
	ContentBlock *anthropicContentBlock `json:"content_block,omitempty"`
	Message      *anthropicResponse     `json:"message,omitempty"`
	Usage        *struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	} `json:"usage,omitempty"`
}

func (p *AnthropicProvider) processStream(reader io.Reader, callback StreamCallback) error {
	scanner := bufio.NewScanner(reader)

	var currentToolUse *protocol.ToolUseBlock
	var inputBuffer strings.Builder

	for scanner.Scan() {
		line := scanner.Text()

		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}

		// Parse SSE data
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}

		var event anthropicStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}

		switch event.Type {
		case "message_start":
			if event.Message != nil {
				callback(&StreamChunk{
					Type: "usage",
					Usage: &Usage{
						InputTokens:         event.Message.Usage.InputTokens,
						OutputTokens:        event.Message.Usage.OutputTokens,
						CachedInputTokens:   event.Message.Usage.CacheReadInputTokens,
						CacheCreationTokens: event.Message.Usage.CacheCreationInputTokens,
					},
				})
			}
		case "content_block_start":
			if event.ContentBlock != nil && event.ContentBlock.Type == "tool_use" {
				currentToolUse = &protocol.ToolUseBlock{
					ID:   event.ContentBlock.ID,
					Name: event.ContentBlock.Name,
				}
				inputBuffer.Reset()
			}

		case "content_block_delta":
			var delta struct {
				Type        string `json:"type"`
				Text        string `json:"text,omitempty"`
				PartialJSON string `json:"partial_json,omitempty"`
			}
			if err := json.Unmarshal(event.Delta, &delta); err == nil {
				if delta.Type == "text_delta" && delta.Text != "" {
					callback(&StreamChunk{
						Type:  "content_block_delta",
						Delta: delta.Text,
					})
				} else if delta.Type == "input_json_delta" && delta.PartialJSON != "" {
					inputBuffer.WriteString(delta.PartialJSON)
				}
			}

		case "content_block_stop":
			if currentToolUse != nil {
				currentToolUse.Input = json.RawMessage(inputBuffer.String())
				callback(&StreamChunk{
					Type:    "tool_use",
					ToolUse: currentToolUse,
				})
				currentToolUse = nil
			}

		case "message_stop":
			callback(&StreamChunk{
				Type: "message_stop",
			})

		case "message_delta":
			var delta struct {
				StopReason string `json:"stop_reason"`
				Usage      *struct {
					OutputTokens int `json:"output_tokens"`
				} `json:"usage,omitempty"`
			}
			if err := json.Unmarshal(event.Delta, &delta); err == nil {
				if delta.Usage != nil {
					callback(&StreamChunk{
						Type: "usage",
						Usage: &Usage{
							OutputTokens: delta.Usage.OutputTokens,
						},
					})
				}
				if delta.StopReason != "" {
					callback(&StreamChunk{
						Type:       "message_delta",
						StopReason: delta.StopReason,
					})
				}
			}
		}
	}

	return scanner.Err()
}
