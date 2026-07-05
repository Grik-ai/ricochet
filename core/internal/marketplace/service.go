package marketplace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/mcp"
	"github.com/igoryan-dao/ricochet/internal/paths"
)

const defaultCatalogURL = "https://raw.githubusercontent.com/igoryan-dao/ricochet-registry/main/marketplace.json"

type ItemType string

const (
	ItemTypeMCP   ItemType = "mcp"
	ItemTypeSkill ItemType = "skill"
)

type Scope string

const (
	ScopeProject Scope = "project"
	ScopeGlobal  Scope = "global"
)

type TrustLevel string

const (
	TrustVerified     TrustLevel = "verified"
	TrustCommunity    TrustLevel = "community"
	TrustExperimental TrustLevel = "experimental"
)

type CatalogResponse struct {
	Items          []Item    `json:"items"`
	LastSynced     time.Time `json:"last_synced,omitempty"`
	Source         string    `json:"source,omitempty"`
	Stale          bool      `json:"stale,omitempty"`
	Error          string    `json:"error,omitempty"`
	ItemCount      int       `json:"item_count"`
	InstalledCount int       `json:"installed_count,omitempty"`
}

type Item struct {
	ID          string      `json:"id"`
	Type        ItemType    `json:"type"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Version     string      `json:"version,omitempty"`
	Author      string      `json:"author,omitempty"`
	Tags        []string    `json:"tags,omitempty"`
	Category    string      `json:"category,omitempty"`
	Trust       TrustLevel  `json:"trust,omitempty"`
	SourceURL   string      `json:"source_url,omitempty"`
	DocsURL     string      `json:"docs_url,omitempty"`
	MCP         *MCPPayload `json:"mcp,omitempty"`
	Skill       *SkillSpec  `json:"skill,omitempty"`
}

type MCPPayload struct {
	InstallMethods []MCPInstallMethod `json:"install_methods,omitempty"`
	Transport      string             `json:"transport,omitempty"`
	Command        string             `json:"command,omitempty"`
	Args           []string           `json:"args,omitempty"`
	URL            string             `json:"url,omitempty"`
	Parameters     []Parameter        `json:"parameters,omitempty"`
	EnvVars        []string           `json:"env_vars,omitempty"`
	Prerequisites  []string           `json:"prerequisites,omitempty"`
	Tools          []string           `json:"tools,omitempty"`
	Resources      []string           `json:"resources,omitempty"`
	Prompts        []string           `json:"prompts,omitempty"`
}

type MCPInstallMethod struct {
	Name          string      `json:"name,omitempty"`
	Transport     string      `json:"transport,omitempty"`
	Command       string      `json:"command,omitempty"`
	Args          []string    `json:"args,omitempty"`
	URL           string      `json:"url,omitempty"`
	EnvVars       []string    `json:"env_vars,omitempty"`
	Parameters    []Parameter `json:"parameters,omitempty"`
	Prerequisites []string    `json:"prerequisites,omitempty"`
}

type Parameter struct {
	Name        string `json:"name"`
	Key         string `json:"key,omitempty"`
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	EnvVar      string `json:"env_var,omitempty"`
	Default     string `json:"default,omitempty"`
	Required    bool   `json:"required,omitempty"`
	Optional    bool   `json:"optional,omitempty"`
	Secret      bool   `json:"secret,omitempty"`
}

type SkillSpec struct {
	DisplayName        string      `json:"display_name,omitempty"`
	SkillName          string      `json:"skill_name"`
	Files              []SkillFile `json:"files"`
	AllowedTools       []string    `json:"allowed_tools,omitempty"`
	ImplicitInvocation *bool       `json:"implicit_invocation,omitempty"`
	UserInvocable      *bool       `json:"user_invocable,omitempty"`
	Dependencies       []string    `json:"dependencies,omitempty"`
}

type SkillFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	SHA256  string `json:"sha256,omitempty"`
}

type InstallRequest struct {
	ID         string            `json:"id"`
	Type       ItemType          `json:"type"`
	Scope      Scope             `json:"scope,omitempty"`
	Method     string            `json:"method,omitempty"`
	Parameters map[string]string `json:"parameters,omitempty"`
}

type RemoveRequest struct {
	ID    string   `json:"id"`
	Type  ItemType `json:"type"`
	Scope Scope    `json:"scope,omitempty"`
	Force bool     `json:"force,omitempty"`
}

type InstalledMetadata struct {
	Project []InstalledItem `json:"project"`
	Global  []InstalledItem `json:"global"`
}

type InstalledItem struct {
	ID           string          `json:"id"`
	Type         ItemType        `json:"type"`
	Name         string          `json:"name"`
	Version      string          `json:"version,omitempty"`
	Scope        Scope           `json:"scope"`
	Paths        []InstalledPath `json:"paths,omitempty"`
	ConfigName   string          `json:"config_name,omitempty"`
	ConfigSHA256 string          `json:"config_sha256,omitempty"`
	InstalledAt  time.Time       `json:"installed_at"`
}

type InstalledPath struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type InstallResult struct {
	Success  bool              `json:"success"`
	Item     InstalledItem     `json:"item"`
	Metadata InstalledMetadata `json:"metadata"`
	Message  string            `json:"message,omitempty"`
}

type RemoveResult struct {
	Success  bool              `json:"success"`
	Metadata InstalledMetadata `json:"metadata"`
	Message  string            `json:"message,omitempty"`
}

type metadataFile struct {
	Items []InstalledItem `json:"items"`
}

type Service struct {
	configDir  string
	cwd        string
	catalogURL string
	cachePath  string
	client     *http.Client
}

var safeNamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)

func NewService(configDir, cwd string) *Service {
	if strings.TrimSpace(configDir) == "" {
		configDir = paths.GetGlobalDir()
	}
	if strings.TrimSpace(cwd) == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}
	return &Service{
		configDir:  configDir,
		cwd:        cwd,
		catalogURL: defaultCatalogURL,
		cachePath:  filepath.Join(configDir, "marketplace_catalog_cache.json"),
		client:     &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *Service) SetCatalogURL(url string) {
	s.catalogURL = strings.TrimSpace(url)
}

func (s *Service) GetCatalog(ctx context.Context) (*CatalogResponse, error) {
	items, syncedAt, err := s.loadCatalogCache()
	if err == nil && len(items) > 0 {
		return s.catalogResponse(items, syncedAt, "cache", false, ""), nil
	}
	items = defaultCatalogItems()
	return s.catalogResponse(items, time.Time{}, "bundled", true, ""), nil
}

func (s *Service) RefreshCatalog(ctx context.Context) (*CatalogResponse, error) {
	if strings.TrimSpace(s.catalogURL) == "" {
		resp, err := s.GetCatalog(ctx)
		if resp != nil {
			resp.Error = "catalog URL is not configured"
			resp.Stale = true
		}
		return resp, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.catalogURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return s.catalogWithError(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return s.catalogWithError(ctx, fmt.Errorf("registry returned %s", resp.Status))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return s.catalogWithError(ctx, err)
	}
	items, err := parseCatalog(data)
	if err != nil {
		return s.catalogWithError(ctx, err)
	}
	if err := s.writeCatalogCache(items); err != nil {
		return nil, err
	}
	return s.catalogResponse(items, time.Now(), "remote", false, ""), nil
}

func (s *Service) InstalledMetadata() (InstalledMetadata, error) {
	project, err := s.readMetadata(ScopeProject)
	if err != nil {
		return InstalledMetadata{}, err
	}
	global, err := s.readMetadata(ScopeGlobal)
	if err != nil {
		return InstalledMetadata{}, err
	}
	return InstalledMetadata{Project: project.Items, Global: global.Items}, nil
}

func (s *Service) Install(ctx context.Context, req InstallRequest) (*InstallResult, error) {
	req.ID = strings.TrimSpace(req.ID)
	if req.Scope == "" {
		req.Scope = ScopeProject
	}
	if err := validateScope(req.Scope); err != nil {
		return nil, err
	}
	catalog, err := s.GetCatalog(ctx)
	if err != nil {
		return nil, err
	}
	item, ok := findItem(catalog.Items, req.ID, req.Type)
	if !ok {
		return nil, fmt.Errorf("marketplace item not found in curated catalog: %s", req.ID)
	}
	var installed InstalledItem
	switch item.Type {
	case ItemTypeMCP:
		installed, err = s.installMCP(item, req)
	case ItemTypeSkill:
		installed, err = s.installSkill(item, req.Scope)
	default:
		err = fmt.Errorf("unsupported marketplace item type: %s", item.Type)
	}
	if err != nil {
		return nil, err
	}
	metadata, err := s.upsertInstalled(installed)
	if err != nil {
		return nil, err
	}
	return &InstallResult{
		Success:  true,
		Item:     installed,
		Metadata: metadata,
		Message:  fmt.Sprintf("Installed %s in %s scope", item.Name, req.Scope),
	}, nil
}

func (s *Service) Remove(ctx context.Context, req RemoveRequest) (*RemoveResult, error) {
	req.ID = strings.TrimSpace(req.ID)
	if req.Scope == "" {
		req.Scope = ScopeProject
	}
	if err := validateScope(req.Scope); err != nil {
		return nil, err
	}
	meta, err := s.readMetadata(req.Scope)
	if err != nil {
		return nil, err
	}
	item, index := findInstalled(meta.Items, req.ID, req.Type)
	if index < 0 {
		return nil, fmt.Errorf("installed marketplace item not found: %s", req.ID)
	}
	switch item.Type {
	case ItemTypeMCP:
		err = s.removeMCP(item, req.Force)
	case ItemTypeSkill:
		err = s.removeSkill(item, req.Force)
	default:
		err = fmt.Errorf("unsupported marketplace item type: %s", item.Type)
	}
	if err != nil {
		return nil, err
	}
	meta.Items = append(meta.Items[:index], meta.Items[index+1:]...)
	if err := s.writeMetadata(req.Scope, meta); err != nil {
		return nil, err
	}
	metadata, err := s.InstalledMetadata()
	if err != nil {
		return nil, err
	}
	return &RemoveResult{
		Success:  true,
		Metadata: metadata,
		Message:  fmt.Sprintf("Removed %s from %s scope", item.Name, req.Scope),
	}, nil
}

func (s *Service) ProjectMCPConfigPath() string {
	return filepath.Join(s.cwd, ".ricochet", "mcp.json")
}

func (s *Service) GlobalMCPConfigPath() string {
	return filepath.Join(s.configDir, "mcp_settings.json")
}

func (s *Service) catalogWithError(ctx context.Context, err error) (*CatalogResponse, error) {
	resp, fallbackErr := s.GetCatalog(ctx)
	if fallbackErr != nil {
		return nil, err
	}
	resp.Error = err.Error()
	resp.Stale = true
	return resp, nil
}

func (s *Service) catalogResponse(items []Item, syncedAt time.Time, source string, stale bool, errorMessage string) *CatalogResponse {
	metadata, _ := s.InstalledMetadata()
	installed := make(map[string]bool)
	for _, item := range metadata.Project {
		installed[string(item.Type)+":"+item.ID] = true
	}
	for _, item := range metadata.Global {
		installed[string(item.Type)+":"+item.ID] = true
	}
	return &CatalogResponse{
		Items:          items,
		LastSynced:     syncedAt,
		Source:         source,
		Stale:          stale,
		Error:          errorMessage,
		ItemCount:      len(items),
		InstalledCount: len(installed),
	}
}

func (s *Service) loadCatalogCache() ([]Item, time.Time, error) {
	data, err := os.ReadFile(s.cachePath)
	if err != nil {
		return nil, time.Time{}, err
	}
	items, err := parseCatalog(data)
	if err != nil {
		return nil, time.Time{}, err
	}
	var syncedAt time.Time
	if info, err := os.Stat(s.cachePath); err == nil {
		syncedAt = info.ModTime()
	}
	return items, syncedAt, nil
}

func (s *Service) writeCatalogCache(items []Item) error {
	if err := os.MkdirAll(filepath.Dir(s.cachePath), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(CatalogResponse{Items: items}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.cachePath, data, 0644)
}

func parseCatalog(data []byte) ([]Item, error) {
	var response CatalogResponse
	if err := json.Unmarshal(data, &response); err == nil && response.Items != nil {
		return normalizeItems(response.Items), nil
	}
	var items []Item
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, fmt.Errorf("parse marketplace catalog: %w", err)
	}
	return normalizeItems(items), nil
}

func normalizeItems(items []Item) []Item {
	for i := range items {
		items[i].ID = strings.TrimSpace(items[i].ID)
		items[i].Type = ItemType(strings.TrimSpace(string(items[i].Type)))
		items[i].Name = strings.TrimSpace(items[i].Name)
		if items[i].Trust == "" {
			items[i].Trust = TrustCommunity
		}
		if items[i].Version == "" {
			items[i].Version = "1.0.0"
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Type != items[j].Type {
			return items[i].Type < items[j].Type
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	return items
}

func findItem(items []Item, id string, itemType ItemType) (Item, bool) {
	for _, item := range items {
		if item.ID != id {
			continue
		}
		if itemType != "" && item.Type != itemType {
			continue
		}
		return item, true
	}
	return Item{}, false
}

func (s *Service) installSkill(item Item, scope Scope) (InstalledItem, error) {
	if item.Skill == nil {
		return InstalledItem{}, fmt.Errorf("skill marketplace item is missing skill payload")
	}
	skillName := sanitizeName(firstNonEmpty(item.Skill.SkillName, item.ID))
	if !safeNamePattern.MatchString(skillName) {
		return InstalledItem{}, fmt.Errorf("invalid skill_name: %s", item.Skill.SkillName)
	}
	if len(item.Skill.Files) == 0 {
		return InstalledItem{}, fmt.Errorf("skill item has no declared files")
	}
	hasSkillMD := false
	for _, file := range item.Skill.Files {
		rel, err := cleanRelativePath(file.Path)
		if err != nil {
			return InstalledItem{}, err
		}
		if rel == "SKILL.md" {
			hasSkillMD = true
			break
		}
	}
	if !hasSkillMD {
		return InstalledItem{}, fmt.Errorf("skill item must declare SKILL.md")
	}
	root := s.skillRoot(scope, skillName)
	var pathsWritten []InstalledPath
	for _, file := range item.Skill.Files {
		rel, err := cleanRelativePath(file.Path)
		if err != nil {
			return InstalledItem{}, err
		}
		target := filepath.Join(root, rel)
		if !isUnderRoot(target, root) {
			return InstalledItem{}, fmt.Errorf("skill file escapes install root: %s", file.Path)
		}
		if file.SHA256 != "" && sha256String(file.Content) != strings.ToLower(file.SHA256) {
			return InstalledItem{}, fmt.Errorf("catalog checksum mismatch for %s", file.Path)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return InstalledItem{}, err
		}
		if err := os.WriteFile(target, []byte(file.Content), 0644); err != nil {
			return InstalledItem{}, err
		}
		pathsWritten = append(pathsWritten, InstalledPath{Path: target, SHA256: sha256String(file.Content)})
	}
	return InstalledItem{
		ID:          item.ID,
		Type:        item.Type,
		Name:        item.Name,
		Version:     item.Version,
		Scope:       scope,
		Paths:       pathsWritten,
		InstalledAt: time.Now(),
	}, nil
}

func (s *Service) installMCP(item Item, req InstallRequest) (InstalledItem, error) {
	if item.MCP == nil {
		return InstalledItem{}, fmt.Errorf("MCP marketplace item is missing mcp payload")
	}
	method, err := selectMCPMethod(item.MCP, req.Method)
	if err != nil {
		return InstalledItem{}, err
	}
	parameters := append([]Parameter{}, item.MCP.Parameters...)
	parameters = append(parameters, method.Parameters...)
	values, err := validateParameters(parameters, req.Parameters)
	if err != nil {
		return InstalledItem{}, err
	}
	command := substituteDeclared(firstNonEmpty(method.Command, item.MCP.Command), values)
	url := substituteDeclared(firstNonEmpty(method.URL, item.MCP.URL), values)
	args := substituteDeclaredSlice(firstNonEmptySlice(method.Args, item.MCP.Args), values)
	transport := firstNonEmpty(method.Transport, item.MCP.Transport, "stdio")
	if transport == "stdio" && strings.TrimSpace(command) == "" {
		return InstalledItem{}, fmt.Errorf("stdio MCP install requires command")
	}
	envNames := append([]string{}, item.MCP.EnvVars...)
	envNames = append(envNames, method.EnvVars...)
	env := make(map[string]string)
	for _, name := range uniqueStrings(envNames) {
		key := strings.TrimSpace(name)
		if key == "" {
			continue
		}
		value := strings.TrimSpace(req.Parameters[key])
		if value == "" {
			value = values[key]
		}
		if value == "" {
			return InstalledItem{}, fmt.Errorf("missing required parameter: %s", key)
		}
		env[key] = value
	}
	for _, param := range parameters {
		if param.EnvVar == "" {
			continue
		}
		key := parameterKey(param)
		if value := values[key]; value != "" {
			env[param.EnvVar] = value
		}
	}

	configName := sanitizeConfigName(item.ID)
	settingsPath := s.GlobalMCPConfigPath()
	if req.Scope == ScopeProject {
		settingsPath = s.ProjectMCPConfigPath()
	}
	settings, err := readMCPSettings(settingsPath)
	if err != nil {
		return InstalledItem{}, err
	}
	if settings.McpServers == nil {
		settings.McpServers = make(map[string]mcp.McpServerConfig)
	}
	config := mcp.McpServerConfig{
		Type:    transport,
		Command: command,
		Args:    args,
		URL:     url,
		Env:     env,
	}
	entryHash := mcpConfigHash(config)
	settings.McpServers[configName] = config
	if err := writeMCPSettings(settingsPath, settings); err != nil {
		return InstalledItem{}, err
	}
	return InstalledItem{
		ID:           item.ID,
		Type:         item.Type,
		Name:         item.Name,
		Version:      item.Version,
		Scope:        req.Scope,
		ConfigName:   configName,
		ConfigSHA256: entryHash,
		Paths:        []InstalledPath{{Path: settingsPath, SHA256: fileSHA256BestEffort(settingsPath)}},
		InstalledAt:  time.Now(),
	}, nil
}

func (s *Service) removeSkill(item InstalledItem, force bool) error {
	for _, installedPath := range item.Paths {
		if !isUnderRoot(installedPath.Path, s.skillRoot(item.Scope, "")) {
			return fmt.Errorf("recorded skill path is outside skill root: %s", installedPath.Path)
		}
		if !force {
			hash, err := fileSHA256(installedPath.Path)
			if err != nil {
				return err
			}
			if hash != installedPath.SHA256 {
				return fmt.Errorf("installed file changed since install: %s", installedPath.Path)
			}
		}
	}
	for _, installedPath := range item.Paths {
		if err := os.Remove(installedPath.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
		removeEmptyParents(filepath.Dir(installedPath.Path), s.skillRoot(item.Scope, ""))
	}
	return nil
}

func (s *Service) removeMCP(item InstalledItem, force bool) error {
	settingsPath := s.GlobalMCPConfigPath()
	if item.Scope == ScopeProject {
		settingsPath = s.ProjectMCPConfigPath()
	}
	settings, err := readMCPSettings(settingsPath)
	if err != nil {
		return err
	}
	config, ok := settings.McpServers[item.ConfigName]
	if !ok {
		return fmt.Errorf("MCP config entry not found: %s", item.ConfigName)
	}
	if !force && item.ConfigSHA256 != "" && mcpConfigHash(config) != item.ConfigSHA256 {
		return fmt.Errorf("MCP config entry changed since install: %s", item.ConfigName)
	}
	delete(settings.McpServers, item.ConfigName)
	return writeMCPSettings(settingsPath, settings)
}

func (s *Service) upsertInstalled(item InstalledItem) (InstalledMetadata, error) {
	meta, err := s.readMetadata(item.Scope)
	if err != nil {
		return InstalledMetadata{}, err
	}
	_, index := findInstalled(meta.Items, item.ID, item.Type)
	if index >= 0 {
		meta.Items[index] = item
	} else {
		meta.Items = append(meta.Items, item)
	}
	if err := s.writeMetadata(item.Scope, meta); err != nil {
		return InstalledMetadata{}, err
	}
	return s.InstalledMetadata()
}

func findInstalled(items []InstalledItem, id string, itemType ItemType) (InstalledItem, int) {
	for i, item := range items {
		if item.ID == id && item.Type == itemType {
			return item, i
		}
	}
	return InstalledItem{}, -1
}

func (s *Service) metadataPath(scope Scope) string {
	if scope == ScopeGlobal {
		return filepath.Join(s.configDir, "marketplace-installed.json")
	}
	return filepath.Join(s.cwd, ".ricochet", "marketplace-installed.json")
}

func (s *Service) readMetadata(scope Scope) (metadataFile, error) {
	path := s.metadataPath(scope)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return metadataFile{}, nil
		}
		return metadataFile{}, err
	}
	var meta metadataFile
	if err := json.Unmarshal(data, &meta); err != nil {
		return metadataFile{}, err
	}
	return meta, nil
}

func (s *Service) writeMetadata(scope Scope, meta metadataFile) error {
	path := s.metadataPath(scope)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	sort.Slice(meta.Items, func(i, j int) bool {
		if meta.Items[i].Type != meta.Items[j].Type {
			return meta.Items[i].Type < meta.Items[j].Type
		}
		return strings.ToLower(meta.Items[i].Name) < strings.ToLower(meta.Items[j].Name)
	})
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *Service) skillRoot(scope Scope, skillName string) string {
	if scope == ScopeGlobal {
		return filepath.Join(s.configDir, "skills", skillName)
	}
	return filepath.Join(s.cwd, ".ricochet", "skills", skillName)
}

func selectMCPMethod(payload *MCPPayload, methodName string) (MCPInstallMethod, error) {
	if len(payload.InstallMethods) == 0 {
		return MCPInstallMethod{}, nil
	}
	if methodName == "" {
		return payload.InstallMethods[0], nil
	}
	for _, method := range payload.InstallMethods {
		if method.Name == methodName {
			return method, nil
		}
	}
	return MCPInstallMethod{}, fmt.Errorf("unknown MCP install method: %s", methodName)
}

func validateParameters(parameters []Parameter, provided map[string]string) (map[string]string, error) {
	values := make(map[string]string)
	for _, param := range parameters {
		key := parameterKey(param)
		if key == "" {
			continue
		}
		value := strings.TrimSpace(provided[key])
		if value == "" && param.Name != "" {
			value = strings.TrimSpace(provided[param.Name])
		}
		if value == "" && param.EnvVar != "" {
			value = strings.TrimSpace(provided[param.EnvVar])
		}
		if value == "" {
			value = param.Default
		}
		required := param.Required || (!param.Optional && param.Default == "")
		if required && strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("missing required parameter: %s", key)
		}
		values[key] = value
		if param.Name != "" {
			values[param.Name] = value
		}
		if param.EnvVar != "" {
			values[param.EnvVar] = value
		}
	}
	return values, nil
}

func parameterKey(param Parameter) string {
	return firstNonEmpty(param.Key, param.Name, param.EnvVar)
}

func substituteDeclared(value string, params map[string]string) string {
	for key, replacement := range params {
		value = strings.ReplaceAll(value, "${"+key+"}", replacement)
		value = strings.ReplaceAll(value, "{{"+key+"}}", replacement)
	}
	return value
}

func substituteDeclaredSlice(values []string, params map[string]string) []string {
	out := make([]string, len(values))
	for i, value := range values {
		out[i] = substituteDeclared(value, params)
	}
	return out
}

func readMCPSettings(path string) (*mcp.McpSettings, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &mcp.McpSettings{McpServers: make(map[string]mcp.McpServerConfig)}, nil
		}
		return nil, err
	}
	var settings mcp.McpSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, err
	}
	if settings.McpServers == nil {
		settings.McpServers = make(map[string]mcp.McpServerConfig)
	}
	return &settings, nil
}

func writeMCPSettings(path string, settings *mcp.McpSettings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if settings.McpServers == nil {
		settings.McpServers = make(map[string]mcp.McpServerConfig)
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func mcpConfigHash(config mcp.McpServerConfig) string {
	data, _ := json.Marshal(config)
	return sha256Bytes(data)
}

func fileSHA256BestEffort(path string) string {
	hash, _ := fileSHA256(path)
	return hash
}

func fileSHA256(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return sha256Bytes(data), nil
}

func sha256String(value string) string {
	return sha256Bytes([]byte(value))
}

func sha256Bytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func cleanRelativePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("file path is required")
	}
	if filepath.IsAbs(path) {
		return "", fmt.Errorf("absolute file paths are not allowed: %s", path)
	}
	clean := filepath.Clean(path)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path traversal is not allowed: %s", path)
	}
	return clean, nil
}

func isUnderRoot(path, root string) bool {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	if absPath == absRoot {
		return true
	}
	return strings.HasPrefix(absPath, absRoot+string(filepath.Separator))
}

func removeEmptyParents(dir, stopRoot string) {
	absStop, err := filepath.Abs(stopRoot)
	if err != nil {
		return
	}
	for {
		absDir, err := filepath.Abs(dir)
		if err != nil || absDir == absStop || !strings.HasPrefix(absDir, absStop+string(filepath.Separator)) {
			return
		}
		if err := os.Remove(absDir); err != nil {
			return
		}
		dir = filepath.Dir(absDir)
	}
}

func validateScope(scope Scope) error {
	switch scope {
	case ScopeProject, ScopeGlobal:
		return nil
	default:
		return fmt.Errorf("unsupported install scope: %s", scope)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func firstNonEmptySlice(values ...[]string) []string {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func sanitizeName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = regexp.MustCompile(`[^a-z0-9-]+`).ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	return value
}

func sanitizeConfigName(value string) string {
	name := sanitizeName(value)
	if name == "" {
		return "marketplace-server"
	}
	return name
}

func defaultCatalogItems() []Item {
	return normalizeItems([]Item{
		{
			ID:          "github",
			Type:        ItemTypeMCP,
			Name:        "GitHub",
			Description: "Work with GitHub repositories, issues, pull requests, and code search through an MCP server.",
			Version:     "1.0.0",
			Author:      "Model Context Protocol",
			Category:    "development",
			Tags:        []string{"git", "issues", "pull-requests"},
			Trust:       TrustVerified,
			SourceURL:   "https://github.com/modelcontextprotocol/servers",
			DocsURL:     "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
			MCP: &MCPPayload{
				Transport: "stdio",
				Command:   "npx",
				Args:      []string{"-y", "@modelcontextprotocol/server-github"},
				EnvVars:   []string{"GITHUB_PERSONAL_ACCESS_TOKEN"},
				Parameters: []Parameter{{
					Name:        "GITHUB_PERSONAL_ACCESS_TOKEN",
					Label:       "GitHub token",
					Description: "Personal access token used by the GitHub MCP server.",
					Secret:      true,
					Required:    true,
				}},
				Tools: []string{"create_issue", "search_repositories", "get_file_contents"},
			},
		},
		{
			ID:          "memory",
			Type:        ItemTypeMCP,
			Name:        "Memory",
			Description: "Local knowledge graph memory server for durable agent notes and relationships.",
			Version:     "1.0.0",
			Author:      "Model Context Protocol",
			Category:    "knowledge",
			Tags:        []string{"memory", "knowledge", "local"},
			Trust:       TrustVerified,
			SourceURL:   "https://github.com/modelcontextprotocol/servers",
			DocsURL:     "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
			MCP: &MCPPayload{
				Transport: "stdio",
				Command:   "npx",
				Args:      []string{"-y", "@modelcontextprotocol/server-memory"},
				Tools:     []string{"create_entities", "create_relations", "search_nodes"},
			},
		},
		{
			ID:          "project-review",
			Type:        ItemTypeSkill,
			Name:        "Project Review",
			Description: "Review code changes with a practical bug/risk/test-gap focus.",
			Version:     "1.0.0",
			Author:      "Ricochet",
			Category:    "review",
			Tags:        []string{"review", "quality", "tests"},
			Trust:       TrustVerified,
			DocsURL:     "https://agentskills.io/",
			Skill: &SkillSpec{
				DisplayName:  "Project Review",
				SkillName:    "project-review",
				AllowedTools: []string{"read_file", "grep_search", "list_files"},
				Files: []SkillFile{{
					Path: "SKILL.md",
					Content: `---
name: project-review
display_name: Project Review
description: Review local code changes for bugs, regressions, and missing tests.
when_to_use: Use when the user asks for a code review or asks to audit a local change.
allowed_tools:
  - read_file
  - grep_search
  - list_files
user_invocable: true
---
# Project Review

Review the change as a senior engineer. Prioritize correctness bugs, behavioral regressions, security risks, and missing tests. Lead with findings ordered by severity and include exact file references.
`,
				}},
			},
		},
		{
			ID:          "mcp-integration-audit",
			Type:        ItemTypeSkill,
			Name:        "MCP Integration Audit",
			Description: "Audit MCP server configuration, declared tools, auth requirements, and permission impact.",
			Version:     "1.0.0",
			Author:      "Ricochet",
			Category:    "security",
			Tags:        []string{"mcp", "permissions", "security"},
			Trust:       TrustVerified,
			DocsURL:     "https://modelcontextprotocol.io/",
			Skill: &SkillSpec{
				DisplayName:  "MCP Integration Audit",
				SkillName:    "mcp-integration-audit",
				AllowedTools: []string{"read_file", "grep_search", "list_files"},
				Files: []SkillFile{{
					Path: "SKILL.md",
					Content: `---
name: mcp-integration-audit
display_name: MCP Integration Audit
description: Audit MCP server setup, trust boundaries, and permission impact.
when_to_use: Use when the user asks to inspect MCP configuration, marketplace installs, or server tool exposure.
allowed_tools:
  - read_file
  - grep_search
  - list_files
user_invocable: true
---
# MCP Integration Audit

Map each configured MCP server to its transport, command or URL, environment requirements, exposed tools/resources/prompts, and approval implications. Flag hidden auto-approval, broad tokens, and config drift.
`,
				}},
			},
		},
	})
}
