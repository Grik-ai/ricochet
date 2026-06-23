package livemode

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/agent"
	"github.com/igoryan-dao/ricochet/internal/discord"
	"github.com/igoryan-dao/ricochet/internal/ether"
	"github.com/igoryan-dao/ricochet/internal/keepawake"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/state"
	"github.com/igoryan-dao/ricochet/internal/telegram"
	"github.com/igoryan-dao/ricochet/internal/whisper"
)

type contextKey string

const chatIDKey contextKey = "chatID"
const discordTargetKey contextKey = "discordTarget"

// Callback data constants for Veto Loop (Sprint 4.0)
const (
	CallbackVetoRetry  = "veto:retry"
	CallbackVetoIgnore = "veto:ignore"
)

const etherGatewayDisabledMessage = "🔴 **Ether Gateway is disabled.** Enable Ether in Ricochet before controlling this session from Telegram or Discord."
const remoteSessionStartDisabledMessage = "🔒 **Remote session start is disabled.** Enable `Allow remote messages to wake Ether and start sessions` in Ricochet Settings, or link this messenger target to an existing session first."
const staleRemoteSessionMessage = "🔒 **This Discord thread is linked to a stale session.** Enable remote session start or switch/link an existing session."

// Controller manages Live Mode - bridging Telegram/Discord with the AI agent
type Controller struct {
	mu sync.RWMutex

	enabled    bool
	tgBot      *telegram.Bot
	discordBot *discord.Bot
	agent      *agent.Controller
	stateMgr   *state.Manager
	chatID     int64 // Primary Telegram chat ID for notifications

	// Cancellation for the listener goroutine
	cancel context.CancelFunc

	isDaemon bool

	// Callback for status updates
	onStatusUpdate func(Status)

	// Callback for emitting activity events to extension
	onActivity func(EtherActivity)

	// Callback for forwarding task progress to IDE
	onTaskProgress func(protocol.TaskProgress)

	// Callback for forwarding chat updates to IDE
	onChatUpdate func(agent.ChatUpdate)

	// Callback for user input injection (CLI/TUI)
	onUserMessage func(string)

	// Main Session ID (from TUI/CLI) to bind Telegram to
	mainSessionID string

	allowRemoteSessionStart bool
	lastSource              string

	// Throttling for streaming updates to prevent webview crash
	lastChatUpdateTime time.Time

	// Draft Messages for Telegram status updates (chatID -> messageID)
	draftMessages map[int64]int

	// Track last request for retry functionality
	lastRequests        map[int64]*agent.ChatRequestInput
	lastDiscordRequests map[string]*agent.ChatRequestInput

	busySessions map[string]bool

	listenerStarted bool
	gatewayStarted  bool
	gatewayCancel   context.CancelFunc
}

// SetMainSessionID sets the primary session ID for binding
func (c *Controller) SetMainSessionID(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mainSessionID = id
}

// SetAllowRemoteSessionStart controls whether remote messengers may create sessions.
func (c *Controller) SetAllowRemoteSessionStart(allowed bool) {
	c.mu.Lock()
	c.allowRemoteSessionStart = allowed
	c.mu.Unlock()
	c.broadcastStatus()
}

// SetOnTaskProgress sets the callback for forwarding task progress
func (c *Controller) SetOnTaskProgress(fn func(protocol.TaskProgress)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onTaskProgress = fn
}

// emitTaskProgress forwards task progress to the IDE
func (c *Controller) emitTaskProgress(progress protocol.TaskProgress) {
	c.mu.RLock()
	fn := c.onTaskProgress
	c.mu.RUnlock()

	if fn != nil {
		fn(progress)
	}
}

// Config holds Live Mode configuration
type Config struct {
	TelegramToken            string   `json:"telegram_token"`
	TelegramChatID           int64    `json:"telegram_chat_id"`
	AllowedUserIDs           []int64  `json:"allowed_user_ids"`
	WhisperBinary            string   `json:"whisper_binary,omitempty"`
	WhisperModel             string   `json:"whisper_model,omitempty"`
	DiscordToken             string   `json:"discord_token,omitempty"`
	DiscordApplicationID     string   `json:"discord_application_id,omitempty"`
	DiscordGuildID           string   `json:"discord_guild_id,omitempty"`
	DiscordAllowedUserIDs    []string `json:"discord_allowed_user_ids,omitempty"`
	DiscordAllowedChannelIDs []string `json:"discord_allowed_channel_ids,omitempty"`
	DiscordRequireMention    bool     `json:"discord_require_mention,omitempty"`
	DiscordTextMode          bool     `json:"discord_text_mode,omitempty"`
	AllowRemoteSessionStart  bool     `json:"allow_remote_session_start,omitempty"`
}

// ChannelStatus describes one configured Ether messenger adapter.
type ChannelStatus struct {
	Configured bool   `json:"configured"`
	Active     bool   `json:"active"`
	Label      string `json:"label"`
	Owner      string `json:"owner,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Status represents the current Live Mode status
type Status struct {
	Enabled                 bool                     `json:"enabled"`
	ConnectedVia            string                   `json:"connectedVia,omitempty"` // backward-compatible summary
	LastActivity            string                   `json:"lastActivity,omitempty"`
	SessionID               string                   `json:"sessionId,omitempty"`
	IsDaemon                bool                     `json:"isDaemon"`
	Channels                map[string]ChannelStatus `json:"channels,omitempty"`
	LastSource              string                   `json:"lastSource,omitempty"`
	AllowRemoteSessionStart bool                     `json:"allowRemoteSessionStart"`
}

// EtherActivity represents real-time activity for UI mirroring
type EtherActivity struct {
	Stage    string `json:"stage"`  // receiving, processing, responding
	Source   string `json:"source"` // telegram, discord
	Username string `json:"username,omitempty"`
	Preview  string `json:"preview,omitempty"` // First 50 chars of message
}

// broadcastStatus notifies listeners about status change
func (c *Controller) broadcastStatus() {
	status := c.GetStatus()
	c.mu.RLock()
	fn := c.onStatusUpdate
	c.mu.RUnlock()
	if fn != nil {
		fn(*status)
	}
}

// SetOnStatusUpdate sets the callback for status updates
func (c *Controller) SetOnStatusUpdate(fn func(Status)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onStatusUpdate = fn
}

// New creates a new Live Mode controller
func New(cfg *Config, agentCtrl *agent.Controller) (*Controller, error) {
	// Create state manager
	stateMgr, err := state.NewManager()
	if err != nil {
		// log.Printf("Warning: Failed to create state manager: %v", err)
		// Continue without persistence
	}

	ctrl := &Controller{
		agent:                   agentCtrl,
		stateMgr:                stateMgr,
		chatID:                  cfg.TelegramChatID,
		allowRemoteSessionStart: cfg.AllowRemoteSessionStart,
		draftMessages:           make(map[int64]int),
		lastRequests:            make(map[int64]*agent.ChatRequestInput),
		lastDiscordRequests:     make(map[string]*agent.ChatRequestInput),
		busySessions:            make(map[string]bool),
	}

	// Create Telegram bot if token provided
	if cfg.TelegramToken != "" {
		// AllowedIDs empty = allow all (bot is protected by token)
		tgBot, err := telegram.New(cfg.TelegramToken, cfg.AllowedUserIDs, stateMgr)
		if err != nil {
			return nil, fmt.Errorf("failed to create telegram bot: %w", err)
		}
		ctrl.tgBot = tgBot
	}

	if cfg.DiscordToken != "" {
		discordBot, err := discord.NewWithConfig(discord.Config{
			Token:             cfg.DiscordToken,
			ApplicationID:     cfg.DiscordApplicationID,
			GuildID:           cfg.DiscordGuildID,
			AllowedUserIDs:    cfg.DiscordAllowedUserIDs,
			AllowedChannelIDs: cfg.DiscordAllowedChannelIDs,
			RequireMention:    cfg.DiscordRequireMention,
			TextMode:          cfg.DiscordTextMode,
		}, stateMgr)
		if err != nil {
			return nil, fmt.Errorf("failed to create discord bot: %w", err)
		}
		ctrl.discordBot = discordBot
	}

	// Initialize Whisper if configured
	if cfg.WhisperBinary != "" && cfg.WhisperModel != "" {
		transcriber, err := whisper.NewTranscriber(cfg.WhisperBinary, cfg.WhisperModel)
		if err != nil {
			log.Printf("⚠️ Failed to initialize Whisper transcriber: %v", err)
		} else {
			if ctrl.tgBot != nil {
				ctrl.tgBot.SetTranscriber(transcriber)
				log.Println("🎙️ Whisper transcription enabled")
			}
		}
	}

	return ctrl, nil
}

// Start begins the internal event listener. Messenger gateways are opened only
// by Enable so passive core startup/health checks cannot claim Telegram/Discord.
func (c *Controller) Start(ctx context.Context) {
	c.mu.Lock()
	if c.listenerStarted || (c.tgBot == nil && c.discordBot == nil) {
		c.mu.Unlock()
		return
	}
	c.listenerStarted = true
	c.mu.Unlock()

	go c.listenForMessages(ctx)
	go func() {
		<-ctx.Done()
		c.stopGateway()
		c.broadcastStatus()
	}()

	// log.Println("Live Mode background poller started")
}

func (c *Controller) startGateway(ctx context.Context) error {
	c.mu.Lock()
	if c.gatewayStarted {
		c.mu.Unlock()
		return nil
	}
	if c.tgBot == nil && c.discordBot == nil {
		c.gatewayStarted = false
		c.mu.Unlock()
		return nil
	}
	gatewayCtx, cancel := context.WithCancel(ctx)
	c.gatewayStarted = true
	c.gatewayCancel = cancel
	tgBot := c.tgBot
	discordBot := c.discordBot
	c.mu.Unlock()

	if tgBot != nil {
		go tgBot.Start(gatewayCtx)
	}
	if discordBot != nil {
		go func() {
			select {
			case <-gatewayCtx.Done():
				c.broadcastStatus()
				return
			default:
			}
			if err := discordBot.Start(); err != nil {
				log.Printf("Discord bot stopped with error: %v", err)
			}
			if gatewayCtx.Err() != nil {
				_ = discordBot.Stop()
			}
			c.broadcastStatus()
		}()
		go func() {
			<-gatewayCtx.Done()
			_ = discordBot.Stop()
			c.broadcastStatus()
		}()
	}
	return nil
}

func (c *Controller) stopGateway() {
	c.mu.Lock()
	if !c.gatewayStarted {
		c.mu.Unlock()
		return
	}
	cancel := c.gatewayCancel
	discordBot := c.discordBot
	c.gatewayStarted = false
	c.gatewayCancel = nil
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if discordBot != nil {
		if err := discordBot.Stop(); err != nil {
			log.Printf("Discord bot stop error: %v", err)
		}
	}
}

// Enable starts Live Mode
func (c *Controller) Enable(ctx context.Context) (*Status, error) {
	c.mu.Lock()
	c.enabled = true
	c.mu.Unlock() // Release lock
	if err := c.startGateway(ctx); err != nil {
		c.mu.Lock()
		c.enabled = false
		c.mu.Unlock()
		c.broadcastStatus()
		return c.GetStatus(), err
	}
	c.broadcastStatus()

	// Notify user safely in background
	if c.chatID != 0 && c.tgBot != nil {
		go func() {
			c.tgBot.SendMessage(context.Background(), c.chatID, "🟢 **Live Mode Enabled**\n\nYou can now send messages here to control Ricochet!")
		}()
	}
	// log.Println("Live Mode enabled")

	return c.GetStatus(), nil
}

// Disable stops Live Mode
func (c *Controller) Disable(ctx context.Context) (*Status, error) {
	c.mu.Lock()
	c.enabled = false
	c.mu.Unlock() // Release lock
	c.stopGateway()
	c.broadcastStatus()

	// Notify user safely in background
	if c.chatID != 0 && c.tgBot != nil {
		go func() {
			c.tgBot.SendMessage(context.Background(), c.chatID, "🔴 **Live Mode Disabled**\n\nReturning control to IDE.")
		}()
	}
	// log.Println("Live Mode disabled")

	return c.GetStatus(), nil
}

// Toggle toggles Live Mode on/off
func (c *Controller) Toggle(ctx context.Context) (*Status, error) {
	c.mu.RLock()
	enabled := c.enabled
	c.mu.RUnlock()

	if enabled {
		return c.Disable(ctx)
	}
	return c.Enable(ctx)
}

// GetStatus returns current Live Mode status
func (c *Controller) GetStatus() *Status {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.getStatusLocked()
}

func (c *Controller) getStatusLocked() *Status {
	telegramActive := c.enabled && c.gatewayStarted && c.tgBot != nil
	discordActive := c.enabled && c.gatewayStarted && c.discordBot != nil && c.discordBot.IsRunning()
	discordError := ""
	discordOwner := ""
	if c.discordBot != nil {
		discordError = c.discordBot.StatusError()
		discordOwner = c.discordBot.GatewayOwner()
		if !c.enabled {
			discordError = "Ether Gateway is disabled"
			discordOwner = "disabled_by_ether"
		}
	}
	status := &Status{
		Enabled:                 c.enabled,
		IsDaemon:                c.isDaemon,
		LastSource:              c.lastSource,
		AllowRemoteSessionStart: c.allowRemoteSessionStart,
		Channels: map[string]ChannelStatus{
			"telegram": {
				Configured: c.tgBot != nil,
				Active:     telegramActive,
				Label:      "Telegram",
				Owner:      ownerForActive(telegramActive),
			},
			"discord": {
				Configured: c.discordBot != nil,
				Active:     discordActive,
				Label:      "Discord",
				Owner:      discordOwner,
				Error:      discordError,
			},
		},
	}
	if c.enabled {
		if telegramActive && discordActive {
			status.ConnectedVia = "telegram+discord"
		} else if discordActive {
			status.ConnectedVia = "discord"
		} else if telegramActive {
			status.ConnectedVia = "telegram"
		} else {
			status.ConnectedVia = "offline (demo)"
		}
	}
	return status
}

func ownerForActive(active bool) string {
	if active {
		return "this_window"
	}
	return ""
}

// SetDaemon marks the controller as running in background mode
func (c *Controller) SetDaemon(isDaemon bool) {
	c.mu.Lock()
	c.isDaemon = isDaemon
	c.mu.Unlock()
	c.broadcastStatus()
}

// listenForMessages handles incoming messenger messages and forwards to agent
func (c *Controller) listenForMessages(ctx context.Context) {
	var tgResponseCh <-chan *telegram.UserResponse
	var tgCallbackCh <-chan *telegram.CallbackEvent
	var discordResponseCh <-chan *discord.UserResponse
	var discordCallbackCh <-chan *discord.CallbackEvent
	if c.tgBot != nil {
		tgResponseCh = c.tgBot.GetResponseChannel()
		tgCallbackCh = c.tgBot.GetCallbackChannel()
	}
	if c.discordBot != nil {
		discordResponseCh = c.discordBot.GetResponseChannel()
		discordCallbackCh = c.discordBot.GetCallbackChannel()
	}

	for {
		select {
		case <-ctx.Done():
			return

		case resp := <-tgResponseCh:
			if resp == nil {
				continue
			}
			// Handle async so we don't block on agent.Chat()
			go c.handleTelegramMessage(ctx, resp)

		case callback := <-tgCallbackCh:
			if callback == nil {
				continue
			}
			c.handleTelegramCallback(ctx, callback)
		case resp := <-discordResponseCh:
			if resp == nil {
				continue
			}
			go c.handleDiscordMessage(ctx, resp)
		case callback := <-discordCallbackCh:
			if callback == nil {
				continue
			}
			c.handleDiscordCallback(ctx, callback)
		}
	}
}

// handleTelegramMessage processes incoming Telegram messages
func (c *Controller) handleTelegramMessage(ctx context.Context, resp *telegram.UserResponse) {
	log.Printf("Live Mode received message from chat %d: %s", resp.ChatID, resp.Text)
	content := strings.TrimSpace(resp.Text)
	target := state.MessengerTarget{Platform: "telegram", ChatID: resp.ChatID}

	if !c.IsEnabled() {
		c.tgBot.SendMessage(ctx, resp.ChatID, etherGatewayDisabledMessage)
		return
	}

	if c.agent == nil {
		// If agent is nil, checking if we have a TUI handler wired
		c.mu.RLock()
		handler := c.onUserMessage
		c.mu.RUnlock()

		if handler != nil {
			handler(resp.Text)
			return
		}

		c.tgBot.SendMessage(ctx, resp.ChatID, "⚠️ Agent not configured and no input handler wired.")
		return
	}

	// Handle /stop command
	if content == "/stop" {
		c.Disable(ctx)
		return
	}

	// Handle /new command
	if content == "/new" {
		if !c.canCreateRemoteSession("telegram", target, content) {
			c.tgBot.SendMessage(ctx, resp.ChatID, remoteSessionStartDisabledMessage)
			return
		}
		s := c.agent.CreateSession()
		c.tgBot.SetActiveSession(resp.ChatID, s.ID)
		c.tgBot.SendMessage(ctx, resp.ChatID, fmt.Sprintf("🆕 **New Session Started:** `%s`", s.ID))
		return
	}

	// Emit receiving activity
	c.emitActivity("receiving", "telegram", resp.Username, resp.Text)

	// Resolve Session ID EARLY so we can tag the user message
	sessionID := c.tgBot.GetActiveSession(resp.ChatID)
	// Check if session ID is valid AND exists in current agent instance
	if sessionID == "" || c.agent.GetSession(sessionID) == nil {
		if !c.canCreateRemoteSession("telegram", target, content) {
			c.tgBot.SendMessage(ctx, resp.ChatID, remoteSessionStartDisabledMessage)
			return
		}
		// FALLBACK: User wants to resume the Active Shell Session (if any)
		// Check if there are any active sessions in the agent.
		sessions := c.agent.ListSessions()
		if len(sessions) > 0 {
			// ListSessions returns sorted by CreatedAt descending (0 is latest)
			// Adopt the latest session (likely the TUI session)
			sessionID = sessions[0].ID
			log.Printf("Live Mode: Resuming existing active session %s for chat %d", sessionID, resp.ChatID)
		} else {
			// No active session found? Create a NEW one.
			s := c.agent.CreateSession()
			sessionID = s.ID
			log.Printf("Live Mode: Created new session %s for chat %d", sessionID, resp.ChatID)
		}

		// Bind to chat
		c.tgBot.SetActiveSession(resp.ChatID, sessionID)
	}

	if resp.Text == "/cancel" {
		if c.agent.AbortSession(sessionID) {
			c.tgBot.SendMessage(ctx, resp.ChatID, fmt.Sprintf("🛑 **Cancel requested for session:** `%s`", sessionID))
		} else {
			c.tgBot.SendMessage(ctx, resp.ChatID, fmt.Sprintf("ℹ️ **No active run for session:** `%s`", sessionID))
		}
		return
	}

	// Forward user message to IDE
	c.emitChatUpdate(agent.ChatUpdate{
		SessionID: sessionID, // Propagate session ID for TUI Sync
		Message: &agent.ChatMessage{
			ID:        fmt.Sprintf("tg-%d-%d", resp.ChatID, resp.MessageID),
			Role:      "user",
			Content:   resp.Text,
			Timestamp: resp.Timestamp,
			Via:       "telegram",
			Username:  resp.Username,
			SessionID: sessionID,
		},
	})

	// Send typing indicator
	c.tgBot.SendTyping(ctx, resp.ChatID)

	// Emit processing activity
	c.emitActivity("processing", "telegram", resp.Username, "")

	// Stream response to Telegram

	// Handle /sessions command
	if resp.Text == "/sessions" {
		sessions := c.agent.ListSessions()
		var views []telegram.SessionView
		for _, s := range sessions {
			views = append(views, telegram.SessionView{
				ID:        s.ID,
				TotalCost: s.TotalCost,
			})
		}
		c.tgBot.SendSessionList(ctx, resp.ChatID, views)
		return
	}

	// Handle /status command
	if resp.Text == "/status" {
		if c.agent != nil {
			pm := c.agent.GetPlanManager()
			if pm != nil {
				statusText := pm.GenerateContext()
				if statusText == "" {
					statusText = "📭 **No active plan found.**"
				} else {
					// Add a header for Telegram
					statusText = "📊 **Current Status & Plan**\n" + statusText
				}
				c.tgBot.SendMessage(ctx, resp.ChatID, statusText)
				return
			}
		}
		c.tgBot.SendMessage(ctx, resp.ChatID, "⚠️ Agent or Plan Manager not ready.")
		return
	}

	if resp.Text == "/queue" {
		session := c.agent.GetSession(sessionID)
		if session == nil || len(session.MessageQueue) == 0 {
			c.tgBot.SendMessage(ctx, resp.ChatID, "📭 **Queue is empty.**")
			return
		}
		var sb strings.Builder
		sb.WriteString("📥 **Queued commands:**\n\n")
		for i, queued := range session.MessageQueue {
			if i >= 5 {
				sb.WriteString(fmt.Sprintf("…and %d more", len(session.MessageQueue)-i))
				break
			}
			sb.WriteString(fmt.Sprintf("%d. `%s` — %s\n", i+1, queued.Delivery, truncateForTelegramStatus(queued.Text)))
		}
		c.tgBot.SendMessage(ctx, resp.ChatID, sb.String())
		return
	}

	// Stream response to Telegram

	// Inject ChatID into context so tools (AskUserRemote) know where to reply
	chatCtx := context.WithValue(ctx, chatIDKey, resp.ChatID)

	// Stream response to Shell, send final to Telegram
	var currentContent string

	// Store request for potential retry
	req := agent.ChatRequestInput{
		SessionID: sessionID,
		Content:   resp.Text,
		Via:       "telegram",
	}
	c.mu.Lock()
	if c.lastRequests == nil {
		c.lastRequests = make(map[int64]*agent.ChatRequestInput)
	}
	c.lastRequests[resp.ChatID] = &req
	c.mu.Unlock()

	if !c.tryMarkSessionBusy(sessionID) {
		deliveryText := resp.Text
		var ok bool
		if strings.HasPrefix(strings.TrimSpace(resp.Text), "/steer ") {
			deliveryText = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(resp.Text), "/steer "))
			_, ok = c.agent.SteerQueuedMessage(sessionID, req.RunID, deliveryText, "telegram")
		} else {
			_, ok = c.agent.EnqueueUserMessage(sessionID, req.RunID, deliveryText, "telegram")
		}
		if ok {
			c.tgBot.SendMessage(ctx, resp.ChatID, "📥 **Command queued for the active run.**")
		}
		return
	}
	defer c.markSessionIdle(sessionID)

	awake, awakeErr := keepawake.Start("telegram live mode run")
	if awakeErr != nil {
		log.Printf("Warning: keep-awake unavailable: %v", awakeErr)
		c.tgBot.SendMessage(ctx, resp.ChatID, "⚠️ Keep-awake is unavailable; the task will continue while this computer stays awake.")
	}
	err := c.agent.Chat(chatCtx, req, func(update interface{}) {
		// Handle TaskProgress for Shell AND Telegram Status Update
		if tp, ok := update.(protocol.TaskProgress); ok {
			c.emitTaskProgress(tp)

			// Update Telegram Draft Status
			if c.tgBot != nil {
				c.mu.Lock()
				draftID, hasDraft := c.draftMessages[resp.ChatID]
				c.mu.Unlock()

				statusText := fmt.Sprintf("🤖 **%s**\n\n_%s_", tp.Status, tp.Summary)
				if len(tp.Steps) > 0 {
					statusText += "\n\n**Progress:**\n"
					lastSteps := tp.Steps
					if len(lastSteps) > 5 {
						lastSteps = lastSteps[len(lastSteps)-5:]
					}
					for i, step := range lastSteps {
						statusText += fmt.Sprintf("• %s\n", step)
						if i == len(lastSteps)-1 {
							statusText += "   └─ ⚡️ _current process_\n"
						}
					}
				}

				if !hasDraft {
					// Create new draft message
					newID, err := c.tgBot.SendMessageAndTrack(ctx, resp.ChatID, statusText)
					if err == nil {
						c.mu.Lock()
						c.draftMessages[resp.ChatID] = newID
						c.mu.Unlock()
					}
				} else {
					// Edit existing draft
					_ = c.tgBot.EditMessage(ctx, resp.ChatID, draftID, statusText)
				}
			}
			return
		}

		// Only handle ChatUpdate for Shell
		chatUpdate, ok := update.(agent.ChatUpdate)
		if !ok || chatUpdate.Message == nil {
			return
		}

		// Store final content for Telegram delivery after loop finishes
		currentContent = chatUpdate.Message.Content

		// Forward updates to Shell with via field
		chatUpdate.Message.Via = "telegram"
		c.emitChatUpdate(chatUpdate)
	})
	awake.Stop()

	if err == nil {
		for _, queued := range c.agent.DrainQueuedMessages(sessionID) {
			c.tgBot.SendMessage(ctx, resp.ChatID, fmt.Sprintf("▶️ **Running queued command:** %s", truncateForTelegramStatus(queued.Text)))
			awake, awakeErr := keepawake.Start("telegram queued live mode run")
			if awakeErr != nil {
				log.Printf("Warning: keep-awake unavailable: %v", awakeErr)
			}
			qErr := c.agent.Chat(chatCtx, agent.ChatRequestInput{
				SessionID:    queued.SessionID,
				Content:      queued.Text,
				Via:          queued.Via,
				RunID:        queued.RunID,
				ContextFiles: queued.ContextFiles,
			}, func(update interface{}) {
				if chatUpdate, ok := update.(agent.ChatUpdate); ok && chatUpdate.Message != nil {
					chatUpdate.Message.Via = "telegram"
					c.emitChatUpdate(chatUpdate)
					currentContent = chatUpdate.Message.Content
				}
			})
			awake.Stop()
			if qErr != nil {
				err = qErr
				break
			}
		}
	}

	// After the Agent is done, send a SINGLE message to Telegram
	if currentContent != "" {
		// Clear draft first
		c.mu.Lock()
		draftID, hasDraft := c.draftMessages[resp.ChatID]
		delete(c.draftMessages, resp.ChatID)
		c.mu.Unlock()

		if hasDraft && c.tgBot != nil {
			// Final results can be large, we might want to edit the draft or send new.
			// Re-use draft for final content to keep chat clean.
			err := c.tgBot.EditMessage(ctx, resp.ChatID, draftID, currentContent)
			if err != nil {
				// Fallback to new message
				_, _ = c.tgBot.SendMessageAndTrack(ctx, resp.ChatID, currentContent)
			}
		} else if c.tgBot != nil {
			_, sendErr := c.tgBot.SendMessageAndTrack(ctx, resp.ChatID, currentContent)
			if sendErr != nil {
				log.Printf("Failed to send final message to Telegram: %v", sendErr)
			}
		}
	} else if err != nil {
		c.tgBot.SendErrorActions(ctx, resp.ChatID, sessionID, err.Error())
	}

	// Emit responding activity (done)
	c.emitActivity("responding", "telegram", resp.Username, "")
}

func (c *Controller) handleDiscordMessage(ctx context.Context, resp *discord.UserResponse) {
	log.Printf("Live Mode received Discord message from channel %s: %s", resp.ChannelID, resp.Text)
	target := discordTargetFromResponse(resp)
	replyChannelID := discordReplyChannelFromResponse(resp)
	targetKey := target.Key()
	content := strings.TrimSpace(resp.Text)

	switch content {
	case "/status":
		c.sendDiscordStatus(ctx, replyChannelID)
		return
	case "/sessions":
		c.sendDiscordSessions(ctx, replyChannelID)
		return
	case "/help":
		c.sendDiscordHelp(ctx, replyChannelID)
		return
	}

	if !c.IsEnabled() {
		c.discordBot.SendMessage(ctx, replyChannelID, etherGatewayDisabledMessage)
		return
	}

	if c.agent == nil {
		c.mu.RLock()
		handler := c.onUserMessage
		c.mu.RUnlock()
		if handler != nil {
			handler(resp.Text)
			return
		}
		c.discordBot.SendMessage(ctx, replyChannelID, "⚠️ Agent not configured and no input handler wired.")
		return
	}

	switch {
	case content == "/stop":
		c.Disable(ctx)
		return
	case content == "/new":
		if !c.canCreateRemoteSession("discord", target, content) {
			c.discordBot.SendMessage(ctx, replyChannelID, remoteSessionStartDisabledMessage)
			return
		}
		s := c.agent.CreateSession()
		_, threadChannelID, createdThread := c.discordBot.CreateSessionThread(ctx, target, s.ID)
		if createdThread {
			c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("🧵 **Thread created and linked:** <#%s>", threadChannelID))
			c.discordBot.SendMessage(ctx, threadChannelID, fmt.Sprintf("🆕 **New session started:** `%s`\n\nWrite here directly; no mention needed.", s.ID))
		} else {
			c.discordBot.SetActiveSessionForTarget(target, s.ID)
			c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("🆕 **New session started:** `%s`", s.ID))
		}
		return
	case strings.HasPrefix(content, "/switch "):
		sessionID := strings.TrimSpace(strings.TrimPrefix(content, "/switch "))
		if sessionID == "" {
			c.discordBot.SendMessage(ctx, replyChannelID, "Usage: `/ricochet switch session:<session_id>`")
			return
		}
		c.discordBot.SetActiveSessionForTarget(target, sessionID)
		c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("✅ **Switched to session:** `%s`", sessionID))
		return
	}

	c.emitActivity("receiving", "discord", resp.Username, resp.Text)

	sessionID := c.discordBot.GetActiveSessionForTarget(target)
	if sessionID == "" {
		if !c.canCreateRemoteSession("discord", target, content) {
			c.discordBot.SendMessage(ctx, replyChannelID, remoteSessionStartDisabledMessage)
			return
		}
	} else if c.agent.GetSession(sessionID) == nil {
		if !c.canCreateRemoteSession("discord", target, content) {
			c.discordBot.SendMessage(ctx, replyChannelID, staleRemoteSessionMessage)
			return
		}
	}

	if sessionID == "" || c.agent.GetSession(sessionID) == nil {
		sessions := c.agent.ListSessions()
		if len(sessions) > 0 {
			sessionID = sessions[0].ID
			log.Printf("Live Mode: Resuming existing active session %s for Discord target %s", sessionID, targetKey)
		} else {
			s := c.agent.CreateSession()
			sessionID = s.ID
			log.Printf("Live Mode: Created new session %s for Discord target %s", sessionID, targetKey)
		}
		c.discordBot.SetActiveSessionForTarget(target, sessionID)
	}

	if content == "/cancel" {
		if c.agent.AbortSession(sessionID) {
			c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("🛑 **Cancel requested for session:** `%s`", sessionID))
		} else {
			c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("ℹ️ **No active run for session:** `%s`", sessionID))
		}
		return
	}
	if content == "/queue" {
		c.sendDiscordQueue(ctx, replyChannelID, sessionID)
		return
	}

	c.enqueueDiscordEther(sessionID, resp, target)
	c.emitChatUpdate(agent.ChatUpdate{
		SessionID: sessionID,
		Message: &agent.ChatMessage{
			ID:        "discord-" + resp.ChannelID + "-" + resp.MessageID,
			Role:      "user",
			Content:   resp.Text,
			Timestamp: resp.Timestamp,
			Via:       "discord",
			Username:  resp.Username,
			SessionID: sessionID,
		},
	})
	c.discordBot.SendTyping(ctx, replyChannelID)
	c.emitActivity("processing", "discord", resp.Username, "")

	chatCtx := context.WithValue(ctx, discordTargetKey, target)
	req := agent.ChatRequestInput{
		SessionID: sessionID,
		Content:   resp.Text,
		Via:       "discord",
	}
	c.mu.Lock()
	c.lastDiscordRequests[targetKey] = &req
	c.mu.Unlock()

	if !c.tryMarkSessionBusy(sessionID) {
		deliveryText := resp.Text
		var ok bool
		if strings.HasPrefix(content, "/steer ") {
			deliveryText = strings.TrimSpace(strings.TrimPrefix(content, "/steer "))
			_, ok = c.agent.SteerQueuedMessage(sessionID, req.RunID, deliveryText, "discord")
		} else {
			_, ok = c.agent.EnqueueUserMessage(sessionID, req.RunID, deliveryText, "discord")
		}
		if ok {
			c.discordBot.SendMessage(ctx, replyChannelID, "📥 **Command queued for the active run.**")
		}
		return
	}
	defer c.markSessionIdle(sessionID)

	var currentContent string
	awake, awakeErr := keepawake.Start("discord live mode run")
	if awakeErr != nil {
		log.Printf("Warning: keep-awake unavailable: %v", awakeErr)
		c.discordBot.SendMessage(ctx, replyChannelID, "⚠️ Keep-awake is unavailable; the task will continue while this computer stays awake.")
	}
	err := c.agent.Chat(chatCtx, req, func(update interface{}) {
		if tp, ok := update.(protocol.TaskProgress); ok {
			c.emitTaskProgress(tp)
			return
		}
		chatUpdate, ok := update.(agent.ChatUpdate)
		if !ok || chatUpdate.Message == nil {
			return
		}
		currentContent = chatUpdate.Message.Content
		chatUpdate.Message.Via = "discord"
		c.emitChatUpdate(chatUpdate)
	})
	awake.Stop()

	if err == nil {
		for _, queued := range c.agent.DrainQueuedMessages(sessionID) {
			c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("▶️ **Running queued command:** %s", truncateForMessengerStatus(queued.Text)))
			awake, awakeErr := keepawake.Start("discord queued live mode run")
			if awakeErr != nil {
				log.Printf("Warning: keep-awake unavailable: %v", awakeErr)
			}
			qErr := c.agent.Chat(chatCtx, agent.ChatRequestInput{
				SessionID:    queued.SessionID,
				Content:      queued.Text,
				Via:          queued.Via,
				RunID:        queued.RunID,
				ContextFiles: queued.ContextFiles,
			}, func(update interface{}) {
				if chatUpdate, ok := update.(agent.ChatUpdate); ok && chatUpdate.Message != nil {
					chatUpdate.Message.Via = "discord"
					c.emitChatUpdate(chatUpdate)
					currentContent = chatUpdate.Message.Content
				}
			})
			awake.Stop()
			if qErr != nil {
				err = qErr
				break
			}
		}
	}

	if currentContent != "" {
		if _, sendErr := c.discordBot.SendMessageAndTrack(ctx, replyChannelID, currentContent); sendErr != nil {
			log.Printf("Failed to send final message to Discord: %v", sendErr)
		}
	} else if err != nil {
		c.discordBot.SendErrorActions(ctx, replyChannelID, sessionID, err.Error())
	}
	c.emitActivity("responding", "discord", resp.Username, "")
}

func (c *Controller) sendDiscordStatus(ctx context.Context, channelID string) {
	if c.agent != nil {
		pm := c.agent.GetPlanManager()
		if pm != nil {
			statusText := pm.GenerateContext()
			if statusText == "" {
				statusText = "📭 **No active plan found.**"
			} else {
				statusText = "📊 **Current Status & Plan**\n" + statusText
			}
			c.discordBot.SendMessage(ctx, channelID, statusText)
			return
		}
	}
	c.discordBot.SendMessage(ctx, channelID, "⚠️ Agent or Plan Manager not ready.")
}

func (c *Controller) sendDiscordSessions(ctx context.Context, channelID string) {
	if c.agent == nil {
		c.discordBot.SendMessage(ctx, channelID, "⚠️ Agent not ready.")
		return
	}
	sessions := c.agent.ListSessions()
	var views []discord.SessionView
	for _, s := range sessions {
		views = append(views, discord.SessionView{ID: s.ID, TotalCost: s.TotalCost})
	}
	c.discordBot.SendSessionList(ctx, channelID, views)
}

func (c *Controller) sendDiscordHelp(ctx context.Context, channelID string) {
	c.discordBot.SendMessage(ctx, channelID, "Ricochet commands: `/ricochet new`, `/ricochet status`, `/ricochet sessions`, `/ricochet run`, `/ricochet cancel`, `/ricochet queue`, `/ricochet switch`.")
}

func (c *Controller) sendDiscordQueue(ctx context.Context, channelID, sessionID string) {
	session := c.agent.GetSession(sessionID)
	if session == nil || len(session.MessageQueue) == 0 {
		c.discordBot.SendMessage(ctx, channelID, "📭 **Queue is empty.**")
		return
	}
	var sb strings.Builder
	sb.WriteString("📥 **Queued commands:**\n\n")
	for i, queued := range session.MessageQueue {
		if i >= 5 {
			sb.WriteString(fmt.Sprintf("…and %d more", len(session.MessageQueue)-i))
			break
		}
		sb.WriteString(fmt.Sprintf("%d. `%s` — %s\n", i+1, queued.Delivery, truncateForMessengerStatus(queued.Text)))
	}
	c.discordBot.SendMessage(ctx, channelID, sb.String())
}

func discordTargetFromResponse(resp *discord.UserResponse) state.MessengerTarget {
	return state.MessengerTarget{
		Platform:  "discord",
		GuildID:   resp.GuildID,
		ChannelID: resp.ChannelID,
		ThreadID:  resp.ThreadID,
		UserID:    resp.UserID,
	}
}

func discordReplyChannelFromResponse(resp *discord.UserResponse) string {
	if resp == nil {
		return ""
	}
	if resp.ThreadID != "" {
		return resp.ThreadID
	}
	return resp.ChannelID
}

func discordReplyChannelFromCallback(callback *discord.CallbackEvent) string {
	if callback == nil {
		return ""
	}
	if callback.ThreadID != "" {
		return callback.ThreadID
	}
	return callback.ChannelID
}

func (c *Controller) enqueueDiscordEther(sessionID string, resp *discord.UserResponse, target state.MessengerTarget) {
	if sessionID == "" || resp == nil {
		return
	}
	timestamp := time.Now()
	if resp.Timestamp > 0 {
		timestamp = time.Unix(resp.Timestamp, 0)
	}
	ether.Get().Enqueue(sessionID, ether.Event{
		Type:      ether.EventUserMessage,
		Content:   resp.Text,
		Timestamp: timestamp,
		Metadata: map[string]string{
			"platform":   "discord",
			"guild_id":   target.GuildID,
			"channel_id": target.ChannelID,
			"thread_id":  target.ThreadID,
			"user_id":    resp.UserID,
			"username":   resp.Username,
			"message_id": resp.MessageID,
		},
	})
}

func (c *Controller) tryMarkSessionBusy(sessionID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.busySessions == nil {
		c.busySessions = make(map[string]bool)
	}
	if c.busySessions[sessionID] {
		return false
	}
	c.busySessions[sessionID] = true
	return true
}

func (c *Controller) markSessionIdle(sessionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.busySessions, sessionID)
}

func truncateForTelegramStatus(text string) string {
	return truncateForMessengerStatus(text)
}

func truncateForMessengerStatus(text string) string {
	text = strings.TrimSpace(text)
	if len(text) <= 120 {
		return text
	}
	return text[:117] + "..."
}

// handleTelegramCallback processes button clicks
func (c *Controller) handleTelegramCallback(ctx context.Context, callback *telegram.CallbackEvent) {
	log.Printf("Live Mode received callback: %s from chat %d", callback.Data, callback.ChatID)

	// Veto / Error Handling
	if strings.HasPrefix(callback.Data, "veto:") {
		parts := strings.Split(callback.Data, ":")
		if len(parts) < 3 {
			return
		}
		action := parts[1]
		_ = parts[2] // sessionID is present but not used yet for direct state manipulation

		switch action {
		case "retry":
			c.tgBot.SendMessage(ctx, callback.ChatID, "🔄 **Перезапуск последней задачи...**")

			c.mu.RLock()
			lastReq := c.lastRequests[callback.ChatID]
			c.mu.RUnlock()

			if lastReq != nil {
				// Re-run the message handler with the last request info
				go func() {
					mockResp := &telegram.UserResponse{
						ChatID:    callback.ChatID,
						Text:      lastReq.Content,
						Timestamp: time.Now().UnixMilli(),
						Username:  "User (Retry)",
					}
					c.handleTelegramMessage(context.Background(), mockResp)
				}()
			} else {
				c.tgBot.SendMessage(ctx, callback.ChatID, "⚠️ Ошибка: не удалось найти параметры последнего запроса.")
			}
		case "fix":
			c.tgBot.SendMessage(ctx, callback.ChatID, "✍️ **Режим исправления активирован.**\nОтправьте сообщение с исправленной командой или инструкцией. Агент подхватит его в следующем цикле.")
		case "abort":
			c.tgBot.SendMessage(ctx, callback.ChatID, "🛑 **Задача отменена.**")
		}
		return
	}

	// Session Switching
	if strings.HasPrefix(callback.Data, "session:") {
		sessionID := strings.TrimPrefix(callback.Data, "session:")
		c.tgBot.SetActiveSession(callback.ChatID, sessionID)
		c.tgBot.SendMessage(ctx, callback.ChatID, fmt.Sprintf("✅ **Switched to session:** `%s`", sessionID))

		// Show recent history
		if c.agent != nil {
			if session := c.agent.GetSession(sessionID); session != nil {
				msgs := session.StateHandler.GetMessages()
				count := len(msgs)
				if count > 0 {
					start := count - 6
					if start < 0 {
						start = 0
					}
					var history strings.Builder
					history.WriteString("📜 **Recent Context:**\n\n")

					for _, m := range msgs[start:] {
						if m.Role == "system" {
							continue
						}
						// Skip tool use/results to keep it clean, or maybe show a summary
						if m.Role == "tool" {
							continue
						}

						icon := "👤"
						if m.Role == "assistant" {
							icon = "🤖"
						}

						content := m.Content
						if len(content) > 200 {
							content = content[:200] + "..."
						}
						// If content is empty (e.g. pure tool call), skip
						if strings.TrimSpace(content) == "" {
							continue
						}

						history.WriteString(fmt.Sprintf("%s **%s**: %s\n\n", icon, strings.Title(m.Role), content))
					}
					c.tgBot.SendMessage(ctx, callback.ChatID, history.String())
				}
			}
		}
		return
	}

	switch callback.Data {
	case telegram.CallbackNewChat:
		target := state.MessengerTarget{Platform: "telegram", ChatID: callback.ChatID}
		if !c.IsEnabled() {
			c.tgBot.SendMessage(ctx, callback.ChatID, etherGatewayDisabledMessage)
			return
		}
		if !c.canCreateRemoteSession("telegram", target, "new_chat") {
			c.tgBot.SendMessage(ctx, callback.ChatID, remoteSessionStartDisabledMessage)
			return
		}
		if c.agent != nil {
			s := c.agent.CreateSession()
			c.tgBot.SetActiveSession(callback.ChatID, s.ID)
			c.tgBot.SendMessage(ctx, callback.ChatID, fmt.Sprintf("🆕 **New Session Started:** `%s`\n\nI am ready. What would you like to build?", s.ID))
		}

	case telegram.CallbackChatHistory:
		if c.agent != nil {
			sessions := c.agent.ListSessions()
			var views []telegram.SessionView
			for _, s := range sessions {
				views = append(views, telegram.SessionView{
					ID:        s.ID,
					TotalCost: s.TotalCost,
				})
			}
			c.tgBot.SendSessionList(ctx, callback.ChatID, views)
		} else {
			c.tgBot.SendMessage(ctx, callback.ChatID, "⚠️ Agent not ready.")
		}

	case CallbackVetoRetry:
		c.tgBot.SendMessage(ctx, callback.ChatID, "🔄 **Retry requested.** Agent is fixing issues...")
		go c.InjectUserMessage(ctx, callback.ChatID, "The quality checks failed. Please fix the reported issues and try again.")

	case CallbackVetoIgnore:
		c.tgBot.SendMessage(ctx, callback.ChatID, "🛡️ **Veto ignored.** Agent is proceeding...")
		go c.InjectUserMessage(ctx, callback.ChatID, "I have reviewed the quality checks and I want you to proceed anyway. Ignore the last veto and finalize the task.")
	}
}

func (c *Controller) handleDiscordCallback(ctx context.Context, callback *discord.CallbackEvent) {
	log.Printf("Live Mode received Discord callback: %s from channel %s", callback.Data, callback.ChannelID)
	target := state.MessengerTarget{
		Platform:  "discord",
		GuildID:   callback.GuildID,
		ChannelID: callback.ChannelID,
		ThreadID:  callback.ThreadID,
		UserID:    callback.UserID,
	}
	replyChannelID := discordReplyChannelFromCallback(callback)
	targetKey := target.Key()

	if strings.HasPrefix(callback.Data, "veto:") {
		parts := strings.Split(callback.Data, ":")
		if len(parts) < 3 {
			return
		}
		action := parts[1]
		sessionID := parts[2]
		switch action {
		case "retry":
			c.discordBot.SendMessage(ctx, replyChannelID, "🔄 **Retrying the last task...**")
			c.mu.RLock()
			lastReq := c.lastDiscordRequests[targetKey]
			c.mu.RUnlock()
			if lastReq != nil {
				go c.handleDiscordMessage(context.Background(), &discord.UserResponse{
					ChannelID: callback.ChannelID,
					GuildID:   callback.GuildID,
					ThreadID:  callback.ThreadID,
					UserID:    callback.UserID,
					Username:  "User (Retry)",
					Text:      lastReq.Content,
					Timestamp: time.Now().Unix(),
				})
			} else {
				c.discordBot.SendMessage(ctx, replyChannelID, "⚠️ Could not find the last request for this Discord target.")
			}
		case "fix":
			c.discordBot.SendMessage(ctx, replyChannelID, "✍️ **Fix mode active.** Send the corrected instruction and Ricochet will use it in the next cycle.")
		case "abort":
			if sessionID != "" && c.agent != nil {
				c.agent.AbortSession(sessionID)
			}
			c.discordBot.SendMessage(ctx, replyChannelID, "🛑 **Task aborted.**")
		}
		return
	}

	if strings.HasPrefix(callback.Data, "session:") {
		sessionID := strings.TrimPrefix(callback.Data, "session:")
		c.discordBot.SetActiveSessionForTarget(target, sessionID)
		c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("✅ **Switched to session:** `%s`", sessionID))
		return
	}

	switch callback.Data {
	case telegram.CallbackNewChat:
		if !c.IsEnabled() {
			c.discordBot.SendMessage(ctx, replyChannelID, etherGatewayDisabledMessage)
			return
		}
		if !c.canCreateRemoteSession("discord", target, "new_chat") {
			c.discordBot.SendMessage(ctx, replyChannelID, remoteSessionStartDisabledMessage)
			return
		}
		if c.agent != nil {
			s := c.agent.CreateSession()
			_, threadChannelID, createdThread := c.discordBot.CreateSessionThread(ctx, target, s.ID)
			if createdThread {
				c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("🧵 **Thread created and linked:** <#%s>", threadChannelID))
				c.discordBot.SendMessage(ctx, threadChannelID, fmt.Sprintf("🆕 **New session started:** `%s`\n\nWrite here directly; no mention needed.", s.ID))
			} else {
				c.discordBot.SetActiveSessionForTarget(target, s.ID)
				c.discordBot.SendMessage(ctx, replyChannelID, fmt.Sprintf("🆕 **New session started:** `%s`\n\nI am ready.", s.ID))
			}
		}
	case CallbackVetoRetry:
		c.discordBot.SendMessage(ctx, replyChannelID, "🔄 **Retry requested.** Agent is fixing issues...")
		go c.handleDiscordMessage(ctx, &discord.UserResponse{
			ChannelID: callback.ChannelID,
			GuildID:   callback.GuildID,
			ThreadID:  callback.ThreadID,
			UserID:    callback.UserID,
			Username:  "System (Admin Override)",
			Text:      "The quality checks failed. Please fix the reported issues and try again.",
			Timestamp: time.Now().Unix(),
		})
	case CallbackVetoIgnore:
		c.discordBot.SendMessage(ctx, replyChannelID, "🛡️ **Veto ignored.** Agent is proceeding...")
		go c.handleDiscordMessage(ctx, &discord.UserResponse{
			ChannelID: callback.ChannelID,
			GuildID:   callback.GuildID,
			ThreadID:  callback.ThreadID,
			UserID:    callback.UserID,
			Username:  "System (Admin Override)",
			Text:      "I have reviewed the quality checks and I want you to proceed anyway. Ignore the last veto and finalize the task.",
			Timestamp: time.Now().Unix(),
		})
	}
}

// InjectUserMessage submits a hidden user instruction to the active session
func (c *Controller) InjectUserMessage(ctx context.Context, chatID int64, text string) {
	c.mu.RLock()
	a := c.agent
	c.mu.RUnlock()

	if a == nil {
		return
	}

	sessionID := c.tgBot.GetActiveSession(chatID)
	if sessionID == "" {
		// FALLBACK: User wants to resume the latest session
		sessions := a.ListSessions()
		if len(sessions) > 0 {
			sessionID = sessions[0].ID
		}
	}

	if sessionID == "" {
		return
	}

	// We use the standard handleTelegramMessage logic but with synthetic response
	c.handleTelegramMessage(ctx, &telegram.UserResponse{
		ChatID:    chatID,
		Text:      text,
		SessionID: sessionID,
		Username:  "System (Admin Override)",
		Timestamp: time.Now().Unix(),
	})
}

// SetAgent sets the agent controller and subscribes to its autonomous events
func (c *Controller) SetAgent(agentPtr *agent.Controller) {
	c.mu.Lock()
	c.agent = agentPtr
	c.mu.Unlock()

	if agentPtr != nil {
		agentPtr.Subscribe(c.handleAgentEvent)
		log.Println("📬 Live Mode subscribed to Agent Event Bus")
	}
}

// handleAgentEvent processes proactive signals from the agent
func (c *Controller) handleAgentEvent(evt agent.Event) {
	c.mu.RLock()
	chatID := c.chatID
	enabled := c.enabled
	tgBot := c.tgBot
	c.mu.RUnlock()

	if !enabled || tgBot == nil || chatID == 0 {
		return
	}

	ctx := context.Background()

	switch evt.Type {
	case agent.EventTaskStarted:
		title, _ := evt.Payload["title"].(string)
		text := fmt.Sprintf("🏗️ **Task Started**\n\nI've begun working on: `%s`", title)
		tgBot.SendMessage(ctx, chatID, text)
		log.Printf("Proactive Task Started Alert sent to Telegram chat %d", chatID)

	case agent.EventTaskFinished:
		title, _ := evt.Payload["title"].(string)
		summary, _ := evt.Payload["summary"].(string)
		text := fmt.Sprintf("✅ **Task Finished**\n\n**Goal:** `%s`\n\n**Summary:**\n%s", title, summary)
		tgBot.SendMessage(ctx, chatID, text)
		log.Printf("Proactive Task Finished Alert sent to Telegram chat %d", chatID)

	case agent.EventVetoed:
		errMsg, _ := evt.Payload["error"].(string)
		text := fmt.Sprintf("🚨 **VETO ALERT**\n\nA quality check hook blocked the task completion.\n\n**Issue:**\n`%s`\n\nHow should I proceed?", errMsg)

		buttons := [][]telegram.ButtonConfig{
			{
				{Text: "🔄 Retry (Apply Fix)", Data: CallbackVetoRetry},
				{Text: "🛡️ Ignore (Proceed)", Data: CallbackVetoIgnore},
			},
		}

		tgBot.SendMessageWithButtons(ctx, chatID, text, buttons)
		log.Printf("Proactive Veto Alert sent to Telegram chat %d", chatID)

	case agent.EventFileChanged:
		filename, _ := evt.Payload["file"].(string)
		text := fmt.Sprintf("👁️ **File Changed Externally**\n\nI detected an external edit to `%s`. Should I re-index or adjust context?", filename)
		tgBot.SendMessage(ctx, chatID, text)
	}
}

// SetChatID sets the primary Telegram chat ID
func (c *Controller) SetChatID(chatID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.chatID = chatID
}

// SetOnActivity sets the callback for activity events
func (c *Controller) SetOnActivity(fn func(EtherActivity)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onActivity = fn
}

// SetOnChatUpdate sets the callback for forwarding chat updates to IDE
func (c *Controller) SetOnChatUpdate(fn func(agent.ChatUpdate)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onChatUpdate = fn
}

// SetOnUserMessage sets the callback for injecting user input (CLI/TUI)
func (c *Controller) SetOnUserMessage(fn func(string)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onUserMessage = fn
}

// emitActivity sends an activity event to the extension
func (c *Controller) emitActivity(stage, source, username, preview string) {
	c.mu.Lock()
	c.lastSource = source
	fn := c.onActivity
	c.mu.Unlock()

	if fn != nil {
		// Truncate preview to 50 chars
		if len(preview) > 50 {
			preview = preview[:50] + "..."
		}
		fn(EtherActivity{
			Stage:    stage,
			Source:   source,
			Username: username,
			Preview:  preview,
		})
	}
}

// emitChatUpdate forwards a chat update to the IDE
// Includes throttling for streaming updates to prevent webview overflow
func (c *Controller) emitChatUpdate(update agent.ChatUpdate) {
	if update.Message == nil {
		return
	}

	c.mu.Lock()
	fn := c.onChatUpdate
	lastTime := c.lastChatUpdateTime
	now := time.Now()

	// Throttle streaming updates to max 20/second (50ms interval) for smoother UI
	// Final messages (IsStreaming=false) bypass throttle
	const throttleInterval = 50 * time.Millisecond

	// Bypass throttle for reasoning updates (to show thinking immediately)
	hasReasoning := update.Message.Reasoning != ""

	if update.Message.IsStreaming && !hasReasoning && now.Sub(lastTime) < throttleInterval {
		c.mu.Unlock()
		return
	}
	c.lastChatUpdateTime = now
	c.mu.Unlock()

	if fn != nil {
		// Populate SessionID from the update wrapper if missing in message
		if update.Message.SessionID == "" {
			update.Message.SessionID = update.SessionID
		}
		fn(update)
	}
}

// IsEnabled returns true if Live Mode is currently active
func (c *Controller) IsEnabled() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.enabled
}

func (c *Controller) remoteSessionStartAllowed() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.allowRemoteSessionStart
}

func (c *Controller) canCreateRemoteSession(platform string, target state.MessengerTarget, command string) bool {
	allowed := c.remoteSessionStartAllowed()
	if !allowed {
		log.Printf("Remote session start denied platform=%s command=%s target=%s", platform, command, target.Key())
	}
	return allowed
}

// AskUserRemote sends an approval request to Telegram and waits for response
// This is used for tool consent when the user is controlling via Ether Mode
func (c *Controller) AskUserRemote(ctx context.Context, question string) (string, error) {
	c.mu.RLock()
	enabled := c.enabled
	tgBot := c.tgBot
	discordBot := c.discordBot
	chatID := c.chatID
	c.mu.RUnlock()

	if !enabled {
		return "", fmt.Errorf("live mode not enabled")
	}

	if discordTarget, ok := ctx.Value(discordTargetKey).(state.MessengerTarget); ok && discordBot != nil {
		if discordTarget.ChannelID == "" {
			return "", fmt.Errorf("discord channel ID not set")
		}
		approvalID := "RA-" + strings.ToUpper(strconv.FormatInt(time.Now().UnixNano()%0xffffff, 36))
		question = fmt.Sprintf("Approval `%s`\n\n%s", approvalID, question)
		c.emitActivity("approval_requested", "discord", "", approvalID)
		response, err := discordBot.AskUser(ctx, discordTarget, question)
		if err == nil && response != "" {
			var status string
			switch response {
			case "yes":
				status = "✅ Approved via Discord"
			case "no":
				status = "❌ Rejected via Discord"
			case "always allow":
				status = "🛡️ Always Allow enabled via Discord"
			default:
				status = "Received: " + response
			}
			c.emitActivity("approved", "discord", "", approvalID+" "+status)
		}
		return response, err
	}

	if tgBot == nil {
		return "", fmt.Errorf("telegram bot not configured")
	}

	if chatID == 0 {
		return "", fmt.Errorf("telegram chat ID not set")
	}

	approvalID := "RA-" + strings.ToUpper(strconv.FormatInt(time.Now().UnixNano()%0xffffff, 36))
	question = fmt.Sprintf("Approval `%s`\n\n%s", approvalID, question)
	c.emitActivity("approval_requested", "telegram", "", approvalID)

	// Use the bot's AskUser method which handles inline buttons
	// Prefer context chatID if available (dynamic routing)
	var response string
	var err error
	if ctxChatID, ok := ctx.Value(chatIDKey).(int64); ok {
		response, err = tgBot.AskUser(ctx, ctxChatID, question)
	} else {
		// Fallback to default configured ChatID
		response, err = tgBot.AskUser(ctx, chatID, question)
	}

	// Emit activity to notify UI about the approval
	if err == nil && response != "" {
		var status string
		switch response {
		case "yes":
			status = "✅ Approved via Telegram"
		case "no":
			status = "❌ Rejected via Telegram"
		case "always allow":
			status = "🛡️ Always Allow enabled via Telegram"
		default:
			status = "Received: " + response
		}
		c.emitActivity("approved", "telegram", "", approvalID+" "+status)
	}

	return response, err
}
