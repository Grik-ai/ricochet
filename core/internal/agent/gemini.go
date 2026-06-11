package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// GeminiProvider implements Provider for Google Gemini API
type GeminiProvider struct {
	apiKey string
	model  string
}

// NewGeminiProvider creates a new Gemini provider
func NewGeminiProvider(apiKey, model string) Provider {
	return &GeminiProvider{
		apiKey: apiKey,
		model:  model,
	}
}

func (p *GeminiProvider) Name() string {
	return "gemini"
}

// Gemini API structures
type geminiRequest struct {
	Contents         []geminiContent         `json:"contents"`
	SystemInstrucion *geminiContent          `json:"systemInstruction,omitempty"`
	GenerationConfig *geminiGenerationConfig `json:"generationConfig,omitempty"`
	Tools            []geminiTool            `json:"tools,omitempty"`
}

type geminiContent struct {
	Role  string       `json:"role"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text         string                  `json:"text,omitempty"`
	FunctionCall *geminiFunctionCall     `json:"functionCall,omitempty"`
	FunctionResp *geminiFunctionResponse `json:"functionResponse,omitempty"`
}

type geminiFunctionCall struct {
	Name string                 `json:"name"`
	Args map[string]interface{} `json:"args"`
}

type geminiFunctionResponse struct {
	Name     string      `json:"name"`
	Response interface{} `json:"response"`
}

type geminiGenerationConfig struct {
	MaxOutputTokens int     `json:"maxOutputTokens,omitempty"`
	Temperature     float64 `json:"temperature,omitempty"`
}

type geminiTool struct {
	FunctionDeclarations []geminiFunctionDecl `json:"functionDeclarations,omitempty"`
}

type geminiFunctionDecl struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters,omitempty"`
}

type geminiResponse struct {
	Candidates    []geminiCandidate `json:"candidates"`
	UsageMetadata *geminiUsage      `json:"usageMetadata,omitempty"`
}

type geminiCandidate struct {
	Content      geminiContent `json:"content"`
	FinishReason string        `json:"finishReason,omitempty"`
}

type geminiUsage struct {
	PromptTokenCount     int `json:"promptTokenCount"`
	CandidatesTokenCount int `json:"candidatesTokenCount"`
	TotalTokenCount      int `json:"totalTokenCount"`
}

type geminiEmbedRequest struct {
	Content geminiContent `json:"content"`
	Model   string        `json:"model,omitempty"`
}

type geminiBatchEmbedRequest struct {
	Requests []geminiEmbedRequest `json:"requests"`
}

type geminiEmbedResponse struct {
	Embedding struct {
		Values []float32 `json:"values"`
	} `json:"embedding"`
}

type geminiBatchEmbedResponse struct {
	Embeddings []struct {
		Values []float32 `json:"values"`
	} `json:"embeddings"`
}

func (p *GeminiProvider) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	// For single text, use single embed endpoint
	if len(texts) == 1 {
		req := geminiEmbedRequest{
			Content: geminiContent{
				Parts: []geminiPart{{Text: texts[0]}},
			},
		}
		body, _ := json.Marshal(req)
		url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=%s", p.apiKey)

		resp, err := doRequest(ctx, "POST", url, map[string]string{"Content-Type": "application/json"}, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			body, _ := io.ReadAll(resp.Body)
			return nil, fmt.Errorf("gemini embed error %d: %s", resp.StatusCode, string(body))
		}

		var gemResp geminiEmbedResponse
		if err := json.NewDecoder(resp.Body).Decode(&gemResp); err != nil {
			return nil, err
		}
		return [][]float32{gemResp.Embedding.Values}, nil
	}

	// For multiple texts, use batchEmbedContents
	batchReq := geminiBatchEmbedRequest{}
	for _, t := range texts {
		batchReq.Requests = append(batchReq.Requests, geminiEmbedRequest{
			Model: "models/text-embedding-004",
			Content: geminiContent{
				Parts: []geminiPart{{Text: t}},
			},
		})
	}

	body, _ := json.Marshal(batchReq)
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=%s", p.apiKey)

	resp, err := doRequest(ctx, "POST", url, map[string]string{"Content-Type": "application/json"}, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("gemini batch embed error %d: %s", resp.StatusCode, string(body))
	}

	var gemResp geminiBatchEmbedResponse
	if err := json.NewDecoder(resp.Body).Decode(&gemResp); err != nil {
		return nil, err
	}

	result := make([][]float32, len(gemResp.Embeddings))
	for i, e := range gemResp.Embeddings {
		result[i] = e.Values
	}
	return result, nil
}

func (p *GeminiProvider) Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	// Use streaming internally and collect result
	var content strings.Builder
	var toolCalls []protocol.ToolUseBlock
	var usage Usage

	err := p.ChatStream(ctx, req, func(chunk *StreamChunk) error {
		if chunk.Usage != nil {
			usage = mergeUsage(usage, *chunk.Usage)
		}
		if chunk.Delta != "" {
			content.WriteString(chunk.Delta)
		}
		if chunk.ToolUse != nil {
			toolCalls = append(toolCalls, *chunk.ToolUse)
		}
		return nil
	})

	if err != nil {
		return nil, err
	}

	return &ChatResponse{
		Content:   content.String(),
		ToolCalls: toolCalls,
		Usage:     usage,
	}, nil
}

func (p *GeminiProvider) ChatStream(ctx context.Context, req *ChatRequest, callback StreamCallback) error {
	// Build Gemini request
	gemReq := geminiRequest{
		Contents: p.convertMessages(req.Messages),
		GenerationConfig: &geminiGenerationConfig{
			MaxOutputTokens: req.MaxTokens,
			Temperature:     req.Temperature,
		},
	}

	if req.SystemPrompt != "" {
		gemReq.SystemInstrucion = &geminiContent{
			Parts: []geminiPart{{Text: req.SystemPrompt}},
		}
	}

	// Convert tools
	if len(req.Tools) > 0 {
		gemReq.Tools = p.convertTools(req.Tools)
	}

	// Make request
	model := p.model
	if model == "" {
		model = "gemini-3-flash" // Default model
	}

	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?alt=sse&key=%s", model, p.apiKey)

	body, err := json.Marshal(gemReq)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	resp, err := doRequest(ctx, "POST", url, map[string]string{
		"Content-Type": "application/json",
	}, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("gemini request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("gemini error %d: %s", resp.StatusCode, string(body))
	}

	return p.processStream(resp.Body, callback)
}

func (p *GeminiProvider) processStream(reader io.Reader, callback StreamCallback) error {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")
		if data == "" {
			continue
		}

		var gemResp geminiResponse
		if err := json.Unmarshal([]byte(data), &gemResp); err != nil {
			continue
		}

		if gemResp.UsageMetadata != nil {
			if err := callback(&StreamChunk{
				Type: "usage",
				Usage: &Usage{
					InputTokens:  gemResp.UsageMetadata.PromptTokenCount,
					OutputTokens: gemResp.UsageMetadata.CandidatesTokenCount,
				},
			}); err != nil {
				return err
			}
		}

		for _, candidate := range gemResp.Candidates {
			for _, part := range candidate.Content.Parts {
				if part.Text != "" {
					if err := callback(&StreamChunk{
						Type:  "content_block_delta",
						Delta: part.Text,
					}); err != nil {
						return err
					}
				}

				if part.FunctionCall != nil {
					argsJSON, _ := json.Marshal(part.FunctionCall.Args)
					if err := callback(&StreamChunk{
						Type: "tool_use",
						ToolUse: &protocol.ToolUseBlock{
							ID:    fmt.Sprintf("call_%s", part.FunctionCall.Name),
							Name:  part.FunctionCall.Name,
							Input: argsJSON,
						},
					}); err != nil {
						return err
					}
				}
			}
		}
	}

	// Send stop
	callback(&StreamChunk{
		Type:       "message_stop",
		StopReason: "end_turn",
	})

	return scanner.Err()
}

func (p *GeminiProvider) convertMessages(msgs []protocol.Message) []geminiContent {
	var contents []geminiContent

	for _, msg := range msgs {
		role := "user"
		if msg.Role == "assistant" {
			role = "model"
		}

		var parts []geminiPart

		// Add text content
		if msg.Content != "" {
			parts = append(parts, geminiPart{Text: msg.Content})
		}

		// Add tool use blocks (for assistant messages)
		for _, toolUse := range msg.ToolUse {
			var args map[string]interface{}
			json.Unmarshal(toolUse.Input, &args)
			parts = append(parts, geminiPart{
				FunctionCall: &geminiFunctionCall{
					Name: toolUse.Name,
					Args: args,
				},
			})
		}

		// Add tool results (for user messages responding to tools)
		for _, result := range msg.ToolResults {
			// Extract function name from ToolUseID (format: "call_XX_functionName" or just "call_functionName")
			funcName := result.ToolUseID
			if strings.HasPrefix(funcName, "call_") {
				parts := strings.Split(funcName, "_")
				if len(parts) >= 2 {
					// Take the last part as function name
					funcName = parts[len(parts)-1]
				}
			}
			parts = append(parts, geminiPart{
				FunctionResp: &geminiFunctionResponse{
					Name:     funcName,
					Response: result.Content,
				},
			})
		}

		if len(parts) > 0 {
			contents = append(contents, geminiContent{
				Role:  role,
				Parts: parts,
			})
		}
	}

	return contents
}

func (p *GeminiProvider) convertTools(tools []protocol.Tool) []geminiTool {
	var decls []geminiFunctionDecl

	for _, tool := range tools {
		decls = append(decls, geminiFunctionDecl{
			Name:        tool.Name,
			Description: tool.Description,
			Parameters:  tool.InputSchema,
		})
	}

	return []geminiTool{{FunctionDeclarations: decls}}
}

// Gemini model definitions for reference
// gemini-3-flash: 1M context, free tier available - fast model
// gemini-3-pro: 1M context, paid - flagship reasoning model
// gemini-2.0-flash: 1M context (legacy)
