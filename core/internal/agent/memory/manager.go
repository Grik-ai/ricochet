package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/igoryan-dao/ricochet/internal/paths"
)

// Learning represents a single piece of persistent knowledge
type Learning struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	Source    string `json:"source"`
	Timestamp int64  `json:"timestamp"`
}

// Manager handles the persistent "memory" of the agent across sessions
type Manager struct {
	mu         sync.RWMutex
	storageDir string
	learnings  map[string]Learning
	indexer    *Indexer // Sprint 5.0: RAG
	memDir     *MemDir  // Phase 2: Transparent memory
}

func NewManager(cwd string) *Manager {
	storageDir := filepath.Join(paths.GetGlobalDir(), "agent-memory", paths.GetWorkspaceHash(cwd))
	if strings.EqualFold(os.Getenv("RICOCHET_PROJECT_MEMORY"), "1") ||
		strings.EqualFold(os.Getenv("RICOCHET_PROJECT_MEMORY"), "true") {
		storageDir = filepath.Join(cwd, ".ricochet", "memory")
	}
	if err := os.MkdirAll(storageDir, 0755); err != nil {
		log.Printf("[Memory] Warning: failed to create storage: %v", err)
	}

	m := &Manager{
		storageDir: storageDir,
		learnings:  make(map[string]Learning),
		memDir:     NewMemDir(cwd),
	}
	m.load()
	return m
}

// SetIndexer attaches a vector indexer to the memory manager
func (m *Manager) SetIndexer(idx *Indexer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.indexer = idx
}

func (m *Manager) load() {
	m.mu.Lock()
	defer m.mu.Unlock()

	files, err := os.ReadDir(m.storageDir)
	if err != nil {
		return
	}

	for _, f := range files {
		if filepath.Ext(f.Name()) == ".json" {
			data, err := os.ReadFile(filepath.Join(m.storageDir, f.Name()))
			if err != nil {
				continue
			}
			var l Learning
			if err := json.Unmarshal(data, &l); err == nil {
				m.learnings[l.Key] = l
			}
		}
	}
}

func (m *Manager) Store(learning Learning) error {
	m.mu.Lock()
	m.learnings[learning.Key] = learning
	m.mu.Unlock()

	// 1. Persistence (JSON)
	data, _ := json.MarshalIndent(learning, "", "  ")
	path := filepath.Join(m.storageDir, learning.Key+".json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		return err
	}

	// 2. Indexing (RAG - Sprint 5.0)
	m.mu.RLock()
	idx := m.indexer
	m.mu.RUnlock()

	if idx != nil {
		// Use background context for indexing to not block standard storage
		go func() {
			if err := idx.IndexLearning(context.Background(), learning); err != nil {
				log.Printf("[Memory] Warning: Failed to index learning: %v", err)
			}
		}()
	}

	return nil
}

func (m *Manager) GetSystemPromptPart() string {
	return m.GetRelevantSystemPromptPart(context.Background(), "")
}

// GetRelevantSystemPromptPart performs RAG to find relevant lessons for a query
func (m *Manager) GetRelevantSystemPromptPart(ctx context.Context, query string) string {
	m.mu.RLock()
	idx := m.indexer
	allLearnings := m.learnings
	m.mu.RUnlock()

	var selected []Learning

	if idx != nil && query != "" {
		// Attempt semantic search
		topK, err := idx.SearchRelevant(ctx, query, 5) // Get top 5 relevant lessons
		if err == nil && len(topK) > 0 {
			selected = topK
			log.Printf("[Memory] RAG: Retrieved %d relevant lessons for query: %s", len(selected), query)
		}
	}

	// FALLBACK: If no indexer or query is empty, return all (Legacy mode or initialization)
	// Or if RAG found nothing but we have few lessons, just show them all.
	if len(selected) == 0 {
		if len(allLearnings) > 10 {
			// Don't inject more than 10 lessons into system prompt in generic mode
			// Real RAG should have handled large memory by now.
			return ""
		}
		for _, l := range allLearnings {
			selected = append(selected, l)
		}
	}

	if len(selected) == 0 {
		return ""
	}

	var contextStr string
	contextStr += "\n\n### 🧠 PERSISTENT MEMORY (Context-Relevant Lessons)\n"
	contextStr += "You have learned the following about this project from previous interactions:\n"
	for _, l := range selected {
		contextStr += fmt.Sprintf("- [%s]: %s\n", l.Key, l.Value)
	}

	// Append Transparent Memory Index (Bortovoy)
	if m.memDir != nil {
		contextStr += m.memDir.GetPromptSection()
	}

	return contextStr
}
