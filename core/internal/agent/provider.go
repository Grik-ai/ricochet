package agent

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// Provider represents an AI provider (Anthropic, OpenAI, OpenRouter)
type Provider interface {
	Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
	ChatStream(ctx context.Context, req *ChatRequest, callback StreamCallback) error
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Name() string
}

// StreamCallback is called for each streaming chunk
type StreamCallback func(chunk *StreamChunk) error

// ChatRequest represents a chat completion request
type ChatRequest struct {
	Model        string             `json:"model"`
	Messages     []protocol.Message `json:"messages"`
	MaxTokens    int                `json:"max_tokens,omitempty"`
	Temperature  float64            `json:"temperature,omitempty"`
	TopP         float64            `json:"top_p,omitempty"`
	Tools        []protocol.Tool    `json:"tools,omitempty"`
	SystemPrompt string             `json:"system,omitempty"`
}

// ChatResponse represents a chat completion response
type ChatResponse struct {
	ID         string                  `json:"id"`
	Model      string                  `json:"model"`
	Content    string                  `json:"content"`
	ToolCalls  []protocol.ToolUseBlock `json:"tool_calls,omitempty"`
	StopReason string                  `json:"stop_reason"`
	Usage      Usage                   `json:"usage"`
}

// Usage represents token usage
type Usage struct {
	InputTokens           int `json:"input_tokens"`
	OutputTokens          int `json:"output_tokens"`
	CachedInputTokens     int `json:"cached_input_tokens,omitempty"`
	CacheCreationTokens   int `json:"cache_creation_tokens,omitempty"`
	ReasoningOutputTokens int `json:"reasoning_output_tokens,omitempty"`
}

func mergeUsage(current, incoming Usage) Usage {
	if incoming.InputTokens > 0 {
		current.InputTokens = incoming.InputTokens
	}
	if incoming.OutputTokens > 0 {
		current.OutputTokens = incoming.OutputTokens
	}
	if incoming.CachedInputTokens > 0 {
		current.CachedInputTokens = incoming.CachedInputTokens
	}
	if incoming.CacheCreationTokens > 0 {
		current.CacheCreationTokens = incoming.CacheCreationTokens
	}
	if incoming.ReasoningOutputTokens > 0 {
		current.ReasoningOutputTokens = incoming.ReasoningOutputTokens
	}
	return current
}

// StreamChunk represents a streaming response chunk
type StreamChunk struct {
	Type           string                 `json:"type"` // content_block_delta, message_stop, etc.
	Delta          string                 `json:"delta,omitempty"`
	ReasoningDelta string                 `json:"reasoning_delta,omitempty"` // DeepSeek R1 reasoning
	ToolUse        *protocol.ToolUseBlock `json:"tool_use,omitempty"`
	StopReason     string                 `json:"stop_reason,omitempty"`
	Usage          *Usage                 `json:"usage,omitempty"`
}

// ProviderConfig holds provider configuration
type ProviderConfig struct {
	Provider         string  `json:"provider"` // anthropic, openai, openrouter
	APIKey           string  `json:"api_key"`
	Model            string  `json:"model"`
	BaseURL          string  `json:"base_url,omitempty"` // For custom endpoints
	Organization     string  `json:"organization,omitempty"`
	Project          string  `json:"project,omitempty"`
	Temperature      float64 `json:"temperature,omitempty"`
	TopP             float64 `json:"top_p,omitempty"`
	MaxTokens        int     `json:"max_tokens,omitempty"`
	AttemptTimeoutMs int     `json:"attempt_timeout_ms,omitempty"`
}

type providerNetworkObserverKey struct{}
type providerNetworkMetadataKey struct{}

type ProviderNetworkMetadata struct {
	Provider  string
	Model     string
	SessionID string
	RunID     string
}

type ProviderNetworkEvent struct {
	Type        string `json:"type"`
	Provider    string `json:"provider,omitempty"`
	Model       string `json:"model,omitempty"`
	SessionID   string `json:"session_id,omitempty"`
	RunID       string `json:"run_id,omitempty"`
	Method      string `json:"method,omitempty"`
	URL         string `json:"url,omitempty"`
	StatusCode  int    `json:"status_code,omitempty"`
	Attempt     int    `json:"attempt,omitempty"`
	MaxAttempts int    `json:"max_attempts,omitempty"`
	DelayMs     int64  `json:"delay_ms,omitempty"`
	LatencyMs   int64  `json:"latency_ms,omitempty"`
	Error       string `json:"error,omitempty"`
	Category    string `json:"category,omitempty"`
	Timestamp   int64  `json:"timestamp"`
}

func WithProviderNetworkObserver(ctx context.Context, observer func(ProviderNetworkEvent)) context.Context {
	return context.WithValue(ctx, providerNetworkObserverKey{}, observer)
}

func WithProviderNetworkMetadata(ctx context.Context, metadata ProviderNetworkMetadata) context.Context {
	return context.WithValue(ctx, providerNetworkMetadataKey{}, metadata)
}

func emitProviderNetworkEvent(ctx context.Context, event ProviderNetworkEvent) {
	observer, _ := ctx.Value(providerNetworkObserverKey{}).(func(ProviderNetworkEvent))
	if observer == nil {
		return
	}
	if metadata, ok := ctx.Value(providerNetworkMetadataKey{}).(ProviderNetworkMetadata); ok {
		if event.Provider == "" {
			event.Provider = metadata.Provider
		}
		if event.Model == "" {
			event.Model = metadata.Model
		}
		if event.SessionID == "" {
			event.SessionID = metadata.SessionID
		}
		if event.RunID == "" {
			event.RunID = metadata.RunID
		}
	}
	if event.Timestamp == 0 {
		event.Timestamp = time.Now().UnixMilli()
	}
	observer(event)
}

func (e ProviderNetworkEvent) Payload() map[string]interface{} {
	return map[string]interface{}{
		"type":         e.Type,
		"provider":     e.Provider,
		"model":        e.Model,
		"session_id":   e.SessionID,
		"run_id":       e.RunID,
		"method":       e.Method,
		"url":          e.URL,
		"status_code":  e.StatusCode,
		"attempt":      e.Attempt,
		"max_attempts": e.MaxAttempts,
		"delay_ms":     e.DelayMs,
		"latency_ms":   e.LatencyMs,
		"error":        e.Error,
		"category":     e.Category,
		"timestamp":    e.Timestamp,
	}
}

func providerNetworkCategoryFromError(ctx context.Context, err error) string {
	if err == nil {
		return ""
	}
	if isFatalNetworkError(ctx, err) {
		return "fatal"
	}
	if isRetryableNetworkError(err) {
		return "network"
	}
	return "unknown"
}

func providerNetworkCategoryFromStatus(statusCode int) string {
	switch {
	case statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden || statusCode == http.StatusBadRequest:
		return "config"
	case statusCode == http.StatusTooManyRequests:
		return "rate_limit"
	case statusCode >= 500:
		return "server"
	case statusCode >= 400:
		return "http"
	default:
		return "ok"
	}
}

// NewProvider creates a provider based on config
func NewProvider(cfg ProviderConfig) (Provider, error) {
	switch strings.ToLower(cfg.Provider) {
	case "anthropic":
		return NewAnthropicProvider(cfg.APIKey, cfg.Model), nil
	case "openai":
		if shouldUseOpenAIResponsesAPI(cfg.Model, cfg.BaseURL) {
			return NewOpenAIResponsesProvider(cfg.APIKey, cfg.Model, cfg.Organization, cfg.Project, cfg.AttemptTimeoutMs), nil
		}
		return NewOpenAIProvider(cfg.APIKey, cfg.Model, cfg.BaseURL, cfg.Organization, cfg.Project, cfg.AttemptTimeoutMs), nil
	case "openrouter":
		baseURL := "https://openrouter.ai/api/v1"
		if cfg.BaseURL != "" {
			baseURL = cfg.BaseURL
		}
		return NewOpenAIProvider(cfg.APIKey, cfg.Model, baseURL, "", "", cfg.AttemptTimeoutMs), nil // OpenRouter doesn't use standard Org/Project headers
	case "xai":
		return NewXAIProvider(cfg.APIKey, cfg.Model, cfg.AttemptTimeoutMs), nil
	case "gemini":
		return NewGeminiProvider(cfg.APIKey, cfg.Model), nil
	case "minimax":
		return NewMinimaxProvider(cfg.APIKey, cfg.Model, cfg.AttemptTimeoutMs), nil
	case "deepseek":
		baseURL := "https://api.deepseek.com"
		if cfg.BaseURL != "" {
			baseURL = cfg.BaseURL
		}
		return NewOpenAIProvider(cfg.APIKey, cfg.Model, baseURL, "", "", cfg.AttemptTimeoutMs), nil
	case "mistral":
		baseURL := "https://api.mistral.ai/v1"
		if cfg.BaseURL != "" {
			baseURL = cfg.BaseURL
		}
		return NewOpenAIProvider(cfg.APIKey, cfg.Model, baseURL, "", "", cfg.AttemptTimeoutMs), nil
	case "grik":
		baseURL := os.Getenv("GRIKAI_CODE_GATEWAY_URL")
		if baseURL == "" {
			baseURL = "https://grik.io/api/v1/ricochet/openai/v1"
		}
		if cfg.BaseURL != "" {
			baseURL = cfg.BaseURL
		}
		apiKey := cfg.APIKey
		if apiKey == "" {
			apiKey = os.Getenv("GRIKAI_ACCESS_TOKEN")
		}
		return NewOpenAIProvider(apiKey, cfg.Model, baseURL, "", "", cfg.AttemptTimeoutMs), nil
	case "zhipu", "glm":
		baseURL := "https://open.bigmodel.cn/api/paas/v4"
		if cfg.BaseURL != "" {
			baseURL = cfg.BaseURL
		}
		return NewOpenAIProvider(cfg.APIKey, cfg.Model, baseURL, "", "", cfg.AttemptTimeoutMs), nil
	case "zhipu-coding":
		baseURL := "https://open.bigmodel.cn/api/paas/v4" // Official bigmodel API uses same for coding
		if cfg.BaseURL != "" {
			baseURL = cfg.BaseURL
		}
		return NewOpenAIProvider(cfg.APIKey, cfg.Model, baseURL, "", "", cfg.AttemptTimeoutMs), nil
	default:
		return nil, fmt.Errorf("unknown provider: %s", cfg.Provider)
	}
}

// httpClient is a shared HTTP client for AI requests.
// Do not set Client.Timeout here: for SSE streaming it applies to the whole
// response body and can cancel long-running agent turns on unstable networks.
var httpClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   20 * time.Second,
		ResponseHeaderTimeout: 300 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 15 * time.Second,
		}).DialContext,
	},
}

func isRetryableNetworkError(err error) bool {
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	return strings.Contains(errStr, "timeout") ||
		strings.Contains(errStr, "temporary") ||
		strings.Contains(errStr, "connection reset") ||
		strings.Contains(errStr, "broken pipe") ||
		strings.Contains(errStr, "eof") ||
		strings.Contains(errStr, "no such host") ||
		strings.Contains(errStr, "server misbehaving") ||
		strings.Contains(errStr, "i/o timeout") ||
		strings.Contains(errStr, "can't assign requested address") ||
		strings.Contains(errStr, "cannot assign requested address") ||
		strings.Contains(errStr, "network is unreachable")
}

func isFatalNetworkError(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return true
	}
	if err == nil {
		return false
	}
	errStr := strings.ToLower(err.Error())
	return strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "certificate") ||
		strings.Contains(errStr, "x509")
}

// doRequest performs an HTTP request and returns the response with retry logic for network errors.
// It does NOT handle 429 (Rate Limit) errors here - those should be handled by provider-specific logic
// to allow for custom backoff strategies.
func doRequest(ctx context.Context, method, url string, headers map[string]string, body io.Reader) (*http.Response, error) {
	resp, cancel, err := DoRequestWithTimeout(ctx, method, url, headers, body, 0)
	if err != nil {
		return nil, err
	}
	if cancel != nil {
		// For non-streaming requests in the generic helper, we can't easily defer,
		// but since it's success and no timeout (passed 0), it's safe to return.
		// Actually, to be safe against leaks if we ever pass a timeout to doRequest:
		// we should probably not cancel here if body is still being read.
	}
	_ = cancel // Handled by caller/leak accepted for generic helper success
	return resp, nil
}

// DoRequestWithTimeout performs an HTTP request with an optional per-attempt timeout.
// It returns the response, a cancel function (which MUST be called by the caller), and any error.
func DoRequestWithTimeout(ctx context.Context, method, url string, headers map[string]string, body io.Reader, perAttemptTimeout time.Duration) (*http.Response, context.CancelFunc, error) {
	// Read body into buffer for retries
	var bodyBytes []byte
	var err error
	if body != nil {
		bodyBytes, err = io.ReadAll(body)
		if err != nil {
			return nil, nil, err
		}
	}

	retryDelay := 500 * time.Millisecond
	maxRetries := 4
	maxAttempts := maxRetries + 1
	totalStarted := time.Now()

	emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
		Type:        string(EventProviderRequestStarted),
		Method:      method,
		URL:         url,
		Attempt:     1,
		MaxAttempts: maxAttempts,
	})

	for i := 0; i <= maxRetries; i++ {
		// Create a per-attempt context if timeout specified
		attemptCtx := ctx
		var cancel context.CancelFunc
		if perAttemptTimeout > 0 {
			attemptCtx, cancel = context.WithTimeout(ctx, perAttemptTimeout)
		}

		// Re-create reader
		var reader io.Reader
		if bodyBytes != nil {
			reader = bytes.NewReader(bodyBytes)
		}

		req, err := http.NewRequestWithContext(attemptCtx, method, url, reader)
		if err != nil {
			if cancel != nil {
				cancel()
			}
			return nil, nil, err
		}

		for k, v := range headers {
			req.Header.Set(k, v)
		}

		attemptStarted := time.Now()
		resp, err := httpClient.Do(req)
		if err != nil {
			if cancel != nil {
				cancel()
			}

			if i < maxRetries && !isFatalNetworkError(ctx, err) && isRetryableNetworkError(err) {
				log.Printf("[Network] Attempt %d failed: %v. Retrying in %v...", i+1, err, retryDelay)
				emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
					Type:        string(EventProviderRequestRetrying),
					Method:      method,
					URL:         url,
					Attempt:     i + 1,
					MaxAttempts: maxAttempts,
					DelayMs:     retryDelay.Milliseconds(),
					LatencyMs:   time.Since(attemptStarted).Milliseconds(),
					Error:       err.Error(),
					Category:    providerNetworkCategoryFromError(ctx, err),
				})
				select {
				case <-time.After(retryDelay):
					retryDelay *= 2
					continue
				case <-ctx.Done():
					emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
						Type:        string(EventProviderRequestFailed),
						Method:      method,
						URL:         url,
						Attempt:     i + 1,
						MaxAttempts: maxAttempts,
						LatencyMs:   time.Since(totalStarted).Milliseconds(),
						Error:       ctx.Err().Error(),
						Category:    "cancelled",
					})
					return nil, nil, ctx.Err()
				}
			}
			emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
				Type:        string(EventProviderRequestFailed),
				Method:      method,
				URL:         url,
				Attempt:     i + 1,
				MaxAttempts: maxAttempts,
				LatencyMs:   time.Since(totalStarted).Milliseconds(),
				Error:       err.Error(),
				Category:    providerNetworkCategoryFromError(ctx, err),
			})
			return nil, nil, err
		}

		// If successful, we don't cancel yet because the caller might need the body (especially for streaming).
		// We rely on the parent ctx or the body being closed to stay clean.
		// Actually, we should return the cancel function so the caller can clean up.
		// For now, let's just NOT cancel on success here and accept the minor leak until func returns,
		// OR better: use a different approach.

		// Check for 5xx errors (server-side issues)
		if resp.StatusCode >= 500 && i < maxRetries {
			log.Printf("[Network] API returned %d. Retrying in %v...", resp.StatusCode, retryDelay)
			emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
				Type:        string(EventProviderRequestRetrying),
				Method:      method,
				URL:         url,
				StatusCode:  resp.StatusCode,
				Attempt:     i + 1,
				MaxAttempts: maxAttempts,
				DelayMs:     retryDelay.Milliseconds(),
				LatencyMs:   time.Since(attemptStarted).Milliseconds(),
				Error:       fmt.Sprintf("provider returned HTTP %d", resp.StatusCode),
				Category:    "server",
			})
			if cancel != nil {
				cancel()
			}
			resp.Body.Close()
			select {
			case <-time.After(retryDelay):
				retryDelay *= 2
				continue
			case <-ctx.Done():
				emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
					Type:        string(EventProviderRequestFailed),
					Method:      method,
					URL:         url,
					Attempt:     i + 1,
					MaxAttempts: maxAttempts,
					LatencyMs:   time.Since(totalStarted).Milliseconds(),
					Error:       ctx.Err().Error(),
					Category:    "cancelled",
				})
				return nil, nil, ctx.Err()
			}
		}

		if resp.StatusCode >= 400 {
			emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
				Type:        string(EventProviderRequestFailed),
				Method:      method,
				URL:         url,
				StatusCode:  resp.StatusCode,
				Attempt:     i + 1,
				MaxAttempts: maxAttempts,
				LatencyMs:   time.Since(totalStarted).Milliseconds(),
				Error:       fmt.Sprintf("provider returned HTTP %d", resp.StatusCode),
				Category:    providerNetworkCategoryFromStatus(resp.StatusCode),
			})
			return resp, cancel, nil
		}

		// On success, we return the cancel function. The caller MUST call it when
		// they are done with the response body.
		emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
			Type:        string(EventProviderRequestSucceeded),
			Method:      method,
			URL:         url,
			StatusCode:  resp.StatusCode,
			Attempt:     i + 1,
			MaxAttempts: maxAttempts,
			LatencyMs:   time.Since(totalStarted).Milliseconds(),
			Category:    "ok",
		})
		return resp, cancel, nil
	}

	emitProviderNetworkEvent(ctx, ProviderNetworkEvent{
		Type:        string(EventProviderRequestFailed),
		Method:      method,
		URL:         url,
		MaxAttempts: maxAttempts,
		LatencyMs:   time.Since(totalStarted).Milliseconds(),
		Error:       "max retries exceeded",
		Category:    "network",
	})
	return nil, nil, fmt.Errorf("max retries exceeded")
}
