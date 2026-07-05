package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestHubLoadMergedSettingsProjectOverridesGlobal(t *testing.T) {
	configDir := t.TempDir()
	workspace := t.TempDir()
	writeMcpSettingsForTest(t, filepath.Join(configDir, "mcp_settings.json"), McpSettings{
		McpServers: map[string]McpServerConfig{
			"shared": {Command: "global"},
			"global-only": {
				Command: "node",
				Args:    []string{"global.js"},
			},
		},
	})
	writeMcpSettingsForTest(t, filepath.Join(workspace, ".ricochet", "mcp.json"), McpSettings{
		McpServers: map[string]McpServerConfig{
			"shared": {Command: "project"},
			"project-only": {
				Command: "node",
				Args:    []string{"project.js"},
			},
		},
	})

	hub := NewHubWithDirs(configDir, workspace)
	t.Cleanup(func() { _ = hub.Close() })
	settings, err := hub.LoadMergedSettings()
	if err != nil {
		t.Fatal(err)
	}
	if settings.McpServers["shared"].Command != "project" {
		t.Fatalf("expected project override, got %#v", settings.McpServers["shared"])
	}
	if _, ok := settings.McpServers["global-only"]; !ok {
		t.Fatalf("expected global server in merged settings: %#v", settings.McpServers)
	}
	if _, ok := settings.McpServers["project-only"]; !ok {
		t.Fatalf("expected project server in merged settings: %#v", settings.McpServers)
	}
}

func writeMcpSettingsForTest(t *testing.T, path string, settings McpSettings) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
}
