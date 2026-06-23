package main

import (
	"log"

	"github.com/igoryan-dao/ricochet/internal/agent"
	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/livemode"
	"github.com/igoryan-dao/ricochet/internal/prompts"
)

func initRuntime(cwd string) (*config.ProvidersManager, error) {
	var err error
	settingsStore, err = config.NewStore()
	if err != nil {
		return nil, err
	}

	settings := settingsStore.Get()
	pm, err := config.NewProvidersManager(config.FindConfigFile())
	if err != nil {
		log.Printf("Warning: Failed to initialize ProvidersManager: %v", err)
	}
	if pm != nil {
		for providerID, key := range settings.Provider.APIKeys {
			pm.SetUserKey(providerID, key)
		}
		if settings.Provider.APIKey != "" && settings.Provider.Provider != "" {
			pm.SetUserKey(settings.Provider.Provider, settings.Provider.APIKey)
		}
	}

	cfg = &agent.Config{
		Provider: agent.ProviderConfig{
			Provider:    settings.Provider.Provider,
			Model:       settings.Provider.Model,
			APIKey:      settings.Provider.APIKey,
			Temperature: settings.Provider.Temperature,
			TopP:        settings.Provider.TopP,
			MaxTokens:   settings.Provider.MaxTokens,
		},
		SystemPrompt:       prompts.BuildSystemPrompt(cwd),
		MaxTokens:          4096,
		ContextWindow:      128000,
		EnableCodeIndex:    settings.Context.EnableCodeIndex,
		Context:            settings.Context,
		AutoApproval:       &settings.AutoApproval,
		ModeModels:         settings.ModeModels,
		Terminal:           settings.Terminal,
		CustomInstructions: settings.CustomInstructions,
	}

	if cfg.Provider.APIKey == "" && pm != nil {
		if resolvedKey := pm.GetAPIKey(cfg.Provider.Provider); resolvedKey != "" {
			log.Printf("Resolved initial API Key for %s from ProvidersManager", cfg.Provider.Provider)
			cfg.Provider.APIKey = resolvedKey
		}
	}

	if settings.Provider.EmbeddingProvider != "" {
		embKey := settings.Provider.APIKeys[settings.Provider.EmbeddingProvider]
		if embKey == "" && settings.Provider.Provider == settings.Provider.EmbeddingProvider {
			embKey = settings.Provider.APIKey
		}
		cfg.EmbeddingProvider = &agent.ProviderConfig{
			Provider: settings.Provider.EmbeddingProvider,
			Model:    settings.Provider.EmbeddingModel,
			APIKey:   embKey,
		}
	}

	liveModeConfig = &livemode.Config{
		TelegramToken:            settings.LiveMode.TelegramToken,
		TelegramChatID:           settings.LiveMode.TelegramChatID,
		AllowedUserIDs:           settings.LiveMode.AllowedUserIDs,
		WhisperBinary:            settings.LiveMode.WhisperBinary,
		WhisperModel:             settings.LiveMode.WhisperModel,
		DiscordToken:             settings.LiveMode.DiscordToken,
		DiscordApplicationID:     settings.LiveMode.DiscordApplicationID,
		DiscordGuildID:           settings.LiveMode.DiscordGuildID,
		DiscordAllowedUserIDs:    settings.LiveMode.DiscordAllowedUserIDs,
		DiscordAllowedChannelIDs: settings.LiveMode.DiscordAllowedChannelIDs,
		DiscordRequireMention:    settings.LiveMode.DiscordRequireMention,
		DiscordTextMode:          settings.LiveMode.DiscordTextMode,
		AllowRemoteSessionStart:  settings.LiveMode.AllowRemoteSessionStart,
	}
	return pm, nil
}
