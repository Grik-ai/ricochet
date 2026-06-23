package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/paths"
)

// State represents the persisted application state
type State struct {
	ActiveSessions        map[int64]string          `json:"active_sessions"`
	DiscordActiveSessions map[string]string         `json:"discord_active_sessions"`
	SessionBindings       map[string]SessionBinding `json:"session_bindings,omitempty"`
	PrimaryChatID         int64                     `json:"primary_chat_id"`
	LastSeen              map[string]time.Time      `json:"last_seen"`
}

// MessengerTarget identifies a concrete messenger endpoint.
type MessengerTarget struct {
	Platform  string `json:"platform"`
	ChatID    int64  `json:"chat_id,omitempty"`
	GuildID   string `json:"guild_id,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	ThreadID  string `json:"thread_id,omitempty"`
	UserID    string `json:"user_id,omitempty"`
}

// Key returns a stable key for routing a messenger endpoint to a session.
func (t MessengerTarget) Key() string {
	switch t.Platform {
	case "telegram":
		if t.ChatID != 0 {
			return "telegram:chat:" + strconv.FormatInt(t.ChatID, 10)
		}
	case "discord":
		if t.GuildID != "" {
			if t.ThreadID != "" {
				return "discord:guild:" + t.GuildID + ":channel:" + t.ChannelID + ":thread:" + t.ThreadID
			}
			if t.ChannelID != "" {
				return "discord:guild:" + t.GuildID + ":channel:" + t.ChannelID
			}
		}
		if t.ChannelID != "" {
			return "discord:channel:" + t.ChannelID
		}
		if t.UserID != "" {
			return "discord:dm:" + t.UserID
		}
	}
	return ""
}

// SessionBinding stores the active Ricochet session for a messenger endpoint.
type SessionBinding struct {
	Target    MessengerTarget `json:"target"`
	SessionID string          `json:"session_id"`
	Mode      string          `json:"mode,omitempty"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// Manager handles state persistence
type Manager struct {
	path string
	mu   sync.Mutex
	data State
}

// NewManager creates a new state manager
func NewManager() (*Manager, error) {
	dir := paths.GetGlobalDir()
	if err := paths.EnsureDir(dir); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "state.json")
	m := &Manager{
		path: path,
		data: State{
			ActiveSessions:        make(map[int64]string),
			DiscordActiveSessions: make(map[string]string),
			SessionBindings:       make(map[string]SessionBinding),
			LastSeen:              make(map[string]time.Time),
		},
	}

	// Try to load existing state
	if err := m.Load(); err != nil {
		// Ignore error if file doesn't exist
		if !os.IsNotExist(err) {
			return nil, err
		}
	}

	return m, nil
}

// Load reads state from file
func (m *Manager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, err := os.ReadFile(m.path)
	if err != nil {
		return err
	}

	err = json.Unmarshal(data, &m.data)
	if err != nil {
		return err
	}

	if m.data.ActiveSessions == nil {
		m.data.ActiveSessions = make(map[int64]string)
	}
	if m.data.DiscordActiveSessions == nil {
		m.data.DiscordActiveSessions = make(map[string]string)
	}
	if m.data.SessionBindings == nil {
		m.data.SessionBindings = make(map[string]SessionBinding)
	}
	if m.data.LastSeen == nil {
		m.data.LastSeen = make(map[string]time.Time)
	}
	m.migrateLegacyBindingsLocked()
	return nil
}

func (m *Manager) migrateLegacyBindingsLocked() {
	if m.data.SessionBindings == nil {
		m.data.SessionBindings = make(map[string]SessionBinding)
	}
	for chatID, sessionID := range m.data.ActiveSessions {
		target := MessengerTarget{Platform: "telegram", ChatID: chatID}
		key := target.Key()
		if key == "" {
			continue
		}
		if _, ok := m.data.SessionBindings[key]; !ok {
			m.data.SessionBindings[key] = SessionBinding{
				Target:    target,
				SessionID: sessionID,
				Mode:      "legacy",
				UpdatedAt: time.Now(),
			}
		}
	}
	for channelID, sessionID := range m.data.DiscordActiveSessions {
		target := MessengerTarget{Platform: "discord", ChannelID: channelID}
		key := target.Key()
		if key == "" {
			continue
		}
		if _, ok := m.data.SessionBindings[key]; !ok {
			m.data.SessionBindings[key] = SessionBinding{
				Target:    target,
				SessionID: sessionID,
				Mode:      "legacy",
				UpdatedAt: time.Now(),
			}
		}
	}
}

// Save writes state to file
func (m *Manager) Save() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, err := json.MarshalIndent(m.data, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(m.path, data, 0644)
}

// GetActiveSessions returns the active sessions map
func (m *Manager) GetActiveSessions() map[int64]string {
	m.mu.Lock()
	defer m.mu.Unlock()

	copy := make(map[int64]string)
	for k, v := range m.data.ActiveSessions {
		copy[k] = v
	}
	return copy
}

// SetActiveSession updates an active session
func (m *Manager) SetActiveSession(chatID int64, sessionID string) error {
	m.mu.Lock()
	m.data.ActiveSessions[chatID] = sessionID
	m.mu.Unlock()
	return m.Save()
}

// GetDiscordActiveSessions returns the active Discord sessions map
func (m *Manager) GetDiscordActiveSessions() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()

	copy := make(map[string]string)
	for k, v := range m.data.DiscordActiveSessions {
		copy[k] = v
	}
	return copy
}

// SetDiscordActiveSession updates an active Discord session
func (m *Manager) SetDiscordActiveSession(channelID string, sessionID string) error {
	m.mu.Lock()
	m.data.DiscordActiveSessions[channelID] = sessionID
	target := MessengerTarget{Platform: "discord", ChannelID: channelID}
	if key := target.Key(); key != "" {
		m.data.SessionBindings[key] = SessionBinding{
			Target:    target,
			SessionID: sessionID,
			Mode:      "legacy",
			UpdatedAt: time.Now(),
		}
	}
	m.mu.Unlock()
	return m.Save()
}

// GetSessionBindings returns a copy of endpoint session bindings.
func (m *Manager) GetSessionBindings() map[string]SessionBinding {
	m.mu.Lock()
	defer m.mu.Unlock()

	copy := make(map[string]SessionBinding)
	for k, v := range m.data.SessionBindings {
		copy[k] = v
	}
	return copy
}

// SetSessionBinding updates the active session for a messenger endpoint.
func (m *Manager) SetSessionBinding(target MessengerTarget, sessionID, mode string) error {
	key := target.Key()
	if key == "" {
		return nil
	}
	m.mu.Lock()
	if m.data.SessionBindings == nil {
		m.data.SessionBindings = make(map[string]SessionBinding)
	}
	m.data.SessionBindings[key] = SessionBinding{
		Target:    target,
		SessionID: sessionID,
		Mode:      mode,
		UpdatedAt: time.Now(),
	}
	if target.Platform == "telegram" && target.ChatID != 0 {
		m.data.ActiveSessions[target.ChatID] = sessionID
	}
	if target.Platform == "discord" && target.ChannelID != "" {
		m.data.DiscordActiveSessions[target.ChannelID] = sessionID
	}
	m.mu.Unlock()
	return m.Save()
}

// GetSessionForTarget returns the active session for a messenger endpoint.
func (m *Manager) GetSessionForTarget(target MessengerTarget) string {
	key := target.Key()
	if key == "" {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if binding, ok := m.data.SessionBindings[key]; ok {
		return binding.SessionID
	}
	if target.Platform == "telegram" && target.ChatID != 0 {
		return m.data.ActiveSessions[target.ChatID]
	}
	if target.Platform == "discord" && target.ChannelID != "" {
		return m.data.DiscordActiveSessions[target.ChannelID]
	}
	return ""
}

// GetPrimaryChatID returns the stored primary chat ID
func (m *Manager) GetPrimaryChatID() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.data.PrimaryChatID
}

// SetPrimaryChatID updates the stored primary chat ID
func (m *Manager) SetPrimaryChatID(chatID int64) error {
	m.mu.Lock()
	m.data.PrimaryChatID = chatID
	m.mu.Unlock()
	return m.Save()
}

// UpdateHeartbeat marks a session as alive
func (m *Manager) UpdateHeartbeat(sessionID string) error {
	m.mu.Lock()
	if m.data.LastSeen == nil {
		m.data.LastSeen = make(map[string]time.Time)
	}
	m.data.LastSeen[sessionID] = time.Now()
	m.mu.Unlock()
	return m.Save()
}

// IsSessionActive checks if the session has been seen recently
func (m *Manager) IsSessionActive(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	last, ok := m.data.LastSeen[sessionID]
	if !ok {
		return false
	}
	// Active if seen in last 5 minutes
	return time.Since(last) < 5*time.Minute
}

// GetLastSeen returns a copy of the last seen timestamps
func (m *Manager) GetLastSeen() map[string]time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()

	copy := make(map[string]time.Time)
	for k, v := range m.data.LastSeen {
		copy[k] = v
	}
	return copy
}
