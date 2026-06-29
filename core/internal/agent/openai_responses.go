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
	"time"

	"github.com/google/uuid"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

const defaultOpenAIResponsesURL = "https://api.openai.com/v1/responses"

type OpenAIResponsesProvider struct {
	apiKey         string
	model          string
	organization   string
	project        string
	attemptTimeout time.Duration
}

func shouldUseOpenAIResponsesAPI(model, baseURL string) bool {
	if strings.TrimSpace(baseURL) != "" && !strings.Contains(baseURL, "api.openai.com") {
		return false
	}
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(model, "gpt-5.5") || strings.HasPrefix(model, "gpt-5.4")
}

func NewOpenAIResponsesProvider(apiKey, model, organization, project string, timeoutMs int) *OpenAIResponsesProvider {
	if model == "" {
		model = "gpt-5.5"
	}
	timeout := time.Duration(timeoutMs) * time.Millisecond
	if timeout == 0 {
		timeout = defaultRequestTimeout
	} else if timeout < minRequestTimeout {
		timeout = minRequestTimeout
	}
	return &OpenAIResponsesProvider{
		apiKey:         apiKey,
		model:          model,
		organization:   organization,
		project:        project,
		attemptTimeout: timeout,
	}
}

func (p *OpenAIResponsesProvider) Name() string {
	return "openai"
}

type responsesRequest struct {
	Model           string               `json:"model"`
	Instructions    string               `json:"instructions,omitempty"`
	Input           []responsesInputItem `json:"input"`
	MaxOutputTokens int                  `json:"max_output_tokens,omitempty"`
	Temperature     float64              `json:"temperature,omitempty"`
	TopP            float64              `json:"top_p,omitempty"`
	Tools           []responsesTool      `json:"tools,omitempty"`
	ToolChoice      string               `json:"tool_choice,omitempty"`
	Stream          bool                 `json:"stream,omitempty"`
	Store           *bool                `json:"store,omitempty"`
}

type responsesInputItem struct {
	Type      string `json:"type,omitempty"`
	Role      string `json:"role,omitempty"`
	Content   any    `json:"content,omitempty"`
	CallID    string `json:"call_id,omitempty"`
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
	Output    string `json:"output,omitempty"`
	Status    string `json:"status,omitempty"`
}

type responsesTool struct {
	Type        string                 `json:"type"`
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
}

type responsesResponse struct {
	ID         string                `json:"id"`
	Model      string                `json:"model"`
	Status     string                `json:"status"`
	OutputText string                `json:"output_text,omitempty"`
	Output     []responsesOutputItem `json:"output"`
	Usage      responsesUsage        `json:"usage"`
	Error      *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type responsesOutputItem struct {
	Type      string                 `json:"type"`
	ID        string                 `json:"id"`
	Role      string                 `json:"role,omitempty"`
	Status    string                 `json:"status,omitempty"`
	Content   []responsesContentPart `json:"content,omitempty"`
	CallID    string                 `json:"call_id,omitempty"`
	Name      string                 `json:"name,omitempty"`
	Arguments string                 `json:"arguments,omitempty"`
}

type responsesContentPart struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type responsesUsage struct {
	InputTokens        int `json:"input_tokens"`
	OutputTokens       int `json:"output_tokens"`
	InputTokensDetails struct {
		CachedTokens int `json:"cached_tokens,omitempty"`
	} `json:"input_tokens_details,omitempty"`
	OutputTokensDetails struct {
		ReasoningTokens int `json:"reasoning_tokens,omitempty"`
	} `json:"output_tokens_details,omitempty"`
}

func (p *OpenAIResponsesProvider) Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	body, err := json.Marshal(p.buildRequest(req, false))
	if err != nil {
		return nil, fmt.Errorf("marshal responses request: %w", err)
	}

	headers := p.headers()
	headers["X-Client-Request-Id"] = uuid.New().String()
	resp, cancel, err := DoRequestWithTimeout(ctx, http.MethodPost, defaultOpenAIResponsesURL, headers, bytes.NewReader(body), p.attemptTimeout)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	if cancel != nil {
		defer cancel()
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}

	var decoded responsesResponse
	if err := json.Unmarshal(respBody, &decoded); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	if decoded.Error != nil {
		return nil, fmt.Errorf("API error: %s", decoded.Error.Message)
	}
	return parseResponsesResponse(&decoded), nil
}

func (p *OpenAIResponsesProvider) ChatStream(ctx context.Context, req *ChatRequest, callback StreamCallback) error {
	body, err := json.Marshal(p.buildRequest(req, true))
	if err != nil {
		return fmt.Errorf("marshal responses request: %w", err)
	}

	headers := p.headers()
	headers["X-Client-Request-Id"] = uuid.New().String()
	resp, cancel, err := DoRequestWithTimeout(ctx, http.MethodPost, defaultOpenAIResponsesURL, headers, bytes.NewReader(body), 0)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	if cancel != nil {
		defer cancel()
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}
	return p.processStream(resp.Body, callback)
}

func (p *OpenAIResponsesProvider) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	return NewOpenAIProvider(p.apiKey, p.model, "", p.organization, p.project, int(p.attemptTimeout/time.Millisecond)).Embed(ctx, texts)
}

func (p *OpenAIResponsesProvider) headers() map[string]string {
	headers := map[string]string{
		"Content-Type": "application/json",
	}
	if p.apiKey != "" {
		headers["Authorization"] = "Bearer " + p.apiKey
	}
	if p.organization != "" {
		headers["OpenAI-Organization"] = p.organization
	}
	if p.project != "" {
		headers["OpenAI-Project"] = p.project
	}
	return headers
}

func (p *OpenAIResponsesProvider) buildRequest(req *ChatRequest, stream bool) *responsesRequest {
	input := make([]responsesInputItem, 0, len(req.Messages))
	for _, msg := range req.Messages {
		if msg.Role == "system" {
			continue
		}
		if len(msg.ToolResults) > 0 {
			for _, tr := range msg.ToolResults {
				input = append(input, responsesInputItem{
					Type:   "function_call_output",
					CallID: tr.ToolUseID,
					Output: tr.Content,
				})
			}
			continue
		}
		if len(msg.ToolUse) > 0 {
			if strings.TrimSpace(msg.Content) != "" {
				input = append(input, responsesInputItem{Role: msg.Role, Content: msg.Content})
			}
			for _, tu := range msg.ToolUse {
				input = append(input, responsesInputItem{
					Type:      "function_call",
					CallID:    tu.ID,
					Name:      tu.Name,
					Arguments: string(tu.Input),
					Status:    "completed",
				})
			}
			continue
		}
		input = append(input, responsesInputItem{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}

	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = 4096
	}

	tools := make([]responsesTool, 0, len(req.Tools))
	for _, t := range req.Tools {
		tools = append(tools, responsesTool{
			Type:        "function",
			Name:        t.Name,
			Description: t.Description,
			Parameters:  t.InputSchema,
		})
	}

	store := false
	request := &responsesRequest{
		Model:           p.model,
		Instructions:    req.SystemPrompt,
		Input:           input,
		MaxOutputTokens: maxTokens,
		Temperature:     req.Temperature,
		TopP:            req.TopP,
		Tools:           tools,
		Stream:          stream,
		Store:           &store,
	}
	if len(tools) > 0 {
		request.ToolChoice = "auto"
	}
	return request
}

func parseResponsesResponse(resp *responsesResponse) *ChatResponse {
	var content strings.Builder
	var toolCalls []protocol.ToolUseBlock

	if resp.OutputText != "" {
		content.WriteString(resp.OutputText)
	}
	for _, item := range resp.Output {
		switch item.Type {
		case "message":
			for _, part := range item.Content {
				if part.Type == "output_text" {
					content.WriteString(part.Text)
				}
			}
		case "function_call":
			toolCalls = append(toolCalls, protocol.ToolUseBlock{
				ID:    firstNonEmptyString(item.CallID, item.ID),
				Name:  item.Name,
				Input: json.RawMessage(item.Arguments),
			})
		}
	}

	return &ChatResponse{
		ID:         resp.ID,
		Model:      resp.Model,
		Content:    content.String(),
		ToolCalls:  toolCalls,
		StopReason: resp.Status,
		Usage: Usage{
			InputTokens:           resp.Usage.InputTokens,
			OutputTokens:          resp.Usage.OutputTokens,
			CachedInputTokens:     resp.Usage.InputTokensDetails.CachedTokens,
			ReasoningOutputTokens: resp.Usage.OutputTokensDetails.ReasoningTokens,
		},
	}
}

type responsesStreamEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta,omitempty"`
	Text  string `json:"text,omitempty"`
	Item  *struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		CallID    string `json:"call_id,omitempty"`
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
		Status    string `json:"status,omitempty"`
	} `json:"item,omitempty"`
	Response *responsesResponse `json:"response,omitempty"`
}

func (p *OpenAIResponsesProvider) processStream(reader io.Reader, callback StreamCallback) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || strings.HasPrefix(line, ":") || strings.HasPrefix(line, "event: ") {
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}
		var event responsesStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		switch event.Type {
		case "response.output_text.delta":
			if event.Delta != "" {
				if err := callback(&StreamChunk{Type: "content_block_delta", Delta: event.Delta}); err != nil {
					return err
				}
			}
		case "response.output_item.done":
			if event.Item != nil && event.Item.Type == "function_call" {
				if err := callback(&StreamChunk{
					Type: "tool_use",
					ToolUse: &protocol.ToolUseBlock{
						ID:    firstNonEmptyString(event.Item.CallID, event.Item.ID),
						Name:  event.Item.Name,
						Input: json.RawMessage(event.Item.Arguments),
					},
				}); err != nil {
					return err
				}
			}
		case "response.completed":
			if event.Response != nil {
				if err := callback(&StreamChunk{
					Type: "usage",
					Usage: &Usage{
						InputTokens:           event.Response.Usage.InputTokens,
						OutputTokens:          event.Response.Usage.OutputTokens,
						CachedInputTokens:     event.Response.Usage.InputTokensDetails.CachedTokens,
						ReasoningOutputTokens: event.Response.Usage.OutputTokensDetails.ReasoningTokens,
					},
				}); err != nil {
					return err
				}
			}
			if err := callback(&StreamChunk{Type: "message_stop"}); err != nil {
				return err
			}
		case "response.failed", "response.incomplete":
			if event.Response != nil && event.Response.Error != nil {
				return fmt.Errorf("OpenAI Responses error: %s", event.Response.Error.Message)
			}
		}
	}
	return scanner.Err()
}
