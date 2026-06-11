package tools

import (
	"context"
	"encoding/json"
	"fmt"

	contextPkg "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type RetrieveContextOriginalTool struct{}

func (t *RetrieveContextOriginalTool) Definition() protocol.Tool {
	return protocol.Tool{
		Name:        "retrieve_context_original",
		Description: "Retrieve locally stored original content for a Ricochet-compressed context fragment by hash, optionally limited to a line range.",
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"hash":       map[string]interface{}{"type": "string", "description": "Hash shown in the compressed fragment"},
				"start_line": map[string]interface{}{"type": "integer", "description": "Optional 1-based start line"},
				"end_line":   map[string]interface{}{"type": "integer", "description": "Optional 1-based end line"},
			},
			"required": []string{"hash"},
		},
	}
}

func (t *RetrieveContextOriginalTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var payload struct {
		Hash      string `json:"hash"`
		StartLine int    `json:"start_line"`
		EndLine   int    `json:"end_line"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return "", err
	}
	content, err := contextPkg.RetrieveContextOriginal("", payload.Hash, payload.StartLine, payload.EndLine)
	if err != nil {
		return "", fmt.Errorf("failed to retrieve compressed original: %w", err)
	}
	return content, nil
}
