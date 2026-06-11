package context

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

const defaultFoldedContextChars = 20000

func BuildFoldedFileContext(ctx context.Context, root string, files []string, maxChars int) protocol.FoldedFileContext {
	if maxChars <= 0 {
		maxChars = defaultFoldedContextChars
	}
	rootAbs, _ := filepath.Abs(root)
	parser := NewLanguageParser()
	defer parser.Close()

	var sb strings.Builder
	out := protocol.FoldedFileContext{
		Root:        rootAbs,
		MaxChars:    maxChars,
		GeneratedAt: time.Now().UnixMilli(),
	}

	seen := make(map[string]bool, len(files))
	for _, raw := range files {
		path := strings.TrimSpace(raw)
		if path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(rootAbs, path)
		}
		pathAbs, err := filepath.Abs(path)
		if err != nil || !isPathInside(rootAbs, pathAbs) || seen[pathAbs] {
			continue
		}
		seen[pathAbs] = true

		rel, _ := filepath.Rel(rootAbs, pathAbs)
		summary := protocol.FoldedFileSummary{Path: rel, Language: strings.TrimPrefix(strings.ToLower(filepath.Ext(pathAbs)), ".")}
		content, err := os.ReadFile(pathAbs)
		if err != nil {
			summary.Error = err.Error()
			out.Files = append(out.Files, summary)
			continue
		}
		if len(content) > 1_000_000 {
			content = content[:1_000_000]
			summary.Truncated = true
		}

		analysis, err := parser.ParseDefinitions(ctx, pathAbs, content)
		if err != nil {
			summary.Definitions = fallbackOutline(content)
		} else {
			summary.Imports = analysis.Imports
			for _, def := range analysis.Definitions {
				name := strings.TrimSpace(def.Name)
				if name == "" {
					name = "<anonymous>"
				}
				summary.Definitions = append(summary.Definitions, fmt.Sprintf("%s %s lines %d-%d", def.Type, name, def.LineStart, def.LineEnd))
			}
		}

		if len(summary.Definitions) == 0 && len(summary.Imports) == 0 {
			continue
		}
		out.Files = append(out.Files, summary)
		before := sb.Len()
		sb.WriteString(fmt.Sprintf("\n<file-outline path=%q>\n", rel))
		if len(summary.Imports) > 0 {
			sb.WriteString("imports:\n")
			for _, imp := range limitStrings(summary.Imports, 20) {
				sb.WriteString("- " + imp + "\n")
			}
		}
		if len(summary.Definitions) > 0 {
			sb.WriteString("definitions:\n")
			for _, def := range limitStrings(summary.Definitions, 80) {
				sb.WriteString("- " + def + "\n")
			}
		}
		sb.WriteString("</file-outline>\n")
		if sb.Len() > maxChars {
			out.Truncated = true
			out.Content = sb.String()[:maxChars] + "\n[...folded file context truncated by budget...]"
			return out
		}
		if sb.Len() == before {
			continue
		}
	}
	out.Content = strings.TrimSpace(sb.String())
	return out
}

func isPathInside(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")
}

func fallbackOutline(content []byte) []string {
	lines := strings.Split(string(content), "\n")
	out := make([]string, 0)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "func ") ||
			strings.HasPrefix(trimmed, "type ") ||
			strings.HasPrefix(trimmed, "class ") ||
			strings.HasPrefix(trimmed, "def ") ||
			strings.HasPrefix(trimmed, "export function ") ||
			strings.HasPrefix(trimmed, "export class ") ||
			strings.HasPrefix(trimmed, "const ") {
			out = append(out, fmt.Sprintf("%s line %d", compactWhitespace(trimmed), i+1))
		}
		if len(out) >= 80 {
			break
		}
	}
	return out
}

func compactWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func limitStrings(values []string, limit int) []string {
	if limit > 0 && len(values) > limit {
		return values[:limit]
	}
	return values
}
