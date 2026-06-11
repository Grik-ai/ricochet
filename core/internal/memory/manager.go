package memory

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/paths"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

var secretLikePattern = regexp.MustCompile(`(?i)(api[_-]?key|secret|token|password|passwd|bearer\s+[a-z0-9._\-]{16,}|sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|glpat-[a-z0-9_\-]{20,})`)

// MemoryItem represents a single fact or memory
type MemoryItem struct {
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	Timestamp time.Time `json:"timestamp"`
}

// MemoryStore is the on-disk format
type MemoryStore struct {
	Memories map[string]MemoryItem `json:"memories"`
}

// Manager handles persistence of memories
type Manager struct {
	cwd      string
	filePath string
	store    *MemoryStore
	mu       sync.RWMutex
}

func NewManager(cwd string) (*Manager, error) {
	configDir := filepath.Join(paths.GetGlobalDir(), "memory", paths.GetWorkspaceHash(cwd))
	if strings.EqualFold(os.Getenv("RICOCHET_PROJECT_MEMORY"), "1") ||
		strings.EqualFold(os.Getenv("RICOCHET_PROJECT_MEMORY"), "true") {
		configDir = filepath.Join(cwd, ".ricochet")
	}
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create config dir: %w", err)
	}

	filePath := filepath.Join(configDir, "memory.json")

	mgr := &Manager{
		cwd:      cwd,
		filePath: filePath,
		store: &MemoryStore{
			Memories: make(map[string]MemoryItem),
		},
	}

	// Load existing if available
	if err := mgr.load(); err != nil {
		// Log warning but allow empty start?
		// If file doesn't exist, it's fine.
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("failed to load memory: %w", err)
		}
	}

	return mgr, nil
}

func (m *Manager) load() error {
	data, err := os.ReadFile(m.filePath)
	if err != nil {
		return err
	}

	if err := json.Unmarshal(data, &m.store); err != nil {
		return err
	}

	if m.store.Memories == nil {
		m.store.Memories = make(map[string]MemoryItem)
	}

	return nil
}

func (m *Manager) save() error {
	data, err := json.MarshalIndent(m.store, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(m.filePath, data, 0644)
}

// Set stores a memory
func (m *Manager) Set(key, value string) error {
	if LooksLikeSecret(key) || LooksLikeSecret(value) {
		return fmt.Errorf("refusing to store secret-looking memory")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	m.store.Memories[key] = MemoryItem{
		Key:       key,
		Value:     value,
		Timestamp: time.Now(),
	}

	return m.save()
}

func LooksLikeSecret(value string) bool {
	return secretLikePattern.MatchString(value)
}

// Get retrieves a memory exact match
func (m *Manager) Get(key string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	item, ok := m.store.Memories[key]
	if !ok {
		return "", false
	}
	return item.Value, true
}

// Search performs a simple fuzzy search (contains) on keys and values
func (m *Manager) Search(query string, limit int) []MemoryItem {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var results []MemoryItem
	query = strings.ToLower(query)

	for _, item := range m.store.Memories {
		if strings.Contains(strings.ToLower(item.Key), query) ||
			strings.Contains(strings.ToLower(item.Value), query) {
			results = append(results, item)
		}
	}

	// Sort by timestamp desc? Or limit?
	// For MVP, just return slice
	if len(results) > limit && limit > 0 {
		return results[:limit]
	}

	return results
}

func (m *Manager) SearchResults(scope, query string, limit int) []protocol.MemorySearchResult {
	items := m.Search(query, limit)
	results := make([]protocol.MemorySearchResult, 0, len(items))
	queryLower := strings.ToLower(strings.TrimSpace(query))
	for _, item := range items {
		snippet := item.Value
		if len(snippet) > 800 {
			snippet = snippet[:800] + "..."
		}
		score := 0.5
		if queryLower != "" {
			keyLower := strings.ToLower(item.Key)
			valueLower := strings.ToLower(item.Value)
			if strings.Contains(keyLower, queryLower) {
				score += 0.35
			}
			if strings.Contains(valueLower, queryLower) {
				score += 0.15
			}
		}
		results = append(results, protocol.MemorySearchResult{
			Scope:     scope,
			Key:       item.Key,
			Path:      m.filePath,
			Snippet:   snippet,
			Score:     score,
			Source:    "memory.json",
			Timestamp: item.Timestamp.UnixMilli(),
		})
	}
	return results
}

// Clear wipes all memories
func (m *Manager) Clear() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.store.Memories = make(map[string]MemoryItem)
	return m.save()
}

// AddLegacy stores a raw string (for compatibility or notes)
func (m *Manager) AddLegacy(content string) error {
	key := fmt.Sprintf("note_%d", time.Now().Unix())
	return m.Set(key, content)
}

// SetRaw allows saving raw content (for ScanProject)
func (m *Manager) SetRaw(key, value string) error {
	return m.Set(key, value)
}

// GetAll returns all memories (for system prompt injection)
func (m *Manager) GetAll() []MemoryItem {
	m.mu.RLock()
	defer m.mu.RUnlock()

	items := make([]MemoryItem, 0, len(m.store.Memories))
	for _, item := range m.store.Memories {
		items = append(items, item)
	}
	return items
}

// GetSystemPromptPart generates the memory context string
func (m *Manager) GetSystemPromptPart() string {
	items := m.GetAll()
	if len(items) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("\n\n### 🧠 Permanent Memory (Project Facts)\n")
	sb.WriteString("Retrieved from Ricochet workspace memory storage:\n")

	// Limit to top 20 recent? Or just all for now.
	// 50 items max to avoid polluting context too much.
	count := 0
	for _, item := range items {
		if count >= 30 {
			sb.WriteString("... (more memories hidden)\n")
			break
		}
		sb.WriteString(fmt.Sprintf("- **%s**: %s\n", item.Key, item.Value))
		count++
	}

	return sb.String()
}
