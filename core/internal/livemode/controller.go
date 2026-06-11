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
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/state"
	"github.com/igoryan-dao/ricochet/internal/telegram"
	"github.com/igoryan-dao/ricochet/internal/whisper"
)

type contextKey string

const chatIDKey contextKey = "chatID"

// Callback data constants for Veto Loop (Sprint 4.0)
const (
	CallbackVetoRetry  = "veto:retry"
	CallbackVetoIgnore = "veto:ignore"
)

// Controller manages Live Mode - bridging Telegram/Discord with the AI agent
type Controller struct {
	mu sync.RWMutex

	enabled  bool
	tgBot    *telegram.Bot
	agent    *agent.Controller
	stateMgr *state.Manager
	chatID   int64 // Primary Telegram chat ID for notifications

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

	// Throttling for streaming updates to prevent webview crash
	lastChatUpdateTime time.Time

	// Draft Messages for Telegram status updates (chatID -> messageID)
	draftMessages map[int64]int

	// Track last request for retry functionality
	lastRequests map[int64]*agent.ChatRequestInput
}

// SetMainSessionID sets the primary session ID for binding
func (c *Controller) SetMainSessionID(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.mainSessionID = id
}

// ... (skip lines)

// SetOnTaskProgress sets the callback for forwarding task progress
func (c *Controller) SetOnTaskProgress(fn func(protocol.TaskProgress)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onTaskProgress = fn
}

// ... (skip lines)

// emitTaskProgress forwards task progress to the IDE
func (c *Controller) emitTaskProgress(progress protocol.TaskProgress) {
	c.mu.RLock()
	fn := c.onTaskProgress
	c.mu.RUnlock()

	if fn != nil {
		fn(progress)
	}
}

// ... (skip lines)

// Config holds Live Mode configuration
type Config struct {
	TelegramToken  string  `json:"telegram_token"`
	TelegramChatID int64   `json:"telegram_chat_id"`
	AllowedUserIDs []int64 `json:"allowed_user_ids"`
	WhisperBinary  string  `json:"whisper_binary,omitempty"`
	WhisperModel   string  `json:"whisper_model,omitempty"`
}

// Status represents the current Live Mode status
type Status struct {
	Enabled      bool   `json:"enabled"`
	ConnectedVia string `json:"connectedVia,omitempty"` // "telegram", "discord", or nil
	LastActivity string `json:"lastActivity,omitempty"`
	SessionID    string `json:"sessionId,omitempty"`
	IsDaemon     bool   `json:"isDaemon"`
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
		agent:         agentCtrl,
		stateMgr:      stateMgr,
		chatID:        cfg.TelegramChatID,
		draftMessages: make(map[int64]int),
		lastRequests:  make(map[int64]*agent.ChatRequestInput),
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

// Start begins the background poller (must be called once)
func (c *Controller) Start(ctx context.Context) {
	c.mu.Lock()
	if c.tgBot == nil {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()

	// Start Telegram bot in background
	go c.tgBot.Start(ctx)

	// Start message listener
	go c.listenForMessages(ctx)

	// log.Println("Live Mode background poller started")
}

// Enable starts Live Mode
func (c *Controller) Enable(ctx context.Context) (*Status, error) {
	c.mu.Lock()
	c.enabled = true
	c.mu.Unlock() // Release lock
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
	status := &Status{
		Enabled:  c.enabled,
		IsDaemon: c.isDaemon,
	}
	if c.enabled {
		if c.tgBot != nil {
			status.ConnectedVia = "telegram"
		} else {
			status.ConnectedVia = "offline (demo)"
		}
	}
	return status
}

// SetDaemon marks the controller as running in background mode
func (c *Controller) SetDaemon(isDaemon bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.isDaemon = isDaemon
	c.broadcastStatus()
}

// listenForMessages handles incoming Telegram messages and forwards to agent
func (c *Controller) listenForMessages(ctx context.Context) {
	if c.tgBot == nil {
		return
	}

	responseCh := c.tgBot.GetResponseChannel()
	callbackCh := c.tgBot.GetCallbackChannel()

	for {
		select {
		case <-ctx.Done():
			return

		case resp := <-responseCh:
			if resp == nil {
				continue
			}
			// Handle async so we don't block on agent.Chat()
			go c.handleTelegramMessage(ctx, resp)

		case callback := <-callbackCh:
			if callback == nil {
				continue
			}
			c.handleTelegramCallback(ctx, callback)
		}
	}
}

// handleTelegramMessage processes incoming Telegram messages
func (c *Controller) handleTelegramMessage(ctx context.Context, resp *telegram.UserResponse) {
	log.Printf("Live Mode received message from chat %d: %s", resp.ChatID, resp.Text)

	// Auto-Enable if disabled
	// Auto-Enable if disabled
	if !c.IsEnabled() {
		log.Println("Live Mode triggering AUTO-ENABLE via Telegram")
		c.mu.Lock()
		c.enabled = true
		c.mu.Unlock()

		// FORCE NEW SESSION on auto-enable
		// This breaks any stale links to CLI sessions (Zombie Session Fix)
		if c.agent != nil {
			// Check if we have a main session bound (TUI active)
			var boundSessionID string
			if c.mainSessionID != "" {
				boundSessionID = c.mainSessionID
				log.Printf("Live Mode: Auto-binding to Main Session %s", boundSessionID)
			} else {
				// Create new if unbound
				s := c.agent.CreateSession()
				boundSessionID = s.ID
				log.Printf("Live Mode: Auto-Enable forced new session %s for chat %d", s.ID, resp.ChatID)
			}

			c.tgBot.SetActiveSession(resp.ChatID, boundSessionID)
		}

		c.tgBot.SendMessage(ctx, resp.ChatID, "🟢 **Ricochet Activated!**\n\nBridging to IDE...")
		c.broadcastStatus()
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
	if resp.Text == "/stop" {
		c.Disable(ctx)
		return
	}

	// Handle /new command
	if resp.Text == "/new" {
		c.agent.ClearSession("default") // Assuming default session for now
		c.tgBot.SendMessage(ctx, resp.ChatID, "🆕 **New Session Started**")
		return
	}

	// Emit receiving activity
	c.emitActivity("receiving", "telegram", resp.Username, resp.Text)

	// Resolve Session ID EARLY so we can tag the user message
	sessionID := c.tgBot.GetActiveSession(resp.ChatID)
	// Check if session ID is valid AND exists in current agent instance
	if sessionID == "" || c.agent.GetSession(sessionID) == nil {
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
	c.mu.RLock()
	fn := c.onActivity
	c.mu.RUnlock()

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

// AskUserRemote sends an approval request to Telegram and waits for response
// This is used for tool consent when the user is controlling via Ether Mode
func (c *Controller) AskUserRemote(ctx context.Context, question string) (string, error) {
	c.mu.RLock()
	enabled := c.enabled
	tgBot := c.tgBot
	chatID := c.chatID
	c.mu.RUnlock()

	if !enabled {
		return "", fmt.Errorf("live mode not enabled")
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
