package telegram

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
	"github.com/gofrs/flock"
	"github.com/igoryan-dao/ricochet/internal/bridge"
	"github.com/igoryan-dao/ricochet/internal/bridge/proto"
	"github.com/igoryan-dao/ricochet/internal/ether"
	"github.com/igoryan-dao/ricochet/internal/format"
	"github.com/igoryan-dao/ricochet/internal/state"
	"github.com/igoryan-dao/ricochet/internal/whisper"
)

// Callback data constants
const (
	CallbackChatHistory = "chat_history"
	CallbackNewChat     = "new_chat"
)

// Global lock to prevent multiple bots in the same process
var (
	processLock   sync.Mutex
	isBotActive   bool
	activeBotLock *flock.Flock
)

// Bot wraps Telegram bot with message handling
type Bot struct {
	bot            *bot.Bot
	token          string
	allowedUserIDs map[int64]bool
	state          *state.Manager

	// Channel for receiving user responses (generic)
	responseCh chan *UserResponse

	// Channel for callback events
	callbackCh chan *CallbackEvent

	// Active session per chat (chatID -> SessionUUID)
	activeMu       sync.Mutex
	activeSessions map[int64]string

	// Pending questions awaiting answers (chatID -> response channel)
	pendingMu sync.Mutex
	pending   map[int64]chan string

	// Session specific channels (SessionUUID -> response channel)
	sessionMu        sync.Mutex
	sessionResponses map[string]chan string

	// Buffer for messages when no one is listening (SessionUUID -> []string)
	unreadMu       sync.Mutex
	unreadMessages map[string][]string

	// Whisper transcriber
	transcriber *whisper.Transcriber

	// Cloud Bridge client (optional)
	bridgeClient *bridge.Client

	// Context cancellation to stop polling loop
	cancelMu sync.Mutex
	cancel   context.CancelFunc
}

// UserResponse represents a message from user
type UserResponse struct {
	ChatID    int64
	Text      string
	SessionID string // Optional, if linked to a session
	Username  string // Telegram username
	MessageID int    // Message ID for referencing
	Timestamp int64  // Unix timestamp
}

// CallbackEvent represents a button click
type CallbackEvent struct {
	ChatID    int64
	UserID    int64
	Data      string
	MessageID int
}

// New creates a new Telegram bot
func New(token string, allowedIDs []int64, stateMgr *state.Manager) (*Bot, error) {
	allowed := make(map[int64]bool)
	for _, id := range allowedIDs {
		allowed[id] = true
	}

	b := &Bot{
		token:            token,
		allowedUserIDs:   allowed,
		state:            stateMgr,
		responseCh:       make(chan *UserResponse, 100),
		callbackCh:       make(chan *CallbackEvent, 100),
		activeSessions:   stateMgr.GetActiveSessions(),
		pending:          make(map[int64]chan string),
		sessionResponses: make(map[string]chan string),
		unreadMessages:   make(map[string][]string),
	}

	opts := []bot.Option{
		bot.WithDefaultHandler(b.handleUpdate),
	}

	if token != "" {
		// Detect conflicts and stop
		opts = append(opts, bot.WithErrorsHandler(func(err error) {
			if err == nil {
				return
			}
			errMsg := err.Error()
			if strings.Contains(errMsg, "conflict") || strings.Contains(errMsg, "Conflict") {
				log.Printf("🛑 [TGBOT] Critical Conflict detected: %v", err)
				log.Println("💡 Tip: This bot token is being used by another process. This instance will now STOP to avoid ping-pong conflicts.")

				b.cancelMu.Lock()
				if b.cancel != nil {
					b.cancel()
				}
				b.cancelMu.Unlock()
			} else {
				log.Printf("⚠️ [TGBOT] Error: %v", err)
			}
		}))

		// Increase timeout for initial getMe and verification
		client := &http.Client{
			Timeout: 10 * time.Second,
		}
		opts = append(opts, bot.WithHTTPClient(10*time.Second, client))

		tgBot, err := bot.New(token, opts...)
		if err != nil {
			return nil, fmt.Errorf("failed to create bot: %w", err)
		}
		b.bot = tgBot
	} else {
		log.Println("⚠️ Telegram token is empty. Bot will operate in bridge-only mode.")
	}

	return b, nil
}

// GetUnreadMessages returns and clears unread messages for a session
func (b *Bot) GetUnreadMessages(sessionID string) []string {
	b.unreadMu.Lock()
	defer b.unreadMu.Unlock()

	msgs := b.unreadMessages[sessionID]
	delete(b.unreadMessages, sessionID)
	return msgs
}

// Start begins long polling
func (b *Bot) Start(ctx context.Context) {
	if b.bot == nil {
		log.Println("⚠️ Telegram bot start skipped (no token). Waiting for Cloud Bridge events...")
		<-ctx.Done()
		return
	}

	// 1. Process-wide check: Wait for any existing bot to finish shutting down
	for {
		processLock.Lock()
		if !isBotActive {
			isBotActive = true
			processLock.Unlock()
			break
		}
		processLock.Unlock()
		log.Println("⏳ Waiting for previous Telegram bot instance in this process to stop...")
		select {
		case <-ctx.Done():
			return
		case <-time.After(1 * time.Second):
			continue
		}
	}

	// Store cancel function for internal/conflict-driven stops
	b.cancelMu.Lock()
	ctx, b.cancel = context.WithCancel(ctx)
	b.cancelMu.Unlock()

	defer func() {
		processLock.Lock()
		isBotActive = false
		processLock.Unlock()
	}()

	// 2. System-wide check (file lock): Cross-process locking per token
	homeDir, _ := os.UserHomeDir()
	tokenHash := sha256.Sum256([]byte(b.token))
	tokenID := hex.EncodeToString(tokenHash[:8])
	lockPath := filepath.Join(homeDir, ".ricochet", fmt.Sprintf("tg-bot-%s.lock", tokenID))
	os.MkdirAll(filepath.Dir(lockPath), 0755)

	fileLock := flock.New(lockPath)
	log.Printf("Starting Telegram bot [%s] (acquiring lock %s)...", b.token[:5]+"..."+b.token[len(b.token)-4:], lockPath)

	// Try to acquire lock once. IDE startup should not spend seconds waiting
	// for another window's Live Mode listener; users can re-enable Live Mode
	// after closing the other instance.
	locked, err := fileLock.TryLock()

	if err != nil {
		log.Printf("⚠️ Error while acquiring Telegram bot lock: %v", err)
	}

	if !locked {
		log.Printf("⚠️ Telegram bot [%s] is already running in another Ricochet instance.", tokenID)
		log.Println("💡 Tip: Only one VS Code window can have Live Mode active at a time for the same bot token.")
		return
	}

	// Store active lock so we can release it exactly when we stop
	activeBotLock = fileLock
	defer func() {
		log.Println("Releasing Telegram bot lock...")
		activeBotLock.Unlock()
		activeBotLock = nil
	}()

	log.Println("Telegram bot started successfully (lock acquired).")

	// Set bot commands
	_, err = b.bot.SetMyCommands(ctx, &bot.SetMyCommandsParams{
		Commands: []models.BotCommand{
			{Command: "start", Description: "🚀 Activate Ricochet"},
			{Command: "new", Description: "🆕 New Session"},
			{Command: "sessions", Description: "📚 List Sessions"},
			{Command: "stop", Description: "🛑 Stop Live Mode"},
		},
	})
	if err != nil {
		log.Printf("⚠️ Failed to set bot commands: %v", err)
	}

	// Start the bot loop
	b.bot.Start(ctx)

	log.Println("Telegram bot loop stopped.")
}

// handleUpdate processes all incoming updates
func (b *Bot) handleUpdate(ctx context.Context, tgBot *bot.Bot, update *models.Update) {
	// Handle callback queries (button clicks)
	if update.CallbackQuery != nil {
		b.handleCallback(ctx, tgBot, update.CallbackQuery)
		return
	}

	// Handle message reactions
	if update.MessageReaction != nil {
		b.handleReaction(ctx, tgBot, update.MessageReaction)
		return
	}

	// Handle regular messages
	if update.Message != nil {
		if update.Message.Voice != nil {
			b.handleVoice(ctx, tgBot, update.Message)
		} else {
			b.handleMessage(ctx, tgBot, update.Message)
		}
	}
}

// handleCallback processes button clicks
func (b *Bot) handleCallback(ctx context.Context, tgBot *bot.Bot, callback *models.CallbackQuery) {
	chatID := callback.Message.Message.Chat.ID
	userID := callback.From.ID

	// Check if chat or user is allowed
	if len(b.allowedUserIDs) > 0 && !b.allowedUserIDs[userID] && !b.allowedUserIDs[chatID] {
		log.Printf("Unauthorized callback from user %d in chat %d", userID, chatID)
		return
	}

	// Answer callback to remove loading state
	tgBot.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{
		CallbackQueryID: callback.ID,
	})

	log.Printf("Callback received: %s from chat %d", callback.Data, chatID)

	// Send confirmation message to user
	var confirmMsg string
	switch callback.Data {
	case "yes":
		confirmMsg = "✅ Approved. Executing..."
	case "no":
		confirmMsg = "❌ Rejected."
	case "always allow":
		confirmMsg = "🛡️ Always Allow enabled. Executing..."
	default:
		confirmMsg = "✓ Received: " + callback.Data
	}
	tgBot.SendMessage(ctx, &bot.SendMessageParams{
		ChatID: chatID,
		Text:   confirmMsg,
	})

	// Check if there's a pending promise for this chat
	b.pendingMu.Lock()
	respCh, ok := b.pending[chatID]
	if ok {
		delete(b.pending, chatID)
		b.pendingMu.Unlock()
		respCh <- callback.Data
		return
	}
	b.pendingMu.Unlock()

	// Send to callback channel
	b.callbackCh <- &CallbackEvent{
		ChatID:    chatID,
		UserID:    userID,
		Data:      callback.Data,
		MessageID: callback.Message.Message.ID,
	}

	// NEW: Enqueue callback in Ether as well
	sessionID := b.GetActiveSession(chatID)
	if sessionID != "" {
		ether.Get().Enqueue(sessionID, ether.Event{
			Type:      ether.EventUserMessage, // Buttons act as messages
			Content:   "Callback: " + callback.Data,
			Timestamp: time.Now(),
			Metadata: map[string]string{
				"callback_data": callback.Data,
				"user_id":       fmt.Sprintf("%d", userID),
			},
		})
	}
}

// SendToSession sends a message to a session listener or buffers it
func (b *Bot) SendToSession(sessionID string, text string) {
	b.sessionMu.Lock()
	ch, ok := b.sessionResponses[sessionID]
	b.sessionMu.Unlock()

	if ok {
		select {
		case ch <- text:
			return
		default:
			// Full, buffer it
		}
	}

	b.unreadMu.Lock()
	b.unreadMessages[sessionID] = append(b.unreadMessages[sessionID], text)
	b.unreadMu.Unlock()
	log.Printf("Message buffered for session %s: %s", sessionID, text)
}

// handleMessage processes incoming messages
func (b *Bot) handleMessage(ctx context.Context, _ *bot.Bot, message *models.Message) {
	chatID := message.Chat.ID
	userID := message.From.ID

	// Check if chat or user is allowed
	if len(b.allowedUserIDs) > 0 && !b.allowedUserIDs[userID] && !b.allowedUserIDs[chatID] {
		log.Printf("Unauthorized access attempt from user %d in chat %d", userID, chatID)
		return
	}

	text := message.Text
	if strings.HasPrefix(text, "/start") {
		b.sendWelcomeMenu(ctx, chatID)
		return
	}

	// Check if there's a pending promise for this chat (e.g. from AskUser)
	b.pendingMu.Lock()
	respCh, ok := b.pending[chatID]
	if ok {
		delete(b.pending, chatID)
		b.pendingMu.Unlock()
		respCh <- text
		return
	}
	b.pendingMu.Unlock()

	// Always send to response channel for Live Mode processing
	b.responseCh <- &UserResponse{
		ChatID:    chatID,
		Text:      text,
		Username:  message.From.Username,
		MessageID: message.ID,
		Timestamp: int64(message.Date),
	}

	// NEW: Enqueue in Ether if session is active
	sessionID := b.GetActiveSession(chatID)
	if sessionID != "" {
		ether.Get().Enqueue(sessionID, ether.Event{
			Type:      ether.EventUserMessage,
			Content:   text,
			Timestamp: time.Unix(int64(message.Date), 0),
			Metadata: map[string]string{
				"message_id": fmt.Sprintf("%d", message.ID),
				"username":   message.From.Username,
			},
		})
	}
}

// handleVoice processes incoming voice messages
func (b *Bot) handleVoice(ctx context.Context, tgBot *bot.Bot, message *models.Message) {
	chatID := message.Chat.ID
	userID := message.From.ID

	// Check if chat or user is allowed
	if len(b.allowedUserIDs) > 0 && !b.allowedUserIDs[userID] && !b.allowedUserIDs[chatID] {
		log.Printf("Unauthorized voice access attempt from user %d in chat %d", userID, chatID)
		return
	}

	if b.transcriber == nil {
		b.SendMessage(ctx, chatID, "⚠️ Voice control not configured (Transcriber missing).")
		return
	}

	b.SendMessage(ctx, chatID, "🎙 _Processing voice message..._")
	b.SendTyping(ctx, chatID)

	// 1. Get file info
	file, err := tgBot.GetFile(ctx, &bot.GetFileParams{
		FileID: message.Voice.FileID,
	})
	if err != nil {
		b.SendMessage(ctx, chatID, fmt.Sprintf("❌ Error getting file: %v", err))
		return
	}

	// 2. Download file
	homeDir, _ := os.UserHomeDir()
	oggPath := filepath.Join(homeDir, ".ricochet", "tmp", message.Voice.FileID+".ogg")

	os.MkdirAll(filepath.Dir(oggPath), 0755)

	if err := b.downloadFile(ctx, file.FilePath, oggPath); err != nil {
		b.SendMessage(ctx, chatID, fmt.Sprintf("❌ Error downloading file: %v", err))
		return
	}
	defer os.Remove(oggPath)

	// 3. Transcribe
	text, err := b.transcriber.Transcribe(oggPath)
	if err != nil {
		b.SendMessage(ctx, chatID, fmt.Sprintf("❌ Transcription error: %v", err))
		return
	}

	if text == "" {
		b.SendMessage(ctx, chatID, "🤔 Could not recognize speech.")
		return
	}

	b.SendMessage(ctx, chatID, fmt.Sprintf("📝 _Text_: %s", text))

	// 4. Route to session
	b.activeMu.Lock()
	sessionID := b.activeSessions[chatID]
	b.activeMu.Unlock()

	if sessionID != "" {
		b.SendToSession(sessionID, "[Voice Message]: "+text)

		// NEW: Enqueue in Ether
		ether.Get().Enqueue(sessionID, ether.Event{
			Type:      ether.EventUserMessage,
			Content:   "[Voice Message]: " + text,
			Timestamp: time.Now(),
		})
	} else {
		b.responseCh <- &UserResponse{
			ChatID:    chatID,
			Text:      "[Voice Message]: " + text,
			SessionID: sessionID,
		}
	}
}

// handleReaction processes emoji reactions to messages
func (b *Bot) handleReaction(_ context.Context, _ *bot.Bot, reaction *models.MessageReactionUpdated) {
	chatID := reaction.Chat.ID
	userID := reaction.User.ID

	// Check access
	if len(b.allowedUserIDs) > 0 && !b.allowedUserIDs[userID] && !b.allowedUserIDs[chatID] {
		return
	}

	sessionID := b.GetActiveSession(chatID)
	if sessionID == "" {
		return
	}

	// For now, we just log that a reaction happened to avoid library-specific compilation issues
	// We can refine this later by inspecting the models.ReactionType properly
	text := fmt.Sprintf("Reaction received by user %d", userID)
	log.Printf("Reaction received in chat %d: %s", chatID, text)

	ether.Get().Enqueue(sessionID, ether.Event{
		Type:      ether.EventReaction,
		Content:   text,
		Timestamp: time.Now(),
		Metadata: map[string]string{
			"user_id": fmt.Sprintf("%d", userID),
			"msg_id":  fmt.Sprintf("%d", reaction.MessageID),
		},
	})
}

// downloadFile downloads a file from Telegram servers
func (b *Bot) downloadFile(_ context.Context, tgFilePath, localPath string) error {
	fileURL := fmt.Sprintf("https://api.telegram.org/file/bot%s/%s", b.token, tgFilePath)

	resp, err := http.Get(fileURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bad status: %s", resp.Status)
	}

	out, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
}

// SetTranscriber sets the whisper transcriber
func (b *Bot) SetTranscriber(t *whisper.Transcriber) {
	b.transcriber = t
}

// SetBridge registers the Cloud Bridge client
func (b *Bot) SetBridge(c *bridge.Client) {
	b.bridgeClient = c
}

// SendMessageAndTrack sends a message and returns its ID for later editing
func (b *Bot) SendMessageAndTrack(ctx context.Context, chatID int64, text string) (int, error) {
	formatted := format.ToTelegramHTML(text)
	msg, err := b.bot.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:    chatID,
		Text:      formatted,
		ParseMode: models.ParseModeHTML,
	})
	if err != nil {
		return 0, err
	}
	return msg.ID, nil
}

// EditMessage edits an existing message by ID
func (b *Bot) EditMessage(ctx context.Context, chatID int64, messageID int, newText string) error {
	_, err := b.bot.EditMessageText(ctx, &bot.EditMessageTextParams{
		ChatID:    chatID,
		MessageID: messageID,
		Text:      format.ToTelegramHTML(newText),
		ParseMode: models.ParseModeHTML,
	})
	return err
}

// SendPhoto sends an image to a chat
func (b *Bot) SendPhoto(ctx context.Context, chatID int64, photoPath string, caption string) error {
	file, err := os.Open(photoPath)
	if err != nil {
		return fmt.Errorf("failed to open photo: %w", err)
	}
	defer file.Close()

	_, err = b.bot.SendPhoto(ctx, &bot.SendPhotoParams{
		ChatID:    chatID,
		Photo:     &models.InputFileUpload{Filename: filepath.Base(photoPath), Data: file},
		Caption:   format.ToTelegramHTML(caption),
		ParseMode: models.ParseModeHTML,
	})
	return err
}

// SendVoice sends a voice message (audio file) to a chat
func (b *Bot) SendVoice(ctx context.Context, chatID int64, audioPath string) error {
	file, err := os.Open(audioPath)
	if err != nil {
		return fmt.Errorf("failed to open audio: %w", err)
	}
	defer file.Close()

	_, err = b.bot.SendVoice(ctx, &bot.SendVoiceParams{
		ChatID: chatID,
		Voice:  &models.InputFileUpload{Filename: filepath.Base(audioPath), Data: file},
	})
	return err
}

// SendCodeBlock sends a nicely formatted code block
func (b *Bot) SendCodeBlock(ctx context.Context, chatID int64, language, code string) error {
	text := fmt.Sprintf("<pre><code class=\"language-%s\">%s</code></pre>", language, format.EscapeHTML(code))
	_, err := b.bot.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:    chatID,
		Text:      text,
		ParseMode: models.ParseModeHTML,
	})
	return err
}

// SetActiveSession sets the active session for a chat
func (b *Bot) SetActiveSession(chatID int64, sessionID string) {
	b.activeMu.Lock()
	b.activeSessions[chatID] = sessionID
	b.activeMu.Unlock()

	if b.state != nil {
		if err := b.state.SetActiveSession(chatID, sessionID); err != nil {
			log.Printf("Failed to save active session state: %v", err)
		}
	}
	log.Printf("Active session for chat %d set to %s", chatID, sessionID)
}

// GetActiveSession returns the active session ID for a chat
func (b *Bot) GetActiveSession(chatID int64) string {
	b.activeMu.Lock()
	defer b.activeMu.Unlock()
	return b.activeSessions[chatID]
}

// RegisterSessionHandler registers a channel for a specific session's response
func (b *Bot) RegisterSessionHandler(sessionID string, ch chan string) {
	b.sessionMu.Lock()
	defer b.sessionMu.Unlock()
	b.sessionResponses[sessionID] = ch
}

// UnregisterSessionHandler removes a session handler
func (b *Bot) UnregisterSessionHandler(sessionID string) {
	b.sessionMu.Lock()
	defer b.sessionMu.Unlock()
	delete(b.sessionResponses, sessionID)
}

// sendWelcomeMenu sends the main menu with inline buttons
func (b *Bot) sendWelcomeMenu(ctx context.Context, chatID int64) {
	keyboard := &models.InlineKeyboardMarkup{
		InlineKeyboard: [][]models.InlineKeyboardButton{
			{
				{Text: "📋 Chat History", CallbackData: CallbackChatHistory},
				{Text: "➕ New Chat", CallbackData: CallbackNewChat},
			},
		},
	}

	_, err := b.bot.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:      chatID,
		Text:        "👋 **Welcome to Ricochet!**\n\nYour IDE is connected. Select an action:",
		ReplyMarkup: keyboard,
	})
	if err != nil {
		log.Printf("Failed to send welcome menu: %v", err)
	}
}

// SessionView represents a session for display
type SessionView struct {
	ID        string
	TotalCost float64
}

// SendSessionList sends a list of sessions
func (b *Bot) SendSessionList(ctx context.Context, chatID int64, sessions []SessionView) error {
	var buttons [][]models.InlineKeyboardButton

	for i := len(sessions) - 1; i >= 0; i-- { // Reverse order (newest first assuming appended)
		s := sessions[i]
		label := fmt.Sprintf("📂 %s", s.ID)
		if s.TotalCost > 0 {
			label += fmt.Sprintf(" ($%.2f)", s.TotalCost)
		}
		buttons = append(buttons, []models.InlineKeyboardButton{
			{Text: label, CallbackData: "session:" + s.ID},
		})
	}

	buttons = append(buttons, []models.InlineKeyboardButton{
		{Text: "➕ Start New Session", CallbackData: CallbackNewChat},
	})

	_, err := b.bot.SendMessage(ctx, &bot.SendMessageParams{
		ChatID:      chatID,
		Text:        "📚 **Select a Session:**",
		ReplyMarkup: &models.InlineKeyboardMarkup{InlineKeyboard: buttons},
		ParseMode:   models.ParseModeMarkdown,
	})
	return err
}

func (b *Bot) SendMessage(ctx context.Context, chatID int64, text string) error {
	if b.bot != nil {
		formatted := format.ToTelegramHTML(text)
		_, err := b.bot.SendMessage(ctx, &bot.SendMessageParams{
			ChatID:    chatID,
			Text:      formatted,
			ParseMode: models.ParseModeHTML,
		})
		return err
	}

	if b.bridgeClient != nil {
		return b.bridgeClient.Send(&proto.BridgeEvent{
			Payload: &proto.BridgeEvent_OutgoingMessage{
				OutgoingMessage: &proto.OutgoingMessage{
					ChatId: chatID,
					Body:   text,
				},
			},
		})
	}

	return fmt.Errorf("no communication channel (no local bot and no bridge)")
}

// SendMessageWithButtons sends a message with inline keyboard
func (b *Bot) SendMessageWithButtons(ctx context.Context, chatID int64, text string, buttons [][]ButtonConfig) error {
	if b.bot != nil {
		formatted := format.ToTelegramHTML(text)
		keyboard := make([][]models.InlineKeyboardButton, len(buttons))
		for i, row := range buttons {
			keyboard[i] = make([]models.InlineKeyboardButton, len(row))
			for j, btn := range row {
				keyboard[i][j] = models.InlineKeyboardButton{
					Text:         btn.Text,
					CallbackData: btn.Data,
				}
			}
		}

		_, err := b.bot.SendMessage(ctx, &bot.SendMessageParams{
			ChatID:    chatID,
			Text:      formatted,
			ParseMode: models.ParseModeHTML,
			ReplyMarkup: &models.InlineKeyboardMarkup{
				InlineKeyboard: keyboard,
			},
		})
		return err
	}

	if b.bridgeClient != nil {
		// Buttons are currently not supported over bridge proto (IncomingMessage only has Body)
		// We fallback to plain text list
		var sb strings.Builder
		sb.WriteString(text + "\n\n")
		for _, row := range buttons {
			for _, btn := range row {
				sb.WriteString(fmt.Sprintf("🔹 %s\n", btn.Text))
			}
		}

		return b.bridgeClient.Send(&proto.BridgeEvent{
			Payload: &proto.BridgeEvent_OutgoingMessage{
				OutgoingMessage: &proto.OutgoingMessage{
					ChatId: chatID,
					Body:   sb.String(),
				},
			},
		})
	}

	return fmt.Errorf("no communication channel")
}

// ButtonConfig represents a button configuration
type ButtonConfig struct {
	Text string
	Data string
}

// AskUser sends a question and waits for response (generic legacy)
func (b *Bot) AskUser(ctx context.Context, chatID int64, question string) (string, error) {
	// Create response channel
	respCh := make(chan string, 1)

	b.pendingMu.Lock()
	b.pending[chatID] = respCh
	b.pendingMu.Unlock()

	// Send question with buttons for easier interaction
	buttons := [][]ButtonConfig{
		{
			{Text: "✅ Yes", Data: "yes"},
			{Text: "❌ No", Data: "no"},
		},
		{
			{Text: "🛡️ Always Allow", Data: "always allow"},
		},
	}

	if err := b.SendMessageWithButtons(ctx, chatID, question, buttons); err != nil {
		b.pendingMu.Lock()
		delete(b.pending, chatID)
		b.pendingMu.Unlock()
		return "", fmt.Errorf("failed to send question: %w", err)
	}

	// Wait for response
	select {
	case <-ctx.Done():
		b.pendingMu.Lock()
		delete(b.pending, chatID)
		b.pendingMu.Unlock()
		return "", ctx.Err()
	case resp := <-respCh:
		return resp, nil
	}
}

// GetResponseChannel returns channel for incoming messages
func (b *Bot) GetResponseChannel() <-chan *UserResponse {
	return b.responseCh
}

// GetCallbackChannel returns channel for button clicks
func (b *Bot) GetCallbackChannel() <-chan *CallbackEvent {
	return b.callbackCh
}

// IsSessionOnline checks if there is a listener for this session
func (b *Bot) IsSessionOnline(sessionID string) bool {
	// 1. Check if there is a live registered handler
	b.sessionMu.Lock()
	_, hasHandler := b.sessionResponses[sessionID]
	b.sessionMu.Unlock()

	if hasHandler {
		return true
	}

	// 2. Check heartbeat in state
	if b.state != nil {
		return b.state.IsSessionActive(sessionID)
	}

	return false
}

// SendTyping sends a typing action to a chat
func (b *Bot) SendTyping(ctx context.Context, chatID int64) {
	b.bot.SendChatAction(ctx, &bot.SendChatActionParams{
		ChatID: chatID,
		Action: models.ChatActionTyping,
	})
}

// SendErrorActions sends an error message with Retry/Fix/Abort buttons
func (b *Bot) SendErrorActions(ctx context.Context, chatID int64, sessionID string, errText string) error {
	text := fmt.Sprintf("❌ **Ошибка выполнения**\n\n`%s`\n\nЧто вы хотите сделать?", errText)

	buttons := [][]ButtonConfig{
		{
			{Text: "🔄 Повторить", Data: "veto:retry:" + sessionID},
			{Text: "✍️ Исправить", Data: "veto:fix:" + sessionID},
		},
		{
			{Text: "🛑 Остановить", Data: "veto:abort:" + sessionID},
		},
	}

	return b.SendMessageWithButtons(ctx, chatID, text, buttons)
}
