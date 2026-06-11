package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// RegistryServer represents an MCP server in the official registry
type RegistryServer struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	Category        string   `json:"category"`
	Command         string   `json:"command"`
	Args            []string `json:"args"`
	EnvVars         []string `json:"envVars,omitempty"`
	LogoURL         string   `json:"logoUrl,omitempty"`
	GitHubURL       string   `json:"githubUrl,omitempty"`
	RequiresAPIKey  bool     `json:"requires_api_key,omitempty"`
	TriggerFiles    []string `json:"trigger_files,omitempty"`
	TriggerExts     []string `json:"trigger_exts,omitempty"`
	Tools           []string `json:"tools,omitempty"`
}

// RegistryResponse is the structure of the remote registry JSON
type RegistryResponse struct {
	Servers []RegistryServer `json:"servers"`
}

// Registry manages fetching and caching of official MCP servers
type Registry struct {
	officialURL string
	cachePath   string
	httpClient  *http.Client
	servers     []RegistryServer
	mu          sync.RWMutex
	lastSynced  time.Time
}

// NewRegistry creates a new MCP Registry service
func NewRegistry(configDir string) *Registry {
	cachePath := filepath.Join(configDir, "mcp_registry_cache.json")
	return &Registry{
		officialURL: "https://raw.githubusercontent.com/igoryan-dao/ricochet-registry/main/mcp-servers.json",
		cachePath:   cachePath,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// GetServers returns the current list of servers from memory/cache
func (r *Registry) GetServers() []RegistryServer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.servers
}

// LoadCache loads the registry from the local cache file
func (r *Registry) LoadCache() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	data, err := os.ReadFile(r.cachePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // No cache yet
		}
		return err
	}

	var servers []RegistryServer
	if err := json.Unmarshal(data, &servers); err != nil {
		return err
	}

	r.servers = servers
	if info, err := os.Stat(r.cachePath); err == nil {
		r.lastSynced = info.ModTime()
	}
	return nil
}

// Sync fetches the latest servers from the remote registry and updates the cache
func (r *Registry) Sync(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", r.officialURL, nil)
	if err != nil {
		return err
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to fetch registry: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("registry returned non-OK status: %s", resp.Status)
	}

	var registry RegistryResponse
	if err := json.NewDecoder(resp.Body).Decode(&registry); err != nil {
		return fmt.Errorf("failed to decode registry JSON: %w", err)
	}

	r.mu.Lock()
	r.servers = registry.Servers
	r.lastSynced = time.Now()
	r.mu.Unlock()

	// Save to cache
	data, err := json.MarshalIndent(r.servers, "", "  ")
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(r.cachePath), 0755); err != nil {
		return err
	}

	return os.WriteFile(r.cachePath, data, 0644)
}

func (r *Registry) GetLastSynced() time.Time {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.lastSynced
}

// FetchServers is a compatibility wrapper that loads the cache and syncs if empty.
func (r *Registry) FetchServers(ctx context.Context) ([]RegistryServer, error) {
	err := r.LoadCache()
	if err != nil {
		return nil, err
	}

	servers := r.GetServers()
	if len(servers) == 0 {
		err = r.Sync(ctx)
		if err != nil {
			return nil, err
		}
		servers = r.GetServers()
	}

	return servers, nil
}
