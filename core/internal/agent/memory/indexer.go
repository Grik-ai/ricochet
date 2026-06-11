package memory

import (
	"context"
	"fmt"

	"github.com/igoryan-dao/ricochet/internal/index"
)

// Indexer handles semantic storage and retrieval of agent learnings (RAG)
type Indexer struct {
	store    index.VectorStore
	embedder index.Embedder
}

func NewIndexer(store index.VectorStore, embedder index.Embedder) *Indexer {
	return &Indexer{
		store:    store,
		embedder: embedder,
	}
}

// IndexLearning converts a learning into a vector and stores it
func (idx *Indexer) IndexLearning(ctx context.Context, l Learning) error {
	// Combine Key and Value for better semantic representation
	text := fmt.Sprintf("Topic: %s\nLesson: %s", l.Key, l.Value)

	embs, err := idx.embedder.Embed(ctx, []string{text})
	if err != nil {
		return fmt.Errorf("failed to embed learning: %w", err)
	}

	doc := index.Document{
		ID:        l.Key,
		Content:   text,
		Embedding: embs[0],
		Metadata: map[string]interface{}{
			"source":    l.Source,
			"timestamp": l.Timestamp,
			"type":      "learning",
		},
	}

	if err := idx.store.Add([]index.Document{doc}); err != nil {
		return err
	}

	return idx.store.Save()
}

// SearchRelevant finds the top N most relevant learnings for a query
func (idx *Indexer) SearchRelevant(ctx context.Context, query string, limit int) ([]Learning, error) {
	if idx.embedder == nil || idx.store == nil {
		return nil, nil
	}

	embs, err := idx.embedder.Embed(ctx, []string{query})
	if err != nil {
		return nil, fmt.Errorf("failed to embed query: %w", err)
	}

	results, err := idx.store.Search(embs[0], limit)
	if err != nil {
		return nil, err
	}

	var learnings []Learning
	for _, res := range results {
		// Reconstruct Learning object (simplified)
		learnings = append(learnings, Learning{
			Key:    res.Document.ID,
			Value:  res.Document.Content, // We might want to parse it back or store Value separately in Metadata
			Source: fmt.Sprintf("%v", res.Document.Metadata["source"]),
		})
	}

	return learnings, nil
}
