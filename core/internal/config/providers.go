package config

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// ProvidersConfig holds server-side providers configuration
type ProvidersConfig struct {
	Providers       map[string]ProviderConfig `yaml:"providers"`
	DefaultProvider string                    `yaml:"default_provider"`
	DefaultModel    string                    `yaml:"default_model"`
	BYOK            BYOKConfig                `yaml:"byok"`
}

// ProviderConfig defines a single provider's server configuration
type ProviderConfig struct {
	Enabled          bool          `yaml:"enabled"`
	Key              string        `yaml:"key"`      // Can be ${ENV_VAR} reference
	BaseURL          string        `yaml:"base_url"` // Optional custom endpoint
	KeySource        string        `yaml:"key_source,omitempty"`
	AccessMode       string        `yaml:"access_mode,omitempty"`
	Models           []ModelConfig `yaml:"models"`
	AttemptTimeoutMs int           `yaml:"attempt_timeout_ms,omitempty"`
}

// ModelConfig defines a model available from the provider
type ModelConfig struct {
	ID                    string  `yaml:"id"`
	Name                  string  `yaml:"name"`
	ContextWindow         int     `yaml:"context_window"`
	InputPrice            float64 `yaml:"input_price"`
	OutputPrice           float64 `yaml:"output_price"`
	IsFree                bool    `yaml:"free"`
	SupportsTools         bool    `yaml:"supports_tools"`
	Recommended           bool    `yaml:"recommended,omitempty"`
	AccessMode            string  `yaml:"access_mode,omitempty"`
	KeySource             string  `yaml:"key_source,omitempty"`
	CredentialMode        string  `yaml:"credential_mode,omitempty"`
	RequiresSubscription  bool    `yaml:"requires_subscription,omitempty"`
	BillingSKU            string  `yaml:"billing_sku,omitempty"`
	Limited               bool    `yaml:"limited,omitempty"`
	Deprecated            bool    `yaml:"deprecated,omitempty"`
	APIType               string  `yaml:"api_type,omitempty"`
	Source                string  `yaml:"source,omitempty"`
	LaunchState           string  `yaml:"launch_state,omitempty"`
	OwnedBy               string  `yaml:"owned_by,omitempty"`
	MayTrainOnYourPrompts bool    `yaml:"may_train_on_your_prompts,omitempty" json:"mayTrainOnYourPrompts,omitempty"`
}

// BYOKConfig defines bring-your-own-key settings
type BYOKConfig struct {
	Enabled             bool `yaml:"enabled"`
	ShowServerProviders bool `yaml:"show_server_providers"`
}

// AvailableProvider is returned to frontend
type AvailableProvider struct {
	ID                             string           `json:"id"`
	Name                           string           `json:"name"`
	HasKey                         bool             `json:"hasKey"`     // Server has key configured
	HasUserKey                     bool             `json:"hasUserKey"` // User has configured a BYOK key
	KeySource                      string           `json:"keySource"`  // "server", "user", "hosted", "none"
	AccessMode                     string           `json:"accessMode,omitempty"`
	Available                      bool             `json:"available"` // User can use (server key OR BYOK)
	Models                         []AvailableModel `json:"models"`
	CatalogStatus                  *CatalogStatus   `json:"catalogStatus,omitempty"`
	PromptTrainingModelCount       int              `json:"promptTrainingModelCount,omitempty"`
	HiddenPromptTrainingModelCount int              `json:"hiddenPromptTrainingModelCount,omitempty"`
}

// CatalogStatus describes where provider model metadata came from.
type CatalogStatus struct {
	Source      string `json:"source,omitempty"`      // "curated", "live", or "mixed"
	RefreshedAt string `json:"refreshedAt,omitempty"` // RFC3339 timestamp when live sync succeeded
	Error       string `json:"error,omitempty"`       // Non-fatal live sync fallback reason
}

// AvailableModel is returned to frontend
type AvailableModel struct {
	ID                    string  `json:"id"`
	Name                  string  `json:"name"`
	ContextWindow         int     `json:"contextWindow"`
	InputPrice            float64 `json:"inputPrice"`
	OutputPrice           float64 `json:"outputPrice"`
	IsFree                bool    `json:"isFree"`
	SupportsTools         bool    `json:"supportsTools"`
	Recommended           bool    `json:"recommended,omitempty"`
	AccessMode            string  `json:"accessMode,omitempty"`
	KeySource             string  `json:"keySource,omitempty"`
	CredentialMode        string  `json:"credentialMode,omitempty"`
	RequiresSubscription  bool    `json:"requiresSubscription,omitempty"`
	BillingSKU            string  `json:"billingSku,omitempty"`
	Limited               bool    `json:"limited,omitempty"`
	Deprecated            bool    `json:"deprecated,omitempty"`
	APIType               string  `json:"apiType,omitempty"`
	Source                string  `json:"source,omitempty"`
	LaunchState           string  `json:"launchState,omitempty"`
	OwnedBy               string  `json:"ownedBy,omitempty"`
	MayTrainOnYourPrompts bool    `json:"mayTrainOnYourPrompts,omitempty"`
}

// ProviderKeyValidationResult reports a non-mutating provider key probe.
type ProviderKeyValidationResult struct {
	ProviderID string `json:"providerId,omitempty"`
	OK         bool   `json:"ok"`
	Status     string `json:"status"`
	Message    string `json:"message"`
	CheckedAt  int64  `json:"checkedAt"`
}

// ProvidersManager handles loading and querying providers config
type ProvidersManager struct {
	config                    *ProvidersConfig
	userKeys                  map[string]string // User-provided keys from Settings
	openRouterRefreshOnce     sync.Once
	openRouterRefreshMu       sync.RWMutex
	openRouterRefreshErr      error
	openRouterRefreshDisabled bool
	openRouterRefreshedAt     time.Time
	openRouterCatalogError    string
}

func providersDebugEnabled() bool {
	switch strings.ToLower(os.Getenv("RICOCHET_DEBUG")) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func providersDebugf(format string, args ...interface{}) {
	if providersDebugEnabled() {
		fmt.Fprintf(os.Stderr, format, args...)
	}
}

// NewProvidersManager creates a new providers manager
func NewProvidersManager(configPath string) (*ProvidersManager, error) {
	pm := &ProvidersManager{
		userKeys: make(map[string]string),
	}

	// Load local dev env file first (if exists)
	pm.loadEnvLocal()

	// Try to load config file
	if configPath != "" {
		if err := pm.loadConfig(configPath); err != nil {
			// Config file optional - use defaults
			pm.config = pm.defaultConfig()
		}
	} else {
		pm.config = pm.defaultConfig()
	}

	// Resolve environment variables in keys
	pm.resolveEnvVars()

	return pm, nil
}

// loadConfig loads providers config from yaml file
func (pm *ProvidersManager) loadConfig(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	pm.config = &ProvidersConfig{}
	return yaml.Unmarshal(data, pm.config)
}

// loadEnvLocal loads .env.local file for local development
// This file is gitignored and contains developer API keys
func (pm *ProvidersManager) loadEnvLocal() {
	// Get executable directory for relative paths
	execPath, _ := os.Executable()
	execDir := filepath.Dir(execPath)
	cwd, _ := os.Getwd()

	// Get home directory
	home, _ := os.UserHomeDir()
	disableProjectEnvLocal := strings.EqualFold(os.Getenv("RICOCHET_DISABLE_PROJECT_ENV_LOCAL"), "1") &&
		!strings.EqualFold(os.Getenv("RICOCHET_ENABLE_PROJECT_ENV_LOCAL"), "1")

	// Look for .env.local in various locations
	paths := []string{}
	if !disableProjectEnvLocal {
		paths = append(paths,
			// Relative to executable (bin/darwin-arm64 -> ../../core/config)
			filepath.Join(execDir, "..", "..", "core", "config", ".env.local"),
			filepath.Join(execDir, "config", ".env.local"),
			filepath.Join(execDir, "..", "config", ".env.local"),
			// Current directory variations
			filepath.Join(cwd, "config", ".env.local"),
			filepath.Join(cwd, "core", "config", ".env.local"),
			"config/.env.local",
			"core/config/.env.local",
			".env.local",
		)
	}
	paths = append(paths, filepath.Join(home, ".ricochet", ".env.local"))

	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		providersDebugf("[Providers] Found .env.local at: %s\n", path)

		// Parse KEY=VALUE lines
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				key := strings.TrimSpace(parts[0])
				value := strings.TrimSpace(parts[1])
				os.Setenv(key, value)
				providersDebugf("[Providers] Set ENV: %s=***\n", key)
			}
		}
		return // Only load first found file
	}
	providersDebugf("[Providers] No .env.local found in search paths\n")
}

// resolveEnvVars replaces ${ENV_VAR} with actual values from environment
func (pm *ProvidersManager) resolveEnvVars() {
	for id, p := range pm.config.Providers {
		if strings.HasPrefix(p.Key, "${") && strings.HasSuffix(p.Key, "}") {
			envVar := p.Key[2 : len(p.Key)-1]
			val := os.Getenv(envVar)
			providersDebugf("[Providers] Resolving %s -> (len=%d)\n", p.Key, len(val))
			p.Key = val
		}
		if strings.HasPrefix(p.BaseURL, "${") && strings.HasSuffix(p.BaseURL, "}") {
			envVar := p.BaseURL[2 : len(p.BaseURL)-1]
			val := os.Getenv(envVar)
			providersDebugf("[Providers] Resolving %s -> (len=%d)\n", p.BaseURL, len(val))
			p.BaseURL = val
		}
		pm.config.Providers[id] = p
	}
}

// SetUserKey sets a user-provided API key for a provider
func (pm *ProvidersManager) SetUserKey(providerID, key string) {
	if strings.TrimSpace(key) == "" {
		delete(pm.userKeys, providerID)
		return
	}
	pm.userKeys[providerID] = key
}

// GetAvailableProviders returns providers available to the user
func (pm *ProvidersManager) GetAvailableProviders() []AvailableProvider {
	result := make([]AvailableProvider, 0)

	providerNames := map[string]string{
		"gemini":       "Google Gemini",
		"deepseek":     "DeepSeek",
		"anthropic":    "Anthropic (Claude)",
		"openai":       "OpenAI",
		"xai":          "xAI (Grok)",
		"minimax":      "MiniMax",
		"mistral":      "Mistral AI",
		"openrouter":   "OpenRouter",
		"zhipu":        "Zhipu AI (GLM)",
		"zhipu-coding": "Zhipu Coding (GLM)",
		"grik":         "Grik",
	}

	for id, p := range pm.config.Providers {
		if !p.Enabled {
			continue
		}

		hasServerKey := p.Key != ""
		hasUserKey := pm.userKeys[id] != ""
		hasAnonymousModel := false
		for _, m := range p.Models {
			if normalizeCredentialMode(m, p) == "none" {
				hasAnonymousModel = true
				break
			}
		}
		available := hasServerKey || (pm.config.BYOK.Enabled && hasUserKey) || hasAnonymousModel
		keySource := "none"
		if hasUserKey {
			keySource = "user"
		} else if hasServerKey {
			keySource = "server"
		}
		if p.KeySource != "" && (hasServerKey || hasUserKey) {
			keySource = p.KeySource
		}
		accessMode := p.AccessMode

		models := make([]AvailableModel, 0, len(p.Models))
		promptTrainingModelCount := 0
		for _, m := range p.Models {
			modelAccessMode := normalizeModelAccessMode(m, accessMode)
			modelKeySource := m.KeySource
			if modelKeySource == "" && modelAccessMode == "subscription" {
				modelKeySource = "hosted"
			}
			modelCredentialMode := normalizeCredentialMode(m, p)
			if m.MayTrainOnYourPrompts {
				promptTrainingModelCount++
			}
			models = append(models, AvailableModel{
				ID:                    m.ID,
				Name:                  m.Name,
				ContextWindow:         m.ContextWindow,
				InputPrice:            m.InputPrice,
				OutputPrice:           m.OutputPrice,
				IsFree:                m.IsFree,
				SupportsTools:         m.SupportsTools,
				Recommended:           m.Recommended,
				AccessMode:            modelAccessMode,
				KeySource:             modelKeySource,
				CredentialMode:        modelCredentialMode,
				RequiresSubscription:  m.RequiresSubscription,
				BillingSKU:            m.BillingSKU,
				Limited:               m.Limited,
				Deprecated:            m.Deprecated,
				APIType:               m.APIType,
				Source:                m.Source,
				LaunchState:           normalizeLaunchState(m.LaunchState),
				OwnedBy:               m.OwnedBy,
				MayTrainOnYourPrompts: m.MayTrainOnYourPrompts,
			})
		}

		name := providerNames[id]
		if name == "" {
			name = id
		}

		result = append(result, AvailableProvider{
			ID:                       id,
			Name:                     name,
			HasKey:                   hasServerKey,
			HasUserKey:               hasUserKey,
			KeySource:                keySource,
			AccessMode:               accessMode,
			Available:                available,
			Models:                   models,
			CatalogStatus:            pm.catalogStatusForProvider(id, p),
			PromptTrainingModelCount: promptTrainingModelCount,
		})
	}

	sort.SliceStable(result, func(i, j int) bool {
		leftRank := providerDisplayRank(result[i].ID)
		rightRank := providerDisplayRank(result[j].ID)
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		if result[i].Name != result[j].Name {
			return result[i].Name < result[j].Name
		}
		return result[i].ID < result[j].ID
	})

	return result
}

func providerDisplayRank(providerID string) int {
	switch strings.ToLower(providerID) {
	case "grik":
		return 0
	case "openrouter":
		return 10
	case "anthropic":
		return 20
	case "openai":
		return 30
	case "deepseek":
		return 40
	case "zhipu":
		return 50
	case "zhipu-coding":
		return 51
	case "gemini":
		return 60
	case "xai":
		return 70
	case "minimax":
		return 80
	case "mistral":
		return 90
	default:
		return 1000
	}
}

func normalizeLaunchState(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "soon":
		return "soon"
	case "live":
		return "live"
	default:
		return ""
	}
}

func (pm *ProvidersManager) catalogStatusForProvider(providerID string, provider ProviderConfig) *CatalogStatus {
	source := catalogSourceForModels(provider.Models)
	if providerID != "openrouter" {
		return &CatalogStatus{Source: source}
	}

	status := &CatalogStatus{Source: source}
	pm.openRouterRefreshMu.RLock()
	defer pm.openRouterRefreshMu.RUnlock()

	if !pm.openRouterRefreshedAt.IsZero() {
		status.RefreshedAt = pm.openRouterRefreshedAt.Format(time.RFC3339)
	}
	if pm.openRouterCatalogError != "" {
		status.Error = pm.openRouterCatalogError
	} else if pm.openRouterRefreshDisabled {
		status.Error = "Live sync disabled"
	}
	return status
}

func catalogSourceForModels(models []ModelConfig) string {
	hasLive := false
	hasCurated := false
	for _, model := range models {
		if strings.EqualFold(model.Source, "openrouter-live") {
			hasLive = true
		} else {
			hasCurated = true
		}
	}
	if hasLive && hasCurated {
		return "mixed"
	}
	if hasLive {
		return "live"
	}
	return "curated"
}

// FilterPromptTrainingModels hides only models explicitly marked as prompt-training risks.
func FilterPromptTrainingModels(providers []AvailableProvider, hide bool) []AvailableProvider {
	if !hide {
		return providers
	}

	filtered := make([]AvailableProvider, 0, len(providers))
	for _, provider := range providers {
		models := make([]AvailableModel, 0, len(provider.Models))
		hiddenCount := 0
		for _, model := range provider.Models {
			if model.MayTrainOnYourPrompts {
				hiddenCount++
				continue
			}
			models = append(models, model)
		}
		provider.Models = models
		provider.HiddenPromptTrainingModelCount = hiddenCount
		if provider.PromptTrainingModelCount == 0 && hiddenCount > 0 {
			provider.PromptTrainingModelCount = hiddenCount
		}
		filtered = append(filtered, provider)
	}
	return filtered
}

func normalizeModelAccessMode(model ModelConfig, providerAccessMode string) string {
	if model.AccessMode != "" {
		return model.AccessMode
	}
	if model.IsFree {
		return "free"
	}
	if model.RequiresSubscription || providerAccessMode == "subscription" {
		return "subscription"
	}
	return "byok"
}

func normalizeCredentialMode(model ModelConfig, provider ProviderConfig) string {
	if model.CredentialMode != "" {
		return model.CredentialMode
	}
	modelAccessMode := normalizeModelAccessMode(model, provider.AccessMode)
	if modelAccessMode == "subscription" || model.RequiresSubscription || model.KeySource == "hosted" || provider.KeySource == "hosted" && provider.AccessMode == "subscription" {
		return "grik_account"
	}
	return "provider_key"
}

// ModelCredentialMode returns the credential mode required for a configured model.
func (pm *ProvidersManager) ModelCredentialMode(providerID, modelID string) (string, bool) {
	provider, ok := pm.config.Providers[providerID]
	if !ok || !provider.Enabled {
		return "", false
	}
	for _, model := range provider.Models {
		if model.ID == modelID {
			return normalizeCredentialMode(model, provider), true
		}
	}
	return "", false
}

// ModelAllowsAnonymousUse reports whether a model explicitly requires no credentials.
func (pm *ProvidersManager) ModelAllowsAnonymousUse(providerID, modelID string) bool {
	mode, ok := pm.ModelCredentialMode(providerID, modelID)
	return ok && mode == "none"
}

// ModelRequiresGrikAccount reports whether a model requires Grik hosted account access.
func (pm *ProvidersManager) ModelRequiresGrikAccount(providerID, modelID string) bool {
	mode, ok := pm.ModelCredentialMode(providerID, modelID)
	return ok && mode == "grik_account"
}

type openRouterModelsResponse struct {
	Data []struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		ContextLength int    `json:"context_length"`
		Pricing       struct {
			Prompt     string `json:"prompt"`
			Completion string `json:"completion"`
		} `json:"pricing"`
		SupportedParameters []string `json:"supported_parameters"`
	} `json:"data"`
}

// RefreshOpenRouterFreeModels merges the current OpenRouter free model catalog
// into the static curated list. Failures are non-fatal by design.
func (pm *ProvidersManager) RefreshOpenRouterFreeModels(ctx context.Context) error {
	pm.openRouterRefreshOnce.Do(func() {
		_ = pm.refreshOpenRouterFreeModelsAndRecord(ctx)
	})
	pm.openRouterRefreshMu.RLock()
	defer pm.openRouterRefreshMu.RUnlock()
	return pm.openRouterRefreshErr
}

// ForceRefreshOpenRouterFreeModels bypasses the once-only startup sync cache.
func (pm *ProvidersManager) ForceRefreshOpenRouterFreeModels(ctx context.Context) error {
	return pm.refreshOpenRouterFreeModelsAndRecord(ctx)
}

func (pm *ProvidersManager) refreshOpenRouterFreeModelsAndRecord(ctx context.Context) error {
	err := pm.refreshOpenRouterFreeModels(ctx)
	pm.openRouterRefreshMu.Lock()
	defer pm.openRouterRefreshMu.Unlock()
	pm.openRouterRefreshErr = err
	pm.openRouterRefreshDisabled = false
	if err != nil {
		pm.openRouterCatalogError = err.Error()
		return err
	}
	pm.openRouterCatalogError = ""
	pm.openRouterRefreshedAt = time.Now().UTC()
	return nil
}

// MarkOpenRouterFreeModelSyncDisabled records that live catalog sync was skipped.
func (pm *ProvidersManager) MarkOpenRouterFreeModelSyncDisabled() {
	pm.openRouterRefreshMu.Lock()
	defer pm.openRouterRefreshMu.Unlock()
	pm.openRouterRefreshDisabled = true
	pm.openRouterCatalogError = "Live sync disabled"
}

func (pm *ProvidersManager) refreshOpenRouterFreeModels(ctx context.Context) error {
	if pm == nil || pm.config == nil {
		return nil
	}
	provider, ok := pm.config.Providers["openrouter"]
	if !ok || !provider.Enabled {
		return nil
	}

	modelsURL := strings.TrimSpace(os.Getenv("OPENROUTER_MODELS_URL"))
	if modelsURL == "" {
		modelsURL = "https://openrouter.ai/api/v1/models"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("openrouter models returned HTTP %d", resp.StatusCode)
	}

	var payload openRouterModelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return err
	}

	seen := make(map[string]int, len(provider.Models))
	for i, model := range provider.Models {
		seen[model.ID] = i
	}
	for _, item := range payload.Data {
		if item.ID == "" || !isOpenRouterFreeModel(item.ID, item.Pricing.Prompt, item.Pricing.Completion) {
			continue
		}
		model := ModelConfig{
			ID:            item.ID,
			Name:          firstNonEmpty(item.Name, item.ID),
			ContextWindow: item.ContextLength,
			IsFree:        true,
			SupportsTools: stringSliceContains(item.SupportedParameters, "tools"),
			AccessMode:    "free",
			Source:        "openrouter-live",
		}
		if idx, ok := seen[item.ID]; ok {
			existing := provider.Models[idx]
			existing.Name = firstNonEmpty(existing.Name, model.Name)
			if existing.ContextWindow == 0 {
				existing.ContextWindow = model.ContextWindow
			}
			existing.IsFree = true
			existing.AccessMode = "free"
			existing.Source = firstNonEmpty(existing.Source, model.Source)
			if !existing.SupportsTools {
				existing.SupportsTools = model.SupportsTools
			}
			provider.Models[idx] = existing
			continue
		}
		provider.Models = append(provider.Models, model)
		seen[item.ID] = len(provider.Models) - 1
	}
	pm.config.Providers["openrouter"] = provider
	return nil
}

func isOpenRouterFreeModel(id, promptPrice, completionPrice string) bool {
	if strings.Contains(strings.ToLower(id), ":free") {
		return true
	}
	prompt, promptErr := strconv.ParseFloat(promptPrice, 64)
	completion, completionErr := strconv.ParseFloat(completionPrice, 64)
	return promptErr == nil && completionErr == nil && prompt == 0 && completion == 0
}

func stringSliceContains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// ValidateProviderKey checks a BYOK provider key without saving it.
func (pm *ProvidersManager) ValidateProviderKey(ctx context.Context, providerID, apiKey string) ProviderKeyValidationResult {
	checkedAt := time.Now().UnixMilli()
	providerID = strings.TrimSpace(providerID)
	key := strings.TrimSpace(apiKey)
	if key == "" {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "no_key", Message: "Enter an API key first.", CheckedAt: checkedAt}
	}
	if pm == nil || pm.config == nil {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "unsupported", Message: "Provider catalog is not available.", CheckedAt: checkedAt}
	}
	provider, ok := pm.config.Providers[providerID]
	if !ok || !provider.Enabled {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "unsupported", Message: "Provider is not configured.", CheckedAt: checkedAt}
	}
	if isHostedSubscriptionAccess(provider) {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "unsupported", Message: "Grik Account providers do not use BYOK API keys.", CheckedAt: checkedAt}
	}

	req, err := providerKeyValidationRequest(ctx, providerID, provider, key)
	if err != nil {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "unsupported", Message: err.Error(), CheckedAt: checkedAt}
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "network_error", Message: "Could not reach provider endpoint.", CheckedAt: checkedAt}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: true, Status: "valid", Message: "Key connected.", CheckedAt: checkedAt}
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "unauthorized", Message: "Provider rejected this API key.", CheckedAt: checkedAt}
	}
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "unsupported", Message: "Provider key check is not supported for this endpoint.", CheckedAt: checkedAt}
	}
	if resp.StatusCode >= 500 {
		return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "network_error", Message: fmt.Sprintf("Provider returned HTTP %d.", resp.StatusCode), CheckedAt: checkedAt}
	}
	return ProviderKeyValidationResult{ProviderID: providerID, OK: false, Status: "unauthorized", Message: fmt.Sprintf("Provider returned HTTP %d.", resp.StatusCode), CheckedAt: checkedAt}
}

func isHostedSubscriptionAccess(provider ProviderConfig) bool {
	return provider.KeySource == "hosted" || provider.AccessMode == "subscription"
}

func providerKeyValidationRequest(ctx context.Context, providerID string, provider ProviderConfig, apiKey string) (*http.Request, error) {
	target, err := providerValidationURL(providerID, provider.BaseURL, apiKey)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}

	switch strings.ToLower(providerID) {
	case "anthropic":
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "gemini":
		// Gemini uses the key query parameter for the models endpoint.
	default:
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func providerValidationURL(providerID, baseURL, apiKey string) (string, error) {
	provider := strings.ToLower(strings.TrimSpace(providerID))
	base := strings.TrimSpace(baseURL)
	if base == "" {
		base = defaultProviderValidationBaseURL(provider)
	}
	if base == "" {
		return "", fmt.Errorf("Provider key check is not supported.")
	}

	switch provider {
	case "gemini":
		u, err := urlWithPath(base, "/v1beta/models")
		if err != nil {
			return "", err
		}
		q := u.Query()
		q.Set("key", apiKey)
		u.RawQuery = q.Encode()
		return u.String(), nil
	default:
		u, err := urlWithPath(base, "/models")
		if err != nil {
			return "", err
		}
		return u.String(), nil
	}
}

func defaultProviderValidationBaseURL(providerID string) string {
	switch providerID {
	case "openai":
		return "https://api.openai.com/v1"
	case "openrouter":
		return "https://openrouter.ai/api/v1"
	case "anthropic":
		return "https://api.anthropic.com/v1"
	case "gemini":
		return "https://generativelanguage.googleapis.com"
	case "deepseek":
		return "https://api.deepseek.com"
	case "zhipu", "zhipu-coding":
		return "https://api.z.ai/api/paas/v4"
	case "mistral":
		return "https://api.mistral.ai/v1"
	case "minimax":
		return "https://api.minimax.chat/v1"
	case "xai":
		return "https://api.x.ai/v1"
	default:
		return ""
	}
}

func urlWithPath(baseURL, suffix string) (*url.URL, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("Provider endpoint is invalid.")
	}
	path := strings.TrimRight(u.Path, "/")
	if strings.HasSuffix(strings.ToLower(path), "/chat/completions") {
		path = strings.TrimSuffix(path, "/chat/completions")
	}
	if strings.HasSuffix(strings.ToLower(path), "/messages") {
		path = strings.TrimSuffix(path, "/messages")
	}
	if !strings.HasSuffix(strings.ToLower(path), strings.ToLower(suffix)) {
		path = path + suffix
	}
	u.Path = path
	u.RawQuery = ""
	u.Fragment = ""
	return u, nil
}

// GetAPIKey returns the API key to use for a provider (server key or user key)
func (pm *ProvidersManager) GetAPIKey(providerID string) string {
	// User key takes priority
	if key := pm.userKeys[providerID]; key != "" {
		return key
	}
	// Fallback to server key
	if p, ok := pm.config.Providers[providerID]; ok {
		return p.Key
	}
	return ""
}

// GetBaseURL returns custom base URL for a provider if configured
func (pm *ProvidersManager) GetBaseURL(providerID string) string {
	if p, ok := pm.config.Providers[providerID]; ok {
		return p.BaseURL
	}
	return ""
}

// GetDefaultProvider returns the default provider ID
func (pm *ProvidersManager) GetDefaultProvider() string {
	if pm.config.DefaultProvider != "" {
		return pm.config.DefaultProvider
	}
	return "grik"
}

// GetDefaultModel returns the default model ID
func (pm *ProvidersManager) GetDefaultModel() string {
	if pm.config.DefaultModel != "" {
		return pm.config.DefaultModel
	}
	return "qwen/qwen3-coder:free"
}

// defaultConfig returns default configuration when no yaml file
func (pm *ProvidersManager) defaultConfig() *ProvidersConfig {
	return &ProvidersConfig{
		Providers: map[string]ProviderConfig{
			"grik": {
				Enabled:    true,
				Key:        os.Getenv("GRIKAI_ACCESS_TOKEN"),
				BaseURL:    os.Getenv("GRIKAI_CODE_GATEWAY_URL"),
				KeySource:  "hosted",
				AccessMode: "subscription",
				Models: []ModelConfig{
					{ID: "qwen/qwen3-coder:free", Name: "Qwen 3 Coder (Anonymous Free)", ContextWindow: 262000, IsFree: true, SupportsTools: true, AccessMode: "free", CredentialMode: "none", Recommended: true},
					{ID: "ricochet-code", Name: "Grik Ricochet Code", ContextWindow: 200000, InputPrice: 5.0, OutputPrice: 20.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code", LaunchState: "soon", OwnedBy: "grik", Recommended: true},
					{ID: "openai/gpt-5.5", Name: "GPT-5.5 (Subscription)", ContextWindow: 1000000, InputPrice: 5.0, OutputPrice: 30.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code", APIType: "responses", Recommended: true},
					{ID: "openai/gpt-5.4", Name: "GPT-5.4 (Subscription)", ContextWindow: 1000000, InputPrice: 2.5, OutputPrice: 15.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code", APIType: "responses"},
					{ID: "openai/gpt-5.4-mini", Name: "GPT-5.4 Mini (Subscription)", ContextWindow: 400000, InputPrice: 0.75, OutputPrice: 4.5, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code", APIType: "responses"},
					{ID: "anthropic/claude-fable-5", Name: "Claude Fable 5 (Subscription)", ContextWindow: 1000000, InputPrice: 10.0, OutputPrice: 50.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
					{ID: "anthropic/claude-opus-4-8", Name: "Claude Opus 4.8 (Subscription)", ContextWindow: 1000000, InputPrice: 5.0, OutputPrice: 25.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code", Recommended: true},
					{ID: "anthropic/claude-sonnet-4-6", Name: "Claude Sonnet 4.6 (Subscription)", ContextWindow: 1000000, InputPrice: 3.0, OutputPrice: 15.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
					{ID: "xai/grok-4.3", Name: "Grok 4.3 (Subscription)", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 2.50, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
					{ID: "xai/grok-build-0.1", Name: "Grok Build 0.1 (Subscription)", ContextWindow: 256000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
					{ID: "deepseek/deepseek-v4-flash", Name: "DeepSeek V4 Flash (Subscription)", ContextWindow: 1000000, InputPrice: 0.14, OutputPrice: 0.28, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
					{ID: "deepseek/deepseek-v4-pro", Name: "DeepSeek V4 Pro (Subscription)", ContextWindow: 1000000, InputPrice: 0.435, OutputPrice: 0.87, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
					{ID: "zhipu/glm-5.1", Name: "GLM-5.1 (Subscription)", ContextWindow: 200000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
					{ID: "minimax/minimax-m3", Name: "MiniMax M3 (Subscription)", ContextWindow: 1000000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true, AccessMode: "subscription", RequiresSubscription: true, BillingSKU: "ricochet_code"},
				},
				AttemptTimeoutMs: 1000,
			},
			"deepseek": {
				Enabled: true,
				Key:     os.Getenv("DEEPSEEK_API_KEY"),
				BaseURL: "https://api.deepseek.com",
				Models: []ModelConfig{
					{ID: "deepseek-v4-flash", Name: "DeepSeek V4 Flash", ContextWindow: 1000000, InputPrice: 0.14, OutputPrice: 0.28, SupportsTools: true, Recommended: true},
					{ID: "deepseek-v4-pro", Name: "DeepSeek V4 Pro", ContextWindow: 1000000, InputPrice: 0.435, OutputPrice: 0.87, SupportsTools: true},
					{ID: "deepseek-chat", Name: "DeepSeek Chat (Deprecated 2026-07-24)", ContextWindow: 1000000, InputPrice: 0.14, OutputPrice: 0.28, SupportsTools: true, Deprecated: true},
					{ID: "deepseek-reasoner", Name: "DeepSeek Reasoner (Deprecated 2026-07-24)", ContextWindow: 1000000, InputPrice: 0.14, OutputPrice: 0.28, SupportsTools: true, Deprecated: true},
				},
				AttemptTimeoutMs: 1000,
			},
			"gemini": {
				Enabled: true,
				Key:     os.Getenv("GEMINI_API_KEY"),
				Models: []ModelConfig{
					{ID: "gemini-3-flash", Name: "Gemini 3 Flash", ContextWindow: 1000000, IsFree: true, SupportsTools: true},
					{ID: "gemini-3-pro", Name: "Gemini 3 Pro", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 10.0, SupportsTools: true},
					{ID: "gemini-2.5-flash", Name: "Gemini 2.5 Flash", ContextWindow: 1000000, IsFree: true, SupportsTools: true},
					{ID: "gemini-2.5-pro", Name: "Gemini 2.5 Pro", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 10.0, SupportsTools: true},
				},
				AttemptTimeoutMs: 1000,
			},
			"anthropic": {
				Enabled: true,
				Key:     os.Getenv("ANTHROPIC_API_KEY"),
				Models: []ModelConfig{
					{ID: "claude-fable-5", Name: "Claude Fable 5", ContextWindow: 1000000, InputPrice: 10.0, OutputPrice: 50.0, SupportsTools: true, Recommended: true},
					{ID: "claude-opus-4-8", Name: "Claude Opus 4.8", ContextWindow: 1000000, InputPrice: 5.0, OutputPrice: 25.0, SupportsTools: true, Recommended: true},
					{ID: "claude-sonnet-4-6", Name: "Claude Sonnet 4.6", ContextWindow: 1000000, InputPrice: 3.0, OutputPrice: 15.0, SupportsTools: true, Recommended: true},
					{ID: "claude-haiku-4-5-20251001", Name: "Claude Haiku 4.5", ContextWindow: 200000, InputPrice: 1.0, OutputPrice: 5.0, SupportsTools: true},
					{ID: "claude-mythos-5", Name: "Claude Mythos 5 (Limited)", ContextWindow: 1000000, InputPrice: 10.0, OutputPrice: 50.0, SupportsTools: true, Limited: true},
				},
				AttemptTimeoutMs: 1000,
			},
			"openai": {
				Enabled: true,
				Key:     os.Getenv("OPENAI_API_KEY"),
				Models: []ModelConfig{
					{ID: "gpt-5.5", Name: "GPT-5.5", ContextWindow: 1000000, InputPrice: 5.0, OutputPrice: 30.0, SupportsTools: true, Recommended: true, APIType: "responses"},
					{ID: "gpt-5.4", Name: "GPT-5.4", ContextWindow: 1000000, InputPrice: 2.5, OutputPrice: 15.0, SupportsTools: true, APIType: "responses"},
					{ID: "gpt-5.4-mini", Name: "GPT-5.4 Mini", ContextWindow: 400000, InputPrice: 0.75, OutputPrice: 4.5, SupportsTools: true, APIType: "responses"},
				},
				AttemptTimeoutMs: 1000,
			},
			"xai": {
				Enabled: true,
				Key:     os.Getenv("XAI_API_KEY"),
				Models: []ModelConfig{
					{ID: "grok-4.3", Name: "Grok 4.3", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 2.50, SupportsTools: true, Recommended: true},
					{ID: "grok-build-0.1", Name: "Grok Build 0.1", ContextWindow: 256000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true},
					{ID: "grok-latest", Name: "Grok Latest Alias", ContextWindow: 1000000, InputPrice: 1.25, OutputPrice: 2.50, SupportsTools: true},
				},
				AttemptTimeoutMs: 1000,
			},
			"mistral": {
				Enabled: true,
				Key:     os.Getenv("MISTRAL_API_KEY"),
				BaseURL: "https://api.mistral.ai/v1",
				Models: []ModelConfig{
					{ID: "codestral-latest", Name: "Codestral (Free)", ContextWindow: 32000, IsFree: true, SupportsTools: true},
					{ID: "ministral-8b-latest", Name: "Ministral 8B (Free)", ContextWindow: 128000, IsFree: true, SupportsTools: true},
				},
				AttemptTimeoutMs: 1000,
			},
			"zhipu": {
				Enabled: true,
				Key:     os.Getenv("ZHIPU_API_KEY"),
				BaseURL: "https://api.z.ai/api/paas/v4",
				Models: []ModelConfig{
					{ID: "glm-5.1", Name: "GLM-5.1 (Flagship)", ContextWindow: 200000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true, Recommended: true},
					{ID: "glm-5-turbo", Name: "GLM-5 Turbo", ContextWindow: 128000, InputPrice: 0.3, OutputPrice: 0.6, SupportsTools: true},
					{ID: "glm-4.7", Name: "GLM-4.7", ContextWindow: 128000, InputPrice: 1.0, OutputPrice: 1.0, SupportsTools: true},
					{ID: "glm-4.7-flash", Name: "GLM-4.7 Flash (Free)", ContextWindow: 128000, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "glm-4.5-flash", Name: "GLM-4.5 Flash (Free)", ContextWindow: 128000, IsFree: true, SupportsTools: true, AccessMode: "free"},
				},
				AttemptTimeoutMs: 1000,
			},
			"zhipu-coding": {
				Enabled: true,
				Key:     os.Getenv("ZHIPU_API_KEY"),
				BaseURL: "https://api.z.ai/api/coding/paas/v4",
				Models: []ModelConfig{
					{ID: "glm-5.1", Name: "GLM-5.1 Coding", ContextWindow: 200000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true, Recommended: true},
					{ID: "glm-4.7", Name: "GLM-4.7 Coding", ContextWindow: 128000, InputPrice: 1.0, OutputPrice: 1.0, SupportsTools: true},
				},
				AttemptTimeoutMs: 1000,
			},
			"minimax": {
				Enabled: true,
				Key:     os.Getenv("MINIMAX_API_KEY"),
				Models: []ModelConfig{
					{ID: "MiniMax-M3", Name: "MiniMax M3", ContextWindow: 1000000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true, Source: "openrouter-verified"},
					{ID: "MiniMax-M2.5", Name: "MiniMax M2.5", ContextWindow: 196608, InputPrice: 0.5, OutputPrice: 1.0, SupportsTools: true},
				},
				AttemptTimeoutMs: 1000,
			},
			"openrouter": {
				Enabled: true,
				Key:     os.Getenv("OPENROUTER_API_KEY"),
				BaseURL: "https://openrouter.ai/api/v1",
				Models: []ModelConfig{
					{ID: "qwen/qwen3-coder:free", Name: "Qwen 3 Coder (Free)", ContextWindow: 262000, IsFree: true, SupportsTools: true, AccessMode: "free", Recommended: true},
					{ID: "openrouter/free", Name: "OpenRouter Free Router", ContextWindow: 200000, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "nex-agi/nex-n2-pro:free", Name: "Nex AGI N2 Pro (Free)", ContextWindow: 32768, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "nvidia/nemotron-3-ultra:free", Name: "Nemotron 3 Ultra (Free)", ContextWindow: 262144, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "minimax/minimax-m3", Name: "MiniMax M3 (OpenRouter)", ContextWindow: 1000000, InputPrice: 1.0, OutputPrice: 2.0, SupportsTools: true},
					{ID: "google/gemma-4-26b-a4b-it:free", Name: "Gemma 4 26B (Free)", ContextWindow: 262144, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "google/gemma-4-31b-it:free", Name: "Gemma 4 31B (Free)", ContextWindow: 262144, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "meta-llama/llama-3.3-70b-instruct:free", Name: "Llama 3.3 70B (Free)", ContextWindow: 128000, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "nvidia/nemotron-3-super-120b-a12b:free", Name: "Nemotron 3 Super (Free)", ContextWindow: 262144, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "minimax/minimax-m2.5:free", Name: "MiniMax M2.5 (Free)", ContextWindow: 196608, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "arcee-ai/trinity-large-preview:free", Name: "Trinity Large (Free)", ContextWindow: 131000, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "liquid/lfm-2.5-1.2b-thinking:free", Name: "LFM 2.5 Thinking (Free)", ContextWindow: 32768, IsFree: true, SupportsTools: true, AccessMode: "free"},
					{ID: "qwen/qwen3-next-80b-a3b-instruct:free", Name: "Qwen 3 Next (Free)", ContextWindow: 262144, IsFree: true, SupportsTools: true, AccessMode: "free"},
				},
				AttemptTimeoutMs: 1000,
			},
		},
		DefaultProvider: "grik",
		DefaultModel:    "qwen/qwen3-coder:free",
		BYOK: BYOKConfig{
			Enabled:             true,
			ShowServerProviders: true,
		},
	}
}

// FindConfigFile looks for providers.yaml in standard locations
func FindConfigFile() string {
	// Look in local project during dev
	execPath, _ := os.Executable()
	execDir := filepath.Dir(execPath)
	cwd, _ := os.Getwd()
	projectPaths := []string{
		filepath.Join(cwd, "config", "providers.yaml"),
		filepath.Join(cwd, "core", "config", "providers.yaml"),
		filepath.Join(execDir, "config", "providers.yaml"),
		filepath.Join(execDir, "..", "config", "providers.yaml"),
		filepath.Join(execDir, "..", "..", "core", "config", "providers.yaml"),
		"config/providers.yaml",
		"core/config/providers.yaml",
	}

	for _, p := range projectPaths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	// Check home directory
	home, _ := os.UserHomeDir()
	if home != "" {
		path := filepath.Join(home, ".ricochet", "providers.yaml")
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}

	// Check /etc for server deployment
	if _, err := os.Stat("/etc/ricochet/providers.yaml"); err == nil {
		return "/etc/ricochet/providers.yaml"
	}

	return ""
}
