package marketplace

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/mcp"
)

func TestCatalogUsesCacheAndBundledFallback(t *testing.T) {
	configDir := t.TempDir()
	workspace := t.TempDir()
	service := NewService(configDir, workspace)

	fallback, err := service.GetCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fallback.Stale || fallback.Source != "bundled" || len(fallback.Items) == 0 {
		t.Fatalf("expected bundled fallback catalog, got %#v", fallback)
	}

	writeCatalog(t, configDir, []Item{testSkillItem("cached-skill", "cached-skill", "Cached")})
	cached, err := service.GetCatalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if cached.Source != "cache" || len(cached.Items) != 1 || cached.Items[0].ID != "cached-skill" {
		t.Fatalf("expected cached catalog, got %#v", cached)
	}
}

func TestSkillInstallProjectAndGlobal(t *testing.T) {
	configDir := t.TempDir()
	workspace := t.TempDir()
	service := NewService(configDir, workspace)
	writeCatalog(t, configDir, []Item{testSkillItem("review", "review", "Review")})

	result, err := service.Install(context.Background(), InstallRequest{ID: "review", Type: ItemTypeSkill})
	if err != nil {
		t.Fatal(err)
	}
	projectPath := filepath.Join(workspace, ".ricochet", "skills", "review", "SKILL.md")
	if _, err := os.Stat(projectPath); err != nil {
		t.Fatalf("expected project skill file: %v", err)
	}
	if result.Item.Scope != ScopeProject || len(result.Metadata.Project) != 1 {
		t.Fatalf("expected project metadata, got %#v", result)
	}

	result, err = service.Install(context.Background(), InstallRequest{ID: "review", Type: ItemTypeSkill, Scope: ScopeGlobal})
	if err != nil {
		t.Fatal(err)
	}
	globalPath := filepath.Join(configDir, "skills", "review", "SKILL.md")
	if _, err := os.Stat(globalPath); err != nil {
		t.Fatalf("expected global skill file: %v", err)
	}
	if result.Item.Scope != ScopeGlobal || len(result.Metadata.Global) != 1 {
		t.Fatalf("expected global metadata, got %#v", result)
	}
}

func TestSkillInstallRejectsPathTraversal(t *testing.T) {
	configDir := t.TempDir()
	workspace := t.TempDir()
	service := NewService(configDir, workspace)
	item := testSkillItem("unsafe", "unsafe", "Unsafe")
	item.Skill.Files = append(item.Skill.Files, SkillFile{Path: "../escape.txt", Content: "escape"})
	writeCatalog(t, configDir, []Item{item})

	_, err := service.Install(context.Background(), InstallRequest{ID: "unsafe", Type: ItemTypeSkill})
	if err == nil {
		t.Fatal("expected path traversal install to fail")
	}
	if _, statErr := os.Stat(filepath.Join(workspace, ".ricochet", "escape.txt")); !os.IsNotExist(statErr) {
		t.Fatalf("unexpected escape file stat error: %v", statErr)
	}
}

func TestMCPInstallValidatesParametersAndWritesScopedConfig(t *testing.T) {
	configDir := t.TempDir()
	workspace := t.TempDir()
	service := NewService(configDir, workspace)
	item := Item{
		ID:          "demo-mcp",
		Type:        ItemTypeMCP,
		Name:        "Demo MCP",
		Description: "Demo",
		Version:     "1.0.0",
		MCP: &MCPPayload{
			Transport: "stdio",
			Command:   "node",
			Args:      []string{"server.js", "${PROJECT_ID}"},
			Parameters: []Parameter{
				{Name: "PROJECT_ID", Required: true},
				{Name: "API_KEY", EnvVar: "API_KEY", Required: true, Secret: true},
			},
			EnvVars: []string{"API_KEY"},
		},
	}
	writeCatalog(t, configDir, []Item{item})

	_, err := service.Install(context.Background(), InstallRequest{
		ID:         "demo-mcp",
		Type:       ItemTypeMCP,
		Parameters: map[string]string{"PROJECT_ID": "repo"},
	})
	if err == nil {
		t.Fatal("expected missing API_KEY to fail")
	}

	_, err = service.Install(context.Background(), InstallRequest{
		ID:   "demo-mcp",
		Type: ItemTypeMCP,
		Parameters: map[string]string{
			"PROJECT_ID": "repo",
			"API_KEY":    "secret",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	projectSettings := readSettingsForTest(t, filepath.Join(workspace, ".ricochet", "mcp.json"))
	cfg := projectSettings.McpServers["demo-mcp"]
	if cfg.Command != "node" || len(cfg.Args) != 2 || cfg.Args[1] != "repo" || cfg.Env["API_KEY"] != "secret" {
		t.Fatalf("unexpected project MCP config: %#v", cfg)
	}
	if len(cfg.AutoApprove) != 0 || len(cfg.AutoApproveTools) != 0 {
		t.Fatalf("marketplace install must not set auto-approve: %#v", cfg)
	}

	_, err = service.Install(context.Background(), InstallRequest{
		ID:    "demo-mcp",
		Type:  ItemTypeMCP,
		Scope: ScopeGlobal,
		Parameters: map[string]string{
			"PROJECT_ID": "repo",
			"API_KEY":    "secret",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	globalSettings := readSettingsForTest(t, filepath.Join(configDir, "mcp_settings.json"))
	if _, ok := globalSettings.McpServers["demo-mcp"]; !ok {
		t.Fatalf("expected global MCP config, got %#v", globalSettings.McpServers)
	}
}

func TestRemoveBlocksChecksumMismatch(t *testing.T) {
	configDir := t.TempDir()
	workspace := t.TempDir()
	service := NewService(configDir, workspace)
	writeCatalog(t, configDir, []Item{testSkillItem("review", "review", "Review")})

	if _, err := service.Install(context.Background(), InstallRequest{ID: "review", Type: ItemTypeSkill}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(workspace, ".ricochet", "skills", "review", "SKILL.md")
	if err := os.WriteFile(path, []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := service.Remove(context.Background(), RemoveRequest{ID: "review", Type: ItemTypeSkill})
	if err == nil {
		t.Fatal("expected checksum mismatch to block removal")
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("changed file should remain after blocked removal: %v", statErr)
	}
}

func writeCatalog(t *testing.T, configDir string, items []Item) {
	t.Helper()
	data, err := json.Marshal(CatalogResponse{Items: items})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "marketplace_catalog_cache.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
}

func testSkillItem(id, skillName, title string) Item {
	return Item{
		ID:          id,
		Type:        ItemTypeSkill,
		Name:        title,
		Description: "Test skill",
		Version:     "1.0.0",
		Skill: &SkillSpec{
			SkillName: skillName,
			Files: []SkillFile{{
				Path: "SKILL.md",
				Content: `---
name: ` + skillName + `
description: Test skill
---
# ` + title + `
`,
			}},
		},
	}
}

func readSettingsForTest(t *testing.T, path string) *mcp.McpSettings {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var settings mcp.McpSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	return &settings
}
