package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// IntelligenceTool stores permanent lessons for the agent
type IntelligenceTool struct {
	category string
	content  string
	storeFn  func(category, content string) error
}

func NewIntelligenceTool(storeFn func(category, content string) error) *IntelligenceTool {
	return &IntelligenceTool{storeFn: storeFn}
}

func (t *IntelligenceTool) Name() string {
	return "store_lesson"
}

func (t *IntelligenceTool) Description() string {
	return "Store a permanent lesson or project-specific rule in the agent's long-term memory. Use this when you find a recurring pattern, a bug fix that was hard to find, or a project-specific convention that should be remembered in future sessions."
}

func (t *IntelligenceTool) InputSchema() string {
	return `{
		"type": "object",
		"properties": {
			"category": {
				"type": "string",
				"description": "Short category name (e.g., 'styling', 'database', 'deploy')"
			},
			"content": {
				"type": "string",
				"description": "The lesson content, including code snippets or specific instructions."
			}
		},
		"required": ["category", "content"]
	}`
}

func (t *IntelligenceTool) Definition() protocol.Tool {
	var inputSchema map[string]interface{}
	_ = json.Unmarshal([]byte(t.InputSchema()), &inputSchema)

	return protocol.Tool{
		Name:        t.Name(),
		Description: t.Description(),
		InputSchema: inputSchema,
	}
}

func (t *IntelligenceTool) Execute(ctx context.Context, argsRaw json.RawMessage) (string, error) {
	var args map[string]interface{}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	category, _ := args["category"].(string)
	content, _ := args["content"].(string)

	if category == "" || content == "" {
		return "", fmt.Errorf("category and content are required")
	}

	err := t.storeFn(category, content)
	if err != nil {
		return "", fmt.Errorf("failed to store lesson: %w", err)
	}

	return fmt.Sprintf("✅ Lesson stored successfully in category: %s", category), nil
}

func (t *IntelligenceTool) Category() ToolCategory {
	return CategoryMeta
}
