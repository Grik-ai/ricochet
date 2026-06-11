package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// ScratchpadManager handles cross-agent knowledge persistence using the filesystem.
// This allows sub-agents to share discoveries without clogging the chat context.
type ScratchpadManager struct {
	rootDir string
	mu      sync.RWMutex
}

// NewScratchpadManager creates a manager for the .ricochet/scratchpad directory
func NewScratchpadManager(projectRoot string) (*ScratchpadManager, error) {
	path := filepath.Join(projectRoot, ".ricochet", "scratchpad")
	if err := os.MkdirAll(path, 0755); err != nil {
		return nil, fmt.Errorf("failed to create scratchpad dir: %w", err)
	}
	return &ScratchpadManager{rootDir: path}, nil
}

// WriteNote adds or updates a shared note
func (s *ScratchpadManager) WriteNote(name, content string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := filepath.Join(s.rootDir, name+".md")
	// Add timestamp to the note
	header := fmt.Sprintf("<!-- Last Updated: %s -->\n", time.Now().Format(time.RFC3339))
	return os.WriteFile(path, []byte(header+content), 0644)
}

// ReadNotes returns a map of all notes in the scratchpad
func (s *ScratchpadManager) ReadNotes() (map[string]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entries, err := os.ReadDir(s.rootDir)
	if err != nil {
		return nil, err
	}

	notes := make(map[string]string)
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".md" {
			path := filepath.Join(s.rootDir, entry.Name())
			content, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			notes[entry.Name()] = string(content)
		}
	}
	return notes, nil
}

// GetSummary returns a single string of all notes formatted for LLM context
func (s *ScratchpadManager) GetSummary() string {
	notes, err := s.ReadNotes()
	if err != nil || len(notes) == 0 {
		return "(No notes in scratchpad)"
	}

	// Sort keys for deterministic output
	keys := make([]string, 0, len(notes))
	for k := range notes {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var res string
	res += "=== SHARED SCRATCHPAD ===\n"
	for _, k := range keys {
		res += fmt.Sprintf("\n### %s\n%s\n", k, notes[k])
	}
	return res
}

// Cleanup removes all notes (usually at end of a big swarm session)
func (s *ScratchpadManager) Cleanup() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	d, err := os.Open(s.rootDir)
	if err != nil {
		return err
	}
	defer d.Close()

	names, err := d.Readdirnames(-1)
	if err != nil {
		return err
	}

	for _, name := range names {
		err = os.RemoveAll(filepath.Join(s.rootDir, name))
		if err != nil {
			return err
		}
	}
	return nil
}
