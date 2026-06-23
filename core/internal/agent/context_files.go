package agent

import (
	"crypto/sha1"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	context_manager "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
)

const (
	maxAttachedFileReadBytes = 512 * 1024
	maxAttachedFileTokens    = 1800
)

func (c *Controller) buildContextFileAttachmentContext(content string, attachments []protocol.ContextFileAttachment) string {
	files := mergeContextFileAttachments(attachments, parseLegacyContextFileMentions(content))
	if len(files) == 0 {
		return ""
	}

	ignoreMatcher := safeguard.NewIgnoreMatcher(c.cwd)
	gitIgnore := loadRootGitIgnore(c.cwd)
	var sections []string
	var warnings []string

	for _, file := range files {
		path := strings.TrimSpace(file.Path)
		if path == "" {
			continue
		}
		resolved, rel, err := c.resolveAttachedContextPath(path)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s skipped: %v", path, err))
			continue
		}
		stagedAttachment := isStagedContextAttachment(file, rel)
		if isAttachmentKind(file) && !stagedAttachment {
			warnings = append(warnings, fmt.Sprintf("%s skipped: staged attachments must be under .ricochet/attachments", rel))
			continue
		}
		if !stagedAttachment {
			if ignored, pattern := ignoreMatcher.IsIgnored(rel); ignored {
				warnings = append(warnings, fmt.Sprintf("%s skipped: blocked by .ricochetignore pattern %q", rel, pattern))
				continue
			}
			if pattern := gitIgnore.match(rel); pattern != "" {
				warnings = append(warnings, fmt.Sprintf("%s skipped: blocked by .gitignore pattern %q", rel, pattern))
				continue
			}
		}

		info, err := os.Stat(resolved)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s skipped: %v", rel, err))
			continue
		}
		if info.IsDir() {
			warnings = append(warnings, fmt.Sprintf("%s skipped: directory attachments are not supported yet", rel))
			continue
		}

		content, truncated, err := readAttachedFilePreview(resolved, info.Size())
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s skipped: %v", rel, err))
			continue
		}
		if looksBinary(content) {
			warnings = append(warnings, fmt.Sprintf("%s skipped: binary file context is not supported", rel))
			continue
		}

		hash := sha1.Sum([]byte(content))
		fragment := context_manager.NewContextFragment("attached:"+rel, "file", rel, content, 90, maxAttachedFileTokens)
		truncated = truncated || fragment.Truncated
		section := fmt.Sprintf("#### %s\n- size: %d bytes\n- preview_hash: %x\n- truncated: %t\n\n```%s\n%s\n```",
			rel,
			info.Size(),
			hash[:8],
			truncated,
			languageFenceForPath(rel),
			fragment.Content,
		)
		if truncated {
			section += "\nRead exact line ranges with read_file before relying on omitted content."
		}
		sections = append(sections, section)
	}

	if len(sections) == 0 && len(warnings) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n\n### Attached Workspace Files\n")
	sb.WriteString("The user attached these workspace files for this turn. Snippets are bounded; read exact ranges before editing or quoting.\n\n")
	for _, section := range sections {
		sb.WriteString(section)
		sb.WriteString("\n\n")
	}
	if len(warnings) > 0 {
		sb.WriteString("### Attached File Warnings\n")
		for _, warning := range warnings {
			sb.WriteString("- ")
			sb.WriteString(warning)
			sb.WriteString("\n")
		}
	}
	return sb.String()
}

func isAttachmentKind(file protocol.ContextFileAttachment) bool {
	return strings.EqualFold(file.Kind, "attachment") || strings.EqualFold(file.Source, "attachment")
}

func isStagedContextAttachment(file protocol.ContextFileAttachment, rel string) bool {
	if !isAttachmentKind(file) {
		return false
	}
	cleanRel := filepath.ToSlash(filepath.Clean(rel))
	return strings.HasPrefix(cleanRel, ".ricochet/attachments/")
}

func (c *Controller) resolveAttachedContextPath(input string) (string, string, error) {
	cleanInput := strings.TrimPrefix(strings.TrimSpace(input), "@")
	if cleanInput == "" {
		return "", "", fmt.Errorf("empty path")
	}
	var abs string
	if filepath.IsAbs(cleanInput) {
		abs = filepath.Clean(cleanInput)
	} else {
		abs = filepath.Join(c.cwd, filepath.FromSlash(cleanInput))
	}
	rel, err := filepath.Rel(c.cwd, abs)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", "", fmt.Errorf("path must be inside workspace")
	}
	return abs, filepath.ToSlash(rel), nil
}

func readAttachedFilePreview(path string, size int64) (string, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", false, err
	}
	defer file.Close()

	limit := int64(maxAttachedFileReadBytes)
	if size >= 0 && size < limit {
		limit = size
	}
	data, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		return "", false, err
	}
	return string(data), size > int64(len(data)), nil
}

func looksBinary(content string) bool {
	if content == "" {
		return false
	}
	sample := content
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	return strings.ContainsRune(sample, '\x00')
}

func parseLegacyContextFileMentions(content string) []protocol.ContextFileAttachment {
	lines := strings.Split(content, "\n")
	inBlock := false
	var files []protocol.ContextFileAttachment
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.EqualFold(strings.TrimSuffix(trimmed, ":"), "Context Files") {
			inBlock = true
			continue
		}
		if !inBlock {
			continue
		}
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "@") {
			break
		}
		path := strings.TrimSpace(strings.TrimPrefix(trimmed, "@"))
		if path != "" {
			files = append(files, protocol.ContextFileAttachment{Path: path, Name: filepath.Base(path), Kind: "file"})
		}
	}
	return files
}

func mergeContextFileAttachments(primary []protocol.ContextFileAttachment, legacy []protocol.ContextFileAttachment) []protocol.ContextFileAttachment {
	seen := map[string]bool{}
	out := make([]protocol.ContextFileAttachment, 0, len(primary)+len(legacy))
	for _, file := range append(append([]protocol.ContextFileAttachment(nil), primary...), legacy...) {
		key := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Path), "@"))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		file.Path = key
		if file.Name == "" {
			file.Name = filepath.Base(key)
		}
		if file.Kind == "" {
			file.Kind = "file"
		}
		out = append(out, file)
	}
	return out
}

func contextFileAttachmentPaths(files []protocol.ContextFileAttachment) []string {
	paths := make([]string, 0, len(files)*2)
	for _, file := range files {
		if strings.TrimSpace(file.Path) != "" {
			paths = append(paths, file.Path)
		}
		if strings.TrimSpace(file.StagedPath) != "" {
			paths = append(paths, file.StagedPath)
		}
	}
	return paths
}

func languageFenceForPath(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "tsx"
	case ".js", ".jsx":
		return "javascript"
	case ".rs":
		return "rust"
	case ".py":
		return "python"
	case ".json":
		return "json"
	case ".md", ".mdx":
		return "markdown"
	case ".toml":
		return "toml"
	case ".yaml", ".yml":
		return "yaml"
	default:
		return ""
	}
}

type rootGitIgnore struct {
	patterns []string
}

func loadRootGitIgnore(root string) rootGitIgnore {
	data, err := os.ReadFile(filepath.Join(root, ".gitignore"))
	if err != nil {
		return rootGitIgnore{}
	}
	var patterns []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "!") {
			continue
		}
		patterns = append(patterns, filepath.ToSlash(strings.Trim(line, "/")))
	}
	return rootGitIgnore{patterns: patterns}
}

func (g rootGitIgnore) match(path string) string {
	path = filepath.ToSlash(strings.TrimPrefix(path, "./"))
	for _, pattern := range g.patterns {
		if pattern == "" {
			continue
		}
		if strings.HasSuffix(pattern, "/") {
			pattern = strings.TrimSuffix(pattern, "/")
		}
		if path == pattern || strings.HasPrefix(path, pattern+"/") {
			return pattern
		}
		if ok, _ := filepath.Match(pattern, filepath.Base(path)); ok {
			return pattern
		}
		if ok, _ := filepath.Match(pattern, path); ok {
			return pattern
		}
	}
	return ""
}
