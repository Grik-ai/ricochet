package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

const defaultOpenAIURL = "https://api.openai.com/v1/chat/completions"
const defaultRequestTimeout = 120 * time.Second
const minRequestTimeout = 30 * time.Second

// OpenAIProvider implements Provider for OpenAI and compatible APIs (OpenRouter)
type OpenAIProvider struct {
	apiKey         string
	model          string
	baseURL        string
	organization   string
	project        string
	attemptTimeout time.Duration
}

// NewOpenAIProvider creates a new OpenAI-compatible provider
func NewOpenAIProvider(apiKey, model, baseURL, organization, project string, timeoutMs int) *OpenAIProvider {
	if model == "" {
		model = "gpt-4o"
	}
	if baseURL == "" {
		baseURL = defaultOpenAIURL
	} else {
		// Ensure the URL ends with /chat/completions
		if !strings.HasSuffix(baseURL, "/chat/completions") {
			baseURL = strings.TrimSuffix(baseURL, "/") + "/chat/completions"
		}
	}

	timeout := time.Duration(timeoutMs) * time.Millisecond
	if timeout == 0 {
		timeout = defaultRequestTimeout
	} else if timeout < minRequestTimeout {
		timeout = minRequestTimeout
	}

	return &OpenAIProvider{
		apiKey:         apiKey,
		model:          model,
		baseURL:        baseURL,
		organization:   organization,
		project:        project,
		attemptTimeout: timeout,
	}
}

func (p *OpenAIProvider) Name() string {
	baseURL := strings.ToLower(p.baseURL)
	switch {
	case strings.Contains(baseURL, "openrouter"):
		return "openrouter"
	case strings.Contains(baseURL, "deepseek"):
		return "deepseek"
	case strings.Contains(baseURL, "mistral"):
		return "mistral"
	case strings.Contains(baseURL, "bigmodel") || strings.Contains(baseURL, "z.ai"):
		return "zhipu"
	case strings.Contains(baseURL, "minimaxi") || strings.Contains(baseURL, "minimax"):
		return "minimax"
	case strings.Contains(baseURL, "generativelanguage"):
		return "gemini"
	case strings.Contains(baseURL, "api.x.ai"):
		return "xai"
	}
	return "openai"
}

// openaiRequest is the OpenAI API request format
type openaiRequest struct {
	Model         string               `json:"model"`
	Messages      []openaiMessage      `json:"messages"`
	MaxTokens     int                  `json:"max_tokens,omitempty"`
	Temperature   float64              `json:"temperature,omitempty"`
	TopP          float64              `json:"top_p,omitempty"`
	Tools         []openaiTool         `json:"tools,omitempty"`
	Stream        bool                 `json:"stream,omitempty"`
	StreamOptions *openaiStreamOptions `json:"stream_options,omitempty"`
}

type openaiStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type openaiMessage struct {
	Role             string           `json:"role"`
	Content          string           `json:"content"`
	ReasoningContent string           `json:"reasoning_content,omitempty"` // DeepSeek R1
	ToolCalls        []openaiToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string           `json:"tool_call_id,omitempty"`
}

type openaiToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openaiTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string                 `json:"name"`
		Description string                 `json:"description"`
		Parameters  map[string]interface{} `json:"parameters"`
	} `json:"function"`
}

// openaiResponse is the OpenAI API response format
type openaiResponse struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int           `json:"index"`
		Message      openaiMessage `json:"message"`
		FinishReason string        `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens            int `json:"prompt_tokens"`
		CompletionTokens        int `json:"completion_tokens"`
		TotalTokens             int `json:"total_tokens"`
		PromptCacheHitTokens    int `json:"prompt_cache_hit_tokens,omitempty"`
		PromptCacheMissTokens   int `json:"prompt_cache_miss_tokens,omitempty"`
		ReasoningTokens         int `json:"reasoning_tokens,omitempty"`
		CompletionTokensDetails struct {
			ReasoningTokens int `json:"reasoning_tokens,omitempty"`
		} `json:"completion_tokens_details,omitempty"`
		PromptTokensDetails struct {
			CachedTokens int `json:"cached_tokens,omitempty"`
		} `json:"prompt_tokens_details,omitempty"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error,omitempty"`
}

// Chat performs a non-streaming chat completion
func (p *OpenAIProvider) Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	openaiReq := p.buildRequest(req, false)

	body, err := json.Marshal(openaiReq)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	requestID := uuid.New().String()
	headers := p.headers()
	headers["X-Client-Request-Id"] = requestID

	var resp *http.Response
	var cancel context.CancelFunc // Defined here for usage inside retry loop
	maxRetries := 5
	maxRateLimitRetries := 1
	rateLimitRetries := 0
	backoff := 1 * time.Second

	for i := 0; i <= maxRetries; i++ {
		// Use a stable per-attempt timeout. Very low provider defaults can make
		// transient DNS/TLS/header delays look like hard model failures.
		resp, cancel, err = DoRequestWithTimeout(ctx, "POST", p.baseURL, headers, bytes.NewReader(body), p.attemptTimeout)
		if err != nil {
			if i < maxRetries && ctx.Err() == nil {
				log.Printf("[OpenAI] Attempt %d failed: %v. Retrying with backoff...", i+1, err)
				select {
				case <-time.After(backoff):
					backoff *= 2
					continue
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			return nil, fmt.Errorf("request failed: %w", err)
		}

		if resp.StatusCode == 429 && i < maxRetries && rateLimitRetries < maxRateLimitRetries {
			if cancel != nil {
				cancel()
			}
			resp.Body.Close()
			rateLimitRetries++
			actualBackoff := rateLimitBackoff(resp, backoff)
			log.Printf("[OpenAI] Rate limit reached (429). Retrying in %v... (Attempt %d/%d)", actualBackoff, i+1, maxRetries)
			select {
			case <-time.After(actualBackoff):
				backoff *= 2
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		break
	}
	if cancel != nil {
		defer cancel()
	}
	defer resp.Body.Close()

	// Log debugging info
	log.Printf("[OpenAI] Request %s: Status %d, X-Request-Id: %s", requestID, resp.StatusCode, resp.Header.Get("X-Request-Id"))

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}

	var openaiResp openaiResponse
	if err := json.Unmarshal(respBody, &openaiResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if openaiResp.Error != nil {
		return nil, fmt.Errorf("API error: %s", openaiResp.Error.Message)
	}

	return p.parseResponse(&openaiResp), nil
}

type openaiEmbedRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type openaiEmbedResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

func (p *OpenAIProvider) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	embedURL := strings.Replace(p.baseURL, "/chat/completions", "/embeddings", 1)

	req := openaiEmbedRequest{
		Model: "text-embedding-3-small", // Default embedding model
		Input: texts,
	}

	body, _ := json.Marshal(req)
	resp, err := doRequest(ctx, "POST", embedURL, p.headers(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("OpenAI Embed error %d: %s", resp.StatusCode, string(respBody))
	}

	var embedResp openaiEmbedResponse
	if err := json.NewDecoder(resp.Body).Decode(&embedResp); err != nil {
		return nil, err
	}

	result := make([][]float32, len(embedResp.Data))
	for i, d := range embedResp.Data {
		result[i] = d.Embedding
	}
	return result, nil
}

// ChatStream performs a streaming chat completion
func (p *OpenAIProvider) ChatStream(ctx context.Context, req *ChatRequest, callback StreamCallback) error {
	openaiReq := p.buildRequest(req, true)

	body, err := json.Marshal(openaiReq)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	requestID := uuid.New().String()
	headers := p.headers()
	headers["X-Client-Request-Id"] = requestID

	var resp *http.Response
	var cancel context.CancelFunc
	maxRetries := 4
	maxRateLimitRetries := 1
	rateLimitRetries := 0
	backoff := 1 * time.Second

	for i := 0; i <= maxRetries; i++ {
		// Do not put a whole-response timeout on SSE streams. The shared
		// transport still limits DNS/TLS/header phases, while the body can stay
		// open for long-running agent turns.
		resp, cancel, err = DoRequestWithTimeout(ctx, "POST", p.baseURL, headers, bytes.NewReader(body), 0)
		if err != nil {
			if i < maxRetries && !isFatalNetworkError(ctx, err) && isRetryableNetworkError(err) {
				log.Printf("[OpenAI] Stream attempt %d failed: %v. Retrying...", i+1, err)
				select {
				case <-time.After(backoff):
					backoff *= 2
					continue
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return fmt.Errorf("request failed: %w", err)
		}

		if resp.StatusCode == 429 && i < maxRetries && rateLimitRetries < maxRateLimitRetries {
			if cancel != nil {
				cancel()
			}
			resp.Body.Close()
			rateLimitRetries++
			actualBackoff := rateLimitBackoff(resp, backoff)
			log.Printf("[OpenAI] Stream Rate limit reached (429). Retrying in %v... (Attempt %d/%d)", actualBackoff, i+1, maxRetries)
			select {
			case <-time.After(actualBackoff):
				backoff *= 2
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		break
	}
	if cancel != nil {
		defer cancel()
	}
	defer resp.Body.Close()

	// Log debugging info
	log.Printf("[OpenAI] Stream Request %s: Status %d, X-Request-Id: %s", requestID, resp.StatusCode, resp.Header.Get("X-Request-Id"))

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}

	if err := p.processStream(resp.Body, callback); err != nil {
		if isRetryableNetworkError(err) {
			return fmt.Errorf("stream interrupted by network instability: %w", err)
		}
		return err
	}
	return nil
}

func rateLimitBackoff(resp *http.Response, fallback time.Duration) time.Duration {
	if resp != nil {
		if retryAfter := strings.TrimSpace(resp.Header.Get("Retry-After")); retryAfter != "" {
			if seconds, err := strconv.Atoi(retryAfter); err == nil && seconds >= 0 {
				d := time.Duration(seconds) * time.Second
				if d > 0 && d <= 5*time.Second {
					return d
				}
			}
		}
	}

	jitter := time.Duration(time.Now().UnixNano()%500) * time.Millisecond
	d := fallback + jitter
	if d > 3*time.Second {
		return 3 * time.Second
	}
	return d
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (p *OpenAIProvider) headers() map[string]string {
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

	// Zhipu/GLM recommended header
	if strings.Contains(p.baseURL, "z.ai") || strings.Contains(p.baseURL, "bigmodel") {
		headers["Accept-Language"] = "en-US,en"
	}

	// OpenRouter specific headers
	if strings.Contains(p.baseURL, "openrouter") {
		headers["HTTP-Referer"] = "https://ricochet.dev"
		headers["X-Title"] = "Ricochet"
	}

	// Masked key logging for debugging
	maskedKey := p.apiKey
	if len(maskedKey) > 10 {
		maskedKey = maskedKey[:4] + "..." + maskedKey[len(maskedKey)-4:]
	}
	log.Printf("[OpenAI] Using API key: %s (Provider: %s)", maskedKey, p.Name())

	return headers
}

func (p *OpenAIProvider) buildRequest(req *ChatRequest, stream bool) *openaiRequest {
	messages := make([]openaiMessage, 0, len(req.Messages)+1)

	// Add system message if present
	if req.SystemPrompt != "" {
		messages = append(messages, openaiMessage{
			Role:    "system",
			Content: req.SystemPrompt,
		})
	}

	for _, msg := range req.Messages {
		// Handle tool results
		if len(msg.ToolResults) > 0 {
			for _, tr := range msg.ToolResults {
				messages = append(messages, openaiMessage{
					Role:       "tool",
					Content:    tr.Content,
					ToolCallID: tr.ToolUseID,
				})
			}
			continue
		}

		// Handle tool calls from assistant
		if len(msg.ToolUse) > 0 {
			toolCalls := make([]openaiToolCall, 0, len(msg.ToolUse))
			for _, tu := range msg.ToolUse {
				toolCalls = append(toolCalls, openaiToolCall{
					ID:   tu.ID,
					Type: "function",
					Function: struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					}{
						Name:      tu.Name,
						Arguments: string(tu.Input),
					},
				})
			}
			messages = append(messages, openaiMessage{
				Role:             msg.Role,
				Content:          msg.Content,
				ReasoningContent: msg.ReasoningContent, // DeepSeek R1 requires this for tool calls
				ToolCalls:        toolCalls,
			})
			continue
		}

		// Simple message
		messages = append(messages, openaiMessage{
			Role:    msg.Role,
			Content: msg.Content,
		})
	}

	maxTokens := req.MaxTokens
	if maxTokens == 0 {
		maxTokens = 4096
	}

	tools := make([]openaiTool, 0, len(req.Tools))
	for _, t := range req.Tools {
		tools = append(tools, openaiTool{
			Type: "function",
			Function: struct {
				Name        string                 `json:"name"`
				Description string                 `json:"description"`
				Parameters  map[string]interface{} `json:"parameters"`
			}{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.InputSchema,
			},
		})
	}

	var streamOptions *openaiStreamOptions
	if stream {
		switch p.Name() {
		case "openai", "openrouter", "deepseek", "xai", "minimax", "gemini":
			streamOptions = &openaiStreamOptions{IncludeUsage: true}
		}
	}

	return &openaiRequest{
		Model:         p.model,
		Messages:      messages,
		MaxTokens:     maxTokens,
		Temperature:   req.Temperature,
		TopP:          req.TopP,
		Tools:         tools,
		Stream:        stream,
		StreamOptions: streamOptions,
	}
}

func (p *OpenAIProvider) parseResponse(resp *openaiResponse) *ChatResponse {
	if len(resp.Choices) == 0 {
		return &ChatResponse{
			ID:    resp.ID,
			Model: resp.Model,
		}
	}

	choice := resp.Choices[0]

	var toolCalls []protocol.ToolUseBlock
	for _, tc := range choice.Message.ToolCalls {
		toolCalls = append(toolCalls, protocol.ToolUseBlock{
			ID:    tc.ID,
			Name:  tc.Function.Name,
			Input: json.RawMessage(tc.Function.Arguments),
		})
	}

	return &ChatResponse{
		ID:         resp.ID,
		Model:      resp.Model,
		Content:    choice.Message.Content,
		ToolCalls:  toolCalls,
		StopReason: choice.FinishReason,
		Usage: Usage{
			InputTokens:           resp.Usage.PromptTokens,
			OutputTokens:          resp.Usage.CompletionTokens,
			CachedInputTokens:     maxInt(resp.Usage.PromptTokensDetails.CachedTokens, resp.Usage.PromptCacheHitTokens),
			ReasoningOutputTokens: maxInt(resp.Usage.CompletionTokensDetails.ReasoningTokens, resp.Usage.ReasoningTokens),
		},
	}
}

// openaiStreamChunk is a streaming response chunk
type openaiStreamChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role             string                 `json:"role,omitempty"`
			Content          string                 `json:"content,omitempty"`
			ReasoningContent string                 `json:"reasoning_content,omitempty"`
			ToolCalls        []openaiStreamToolCall `json:"tool_calls,omitempty"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens            int `json:"prompt_tokens"`
		CompletionTokens        int `json:"completion_tokens"`
		TotalTokens             int `json:"total_tokens"`
		PromptCacheHitTokens    int `json:"prompt_cache_hit_tokens,omitempty"`
		PromptCacheMissTokens   int `json:"prompt_cache_miss_tokens,omitempty"`
		ReasoningTokens         int `json:"reasoning_tokens,omitempty"`
		CompletionTokensDetails struct {
			ReasoningTokens int `json:"reasoning_tokens,omitempty"`
		} `json:"completion_tokens_details,omitempty"`
		PromptTokensDetails struct {
			CachedTokens int `json:"cached_tokens,omitempty"`
		} `json:"prompt_tokens_details,omitempty"`
	} `json:"usage,omitempty"`
}

// openaiStreamToolCall is a tool call in a streaming response (includes Index)
type openaiStreamToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
	} `json:"function"`
}

func (p *OpenAIProvider) processStream(reader io.Reader, callback StreamCallback) error {
	scanner := bufio.NewScanner(reader)

	toolCallBuffers := make(map[int]*struct {
		id   string
		name string
		args strings.Builder
	})

	var inReasoning bool

	for scanner.Scan() {
		line := scanner.Text()

		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}

		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			// Close reasoning if still open
			if inReasoning {
				if err := callback(&StreamChunk{
					Type:  "content_block_delta",
					Delta: "\n</thinking>\n\n",
				}); err != nil {
					return err
				}
				inReasoning = false
			}
			if err := callback(&StreamChunk{Type: "message_stop"}); err != nil {
				return err
			}
			break
		}

		var chunk openaiStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}

		if chunk.Usage != nil {
			if err := callback(&StreamChunk{
				Type: "usage",
				Usage: &Usage{
					InputTokens:           chunk.Usage.PromptTokens,
					OutputTokens:          chunk.Usage.CompletionTokens,
					CachedInputTokens:     maxInt(chunk.Usage.PromptTokensDetails.CachedTokens, chunk.Usage.PromptCacheHitTokens),
					ReasoningOutputTokens: maxInt(chunk.Usage.CompletionTokensDetails.ReasoningTokens, chunk.Usage.ReasoningTokens),
				},
			}); err != nil {
				return err
			}
		}

		if len(chunk.Choices) == 0 {
			continue
		}

		choice := chunk.Choices[0]

		// Handle reasoning delta (DeepSeek R1/V3)
		if choice.Delta.ReasoningContent != "" {
			if !inReasoning {
				log.Printf("[OpenAI] Starting reasoning block, first chunk: %q", choice.Delta.ReasoningContent[:min(50, len(choice.Delta.ReasoningContent))])
				if err := callback(&StreamChunk{
					Type:  "content_block_delta",
					Delta: "<thinking>\n",
				}); err != nil {
					return err
				}
				inReasoning = true
			}
			// Send both: Delta for UI display, ReasoningDelta for storage
			if err := callback(&StreamChunk{
				Type:           "content_block_delta",
				Delta:          choice.Delta.ReasoningContent,
				ReasoningDelta: choice.Delta.ReasoningContent,
			}); err != nil {
				return err
			}
		}

		// Handle content delta
		if choice.Delta.Content != "" {
			if inReasoning {
				if err := callback(&StreamChunk{
					Type:  "content_block_delta",
					Delta: "\n</thinking>\n\n",
				}); err != nil {
					return err
				}
				inReasoning = false
			}
			if err := callback(&StreamChunk{
				Type:  "content_block_delta",
				Delta: choice.Delta.Content,
			}); err != nil {
				return err
			}
		}

		// Handle tool calls
		for _, tc := range choice.Delta.ToolCalls {
			if inReasoning {
				if err := callback(&StreamChunk{
					Type:  "content_block_delta",
					Delta: "\n</thinking>\n\n",
				}); err != nil {
					return err
				}
				inReasoning = false
			}

			if _, ok := toolCallBuffers[tc.Index]; !ok {
				toolCallBuffers[tc.Index] = &struct {
					id   string
					name string
					args strings.Builder
				}{
					id:   tc.ID,
					name: tc.Function.Name,
				}
			}

			buf := toolCallBuffers[tc.Index]
			if tc.ID != "" {
				buf.id = tc.ID
			}
			if tc.Function.Name != "" {
				buf.name = tc.Function.Name
			}
			if tc.Function.Arguments != "" {
				buf.args.WriteString(tc.Function.Arguments)
			}
		}

		// Handle finish reason
		if choice.FinishReason != "" {
			if inReasoning {
				if err := callback(&StreamChunk{
					Type:  "content_block_delta",
					Delta: "\n</thinking>\n\n",
				}); err != nil {
					return err
				}
				inReasoning = false
			}

			// Emit any buffered tool calls
			for _, buf := range toolCallBuffers {
				if err := callback(&StreamChunk{
					Type: "tool_use",
					ToolUse: &protocol.ToolUseBlock{
						ID:    buf.id,
						Name:  buf.name,
						Input: json.RawMessage(buf.args.String()),
					},
				}); err != nil {
					return err
				}
			}

			if err := callback(&StreamChunk{
				Type:       "message_delta",
				StopReason: choice.FinishReason,
			}); err != nil {
				return err
			}
		}
	}

	return scanner.Err()
}
