package skills

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindApplicableSkills(t *testing.T) {
	// Setup temporary directory with skills
	tmpDir, err := os.MkdirTemp("", "skills_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	// Create .agent/skills structure
	skillsDir := filepath.Join(tmpDir, ".agent", "skills")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Create skill-rules.json
	rulesJSON := `{
		"backend-skill": {
			"type": "domain",
			"enforcement": "suggest",
			"promptTriggers": {
				"keywords": ["controller", "service"],
				"intentPatterns": ["create.*endpoint"]
			},
			"fileTriggers": {
				"pathPatterns": ["**/*.go"]
			}
		},
		"frontend-skill": {
			"type": "domain",
			"enforcement": "suggest",
			"promptTriggers": {
				"keywords": ["react", "component"]
			},
			"fileTriggers": {
				"pathPatterns": ["**/*.tsx"]
			}
		}
	}`
	if err := os.WriteFile(filepath.Join(skillsDir, "skill-rules.json"), []byte(rulesJSON), 0644); err != nil {
		t.Fatal(err)
	}

	// Create dummy markdown files
	if err := os.WriteFile(filepath.Join(skillsDir, "backend-skill.md"), []byte("# Backend Rules"), 0644); err != nil {
		t.Fatal(err)
	}

	// Initialize Manager
	opt := NewManager(tmpDir)
	if err := opt.LoadSkills(); err != nil {
		t.Fatalf("LoadSkills failed: %v", err)
	}

	tests := []struct {
		name        string
		prompt      string
		activeFiles []string
		wantSkill   string
	}{
		{
			name:        "Keyword Trigger (backend)",
			prompt:      "I need to fix the auth controller",
			activeFiles: nil,
			wantSkill:   "backend-skill",
		},
		{
			name:        "Regex Trigger (backend)",
			prompt:      "Let's create a new user endpoint",
			activeFiles: nil,
			wantSkill:   "backend-skill",
		},
		{
			name:        "File Trigger (backend)",
			prompt:      "Fix this bug",
			activeFiles: []string{"/path/to/main.go"},
			wantSkill:   "backend-skill",
		},
		{
			name:        "Keyword Trigger (frontend)",
			prompt:      "Update the button component",
			activeFiles: nil,
			wantSkill:   "frontend-skill",
		},
		{
			name:        "No Match",
			prompt:      "Hello world",
			activeFiles: []string{"README.md"},
			wantSkill:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			skills := opt.FindApplicableSkills(tt.prompt, tt.activeFiles)

			if tt.wantSkill == "" {
				if len(skills) > 0 {
					t.Errorf("Expected no skills, got %d", len(skills))
				}
			} else {
				if len(skills) == 0 {
					t.Errorf("Expected skill %s, got none", tt.wantSkill)
					return
				}
				found := false
				for _, s := range skills {
					if s.Name == tt.wantSkill {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("Expected skill %s not found in results", tt.wantSkill)
				}
			}
		})
	}
}

func TestDynamicSkillManifestAndScope(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "skills_v2_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	skillsDir := filepath.Join(tmpDir, ".ricochet", "skills", "debug")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		t.Fatal(err)
	}
	skillBody := `---
name: debug
display_name: Debug Ricochet
description: Diagnose Ricochet
when_to_use: Use for logs and stuck sessions.
allowed_tools:
  - read_file
  - grep_search
context: fork
enabled: true
triggers:
  keywords:
    - debug
---
# Debug instructions
`
	if err := os.WriteFile(filepath.Join(skillsDir, "SKILL.md"), []byte(skillBody), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(tmpDir)
	if err := mgr.LoadSkills(); err != nil {
		t.Fatalf("LoadSkills failed: %v", err)
	}

	manifests := mgr.ListSkillManifests()
	var found bool
	for _, manifest := range manifests {
		if manifest.Name == "debug" {
			found = true
			if manifest.Context != "fork" {
				t.Fatalf("expected fork context, got %q", manifest.Context)
			}
			if manifest.WhenToUse == "" {
				t.Fatalf("expected when_to_use to be populated")
			}
			if len(manifest.AllowedTools) != 2 {
				t.Fatalf("expected allowed tools, got %#v", manifest.AllowedTools)
			}
		}
	}
	if !found {
		t.Fatalf("debug manifest not found")
	}

	if _, ok := mgr.ActivateSkillScope("s1", "debug"); !ok {
		t.Fatalf("expected skill scope to activate")
	}
	if ok, _ := mgr.ToolAllowedInActiveScope("s1", "read_file"); !ok {
		t.Fatalf("read_file should be allowed")
	}
	if ok, _ := mgr.ToolAllowedInActiveScope("s1", "write_file"); ok {
		t.Fatalf("write_file should be blocked by skill scope")
	}
}

func TestDisabledDynamicSkillIsNotApplicable(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "skills_disabled_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	skillsDir := filepath.Join(tmpDir, ".ricochet", "skills", "off")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		t.Fatal(err)
	}
	skillBody := `---
name: off
description: Disabled skill
enabled: false
triggers:
  keywords:
    - disabled-trigger
---
No-op.
`
	if err := os.WriteFile(filepath.Join(skillsDir, "SKILL.md"), []byte(skillBody), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(tmpDir)
	if err := mgr.LoadSkills(); err != nil {
		t.Fatalf("LoadSkills failed: %v", err)
	}
	if got := mgr.FindApplicableSkills("disabled-trigger", nil); len(got) != 0 {
		t.Fatalf("disabled skill should not be applicable: %#v", got)
	}
}

func TestMisplacedProjectMarkdownReturnsDiagnostic(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "skills_misplaced_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	skillsDir := filepath.Join(tmpDir, ".ricochet", "skills")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		t.Fatal(err)
	}
	misplacedPath := filepath.Join(skillsDir, "browser_automation.md")
	if err := os.WriteFile(misplacedPath, []byte("# Browser automation"), 0644); err != nil {
		t.Fatal(err)
	}

	mgr := NewManager(tmpDir)
	if err := mgr.LoadSkills(); err != nil {
		t.Fatalf("LoadSkills failed: %v", err)
	}

	var diagnosticFound bool
	for _, manifest := range mgr.ListSkillManifests() {
		if manifest.ContentPath == misplacedPath {
			diagnosticFound = true
			if manifest.LoadStatus != "warning" {
				t.Fatalf("expected warning load status, got %q", manifest.LoadStatus)
			}
			if len(manifest.ValidationErrors) == 0 {
				t.Fatalf("expected validation errors")
			}
			if manifest.Enabled {
				t.Fatalf("diagnostic should not be enabled")
			}
		}
	}
	if !diagnosticFound {
		t.Fatalf("expected misplaced markdown diagnostic")
	}
}

func TestSkillOverridesPersistByNameAndPathPrecedence(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "skills_override_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	skillsDir := filepath.Join(tmpDir, ".ricochet", "skills", "alpha")
	if err := os.MkdirAll(skillsDir, 0755); err != nil {
		t.Fatal(err)
	}
	skillPath := filepath.Join(skillsDir, "SKILL.md")
	skillBody := `---
name: alpha
description: Alpha skill
triggers:
  keywords:
    - alpha-trigger
---
Alpha.
`
	if err := os.WriteFile(skillPath, []byte(skillBody), 0644); err != nil {
		t.Fatal(err)
	}

	disabled := false
	enabled := true
	mgr := NewManager(tmpDir)
	if err := mgr.LoadSkillsWithOverrides([]SkillOverride{
		{Name: "alpha", Enabled: &disabled},
		{ContentPath: skillPath, Enabled: &enabled, Visibility: "on"},
	}); err != nil {
		t.Fatalf("LoadSkillsWithOverrides failed: %v", err)
	}
	if got := mgr.FindApplicableSkills("alpha-trigger", nil); len(got) != 1 || got[0].Name != "alpha" {
		t.Fatalf("path override should take precedence over name override: %#v", got)
	}

	if err := mgr.LoadSkillsWithOverrides([]SkillOverride{{Name: "alpha", Enabled: &disabled, Visibility: "off"}}); err != nil {
		t.Fatalf("LoadSkillsWithOverrides failed: %v", err)
	}
	if got := mgr.FindApplicableSkills("alpha-trigger", nil); len(got) != 0 {
		t.Fatalf("disabled override should suppress skill: %#v", got)
	}
}

func TestProjectSkillCreateDeleteAndRestrictions(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "skills_create_delete_test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	if err := os.WriteFile(filepath.Join(tmpDir, "RICOCHET.md"), []byte("Project rules"), 0644); err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(tmpDir)
	path, err := mgr.CreateProjectSkill("Browser Automation", "Automate browser workflows")
	if err != nil {
		t.Fatalf("CreateProjectSkill failed: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("created skill missing: %v", err)
	}
	if err := mgr.LoadSkills(); err != nil {
		t.Fatalf("LoadSkills failed: %v", err)
	}

	var foundProject bool
	var foundRootRule bool
	for _, manifest := range mgr.ListSkillManifests() {
		if manifest.Name == "browser-automation" {
			foundProject = true
			if !manifest.CanEdit || !manifest.CanDelete {
				t.Fatalf("project skill should be editable/deletable: %#v", manifest)
			}
		}
		if manifest.Type == "root_rule" {
			foundRootRule = true
			if manifest.CanEdit || manifest.CanDelete {
				t.Fatalf("root rule should not be editable/deletable: %#v", manifest)
			}
		}
	}
	if !foundProject {
		t.Fatalf("created project skill manifest not found")
	}
	if !foundRootRule {
		t.Fatalf("root rule manifest not found")
	}

	if err := mgr.DeleteProjectSkill("browser-automation", path); err != nil {
		t.Fatalf("DeleteProjectSkill failed: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected project skill to be deleted, got err=%v", err)
	}
	if err := mgr.DeleteProjectSkill("RICOCHET.md", filepath.Join(tmpDir, "RICOCHET.md")); err == nil {
		t.Fatalf("root rule deletion should be rejected")
	}
}
