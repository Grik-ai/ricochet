package agent

import (
	"bytes"
	"context"
	"crypto/sha1"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	context_manager "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
)

const (
	maxAttachedFileReadBytes = 512 * 1024
	maxAttachedFileTokens    = 1800
	attachmentParseTimeout   = 12 * time.Second
)

var (
	errPDFParserUnavailable = errors.New("pdftotext is not installed")
	errOCRUnavailable       = errors.New("tesseract OCR is not installed")
)

type attachedFileManifestEntry struct {
	Path   string
	Name   string
	Mime   string
	Size   int64
	Status string
	Note   string
}

func (c *Controller) buildContextFileAttachmentContext(content string, attachments []protocol.ContextFileAttachment) string {
	files := mergeContextFileAttachments(attachments, parseLegacyContextFileMentions(content))
	if len(files) == 0 {
		return ""
	}

	ignoreMatcher := safeguard.NewIgnoreMatcher(c.cwd)
	gitIgnore := loadRootGitIgnore(c.cwd)
	var sections []string
	var warnings []string
	var manifest []attachedFileManifestEntry

	for _, file := range files {
		path := strings.TrimSpace(file.Path)
		if path == "" {
			continue
		}
		entry := attachedFileManifestEntry{
			Path:   path,
			Name:   attachedFileDisplayName(file, path),
			Mime:   file.Mime,
			Status: "sent",
			Note:   "included in context_files",
		}
		resolved, rel, err := c.resolveAttachedContextPath(path)
		if err != nil {
			entry.Note = fmt.Sprintf("not readable: %v", err)
			manifest = append(manifest, entry)
			warnings = append(warnings, fmt.Sprintf("%s skipped: %v", path, err))
			continue
		}
		entry.Path = rel
		entry.Name = attachedFileDisplayName(file, rel)
		stagedAttachment := isStagedContextAttachment(file, rel)
		if isAttachmentKind(file) && !stagedAttachment {
			entry.Note = "staged attachments must be under .ricochet/attachments"
			manifest = append(manifest, entry)
			warnings = append(warnings, fmt.Sprintf("%s skipped: %s", rel, entry.Note))
			continue
		}
		if !stagedAttachment {
			if ignored, pattern := ignoreMatcher.IsIgnored(rel); ignored {
				entry.Note = fmt.Sprintf("blocked by .ricochetignore pattern %q", pattern)
				manifest = append(manifest, entry)
				warnings = append(warnings, fmt.Sprintf("%s skipped: %s", rel, entry.Note))
				continue
			}
			if pattern := gitIgnore.match(rel); pattern != "" {
				entry.Note = fmt.Sprintf("blocked by .gitignore pattern %q", pattern)
				manifest = append(manifest, entry)
				warnings = append(warnings, fmt.Sprintf("%s skipped: %s", rel, entry.Note))
				continue
			}
		}

		info, err := os.Stat(resolved)
		if err != nil {
			entry.Note = fmt.Sprintf("not readable: %v", err)
			manifest = append(manifest, entry)
			warnings = append(warnings, fmt.Sprintf("%s skipped: %v", rel, err))
			continue
		}
		entry.Size = info.Size()
		if info.IsDir() {
			entry.Status = "unsupported_binary"
			entry.Note = "directory attachments are not supported yet"
			manifest = append(manifest, entry)
			warnings = append(warnings, fmt.Sprintf("%s skipped: %s", rel, entry.Note))
			continue
		}

		content, truncated, readSource, err := readAttachedTextForContext(resolved, file, rel, info.Size())
		if err != nil {
			entry.Status, entry.Note = attachmentReadFailureStatus(file, rel, err)
			manifest = append(manifest, entry)
			warnings = append(warnings, fmt.Sprintf("%s skipped: %s", rel, entry.Note))
			continue
		}

		entry.Status = "included_text"
		entry.Note = readSource
		manifest = append(manifest, entry)
		hash := sha1.Sum([]byte(content))
		fragment := context_manager.NewContextFragment("attached:"+rel, "file", rel, content, 90, maxAttachedFileTokens)
		truncated = truncated || fragment.Truncated
		section := fmt.Sprintf("#### %s\n- size: %d bytes\n- status: included_text\n- source: %s\n- preview_hash: %x\n- truncated: %t\n\n```%s\n%s\n```",
			rel,
			info.Size(),
			readSource,
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

	if len(sections) == 0 && len(warnings) == 0 && len(manifest) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n\n### Attached Files\n")
	sb.WriteString("The user attached these files for this turn. The manifest lists every sent file; only `included_text` files have readable snippets below.\n\n")
	for _, entry := range manifest {
		sb.WriteString("- ")
		sb.WriteString(formatAttachedFileManifestEntry(entry))
		sb.WriteString("\n")
	}
	if len(manifest) > 0 {
		sb.WriteString("\n")
	}
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

func attachedFileDisplayName(file protocol.ContextFileAttachment, fallbackPath string) string {
	name := strings.TrimSpace(file.Name)
	if name != "" {
		return name
	}
	return filepath.Base(strings.TrimSpace(fallbackPath))
}

func formatAttachedFileManifestEntry(entry attachedFileManifestEntry) string {
	parts := []string{fmt.Sprintf("`%s`", entry.Name)}
	if entry.Path != "" && entry.Path != entry.Name {
		parts = append(parts, fmt.Sprintf("path: `%s`", entry.Path))
	}
	if entry.Mime != "" {
		parts = append(parts, "mime: "+entry.Mime)
	}
	if entry.Size > 0 {
		parts = append(parts, fmt.Sprintf("size: %d bytes", entry.Size))
	}
	parts = append(parts, "status: "+entry.Status)
	if entry.Note != "" {
		parts = append(parts, "note: "+entry.Note)
	}
	return strings.Join(parts, "; ")
}

func readAttachedTextForContext(path string, file protocol.ContextFileAttachment, rel string, size int64) (string, bool, string, error) {
	switch {
	case isPDFAttachment(file, rel):
		text, truncated, err := readAttachedPDFText(path)
		return text, truncated, "pdftotext", err
	case isRasterImageAttachment(file, rel):
		text, truncated, err := readAttachedImageOCRText(path)
		return text, truncated, "tesseract_ocr", err
	}

	if isAttachmentKind(file) {
		mime := normalizedAttachmentMime(file)
		if mime != "" && !isTextLikeAttachmentMime(mime) {
			return "", false, "", fmt.Errorf("binary attachment content is not readable by the model yet")
		}
	}

	content, truncated, err := readAttachedFilePreview(path, size)
	if err != nil {
		return "", false, "", err
	}
	if looksBinary(content) {
		return "", false, "", fmt.Errorf("binary file context is not readable yet")
	}
	return content, truncated, "text_preview", nil
}

func attachmentReadFailureStatus(file protocol.ContextFileAttachment, rel string, err error) (string, string) {
	message := strings.TrimSpace(err.Error())
	switch {
	case isPDFAttachment(file, rel):
		if errors.Is(err, errPDFParserUnavailable) {
			return "needs_pdf_parse", "pdftotext is not installed; PDF text was not included"
		}
		return "needs_pdf_parse", "PDF text was not included: " + message
	case isRasterImageAttachment(file, rel):
		if errors.Is(err, errOCRUnavailable) {
			return "needs_ocr", "tesseract OCR is not installed; image text was not included"
		}
		return "needs_ocr", "image OCR text was not included: " + message
	default:
		return "unsupported_binary", message
	}
}

func isPDFAttachment(file protocol.ContextFileAttachment, rel string) bool {
	mime := normalizedAttachmentMime(file)
	return mime == "application/pdf" || strings.EqualFold(filepath.Ext(rel), ".pdf")
}

func isRasterImageAttachment(file protocol.ContextFileAttachment, rel string) bool {
	mime := normalizedAttachmentMime(file)
	ext := strings.ToLower(filepath.Ext(rel))
	if mime == "image/svg+xml" {
		return false
	}
	if ext == ".svg" {
		return false
	}
	return strings.HasPrefix(mime, "image/") || isImageAttachmentExtension(ext)
}

func normalizedAttachmentMime(file protocol.ContextFileAttachment) string {
	return strings.ToLower(strings.TrimSpace(strings.Split(file.Mime, ";")[0]))
}

func isImageAttachmentExtension(ext string) bool {
	switch ext {
	case ".avif", ".bmp", ".gif", ".heic", ".heif", ".jpg", ".jpeg", ".png", ".svg", ".webp":
		return true
	default:
		return false
	}
}

func isTextLikeAttachmentMime(mime string) bool {
	if strings.HasPrefix(mime, "text/") {
		return true
	}
	switch mime {
	case "application/json",
		"application/xml",
		"application/javascript",
		"application/x-javascript",
		"application/typescript",
		"application/x-typescript",
		"application/x-sh",
		"application/graphql",
		"application/ld+json",
		"application/toml",
		"application/yaml",
		"application/x-yaml",
		"image/svg+xml":
		return true
	default:
		return false
	}
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

func readAttachedPDFText(path string) (string, bool, error) {
	binary, err := lookLocalAttachmentTool("pdftotext")
	if err != nil {
		return "", false, errPDFParserUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), attachmentParseTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-layout", "-q", path, "-")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", false, fmt.Errorf("pdftotext timed out")
		}
		return "", false, fmt.Errorf("pdftotext failed: %s", strings.TrimSpace(stderr.String()))
	}
	return boundedAttachedToolOutput(stdout.String(), "pdftotext produced no text")
}

func readAttachedImageOCRText(path string) (string, bool, error) {
	binary, err := lookLocalAttachmentTool("tesseract")
	if err != nil {
		return "", false, errOCRUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), attachmentParseTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, path, "stdout", "--psm", "6")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", false, fmt.Errorf("tesseract OCR timed out")
		}
		return "", false, fmt.Errorf("tesseract OCR failed: %s", strings.TrimSpace(stderr.String()))
	}
	return boundedAttachedToolOutput(stdout.String(), "tesseract OCR produced no text")
}

func lookLocalAttachmentTool(name string) (string, error) {
	if binary, err := exec.LookPath(name); err == nil {
		return binary, nil
	}
	if os.Getenv("RICOCHET_DISABLE_ATTACHMENT_TOOL_FALLBACK") == "1" {
		return "", os.ErrNotExist
	}
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"} {
		candidate := filepath.Join(dir, name)
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			return candidate, nil
		}
	}
	return "", os.ErrNotExist
}

func boundedAttachedToolOutput(text string, emptyMessage string) (string, bool, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false, errors.New(emptyMessage)
	}
	if len(text) > maxAttachedFileReadBytes {
		return text[:maxAttachedFileReadBytes], true, nil
	}
	return text, false, nil
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
