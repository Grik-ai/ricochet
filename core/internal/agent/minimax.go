package agent

// MiniMax provider - uses OpenAI-compatible API
// Global: https://api.minimax.io/v1
// China: https://api.minimaxi.com/v1

// NewMinimaxProvider creates a new MiniMax provider
func NewMinimaxProvider(apiKey, model string, timeoutMs int) Provider {
	if model == "" {
		model = "MiniMax-M3"
	}
	return NewOpenAIProvider(apiKey, model, "https://api.minimax.io/v1", "", "", timeoutMs)
}

// MiniMax model definitions for reference:
// MiniMax-M3: 1M context, current verified catalog route via OpenRouter.
// MiniMax-M2.5: 196K context, also available as an OpenRouter free model.
