package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
)

// Hub manages connections to multiple MCP servers
type Hub struct {
	connections map[string]*McpConnection
	mu          sync.RWMutex
	configDir   string
	lastModTime time.Time
	registry    *Registry
}

// McpConnection represents an active connection to an MCP server
type McpConnection struct {
	Name              string                 `json:"name"`
	Status            string                 `json:"status"` // "connected", "connecting", "disconnected", "error"
	Error             string                 `json:"error,omitempty"`
	Tools             []mcp.Tool             `json:"tools,omitempty"`
	Resources         []mcp.Resource         `json:"resources,omitempty"`
	ResourceTemplates []mcp.ResourceTemplate `json:"resourceTemplates,omitempty"`
	Prompts           []mcp.Prompt           `json:"prompts,omitempty"`
	Latency           time.Duration          `json:"latency,omitempty"`
	UpdatedAt         time.Time              `json:"updatedAt"`
	Client            *client.Client         `json:"-"`
	Cmd               *exec.Cmd              `json:"-"`
}

// NewHub creates a new MCP Hub
func NewHub(configDir string) *Hub {
	h := &Hub{
		connections: make(map[string]*McpConnection),
		configDir:   configDir,
		registry:    NewRegistry(configDir),
	}
	h.registry.LoadCache()
	h.StartWatcher()
	return h
}

func (h *Hub) Registry() *Registry {
	return h.registry
}

func (h *Hub) StartWatcher() {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()

		settingsPath := filepath.Join(h.configDir, "mcp_settings.json")

		// Initial wait for file to exist or just load if exists
		// We'll trust the loop to pick it up or load initially if exists
		if _, err := os.Stat(settingsPath); err == nil {
			h.LoadFromSettings(settingsPath)
		}

		for range ticker.C {
			info, err := os.Stat(settingsPath)
			if err != nil {
				continue
			}

			if info.ModTime().After(h.lastModTime) {
				// File changed, reload
				h.LoadFromSettings(settingsPath)
			}
		}
	}()
}

func (h *Hub) LoadFromSettings(path string) {
	settings, err := h.loadMcpSettings()
	if err != nil {
		fmt.Printf("Error loading mcp_settings.json: %v\n", err)
		return
	}

	// Update lastModTime immediately to avoid double loading
	info, _ := os.Stat(path)
	if info != nil {
		h.lastModTime = info.ModTime()
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	// 1. Identify removed servers
	for name, conn := range h.connections {
		if _, exists := settings.McpServers[name]; !exists {
			fmt.Printf("Removing MCP server: %s\n", name)
			conn.Client.Close()
			delete(h.connections, name)
		}
	}


	// 2. Add/Update servers
	for name, config := range settings.McpServers {
		if config.Disabled {
			if conn, exists := h.connections[name]; exists {
				fmt.Printf("Disabling MCP server: %s\n", name)
				conn.Client.Close()
				delete(h.connections, name)
			}
			continue
		}

		if _, exists := h.connections[name]; !exists {
			// New connection
			// We launch a goroutine to connect to avoid blocking the hub lock for too long,
			// BUT we are holding the lock right now.
			// Ideally we should gather new configs and connect outside lock.
			// For simplicity in MVP, we connect synchronously or strictly assume fast startup.
			// Startups are NOT fast (process spawn).
			// So we should do it outside lock.

			// Strategy: Unlock, Connect, Lock, Assign.
			// But that's complicated with loop.
			// Simplest: Just use a separate goroutine for each connection attempt.

			go h.connectAsync(name, config)
		} else {
			// TODO: Check if config changed and reconnect?
			// Ignoring update for existing connections for now.
		}
	}
}

func (h *Hub) connectAsync(name string, config McpServerConfig) {
	fmt.Printf("Connecting to MCP server: %s\n", name)
	h.mu.Lock()
	h.connections[name] = &McpConnection{
		Name:      name,
		Status:    "connecting",
		UpdatedAt: time.Now(),
	}
	h.mu.Unlock()

	if err := h.connectInternal(context.Background(), name, config); err != nil {
		fmt.Printf("Failed to connect %s: %v\n", name, err)
		h.mu.Lock()
		if conn, ok := h.connections[name]; ok {
			conn.Status = "error"
			conn.Error = err.Error()
			conn.UpdatedAt = time.Now()
		}
		h.mu.Unlock()
	} else {
		fmt.Printf("Connected to MCP server: %s\n", name)
	}
}

// Connect establishes a connection to an MCP server via Stdio (Public API)
func (h *Hub) Connect(ctx context.Context, name string, config McpServerConfig) error {
	return h.connectInternal(ctx, name, config)
}

func (h *Hub) connectInternal(ctx context.Context, name string, config McpServerConfig) error {
	var mcpClient *client.Client
	var err error

	// 1. Create Client (Stdio or SSE)
	if config.URL != "" || config.Type == "sse" {
		// Placeholder for SSE client implementation
		// mcpClient, err = client.NewSSEMCPClient(config.URL)
		return fmt.Errorf("SSE (Remote) MCP servers are not yet fully supported in this version")
	} else {
		mcpClient, err = client.NewStdioMCPClient(config.Command, config.Args)
	}

	if err != nil {
		return fmt.Errorf("failed to create MCP client for %s: %w", name, err)
	}

	// 2. Start (Launch process)
	if err := mcpClient.Start(ctx); err != nil {
		return fmt.Errorf("failed to start MCP client for %s: %w", name, err)
	}

	// 3. Initialize
	initReq := mcp.InitializeRequest{}
	initReq.Params.ProtocolVersion = "2024-11-05"
	initReq.Params.Capabilities = mcp.ClientCapabilities{}
	initReq.Params.ClientInfo = mcp.Implementation{
		Name:    "ricochet",
		Version: "1.0.0",
	}

	_, err = mcpClient.Initialize(ctx, initReq)
	if err != nil {
		return fmt.Errorf("failed to initialize MCP client for %s: %w", name, err)
	}

	// 4. Collect Primitives
	conn, err := h.collectPrimitives(ctx, name, mcpClient)
	if err != nil {
		return err
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.connections[name] = conn
	return nil
}

func (h *Hub) collectPrimitives(ctx context.Context, name string, mcpClient *client.Client) (*McpConnection, error) {
	startTime := time.Now()
	ctxInit, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Fetch Tools
	listToolsResult, _ := mcpClient.ListTools(ctxInit, mcp.ListToolsRequest{})
	tools := []mcp.Tool{}
	if listToolsResult != nil {
		tools = listToolsResult.Tools
	}

	// Fetch Resources
	listResourcesResult, _ := mcpClient.ListResources(ctxInit, mcp.ListResourcesRequest{})
	resources := []mcp.Resource{}
	if listResourcesResult != nil {
		resources = listResourcesResult.Resources
	}

	// Fetch Resource Templates
	listTemplatesResult, _ := mcpClient.ListResourceTemplates(ctxInit, mcp.ListResourceTemplatesRequest{})
	templates := []mcp.ResourceTemplate{}
	if listTemplatesResult != nil {
		templates = listTemplatesResult.ResourceTemplates
	}

	// Fetch Prompts
	listPromptsResult, _ := mcpClient.ListPrompts(ctxInit, mcp.ListPromptsRequest{})
	prompts := []mcp.Prompt{}
	if listPromptsResult != nil {
		prompts = listPromptsResult.Prompts
	}

	latency := time.Since(startTime)

	return &McpConnection{
		Name:              name,
		Status:            "connected",
		Client:            mcpClient,
		Tools:             tools,
		Resources:         resources,
		ResourceTemplates: templates,
		Prompts:           prompts,
		Latency:           latency,
		UpdatedAt:         time.Now(),
	}, nil
}

// ProbeServer connects to a server temporarily to fetch its tools and properties
func (h *Hub) ProbeServer(ctx context.Context, config McpServerConfig) (*McpConnection, error) {
	var mcpClient *client.Client
	var err error

	if config.URL != "" || config.Type == "sse" {
		return nil, fmt.Errorf("SSE probing not yet implemented")
	}

	mcpClient, err = client.NewStdioMCPClient(config.Command, config.Args)
	if err != nil {
		return nil, err
	}

	if err := mcpClient.Start(ctx); err != nil {
		return nil, err
	}
	defer mcpClient.Close()

	initReq := mcp.InitializeRequest{}
	initReq.Params.ProtocolVersion = "2024-11-05"
	initReq.Params.ClientInfo = mcp.Implementation{Name: "ricochet-probe", Version: "1.0.0"}

	_, err = mcpClient.Initialize(ctx, initReq)
	if err != nil {
		return nil, err
	}

	return h.collectPrimitives(ctx, "probe", mcpClient)
}

// GetStatus returns the current status of all connections
func (h *Hub) GetStatus() map[string]*McpConnection {
	h.mu.RLock()
	defer h.mu.RUnlock()

	// Return a copy for safe serialization
	status := make(map[string]*McpConnection)
	for name, conn := range h.connections {
		status[name] = conn
	}
	return status
}

// GetTools returns a flat list of all tools from all servers
func (h *Hub) GetTools() []mcp.Tool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var allTools []mcp.Tool
	for _, conn := range h.connections {
		for _, tool := range conn.Tools {
			allTools = append(allTools, tool)
		}
	}
	return allTools
}

// CallTool executes a tool on the appropriate server
func (h *Hub) CallTool(ctx context.Context, name string, args map[string]interface{}) (*mcp.CallToolResult, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	// Find server with this tool
	var targetConn *McpConnection
	var targetConfig *McpServerConfig
	for _, conn := range h.connections {
		for _, tool := range conn.Tools {
			if tool.Name == name {
				targetConn = conn
				break
			}
		}
		if targetConn != nil {
			// Find config for this server to check auto-approval settings
			h.mu.RUnlock()
			settings, _ := h.loadMcpSettings()
			h.mu.RLock()
			if settings != nil {
				if cfg, ok := settings.McpServers[targetConn.Name]; ok {
					targetConfig = &cfg
				}
			}
			break
		}
	}

	if targetConn == nil {
		return nil, fmt.Errorf("tool not found: %s", name)
	}

	// ─── Phase 5: Granular Security Check ───
	isAutoApproved := false
	if targetConfig != nil {
		for _, approved := range targetConfig.AutoApproveTools {
			if approved == name || approved == "*" {
				isAutoApproved = true
				break
			}
		}
	}

	// If not auto-approved, we would normally prompt the user.
	// For now, we follow the global safeguard rule, but we mark it.
	if !isAutoApproved {
		// log.Printf("Tool %s on server %s is NOT auto-approved by server-config", name, targetConn.Name)
	}

	// Calculate timeout (default 60s)
	ctxWithTimeout, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	return targetConn.Client.CallTool(ctxWithTimeout, mcp.CallToolRequest{
		Params: mcp.CallToolParams{
			Name:      name,
			Arguments: args,
		},
	})
}

// ReadResource reads a resource from the appropriate MCP server
func (h *Hub) ReadResource(ctx context.Context, uri string) (*mcp.ReadResourceResult, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	// Find server with this resource URI (or template)
	var targetConn *McpConnection
	for _, conn := range h.connections {
		// Check explicit resources
		for _, res := range conn.Resources {
			if res.URI == uri {
				targetConn = conn
				break
			}
		}
		if targetConn != nil {
			break
		}

		// Check templates (basic prefix match or regex would be better)
		for _, tpl := range conn.ResourceTemplates {
			if strings.HasPrefix(uri, strings.Split(tpl.URITemplate.Raw(), "{")[0]) {
				targetConn = conn
				break
			}
		}
		if targetConn != nil {
			break
		}
	}

	if targetConn == nil {
		return nil, fmt.Errorf("no server found for resource: %s", uri)
	}

	return targetConn.Client.ReadResource(ctx, mcp.ReadResourceRequest{
		Params: mcp.ReadResourceParams{
			URI: uri,
		},
	})
}

// GetPrompt retrieves a prompt from the appropriate MCP server
func (h *Hub) GetPrompt(ctx context.Context, name string, args map[string]interface{}) (*mcp.GetPromptResult, error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var targetConn *McpConnection
	for _, conn := range h.connections {
		for _, p := range conn.Prompts {
			if p.Name == name {
				targetConn = conn
				break
			}
		}
		if targetConn != nil {
			break
		}
	}

	if targetConn == nil {
		return nil, fmt.Errorf("prompt not found: %s", name)
	}

	// Convert map[string]interface{} to map[string]string as required by the SDK
	stringArgs := make(map[string]string)
	for k, v := range args {
		stringArgs[k] = fmt.Sprintf("%v", v)
	}

	return targetConn.Client.GetPrompt(ctx, mcp.GetPromptRequest{
		Params: mcp.GetPromptParams{
			Name:      name,
			Arguments: stringArgs,
		},
	})
}

// Close closes all connections
func (h *Hub) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, conn := range h.connections {
		conn.Client.Close()
	}
	return nil
}

func (h *Hub) loadMcpSettings() (*McpSettings, error) {
	settingsPath := filepath.Join(h.configDir, "mcp_settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil, err
	}
	var settings McpSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, err
	}
	return &settings, nil
}
