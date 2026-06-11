package index

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sync"
)

// Document represents a chunk of code in the index
type Document struct {
	ID        string                 `json:"id"`
	FilePath  string                 `json:"file_path"`
	Content   string                 `json:"content"`
	LineStart int                    `json:"line_start"`
	LineEnd   int                    `json:"line_end"`
	Embedding []float32              `json:"embedding"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
}

// SearchResult represents a single match from the vector store
type SearchResult struct {
	Document *Document
	Score    float64
}

// VectorStore interface for semantic search
type VectorStore interface {
	Add(docs []Document) error
	Search(queryEmbedding []float32, limit int) ([]SearchResult, error)
	Clear() error
	Save() error
	Load() error
	Count() int
}

// LocalStore implements VectorStore using in-memory slice and local persistence
type LocalStore struct {
	mu   sync.RWMutex
	path string
	docs []Document
}

func NewLocalStore(path string) (*LocalStore, error) {
	s := &LocalStore{
		path: path,
		docs: make([]Document, 0),
	}
	// Try to load existing index
	if _, err := os.Stat(path); err == nil {
		if err := s.Load(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *LocalStore) Add(docs []Document) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.docs = append(s.docs, docs...)
	return nil
}

func (s *LocalStore) Search(query []float32, limit int) ([]SearchResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.docs) == 0 {
		return nil, nil
	}

	results := make([]SearchResult, 0, len(s.docs))
	for i := range s.docs {
		score := cosineSimilarity(query, s.docs[i].Embedding)
		results = append(results, SearchResult{
			Document: &s.docs[i],
			Score:    score,
		})
	}

	// Sort by score descending
	// (Using a simple bubble sort or similar for now for simplicity,
	// or just use sort.Slice if we want to be more efficient)
	// For production we'd want a proper vector DB like Qdrant/Milvus/Chroma
	// but for a local IDE tool, this is fine for up to ~10k chunks.

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

func (s *LocalStore) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.docs = make([]Document, 0)
	return nil
}

func (s *LocalStore) Save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return err
	}

	data, err := json.Marshal(s.docs)
	if err != nil {
		return err
	}

	return os.WriteFile(s.path, data, 0644)
}

func (s *LocalStore) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}

	return json.Unmarshal(data, &s.docs)
}

func (s *LocalStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.docs)
}

func cosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		dot += float64(a[i] * b[i])
		normA += float64(a[i] * a[i])
		normB += float64(b[i] * b[i])
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}
