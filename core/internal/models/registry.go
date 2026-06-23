package models

// ModelInfo contains information about an AI model
type ModelInfo struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Provider      string  `json:"provider"`
	ContextWindow int     `json:"contextWindow"`
	InputPrice    float64 `json:"inputPrice"`  // per 1M tokens
	OutputPrice   float64 `json:"outputPrice"` // per 1M tokens
	IsFree        bool    `json:"isFree"`
	SupportsTools bool    `json:"supportsTools"`
	Description   string  `json:"description,omitempty"`
}

// ProviderInfo contains provider details and available models
type ProviderInfo struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	HasKey      bool        `json:"hasKey"`
	IsAvailable bool        `json:"isAvailable"`
	Models      []ModelInfo `json:"models"`
}

// Registry holds all available providers and models
var Registry = map[string]ProviderInfo{
	"gemini": {
		ID:   "gemini",
		Name: "Google Gemini",
		Models: []ModelInfo{
			{ID: "gemini-3-flash", Name: "Gemini 3 Flash", Provider: "gemini", ContextWindow: 1000000, InputPrice: 0, OutputPrice: 0, IsFree: true, SupportsTools: true, Description: "Fast, free tier"},
			{ID: "gemini-3-pro", Name: "Gemini 3 Pro", Provider: "gemini", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 5.0, IsFree: false, SupportsTools: true, Description: "Flagship model"},
			{ID: "gemini-2.0-flash", Name: "Gemini 2.0 Flash", Provider: "gemini", ContextWindow: 1000000, InputPrice: 0.075, OutputPrice: 0.30, IsFree: false, SupportsTools: true},
		},
	},
	"anthropic": {
		ID:   "anthropic",
		Name: "Anthropic (Claude)",
		Models: []ModelInfo{
			{ID: "claude-fable-5", Name: "Claude Fable 5", Provider: "anthropic", ContextWindow: 1000000, InputPrice: 10.0, OutputPrice: 50.0, IsFree: false, SupportsTools: true, Description: "Most capable widely released Claude"},
			{ID: "claude-opus-4-8", Name: "Claude Opus 4.8", Provider: "anthropic", ContextWindow: 1000000, InputPrice: 5.0, OutputPrice: 25.0, IsFree: false, SupportsTools: true, Description: "Opus-tier agentic coding"},
			{ID: "claude-sonnet-4-6", Name: "Claude Sonnet 4.6", Provider: "anthropic", ContextWindow: 1000000, InputPrice: 3.0, OutputPrice: 15.0, IsFree: false, SupportsTools: true, Description: "Best speed/intelligence balance"},
			{ID: "claude-haiku-4-5-20251001", Name: "Claude Haiku 4.5", Provider: "anthropic", ContextWindow: 200000, InputPrice: 1.0, OutputPrice: 5.0, IsFree: false, SupportsTools: true},
		},
	},
	"openai": {
		ID:   "openai",
		Name: "OpenAI",
		Models: []ModelInfo{
			{ID: "gpt-5.5", Name: "GPT-5.5", Provider: "openai", ContextWindow: 1000000, InputPrice: 5.0, OutputPrice: 30.0, IsFree: false, SupportsTools: true, Description: "Flagship Responses API model"},
			{ID: "gpt-5.4", Name: "GPT-5.4", Provider: "openai", ContextWindow: 1000000, InputPrice: 2.5, OutputPrice: 15.0, IsFree: false, SupportsTools: true},
			{ID: "gpt-5.4-mini", Name: "GPT-5.4 Mini", Provider: "openai", ContextWindow: 400000, InputPrice: 0.75, OutputPrice: 4.5, IsFree: false, SupportsTools: true},
		},
	},
	"xai": {
		ID:   "xai",
		Name: "xAI (Grok)",
		Models: []ModelInfo{
			{ID: "grok-4.3", Name: "Grok 4.3", Provider: "xai", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 2.50, IsFree: false, SupportsTools: true, Description: "Current general-purpose Grok"},
			{ID: "grok-build-0.1", Name: "Grok Build 0.1", Provider: "xai", ContextWindow: 256000, InputPrice: 1.0, OutputPrice: 2.0, IsFree: false, SupportsTools: true, Description: "Coding agent model"},
			{ID: "grok-latest", Name: "Grok Latest Alias", Provider: "xai", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 2.50, IsFree: false, SupportsTools: true},
		},
	},
	"deepseek": {
		ID:   "deepseek",
		Name: "DeepSeek",
		Models: []ModelInfo{
			{ID: "deepseek-v4-flash", Name: "DeepSeek V4 Flash", Provider: "deepseek", ContextWindow: 1000000, InputPrice: 0.14, OutputPrice: 0.28, IsFree: false, SupportsTools: true, Description: "Current default DeepSeek model"},
			{ID: "deepseek-v4-pro", Name: "DeepSeek V4 Pro", Provider: "deepseek", ContextWindow: 1000000, InputPrice: 0.435, OutputPrice: 0.87, IsFree: false, SupportsTools: true},
			{ID: "deepseek-chat", Name: "DeepSeek Chat (Deprecated 2026-07-24)", Provider: "deepseek", ContextWindow: 1000000, InputPrice: 0.14, OutputPrice: 0.28, IsFree: false, SupportsTools: true},
			{ID: "deepseek-reasoner", Name: "DeepSeek Reasoner (Deprecated 2026-07-24)", Provider: "deepseek", ContextWindow: 1000000, InputPrice: 0.14, OutputPrice: 0.28, IsFree: false, SupportsTools: true},
		},
	},
	"minimax": {
		ID:   "minimax",
		Name: "MiniMax",
		Models: []ModelInfo{
			{ID: "MiniMax-M3", Name: "MiniMax M3", Provider: "minimax", ContextWindow: 1000000, InputPrice: 1.0, OutputPrice: 2.0, IsFree: false, SupportsTools: true, Description: "Current verified MiniMax route"},
			{ID: "MiniMax-M2.5", Name: "MiniMax M2.5", Provider: "minimax", ContextWindow: 196608, InputPrice: 0.5, OutputPrice: 1.0, IsFree: false, SupportsTools: true},
		},
	},
	"moonshot": {
		ID:   "moonshot",
		Name: "Moonshot AI (Kimi)",
		Models: []ModelInfo{
			{ID: "moonshot-v1-8k", Name: "Kimi 8k", Provider: "moonshot", ContextWindow: 8000, InputPrice: 0.15, OutputPrice: 0.60, IsFree: false, SupportsTools: true, Description: "Standard context"},
			{ID: "moonshot-v1-32k", Name: "Kimi 32k", Provider: "moonshot", ContextWindow: 32000, InputPrice: 0.30, OutputPrice: 1.20, IsFree: false, SupportsTools: true, Description: "Long context"},
			{ID: "moonshot-v1-128k", Name: "Kimi 128k", Provider: "moonshot", ContextWindow: 128000, InputPrice: 0.60, OutputPrice: 2.40, IsFree: false, SupportsTools: true, Description: "Ultra long context"},
		},
	},
	"zhipu": {
		ID:   "zhipu",
		Name: "Zhipu AI (GLM)",
		Models: []ModelInfo{
			{ID: "glm-5.1", Name: "GLM-5.1", Provider: "zhipu", ContextWindow: 200000, InputPrice: 1.0, OutputPrice: 2.0, IsFree: false, SupportsTools: true, Description: "Latest GLM flagship"},
			{ID: "glm-5-turbo", Name: "GLM-5 Turbo", Provider: "zhipu", ContextWindow: 128000, InputPrice: 0.3, OutputPrice: 0.6, IsFree: false, SupportsTools: true},
			{ID: "glm-4.7", Name: "GLM-4.7", Provider: "zhipu", ContextWindow: 128000, InputPrice: 1.0, OutputPrice: 1.0, IsFree: false, SupportsTools: true},
			{ID: "glm-4.7-flash", Name: "GLM-4.7 Flash", Provider: "zhipu", ContextWindow: 128000, InputPrice: 0, OutputPrice: 0, IsFree: true, SupportsTools: true},
		},
	},
	"openrouter": {
		ID:   "openrouter",
		Name: "OpenRouter",
		Models: []ModelInfo{
			{ID: "qwen/qwen3-coder:free", Name: "Qwen 3 Coder (Free)", Provider: "openrouter", ContextWindow: 262000, InputPrice: 0, OutputPrice: 0, IsFree: true, SupportsTools: true},
			{ID: "openrouter/free", Name: "OpenRouter Free Router", Provider: "openrouter", ContextWindow: 200000, InputPrice: 0, OutputPrice: 0, IsFree: true, SupportsTools: true},
			{ID: "minimax/minimax-m2.5:free", Name: "MiniMax M2.5 (Free)", Provider: "openrouter", ContextWindow: 196608, InputPrice: 0, OutputPrice: 0, IsFree: true, SupportsTools: true},
			{ID: "minimax/minimax-m3", Name: "MiniMax M3", Provider: "openrouter", ContextWindow: 1000000, InputPrice: 1.0, OutputPrice: 2.0, IsFree: false, SupportsTools: true},
		},
	},
}

// GetAvailableModels returns models for a provider with key status
func GetAvailableModels(providerID string, hasKey bool) []ModelInfo {
	provider, ok := Registry[providerID]
	if !ok {
		return nil
	}

	models := make([]ModelInfo, len(provider.Models))
	copy(models, provider.Models)

	return models
}

// GetAllProviders returns all providers with availability status
func GetAllProviders(keyMap map[string]string) []ProviderInfo {
	providers := make([]ProviderInfo, 0, len(Registry))

	for id, p := range Registry {
		p.HasKey = keyMap[id] != ""
		p.IsAvailable = p.HasKey
		providers = append(providers, p)
	}

	return providers
}

// GetModelByID finds a model across all providers
func GetModelByID(modelID string) *ModelInfo {
	for _, provider := range Registry {
		for _, model := range provider.Models {
			if model.ID == modelID {
				return &model
			}
		}
	}
	return nil
}

// DefaultKeys are built-in API keys (loaded from .env.keys)
var DefaultKeys = map[string]string{}

// SetDefaultKey sets a default API key for a provider
func SetDefaultKey(provider, key string) {
	DefaultKeys[provider] = key
}

// HasDefaultKey checks if a default key exists for provider
func HasDefaultKey(provider string) bool {
	return DefaultKeys[provider] != ""
}
