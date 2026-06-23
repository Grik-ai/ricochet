package agent

// xAI Grok provider - uses OpenAI-compatible API at https://api.x.ai/v1

// NewXAIProvider creates a new xAI provider
// xAI uses OpenAI-compatible API, so we reuse OpenAIProvider with custom baseURL
func NewXAIProvider(apiKey, model string, timeoutMs int) Provider {
	if model == "" {
		model = "grok-4.3"
	}
	return NewOpenAIProvider(apiKey, model, "https://api.x.ai/v1", "", "", timeoutMs)
}

// XAI model definitions for reference
// grok-4.3: 1M context, current general-purpose recommendation.
// grok-build-0.1: 256K context, coding-specific agent model.
// grok-latest: provider-managed latest alias.
