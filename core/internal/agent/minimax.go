package agent

// MiniMax provider - uses OpenAI-compatible API
// Global: https://api.minimax.io/v1
// China: https://api.minimaxi.com/v1

// NewMinimaxProvider creates a new MiniMax provider
// MiniMax M2.1 supports OpenAI-compatible API
func NewMinimaxProvider(apiKey, model string, timeoutMs int) Provider {
	if model == "" {
		model = "MiniMax-M2.1" // Default model
	}
	return NewOpenAIProvider(apiKey, model, "https://api.minimax.io/v1", "", "", timeoutMs)
}

// MiniMax model definitions for reference:
// MiniMax-M2.1: 200K context, very affordable, good for coding
// MiniMax-Text-02: 1M context, latest flagship model
