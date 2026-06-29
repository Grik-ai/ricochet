package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/agent"
	"github.com/igoryan-dao/ricochet/internal/batch"
	"github.com/igoryan-dao/ricochet/internal/checkpoints"
	"github.com/igoryan-dao/ricochet/internal/codegraph"
	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/keepawake"
	"github.com/igoryan-dao/ricochet/internal/livemode"
	"github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/modes"
	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
	"github.com/igoryan-dao/ricochet/internal/skills"
	"github.com/igoryan-dao/ricochet/internal/whisper"
	"github.com/igoryan-dao/ricochet/internal/workflow"
)

// ResponseWriter interface allows different transports (Stdio, WS) to send responses
type ResponseWriter interface {
	Send(msg interface{}) error
}

// Handler manages the application state and processes RPC messages
type Handler struct {
	Agent          *agent.Controller
	LiveMode       *livemode.Controller
	Checkpoint     *checkpoints.CheckpointService
	Batch          *batch.Manager
	BatchRunner    *batch.Runner
	Providers      *config.ProvidersManager
	Config         *agent.Config
	LiveModeConfig *livemode.Config
	Settings       *config.Store
	Host           host.Host // StdioHost or other
	Modes          *modes.Manager
	McpHub         *mcp.Hub
	Codegraph      *codegraph.Service
	Workflows      *workflow.Manager
	Transcriber    *whisper.Transcriber
	AudioBuffer    []byte
	AudioMu        sync.Mutex
	InitMu         sync.Mutex // Protects lazy init of Agent
	GlobalCtx      context.Context
	OnEvent        func(agent.Event)         `json:"-"`
	OnBatchEvent   func(protocol.BatchEvent) `json:"-"`

	StartedAt             time.Time `json:"-"`
	HealthMu              sync.RWMutex
	ActiveChat            bool
	ActiveRunsMu          sync.RWMutex
	ActiveRuns            map[string]string
	LastProviderRequestAt int64
	LastProviderSuccessAt int64
	LastProviderError     string
	LastProviderCategory  string
	LastProviderLatencyMs int64
}

// NewHandler creates a new handler with initial state
func NewHandler(
	ctx context.Context,
	cfg *agent.Config,
	liveCfg *livemode.Config,
	settings *config.Store,
	host host.Host,
	modes *modes.Manager,
	mcp *mcp.Hub,
	cg *codegraph.Service,
	wm *workflow.Manager,
	pm *config.ProvidersManager,
	liveCtrl *livemode.Controller,
) *Handler {
	return &Handler{
		GlobalCtx:      ctx,
		Config:         cfg,
		LiveModeConfig: liveCfg,
		LiveMode:       liveCtrl,
		Settings:       settings,
		Host:           host,
		Modes:          modes,
		McpHub:         mcp,
		Codegraph:      cg,
		Workflows:      wm,
		Providers:      pm,
		StartedAt:      time.Now(),
	}
}

func (h *Handler) getLiveModeStatus() *livemode.Status {
	if h.LiveMode != nil {
		return h.LiveMode.GetStatus()
	}

	var telegramToken string
	var telegramChatID int64
	var discordToken string
	var discordApplicationID string
	allowRemoteSessionStart := false

	if h.Settings != nil {
		settings := h.Settings.Get()
		telegramToken = settings.LiveMode.TelegramToken
		telegramChatID = settings.LiveMode.TelegramChatID
		discordToken = settings.LiveMode.DiscordToken
		discordApplicationID = settings.LiveMode.DiscordApplicationID
		allowRemoteSessionStart = settings.LiveMode.AllowRemoteSessionStart
	}
	if h.LiveModeConfig != nil {
		if h.LiveModeConfig.TelegramToken != "" {
			telegramToken = h.LiveModeConfig.TelegramToken
		}
		if h.LiveModeConfig.TelegramChatID != 0 {
			telegramChatID = h.LiveModeConfig.TelegramChatID
		}
		if h.LiveModeConfig.DiscordToken != "" {
			discordToken = h.LiveModeConfig.DiscordToken
		}
		if h.LiveModeConfig.DiscordApplicationID != "" {
			discordApplicationID = h.LiveModeConfig.DiscordApplicationID
		}
		allowRemoteSessionStart = h.LiveModeConfig.AllowRemoteSessionStart
	}

	return &livemode.Status{
		Enabled:                 false,
		AllowRemoteSessionStart: allowRemoteSessionStart,
		Channels: map[string]livemode.ChannelStatus{
			"telegram": {
				Configured: strings.TrimSpace(telegramToken) != "" || telegramChatID != 0,
				Active:     false,
				Label:      "Telegram",
			},
			"discord": {
				Configured: strings.TrimSpace(discordToken) != "" || strings.TrimSpace(discordApplicationID) != "",
				Active:     false,
				Label:      "Discord",
			},
		},
	}
}

func (h *Handler) setActiveChat(active bool) {
	h.HealthMu.Lock()
	h.ActiveChat = active
	h.HealthMu.Unlock()
}

func (h *Handler) isSessionActive(sessionID string) bool {
	h.ActiveRunsMu.RLock()
	defer h.ActiveRunsMu.RUnlock()
	if h.ActiveRuns == nil {
		return false
	}
	return h.ActiveRuns[sessionID] != ""
}

func (h *Handler) setSessionActive(sessionID, runID string, active bool) {
	h.ActiveRunsMu.Lock()
	if h.ActiveRuns == nil {
		h.ActiveRuns = make(map[string]string)
	}
	if active {
		h.ActiveRuns[sessionID] = runID
	} else {
		delete(h.ActiveRuns, sessionID)
	}
	activeChat := len(h.ActiveRuns) > 0
	h.ActiveRunsMu.Unlock()
	h.setActiveChat(activeChat)
}

func (h *Handler) recordProviderEvent(e agent.Event) {
	switch string(e.Type) {
	case string(agent.EventProviderRequestStarted):
		h.HealthMu.Lock()
		h.LastProviderRequestAt = time.Now().UnixMilli()
		h.HealthMu.Unlock()
	case string(agent.EventProviderRequestSucceeded):
		h.HealthMu.Lock()
		h.LastProviderRequestAt = payloadInt64(e.Payload, "timestamp", time.Now().UnixMilli())
		h.LastProviderSuccessAt = h.LastProviderRequestAt
		h.LastProviderLatencyMs = payloadInt64(e.Payload, "latency_ms", 0)
		h.LastProviderError = ""
		h.LastProviderCategory = ""
		h.HealthMu.Unlock()
	case string(agent.EventProviderRequestRetrying), string(agent.EventProviderRequestFailed):
		h.HealthMu.Lock()
		h.LastProviderRequestAt = payloadInt64(e.Payload, "timestamp", time.Now().UnixMilli())
		h.LastProviderLatencyMs = payloadInt64(e.Payload, "latency_ms", 0)
		if errText, ok := e.Payload["error"].(string); ok {
			h.LastProviderError = errText
		}
		if category, ok := e.Payload["category"].(string); ok {
			h.LastProviderCategory = category
		}
		h.HealthMu.Unlock()
	}
}

func payloadInt64(payload map[string]interface{}, key string, fallback int64) int64 {
	if payload == nil {
		return fallback
	}
	switch value := payload[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	default:
		return fallback
	}
}

func (h *Handler) healthSnapshot() map[string]interface{} {
	h.HealthMu.RLock()
	activeChat := h.ActiveChat
	lastProviderRequestAt := h.LastProviderRequestAt
	lastProviderSuccessAt := h.LastProviderSuccessAt
	lastProviderError := h.LastProviderError
	lastProviderCategory := h.LastProviderCategory
	lastProviderLatencyMs := h.LastProviderLatencyMs
	h.HealthMu.RUnlock()

	provider := ""
	model := ""
	baseURL := ""
	if h.Config != nil {
		provider = h.Config.Provider.Provider
		model = h.Config.Provider.Model
		baseURL = h.Config.Provider.BaseURL
	}

	return map[string]interface{}{
		"ok":                       true,
		"timestamp":                time.Now().UnixMilli(),
		"uptime_ms":                time.Since(h.StartedAt).Milliseconds(),
		"active_chat":              activeChat,
		"provider":                 provider,
		"model":                    model,
		"base_url":                 baseURL,
		"last_provider_request_at": lastProviderRequestAt,
		"last_provider_success_at": lastProviderSuccessAt,
		"last_provider_error":      lastProviderError,
		"last_provider_category":   lastProviderCategory,
		"last_provider_latency_ms": lastProviderLatencyMs,
	}
}

func (h *Handler) ensureCheckpointService() error {
	if h.Checkpoint != nil && h.Checkpoint.IsInitialized() {
		return nil
	}
	cwd := h.Host.GetCWD()
	taskID := paths.GetWorkspaceHash(cwd)
	service := checkpoints.NewCheckpointService(taskID, cwd, paths.GetShadowGitDir(cwd))
	if err := service.Init(); err != nil {
		return err
	}
	h.Checkpoint = service
	return nil
}

func (h *Handler) ensureBatchManager() error {
	if h.Batch != nil {
		return nil
	}
	cwd := h.Host.GetCWD()
	storageDir := filepath.Join(paths.GetGlobalDir(), "batch", paths.GetWorkspaceHash(cwd))
	manager, err := batch.NewManager(cwd, storageDir)
	if err != nil {
		return err
	}
	h.Batch = manager
	return nil
}

func (h *Handler) ensureBatchRunner() error {
	if err := h.ensureBatchManager(); err != nil {
		return err
	}
	if err := h.lazyInitAgent(); err != nil {
		return err
	}
	if h.BatchRunner != nil {
		return nil
	}
	runner := batch.NewRunner(h.Batch, &batchWorkerExecutor{handler: h})
	runner.SetEventHandler(func(event protocol.BatchEvent) {
		if h.OnBatchEvent != nil {
			h.OnBatchEvent(event)
		}
	})
	h.BatchRunner = runner
	return nil
}

// HandleMessage processes a single RPC message
func (h *Handler) HandleMessage(msg protocol.RPCMessage, writer ResponseWriter) {
	switch msg.Type {
	case "health_check":
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "health_check",
			Payload: protocol.EncodeRPC(h.healthSnapshot()),
		})

	case "get_state":
		var payload struct {
			SessionID string `json:"session_id"`
		}
		json.Unmarshal(msg.Payload, &payload)
		sessionID := payload.SessionID
		if sessionID == "" {
			sessionID = "default"
		}

		if h.Agent != nil {
			state := h.Agent.GetState(sessionID)
			writer.Send(protocol.RPCMessage{
				ID:      msg.ID,
				Type:    "state",
				Payload: protocol.EncodeRPC(state),
			})
		} else {
			writer.Send(protocol.RPCMessage{
				ID:   msg.ID,
				Type: "state",
				Payload: protocol.EncodeRPC(map[string]interface{}{
					"messages":        []interface{}{},
					"liveModeEnabled": false,
				}),
			})
		}

	case "list_sessions":
		if h.Agent != nil {
			sessions := h.Agent.ListSessions()
			writer.Send(protocol.RPCMessage{
				ID:      msg.ID,
				Type:    "session_list",
				Payload: protocol.EncodeRPC(map[string]interface{}{"sessions": sessions}),
			})
		} else {
			writer.Send(protocol.RPCMessage{
				ID:      msg.ID,
				Type:    "session_list",
				Payload: protocol.EncodeRPC(map[string]interface{}{"sessions": []interface{}{}}),
			})
		}

	case "create_session":
		var payload struct {
			SessionID string `json:"session_id"`
		}
		json.Unmarshal(msg.Payload, &payload)

		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}

		var session *agent.Session
		if payload.SessionID != "" {
			session = h.Agent.CreateSessionWithID(payload.SessionID)
		} else {
			session = h.Agent.CreateSession()
		}
		h.Agent.SetMainSessionID(session.ID)

		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "session_created",
			Payload: protocol.EncodeRPC(session),
		})

	case "hydrate_session":
		var payload struct {
			SessionID string             `json:"session_id"`
			Messages  []protocol.Message `json:"messages"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}

		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}

		h.Agent.HydrateSession(payload.SessionID, payload.Messages)
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "session_hydrated",
			Payload: protocol.EncodeRPC(map[string]bool{"success": true}),
		})

	case "delete_session":
		var payload struct {
			SessionID string `json:"session_id"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		if h.Agent != nil {
			h.Agent.DeleteSession(payload.SessionID)
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "session_deleted"})

	case "abort_chat":
		log.Printf("Received abort_chat request")
		var payload struct {
			SessionID string `json:"session_id"`
			RunID     string `json:"run_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		success := false
		if h.Agent != nil {
			switch {
			case payload.SessionID != "" && payload.RunID != "":
				success = h.Agent.AbortRun(payload.SessionID, payload.RunID)
			case payload.SessionID != "":
				success = h.Agent.AbortSession(payload.SessionID)
			default:
				h.Agent.AbortCurrentSession()
				success = true
			}
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "aborted", Payload: protocol.EncodeRPC(map[string]bool{"success": success})})

	case "plan_decision":
		var payload struct {
			SessionID  string `json:"session_id"`
			ArtifactID string `json:"artifact_id"`
			Path       string `json:"path"`
			Decision   string `json:"decision"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: fmt.Sprintf("Failed to initialize AI provider: %v", err)})
				return
			}
		}
		log.Printf("[PlanDecision] received session_id=%s artifact_id=%s path=%s decision=%s webview_timeline_mutated=false", payload.SessionID, payload.ArtifactID, payload.Path, payload.Decision)
		decision, err := h.Agent.HandlePlanDecision(payload.SessionID, payload.ArtifactID, payload.Path, payload.Decision)
		if err != nil {
			log.Printf("[PlanDecision] failed session_id=%s artifact_id=%s decision=%s error=%v webview_timeline_mutated=false", payload.SessionID, payload.ArtifactID, payload.Decision, err)
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		log.Printf("[PlanDecision] applied session_id=%s artifact_id=%s normalized_decision=%s webview_timeline_mutated=false", payload.SessionID, payload.ArtifactID, decision)
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "plan_decision_result",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"ok":           true,
				"session_id":   payload.SessionID,
				"artifact_id":  payload.ArtifactID,
				"path":         payload.Path,
				"decision":     decision,
				"planApproved": decision == "implement",
			}),
		})

	case "chat_message":
		var payload struct {
			Content string `json:"content"`
		}
		// First pass to get content for logging
		json.Unmarshal(msg.Payload, &payload)
		log.Printf("Received chat message: %s", payload.Content)

		credentialMode := h.Config.Provider.CredentialMode
		modelKnown := true
		if h.Providers != nil {
			if mode, ok := h.Providers.ModelCredentialMode(h.Config.Provider.Provider, h.Config.Provider.Model); ok {
				credentialMode = mode
				h.Config.Provider.CredentialMode = mode
			} else {
				modelKnown = false
			}
		}
		if credentialMode == "none" {
			h.Config.Provider.APIKey = ""
		}

		if !modelKnown {
			writer.Send(protocol.RPCMessage{
				ID:    msg.ID,
				Type:  "response",
				Error: fmt.Sprintf("Selected model %s/%s is not available. Choose another model in Settings.", h.Config.Provider.Provider, h.Config.Provider.Model),
			})
			return
		}

		if h.Config.Provider.APIKey == "" && h.Providers != nil && credentialMode != "none" {
			// Fallback: try to resolve from ProvidersManager if missing in Config
			resolved := h.Providers.GetAPIKey(h.Config.Provider.Provider)
			if resolved != "" {
				h.Config.Provider.APIKey = resolved
				log.Printf("[Handler] Resolved missing API key for %s from ProvidersManager", h.Config.Provider.Provider)
			}
		}

		if h.Config.Provider.APIKey == "" && credentialMode != "none" {
			errorMessage := fmt.Sprintf("API key required for %s. Open Settings → Models and add a provider API key.", h.Config.Provider.Provider)
			if credentialMode == "grik_account" || h.Providers != nil && h.Providers.ModelRequiresGrikAccount(h.Config.Provider.Provider, h.Config.Provider.Model) {
				errorMessage = "Sign in to Grik or upgrade your account to use this hosted Ricochet model."
			}
			writer.Send(protocol.RPCMessage{
				ID:    msg.ID,
				Type:  "response",
				Error: errorMessage,
			})
			return
		}

		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{
					ID:    msg.ID,
					Type:  "response",
					Error: fmt.Sprintf("Failed to initialize AI provider: %v", err),
				})
				return
			}
		}

		var fullPayload struct {
			Content      string                           `json:"content"`
			SessionID    string                           `json:"session_id"`
			Via          string                           `json:"via"`
			RunID        string                           `json:"run_id"`
			PlanMode     bool                             `json:"plan_mode,omitempty"`
			ContextFiles []protocol.ContextFileAttachment `json:"context_files,omitempty"`
			Delivery     string                           `json:"delivery,omitempty"`
		}
		if err := json.Unmarshal(msg.Payload, &fullPayload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}

		sessionID := fullPayload.SessionID
		if sessionID == "" {
			sessionID = "default"
		}

		if h.isSessionActive(sessionID) {
			var queued protocol.QueuedMessage
			var ok bool
			if strings.EqualFold(fullPayload.Delivery, "steer") {
				queued, ok = h.Agent.SteerQueuedMessageWithContextFiles(sessionID, fullPayload.RunID, fullPayload.Content, fullPayload.Via, fullPayload.ContextFiles)
			} else {
				queued, ok = h.Agent.EnqueueUserMessageWithContextFiles(sessionID, fullPayload.RunID, fullPayload.Content, fullPayload.Via, fullPayload.ContextFiles)
			}
			if ok {
				writer.Send(protocol.RPCMessage{
					ID:   msg.ID,
					Type: "message_queued",
					Payload: protocol.EncodeRPC(map[string]interface{}{
						"session_id": sessionID,
						"run_id":     fullPayload.RunID,
						"message":    queued,
					}),
				})
				return
			}
		}

		sendUpdate := func(update interface{}) {
			switch u := update.(type) {
			case agent.ChatUpdate:
				if u.Message != nil {
					writer.Send(protocol.RPCMessage{
						Type: "chat_update",
						Payload: protocol.EncodeRPC(map[string]interface{}{
							"session_id": u.SessionID,
							"run_id":     u.RunID,
							"message":    u.Message,
							"usage":      u.Usage,
						}),
					})
				}
				if u.ContextStatus != nil {
					writer.Send(protocol.RPCMessage{
						Type:    "context_status",
						Payload: protocol.EncodeRPC(u.ContextStatus),
					})
				}
				if u.Usage != nil {
					writer.Send(protocol.RPCMessage{
						Type:    "usage_update",
						Payload: protocol.EncodeRPC(u.Usage),
					})
				}
			case protocol.TaskProgress:
				writer.Send(protocol.RPCMessage{
					Type:    "task_progress",
					Payload: protocol.EncodeRPC(u),
				})
			case protocol.CommandEvent:
				writer.Send(protocol.RPCMessage{
					Type:    "command_event",
					Payload: protocol.EncodeRPC(u),
				})
			case protocol.ToolLifecycleEvent:
				writer.Send(protocol.RPCMessage{
					Type:    "tool_lifecycle",
					Payload: protocol.EncodeRPC(u),
				})
			case protocol.ContextCompactionEvent:
				writer.Send(protocol.RPCMessage{
					Type:    "context_compaction",
					Payload: protocol.EncodeRPC(u),
				})
			case protocol.CheckpointEvent:
				writer.Send(protocol.RPCMessage{
					Type:    "checkpoint_event",
					Payload: protocol.EncodeRPC(u),
				})
			}
		}

		h.setSessionActive(sessionID, fullPayload.RunID, true)
		awake, awakeErr := keepawake.Start("ricochet active run")
		if awakeErr != nil {
			log.Printf("Warning: keep-awake unavailable: %v", awakeErr)
		}
		err := h.Agent.Chat(h.GlobalCtx, agent.ChatRequestInput{
			SessionID:    sessionID,
			Content:      fullPayload.Content,
			Via:          fullPayload.Via,
			RunID:        fullPayload.RunID,
			PlanMode:     fullPayload.PlanMode,
			ContextFiles: fullPayload.ContextFiles,
		}, sendUpdate)
		awake.Stop()
		h.setSessionActive(sessionID, fullPayload.RunID, false)

		if err == nil {
			for _, queued := range h.Agent.DrainQueuedMessages(sessionID) {
				h.setSessionActive(queued.SessionID, queued.RunID, true)
				awake, awakeErr := keepawake.Start("ricochet queued run")
				if awakeErr != nil {
					log.Printf("Warning: keep-awake unavailable: %v", awakeErr)
				}
				qErr := h.Agent.Chat(h.GlobalCtx, agent.ChatRequestInput{
					SessionID:    queued.SessionID,
					Content:      queued.Text,
					Via:          queued.Via,
					RunID:        queued.RunID,
					ContextFiles: queued.ContextFiles,
				}, sendUpdate)
				awake.Stop()
				h.setSessionActive(queued.SessionID, queued.RunID, false)
				if qErr != nil {
					writer.Send(protocol.RPCMessage{
						Type:  "queued_message_error",
						Error: qErr.Error(),
						Payload: protocol.EncodeRPC(map[string]interface{}{
							"session_id": queued.SessionID,
							"run_id":     queued.RunID,
							"message_id": queued.ID,
							"error":      qErr.Error(),
						}),
					})
				}
			}
		}

		if err != nil {
			log.Printf("Chat error: %v", err)
			writer.Send(protocol.RPCMessage{
				ID:    msg.ID,
				Type:  "response",
				Error: err.Error(),
			})
		} else {
			writer.Send(protocol.RPCMessage{
				ID:      msg.ID,
				Type:    "response",
				Payload: protocol.EncodeRPC(map[string]interface{}{"status": "done"}),
			})
		}

	case "update_queued_message":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		var payload struct {
			SessionID string `json:"session_id"`
			MessageID string `json:"message_id"`
			Content   string `json:"content"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		if payload.SessionID == "" {
			payload.SessionID = "default"
		}
		queued, ok := h.Agent.UpdateQueuedMessage(payload.SessionID, payload.MessageID, payload.Content)
		if !ok {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "queued message not found or invalid update"})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "queued_message_updated",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"session_id": payload.SessionID,
				"message":    queued,
			}),
		})

	case "delete_queued_message":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		var payload struct {
			SessionID string `json:"session_id"`
			MessageID string `json:"message_id"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		if payload.SessionID == "" {
			payload.SessionID = "default"
		}
		if !h.Agent.DeleteQueuedMessage(payload.SessionID, payload.MessageID) {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "queued message not found"})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "queued_message_deleted",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"session_id":  payload.SessionID,
				"message_id":  payload.MessageID,
				"delete_kind": "queued_message",
			}),
		})

	case "get_tool_lifecycle_events":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		var payload struct {
			Limit int `json:"limit,omitempty"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		events, err := h.Agent.ReplayToolLifecycleEvents(payload.Limit)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "tool_lifecycle_events",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"events": events,
			}),
		})

	case "get_models":
		if h.Providers == nil {
			// Lazy init providers if needed
			configPath := config.FindConfigFile()
			pm, err := config.NewProvidersManager(configPath)
			if err != nil {
				log.Printf("get_models: Error creating ProvidersManager: %v", err)
			}
			h.Providers = pm
		}

		if h.Providers == nil {
			writer.Send(protocol.RPCMessage{
				ID:   msg.ID,
				Type: "response",
				Payload: protocol.EncodeRPC(map[string]interface{}{
					"providers":                   []interface{}{},
					"hide_prompt_training_models": false,
				}),
			})
			return
		}

		hidePromptTrainingModels := false
		if h.Settings != nil {
			s := h.Settings.Get()
			hidePromptTrainingModels = s.HidePromptTrainingModels
			for providerID, key := range s.Provider.APIKeys {
				h.Providers.SetUserKey(providerID, key)
			}
			if s.Provider.APIKey != "" && s.Provider.Provider != "" {
				h.Providers.SetUserKey(s.Provider.Provider, s.Provider.APIKey)
			}
		}

		if !strings.EqualFold(os.Getenv("RICOCHET_DISABLE_OPENROUTER_MODEL_SYNC"), "1") {
			syncCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if err := h.Providers.RefreshOpenRouterFreeModels(syncCtx); err != nil {
				log.Printf("get_models: OpenRouter free model sync skipped: %v", err)
			}
			cancel()
		}

		providers := h.Providers.GetAvailableProviders()
		providers = config.FilterPromptTrainingModels(providers, hidePromptTrainingModels)
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"providers":                   providers,
				"hide_prompt_training_models": hidePromptTrainingModels,
			}),
		})

	case "get_usage":
		var payload struct {
			SessionID string `json:"session_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		if payload.SessionID == "" {
			payload.SessionID = "default"
		}
		if h.Agent == nil {
			writer.Send(protocol.RPCMessage{
				ID:   msg.ID,
				Type: "response",
				Payload: protocol.EncodeRPC(map[string]interface{}{
					"sessionId": payload.SessionID,
				}),
			})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(h.Agent.GetUsageSnapshot(payload.SessionID)),
		})

	case "get_context_status":
		var payload struct {
			SessionID string `json:"session_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(h.Agent.GetContextStatus(payload.SessionID)),
		})

	case "compact_context_now":
		var payload struct {
			SessionID string `json:"session_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		status, event, err := h.Agent.CompactContextNow(h.GlobalCtx, payload.SessionID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"status": status,
				"event":  event,
			}),
		})

	case "checkpoint_preview_restore":
		if err := h.ensureCheckpointService(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			Hash           string `json:"hash"`
			CheckpointHash string `json:"checkpoint_hash"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		hash := payload.CheckpointHash
		if hash == "" {
			hash = payload.Hash
		}
		preview, err := h.Checkpoint.PreviewRestore(hash)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "checkpoint_restore_preview", Payload: protocol.EncodeRPC(preview)})

	case "checkpoint_restore":
		if err := h.ensureCheckpointService(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var req protocol.CheckpointRestoreRequest
		_ = json.Unmarshal(msg.Payload, &req)
		if req.CheckpointHash == "" {
			var legacy struct {
				Hash string `json:"hash"`
			}
			_ = json.Unmarshal(msg.Payload, &legacy)
			req.CheckpointHash = legacy.Hash
		}
		if req.Mode == "" {
			req.Mode = "full"
		}
		if !req.CreateSafetyCheckpoint && (req.Mode == "full" || req.Mode == "selected_files") {
			req.CreateSafetyCheckpoint = true
		}
		result, err := h.Checkpoint.RestoreWithOptions(req)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "checkpoint_restore_result", Payload: protocol.EncodeRPC(result)})

	case "checkpoint_create_patch":
		if err := h.ensureCheckpointService(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			Hash           string `json:"hash"`
			CheckpointHash string `json:"checkpoint_hash"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		hash := payload.CheckpointHash
		if hash == "" {
			hash = payload.Hash
		}
		patchPath, err := h.Checkpoint.CreatePatch(hash)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "checkpoint_patch", Payload: protocol.EncodeRPC(map[string]string{"patch_path": patchPath})})

	case "checkpoint_list":
		if err := h.ensureCheckpointService(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "checkpoint_list",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"checkpoints": h.Checkpoint.List(),
				"base_hash":   h.Checkpoint.BaseHash(),
			}),
		})

	case "batch_run_create":
		if err := h.ensureBatchManager(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var req batch.CreateRunRequest
		_ = json.Unmarshal(msg.Payload, &req)
		if err := h.ensureCheckpointService(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		checkpointHash, err := h.Checkpoint.Save("Batch preflight checkpoint")
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: fmt.Sprintf("batch preflight checkpoint: %v", err)})
			return
		}
		req.BaseCheckpointHash = checkpointHash
		run, err := h.Batch.CreateRun(req)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_run", Payload: protocol.EncodeRPC(run)})

	case "batch_run_start":
		if err := h.ensureBatchRunner(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			RunID string `json:"run_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		run, err := h.BatchRunner.StartRun(h.GlobalCtx, payload.RunID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_run", Payload: protocol.EncodeRPC(run)})

	case "batch_run_abort":
		if err := h.ensureBatchRunner(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			RunID string `json:"run_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		run, err := h.BatchRunner.AbortRun(payload.RunID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_run", Payload: protocol.EncodeRPC(run)})

	case "batch_run_list":
		if err := h.ensureBatchManager(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_runs", Payload: protocol.EncodeRPC(map[string]interface{}{"runs": h.Batch.ListRuns()})})

	case "batch_worker_diff":
		if err := h.ensureBatchManager(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			WorkerID string `json:"worker_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		diff, err := h.Batch.WorkerDiff(payload.WorkerID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_worker_diff", Payload: protocol.EncodeRPC(diff)})

	case "batch_worker_apply":
		if err := h.ensureBatchManager(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		if err := h.ensureCheckpointService(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			WorkerID string `json:"worker_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		if _, err := h.Checkpoint.Save(fmt.Sprintf("Safety checkpoint before applying batch worker %s", payload.WorkerID)); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: fmt.Sprintf("batch apply safety checkpoint: %v", err)})
			return
		}
		worker, err := h.Batch.ApplyWorker(payload.WorkerID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_worker", Payload: protocol.EncodeRPC(worker)})

	case "batch_worker_retry":
		if err := h.ensureBatchRunner(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			WorkerID string `json:"worker_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		run, err := h.BatchRunner.RetryWorker(h.GlobalCtx, payload.WorkerID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_run", Payload: protocol.EncodeRPC(run)})

	case "batch_worker_artifacts":
		if err := h.ensureBatchManager(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			WorkerID string `json:"worker_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		artifacts, err := h.Batch.WorkerArtifacts(payload.WorkerID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_worker_artifacts", Payload: protocol.EncodeRPC(map[string]interface{}{"worker_id": payload.WorkerID, "artifacts": artifacts})})

	case "batch_run_cleanup":
		if err := h.ensureBatchManager(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			RunID string `json:"run_id"`
		}
		_ = json.Unmarshal(msg.Payload, &payload)
		run, err := h.Batch.CleanupRun(payload.RunID)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "batch_run", Payload: protocol.EncodeRPC(run)})

	case "get_workflows":
		if h.Workflows != nil {
			// Reload to ensure fresh data
			h.Workflows.LoadWorkflows()
			wfs := h.Workflows.GetWorkflows()
			writer.Send(protocol.RPCMessage{
				ID:      msg.ID,
				Type:    "workflows_list",
				Payload: protocol.EncodeRPC(map[string]interface{}{"workflows": wfs}),
			})
		} else {
			writer.Send(protocol.RPCMessage{
				ID:      msg.ID,
				Type:    "workflows_list",
				Payload: protocol.EncodeRPC(map[string]interface{}{"workflows": []interface{}{}}),
			})
		}

	case "get_settings":
		if h.Settings == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "settings store not initialized"})
			return
		}
		s := h.Settings.Get()
		settings := map[string]interface{}{
			"provider":                    s.Provider.Provider,
			"model":                       s.Provider.Model,
			"apiKeys":                     s.Provider.APIKeys,
			"embeddingProvider":           s.Provider.EmbeddingProvider,
			"embeddingModel":              s.Provider.EmbeddingModel,
			"temperature":                 s.Provider.Temperature,
			"topP":                        s.Provider.TopP,
			"maxTokens":                   s.Provider.MaxTokens,
			"telegramToken":               s.LiveMode.TelegramToken,
			"telegramChatId":              s.LiveMode.TelegramChatID,
			"discordToken":                s.LiveMode.DiscordToken,
			"discordApplicationId":        s.LiveMode.DiscordApplicationID,
			"discordGuildId":              s.LiveMode.DiscordGuildID,
			"discordAllowedUserIds":       s.LiveMode.DiscordAllowedUserIDs,
			"discordAllowedChannelIds":    s.LiveMode.DiscordAllowedChannelIDs,
			"discordRequireMention":       s.LiveMode.DiscordRequireMention,
			"discordTextMode":             s.LiveMode.DiscordTextMode,
			"allowRemoteSessionStart":     s.LiveMode.AllowRemoteSessionStart,
			"context":                     s.Context,
			"auto_approval":               s.AutoApproval,
			"mode_models":                 s.ModeModels,
			"terminal":                    s.Terminal,
			"theme":                       s.Theme,
			"custom_instructions":         s.CustomInstructions,
			"customInstructions":          s.CustomInstructions,
			"hide_prompt_training_models": s.HidePromptTrainingModels,
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "settings_loaded", Payload: protocol.EncodeRPC(settings)})

	case "save_settings":
		h.handleSaveSettings(msg, writer)

	case "set_grik_access_token":
		var payload struct {
			AccessToken string `json:"access_token"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		if payload.AccessToken == "" {
			os.Unsetenv("GRIKAI_ACCESS_TOKEN")
			if h.Providers != nil {
				h.Providers.SetUserKey("grik", "")
			}
			if h.Config != nil && strings.EqualFold(h.Config.Provider.Provider, "grik") {
				h.Config.Provider.APIKey = ""
			}
			writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "response", Payload: protocol.EncodeRPC(map[string]bool{"ok": true})})
			return
		}

		os.Setenv("GRIKAI_ACCESS_TOKEN", payload.AccessToken)
		if h.Providers != nil {
			h.Providers.SetUserKey("grik", payload.AccessToken)
		}
		if h.Config != nil && strings.EqualFold(h.Config.Provider.Provider, "grik") {
			h.Config.Provider.APIKey = payload.AccessToken
			if h.Agent != nil {
				if err := h.Agent.ReloadProvider(h.Config.Provider); err != nil {
					writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Failed to reload Grik provider: " + err.Error()})
					return
				}
			}
		}
		writer.Send(protocol.RPCMessage{ID: msg.ID, Type: "response", Payload: protocol.EncodeRPC(map[string]bool{"ok": true})})

	case "set_live_mode":
		h.handleSetLiveMode(msg, writer)

	case "set_remote_session_start":
		h.handleSetRemoteSessionStart(msg, writer)

	case "get_live_mode_status":
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "live_mode_status",
			Payload: protocol.EncodeRPC(h.getLiveModeStatus()),
		})
	case "get_tasks":
		var tasks []agent.TaskItem
		if h.Agent != nil {
			pm := h.Agent.GetPlanManager()
			if pm != nil {
				tasks = pm.GetTasks()
			}
		}
		if tasks == nil {
			tasks = []agent.TaskItem{}
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"tasks": tasks,
			}),
		})

	case "set_column":
		var payload struct {
			TaskID string `json:"taskId"`
			Column string `json:"column"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}

		log.Printf("[Handler] Setting column for task %s to %s", payload.TaskID, payload.Column)

		if h.Agent == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "agent not initialized"})
			return
		}

		pm := h.Agent.GetPlanManager()
		if pm == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "plan manager not initialized"})
			return
		}

		if err := pm.SetColumn(payload.TaskID, payload.Column); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
		} else {
			writer.Send(protocol.RPCMessage{
				ID:   msg.ID,
				Type: "response",
				Payload: protocol.EncodeRPC(map[string]interface{}{
					"success": true,
				}),
			})
		}

	case "get_skills":
		skills, err := h.listSkillManifests()
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"skills": skills}),
		})

	case "set_skill_enabled":
		if err := h.lazyInitAgent(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			Name        string `json:"name"`
			ContentPath string `json:"content_path"`
			Path        string `json:"path"`
			Enabled     bool   `json:"enabled"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		contentPath := firstNonEmpty(payload.ContentPath, payload.Path)
		if strings.TrimSpace(payload.Name) == "" && strings.TrimSpace(contentPath) == "" {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "skill name or content_path is required"})
			return
		}
		if err := h.Agent.GetSkillsManager().SetEnabledBySelector(payload.Name, contentPath, payload.Enabled); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		if err := h.updateSkillEnabledSetting(payload.Name, contentPath, payload.Enabled); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		h.syncSkillSettings()
		manifests := h.Agent.GetSkillsManager().ListSkillManifests()
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"success": true, "skills": manifests}),
		})

	case "rescan_skills":
		if err := h.lazyInitAgent(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		if err := h.Agent.GetSkillsManager().LoadSkillsWithOverrides(h.skillOverridesFromSettings()); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"success": true, "skills": h.Agent.GetSkillsManager().ListSkillManifests()}),
		})

	case "create_project_skill":
		if err := h.lazyInitAgent(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		path, err := h.Agent.GetSkillsManager().CreateProjectSkill(payload.Name, payload.Description)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		if err := h.Agent.GetSkillsManager().LoadSkillsWithOverrides(h.skillOverridesFromSettings()); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"success": true, "path": path, "skills": h.Agent.GetSkillsManager().ListSkillManifests()}),
		})

	case "delete_project_skill":
		if err := h.lazyInitAgent(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		var payload struct {
			Name        string `json:"name"`
			ContentPath string `json:"content_path"`
			Path        string `json:"path"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		contentPath := firstNonEmpty(payload.ContentPath, payload.Path)
		if err := h.Agent.GetSkillsManager().DeleteProjectSkill(payload.Name, contentPath); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		if err := h.removeSkillSetting(payload.Name, contentPath); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		if err := h.Agent.GetSkillsManager().LoadSkillsWithOverrides(h.skillOverridesFromSettings()); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"success": true, "skills": h.Agent.GetSkillsManager().ListSkillManifests()}),
		})

	case "get_index_status":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		idx := h.Agent.GetIndexer()
		status := idx.GetStatus()
		workspaceStatus := h.Agent.GetWorkspaceIndexStatus()
		semanticEnabled := h.Config != nil && h.Config.EnableCodeIndex
		workspaceEnabled := h.Config != nil && h.Config.Context.WorkspaceIndexEnabled
		storePath := ""
		if home, err := os.UserHomeDir(); err == nil {
			storePath = filepath.Join(home, ".ricochet", "index.vdb")
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"is_indexing":         status.IsIndexing,
				"total_docs":          status.TotalDocs,
				"provider_configured": status.ProviderConfigured,
				"last_indexed_at":     status.LastIndexedAt,
				"duration_ms":         status.DurationMs,
				"error":               status.Error,
				"semantic_enabled":    semanticEnabled,
				"workspace_enabled":   workspaceEnabled,
				"store_path":          storePath,
				"workspace":           workspaceStatus,
			}),
		})

	case "probe_mcp_server":
		var payload mcp.McpServerConfig
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}

		if h.McpHub == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "MCP Hub not initialized"})
			return
		}

		status, err := h.McpHub.ProbeServer(h.GlobalCtx, payload)
		if err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}

		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(status),
		})

	case "get_mcp_registry":
		if h.McpHub == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "MCP Hub not initialized"})
			return
		}
		reg := h.McpHub.Registry()
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"servers":    reg.GetServers(),
				"lastSynced": reg.GetLastSynced(),
			}),
		})

	case "refresh_mcp_registry":
		if h.McpHub == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "MCP Hub not initialized"})
			return
		}
		reg := h.McpHub.Registry()
		go func() {
			if err := reg.Sync(h.GlobalCtx); err != nil {
				log.Printf("Failed to sync MCP registry: %v", err)
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			} else {
				writer.Send(protocol.RPCMessage{
					ID:   msg.ID,
					Type: "response",
					Payload: protocol.EncodeRPC(map[string]interface{}{
						"servers":    reg.GetServers(),
						"lastSynced": reg.GetLastSynced(),
					}),
				})
			}
		}()
		return // Response is sent asynchronously

	case "get_permissions":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		sg := h.Agent.GetSafeguard()
		if sg == nil || sg.PermissionStore == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "permission store not initialized"})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:   msg.ID,
			Type: "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"rules": sg.PermissionStore.ListRules(),
				"audit": sg.PermissionStore.ListAudit(),
			}),
		})

	case "add_permission_rule":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		var rule safeguard.PermissionRule
		if err := json.Unmarshal(msg.Payload, &rule); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		if rule.Action != "allow" && rule.Action != "deny" {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "permission action must be 'allow' or 'deny'"})
			return
		}
		if rule.Scope == "" {
			rule.Scope = safeguard.ScopeProject
		}
		if rule.Scope == safeguard.ScopeProject && rule.Project == "" && h.Host != nil {
			rule.Project = h.Host.GetCWD()
		}
		sg := h.Agent.GetSafeguard()
		if sg == nil || sg.PermissionStore == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "permission store not initialized"})
			return
		}
		if err := sg.PermissionStore.AddRule(rule); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"success": true}),
		})

	case "remove_permission_rule":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		var payload struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "Invalid payload: " + err.Error()})
			return
		}
		sg := h.Agent.GetSafeguard()
		if sg == nil || sg.PermissionStore == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "permission store not initialized"})
			return
		}
		if err := sg.PermissionStore.RemoveRule(payload.ID); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"success": true}),
		})

	case "clear_permission_audit":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		sg := h.Agent.GetSafeguard()
		if sg == nil || sg.PermissionStore == nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: "permission store not initialized"})
			return
		}
		if err := sg.PermissionStore.ClearAudit(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"success": true}),
		})

	case "reindex_project":
		if h.Agent == nil {
			if err := h.lazyInitAgent(); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
				return
			}
		}
		idx := h.Agent.GetIndexer()
		semanticEnabled := h.Config != nil && h.Config.EnableCodeIndex
		workspaceEnabled := h.Config != nil && h.Config.Context.WorkspaceIndexEnabled
		go func() {
			if workspaceEnabled {
				if err := h.Agent.RebuildWorkspaceIndex(h.GlobalCtx); err != nil {
					log.Printf("Workspace map rebuild failed: %v", err)
				}
			}
			if !semanticEnabled {
				return
			}
			if err := idx.IndexAll(h.GlobalCtx); err != nil {
				log.Printf("Re-indexing failed: %v", err)
			}
		}()
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "response",
			Payload: protocol.EncodeRPC(map[string]interface{}{"status": "started", "semantic": semanticEnabled, "workspace": workspaceEnabled}),
		})

	default:
		log.Printf("[Handler] Unknown message type: %s (id=%s)", msg.Type, msg.ID)
		// Send an error response so the caller doesn't hang forever
		if msg.ID != "" {
			writer.Send(protocol.RPCMessage{
				ID:    msg.ID,
				Type:  "response",
				Error: fmt.Sprintf("Unknown message type: %s", msg.Type),
			})
		}
	}
}

func (h *Handler) lazyInitAgent() error {
	h.InitMu.Lock()
	defer h.InitMu.Unlock()

	if h.Agent != nil {
		return nil
	}

	if h.Settings != nil {
		s := h.Settings.Get()
		if h.Providers != nil {
			for providerID, key := range s.Provider.APIKeys {
				h.Providers.SetUserKey(providerID, key)
			}
		}
		apiKey := s.Provider.APIKey
		if apiKey == "" {
			if key, ok := s.Provider.APIKeys[s.Provider.Provider]; ok && key != "" {
				apiKey = key
			} else if h.Providers != nil {
				apiKey = h.Providers.GetAPIKey(s.Provider.Provider)
			}
		}
		h.Config.Provider.Provider = s.Provider.Provider
		h.Config.Provider.Model = s.Provider.Model
		h.Config.Provider.APIKey = apiKey
		h.Config.Provider.Temperature = s.Provider.Temperature
		h.Config.Provider.TopP = s.Provider.TopP
		h.Config.Provider.MaxTokens = s.Provider.MaxTokens
		h.Config.EnableCodeIndex = s.Context.EnableCodeIndex
		h.Config.Context = s.Context
		h.Config.AutoApproval = &s.AutoApproval
		h.Config.ModeModels = s.ModeModels
		h.Config.Terminal = s.Terminal
		h.Config.CustomInstructions = s.CustomInstructions
		if limiter, ok := h.Host.(interface{ SetCommandOutputLineLimit(int) }); ok {
			limiter.SetCommandOutputLineLimit(s.Terminal.OutputLineLimit)
		}
	}

	log.Printf("Initializing agent controller with provider %s (%s)", h.Config.Provider.Provider, h.Config.Provider.Model)
	var err error
	h.Agent, err = agent.NewController(h.Config, agent.ControllerOptions{
		Host:             h.Host,
		Modes:            h.Modes,
		McpHub:           h.McpHub,
		ProvidersManager: h.Providers,
		Codegraph:        h.Codegraph,
		WorkflowManager:  h.Workflows,
	})
	if err != nil {
		return err
	}

	h.Agent.SubscribeEvents(func(e agent.Event) {
		h.recordProviderEvent(e)
		if h.OnEvent != nil {
			h.OnEvent(e)
		}
	})

	if h.LiveMode != nil {
		h.Agent.SetLiveMode(h.LiveMode)
		h.LiveMode.SetAgent(h.Agent)
	}
	h.syncSkillSettings()
	return nil
}

func (h *Handler) listSkillManifests() ([]protocol.SkillManifest, error) {
	if err := h.lazyInitAgent(); err != nil {
		return nil, err
	}
	h.syncSkillSettings()
	return h.Agent.GetSkillsManager().ListSkillManifests(), nil
}

func (h *Handler) syncSkillSettings() {
	if h.Agent == nil || h.Agent.GetSkillsManager() == nil {
		return
	}
	h.Agent.GetSkillsManager().ApplyOverrides(h.skillOverridesFromSettings())
}

func (h *Handler) skillOverridesFromSettings() []skills.SkillOverride {
	if h.Settings == nil {
		return nil
	}
	settings := h.Settings.Get()
	overrides := make([]skills.SkillOverride, 0, len(settings.Skills.Config))
	for _, entry := range settings.Skills.Config {
		name := strings.TrimSpace(entry.Name)
		contentPath := strings.TrimSpace(entry.ContentPath)
		if name == "" && contentPath == "" {
			continue
		}
		override := skills.SkillOverride{
			Name:        name,
			ContentPath: contentPath,
			Visibility:  strings.TrimSpace(entry.Visibility),
		}
		if entry.Enabled != nil {
			enabled := *entry.Enabled
			override.Enabled = &enabled
		}
		overrides = append(overrides, override)
	}
	return overrides
}

func (h *Handler) updateSkillEnabledSetting(name, contentPath string, enabled bool) error {
	if h.Settings == nil {
		return nil
	}
	name = strings.TrimSpace(name)
	contentPath = strings.TrimSpace(contentPath)
	visibility := "off"
	if enabled {
		visibility = "on"
	}
	return h.Settings.Update(func(s *config.Settings) {
		for i := range s.Skills.Config {
			entry := &s.Skills.Config[i]
			if skillConfigMatches(*entry, name, contentPath) {
				if entry.Name == "" {
					entry.Name = name
				}
				if contentPath != "" {
					entry.ContentPath = contentPath
				}
				entry.Enabled = boolPtr(enabled)
				if !enabled || entry.Visibility == "" || entry.Visibility == "off" {
					entry.Visibility = visibility
				}
				return
			}
		}
		s.Skills.Config = append(s.Skills.Config, config.SkillConfigEntry{
			Name:        name,
			ContentPath: contentPath,
			Enabled:     boolPtr(enabled),
			Visibility:  visibility,
		})
	})
}

func (h *Handler) removeSkillSetting(name, contentPath string) error {
	if h.Settings == nil {
		return nil
	}
	name = strings.TrimSpace(name)
	contentPath = strings.TrimSpace(contentPath)
	return h.Settings.Update(func(s *config.Settings) {
		filtered := s.Skills.Config[:0]
		for _, entry := range s.Skills.Config {
			if skillConfigMatches(entry, name, contentPath) {
				continue
			}
			filtered = append(filtered, entry)
		}
		if len(filtered) == 0 {
			s.Skills.Config = nil
		} else {
			s.Skills.Config = filtered
		}
	})
}

func skillConfigMatches(entry config.SkillConfigEntry, name, contentPath string) bool {
	if contentPath != "" && strings.TrimSpace(entry.ContentPath) != "" {
		return filepath.Clean(entry.ContentPath) == filepath.Clean(contentPath)
	}
	if name != "" && strings.TrimSpace(entry.Name) != "" {
		return strings.EqualFold(strings.TrimSpace(entry.Name), name)
	}
	return false
}

func boolPtr(value bool) *bool {
	return &value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

type batchWorkerExecutor struct {
	handler *Handler
}

func (e *batchWorkerExecutor) ExecuteBatchWorker(ctx context.Context, req batch.WorkerExecutionRequest) (batch.WorkerExecutionResult, error) {
	if e.handler == nil || e.handler.Agent == nil {
		return batch.WorkerExecutionResult{}, fmt.Errorf("agent controller is not initialized")
	}
	output, err := e.handler.Agent.RunSubtaskInDirWithOptions(
		ctx,
		req.ParentSessionID,
		req.WorkerTitle,
		req.Contract,
		"batch-worker",
		req.WorktreePath,
		nil,
		"",
		agent.SubtaskRunOptions{
			MaxTurns:                  8,
			SuppressParentChatUpdates: true,
			BatchWorkerID:             req.WorkerID,
			AgentSessionID:            req.AgentSessionID,
			AllowedRoot:               req.WorktreePath,
			ScopePaths:                req.ScopePaths,
			IsolatedAutoApprove:       true,
			VerificationCommands:      req.VerificationCommands,
		},
	)
	result := batch.WorkerExecutionResult{Status: "completed", Summary: strings.TrimSpace(output), OutputPreview: trimText(output, 1000)}
	var parsed struct {
		Status       string `json:"status"`
		Summary      string `json:"summary"`
		Error        string `json:"error"`
		RecoveryHint string `json:"recovery_hint"`
	}
	if json.Unmarshal([]byte(output), &parsed) == nil && (parsed.Status != "" || parsed.Summary != "" || parsed.Error != "") {
		result.Status = parsed.Status
		result.Summary = strings.TrimSpace(parsed.Summary)
		if result.Summary == "" {
			result.Summary = strings.TrimSpace(parsed.Error)
		}
		if parsed.RecoveryHint != "" {
			result.Summary = strings.TrimSpace(result.Summary + "\n\n" + parsed.RecoveryHint)
		}
		result.OutputPreview = trimText(result.Summary, 1000)
	}
	if strings.EqualFold(result.Status, "success") {
		result.Status = "completed"
	}
	return result, err
}

func trimText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

func (h *Handler) handleSaveSettings(msg protocol.RPCMessage, writer ResponseWriter) {
	var payload struct {
		APIKeys                       *map[string]string           `json:"apiKeys"`
		Provider                      *string                      `json:"provider"`
		Model                         *string                      `json:"model"`
		EmbeddingProvider             *string                      `json:"embeddingProvider"`
		EmbeddingModel                *string                      `json:"embeddingModel"`
		TelegramToken                 *string                      `json:"telegramToken"`
		TelegramChatID                *int64                       `json:"telegramChatId"`
		DiscordToken                  *string                      `json:"discordToken"`
		DiscordApplicationID          *string                      `json:"discordApplicationId"`
		DiscordGuildID                *string                      `json:"discordGuildId"`
		DiscordAllowedUserIDs         *[]string                    `json:"discordAllowedUserIds"`
		DiscordAllowedChannelIDs      *[]string                    `json:"discordAllowedChannelIds"`
		DiscordRequireMention         *bool                        `json:"discordRequireMention"`
		DiscordTextMode               *bool                        `json:"discordTextMode"`
		AllowRemoteSessionStart       *bool                        `json:"allowRemoteSessionStart"`
		Context                       *config.ContextSettings      `json:"context,omitempty"`
		AutoApproval                  *config.AutoApprovalSettings `json:"auto_approval,omitempty"`
		ModeModels                    *config.ModeModelSettings    `json:"mode_models,omitempty"`
		Terminal                      *config.TerminalSettings     `json:"terminal,omitempty"`
		Temperature                   *float64                     `json:"temperature"`
		TopP                          *float64                     `json:"topP"`
		TopPSnake                     *float64                     `json:"top_p"`
		MaxTokens                     *int                         `json:"maxTokens"`
		CustomInstructions            *string                      `json:"customInstructions"`
		CustomInstructionsSnake       *string                      `json:"custom_instructions"`
		HidePromptTrainingModels      *bool                        `json:"hide_prompt_training_models"`
		HidePromptTrainingModelsCamel *bool                        `json:"hidePromptTrainingModels"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
		return
	}
	topP := payload.TopP
	if topP == nil {
		topP = payload.TopPSnake
	}
	customInstructions := payload.CustomInstructions
	if customInstructions == nil {
		customInstructions = payload.CustomInstructionsSnake
	}
	hidePromptTrainingModels := payload.HidePromptTrainingModels
	if hidePromptTrainingModels == nil {
		hidePromptTrainingModels = payload.HidePromptTrainingModelsCamel
	}

	// Do not destroy h.LiveMode here. It is running in the background (managed by main.go/Handler).
	// We will re-link the new Agent to it in lazyInitAgent.

	// Update LiveMode ChatID if changed
	if h.LiveMode != nil && payload.TelegramChatID != nil {
		h.LiveMode.SetChatID(*payload.TelegramChatID)
	}

	// Save all sessions before potentially resetting the agent
	if h.Agent != nil {
		h.Agent.SaveAllSessions()
	}

	// Determine if we need a full reset or just a provider reload
	needsProviderReload := false
	previousProvider := ""
	previousModel := ""
	previousAPIKey := ""
	previousTelegramToken := ""
	previousDiscordToken := ""
	if h.Config != nil {
		previousProvider = h.Config.Provider.Provider
		previousModel = h.Config.Provider.Model
		previousAPIKey = h.Config.Provider.APIKey
	}
	if h.Settings != nil {
		previousTelegramToken = h.Settings.Get().LiveMode.TelegramToken
		previousDiscordToken = h.Settings.Get().LiveMode.DiscordToken
	}
	liveModeRestartRequired := false

	// We only set to nil if we cannot hot-swap or if agent wasn't initialized
	// If it was already initialized, we'll try to update it in-place below
	if h.Agent == nil {
		// Just ensure it's nil for lazyInitAgent later if it wasn't there
	}

	if h.Settings != nil {
		h.Settings.Update(func(s *config.Settings) {
			if payload.APIKeys != nil {
				if s.Provider.APIKeys == nil {
					s.Provider.APIKeys = make(map[string]string)
				}
				for k, v := range *payload.APIKeys {
					if v != "" {
						s.Provider.APIKeys[k] = v
					} else {
						delete(s.Provider.APIKeys, k)
					}
					if h.Providers != nil {
						h.Providers.SetUserKey(k, v)
					}
				}
			}

			if payload.Provider != nil && *payload.Provider != "" {
				s.Provider.Provider = *payload.Provider
			}
			if payload.Model != nil && *payload.Model != "" {
				s.Provider.Model = *payload.Model
			}
			if payload.EmbeddingProvider != nil {
				s.Provider.EmbeddingProvider = *payload.EmbeddingProvider
			}
			if payload.EmbeddingModel != nil {
				s.Provider.EmbeddingModel = *payload.EmbeddingModel
			}
			if payload.TelegramToken != nil {
				s.LiveMode.TelegramToken = *payload.TelegramToken
				h.LiveModeConfig.TelegramToken = *payload.TelegramToken
				if h.LiveMode != nil && previousTelegramToken != *payload.TelegramToken {
					liveModeRestartRequired = true
				}
			}
			if payload.TelegramChatID != nil {
				s.LiveMode.TelegramChatID = *payload.TelegramChatID
				h.LiveModeConfig.TelegramChatID = *payload.TelegramChatID
			}
			if payload.DiscordToken != nil {
				s.LiveMode.DiscordToken = *payload.DiscordToken
				h.LiveModeConfig.DiscordToken = *payload.DiscordToken
				if h.LiveMode != nil && previousDiscordToken != *payload.DiscordToken {
					liveModeRestartRequired = true
				}
			}
			if payload.DiscordApplicationID != nil {
				s.LiveMode.DiscordApplicationID = *payload.DiscordApplicationID
				h.LiveModeConfig.DiscordApplicationID = *payload.DiscordApplicationID
			}
			if payload.DiscordGuildID != nil {
				s.LiveMode.DiscordGuildID = *payload.DiscordGuildID
				h.LiveModeConfig.DiscordGuildID = *payload.DiscordGuildID
			}
			if payload.DiscordAllowedUserIDs != nil {
				s.LiveMode.DiscordAllowedUserIDs = *payload.DiscordAllowedUserIDs
				h.LiveModeConfig.DiscordAllowedUserIDs = *payload.DiscordAllowedUserIDs
			}
			if payload.DiscordAllowedChannelIDs != nil {
				s.LiveMode.DiscordAllowedChannelIDs = *payload.DiscordAllowedChannelIDs
				h.LiveModeConfig.DiscordAllowedChannelIDs = *payload.DiscordAllowedChannelIDs
			}
			if payload.DiscordRequireMention != nil {
				s.LiveMode.DiscordRequireMention = *payload.DiscordRequireMention
				h.LiveModeConfig.DiscordRequireMention = *payload.DiscordRequireMention
			}
			if payload.DiscordTextMode != nil {
				s.LiveMode.DiscordTextMode = *payload.DiscordTextMode
				h.LiveModeConfig.DiscordTextMode = *payload.DiscordTextMode
			}
			if payload.AllowRemoteSessionStart != nil {
				s.LiveMode.AllowRemoteSessionStart = *payload.AllowRemoteSessionStart
				h.LiveModeConfig.AllowRemoteSessionStart = *payload.AllowRemoteSessionStart
				if h.LiveMode != nil {
					h.LiveMode.SetAllowRemoteSessionStart(*payload.AllowRemoteSessionStart)
				}
			}
			if payload.Context != nil {
				s.Context = *payload.Context
			}
			if payload.ModeModels != nil {
				s.ModeModels = *payload.ModeModels
			}
			if payload.Terminal != nil {
				s.Terminal = *payload.Terminal
				if s.Terminal.OutputLineLimit <= 0 {
					s.Terminal.OutputLineLimit = 500
				}
			}
			if customInstructions != nil {
				s.CustomInstructions = *customInstructions
			}
			if payload.AutoApproval != nil {
				s.AutoApproval = *payload.AutoApproval
			}
			if payload.Temperature != nil {
				s.Provider.Temperature = *payload.Temperature
			}
			if topP != nil {
				s.Provider.TopP = *topP
			}
			if payload.MaxTokens != nil {
				s.Provider.MaxTokens = *payload.MaxTokens
			}
			if hidePromptTrainingModels != nil {
				s.HidePromptTrainingModels = *hidePromptTrainingModels
			}

			targetProvider := s.Provider.Provider
			targetModel := s.Provider.Model
			credentialMode := ""
			if h.Providers != nil {
				if mode, ok := h.Providers.ModelCredentialMode(targetProvider, targetModel); ok {
					credentialMode = mode
				}
			}
			var apiKey string
			if credentialMode != "none" {
				if key, ok := s.Provider.APIKeys[targetProvider]; ok && key != "" {
					apiKey = key
				} else if h.Providers != nil {
					apiKey = h.Providers.GetAPIKey(targetProvider)
				}
			}
			s.Provider.APIKey = apiKey

			if h.Config != nil {
				h.Config.Provider.Provider = s.Provider.Provider
				h.Config.Provider.Model = s.Provider.Model
				h.Config.Provider.APIKey = apiKey
				h.Config.Provider.CredentialMode = credentialMode
				if h.Providers != nil {
					h.Config.Provider.BaseURL = h.Providers.GetBaseURL(targetProvider)
				}
				h.Config.Provider.Temperature = s.Provider.Temperature
				h.Config.Provider.TopP = s.Provider.TopP
				h.Config.Provider.MaxTokens = s.Provider.MaxTokens
				h.Config.EnableCodeIndex = s.Context.EnableCodeIndex
				h.Config.Context = s.Context
				h.Config.AutoApproval = &s.AutoApproval
				h.Config.ModeModels = s.ModeModels
				h.Config.Terminal = s.Terminal
				h.Config.CustomInstructions = s.CustomInstructions
				if limiter, ok := h.Host.(interface{ SetCommandOutputLineLimit(int) }); ok {
					limiter.SetCommandOutputLineLimit(s.Terminal.OutputLineLimit)
				}
				if previousProvider != s.Provider.Provider || previousModel != s.Provider.Model || previousAPIKey != apiKey {
					needsProviderReload = true
				}
			}

			s.LiveMode.Enabled = s.LiveMode.TelegramToken != "" || s.LiveMode.DiscordToken != ""
		})
	}

	// Updating runtime config logic (abbreviated, similar to main.go)
	if payload.EmbeddingProvider != nil && *payload.EmbeddingProvider != "" {
		// embedding config logic
		s := h.Settings.Get()
		embKey := s.Provider.APIKeys[*payload.EmbeddingProvider]
		if embKey == "" && s.Provider.Provider == *payload.EmbeddingProvider {
			embKey = s.Provider.APIKey
		}
		h.Config.EmbeddingProvider = &agent.ProviderConfig{
			Provider: *payload.EmbeddingProvider,
			Model:    s.Provider.EmbeddingModel,
			APIKey:   embKey,
		}
	} else if payload.EmbeddingProvider != nil {
		h.Config.EmbeddingProvider = nil
	}

	// Finalize agent update: either re-init if nil, or reload if crit settings changed
	if h.Agent != nil {
		if needsProviderReload {
			log.Printf("Hot-swapping agent provider to %s (%s)", h.Config.Provider.Provider, h.Config.Provider.Model)
			if err := h.Agent.ReloadProvider(h.Config.Provider); err != nil {
				writer.Send(protocol.RPCMessage{ID: msg.ID, Error: fmt.Sprintf("Failed to hot-swap provider: %v", err)})
				return
			}
		}
		if h.LiveMode != nil {
			h.Agent.SetLiveMode(h.LiveMode)
			h.LiveMode.SetAgent(h.Agent)
		}
	} else {
		// New agent initialization
		if err := h.lazyInitAgent(); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
	}

	writer.Send(protocol.RPCMessage{
		ID:   msg.ID,
		Type: "settings_saved",
		Payload: protocol.EncodeRPC(map[string]interface{}{
			"success":                 true,
			"liveModeAvailable":       h.LiveModeConfig.TelegramToken != "" || h.LiveModeConfig.DiscordToken != "",
			"liveModeRestartRequired": liveModeRestartRequired,
		}),
	})
	writer.Send(protocol.RPCMessage{
		Type:    "live_mode_status",
		Payload: protocol.EncodeRPC(h.getLiveModeStatus()),
	})
}

func (h *Handler) handleSetRemoteSessionStart(msg protocol.RPCMessage, writer ResponseWriter) {
	var payload struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
		return
	}

	if h.LiveModeConfig != nil {
		h.LiveModeConfig.AllowRemoteSessionStart = payload.Enabled
	}
	if h.Settings != nil {
		if err := h.Settings.Update(func(s *config.Settings) {
			s.LiveMode.AllowRemoteSessionStart = payload.Enabled
		}); err != nil {
			writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
			return
		}
	}
	if h.LiveMode != nil {
		h.LiveMode.SetAllowRemoteSessionStart(payload.Enabled)
	}

	writer.Send(protocol.RPCMessage{
		ID:      msg.ID,
		Type:    "live_mode_status",
		Payload: protocol.EncodeRPC(h.getLiveModeStatus()),
	})
}

func (h *Handler) handleSetLiveMode(msg protocol.RPCMessage, writer ResponseWriter) {
	var payload struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		writer.Send(protocol.RPCMessage{ID: msg.ID, Error: err.Error()})
		return
	}

	h.InitMu.Lock()
	if h.LiveMode == nil {
		// Should have been initialized in main.go, but if not (e.g. no token on startup but added later??)
		// We can try to init here, but it won't have callbacks wired unless we wire them.
		// For now, assume main.go handles it if token is present.
		// If token was added via settings save, we might need re-init.
		var err error
		h.LiveMode, err = livemode.New(h.LiveModeConfig, h.Agent)
		if err != nil {
			h.InitMu.Unlock()
			writer.Send(protocol.RPCMessage{
				ID:      msg.ID,
				Type:    "live_mode_status",
				Payload: protocol.EncodeRPC(map[string]interface{}{"enabled": false, "error": err.Error()}),
			})
			return
		}

		// Note: Callbacks might be missing if created here!
		// TODO: Ensure save_settings re-wires LiveMode properly.
	}

	if h.Agent != nil && h.LiveMode != nil {
		h.Agent.SetLiveMode(h.LiveMode)
		h.LiveMode.SetAgent(h.Agent)
	}
	h.InitMu.Unlock()

	// Toggle
	var status *livemode.Status
	var err error
	if payload.Enabled {
		status, err = h.LiveMode.Enable(h.GlobalCtx)
	} else {
		status, err = h.LiveMode.Disable(h.GlobalCtx)
	}

	if err != nil {
		writer.Send(protocol.RPCMessage{
			ID:      msg.ID,
			Type:    "live_mode_status",
			Payload: protocol.EncodeRPC(map[string]interface{}{"enabled": false, "error": err.Error()}),
		})
		return
	}

	writer.Send(protocol.RPCMessage{
		ID:      msg.ID,
		Type:    "live_mode_status",
		Payload: protocol.EncodeRPC(status),
	})
}
