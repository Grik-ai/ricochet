package mcp

// McpSettings represents the root of mcp_settings.json
type McpSettings struct {
	McpServers map[string]McpServerConfig `json:"mcpServers"`
}

// McpServerConfig represents the configuration for a single MCP server
type McpServerConfig struct {
	Type             string            `json:"type,omitempty"` // "stdio", "sse", etc.
	Command          string            `json:"command,omitempty"`
	Args             []string          `json:"args,omitempty"`
	URL              string            `json:"url,omitempty"` // For SSE/remote servers
	AutoApproveTools []string          `json:"autoApproveTools,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	Disabled         bool              `json:"disabled,omitempty"`
	AutoApprove      []string          `json:"autoApprove,omitempty"`
}
