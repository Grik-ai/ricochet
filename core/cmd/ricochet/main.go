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
	"sync"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/gorilla/websocket"
	"github.com/igoryan-dao/ricochet/internal/agent"
	"github.com/igoryan-dao/ricochet/internal/codegraph"
	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/livemode"
	"github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/modes"
	"github.com/igoryan-dao/ricochet/internal/prompts"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/server"
	"github.com/igoryan-dao/ricochet/internal/tui"
	"github.com/igoryan-dao/ricochet/internal/workflow"
	"github.com/mattn/go-isatty"
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
)

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

	fmt.Println("\n\n********************************************************")
	fmt.Println("* RICOCHET CORE v2.0 - BUILD UPDATED: 2026-04-15 15:30 *")
	fmt.Println("********************************************************")

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

	// Initialize Settings Store
	var errStore error
	settingsStore, errStore = config.NewStore()
	if errStore != nil {
		log.Printf("Warning: Failed to initialize settings store: %v", errStore)
	}

	settings := settingsStore.Get()

	// Initialize ProvidersManager early to allow key resolution from .env.local
	configPath := config.FindConfigFile()
	pm, err := config.NewProvidersManager(configPath)
	if err != nil {
		log.Printf("Warning: Failed to initialize ProvidersManager: %v", err)
	}

	// Initialize default config (will be updated via settings)
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
		MaxTokens:          4096, // Max tokens for response
		ContextWindow:      128000,
		EnableCodeIndex:    settings.Context.EnableCodeIndex,
		Context:            settings.Context,
		AutoApproval:       &settings.AutoApproval,
		ModeModels:         settings.ModeModels,
		Terminal:           settings.Terminal,
		CustomInstructions: settings.CustomInstructions,
	}

	// Final API Key Resolution: Priority Settings.APIKey > ProvidersManager (Server Keys / .env.local)
	if cfg.Provider.APIKey == "" && pm != nil {
		resolvedKey := pm.GetAPIKey(cfg.Provider.Provider)
		if resolvedKey != "" {
			log.Printf("Resolved initial API Key for %s from ProvidersManager", cfg.Provider.Provider)
			cfg.Provider.APIKey = resolvedKey
		}
	}

	// Configure Embedding Provider if one is specified
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

	// Initialize Live Mode config (will be updated via settings)
	liveModeConfig = &livemode.Config{
		TelegramToken:  settings.LiveMode.TelegramToken,
		TelegramChatID: settings.LiveMode.TelegramChatID,
		AllowedUserIDs: []int64{},
		WhisperBinary:  settings.LiveMode.WhisperBinary,
		WhisperModel:   settings.LiveMode.WhisperModel,
	}

	// Check for flags
	args := os.Args[1:]
	isServer := false
	port := "5555"
	isStdio := false
	forceTui := false
	isDaemon := false

	for i := 0; i < len(args); i++ {
		if args[i] == "--server" {
			isServer = true
		} else if args[i] == "--port" && i+1 < len(args) {
			port = args[i+1]
			i++
		} else if args[i] == "--stdio" {
			isStdio = true
		} else if args[i] == "--tui" {
			forceTui = true
		} else if args[i] == "--daemon" {
			isDaemon = true
		}
	}

	if isServer || isDaemon {
		runServerMode(ctx, cwd, port, isDaemon, pm)
	} else if isStdio {
		runStdioMode(ctx, cwd, pm)
	} else if forceTui || (len(args) == 0 && isatty.IsTerminal(os.Stdout.Fd()) && isatty.IsTerminal(os.Stdin.Fd())) {
		// Default to Interactive Mode if TTY detected OR forced
		runInteractiveMode(ctx, cwd)
	} else {
		// Default to MCP mode if no args and not TTY, or handle as needed
		runMCPMode(ctx)
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
	if liveModeConfig.TelegramToken != "" {
		var err error
		liveCtrl, err = livemode.New(liveModeConfig, nil)
		if err != nil {
			log.Printf("Warning: Failed to create LiveMode controller: %v", err)
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
	writer := &StdioWriter{}

	// Send ready message
	sendMessage(protocol.RPCMessage{Type: "ready", Payload: protocol.EncodeRPC(map[string]string{"version": "0.1.0"})})

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
	if liveModeConfig.TelegramToken != "" {
		var err error
		liveCtrl, err = livemode.New(liveModeConfig, nil)
		if err != nil {
			log.Printf("Warning: Failed to create LiveMode controller: %v", err)
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
func runMCPMode(ctx context.Context) {
	log.Println("Starting in MCP mode...")
	log.Println("MCP server not yet integrated into unified binary")
	<-ctx.Done()
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
	cfg := &agent.Config{
		Provider: agent.ProviderConfig{
			Provider: settings.Provider.Provider,
			Model:    settings.Provider.Model,
			APIKey:   settings.Provider.APIKey,
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
	if settings.LiveMode.TelegramToken != "" {
		liveConfig := &livemode.Config{
			TelegramToken:  settings.LiveMode.TelegramToken,
			TelegramChatID: settings.LiveMode.TelegramChatID,
			WhisperBinary:  settings.LiveMode.WhisperBinary,
			WhisperModel:   settings.LiveMode.WhisperModel,
		}

		// Re-use err
		liveCtrl, err = livemode.New(liveConfig, nil)
		if err != nil {
			fmt.Printf("Warning: Failed to create LiveMode controller: %v\n", err)
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
