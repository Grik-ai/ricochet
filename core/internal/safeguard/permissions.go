package safeguard

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type PermissionScope string

const (
	ScopeGlobal  PermissionScope = "global"
	ScopeProject PermissionScope = "project"
	ScopeSession PermissionScope = "session"

	ZoneDanger   TrustZone = 0 // "God Mode"
	ZoneSafe     TrustZone = 1 // Default
	ZoneReadOnly TrustZone = 2 // Analysis only
)

type TrustZone int

// ZoneConfig maps tools to their minimum required zone (Lower zone = Higher trust required)
var toolZoneMap = map[string]TrustZone{
	"execute_command": ZoneSafe,     // Safe (Protected by IsSafeCommand + ensureConsent)
	"write_file":      ZoneSafe,     // Safe (Project only)
	"execute_python":  ZoneSafe,     // Safe (Sandboxed - theoretically)
	"read_file":       ZoneReadOnly, // Read only
	"list_dir":        ZoneReadOnly,
	"codebase_search": ZoneReadOnly,
	"browser_open":    ZoneReadOnly,
}

type PermissionRule struct {
	ID            string          `json:"id,omitempty"`
	Tool          string          `json:"tool"`
	Path          string          `json:"path,omitempty"`           // Glob, prefix pattern, or exact target
	CommandPrefix string          `json:"command_prefix,omitempty"` // Prefix match for shell commands
	Action        string          `json:"action"`                   // "allow", "deny"
	Scope         PermissionScope `json:"scope"`
	Project       string          `json:"project,omitempty"`
	SessionID     string          `json:"session_id,omitempty"`
	ExpiresAt     int64           `json:"expires_at,omitempty"`
	CreatedAt     int64           `json:"created_at,omitempty"`
}

type Permissions struct {
	Rules []PermissionRule       `json:"rules"`
	Audit []PermissionAuditEntry `json:"audit,omitempty"`
}

type PermissionDecision string

const (
	PermissionAllow   PermissionDecision = "allow"
	PermissionDeny    PermissionDecision = "deny"
	PermissionUnknown PermissionDecision = "unknown"
)

type PermissionCheck struct {
	Tool      string
	Target    string
	Project   string
	SessionID string
}

type PermissionAuditEntry struct {
	Timestamp int64  `json:"timestamp"`
	Tool      string `json:"tool"`
	Target    string `json:"target,omitempty"`
	Project   string `json:"project,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Decision  string `json:"decision"`
	Source    string `json:"source"`
	Reason    string `json:"reason,omitempty"`
}

type PermissionStore struct {
	mu          sync.RWMutex
	path        string
	permissions *Permissions
}

// NewPermissionStore creates a store for persistent permissions
func NewPermissionStore() (*PermissionStore, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home dir: %w", err)
	}

	return NewPermissionStoreAt(filepath.Join(homeDir, ".ricochet"))
}

func NewPermissionStoreAt(configDir string) (*PermissionStore, error) {
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create config dir: %w", err)
	}

	store := &PermissionStore{
		path: filepath.Join(configDir, "permissions.json"),
		permissions: &Permissions{
			Rules: []PermissionRule{},
		},
	}

	if err := store.Load(); err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("failed to load permissions: %w", err)
		}
		// If file doesn't exist, save default
		if err := store.Save(); err != nil {
			return nil, fmt.Errorf("failed to save default permissions: %w", err)
		}
	}

	return store, nil
}

func (s *PermissionStore) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}

	var perms Permissions
	if err := json.Unmarshal(data, &perms); err != nil {
		return fmt.Errorf("failed to parse permissions.json: %w", err)
	}

	s.permissions = &perms
	changed := false
	for i := range s.permissions.Rules {
		if s.permissions.Rules[i].ID == "" {
			s.permissions.Rules[i].ID = uuid.New().String()
			changed = true
		}
	}
	if changed {
		return s.Save()
	}
	return nil
}

// Save writes permissions to disk. NOTE: Caller must hold lock if needed.
func (s *PermissionStore) Save() error {
	// Removed internal locking to prevent deadlock since AddRule calls this while holding Lock
	data, err := json.MarshalIndent(s.permissions, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal permissions: %w", err)
	}

	return atomicWriteFile(s.path, data, 0600)
}

func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func (s *PermissionStore) AddRule(rule PermissionRule) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if rule.Scope == "" {
		rule.Scope = ScopeProject
	}
	if rule.Action == "" {
		rule.Action = "allow"
	}
	if rule.CreatedAt == 0 {
		rule.CreatedAt = time.Now().Unix()
	}
	if rule.Action == string(PermissionAllow) && rule.Tool == "execute_command" && IsRiskyCommandApprovalPrefix(rule.CommandPrefix) {
		return fmt.Errorf("command prefix %q is too broad or unsafe to persist; approve a more specific command instead", rule.CommandPrefix)
	}
	for i, existing := range s.permissions.Rules {
		if samePermissionRule(existing, rule) {
			if rule.ID == "" {
				rule.ID = existing.ID
			}
			s.permissions.Rules[i] = rule
			return s.Save()
		}
	}
	if rule.ID == "" {
		rule.ID = uuid.New().String()
	}
	s.permissions.Rules = append(s.permissions.Rules, rule)
	return s.Save() // Auto-save
}

func (s *PermissionStore) RemoveRule(id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("permission rule id is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i, rule := range s.permissions.Rules {
		if rule.ID == id {
			s.permissions.Rules = append(s.permissions.Rules[:i], s.permissions.Rules[i+1:]...)
			return s.Save()
		}
	}
	return fmt.Errorf("permission rule %s not found", id)
}

func (s *PermissionStore) Decide(check PermissionCheck) PermissionDecision {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now().Unix()
	decision := PermissionUnknown
	for _, rule := range s.permissions.Rules {
		if !permissionRuleMatches(rule, check, now) {
			continue
		}
		if rule.Action == string(PermissionDeny) {
			return PermissionDeny
		}
		if rule.Action == string(PermissionAllow) {
			decision = PermissionAllow
		}
	}
	return decision
}

func (s *PermissionStore) IsAllowed(tool string, path string) bool {
	return s.Decide(PermissionCheck{Tool: tool, Target: path}) == PermissionAllow
}

func (s *PermissionStore) AppendAudit(entry PermissionAuditEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if entry.Timestamp == 0 {
		entry.Timestamp = time.Now().Unix()
	}
	s.permissions.Audit = append(s.permissions.Audit, entry)
	const maxAuditEntries = 500
	if len(s.permissions.Audit) > maxAuditEntries {
		s.permissions.Audit = s.permissions.Audit[len(s.permissions.Audit)-maxAuditEntries:]
	}
	return s.Save()
}

func (s *PermissionStore) ListRules() []PermissionRule {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rules := make([]PermissionRule, len(s.permissions.Rules))
	copy(rules, s.permissions.Rules)
	return rules
}

func (s *PermissionStore) ListAudit() []PermissionAuditEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	audit := make([]PermissionAuditEntry, len(s.permissions.Audit))
	copy(audit, s.permissions.Audit)
	return audit
}

func (s *PermissionStore) ClearAudit() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.permissions.Audit = nil
	return s.Save()
}

func samePermissionRule(a, b PermissionRule) bool {
	return a.Tool == b.Tool &&
		a.Path == b.Path &&
		a.CommandPrefix == b.CommandPrefix &&
		a.Scope == b.Scope &&
		a.Project == b.Project &&
		a.SessionID == b.SessionID
}

func permissionRuleMatches(rule PermissionRule, check PermissionCheck, now int64) bool {
	if rule.ExpiresAt > 0 && rule.ExpiresAt <= now {
		return false
	}
	if rule.Tool != "" && rule.Tool != "*" && rule.Tool != check.Tool {
		return false
	}
	switch rule.Scope {
	case ScopeProject:
		if rule.Project != "" && rule.Project != check.Project {
			return false
		}
	case ScopeSession:
		if rule.SessionID == "" || rule.SessionID != check.SessionID {
			return false
		}
	case ScopeGlobal, "":
	default:
		return false
	}
	if rule.CommandPrefix != "" {
		return strings.HasPrefix(check.Target, rule.CommandPrefix)
	}
	return targetMatches(rule.Path, check.Target)
}

func targetMatches(pattern, target string) bool {
	if pattern == "" || pattern == "*" {
		return true
	}
	if pattern == target {
		return true
	}
	if strings.HasSuffix(pattern, "*") && strings.HasPrefix(target, strings.TrimSuffix(pattern, "*")) {
		return true
	}
	if ok, _ := filepath.Match(pattern, target); ok {
		return true
	}
	if base := filepath.Base(target); base != target {
		if ok, _ := filepath.Match(pattern, base); ok {
			return true
		}
	}
	return false
}

// CheckZonePermission checks if a tool is allowed in the given zone
func CheckZonePermission(zone TrustZone, tool string) error {
	requiredZone, ok := toolZoneMap[tool]
	if !ok {
		// Unknown tools are treated as Dangerous by default?
		// Or Safe by default? Let's say Safe (1) if it's passive, but we don't know.
		// BETTER: Default to ZoneReadOnly (2) unless listed.
		// Actually, let's default to ZoneSafe for unknown tools to be permissive during dev,
		// but blocked in ReadOnly.
		requiredZone = ZoneSafe
	}

	// Zone 0 (Danger) < Zone 1 (Safe) < Zone 2 (ReadOnly)
	// User Zone must be <= Required Zone to be allowed.
	// Example: User=0 (Danger), Required=0 (Danger) -> OK
	// Example: User=1 (Safe), Required=0 (Danger) -> DENIED
	// Example: User=2 (ReadOnly), Required=1 (Safe) -> DENIED

	if zone > requiredZone {
		return fmt.Errorf("tool '%s' requires trust zone %d, but current zone is %d", tool, requiredZone, zone)
	}
	return nil
}
