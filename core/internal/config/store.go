package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ContextSettings controls context window management
type ContextSettings struct {
	AutoCondense               bool `json:"auto_condense"`                 // Enable automatic context condensation
	CondenseThreshold          int  `json:"condense_threshold"`            // % of context at which to trigger condensation (default: 70)
	SlidingWindowSize          int  `json:"sliding_window_size"`           // Fallback: how many messages to keep (default: 20)
	ShowContextIndicator       bool `json:"show_context_indicator"`        // Show context % in UI
	EnableCheckpoints          bool `json:"enable_checkpoints"`            // Enable workspace checkpointing
	CheckpointOnWrites         bool `json:"checkpoint_on_writes"`          // Auto-checkpoint after write operations
	EnableCodeIndex            bool `json:"enable_code_index"`             // Enable semantic indexing for code_search
	WorkspaceIndexEnabled      bool `json:"workspace_index_enabled"`       // Enable cheap local workspace manifest/outlines
	WorkspaceIndexAutoBriefing bool `json:"workspace_index_auto_briefing"` // Allow optional LLM project briefing on workspace open
	CloudIndexEnabled          bool `json:"cloud_index_enabled"`           // Opt-in only; no upload when false
	MaxFragmentTokens          int  `json:"max_fragment_tokens"`           // Hard budget for individual context fragments
	ShowContributorPanel       bool `json:"show_contributor_panel"`        // Show context contributor diagnostics in UI
}

// AutoApprovalSettings controls which actions can run without user confirmation
type AutoApprovalSettings struct {
	Enabled             bool    `json:"enabled"`                // Master switch for auto-approval
	ReadFiles           bool    `json:"read_files"`             // Read files in workspace
	ReadFilesExternal   bool    `json:"read_files_external"`    // Read files outside workspace
	EditFiles           bool    `json:"edit_files"`             // Edit files in workspace
	EditFilesExternal   bool    `json:"edit_files_external"`    // Edit files outside workspace
	ExecuteSafeCommands bool    `json:"execute_safe_commands"`  // Run safe commands (ls, cat, etc.)
	ExecuteAllCommands  bool    `json:"execute_all_commands"`   // Run any command (dangerous!)
	DeleteFiles         bool    `json:"delete_files"`           // Delete files in workspace
	DeleteFilesExternal bool    `json:"delete_files_external"`  // Delete files outside workspace
	UseBrowser          bool    `json:"use_browser"`            // Browser automation
	UseMCP              bool    `json:"use_mcp"`                // MCP server tools
	EnableNotifications bool    `json:"enable_notifications"`   // Enable system notifications
	MaxRequests         int     `json:"max_requests,omitempty"` // 0 means unlimited
	MaxCostUSD          float64 `json:"max_cost_usd,omitempty"` // 0 means unlimited
}

type ModeModel struct {
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
}

type ModeModelSettings struct {
	Enabled bool      `json:"enabled,omitempty"`
	Plan    ModeModel `json:"plan,omitempty"`
	Act     ModeModel `json:"act,omitempty"`
}

type TerminalSettings struct {
	OutputLineLimit int `json:"output_line_limit,omitempty"`
}

type ToolsSettings struct {
	DisableLLMCorrection bool `json:"disable_llm_correction"`
}

type SkillConfigEntry struct {
	Name        string `json:"name,omitempty"`
	ContentPath string `json:"content_path,omitempty"`
	Enabled     *bool  `json:"enabled,omitempty"`
	Visibility  string `json:"visibility,omitempty"`
}

type SkillsSettings struct {
	Config []SkillConfigEntry `json:"config,omitempty"`
}

type AuthSettings struct {
	GrikAccessToken  string `json:"grik_access_token,omitempty"`
	GrikRefreshToken string `json:"grik_refresh_token,omitempty"`
	GrikExpiresAt    int64  `json:"grik_expires_at,omitempty"`
}

type Settings struct {
	Tools                    ToolsSettings        `json:"tools"`
	Provider                 ProviderSettings     `json:"provider"`
	Auth                     AuthSettings         `json:"auth,omitempty"`
	LiveMode                 LiveModeSettings     `json:"live_mode"`
	Context                  ContextSettings      `json:"context"`
	AutoApproval             AutoApprovalSettings `json:"auto_approval"`
	ModeModels               ModeModelSettings    `json:"mode_models,omitempty"`
	Terminal                 TerminalSettings     `json:"terminal,omitempty"`
	Skills                   SkillsSettings       `json:"skills,omitempty"`
	Theme                    string               `json:"theme"`
	CustomInstructions       string               `json:"custom_instructions,omitempty"`
	HidePromptTrainingModels bool                 `json:"hide_prompt_training_models,omitempty"`
}

type ProviderSettings struct {
	Provider          string            `json:"provider"` // "anthropic", "openai", "openrouter"
	Model             string            `json:"model"`
	APIKey            string            `json:"api_key"`                      // Legacy single key (backwards compat)
	APIKeys           map[string]string `json:"api_keys,omitempty"`           // Per-provider keys
	EmbeddingProvider string            `json:"embedding_provider,omitempty"` // Separate provider for embeddings (e.g. openai)
	EmbeddingModel    string            `json:"embedding_model,omitempty"`    // Model for embeddings
	Temperature       float64           `json:"temperature,omitempty"`
	TopP              float64           `json:"top_p,omitempty"`
	MaxTokens         int               `json:"max_tokens,omitempty"`
}

type LiveModeSettings struct {
	Enabled                  bool     `json:"enabled"`
	TelegramToken            string   `json:"telegram_token"`
	TelegramChatID           int64    `json:"telegram_chat_id"`
	AllowedUserIDs           []int64  `json:"allowed_user_ids"`
	WhisperBinary            string   `json:"whisper_binary,omitempty"` // Path to whisper executable
	WhisperModel             string   `json:"whisper_model,omitempty"`  // Path to ggml model
	DiscordToken             string   `json:"discord_token,omitempty"`
	DiscordApplicationID     string   `json:"discord_application_id,omitempty"`
	DiscordGuildID           string   `json:"discord_guild_id,omitempty"`
	DiscordAllowedUserIDs    []string `json:"discord_allowed_user_ids,omitempty"`
	DiscordAllowedChannelIDs []string `json:"discord_allowed_channel_ids,omitempty"`
	DiscordRequireMention    bool     `json:"discord_require_mention"`
	DiscordTextMode          bool     `json:"discord_text_mode,omitempty"`
	AllowRemoteSessionStart  bool     `json:"allow_remote_session_start,omitempty"`
}

type Store struct {
	mu       sync.RWMutex
	path     string
	settings *Settings
}

func NewStore() (*Store, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home dir: %w", err)
	}

	configDir := filepath.Join(homeDir, ".ricochet")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create config dir: %w", err)
	}

	// Default provider uses an anonymous Grik free model; paid hosted models still require account access.
	defaultProvider := "grik"
	defaultModel := "qwen/qwen3-coder:free"
	defaultAPIKey := ""

	// Optional: Check for dev environment variables (local dev only)
	if envKey := os.Getenv("RICOCHET_OPENROUTER_KEY"); envKey != "" {
		defaultAPIKey = envKey
	} else if envKey := os.Getenv("RICOCHET_DEEPSEEK_KEY"); envKey != "" {
		defaultProvider = "deepseek"
		defaultModel = "deepseek-chat"
		defaultAPIKey = envKey
	} else if envKey := os.Getenv("RICOCHET_GEMINI_KEY"); envKey != "" {
		defaultProvider = "gemini"
		defaultModel = "gemini-3-flash"
		defaultAPIKey = envKey
	} else if envKey := os.Getenv("RICOCHET_MOONSHOT_KEY"); envKey != "" {
		defaultProvider = "moonshot"
		defaultModel = "moonshot-v1-8k"
		defaultAPIKey = envKey
	} else if envKey := os.Getenv("RICOCHET_ZHIPU_KEY"); envKey != "" {
		defaultProvider = "zhipu"
		defaultModel = "glm-4-flash"
		defaultAPIKey = envKey
	}

	store := &Store{
		path: filepath.Join(configDir, "settings.json"),
		settings: &Settings{
			Provider: ProviderSettings{
				Provider:    defaultProvider,
				Model:       defaultModel,
				APIKey:      defaultAPIKey,
				APIKeys:     map[string]string{},
				Temperature: 0,
				TopP:        1,
				MaxTokens:   4096,
			},
			LiveMode: LiveModeSettings{
				DiscordRequireMention: true,
			},
			Context: ContextSettings{
				AutoCondense:               true,
				CondenseThreshold:          70,
				SlidingWindowSize:          20,
				ShowContextIndicator:       true,
				EnableCheckpoints:          true,
				CheckpointOnWrites:         true,
				EnableCodeIndex:            true,
				WorkspaceIndexEnabled:      true,
				WorkspaceIndexAutoBriefing: false,
				CloudIndexEnabled:          false,
				MaxFragmentTokens:          10000,
				ShowContributorPanel:       true,
			},
			AutoApproval: AutoApprovalSettings{
				Enabled:             false,
				ReadFiles:           false,
				ReadFilesExternal:   false,
				EditFiles:           false,
				EditFilesExternal:   false,
				ExecuteSafeCommands: false,
				ExecuteAllCommands:  false,
				DeleteFiles:         false,
				DeleteFilesExternal: false,
				UseBrowser:          false,
				UseMCP:              false,
			},
			ModeModels: ModeModelSettings{},
			Terminal: TerminalSettings{
				OutputLineLimit: 500,
			},
			Tools: ToolsSettings{
				DisableLLMCorrection: false, // Default enabled
			},
			Theme: "dark",
		},
	}

	if err := store.Load(); err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("failed to load settings: %w", err)
		}
		// If file doesn't exist, save default
		if err := store.Save(); err != nil {
			return nil, fmt.Errorf("failed to save default settings: %w", err)
		}
	}

	return store, nil
}

func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}

	var settings Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("failed to parse settings.json: %w", err)
	}
	if !settingsHasLiveModeField(data, "discord_require_mention") {
		settings.LiveMode.DiscordRequireMention = true
	}
	normalizeSettings(&settings)

	s.settings = &settings
	return nil
}

func settingsHasLiveModeField(data []byte, field string) bool {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return false
	}
	liveRaw, ok := root["live_mode"]
	if !ok {
		return false
	}
	var live map[string]json.RawMessage
	if err := json.Unmarshal(liveRaw, &live); err != nil {
		return false
	}
	_, ok = live[field]
	return ok
}

func normalizeSettings(settings *Settings) {
	if settings.Provider.APIKeys == nil {
		settings.Provider.APIKeys = make(map[string]string)
	}
	if settings.Auth.GrikAccessToken != "" {
		settings.Provider.APIKeys["grik"] = settings.Auth.GrikAccessToken
		if settings.Provider.Provider == "grik" {
			settings.Provider.APIKey = settings.Auth.GrikAccessToken
		}
	}
	if settings.Provider.TopP == 0 {
		settings.Provider.TopP = 1
	}
	if settings.Provider.MaxTokens == 0 {
		settings.Provider.MaxTokens = 4096
	}
	if settings.Context.CondenseThreshold == 0 {
		settings.Context.CondenseThreshold = 70
	}
	if settings.Context.SlidingWindowSize == 0 {
		settings.Context.SlidingWindowSize = 20
	}
	if settings.Context.MaxFragmentTokens == 0 {
		settings.Context.MaxFragmentTokens = 10000
	}
	if settings.Context.EnableCodeIndex && !settings.Context.WorkspaceIndexEnabled {
		settings.Context.WorkspaceIndexEnabled = true
	}
	if settings.Context.AutoCondense && !settings.Context.ShowContributorPanel {
		settings.Context.ShowContributorPanel = true
	}
	if settings.Terminal.OutputLineLimit <= 0 {
		settings.Terminal.OutputLineLimit = 500
	}
	settings.Skills.Config = normalizeSkillConfig(settings.Skills.Config)
	if !settings.Context.AutoCondense && !settings.Context.ShowContextIndicator && !settings.Context.EnableCheckpoints && !settings.Context.CheckpointOnWrites && !settings.Context.EnableCodeIndex {
		settings.Context.AutoCondense = true
		settings.Context.ShowContextIndicator = true
		settings.Context.EnableCheckpoints = true
		settings.Context.CheckpointOnWrites = true
		settings.Context.EnableCodeIndex = true
		settings.Context.WorkspaceIndexEnabled = true
		settings.Context.MaxFragmentTokens = 10000
		settings.Context.ShowContributorPanel = true
	}
}

func normalizeSkillConfig(entries []SkillConfigEntry) []SkillConfigEntry {
	if len(entries) == 0 {
		return nil
	}
	out := make([]SkillConfigEntry, 0, len(entries))
	seen := make(map[string]int, len(entries))
	for _, entry := range entries {
		entry.Name = strings.TrimSpace(entry.Name)
		entry.ContentPath = strings.TrimSpace(entry.ContentPath)
		entry.Visibility = normalizeSkillVisibility(entry.Visibility)
		if entry.Name == "" && entry.ContentPath == "" {
			continue
		}
		key := entry.ContentPath
		if key == "" {
			key = "name:" + entry.Name
		}
		if idx, ok := seen[key]; ok {
			out[idx] = entry
			continue
		}
		seen[key] = len(out)
		out = append(out, entry)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeSkillVisibility(value string) string {
	switch strings.TrimSpace(value) {
	case "", "on", "name-only", "user-invocable-only", "off":
		return strings.TrimSpace(value)
	default:
		return ""
	}
}

func (s *Store) Save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, err := json.MarshalIndent(s.settings, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal settings: %w", err)
	}

	return os.WriteFile(s.path, data, 0644)
}

func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return *s.settings
}

func (s *Store) Update(fn func(*Settings)) error {
	s.mu.Lock()
	fn(s.settings)
	s.mu.Unlock()
	return s.Save()
}
