package context

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Tracker defines interface for context providers
type Tracker interface {
	GetContext() string
}

// EnvironmentTracker tracks system environment
type EnvironmentTracker struct {
	cwd string
}

// NewEnvironmentTracker creates a new environment tracker
func NewEnvironmentTracker(cwd string) *EnvironmentTracker {
	return &EnvironmentTracker{cwd: cwd}
}

// GetCwd returns the tracked current working directory
func (e *EnvironmentTracker) GetCwd() string {
	return e.cwd
}

func (e *EnvironmentTracker) GetContext() string {
	var sb strings.Builder
	sb.WriteString("## Environment Context\n")
	sb.WriteString(fmt.Sprintf("- OS: %s\n", runtime.GOOS))
	sb.WriteString(fmt.Sprintf("- CWD: %s\n", e.cwd))

	// Project type detection
	if _, err := os.Stat(filepath.Join(e.cwd, "go.mod")); err == nil {
		sb.WriteString("- Project Type: Go\n")
	} else if _, err := os.Stat(filepath.Join(e.cwd, "package.json")); err == nil {
		sb.WriteString("- Project Type: Node.js/JavaScript\n")
	} else if _, err := os.Stat(filepath.Join(e.cwd, "Cargo.toml")); err == nil {
		sb.WriteString("- Project Type: Rust\n")
	} else if _, err := os.Stat(filepath.Join(e.cwd, "requirements.txt")); err == nil {
		sb.WriteString("- Project Type: Python\n")
	}

	sb.WriteString(fmt.Sprintf("- Time: %s\n", time.Now().Format(time.RFC1123)))

	return sb.String()
}

// FileTracker tracks files relevant to the session
type FileTracker struct {
	mu            sync.RWMutex
	accessedFiles map[string]time.Time
}

// NewFileTracker creates a new file tracker
func NewFileTracker() *FileTracker {
	return &FileTracker{
		accessedFiles: make(map[string]time.Time),
	}
}

// AddFile marks a file as accessed
func (f *FileTracker) AddFile(path string) {
	if path == "" {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.accessedFiles[path] = time.Now()
}

// GetContext returns the list of recently accessed files
func (f *FileTracker) GetContext() string {
	f.mu.RLock()
	defer f.mu.RUnlock()

	if len(f.accessedFiles) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("## Accessed Files\n")
	for path := range f.accessedFiles {
		sb.WriteString(fmt.Sprintf("- %s\n", path))
	}
	return sb.String()
}

// GetFiles returns the list of accessed files as a slice
func (f *FileTracker) GetFiles() []string {
	f.mu.RLock()
	defer f.mu.RUnlock()

	var files []string
	for path := range f.accessedFiles {
		files = append(files, path)
	}
	return files
}

// GetRecentFiles returns accessed files sorted by most recent first.
func (f *FileTracker) GetRecentFiles(limit int) []string {
	f.mu.RLock()
	defer f.mu.RUnlock()

	type fileAccess struct {
		path string
		at   time.Time
	}
	items := make([]fileAccess, 0, len(f.accessedFiles))
	for path, at := range f.accessedFiles {
		items = append(items, fileAccess{path: path, at: at})
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].at.After(items[j].at)
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	files := make([]string, 0, len(items))
	for _, item := range items {
		files = append(files, item.path)
	}
	return files
}

// HasRead checks if a file has been read in this session
func (f *FileTracker) HasRead(path string) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()

	// Handle relative/absolute paths
	// In practice we should normalize them, but for now we check as is
	_, exists := f.accessedFiles[path]
	return exists
}
