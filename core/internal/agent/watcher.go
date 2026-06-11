package agent

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/agent/hooks"
)

// FileWatcher monitors the workspace for external changes and triggers FileChanged hooks
type FileWatcher struct {
	cwd          string
	hooks        *hooks.DynamicHookManager
	pollInterval time.Duration
	lastModTimes map[string]time.Time
}

func NewFileWatcher(cwd string, h *hooks.DynamicHookManager) *FileWatcher {
	return &FileWatcher{
		cwd:          cwd,
		hooks:        h,
		pollInterval: 2 * time.Second,
		lastModTimes: make(map[string]time.Time),
	}
}

func (w *FileWatcher) Start(ctx context.Context) {
	log.Printf("[Watcher] Starting workspace monitor (poll: %v)", w.pollInterval)
	ticker := time.NewTicker(w.pollInterval)
	defer ticker.Stop()

	// Initial scan to establish baseline
	w.scan()

	for {
		select {
		case <-ticker.C:
			w.scan()
		case <-ctx.Done():
			return
		}
	}
}

func (w *FileWatcher) scan() {
	if w.hooks == nil {
		return
	}

	// We only watch files that match active FileChanged hooks to save resources
	allHooks := w.hooks.ListHooks()
	var watchPatterns []string
	for _, h := range allHooks {
		if h.Event == hooks.EventFileChanged && h.Enabled {
			if h.Pattern != "" {
				watchPatterns = append(watchPatterns, h.Pattern)
			}
		}
	}

	if len(watchPatterns) == 0 {
		return
	}

	// For simple polling, we walk the tree up to a limited depth
	filepath.Walk(w.cwd, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}

		rel, _ := filepath.Rel(w.cwd, path)

		// Skip hidden
		if strings.HasPrefix(info.Name(), ".") && info.Name() != "." {
			return nil
		}

		// Check if matches any pattern
		matched := false
		for _, p := range watchPatterns {
			if m, _ := filepath.Match(p, info.Name()); m {
				matched = true
				break
			}
		}

		if matched {
			lastMod, exists := w.lastModTimes[rel]
			if exists && info.ModTime().After(lastMod) {
				log.Printf("[Watcher] Detected external change: %s", rel)
				// Trigger Hook
				args := map[string]interface{}{
					"file_path": rel,
					"abs_path":  path,
					"event":     hooks.EventFileChanged,
				}
				go w.hooks.TriggerHooks(context.Background(), hooks.EventFileChanged, args)
			}
			w.lastModTimes[rel] = info.ModTime()
		}

		return nil
	})
}
