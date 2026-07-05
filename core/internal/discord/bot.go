package discord

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/gofrs/flock"
	"github.com/igoryan-dao/ricochet/internal/ether"
	"github.com/igoryan-dao/ricochet/internal/format"
	"github.com/igoryan-dao/ricochet/internal/state"
)

const discordBotAlreadyRunningMessage = "Discord bot is already running in another Ricochet window"
const discordGatewayCloudOwnerMessage = "Discord gateway is configured for Hosted Ricochet"
const discordGatewayDisabledMessage = "Discord gateway is disabled by RICOCHET_DISCORD_GATEWAY_MODE"

// Config controls Discord Live Mode behavior.
type Config struct {
	Token             string
	ApplicationID     string
	GuildID           string
	AllowedUserIDs    []string
	AllowedChannelIDs []string
	RequireMention    bool
	TextMode          bool
}

// Bot wraps Discord bot with message handling
type Bot struct {
	session       *discordgo.Session
	token         string
	applicationID string
	guildID       string // Optional: restrict to specific guild
	state         *state.Manager

	allowedUserIDs    map[string]bool
	allowedChannelIDs map[string]bool
	requireMention    bool
	textMode          bool

	// Channel for receiving user responses
	responseCh chan *UserResponse

	// Channel for component/button callback events
	callbackCh chan *CallbackEvent

	// Active session per channel (channelID -> SessionUUID)
	activeMu       sync.Mutex
	activeSessions map[string]string

	// Pending questions awaiting answers (target key -> response channel)
	pendingMu sync.Mutex
	pending   map[string]chan string

	// Session specific channels (SessionUUID -> response channel)
	sessionMu        sync.Mutex
	sessionResponses map[string]chan string

	// Buffer for messages when no one is listening
	unreadMu       sync.Mutex
	unreadMessages map[string][]string

	// Runtime gateway ownership. The file lock prevents multiple Ricochet
	// windows from handling the same Discord gateway events.
	runtimeMu   sync.Mutex
	lock        *flock.Flock
	running     bool
	lockBusy    bool
	ownerState  string
	statusError string
}

// UserResponse represents a message from user
type UserResponse struct {
	ChannelID string
	GuildID   string
	ThreadID  string
	UserID    string
	Username  string
	Text      string
	SessionID string
	MessageID string
	Timestamp int64
}

// CallbackEvent represents a Discord component interaction.
type CallbackEvent struct {
	ChannelID     string
	GuildID       string
	ThreadID      string
	UserID        string
	Username      string
	Data          string
	MessageID     string
	InteractionID string
}

// New creates a new Discord bot
func New(token string, guildID string, stateMgr *state.Manager) (*Bot, error) {
	return NewWithConfig(Config{Token: token, GuildID: guildID, TextMode: true}, stateMgr)
}

// NewWithConfig creates a new Discord bot from explicit config.
func NewWithConfig(cfg Config, stateMgr *state.Manager) (*Bot, error) {
	session, err := discordgo.New("Bot " + cfg.Token)
	if err != nil {
		return nil, fmt.Errorf("failed to create Discord session: %w", err)
	}
	allowedUsers := make(map[string]bool)
	for _, id := range cfg.AllowedUserIDs {
		id = strings.TrimSpace(id)
		if id != "" {
			allowedUsers[id] = true
		}
	}
	allowedChannels := make(map[string]bool)
	for _, id := range cfg.AllowedChannelIDs {
		id = strings.TrimSpace(id)
		if id != "" {
			allowedChannels[id] = true
		}
	}

	b := &Bot{
		session:           session,
		token:             cfg.Token,
		applicationID:     cfg.ApplicationID,
		guildID:           cfg.GuildID,
		state:             stateMgr,
		allowedUserIDs:    allowedUsers,
		allowedChannelIDs: allowedChannels,
		requireMention:    cfg.RequireMention,
		textMode:          cfg.TextMode,
		responseCh:        make(chan *UserResponse, 100),
		callbackCh:        make(chan *CallbackEvent, 100),
		activeSessions:    make(map[string]string),
		pending:           make(map[string]chan string),
		sessionResponses:  make(map[string]chan string),
		unreadMessages:    make(map[string][]string),
	}

	// Register handlers
	session.AddHandler(b.handleMessage)
	session.AddHandler(b.handleInteraction)
	session.AddHandler(b.handleReady)

	// Set intents
	session.Identify.Intents = discordgo.IntentsGuildMessages | discordgo.IntentsDirectMessages
	if cfg.TextMode {
		session.Identify.Intents |= discordgo.IntentsMessageContent
	}

	// Load active sessions from state
	if stateMgr != nil {
		active := stateMgr.GetDiscordActiveSessions()
		for channelID, sessionID := range active {
			target := state.MessengerTarget{Platform: "discord", ChannelID: channelID}
			b.activeSessions[target.Key()] = sessionID
		}
		for key, binding := range stateMgr.GetSessionBindings() {
			if binding.Target.Platform == "discord" {
				b.activeSessions[key] = binding.SessionID
			}
		}
	}

	return b, nil
}

// Start opens connection to Discord
func (b *Bot) Start() error {
	b.runtimeMu.Lock()
	defer b.runtimeMu.Unlock()

	if b.running {
		return nil
	}

	b.lockBusy = false
	b.ownerState = ""
	b.statusError = ""

	tokenID := discordBotTokenID(b.token)
	mode := discordGatewayMode()
	executable, _ := os.Executable()
	log.Printf("Discord gateway candidate [%s]: pid=%d mode=%s executable=%s", tokenID, os.Getpid(), mode, executable)
	switch mode {
	case "", "local":
	case "cloud":
		b.ownerState = "cloud"
		b.statusError = discordGatewayCloudOwnerMessage
		log.Printf("Discord bot [%s] not started locally: %s.", tokenID, b.statusError)
		return nil
	case "disabled":
		b.ownerState = "disabled"
		b.statusError = discordGatewayDisabledMessage
		log.Printf("Discord bot [%s] not started: %s.", tokenID, b.statusError)
		return nil
	default:
		b.ownerState = "disabled"
		b.statusError = fmt.Sprintf("Discord gateway disabled: unsupported RICOCHET_DISCORD_GATEWAY_MODE=%q", mode)
		log.Printf("Discord bot [%s] not started: %s.", tokenID, b.statusError)
		return nil
	}

	fileLock, lockPath, locked, err := acquireDiscordBotLockInHome(b.token, "")
	if err != nil {
		b.ownerState = "error"
		b.statusError = fmt.Sprintf("Discord bot lock error: %v", err)
		log.Printf("⚠️ Error while acquiring Discord bot lock [%s]: %v", tokenID, err)
		return err
	}
	if !locked {
		b.lockBusy = true
		b.ownerState = "another_window"
		b.statusError = discordBotAlreadyRunningMessage
		log.Printf("⚠️ Discord bot [%s] is already running in another Ricochet instance.", tokenID)
		log.Println("💡 Tip: Only one Ricochet window can have Live Mode active at a time for the same Discord bot token.")
		return nil
	}
	b.lock = fileLock

	log.Printf("Starting Discord bot [%s] (lock acquired %s)...", tokenID, lockPath)
	if err := b.session.Open(); err != nil {
		b.ownerState = "error"
		b.statusError = fmt.Sprintf("Discord bot start error: %v", err)
		b.releaseLockLocked()
		return err
	}
	b.running = true
	b.ownerState = "this_window"
	b.statusError = ""
	log.Println("Discord bot started successfully (lock acquired).")
	return nil
}

// Stop closes connection
func (b *Bot) Stop() error {
	b.runtimeMu.Lock()
	defer b.runtimeMu.Unlock()

	var closeErr error
	if b.running {
		log.Println("Stopping Discord bot...")
		closeErr = b.session.Close()
		b.running = false
	}
	if unlockErr := b.releaseLockLocked(); closeErr == nil && unlockErr != nil {
		closeErr = unlockErr
	}
	b.lockBusy = false
	b.ownerState = ""
	if closeErr == nil {
		b.statusError = ""
	}
	return closeErr
}

func (b *Bot) releaseLockLocked() error {
	if b.lock == nil {
		return nil
	}
	log.Println("Releasing Discord bot lock...")
	err := b.lock.Unlock()
	b.lock = nil
	return err
}

// IsRunning reports whether this process owns the Discord gateway connection.
func (b *Bot) IsRunning() bool {
	b.runtimeMu.Lock()
	defer b.runtimeMu.Unlock()
	return b.running
}

// StatusError returns the current Discord gateway status explanation, if any.
func (b *Bot) StatusError() string {
	b.runtimeMu.Lock()
	defer b.runtimeMu.Unlock()
	return b.statusError
}

// IsLockBusy reports whether another Ricochet process owns this Discord token.
func (b *Bot) IsLockBusy() bool {
	b.runtimeMu.Lock()
	defer b.runtimeMu.Unlock()
	return b.lockBusy
}

// GatewayOwner reports which Ricochet owner, if any, controls this Discord gateway.
func (b *Bot) GatewayOwner() string {
	b.runtimeMu.Lock()
	defer b.runtimeMu.Unlock()
	return b.ownerState
}

func discordBotTokenID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:8])
}

func discordGatewayMode() string {
	return strings.ToLower(strings.TrimSpace(os.Getenv("RICOCHET_DISCORD_GATEWAY_MODE")))
}

func discordBotLockPath(homeDir, token string) string {
	return filepath.Join(homeDir, ".ricochet", fmt.Sprintf("discord-bot-%s.lock", discordBotTokenID(token)))
}

func acquireDiscordBotLockInHome(token, homeDir string) (*flock.Flock, string, bool, error) {
	if strings.TrimSpace(token) == "" {
		return nil, "", true, nil
	}
	if homeDir == "" {
		var err error
		homeDir, err = os.UserHomeDir()
		if err != nil {
			return nil, "", false, err
		}
	}
	lockPath := discordBotLockPath(homeDir, token)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0755); err != nil {
		return nil, lockPath, false, err
	}
	fileLock := flock.New(lockPath)
	locked, err := fileLock.TryLock()
	return fileLock, lockPath, locked, err
}

// handleReady logs when bot is connected
func (b *Bot) handleReady(_ *discordgo.Session, r *discordgo.Ready) {
	log.Printf("Discord bot connected as %s#%s", r.User.Username, r.User.Discriminator)
	if b.applicationID == "" {
		b.applicationID = r.User.ID
	}
	if err := b.registerCommands(); err != nil {
		log.Printf("Failed to register Discord commands: %v", err)
	}
}

// handleMessage processes incoming messages
func (b *Bot) handleMessage(s *discordgo.Session, m *discordgo.MessageCreate) {
	botUserID := discordSessionUserID(s)
	// Ignore bot's own messages
	if m.Author == nil || (botUserID != "" && m.Author.ID == botUserID) {
		return
	}

	// Ignore messages from other guilds if restricted
	if b.guildID != "" && m.GuildID != b.guildID {
		return
	}
	target := targetFromMessage(s, m)
	if !b.isAllowed(m.Author.ID, target.ChannelID, target.ThreadID, m.ChannelID) {
		return
	}

	text := m.Content
	if strings.TrimSpace(text) == "" || !b.textMode {
		return
	}
	sessionID := b.GetActiveSessionForTarget(target)
	boundThread := target.ThreadID != "" && sessionID != ""
	if m.GuildID != "" && b.requireMention && !boundThread {
		mentioned := false
		for _, mention := range m.Mentions {
			if mention != nil && mention.ID == botUserID {
				mentioned = true
				break
			}
		}
		if !mentioned {
			return
		}
		text = stripBotMention(text, botUserID)
		if strings.TrimSpace(text) == "" {
			return
		}
	}

	// Handle commands
	if strings.HasPrefix(text, "/ricochet") || strings.HasPrefix(text, "!ricochet") {
		b.handleCommand(s, m, text)
		return
	}

	// Route to active session
	if sessionID != "" {
		b.responseCh <- &UserResponse{
			ChannelID: target.ChannelID,
			GuildID:   m.GuildID,
			ThreadID:  target.ThreadID,
			UserID:    m.Author.ID,
			Username:  discordUsername(m.Author),
			Text:      text,
			SessionID: sessionID,
			MessageID: m.ID,
			Timestamp: snowflakeTimestamp(m.ID),
		}
		return
	}

	// Buffer or send to general channel
	b.responseCh <- &UserResponse{
		ChannelID: target.ChannelID,
		GuildID:   m.GuildID,
		ThreadID:  target.ThreadID,
		UserID:    m.Author.ID,
		Username:  discordUsername(m.Author),
		Text:      text,
		MessageID: m.ID,
		Timestamp: snowflakeTimestamp(m.ID),
	}
}

// handleCommand processes bot commands
func (b *Bot) handleCommand(s *discordgo.Session, m *discordgo.MessageCreate, text string) {
	parts := strings.Fields(text)
	if len(parts) < 2 {
		b.SendMessage(context.Background(), m.ChannelID, "📡 **Ricochet Discord** — AI Agent Bridge\n\nCommands:\n• `/ricochet status` — Show active session\n• `/ricochet activate <session>` — Activate a session")
		return
	}

	command := "/" + parts[1]
	if parts[1] == "activate" || parts[1] == "link" {
		if len(parts) < 3 {
			b.SendMessage(context.Background(), m.ChannelID, "Usage: `/ricochet activate <session_id>`")
			return
		}
		command = "/switch " + parts[2]
	} else if len(parts) > 2 {
		command += " " + strings.Join(parts[2:], " ")
	}
	target := targetFromDiscordChannel(s, m.GuildID, m.ChannelID, m.Author.ID)
	b.responseCh <- &UserResponse{
		ChannelID: target.ChannelID,
		GuildID:   m.GuildID,
		ThreadID:  target.ThreadID,
		UserID:    m.Author.ID,
		Username:  discordUsername(m.Author),
		Text:      command,
		MessageID: m.ID,
		Timestamp: snowflakeTimestamp(m.ID),
	}
}

func (b *Bot) registerCommands() error {
	if b.applicationID == "" {
		return nil
	}
	command := &discordgo.ApplicationCommand{
		Name:        "ricochet",
		Description: "Control Ricochet Ether",
		Options: []*discordgo.ApplicationCommandOption{
			{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "status", Description: "Show active Ricochet session"},
			{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "sessions", Description: "List recent Ricochet sessions"},
			{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "queue", Description: "Show queued commands"},
			{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "new", Description: "Start a new Ricochet session"},
			{Type: discordgo.ApplicationCommandOptionSubCommand, Name: "cancel", Description: "Cancel the active Ricochet run"},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "link",
				Description: "Link this Discord target to a Ricochet session",
				Options: []*discordgo.ApplicationCommandOption{
					{Type: discordgo.ApplicationCommandOptionString, Name: "session", Description: "Ricochet session ID", Required: true},
				},
			},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "switch",
				Description: "Switch this Discord target to a Ricochet session",
				Options: []*discordgo.ApplicationCommandOption{
					{Type: discordgo.ApplicationCommandOptionString, Name: "session", Description: "Ricochet session ID", Required: true},
				},
			},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "run",
				Description: "Send a command to the active Ricochet session",
				Options: []*discordgo.ApplicationCommandOption{
					{Type: discordgo.ApplicationCommandOptionString, Name: "message", Description: "Instruction for Ricochet", Required: true},
				},
			},
			{
				Type:        discordgo.ApplicationCommandOptionSubCommand,
				Name:        "steer",
				Description: "Steer the active queued Ricochet run",
				Options: []*discordgo.ApplicationCommandOption{
					{Type: discordgo.ApplicationCommandOptionString, Name: "message", Description: "Steering instruction", Required: true},
				},
			},
		},
	}
	_, err := b.session.ApplicationCommandCreate(b.applicationID, b.guildID, command)
	return err
}

func (b *Bot) handleInteraction(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if i == nil || i.Member != nil && i.Member.User == nil {
		return
	}
	botUserID := discordSessionUserID(s)
	user := i.User
	if user == nil && i.Member != nil {
		user = i.Member.User
	}
	if user == nil || (botUserID != "" && user.ID == botUserID) {
		return
	}
	if b.guildID != "" && i.GuildID != "" && i.GuildID != b.guildID {
		return
	}
	target := targetFromDiscordChannel(s, i.GuildID, i.ChannelID, user.ID)
	if !b.isAllowed(user.ID, target.ChannelID, target.ThreadID, i.ChannelID) {
		_ = interactionRespond(s, i, "This Discord user or channel is not allowed to control Ricochet.", true)
		return
	}

	switch i.Type {
	case discordgo.InteractionApplicationCommand:
		data := i.ApplicationCommandData()
		if data.Name != "ricochet" || len(data.Options) == 0 {
			return
		}
		text := discordCommandText(data.Options[0])
		if text == "" {
			return
		}
		_ = interactionRespond(s, i, "Ricochet received this command.", true)
		b.responseCh <- &UserResponse{
			ChannelID: target.ChannelID,
			GuildID:   i.GuildID,
			ThreadID:  target.ThreadID,
			UserID:    user.ID,
			Username:  discordUsername(user),
			Text:      text,
			MessageID: i.ID,
			Timestamp: time.Now().Unix(),
		}
	case discordgo.InteractionMessageComponent:
		data := i.MessageComponentData()
		_ = s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{Type: discordgo.InteractionResponseDeferredMessageUpdate})
		targetKey := target.Key()
		b.pendingMu.Lock()
		respCh, ok := b.pending[targetKey]
		if ok {
			delete(b.pending, targetKey)
		}
		b.pendingMu.Unlock()
		if ok {
			respCh <- data.CustomID
			return
		}
		event := &CallbackEvent{
			ChannelID:     target.ChannelID,
			GuildID:       i.GuildID,
			ThreadID:      target.ThreadID,
			UserID:        user.ID,
			Username:      discordUsername(user),
			Data:          data.CustomID,
			InteractionID: i.ID,
		}
		if i.Message != nil {
			event.MessageID = i.Message.ID
			if sessionID := b.GetActiveSessionForTarget(target); sessionID != "" {
				ether.Get().Enqueue(sessionID, ether.Event{
					Type:      ether.EventReaction,
					Content:   "Callback: " + data.CustomID,
					Timestamp: time.Now(),
					Metadata: map[string]string{
						"platform":       "discord",
						"guild_id":       i.GuildID,
						"channel_id":     target.ChannelID,
						"thread_id":      target.ThreadID,
						"user_id":        user.ID,
						"username":       discordUsername(user),
						"message_id":     i.Message.ID,
						"callback_data":  data.CustomID,
						"interaction_id": i.ID,
					},
				})
			}
		}
		b.callbackCh <- event
	}
}

func discordCommandText(option *discordgo.ApplicationCommandInteractionDataOption) string {
	if option == nil {
		return ""
	}
	switch option.Name {
	case "link", "switch":
		return "/switch " + optionStringValue(option, "session")
	case "run":
		return optionStringValue(option, "message")
	case "steer":
		return "/steer " + optionStringValue(option, "message")
	case "status", "sessions", "queue", "new", "cancel":
		return "/" + option.Name
	default:
		return ""
	}
}

func optionStringValue(option *discordgo.ApplicationCommandInteractionDataOption, name string) string {
	for _, child := range option.Options {
		if child.Name == name {
			return child.StringValue()
		}
	}
	return ""
}

// SendMessage sends a message to a channel
func (b *Bot) SendMessage(ctx context.Context, channelID string, text string) error {
	formatted := format.ToDiscordMarkdown(text)
	_, err := b.session.ChannelMessageSend(channelID, formatted)
	return err
}

// SendMessageAndTrack sends a message and returns its Discord message ID.
func (b *Bot) SendMessageAndTrack(ctx context.Context, channelID string, text string) (string, error) {
	formatted := format.ToDiscordMarkdown(text)
	msg, err := b.session.ChannelMessageSend(channelID, formatted)
	if err != nil {
		return "", err
	}
	return msg.ID, nil
}

// EditMessage edits an existing Discord message.
func (b *Bot) EditMessage(ctx context.Context, channelID, messageID, newText string) error {
	formatted := format.ToDiscordMarkdown(newText)
	_, err := b.session.ChannelMessageEdit(channelID, messageID, formatted)
	return err
}

// ButtonConfig represents a Discord button configuration.
type ButtonConfig struct {
	Text string
	Data string
	URL  string
}

// SendMessageWithButtons sends a message with interactive Discord buttons.
func (b *Bot) SendMessageWithButtons(ctx context.Context, channelID string, text string, buttons [][]ButtonConfig) error {
	formatted := format.ToDiscordMarkdown(text)
	msg := &discordgo.MessageSend{
		Content:    formatted,
		Components: discordButtonComponents(buttons),
	}
	_, err := b.session.ChannelMessageSendComplex(channelID, msg)
	return err
}

// SendPhoto sends an image to a Discord channel
func (b *Bot) SendPhoto(ctx context.Context, channelID string, photoPath string, caption string) error {
	file, err := os.Open(photoPath)
	if err != nil {
		return fmt.Errorf("failed to open photo: %w", err)
	}
	defer file.Close()

	_, err = b.session.ChannelMessageSendComplex(channelID, &discordgo.MessageSend{
		Content: caption,
		Files: []*discordgo.File{
			{
				Name:        filepath.Base(photoPath),
				ContentType: "image/png", // Discord usually detects it, but better specified
				Reader:      file,
			},
		},
	})
	return err
}

// SendVoice sends an audio file to a Discord channel
func (b *Bot) SendVoice(ctx context.Context, channelID string, audioPath string) error {
	file, err := os.Open(audioPath)
	if err != nil {
		return fmt.Errorf("failed to open audio: %w", err)
	}
	defer file.Close()

	_, err = b.session.ChannelMessageSendComplex(channelID, &discordgo.MessageSend{
		Files: []*discordgo.File{
			{
				Name:        filepath.Base(audioPath),
				ContentType: "audio/wav",
				Reader:      file,
			},
		},
	})
	return err
}

// SendCodeBlock sends a formatted code block to Discord
func (b *Bot) SendCodeBlock(ctx context.Context, channelID string, language, code string) error {
	formatted := fmt.Sprintf("```%s\n%s\n```", language, code)
	_, err := b.session.ChannelMessageSend(channelID, formatted)
	return err
}

// SendToSession routes message to a specific session
func (b *Bot) SendToSession(sessionID, text string) {
	b.sessionMu.Lock()
	ch, ok := b.sessionResponses[sessionID]
	b.sessionMu.Unlock()

	if ok {
		select {
		case ch <- text:
			log.Printf("Message sent to session %s", sessionID)
		default:
			log.Printf("Session %s channel full, buffering", sessionID)
			b.bufferMessage(sessionID, text)
		}
		return
	}

	b.bufferMessage(sessionID, text)
}

func (b *Bot) bufferMessage(sessionID, text string) {
	b.unreadMu.Lock()
	b.unreadMessages[sessionID] = append(b.unreadMessages[sessionID], text)
	b.unreadMu.Unlock()
	log.Printf("Message buffered for session %s", sessionID)
}

// SetActiveSession sets the active session for a channel
func (b *Bot) SetActiveSession(channelID, sessionID string) {
	b.SetActiveSessionForTarget(state.MessengerTarget{Platform: "discord", ChannelID: channelID}, sessionID)
}

// SetActiveSessionForTarget sets the active session for a Discord endpoint.
func (b *Bot) SetActiveSessionForTarget(target state.MessengerTarget, sessionID string) {
	if target.Platform == "" {
		target.Platform = "discord"
	}
	key := target.Key()
	if key == "" || sessionID == "" {
		return
	}
	b.activeMu.Lock()
	b.activeSessions[key] = sessionID
	b.activeMu.Unlock()
	log.Printf("Active session for Discord target %s set to %s", key, sessionID)

	if b.state != nil {
		if err := b.state.SetSessionBinding(target, sessionID, "discord"); err != nil {
			log.Printf("Failed to save Discord session state: %v", err)
		}
	}
}

func (b *Bot) CreateSessionThread(ctx context.Context, target state.MessengerTarget, sessionID string) (state.MessengerTarget, string, bool) {
	_ = ctx
	if target.GuildID == "" || target.ChannelID == "" || target.ThreadID != "" || sessionID == "" {
		return target, discordSendChannelID(target), false
	}
	if ch, err := b.session.State.Channel(target.ChannelID); err == nil && ch != nil && ch.IsThread() {
		return target, discordSendChannelID(target), false
	}
	name := "ricochet-" + shortDiscordSessionID(sessionID)
	thread, err := b.session.ThreadStart(target.ChannelID, name, discordgo.ChannelTypeGuildPublicThread, 1440)
	if err != nil || thread == nil || thread.ID == "" {
		return target, discordSendChannelID(target), false
	}
	threadTarget := target
	threadTarget.ThreadID = thread.ID
	b.SetActiveSessionForTarget(threadTarget, sessionID)
	return threadTarget, thread.ID, true
}

// GetActiveSession returns the active session for a channel
func (b *Bot) GetActiveSession(channelID string) string {
	return b.GetActiveSessionForTarget(state.MessengerTarget{Platform: "discord", ChannelID: channelID})
}

// GetActiveSessionForTarget returns the active session for a Discord endpoint.
func (b *Bot) GetActiveSessionForTarget(target state.MessengerTarget) string {
	if target.Platform == "" {
		target.Platform = "discord"
	}
	key := target.Key()
	b.activeMu.Lock()
	defer b.activeMu.Unlock()
	if sessionID := b.activeSessions[key]; sessionID != "" {
		return sessionID
	}
	if target.ThreadID != "" {
		legacyGuildThreadKey := state.MessengerTarget{
			Platform:  "discord",
			GuildID:   target.GuildID,
			ChannelID: target.ThreadID,
			ThreadID:  target.ThreadID,
		}.Key()
		if sessionID := b.activeSessions[legacyGuildThreadKey]; sessionID != "" {
			return sessionID
		}
		legacyThreadKey := state.MessengerTarget{Platform: "discord", ChannelID: target.ThreadID}.Key()
		if sessionID := b.activeSessions[legacyThreadKey]; sessionID != "" {
			return sessionID
		}
	}
	if target.ChannelID != "" {
		if target.GuildID != "" {
			parentGuildKey := state.MessengerTarget{
				Platform:  "discord",
				GuildID:   target.GuildID,
				ChannelID: target.ChannelID,
			}.Key()
			if sessionID := b.activeSessions[parentGuildKey]; sessionID != "" {
				return sessionID
			}
		}
		return b.activeSessions[state.MessengerTarget{Platform: "discord", ChannelID: target.ChannelID}.Key()]
	}
	return ""
}

// RegisterSessionHandler registers a channel for session responses
func (b *Bot) RegisterSessionHandler(sessionID string, ch chan string) {
	b.sessionMu.Lock()
	b.sessionResponses[sessionID] = ch
	b.sessionMu.Unlock()
}

// UnregisterSessionHandler removes session handler
func (b *Bot) UnregisterSessionHandler(sessionID string) {
	b.sessionMu.Lock()
	delete(b.sessionResponses, sessionID)
	b.sessionMu.Unlock()
}

// GetUnreadMessages returns and clears buffered messages
func (b *Bot) GetUnreadMessages(sessionID string) []string {
	b.unreadMu.Lock()
	defer b.unreadMu.Unlock()
	msgs := b.unreadMessages[sessionID]
	delete(b.unreadMessages, sessionID)
	return msgs
}

// GetResponseChannel returns the general response channel
func (b *Bot) GetResponseChannel() <-chan *UserResponse {
	return b.responseCh
}

// GetCallbackChannel returns the Discord component callback channel.
func (b *Bot) GetCallbackChannel() <-chan *CallbackEvent {
	return b.callbackCh
}

// AskUser asks a question in Discord and waits for a response or button click.
func (b *Bot) AskUser(ctx context.Context, target state.MessengerTarget, question string) (string, error) {
	target.Platform = "discord"
	key := target.Key()
	if key == "" || target.ChannelID == "" {
		return "", fmt.Errorf("discord channel_id not set")
	}
	sendChannelID := discordSendChannelID(target)
	respCh := make(chan string, 1)
	b.pendingMu.Lock()
	b.pending[key] = respCh
	b.pendingMu.Unlock()

	buttons := [][]ButtonConfig{
		{
			{Text: "Approve", Data: "yes"},
			{Text: "Reject", Data: "no"},
		},
		{
			{Text: "Always allow", Data: "always allow"},
		},
	}
	if err := b.SendMessageWithButtons(ctx, sendChannelID, question, buttons); err != nil {
		b.pendingMu.Lock()
		delete(b.pending, key)
		b.pendingMu.Unlock()
		return "", fmt.Errorf("failed to send question: %w", err)
	}

	select {
	case <-ctx.Done():
		b.pendingMu.Lock()
		delete(b.pending, key)
		b.pendingMu.Unlock()
		return "", ctx.Err()
	case resp := <-respCh:
		return resp, nil
	}
}

// SendTyping shows typing indicator
func (b *Bot) SendTyping(ctx context.Context, channelID string) {
	b.session.ChannelTyping(channelID)
}

// SendSessionList sends a session picker as Discord buttons.
func (b *Bot) SendSessionList(ctx context.Context, channelID string, sessions []SessionView) error {
	var rows [][]ButtonConfig
	for i := len(sessions) - 1; i >= 0; i-- {
		s := sessions[i]
		label := s.ID
		if s.TotalCost > 0 {
			label += fmt.Sprintf(" ($%.2f)", s.TotalCost)
		}
		rows = append(rows, []ButtonConfig{{Text: label, Data: "session:" + s.ID}})
		if len(rows) >= 5 {
			break
		}
	}
	rows = append(rows, []ButtonConfig{{Text: "Start new session", Data: "new_chat"}})
	return b.SendMessageWithButtons(ctx, channelID, "**Select a Ricochet session:**", rows)
}

// SendErrorActions sends a Discord error action card.
func (b *Bot) SendErrorActions(ctx context.Context, channelID string, sessionID string, errText string) error {
	text := fmt.Sprintf("**Execution error**\n\n`%s`\n\nWhat should Ricochet do?", errText)
	buttons := [][]ButtonConfig{
		{
			{Text: "Retry", Data: "veto:retry:" + sessionID},
			{Text: "Fix", Data: "veto:fix:" + sessionID},
		},
		{
			{Text: "Abort", Data: "veto:abort:" + sessionID},
		},
	}
	return b.SendMessageWithButtons(ctx, channelID, text, buttons)
}

// SessionView represents a Ricochet session for display.
type SessionView struct {
	ID        string
	TotalCost float64
}

func (b *Bot) isAllowed(userID string, channelIDs ...string) bool {
	if len(b.allowedUserIDs) > 0 && !b.allowedUserIDs[userID] {
		return false
	}
	if len(b.allowedChannelIDs) > 0 {
		for _, channelID := range channelIDs {
			if channelID != "" && b.allowedChannelIDs[channelID] {
				return true
			}
		}
		return false
	}
	return true
}

func targetFromMessage(s *discordgo.Session, m *discordgo.MessageCreate) state.MessengerTarget {
	userID := ""
	if m != nil && m.Author != nil {
		userID = m.Author.ID
	}
	if m == nil {
		return state.MessengerTarget{Platform: "discord", UserID: userID}
	}
	return targetFromDiscordChannel(s, m.GuildID, m.ChannelID, userID)
}

func targetFromDiscordChannel(s *discordgo.Session, guildID, channelID, userID string) state.MessengerTarget {
	target := state.MessengerTarget{
		Platform:  "discord",
		GuildID:   guildID,
		ChannelID: channelID,
		UserID:    userID,
	}
	if guildID == "" || channelID == "" || s == nil {
		return target
	}
	var ch *discordgo.Channel
	if s.State != nil {
		if stateChannel, err := s.State.Channel(channelID); err == nil {
			ch = stateChannel
		}
	}
	if ch == nil {
		if fetchedChannel, err := s.Channel(channelID); err == nil {
			ch = fetchedChannel
		}
	}
	if ch == nil || !ch.IsThread() {
		return target
	}
	target.ThreadID = channelID
	if ch.ParentID != "" {
		target.ChannelID = ch.ParentID
	}
	return target
}

func stripBotMention(text, botID string) string {
	replacer := strings.NewReplacer("<@"+botID+">", "", "<@!"+botID+">", "")
	return strings.TrimSpace(replacer.Replace(text))
}

func discordUsername(user *discordgo.User) string {
	if user == nil {
		return ""
	}
	if user.GlobalName != "" {
		return user.GlobalName
	}
	if user.Username != "" {
		return user.Username
	}
	return user.ID
}

func discordSessionUserID(s *discordgo.Session) string {
	if s == nil || s.State == nil || s.State.User == nil {
		return ""
	}
	return s.State.User.ID
}

func shortDiscordSessionID(sessionID string) string {
	sessionID = strings.TrimSpace(sessionID)
	if len(sessionID) <= 18 {
		return sessionID
	}
	return sessionID[:18]
}

func discordSendChannelID(target state.MessengerTarget) string {
	if target.ThreadID != "" {
		return target.ThreadID
	}
	return target.ChannelID
}

func discordButtonComponents(rows [][]ButtonConfig) []discordgo.MessageComponent {
	components := make([]discordgo.MessageComponent, 0, len(rows))
	for _, row := range rows {
		actionRow := discordgo.ActionsRow{}
		for _, btn := range row {
			if btn.Text == "" {
				continue
			}
			button := discordgo.Button{
				Label: btn.Text,
				Style: discordgo.PrimaryButton,
			}
			if btn.URL != "" {
				button.Style = discordgo.LinkButton
				button.URL = btn.URL
			} else {
				button.CustomID = btn.Data
			}
			actionRow.Components = append(actionRow.Components, button)
		}
		if len(actionRow.Components) > 0 {
			components = append(components, actionRow)
		}
	}
	return components
}

func interactionRespond(s *discordgo.Session, i *discordgo.InteractionCreate, content string, ephemeral bool) error {
	flags := discordgo.MessageFlags(0)
	if ephemeral {
		flags = discordgo.MessageFlagsEphemeral
	}
	return s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: content,
			Flags:   flags,
		},
	})
}

func snowflakeTimestamp(id string) int64 {
	if id == "" {
		return time.Now().Unix()
	}
	created, err := discordgo.SnowflakeTimestamp(id)
	if err != nil {
		return time.Now().Unix()
	}
	return created.Unix()
}
