package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/index"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type WorkspaceGraphTool struct {
	NameValue string
	Manager   *index.WorkspaceIndexManager
}

func (t *WorkspaceGraphTool) Definition() protocol.Tool {
	switch t.NameValue {
	case "graph_status":
		return protocol.Tool{
			Name:        "graph_status",
			Description: "Return local workspace graph/index status. Use before broad codebase exploration to know whether local project intelligence is ready or stale.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
		}
	case "graph_explore":
		return protocol.Tool{
			Name:        "graph_explore",
			Description: "Explore the most important indexed files in the local workspace graph without reading full files. Returns path, language, size, imports, definition counts, and stale warnings.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"limit": map[string]interface{}{"type": "integer", "description": "Maximum files to return (default 40)"},
				},
			},
		}
	case "route_lookup":
		return protocol.Tool{
			Name:        "route_lookup",
			Description: "Find likely files/routes/modules for a query using the local workspace graph. Use this before broad grep/read when navigating unfamiliar code.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "Path, module, feature, file name, import, or language hint"},
					"limit": map[string]interface{}{"type": "integer", "description": "Maximum results (default 20)"},
				},
				"required": []string{"query"},
			},
		}
	case "dependency_trace":
		return protocol.Tool{
			Name:        "dependency_trace",
			Description: "Show files imported by a target file/module and files that appear to import it. Use before edits to understand impact radius.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path_or_import": map[string]interface{}{"type": "string", "description": "Workspace path or import/module suffix"},
					"limit":          map[string]interface{}{"type": "integer", "description": "Maximum dependencies/dependents per side (default 30)"},
				},
				"required": []string{"path_or_import"},
			},
		}
	case "symbol_impact":
		return protocol.Tool{
			Name:        "symbol_impact",
			Description: "Estimate impact radius for a symbol or file using local graph route lookup and dependency trace. Read exact files before editing.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"symbol": map[string]interface{}{"type": "string", "description": "Symbol, file path, module, or import name"},
					"limit":  map[string]interface{}{"type": "integer", "description": "Maximum results (default 20)"},
				},
				"required": []string{"symbol"},
			},
		}
	default:
		return protocol.Tool{Name: t.NameValue, Description: "Workspace graph tool", InputSchema: map[string]interface{}{"type": "object"}}
	}
}

func (t *WorkspaceGraphTool) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	if t.Manager == nil {
		return "", fmt.Errorf("workspace graph is not initialized")
	}
	switch t.NameValue {
	case "graph_status":
		return marshalGraphResult(t.Manager.Status())
	case "graph_explore":
		var payload struct {
			Limit int `json:"limit"`
		}
		_ = json.Unmarshal(args, &payload)
		return marshalGraphResult(map[string]interface{}{
			"status": t.Manager.Status(),
			"files":  t.Manager.Explore(payload.Limit),
			"note":   "If any result has stale=true, read the live file before using it for edits.",
		})
	case "route_lookup":
		var payload struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := json.Unmarshal(args, &payload); err != nil {
			return "", err
		}
		if strings.TrimSpace(payload.Query) == "" {
			return "", fmt.Errorf("query is required")
		}
		return marshalGraphResult(map[string]interface{}{
			"query":   payload.Query,
			"results": t.Manager.RouteLookup(payload.Query, payload.Limit),
			"note":    "Graph results are navigation hints. Read exact line ranges before making edits.",
		})
	case "dependency_trace":
		var payload struct {
			PathOrImport string `json:"path_or_import"`
			Limit        int    `json:"limit"`
		}
		if err := json.Unmarshal(args, &payload); err != nil {
			return "", err
		}
		if strings.TrimSpace(payload.PathOrImport) == "" {
			return "", fmt.Errorf("path_or_import is required")
		}
		return marshalGraphResult(map[string]interface{}{
			"target": payload.PathOrImport,
			"trace":  t.Manager.DependencyTrace(payload.PathOrImport, payload.Limit),
			"note":   "This is a heuristic impact radius; verify with search/LSP before editing shared code.",
		})
	case "symbol_impact":
		var payload struct {
			Symbol string `json:"symbol"`
			Limit  int    `json:"limit"`
		}
		if err := json.Unmarshal(args, &payload); err != nil {
			return "", err
		}
		if strings.TrimSpace(payload.Symbol) == "" {
			return "", fmt.Errorf("symbol is required")
		}
		matches := t.Manager.RouteLookup(payload.Symbol, payload.Limit)
		trace := t.Manager.DependencyTrace(payload.Symbol, payload.Limit)
		return marshalGraphResult(map[string]interface{}{
			"symbol":       payload.Symbol,
			"likely_files": matches,
			"impact_trace": trace,
			"note":         "Impact is estimated from local graph data. Use LSP/search and read live files before changing behavior.",
		})
	default:
		return "", fmt.Errorf("unknown workspace graph tool: %s", t.NameValue)
	}
}

func marshalGraphResult(value interface{}) (string, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}
