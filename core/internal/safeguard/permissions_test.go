package safeguard

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestPermissionStoreDecision(t *testing.T) {
	store, err := NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}

	if err := store.AddRule(PermissionRule{
		Tool:    "execute_command",
		Path:    "git status --short",
		Action:  "allow",
		Scope:   ScopeProject,
		Project: "/repo",
	}); err != nil {
		t.Fatalf("AddRule allow: %v", err)
	}
	if err := store.AddRule(PermissionRule{
		Tool:    "execute_command",
		Path:    "git status --short",
		Action:  "deny",
		Scope:   ScopeProject,
		Project: "/repo",
	}); err != nil {
		t.Fatalf("AddRule deny: %v", err)
	}

	decision := store.Decide(PermissionCheck{
		Tool:    "execute_command",
		Target:  "git status --short",
		Project: "/repo",
	})
	if decision != PermissionDeny {
		t.Fatalf("deny should take precedence, got %s", decision)
	}

	otherProject := store.Decide(PermissionCheck{
		Tool:    "execute_command",
		Target:  "git status --short",
		Project: "/other",
	})
	if otherProject != PermissionUnknown {
		t.Fatalf("project-scoped rule leaked to another project: %s", otherProject)
	}
}

func TestPermissionStoreSessionScope(t *testing.T) {
	store, err := NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}

	if err := store.AddRule(PermissionRule{
		Tool:      "write_file",
		Path:      "README.md",
		Action:    "allow",
		Scope:     ScopeSession,
		SessionID: "session-1",
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}

	if got := store.Decide(PermissionCheck{Tool: "write_file", Target: "README.md", SessionID: "session-1"}); got != PermissionAllow {
		t.Fatalf("expected session allow, got %s", got)
	}
	if got := store.Decide(PermissionCheck{Tool: "write_file", Target: "README.md", SessionID: "session-2"}); got != PermissionUnknown {
		t.Fatalf("session rule leaked, got %s", got)
	}
}

func TestPermissionStoreCommandPrefixAndAuditLimit(t *testing.T) {
	store, err := NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}

	if err := store.AddRule(PermissionRule{
		Tool:          "execute_command",
		CommandPrefix: "git status",
		Action:        "allow",
		Scope:         ScopeGlobal,
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}
	if got := store.Decide(PermissionCheck{Tool: "execute_command", Target: "git status --short"}); got != PermissionAllow {
		t.Fatalf("expected command prefix allow, got %s", got)
	}

	for i := 0; i < 510; i++ {
		if err := store.AppendAudit(PermissionAuditEntry{
			Tool:     "execute_command",
			Decision: "allow",
			Source:   "test",
			Reason:   fmt.Sprintf("entry-%d", i),
		}); err != nil {
			t.Fatalf("AppendAudit: %v", err)
		}
	}
	if got := len(store.permissions.Audit); got != 500 {
		t.Fatalf("expected audit log trimmed to 500 entries, got %d", got)
	}
	if store.permissions.Audit[0].Reason != "entry-10" {
		t.Fatalf("expected oldest retained audit entry to be entry-10, got %q", store.permissions.Audit[0].Reason)
	}
}

func TestPermissionStoreRemoveRule(t *testing.T) {
	store, err := NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}

	if err := store.AddRule(PermissionRule{
		Tool:   "execute_command",
		Path:   "git status --short",
		Action: "allow",
		Scope:  ScopeGlobal,
	}); err != nil {
		t.Fatalf("AddRule: %v", err)
	}

	rules := store.ListRules()
	if len(rules) != 1 {
		t.Fatalf("expected 1 rule, got %d", len(rules))
	}
	if rules[0].ID == "" {
		t.Fatal("expected generated rule id")
	}

	if err := store.RemoveRule(rules[0].ID); err != nil {
		t.Fatalf("RemoveRule: %v", err)
	}
	if got := store.Decide(PermissionCheck{Tool: "execute_command", Target: "git status --short"}); got != PermissionUnknown {
		t.Fatalf("expected rule to be removed, got %s", got)
	}
}

func TestPermissionStoreClearAudit(t *testing.T) {
	store, err := NewPermissionStoreAt(t.TempDir())
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}
	if err := store.AppendAudit(PermissionAuditEntry{Tool: "execute_command", Decision: "allow", Source: "test"}); err != nil {
		t.Fatalf("AppendAudit: %v", err)
	}
	if err := store.ClearAudit(); err != nil {
		t.Fatalf("ClearAudit: %v", err)
	}
	if got := len(store.ListAudit()); got != 0 {
		t.Fatalf("expected empty audit log, got %d", got)
	}
}

func TestPermissionStorePrivateFileModeAndRiskyPrefix(t *testing.T) {
	dir := t.TempDir()
	store, err := NewPermissionStoreAt(dir)
	if err != nil {
		t.Fatalf("NewPermissionStoreAt: %v", err)
	}
	if err := store.AddRule(PermissionRule{
		Tool:          "execute_command",
		CommandPrefix: "bash",
		Action:        "allow",
		Scope:         ScopeGlobal,
	}); err == nil {
		t.Fatalf("expected broad shell prefix to be rejected")
	}
	if err := store.AddRule(PermissionRule{
		Tool:          "execute_command",
		CommandPrefix: "git status",
		Action:        "allow",
		Scope:         ScopeGlobal,
	}); err != nil {
		t.Fatalf("specific git status prefix should be allowed: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "permissions.json"))
	if err != nil {
		t.Fatalf("stat permissions file: %v", err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("permissions file mode = %o, want 0600", got)
	}
}
