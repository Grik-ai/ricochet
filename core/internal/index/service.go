package index

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	ricochetContext "github.com/igoryan-dao/ricochet/internal/context"
)

// Embedder interface for generating embeddings
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
}

// Indexer handles the codebase indexing process
type Indexer struct {
	mu             sync.RWMutex
	store          VectorStore
	provider       Embedder
	parser         *ricochetContext.LanguageParser
	workspaceRoot  string
	isIndexing     bool
	lastError      string
	lastIndexedAt  int64
	lastDurationMs int64
}

func NewIndexer(store VectorStore, provider Embedder, workspaceRoot string) *Indexer {
	return &Indexer{
		store:         store,
		provider:      provider,
		parser:        ricochetContext.NewLanguageParser(),
		workspaceRoot: workspaceRoot,
	}
}

func (idx *Indexer) SetProvider(provider Embedder) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	idx.provider = provider
}

// IndexAll performs a full scan of the workspace
func (idx *Indexer) IndexAll(ctx context.Context) (returnErr error) {
	start := time.Now()

	idx.mu.Lock()
	if idx.provider == nil {
		returnErr = fmt.Errorf("semantic index disabled: no embedding provider configured")
		idx.lastError = returnErr.Error()
		idx.mu.Unlock()
		return returnErr
	}

	if idx.isIndexing {
		idx.mu.Unlock()
		return fmt.Errorf("indexing already in progress")
	}
	provider := idx.provider
	idx.isIndexing = true
	idx.lastError = ""
	idx.mu.Unlock()

	defer func() {
		idx.mu.Lock()
		idx.isIndexing = false
		idx.lastDurationMs = time.Since(start).Milliseconds()
		if returnErr != nil {
			idx.lastError = returnErr.Error()
		} else {
			idx.lastError = ""
			idx.lastIndexedAt = time.Now().UnixMilli()
		}
		idx.mu.Unlock()
	}()

	var allDocs []Document

	err := filepath.Walk(idx.workspaceRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			name := info.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "dist" || name == "out" {
				return filepath.SkipDir
			}
			return nil
		}

		ext := strings.ToLower(filepath.Ext(path))
		switch ext {
		case ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go":
			// Go ahead
		default:
			return nil
		}

		docs, err := idx.indexFile(ctx, path)
		if err != nil {
			fmt.Printf("Warning: failed to index file %s: %v\n", path, err)
			return nil
		}

		allDocs = append(allDocs, docs...)
		return nil
	})

	if err != nil {
		return err
	}

	if len(allDocs) > 0 {
		// 1. Build Dependency Graph and Compute PageRank
		graph := NewDependencyGraph()
		graph.BuildGraph(allDocs)
		graph.ComputePageRank(0.85, 20) // Standard damping factor

		// 2. Assign PageRank to documents
		for i := range allDocs {
			if node, ok := graph.Nodes[allDocs[i].FilePath]; ok {
				if allDocs[i].Metadata == nil {
					allDocs[i].Metadata = make(map[string]interface{})
				}
				allDocs[i].Metadata["pagerank"] = node.PageRank
			}
		}

		// 3. Generate embeddings
		batchSize := 20
		for i := 0; i < len(allDocs); i += batchSize {
			end := i + batchSize
			if end > len(allDocs) {
				end = len(allDocs)
			}

			var batchTexts []string
			for _, d := range allDocs[i:end] {
				batchTexts = append(batchTexts, d.Content)
			}

			embeddings, err := provider.Embed(ctx, batchTexts)
			if err != nil {
				return fmt.Errorf("failed to generate embeddings: %w", err)
			}

			for j, emb := range embeddings {
				allDocs[i+j].Embedding = emb
			}
		}

		if err := idx.store.Clear(); err != nil {
			return err
		}
		if err := idx.store.Add(allDocs); err != nil {
			return err
		}
		return idx.store.Save()
	}

	return nil
}

func (idx *Indexer) indexFile(ctx context.Context, path string) ([]Document, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	relPath, _ := filepath.Rel(idx.workspaceRoot, path)

	// Try to get definitions (functions, classes) and imports
	analysis, err := idx.parser.ParseDefinitions(ctx, path, content)
	if err != nil {
		return idx.chunkSimple(relPath, string(content)), nil
	}

	var docs []Document
	lines := strings.Split(string(content), "\n")

	// Store file-level metadata (imports) in every chunk derived from this file
	// or create a dedicated "File" chunk?
	// For now, we propagate imports to all chunks so the graph builder can pick any.

	// If definitions exist, chunk by definitions
	if len(analysis.Definitions) > 0 {
		for _, def := range analysis.Definitions {
			start := def.LineStart - 1
			end := def.LineEnd
			if start < 0 {
				start = 0
			}
			if end > len(lines) {
				end = len(lines)
			}
			if start >= end {
				continue
			}

			chunk := strings.Join(lines[start:end], "\n")
			if len(chunk) > 8000 {
				chunk = chunk[:8000]
			}

			docs = append(docs, Document{
				ID:        fmt.Sprintf("%s:%d-%d", relPath, def.LineStart, def.LineEnd),
				FilePath:  relPath,
				Content:   fmt.Sprintf("// File: %s\n// %s: %s\n%s", relPath, def.Type, def.Name, chunk),
				LineStart: def.LineStart,
				LineEnd:   def.LineEnd,
				Metadata: map[string]interface{}{
					"type":    def.Type,
					"name":    def.Name,
					"imports": analysis.Imports, // Add imports to metadata
				},
			})
		}
	}

	// Always add a "whole file" summary or if chunks were empty
	if len(docs) == 0 && len(content) > 0 {
		return idx.chunkSimpleWithImports(relPath, string(content), analysis.Imports), nil
	}

	return docs, nil
}

func (idx *Indexer) chunkSimple(relPath, content string) []Document {
	return idx.chunkSimpleWithImports(relPath, content, nil)
}

func (idx *Indexer) chunkSimpleWithImports(relPath, content string, imports []string) []Document {
	lines := strings.Split(content, "\n")
	chunkSize := 50
	var docs []Document

	for i := 0; i < len(lines); i += chunkSize {
		end := i + chunkSize
		if end > len(lines) {
			end = len(lines)
		}

		chunk := strings.Join(lines[i:end], "\n")
		doc := Document{
			ID:        fmt.Sprintf("%s:%d-%d", relPath, i+1, end),
			FilePath:  relPath,
			Content:   fmt.Sprintf("// File: %s (Lines %d-%d)\n%s", relPath, i+1, end, chunk),
			LineStart: i + 1,
			LineEnd:   end,
			Metadata:  make(map[string]interface{}),
		}

		if imports != nil {
			doc.Metadata["imports"] = imports
		}

		docs = append(docs, doc)
	}
	return docs
}

func (idx *Indexer) Search(ctx context.Context, query string, limit int) ([]SearchResult, error) {
	if idx.provider == nil {
		return nil, fmt.Errorf("semantic search disabled: no embedding provider configured")
	}

	emb, err := idx.provider.Embed(ctx, []string{query})
	if err != nil {
		return nil, err
	}
	if len(emb) == 0 {
		return nil, nil
	}

	// This is where we would ideally combine vector score with PageRank
	// But LocalStore.Search is naive.
	// We should probably modify LocalStore.Search or re-rank here.

	results, err := idx.store.Search(emb[0], limit*2) // Get more results to re-rank
	if err != nil {
		return nil, err
	}

	// Simple re-ranking: Score = VectorScore * (1 + PageRank_Boost)
	// Assuming PageRank is small (e.g. 0.001 to 0.1), we normalize it or just add it.

	for i := range results {
		if pr, ok := results[i].Document.Metadata["pagerank"].(float64); ok {
			// Boost factor. If PR is high, we boost.
			// Vector scores are usually 0.7-0.9.
			// Let's say PR can boost up to 20%.
			// Need to normalize PR? For now just raw addition with weight.
			results[i].Score = results[i].Score + (pr * 100.0) // Heuristic: PR is usually small (1/N)
		}
	}

	// Sort again
	for i := 0; i < len(results); i++ {
		for j := i + 1; j < len(results); j++ {
			if results[i].Score < results[j].Score {
				results[i], results[j] = results[j], results[i]
			}
		}
	}

	if len(results) > limit {
		results = results[:limit]
	}

	return results, nil
}

type IndexStatus struct {
	IsIndexing         bool   `json:"is_indexing"`
	TotalDocs          int    `json:"total_docs"`
	ProviderConfigured bool   `json:"provider_configured"`
	LastIndexedAt      int64  `json:"last_indexed_at,omitempty"`
	DurationMs         int64  `json:"duration_ms,omitempty"`
	Error              string `json:"error,omitempty"`
}

func (idx *Indexer) GetStatus() IndexStatus {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	return IndexStatus{
		IsIndexing:         idx.isIndexing,
		TotalDocs:          idx.store.Count(),
		ProviderConfigured: idx.provider != nil,
		LastIndexedAt:      idx.lastIndexedAt,
		DurationMs:         idx.lastDurationMs,
		Error:              idx.lastError,
	}
}
