package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/gorilla/websocket"
	"github.com/igoryan-dao/ricochet/internal/agent"
	bridgepkg "github.com/igoryan-dao/ricochet/internal/bridge"
	bridgeproto "github.com/igoryan-dao/ricochet/internal/bridge/proto"
	"github.com/igoryan-dao/ricochet/internal/codegraph"
	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/format"
	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/livemode"
	"github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/modes"
	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/prompts"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/remote"
	"github.com/igoryan-dao/ricochet/internal/server"
	"github.com/igoryan-dao/ricochet/internal/tui"
	"github.com/igoryan-dao/ricochet/internal/version"
	"github.com/igoryan-dao/ricochet/internal/workflow"
	"github.com/muesli/termenv"
)

var (
	// State is now managed by server.Handler, but we keep initial config here
	// to pass to the handler constructor.
	cfg            *agent.Config
	liveModeConfig *livemode.Config
	settingsStore  *config.Store
	outputMu       sync.Mutex

	// Server Hub
	wsHub *WsHub

	remoteSessionBindings sync.Map
)

func debugLogsEnabled() bool {
	switch strings.ToLower(os.Getenv("RICOCHET_DEBUG")) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func logLiveModeInitError(err error) {
	if debugLogsEnabled() {
		log.Printf("Warning: Failed to create LiveMode controller: %v", err)
	}
}

// StdioWriter implements server.ResponseWriter for Stdio
type StdioWriter struct{}

func (w *StdioWriter) Send(msg interface{}) error {
	sendMessage(msg)
	return nil
}

// WsWriter implements server.ResponseWriter for WebSocket (broadcasts to specific conn or all)
type WsWriter struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (w *WsWriter) Send(msg interface{}) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteJSON(msg)
}

// BroadcastWriter implements server.ResponseWriter for broadcasting to all clients
type BroadcastWriter struct {
	hub *WsHub
}

func (w *BroadcastWriter) Send(msg interface{}) error {
	w.hub.Broadcast(msg)
	return nil
}

type DiscardWriter struct{}

func (w *DiscardWriter) Send(msg interface{}) error { return nil }

type BridgeWriter struct {
	client    *bridgepkg.Client
	eventID   string
	endpoint  BridgeEndpoint
	sessionID string
	lastText  string
	sentFinal bool
	mu        sync.Mutex
}

func (w *BridgeWriter) Send(msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	var rpc protocol.RPCMessage
	if err := json.Unmarshal(data, &rpc); err != nil {
		return err
	}

	switch rpc.Type {
	case "chat_update":
		var payload struct {
			Message *agent.ChatMessage `json:"message"`
		}
		if err := json.Unmarshal(rpc.Payload, &payload); err != nil || payload.Message == nil {
			return nil
		}
		if payload.Message.Role != "assistant" || strings.TrimSpace(payload.Message.Content) == "" {
			return nil
		}
		w.mu.Lock()
		w.lastText = payload.Message.Content
		shouldSend := !payload.Message.IsStreaming && !w.sentFinal
		if shouldSend {
			w.sentFinal = true
		}
		w.mu.Unlock()
		if shouldSend {
			return w.sendText(payload.Message.Content)
		}
	case "message_queued":
		_ = w.sendText("📥 Command queued for the current Ricochet run.")
		_ = w.client.AckEvent(w.eventID, "completed", "")
	case "response":
		if rpc.Error != "" {
			_ = w.client.AckEvent(w.eventID, "failed", rpc.Error)
			return w.sendText("❌ " + rpc.Error)
		}
		w.mu.Lock()
		text := w.lastText
		alreadySent := w.sentFinal
		if text != "" && !alreadySent {
			w.sentFinal = true
		}
		w.mu.Unlock()
		if text != "" && !alreadySent {
			_ = w.sendText(text)
		}
		_ = w.client.AckEvent(w.eventID, "completed", "")
	}
	return nil
}

func (w *BridgeWriter) sendText(text string) error {
	if strings.TrimSpace(text) == "" || w.endpoint.IsZero() {
		return nil
	}
	platform := firstNonEmptyString(w.endpoint.Platform, "telegram")
	outText := text
	parseMode := ""
	if platform == "telegram" {
		outText = format.ToTelegramHTML(text)
		parseMode = "HTML"
	}
	return w.client.Send(&bridgeproto.BridgeEvent{
		SessionId: w.sessionID,
		Payload: &bridgeproto.BridgeEvent_OutboundMessage{
			OutboundMessage: &bridgeproto.OutboundMessage{
				Envelope: &bridgeproto.Envelope{
					SessionId:     w.sessionID,
					Platform:      platform,
					ChatId:        w.endpoint.ChatID,
					ChannelId:     w.endpoint.ChannelID,
					ThreadId:      w.endpoint.ThreadID,
					UserId:        w.endpoint.UserID,
					CorrelationId: w.eventID,
				},
				Text:      outText,
				ParseMode: parseMode,
			},
		},
	})
}

type BridgeEndpoint struct {
	Platform  string
	ChatID    int64
	ChannelID string
	ThreadID  string
	UserID    string
}

func (e BridgeEndpoint) Key() string {
	switch e.Platform {
	case "discord":
		if e.ThreadID != "" {
			return "discord:channel:" + e.ChannelID + ":thread:" + e.ThreadID
		}
		if e.ChannelID != "" {
			return "discord:channel:" + e.ChannelID
		}
		if e.UserID != "" {
			return "discord:dm:" + e.UserID
		}
	case "telegram", "":
		if e.ChatID != 0 {
			return fmt.Sprintf("telegram:chat:%d", e.ChatID)
		}
	}
	return ""
}

func (e BridgeEndpoint) IsZero() bool {
	return e.Key() == ""
}

type WsHub struct {
	clients    map[*websocket.Conn]bool
	clientsMu  sync.RWMutex
	register   chan *websocket.Conn
	unregister chan *websocket.Conn
}

func NewWsHub() *WsHub {
	return &WsHub{
		clients:    make(map[*websocket.Conn]bool),
		register:   make(chan *websocket.Conn),
		unregister: make(chan *websocket.Conn),
	}
}

func (h *WsHub) Run(ctx context.Context) {
	for {
		select {
		case client := <-h.register:
			h.clientsMu.Lock()
			h.clients[client] = true
			h.clientsMu.Unlock()
			log.Printf("Client connected. Total: %d", len(h.clients))
		case client := <-h.unregister:
			h.clientsMu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				client.Close()
			}
			h.clientsMu.Unlock()
			log.Printf("Client disconnected. Total: %d", len(h.clients))
		case <-ctx.Done():
			return
		}
	}
}

func (h *WsHub) Broadcast(msg interface{}) {
	h.clientsMu.RLock()
	defer h.clientsMu.RUnlock()

	for client := range h.clients {
		err := client.WriteJSON(msg)
		if err != nil {
			log.Printf("Error broadcasting to client: %v", err)
			// Don't unregister here to avoid deadlock, let the reader loop handle disconnect
		}
	}
}

func startCloudBridgeClient(ctx context.Context, cwd string, handler *server.Handler) {
	cloudURL := strings.TrimSpace(os.Getenv("RICOCHET_CLOUD_URL"))
	if cloudURL == "" {
		return
	}
	sessionID := strings.TrimSpace(os.Getenv("RICOCHET_SESSION_ID"))
	if sessionID == "" {
		sessionID = "session_" + paths.GetWorkspaceHash(cwd)
	}
	client := bridgepkg.NewClient(cloudURL, sessionID)
	log.Printf("Cloud bridge enabled for session %s", sessionID)
	go client.Run(ctx)
	go func() {
		for {
			select {
			case <-ctx.Done():
				client.Close()
				return
			case event := <-client.Incoming():
				if event == nil {
					continue
				}
				bridgeSessionID, endpoint, eventID, text := extractBridgeInbound(event, sessionID)
				if strings.TrimSpace(text) == "" {
					continue
				}
				go handleCloudBridgeText(handler, client, bridgeSessionID, endpoint, eventID, text)
			}
		}
	}()
}

func extractBridgeInbound(event *bridgeproto.BridgeEvent, fallbackSessionID string) (string, BridgeEndpoint, string, string) {
	sessionID := firstNonEmptyString(event.GetSessionId(), fallbackSessionID)
	if msg := event.GetInboundMessage(); msg != nil {
		env := msg.GetEnvelope()
		if env != nil {
			sessionID = firstNonEmptyString(env.GetSessionId(), sessionID)
		}
		text := msg.GetText()
		if text == "" {
			text = msg.GetCallbackData()
		}
		return sessionID, endpointFromEnvelope(env), env.GetEventId(), text
	}
	if msg := event.GetIncomingMessage(); msg != nil {
		return sessionID, BridgeEndpoint{Platform: firstNonEmptyString(msg.GetPlatform(), "telegram"), ChatID: msg.GetChatId()}, "", msg.GetBody()
	}
	if control := event.GetSessionControl(); control != nil {
		env := control.GetEnvelope()
		if env != nil {
			sessionID = firstNonEmptyString(control.GetTargetSessionId(), env.GetSessionId(), sessionID)
			return sessionID, endpointFromEnvelope(env), env.GetEventId(), control.GetBody()
		}
	}
	return sessionID, BridgeEndpoint{}, "", ""
}

func endpointFromEnvelope(env *bridgeproto.Envelope) BridgeEndpoint {
	if env == nil {
		return BridgeEndpoint{}
	}
	return BridgeEndpoint{
		Platform:  firstNonEmptyString(env.GetPlatform(), "telegram"),
		ChatID:    env.GetChatId(),
		ChannelID: env.GetChannelId(),
		ThreadID:  env.GetThreadId(),
		UserID:    env.GetUserId(),
	}
}

func handleCloudBridgeText(handler *server.Handler, client *bridgepkg.Client, sessionID string, endpoint BridgeEndpoint, eventID, text string) {
	delivery := "queue"
	content := strings.TrimSpace(text)
	activeSessionID := remoteActiveSessionID(endpoint, sessionID)
	if strings.HasPrefix(content, "/steer ") {
		delivery = "steer"
		content = strings.TrimSpace(strings.TrimPrefix(content, "/steer "))
	}
	if strings.HasPrefix(content, "/help") {
		writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: activeSessionID}
		_ = writer.sendText("Safe remote commands:\n\n" + strings.Join(remote.SafeSlashCommands(), "\n"))
		_ = client.AckEvent(eventID, "completed", "")
		return
	}
	if !remote.IsSafeSlashCommand(content) {
		writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: activeSessionID}
		_ = writer.sendText("⚠️ This slash command is local-only and cannot be executed from remote control. Send `/help` for safe remote commands.")
		_ = client.AckEvent(eventID, "rejected", "unsafe remote command")
		return
	}
	if strings.HasPrefix(content, "/status") {
		writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: activeSessionID}
		_ = writer.sendText(fmt.Sprintf("🟢 Ricochet is online.\n\nActive session: `%s`", activeSessionID))
		_ = client.AckEvent(eventID, "completed", "")
		return
	}
	if strings.HasPrefix(content, "/sessions") {
		writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: activeSessionID}
		_ = writer.sendText(remoteSessionsText(handler, activeSessionID))
		_ = client.AckEvent(eventID, "completed", "")
		return
	}
	if strings.HasPrefix(content, "/queue") {
		ensureRemoteSession(handler, activeSessionID)
		writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: activeSessionID}
		_ = writer.sendText(remoteQueueText(handler, activeSessionID))
		_ = client.AckEvent(eventID, "completed", "")
		return
	}
	if strings.HasPrefix(content, "/cancel") {
		canceled := false
		if handler.Agent != nil {
			canceled = handler.Agent.AbortSession(activeSessionID)
		}
		writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: activeSessionID}
		if canceled {
			_ = writer.sendText(fmt.Sprintf("🛑 Cancel requested for session `%s`.", activeSessionID))
		} else {
			_ = writer.sendText(fmt.Sprintf("ℹ️ No active run found for session `%s`.", activeSessionID))
		}
		_ = client.AckEvent(eventID, "completed", "")
		return
	}
	if strings.HasPrefix(content, "/new") {
		newSessionID := fmt.Sprintf("s_remote_%d", time.Now().UnixMilli())
		ensureRemoteSession(handler, newSessionID)
		remoteSessionBindings.Store(endpoint.Key(), newSessionID)
		writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: newSessionID}
		_ = writer.sendText(fmt.Sprintf("🆕 New remote session started: `%s`", newSessionID))
		_ = client.AckEvent(eventID, "completed", "")
		return
	}
	if strings.HasPrefix(content, "/switch ") {
		target := strings.TrimSpace(strings.TrimPrefix(content, "/switch "))
		if target != "" {
			ensureRemoteSession(handler, target)
			remoteSessionBindings.Store(endpoint.Key(), target)
			writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: target}
			_ = writer.sendText(fmt.Sprintf("✅ Switched to session: `%s`", target))
			_ = client.AckEvent(eventID, "completed", "")
			return
		}
	}
	ensureRemoteSession(handler, activeSessionID)
	payload := map[string]interface{}{
		"content":    content,
		"session_id": activeSessionID,
		"via":        "cloud",
		"run_id":     fmt.Sprintf("cloud-%d", time.Now().UnixMilli()),
		"delivery":   delivery,
	}
	writer := &BridgeWriter{client: client, eventID: eventID, endpoint: endpoint, sessionID: activeSessionID}
	handler.HandleMessage(protocol.RPCMessage{
		ID:      eventID,
		Type:    "chat_message",
		Payload: protocol.EncodeRPC(payload),
	}, writer)
}

func remoteSessionsText(handler *server.Handler, activeSessionID string) string {
	if handler.Agent == nil {
		return "⚠️ Agent is not ready."
	}
	sessions := handler.Agent.ListSessions()
	if len(sessions) == 0 {
		return "📭 No sessions yet."
	}
	var sb strings.Builder
	sb.WriteString("🧭 Remote sessions:\n\n")
	for i, session := range sessions {
		if i >= 8 {
			sb.WriteString(fmt.Sprintf("…and %d more", len(sessions)-i))
			break
		}
		marker := " "
		if session.ID == activeSessionID {
			marker = "•"
		}
		sb.WriteString(fmt.Sprintf("%s `%s` — $%.4f\n", marker, session.ID, session.TotalCost))
	}
	return sb.String()
}

func remoteQueueText(handler *server.Handler, sessionID string) string {
	if handler.Agent == nil {
		return "⚠️ Agent is not ready."
	}
	session := handler.Agent.GetSession(sessionID)
	if session == nil || len(session.MessageQueue) == 0 {
		return "📭 Queue is empty."
	}
	var sb strings.Builder
	sb.WriteString("📥 Queued commands:\n\n")
	for i, queued := range session.MessageQueue {
		if i >= 5 {
			sb.WriteString(fmt.Sprintf("…and %d more", len(session.MessageQueue)-i))
			break
		}
		sb.WriteString(fmt.Sprintf("%d. `%s` — %s\n", i+1, queued.Delivery, truncateBridgeText(queued.Text)))
	}
	return sb.String()
}

func truncateBridgeText(text string) string {
	text = strings.TrimSpace(text)
	if len(text) <= 120 {
		return text
	}
	return text[:117] + "..."
}

func remoteActiveSessionID(endpoint BridgeEndpoint, fallback string) string {
	if value, ok := remoteSessionBindings.Load(endpoint.Key()); ok {
		if sessionID, ok := value.(string); ok && strings.TrimSpace(sessionID) != "" {
			return sessionID
		}
	}
	return fallback
}

func ensureRemoteSession(handler *server.Handler, sessionID string) {
	if strings.TrimSpace(sessionID) == "" {
		return
	}
	handler.HandleMessage(protocol.RPCMessage{
		ID:   "bridge-create-" + sessionID,
		Type: "create_session",
		Payload: protocol.EncodeRPC(map[string]string{
			"session_id": sessionID,
		}),
	}, &DiscardWriter{})
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Allow all origins for local dev
	CheckOrigin: func(r *http.Request) bool { return true },
}

func main() {
	// Force TrueColor for TUI - fixes ANSI artifacts in some VTs
	lipgloss.SetColorProfile(termenv.TrueColor)

	log.SetPrefix("[ricochet-core] ")
	log.SetOutput(os.Stderr)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle shutdown signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("Shutting down...")
		cancel()
	}()

	// Get current working directory for context
	cwd, err := os.Getwd()
	if err != nil {
		log.Printf("Warning: Failed to get cwd: %v", err)
		cwd = "."
	}

	if err := executeRoot(ctx, cwd); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// runStdioMode runs as sidecar process communicating with extension via stdio
func runStdioMode(ctx context.Context, cwd string, pm *config.ProvidersManager) {
	log.Println("Starting in stdio mode...")

	stdioHost := host.NewStdioHost(cwd)
	modesManager := modes.NewManager(cwd)
	mcpHub := mcp.NewHub(cwd)
	cg := codegraph.NewService()
	// Init Workflow Manager
	wm := workflow.NewManager(cwd)
	if err := wm.LoadWorkflows(); err != nil {
		log.Printf("Warning: Failed to load workflows: %v", err)
	}
	if err := wm.Hooks.LoadHooks(); err != nil {
		log.Printf("Warning: Failed to load hooks: %v", err)
	}

	// Trigger on_start hook
	wm.Hooks.Trigger("on_start")

	// Handle graceful shutdown for hooks
	go func() {
		<-ctx.Done()
		wm.Hooks.Trigger("on_shutdown")
	}()

	modesManager.SetOnModeChange(func(slug string) {
		sendMessage(protocol.RPCMessage{
			Type:    "mode_changed",
			Payload: protocol.EncodeRPC(map[string]string{"mode": slug}),
		})
	})

	// Initialize LiveMode Controller
	var liveCtrl *livemode.Controller
	if liveModeConfig.TelegramToken != "" || liveModeConfig.DiscordToken != "" {
		var err error
		liveCtrl, err = livemode.New(liveModeConfig, nil)
		if err != nil {
			logLiveModeInitError(err)
		} else {
			// Wire callbacks
			liveCtrl.SetOnStatusUpdate(func(status livemode.Status) {
				sendMessage(protocol.RPCMessage{
					Type:    "live_mode_status",
					Payload: protocol.EncodeRPC(status),
				})
			})
			liveCtrl.SetOnActivity(func(activity livemode.EtherActivity) {
				sendMessage(protocol.RPCMessage{
					Type: "ether_activity",
					Payload: protocol.EncodeRPC(map[string]interface{}{
						"stage":    activity.Stage,
						"source":   activity.Source,
						"username": activity.Username,
						"preview":  activity.Preview,
					}),
				})
			})
			liveCtrl.SetOnChatUpdate(func(update agent.ChatUpdate) {
				sendMessage(protocol.RPCMessage{
					Type: "chat_update",
					Payload: protocol.EncodeRPC(map[string]interface{}{
						"message": update.Message,
					}),
				})
			})
			// Start background polling
			liveCtrl.Start(ctx)
		}
	}

	// Initialize Handler
	// We pass nil for ProvidersManager initially, Handler handles lazy load if needed
	handler := server.NewHandler(
		ctx,
		cfg,
		liveModeConfig,
		settingsStore,
		stdioHost,
		modesManager,
		mcpHub,
		cg,
		wm,
		pm,
		liveCtrl,
	)
	handler.OnEvent = func(e agent.Event) {
		sendMessage(protocol.RPCMessage{
			Type:    string(e.Type),
			Payload: protocol.EncodeRPC(e.Payload),
		})
	}
	handler.OnBatchEvent = func(e protocol.BatchEvent) {
		sendMessage(protocol.RPCMessage{
			Type:    "batch_event",
			Payload: protocol.EncodeRPC(e),
		})
	}
	startCloudBridgeClient(ctx, cwd, handler)
	writer := &StdioWriter{}

	// Send ready message with enough diagnostics to catch stale extension binaries.
	ready := version.Get()
	sendMessage(protocol.RPCMessage{Type: "ready", Payload: protocol.EncodeRPC(map[string]interface{}{
		"version":         ready.Version,
		"commit":          ready.Commit,
		"build_time":      ready.BuildTime,
		"executable_path": ready.ExecutablePath,
		"cwd":             cwd,
	})})

	// Read messages from stdin
	scanner := bufio.NewScanner(os.Stdin)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}

		line := scanner.Bytes()
		var msg protocol.RPCMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			log.Printf("Failed to parse message: %v", err)
			continue
		}

		// Handle response type directly in loop (Host specific)
		if msg.Type == "response" {
			// Handle ID which could be string or float64 from extension
			var idStr string
			switch v := msg.ID.(type) {
			case string:
				idStr = v
			case float64:
				idStr = fmt.Sprintf("%.0f", v)
			default:
				log.Printf("Warning: Unknown ID type: %T", v)
				continue
			}

			// Pass raw payload directly to handle generic types
			stdioHost.HandleResponse(idStr, msg.Payload)
			continue
		}

		// Process message via Handler
		go handler.HandleMessage(msg, writer)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Scanner error: %v", err)
	}
}

// runServerMode runs as a WebSocket server (Dawn of the Daemon)
func runServerMode(ctx context.Context, cwd, port string, isDaemon bool, pm *config.ProvidersManager) {
	if isDaemon {
		log.Printf("Starting in Daemon Mode on port %s...", port)
	} else {
		log.Printf("Starting in Server Mode on port %s...", port)
	}

	// PID file management
	homeDir, _ := os.UserHomeDir()
	pidFile := filepath.Join(homeDir, ".ricochet", "core.pid")
	os.MkdirAll(filepath.Dir(pidFile), 0755)

	// Check if already running
	if oldPidData, err := os.ReadFile(pidFile); err == nil {
		var oldPid int
		fmt.Sscanf(string(oldPidData), "%d", &oldPid)
		if process, err := os.FindProcess(oldPid); err == nil {
			// On Unix, FindProcess always succeeds, so we need to send signal 0
			if err := process.Signal(syscall.Signal(0)); err == nil {
				log.Printf("Core is already running with PID %d. Use --force to restart or stop it first.", oldPid)
				if isDaemon {
					return
				}
			}
		}
	}

	// Save current PID
	os.WriteFile(pidFile, []byte(fmt.Sprintf("%d", os.Getpid())), 0644)
	defer os.Remove(pidFile)

	// Server Host acts conceptually different than StdioHost
	headlessHost := host.NewStdioHost(cwd)

	modesManager := modes.NewManager(cwd)
	mcpHub := mcp.NewHub(cwd)
	cg := codegraph.NewService()
	wm := workflow.NewManager(cwd)
	wm.LoadWorkflows()

	wsHub = NewWsHub()
	go wsHub.Run(ctx)

	// Initialize LiveMode Controller
	var liveCtrl *livemode.Controller
	if liveModeConfig.TelegramToken != "" || liveModeConfig.DiscordToken != "" {
		var err error
		liveCtrl, err = livemode.New(liveModeConfig, nil)
		if err != nil {
			logLiveModeInitError(err)
		} else {
			// Set daemon state so UI knows if we are persistent
			liveCtrl.SetDaemon(isDaemon)

			// Wire callbacks - using wsHub Broadcast
			broadcastWriter := &BroadcastWriter{hub: wsHub}

			liveCtrl.SetOnStatusUpdate(func(status livemode.Status) {
				broadcastWriter.Send(protocol.RPCMessage{
					Type:    "live_mode_status",
					Payload: protocol.EncodeRPC(status),
				})
			})
			liveCtrl.SetOnActivity(func(activity livemode.EtherActivity) {
				broadcastWriter.Send(protocol.RPCMessage{
					Type: "ether_activity",
					Payload: protocol.EncodeRPC(map[string]interface{}{
						"stage":    activity.Stage,
						"source":   activity.Source,
						"username": activity.Username,
						"preview":  activity.Preview,
					}),
				})
			})
			liveCtrl.SetOnChatUpdate(func(update agent.ChatUpdate) {
				broadcastWriter.Send(protocol.RPCMessage{
					Type: "chat_update",
					Payload: protocol.EncodeRPC(map[string]interface{}{
						"message": update.Message,
					}),
				})
			})
			// Start background polling
			liveCtrl.Start(ctx)
		}
	}

	handler := server.NewHandler(
		ctx,
		cfg,
		liveModeConfig,
		settingsStore,
		headlessHost,
		modesManager,
		mcpHub,
		cg,
		wm,
		pm,
		liveCtrl,
	)
	handler.OnEvent = func(e agent.Event) {
		wsHub.Broadcast(protocol.RPCMessage{
			Type:    string(e.Type),
			Payload: protocol.EncodeRPC(e.Payload),
		})
	}
	handler.OnBatchEvent = func(e protocol.BatchEvent) {
		wsHub.Broadcast(protocol.RPCMessage{
			Type:    "batch_event",
			Payload: protocol.EncodeRPC(e),
		})
	}
	startCloudBridgeClient(ctx, cwd, handler)

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("Upgrade error:", err)
			return
		}

		wsHub.register <- conn

		wsWriter := &WsWriter{conn: conn}

		// Read Loop
		go func() {
			defer func() {
				wsHub.unregister <- conn
			}()

			for {
				var msg protocol.RPCMessage
				err := conn.ReadJSON(&msg)
				if err != nil {
					log.Printf("Read error: %v", err)
					break
				}

				// Ensure ID is string (JS JSON often sends numbers)

				// Handle response
				if msg.Type == "response" {
					continue
				}

				// Special handling for Chat Message to broadcast updates
				if msg.Type == "chat_message" {
					// We want updates to go to EVERYONE, not just the caller
					broadcastWriter := &BroadcastWriter{hub: wsHub}
					handler.HandleMessage(msg, broadcastWriter)
				} else {
					// Other requests (get_state, etc) go back to caller only
					handler.HandleMessage(msg, wsWriter)
				}
			}
		}()
	})

	log.Printf("Listening on :%s", port)
	server := &http.Server{Addr: ":" + port, Handler: nil}

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("ListenAndServe error: %v", err)
		}
	}()

	// Wait for shutdown trigger
	<-ctx.Done()

	ctxShut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(ctxShut)
}

// runMCPMode runs as MCP server (for Claude Code, Cursor, etc.)
func runMCPMode(_ context.Context) error {
	return fmt.Errorf("MCP server mode is not wired to the unified agent yet; use `ricochet daemon start` for Ricochet clients or configure MCP servers with `ricochet mcp`")
}

func sendMessage(msg interface{}) {
	outputMu.Lock()
	defer outputMu.Unlock()

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal message: %v", err)
		return
	}
	fmt.Printf("%s\n", data)
}

// runInteractiveMode launches the TUI agent
func runInteractiveMode(_ context.Context, cwd string) {
	// Redirect logs to file to avoid messing up TUI
	f, err := os.OpenFile("ricochet.log", os.O_RDWR|os.O_CREATE|os.O_APPEND, 0666)
	if err == nil {
		log.SetOutput(f)
		defer f.Close()
	} else {
		log.SetOutput(new(devNull))
	}

	msgChan := make(chan tea.Msg, 100)
	tuiHost := tui.NewTuiHost(cwd, msgChan)

	// Create Agent Controller
	// We reuse main's cfg if possible, but simpler to recreate or pass it in.
	// For simplicity, let's rely on standard config loading inside NewController (partial duplication but safe)

	settingsStore, _ := config.NewStore()
	settings := settingsStore.Get()
	pm, _ := config.NewProvidersManager(config.FindConfigFile())
	credentialMode := ""
	baseURL := ""
	if pm != nil {
		for providerID, key := range settings.Provider.APIKeys {
			pm.SetUserKey(providerID, key)
		}
		if mode, ok := pm.ModelCredentialMode(settings.Provider.Provider, settings.Provider.Model); ok {
			credentialMode = mode
		}
		baseURL = pm.GetBaseURL(settings.Provider.Provider)
	}
	apiKey := settings.Provider.APIKey
	if credentialMode == "none" {
		apiKey = ""
	}
	cfg := &agent.Config{
		Provider: agent.ProviderConfig{
			Provider:       settings.Provider.Provider,
			Model:          settings.Provider.Model,
			APIKey:         apiKey,
			BaseURL:        baseURL,
			CredentialMode: credentialMode,
		},
		SystemPrompt:  prompts.BuildSystemPrompt(cwd), // Updated to use prompts package
		MaxTokens:     4096,
		ContextWindow: 128000,
		AutoApproval:  &settings.AutoApproval,
		ModeModels:    settings.ModeModels,
		Terminal:      settings.Terminal,
	}

	// FORCE-ENABLE read ops for better UX (ignoring stale config if needed)
	cfg.AutoApproval.Enabled = true
	cfg.AutoApproval.ReadFiles = true
	cfg.AutoApproval.ReadFilesExternal = false  // Keep this safe
	cfg.AutoApproval.ExecuteSafeCommands = true // Allow ls, cat etc

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

	// Helper to handle API Keys map
	if cfg.Provider.APIKey == "" && len(settings.Provider.APIKeys) > 0 {
		// Try to fallback
		if k, ok := settings.Provider.APIKeys[cfg.Provider.Provider]; ok {
			cfg.Provider.APIKey = k
		}
	}

	opts := agent.ControllerOptions{
		Host: tuiHost,
	}

	controller, err := agent.NewController(cfg, opts)
	if err != nil {
		fmt.Printf("Failed to initialize agent (check connection/keys): %v\n", err)
		os.Exit(1)
	}

	// WIRE SWARM EVENTS TO TUI
	controller.SetOnTaskProgress(func(progress protocol.TaskProgress) {
		msgChan <- progress
	})

	// Initialize Live Mode if configured
	var liveCtrl *livemode.Controller
	if settings.LiveMode.TelegramToken != "" || settings.LiveMode.DiscordToken != "" {
		liveConfig := &livemode.Config{
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

		// Re-use err
		liveCtrl, err = livemode.New(liveConfig, nil)
		if err != nil {
			logLiveModeInitError(err)
		} else {
			// Wire Callbacks
			liveCtrl.SetAgent(controller)

			// 1. Output Mirroring (Agent -> Telegram) AND (Telegram -> TUI)
			liveCtrl.SetOnChatUpdate(func(update agent.ChatUpdate) {
				// Filter out technical updates (ContextStatus) that have no message content/role
				if update.Message == nil || (update.Message.Role == "" && update.Message.Content == "") {
					return
				}
				log.Printf("[MAIN] Forwarding ChatUpdate to TUI: %d chars", len(update.Message.Content))
				msgChan <- tui.RemoteChatMsg{Message: *update.Message}
			})

			// 2. Input Control (Telegram -> TUI)
			liveCtrl.SetOnUserMessage(func(msg string) {
				msgChan <- tui.RemoteInputMsg{Content: msg}
			})

			// 3. Task Progress (Agent -> TUI)
			liveCtrl.SetOnTaskProgress(func(progress protocol.TaskProgress) {
				msgChan <- progress
			})

			// Start background polling
			liveCtrl.Start(context.Background())
		}
	}

	// Pass controller to model
	// m := tui.NewModel(cwd, cfg.Provider.Model, msgChan, controller)
	// We need to inject liveCtrl into model if possible, or let model handle it via controller?
	// The Model struct has LiveCtrl field.

	m := tui.NewModel(cwd, cfg.Provider.Model, msgChan, controller)

	// BIND PLAN TO SESSION
	// Now that TUI has created a fresh session ID, we tell the Controller (and PlanManager) to scope to it.
	controller.SetMainSessionID(m.SessionID)

	m.LiveCtrl = liveCtrl
	if liveCtrl != nil {
		m.IsEtherMode = true
		// BINDING FIX: Tell LiveMode about the TUI's session
		liveCtrl.SetMainSessionID(m.SessionID)
	}
	m.SettingsStore = settingsStore

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Printf("Error running Ricochet TUI: %v\n", err)
		os.Exit(1)
	}
}

type devNull struct{}

func (d *devNull) Write(p []byte) (n int, err error) {
	return len(p), nil
}
