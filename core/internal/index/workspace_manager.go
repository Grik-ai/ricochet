package index

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	ricochetContext "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type WorkspaceIndexManager struct {
	mu      sync.RWMutex
	root    string
	parser  *ricochetContext.LanguageParser
	status  protocol.WorkspaceIndexStatus
	records []protocol.WorkspaceFileRecord
}

func NewWorkspaceIndexManager(root string) *WorkspaceIndexManager {
	return &WorkspaceIndexManager{
		root:   root,
		parser: ricochetContext.NewLanguageParser(),
		status: protocol.WorkspaceIndexStatus{
			WorkspaceRoot: root,
			Status:        "disabled",
			Enabled:       false,
		},
	}
}

func (m *WorkspaceIndexManager) Close() {
	if m != nil && m.parser != nil {
		m.parser.Close()
	}
}

func (m *WorkspaceIndexManager) Start(ctx context.Context, interval time.Duration) {
	if m == nil {
		return
	}
	go func() {
		_ = m.Rebuild(ctx)
		if interval <= 0 {
			return
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = m.Rebuild(ctx)
			}
		}
	}()
}

func (m *WorkspaceIndexManager) Rebuild(ctx context.Context) error {
	if m == nil {
		return nil
	}
	start := time.Now()
	m.mu.Lock()
	m.status = protocol.WorkspaceIndexStatus{
		WorkspaceRoot: m.root,
		Status:        "indexing",
		Enabled:       true,
		LastIndexedAt: m.status.LastIndexedAt,
	}
	m.mu.Unlock()

	records := make([]protocol.WorkspaceFileRecord, 0)
	var filesTotal int
	var bytesIndexed int64
	var definitions int

	err := filepath.WalkDir(m.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if d.IsDir() {
			if shouldSkipWorkspaceDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if !isIndexableWorkspaceFile(path) {
			return nil
		}
		filesTotal++

		record := m.indexRecord(ctx, path)
		bytesIndexed += record.Size
		definitions += record.Definitions
		records = append(records, record)
		return nil
	})

	status := protocol.WorkspaceIndexStatus{
		WorkspaceRoot: m.root,
		Status:        "clean",
		Enabled:       true,
		FilesTotal:    filesTotal,
		FilesIndexed:  len(records),
		Definitions:   definitions,
		BytesIndexed:  bytesIndexed,
		LastIndexedAt: time.Now().UnixMilli(),
		DurationMs:    time.Since(start).Milliseconds(),
		SampleFiles:   topWorkspaceRecords(records, 20),
	}
	if err != nil {
		status.Status = "error"
		status.Error = err.Error()
	}

	m.mu.Lock()
	m.status = status
	m.records = append([]protocol.WorkspaceFileRecord(nil), records...)
	m.mu.Unlock()
	return err
}

func (m *WorkspaceIndexManager) Status() protocol.WorkspaceIndexStatus {
	if m == nil {
		return protocol.WorkspaceIndexStatus{Status: "disabled", Enabled: false}
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

func (m *WorkspaceIndexManager) Records() []protocol.WorkspaceFileRecord {
	if m == nil {
		return nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]protocol.WorkspaceFileRecord, len(m.records))
	copy(out, m.records)
	return out
}

func (m *WorkspaceIndexManager) Explore(limit int) []protocol.WorkspaceFileRecord {
	records := m.Records()
	if limit <= 0 {
		limit = 40
	}
	return topWorkspaceRecords(records, limit)
}

func (m *WorkspaceIndexManager) RouteLookup(query string, limit int) []protocol.WorkspaceFileRecord {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil
	}
	if limit <= 0 {
		limit = 20
	}
	records := m.Records()
	scored := make([]protocol.WorkspaceFileRecord, 0)
	for _, record := range records {
		haystack := strings.ToLower(record.Path + " " + record.Language + " " + strings.Join(record.Imports, " "))
		if strings.Contains(haystack, query) {
			record.Stale = m.isRecordStale(record)
			scored = append(scored, record)
		}
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Definitions == scored[j].Definitions {
			return len(scored[i].Path) < len(scored[j].Path)
		}
		return scored[i].Definitions > scored[j].Definitions
	})
	if len(scored) > limit {
		scored = scored[:limit]
	}
	return scored
}

func (m *WorkspaceIndexManager) DependencyTrace(pathOrImport string, limit int) map[string][]protocol.WorkspaceFileRecord {
	target := strings.TrimSpace(filepath.ToSlash(pathOrImport))
	if target == "" {
		return map[string][]protocol.WorkspaceFileRecord{}
	}
	if limit <= 0 {
		limit = 30
	}
	records := m.Records()
	direct := make([]protocol.WorkspaceFileRecord, 0)
	reverse := make([]protocol.WorkspaceFileRecord, 0)
	for _, record := range records {
		if record.Path == target || strings.HasSuffix(record.Path, target) {
			for _, imp := range record.Imports {
				for _, candidate := range records {
					if importMatchesRecord(imp, candidate.Path) {
						candidate.Stale = m.isRecordStale(candidate)
						direct = append(direct, candidate)
					}
				}
			}
		}
		for _, imp := range record.Imports {
			if importMatchesRecord(imp, target) {
				record.Stale = m.isRecordStale(record)
				reverse = append(reverse, record)
				break
			}
		}
	}
	if len(direct) > limit {
		direct = direct[:limit]
	}
	if len(reverse) > limit {
		reverse = reverse[:limit]
	}
	return map[string][]protocol.WorkspaceFileRecord{
		"dependencies": direct,
		"dependents":   reverse,
	}
}

func (m *WorkspaceIndexManager) isRecordStale(record protocol.WorkspaceFileRecord) bool {
	if m == nil || record.Path == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(m.root, filepath.FromSlash(record.Path)))
	if err != nil {
		return true
	}
	return info.ModTime().UnixMilli() > record.IndexedAt
}

func (m *WorkspaceIndexManager) indexRecord(ctx context.Context, path string) protocol.WorkspaceFileRecord {
	info, err := os.Stat(path)
	if err != nil {
		return protocol.WorkspaceFileRecord{Path: relPath(m.root, path), Error: err.Error()}
	}
	record := protocol.WorkspaceFileRecord{
		Path:       relPath(m.root, path),
		Language:   languageForPath(path),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UnixMilli(),
		IndexedAt:  time.Now().UnixMilli(),
	}
	content, err := os.ReadFile(path)
	if err != nil {
		record.Error = err.Error()
		return record
	}
	sum := sha1.Sum(content)
	record.Hash = hex.EncodeToString(sum[:8])

	if analysis, err := m.parser.ParseDefinitions(ctx, path, content); err == nil {
		record.Definitions = len(analysis.Definitions)
		record.Imports = analysis.Imports
	} else {
		record.Definitions = countFallbackDefinitions(content)
	}
	return record
}

func shouldSkipWorkspaceDir(name string) bool {
	switch name {
	case ".git", ".hg", ".svn", ".ricochet", ".kilo", ".kilocode", "node_modules", "vendor", "dist", "out", "build", "coverage", "target", "__pycache__":
		return true
	default:
		return strings.HasPrefix(name, ".cache")
	}
}

func isIndexableWorkspaceFile(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go", ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".md", ".mdx", ".json", ".yaml", ".yml", ".toml":
		return true
	default:
		return false
	}
}

func languageForPath(path string) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	if ext == "yml" {
		return "yaml"
	}
	return ext
}

func relPath(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(rel)
}

func countFallbackDefinitions(content []byte) int {
	count := 0
	for _, line := range strings.Split(string(content), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "func ") ||
			strings.HasPrefix(trimmed, "type ") ||
			strings.HasPrefix(trimmed, "class ") ||
			strings.HasPrefix(trimmed, "def ") ||
			strings.HasPrefix(trimmed, "export function ") ||
			strings.HasPrefix(trimmed, "export class ") {
			count++
		}
	}
	return count
}

func topWorkspaceRecords(records []protocol.WorkspaceFileRecord, limit int) []protocol.WorkspaceFileRecord {
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].Definitions == records[j].Definitions {
			return records[i].Size > records[j].Size
		}
		return records[i].Definitions > records[j].Definitions
	})
	if limit > 0 && len(records) > limit {
		records = records[:limit]
	}
	out := make([]protocol.WorkspaceFileRecord, len(records))
	copy(out, records)
	return out
}

func importMatchesRecord(imp string, path string) bool {
	imp = strings.Trim(strings.TrimSpace(filepath.ToSlash(imp)), "\"'`")
	path = filepath.ToSlash(path)
	if imp == "" || path == "" {
		return false
	}
	if strings.HasSuffix(path, imp) || strings.HasSuffix(path, imp+".go") || strings.HasSuffix(path, imp+".ts") || strings.HasSuffix(path, imp+".tsx") || strings.HasSuffix(path, imp+".js") {
		return true
	}
	base := filepath.Base(imp)
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	return base == name || strings.TrimSuffix(base, filepath.Ext(base)) == name
}

func (m *WorkspaceIndexManager) String() string {
	status := m.Status()
	return fmt.Sprintf("%s: %d files, %d definitions", status.Status, status.FilesIndexed, status.Definitions)
}
