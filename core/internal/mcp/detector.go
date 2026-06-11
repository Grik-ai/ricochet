package mcp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// Detect recommends extensions based on the current workspace.
func Detect(cwd string, mgr *Manager) ([]RegistryServer, error) {
	reg := NewRegistry("")
	registry, err := reg.FetchServers(context.Background())
	if err != nil {
		// Log warning but fallback to built-in? LoadRegistry handles fallback internally.
		// If error is strictly remote fetch failure, LoadRegistry returns built-in.
		// If error is something else, we might fail or just log.
		// For now return err.
		// But LoadRegistry signature returns ([]Item, error).
		// Let's assume it handled fallbacks.
		return nil, err
	}
	installed, err := mgr.ListServers()
	if err != nil {
		return nil, err
	}

	var recommendations []RegistryServer

	// Helper to check if file exists
	fileExists := func(pattern string) bool {
		matches, _ := filepath.Glob(filepath.Join(cwd, pattern))
		return len(matches) > 0
	}

	// Helper to walk and check extensions - simplified for MVP.
	// We'll just check root directory or use Glob.
	// For deeper scan, we might need filepath.Walk but let's look at root + 1 level
	// or specific known files.

	repoFiles, _ := os.ReadDir(cwd)
	var fileNames []string
	for _, f := range repoFiles {
		fileNames = append(fileNames, f.Name())
	}

	for _, item := range registry {
		// 1. Check if already installed
		if _, exists := installed[item.Name]; exists {
			continue
		}

		matched := false

		// 2. Check Trigger Files
		for _, trigger := range item.TriggerFiles {
			// Special case: "*" matches everything
			if trigger == "*" {
				matched = true
				break
			}
			if fileExists(trigger) {
				matched = true
				break
			}
		}

		// 3. Check Trigger Extensions
		if !matched && len(item.TriggerExts) > 0 {
			for _, fName := range fileNames {
				ext := filepath.Ext(fName)
				for _, trExt := range item.TriggerExts {
					if strings.EqualFold(ext, trExt) {
						matched = true
						break
					}
				}
				if matched {
					break
				}
			}
		}

		if matched {
			recommendations = append(recommendations, item)
		}
	}

	return recommendations, nil
}
