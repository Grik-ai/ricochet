package agent

// xAI Grok provider - uses OpenAI-compatible API at https://api.x.ai/v1

// NewXAIProvider creates a new xAI provider
// xAI uses OpenAI-compatible API, so we reuse OpenAIProvider with custom baseURL
func NewXAIProvider(apiKey, model string, timeoutMs int) Provider {
	return NewOpenAIProvider(apiKey, model, "https://api.x.ai/v1", "", "", timeoutMs)
}

// XAI model definitions for reference
// grok-code-fast-1: 256K context, $0.20/$1.50 per M tokens - optimized for coding
// grok-4: 2M context, $3.00/$15.00 per M tokens - flagship model
// grok-4-fast-reasoning: 2M context, $0.20/$0.50 per M tokens
// grok-3: 131K context, $3.00/$15.00 per M tokens
// grok-3-mini: 131K context, $0.30/$0.50 per M tokens
