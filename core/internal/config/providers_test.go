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
	if got := pm.GetDefaultProvider(); got != "grik" {
		t.Fatalf("default provider = %q, want grik", got)
	}
	if got := pm.GetDefaultModel(); got != "qwen/qwen3-coder:free" {
		t.Fatalf("default model = %q, want qwen/qwen3-coder:free", got)
	}

	found := false
	for _, provider := range pm.GetAvailableProviders() {
		if provider.ID != "grik" {
			continue
		}
		for _, model := range provider.Models {
			if model.ID == "qwen/qwen3-coder:free" {
				if model.CredentialMode != "none" {
					t.Fatalf("default model credentialMode = %q, want none", model.CredentialMode)
				}
				found = true
			}
		}
	}
	if !found {
		t.Fatal("Grik anonymous default Qwen model missing from provider catalog")
	}
}

func TestCatalogCoversJune2026RequiredModels(t *testing.T) {
	required := map[string][]string{
		"openai":     {"gpt-5.5", "gpt-5.4", "gpt-5.4-mini"},
		"anthropic":  {"claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"},
		"xai":        {"grok-4.3", "grok-build-0.1"},
		"deepseek":   {"deepseek-v4-flash", "deepseek-v4-pro"},
		"zhipu":      {"glm-5.1", "glm-5-turbo", "glm-4.7"},
		"minimax":    {"MiniMax-M3"},
		"openrouter": {"qwen/qwen3-coder:free", "openrouter/free", "minimax/minimax-m2.5:free", "minimax/minimax-m3"},
		"grik": {
			"qwen/qwen3-coder:free",
			"ricochet-code",
			"openai/gpt-5.5",
			"openai/gpt-5.4",
			"openai/gpt-5.4-mini",
			"anthropic/claude-fable-5",
			"anthropic/claude-opus-4-8",
			"anthropic/claude-sonnet-4-6",
			"xai/grok-4.3",
			"xai/grok-build-0.1",
			"deepseek/deepseek-v4-flash",
			"deepseek/deepseek-v4-pro",
			"zhipu/glm-5.1",
			"minimax/minimax-m3",
		},
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

func TestGrikBillingModelsHaveExplicitRates(t *testing.T) {
	checkRates := func(t *testing.T, pm *ProvidersManager) {
		t.Helper()
		for _, provider := range pm.GetAvailableProviders() {
			if provider.ID != "grik" {
				continue
			}
			for _, model := range provider.Models {
				if model.BillingSKU != "ricochet_code" {
					continue
				}
				if model.InputPrice <= 0 || model.OutputPrice <= 0 {
					t.Fatalf("grik model %s has billing_sku without explicit rates: input=%v output=%v", model.ID, model.InputPrice, model.OutputPrice)
				}
			}
			return
		}
		t.Fatal("grik provider missing")
	}

	fallbackPM, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("fallback providers: %v", err)
	}
	checkRates(t, fallbackPM)

	yamlPath := filepath.Join("..", "..", "config", "providers.yaml")
	yamlPM, err := NewProvidersManager(yamlPath)
	if err != nil {
		t.Fatalf("yaml providers: %v", err)
	}
	checkRates(t, yamlPM)
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

func TestAnonymousAndProviderKeyCredentialModes(t *testing.T) {
	pm, err := NewProvidersManager("")
	if err != nil {
		t.Fatalf("NewProvidersManager: %v", err)
	}
	if mode, ok := pm.ModelCredentialMode("grik", "qwen/qwen3-coder:free"); !ok || mode != "none" {
		t.Fatalf("grik anonymous free credential mode = %q/%v, want none/true", mode, ok)
	}
	if !pm.ModelAllowsAnonymousUse("grik", "qwen/qwen3-coder:free") {
		t.Fatal("grik anonymous free model should allow anonymous use")
	}
	if mode, ok := pm.ModelCredentialMode("openrouter", "qwen/qwen3-coder:free"); !ok || mode != "provider_key" {
		t.Fatalf("openrouter free credential mode = %q/%v, want provider_key/true", mode, ok)
	}
	if pm.ModelAllowsAnonymousUse("openrouter", "qwen/qwen3-coder:free") {
		t.Fatal("openrouter free model should still require a provider key")
	}
	if mode, ok := pm.ModelCredentialMode("grik", "openai/gpt-5.5"); !ok || mode != "grik_account" {
		t.Fatalf("grik subscription credential mode = %q/%v, want grik_account/true", mode, ok)
	}
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

func TestFilterPromptTrainingModelsHidesOnlyExplicitTrainingModels(t *testing.T) {
	providers := []AvailableProvider{
		{
			ID:   "kilo-style",
			Name: "Kilo Style",
			Models: []AvailableModel{
				{ID: "training", Name: "Training", MayTrainOnYourPrompts: true},
				{ID: "private", Name: "Private", MayTrainOnYourPrompts: false},
				{ID: "unknown", Name: "Unknown"},
			},
			PromptTrainingModelCount: 1,
		},
		{
			ID:   "custom",
			Name: "Custom",
			Models: []AvailableModel{
				{ID: "explicit-training", Name: "Explicit Training", MayTrainOnYourPrompts: true},
				{ID: "byok-unknown", Name: "BYOK Unknown"},
			},
			PromptTrainingModelCount: 1,
		},
	}

	visible := FilterPromptTrainingModels(providers, true)
	if got := providerModelSet(visible); got["kilo-style"]["training"] {
		t.Fatal("explicit prompt-training model should be hidden")
	}
	if got := providerModelSet(visible); got["custom"]["explicit-training"] {
		t.Fatal("explicit prompt-training custom model should be hidden")
	}
	for _, want := range []struct {
		provider string
		model    string
	}{
		{"kilo-style", "private"},
		{"kilo-style", "unknown"},
		{"custom", "byok-unknown"},
	} {
		if !providerModelSet(visible)[want.provider][want.model] {
			t.Fatalf("model %s/%s should remain visible", want.provider, want.model)
		}
	}
	if visible[0].HiddenPromptTrainingModelCount != 1 {
		t.Fatalf("hidden count = %d, want 1", visible[0].HiddenPromptTrainingModelCount)
	}

	unfiltered := FilterPromptTrainingModels(providers, false)
	if !providerModelSet(unfiltered)["kilo-style"]["training"] {
		t.Fatal("prompt-training model should remain visible when privacy filter is off")
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
