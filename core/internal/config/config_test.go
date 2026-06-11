package config

import (
	"encoding/json"
	"testing"
)

func TestToolsSettings_JSON(t *testing.T) {
	jsonStr := `{"tools": {"disable_llm_correction": true}, "theme": "dark"}`
	var settings Settings
	if err := json.Unmarshal([]byte(jsonStr), &settings); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	if !settings.Tools.DisableLLMCorrection {
		t.Error("Expected DisableLLMCorrection to be true")
	}
}

func TestSkillsSettings_JSONAndNormalize(t *testing.T) {
	jsonStr := `{
		"skills": {
			"config": [
				{"name": "debug", "enabled": false, "visibility": "off"},
				{"content_path": "/repo/.ricochet/skills/debug/SKILL.md", "enabled": true, "visibility": "user-invocable-only"},
				{"name": "bad", "visibility": "invalid"}
			]
		},
		"theme": "dark"
	}`
	var settings Settings
	if err := json.Unmarshal([]byte(jsonStr), &settings); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}
	normalizeSettings(&settings)

	if len(settings.Skills.Config) != 3 {
		t.Fatalf("expected 3 skill config entries, got %d", len(settings.Skills.Config))
	}
	if settings.Skills.Config[0].Enabled == nil || *settings.Skills.Config[0].Enabled {
		t.Fatalf("expected debug skill to be disabled")
	}
	if settings.Skills.Config[1].Visibility != "user-invocable-only" {
		t.Fatalf("expected visibility to persist, got %q", settings.Skills.Config[1].Visibility)
	}
	if settings.Skills.Config[2].Visibility != "" {
		t.Fatalf("expected invalid visibility to normalize away")
	}
}
