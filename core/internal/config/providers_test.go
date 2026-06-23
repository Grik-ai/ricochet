package config

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaultProviderMatchesDocumentedDefault(t *testing.T) {
	pm, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("NewProvidersManager: %v", err)
	}
	if got := pm.GetDefaultProvider(); got != "openrouter" {
		t.Fatalf("default provider = %q, want openrouter", got)
	}
	if got := pm.GetDefaultModel(); got != "qwen/qwen3-coder:free" {
		t.Fatalf("default model = %q, want qwen/qwen3-coder:free", got)
	}

	found := false
	for _, provider := range pm.GetAvailableProviders() {
		if provider.ID != "openrouter" {
			continue
		}
		for _, model := range provider.Models {
			if model.ID == "qwen/qwen3-coder:free" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("OpenRouter default Qwen model missing from provider catalog")
	}
}

func TestCatalogCoversJune2026RequiredModels(t *testing.T) {
	required := map[string][]string{
		"openai":       {"gpt-5.5", "gpt-5.4", "gpt-5.4-mini"},
		"anthropic":    {"claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"},
		"xai":          {"grok-4.3", "grok-build-0.1"},
		"deepseek":     {"deepseek-v4-flash", "deepseek-v4-pro"},
		"zhipu":        {"glm-5.1", "glm-5-turbo", "glm-4.7"},
		"minimax":      {"MiniMax-M3"},
		"openrouter":   {"qwen/qwen3-coder:free", "openrouter/free", "minimax/minimax-m2.5:free", "minimax/minimax-m3"},
		"grik":         {"openai/gpt-5.5", "anthropic/claude-opus-4-8", "xai/grok-4.3", "deepseek/deepseek-v4-pro"},
		"zhipu-coding": {"glm-5.1"},
	}

	checkCatalog := func(t *testing.T, pm *ProvidersManager) {
		t.Helper()
		providers := providerModelSet(pm.GetAvailableProviders())
		for providerID, models := range required {
			for _, modelID := range models {
				if !providers[providerID][modelID] {
					t.Fatalf("%s missing required model %s", providerID, modelID)
				}
			}
		}
	}

	fallbackPM, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("fallback providers: %v", err)
	}
	checkCatalog(t, fallbackPM)

	yamlPath := filepath.Join("..", "..", "config", "providers.yaml")
	yamlPM, err := NewProvidersManager(yamlPath)
	if err != nil {
		t.Fatalf("yaml providers: %v", err)
	}
	checkCatalog(t, yamlPM)
}

func TestDefaultModelIsNotDeprecatedOrLimited(t *testing.T) {
	pm, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("NewProvidersManager: %v", err)
	}
	defaultProvider := pm.GetDefaultProvider()
	defaultModel := pm.GetDefaultModel()
	for _, provider := range pm.GetAvailableProviders() {
		if provider.ID != defaultProvider {
			continue
		}
		for _, model := range provider.Models {
			if model.ID == defaultModel {
				if model.Deprecated || model.Limited {
					t.Fatalf("default model must not be limited/deprecated: %#v", model)
				}
				return
			}
		}
	}
	t.Fatalf("default model %s/%s missing", defaultProvider, defaultModel)
}

func TestGrikProviderUsesHostedKeySource(t *testing.T) {
	pm, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("NewProvidersManager: %v", err)
	}
	pm.SetUserKey("grik", "grik-token")
	for _, provider := range pm.GetAvailableProviders() {
		if provider.ID == "grik" {
			if provider.KeySource != "hosted" {
				t.Fatalf("grik keySource = %q, want hosted", provider.KeySource)
			}
			if provider.AccessMode != "subscription" {
				t.Fatalf("grik accessMode = %q, want subscription", provider.AccessMode)
			}
			return
		}
	}
	t.Fatal("grik provider missing")
}

func TestAvailableProvidersDoNotExposeResolvedKeys(t *testing.T) {
	t.Setenv("GRIKAI_ACCESS_TOKEN", "grik-secret-token")
	t.Setenv("OPENROUTER_API_KEY", "openrouter-secret-token")

	pm, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("NewProvidersManager: %v", err)
	}
	payload, err := json.Marshal(pm.GetAvailableProviders())
	if err != nil {
		t.Fatalf("marshal providers: %v", err)
	}
	body := string(payload)
	for _, secret := range []string{"grik-secret-token", "openrouter-secret-token", "apiKey", "api_key"} {
		if strings.Contains(body, secret) {
			t.Fatalf("available provider metadata leaked %q in %s", secret, body)
		}
	}
}

func TestRefreshOpenRouterFreeModelsAddsLiveFreeModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{
			"data": [
				{
					"id": "example/new-free-model",
					"name": "Example Free",
					"context_length": 12345,
					"pricing": {"prompt": "0", "completion": "0"},
					"supported_parameters": ["tools", "temperature"]
				},
				{
					"id": "example/paid-model",
					"name": "Example Paid",
					"context_length": 12345,
					"pricing": {"prompt": "0.1", "completion": "0.2"},
					"supported_parameters": ["tools"]
				}
			]
		}`))
	}))
	defer server.Close()
	t.Setenv("OPENROUTER_MODELS_URL", server.URL)

	pm, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("NewProvidersManager: %v", err)
	}
	if err := pm.RefreshOpenRouterFreeModels(testContext(t)); err != nil {
		t.Fatalf("RefreshOpenRouterFreeModels: %v", err)
	}
	providers := providerModelSet(pm.GetAvailableProviders())
	if !providers["openrouter"]["example/new-free-model"] {
		t.Fatal("live free model was not merged")
	}
	if providers["openrouter"]["example/paid-model"] {
		t.Fatal("paid model should not be merged by free sync")
	}
}

func providerModelSet(providers []AvailableProvider) map[string]map[string]bool {
	result := make(map[string]map[string]bool, len(providers))
	for _, provider := range providers {
		models := make(map[string]bool, len(provider.Models))
		for _, model := range provider.Models {
			models[model.ID] = true
		}
		result[provider.ID] = models
	}
	return result
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	t.Cleanup(cancel)
	return ctx
}
