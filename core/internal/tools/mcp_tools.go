package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"strings"
	"github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	mcpLib "github.com/mark3labs/mcp-go/mcp"
)

// MCPListTool lists all connected MCP servers and their status
type MCPListTool struct {
	Hub *mcp.Hub
}

func (t *MCPListTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "list_mcp_servers",
		Description: "List all currently configured MCP servers, their connection status, uptime, and provided tools.",
		InputSchema: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
	}
}

func (t *MCPListTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	if t.Hub == nil {
		return "", fmt.Errorf("MCP Hub is not initialized")
	}

	status := t.Hub.GetStatus()
	if len(status) == 0 {
		return "No MCP servers configured.", nil
	}

	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to format status: %w", err)
	}

	return string(data), nil
}

// MCPInstallTool installs a new MCP server
type MCPInstallTool struct {
	Hub       *mcp.Hub
	ConfigDir string
}

func (t *MCPInstallTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "install_mcp_server",
		Description: "Install and configure a new MCP server. Supports stdio servers.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name":    map[string]interface{}{"type": "string", "description": "Unique name for the server"},
				"command": map[string]interface{}{"type": "string", "description": "Command to run (e.g. 'npx', 'node')"},
				"args":    map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
				"env":     map[string]interface{}{"type": "object", "additionalProperties": map[string]interface{}{"type": "string"}},
			},
			"required": []string{"name", "command"},
		},
	}
}

func (t *MCPInstallTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Name    string            `json:"name"`
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	}

	if err := json.Unmarshal(args, &params); err != nil {
		return "", err
	}

	settingsPath := filepath.Join(t.ConfigDir, "mcp_settings.json")
	var settings mcp.McpSettings

	data, err := os.ReadFile(settingsPath)
	if err == nil {
		json.Unmarshal(data, &settings)
	}

	if settings.McpServers == nil {
		settings.McpServers = make(map[string]mcp.McpServerConfig)
	}

	settings.McpServers[params.Name] = mcp.McpServerConfig{
		Command: params.Command,
		Args:    params.Args,
		Env:     params.Env,
	}

	newData, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return "", err
	}

	if err := os.WriteFile(settingsPath, newData, 0644); err != nil {
		return "", fmt.Errorf("failed to save settings: %w", err)
	}

	return fmt.Sprintf("Successfully installed MCP server '%s'. It will be started momentarily.", params.Name), nil
}

// MCPBrowseRegistryTool allows agents to browse available MCP servers
type MCPBrowseRegistryTool struct {
	Registry *mcp.Registry
}

func (t *MCPBrowseRegistryTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "browse_mcp_registry",
		Description: "Browse the official registry of community-maintained MCP servers. Use this to find new tools to install.",
		InputSchema: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
	}
}

func (t *MCPBrowseRegistryTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	if t.Registry == nil {
		return "", fmt.Errorf("MCP Registry is not initialized")
	}

	servers, err := t.Registry.FetchServers(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to fetch registry: %w", err)
	}

	data, err := json.MarshalIndent(servers, "", "  ")
	if err != nil {
		return "", err
	}

	return string(data), nil
}

// MCPListResourcesTool lists all available MCP resources
type MCPListResourcesTool struct {
	Hub *mcp.Hub
}

func (t *MCPListResourcesTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "list_mcp_resources",
		Description: "List all available resources from connected MCP servers. Resources can be logs, schemas, or documentation.",
		InputSchema: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
	}
}

func (t *MCPListResourcesTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	if t.Hub == nil {
		return "", fmt.Errorf("MCP Hub is not initialized")
	}

	status := t.Hub.GetStatus()
	type ResourceInfo struct {
		Server    string            `json:"server"`
		Resources []mcpLib.Resource `json:"resources"`
	}

	var results []ResourceInfo
	for name, conn := range status {
		if len(conn.Resources) > 0 {
			results = append(results, ResourceInfo{
				Server:    name,
				Resources: conn.Resources,
			})
		}
	}

	if len(results) == 0 {
		return "No MCP resources found.", nil
	}

	data, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		return "", err
	}

	return string(data), nil
}

// MCPReadResourceTool reads a specific MCP resource
type MCPReadResourceTool struct {
	Hub *mcp.Hub
}

func (t *MCPReadResourceTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "read_mcp_resource",
		Description: "Read the content of an MCP resource by its URI.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"uri": map[string]interface{}{"type": "string", "description": "The URI of the resource to read"},
			},
			"required": []string{"uri"},
		},
	}
}

func (t *MCPReadResourceTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", err
	}

	if t.Hub == nil {
		return "", fmt.Errorf("MCP Hub is not initialized")
	}

	result, err := t.Hub.ReadResource(ctx, params.URI)
	if err != nil {
		return "", fmt.Errorf("failed to read resource: %w", err)
	}

	var sb strings.Builder
	for _, content := range result.Contents {
		// Handle both Text and Blob types by inspection
		// NOTE: mcpLib.ResourceContents is an interface or a struct with optional fields.
		// According to common SDK patterns, we check for Text field.
		if text, ok := content.(mcpLib.TextResourceContents); ok {
			sb.WriteString(text.Text)
			sb.WriteString("\n")
		} else if blob, ok := content.(mcpLib.BlobResourceContents); ok {
			sb.WriteString(fmt.Sprintf("[Binary Content (%s)]\n", blob.MIMEType))
		}
	}

	return sb.String(), nil
}

// MCPListPromptsTool lists all available MCP prompts
type MCPListPromptsTool struct {
	Hub *mcp.Hub
}

func (t *MCPListPromptsTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "list_mcp_prompts",
		Description: "List all available prompt templates from connected MCP servers.",
		InputSchema: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
	}
}

func (t *MCPListPromptsTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	if t.Hub == nil {
		return "", fmt.Errorf("MCP Hub is not initialized")
	}

	status := t.Hub.GetStatus()
	type PromptInfo struct {
		Server  string          `json:"server"`
		Prompts []mcpLib.Prompt `json:"prompts"`
	}

	var results []PromptInfo
	for name, conn := range status {
		if len(conn.Prompts) > 0 {
			results = append(results, PromptInfo{
				Server:  name,
				Prompts: conn.Prompts,
			})
		}
	}

	if len(results) == 0 {
		return "No MCP prompts found.", nil
	}

	data, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		return "", err
	}

	return string(data), nil
}
