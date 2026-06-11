package context

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

const (
	defaultCompressionMaxTokens = 1400
	defaultCompressionMinTokens = 3200
)

type ContextCompressor struct {
	StoreDir     string
	MaxTokens    int
	MinTokens    int
	PreviewLines int
	PreviewTail  int
}

type storedContextOriginal struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Source    string `json:"source,omitempty"`
	Hash      string `json:"hash"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"created_at"`
}

func DefaultCompressionStoreDir() string {
	if dir := os.Getenv("RICOCHET_CONTEXT_STORE"); dir != "" {
		return dir
	}
	if cacheDir, err := os.UserCacheDir(); err == nil && cacheDir != "" {
		return filepath.Join(cacheDir, "ricochet", "context-originals")
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		return filepath.Join(os.TempDir(), "ricochet-context-originals")
	}
	return filepath.Join(home, ".ricochet", "context-originals")
}

func NewContextCompressor(storeDir string) *ContextCompressor {
	if storeDir == "" {
		storeDir = DefaultCompressionStoreDir()
	}
	return &ContextCompressor{
		StoreDir:     storeDir,
		MaxTokens:    defaultCompressionMaxTokens,
		MinTokens:    defaultCompressionMinTokens,
		PreviewLines: 80,
		PreviewTail:  40,
	}
}

func (c *ContextCompressor) CompressMessages(messages []protocol.Message) ([]protocol.Message, *protocol.ContextCompressionReport) {
	if c == nil {
		return messages, nil
	}
	if c.MaxTokens <= 0 {
		c.MaxTokens = defaultCompressionMaxTokens
	}
	if c.MinTokens <= 0 {
		c.MinTokens = defaultCompressionMinTokens
	}

	toolNames := map[string]string{}
	for _, msg := range messages {
		for _, tu := range msg.ToolUse {
			toolNames[tu.ID] = tu.Name
		}
	}

	report := &protocol.ContextCompressionReport{
		Enabled:     true,
		GeneratedAt: time.Now().UnixMilli(),
	}
	out := make([]protocol.Message, len(messages))
	copy(out, messages)

	for mi := range out {
		msg := out[mi]
		if msg.Content != "" && shouldCompressMessage(msg) {
			kind := "history"
			id := msg.ID
			if id == "" {
				id = fmt.Sprintf("message_%03d", mi+1)
			}
			compressed, fragment, ok := c.compressText(id, kind, msg.Role, msg.Content)
			if ok {
				msg.Content = compressed
				report.Fragments = append(report.Fragments, fragment)
			}
		}
		for ri := range msg.ToolResults {
			tr := msg.ToolResults[ri]
			name := toolNames[tr.ToolUseID]
			kind := compressionKindForTool(name)
			compressed, fragment, ok := c.compressText("tool_result_"+tr.ToolUseID, kind, name, tr.Content)
			if ok {
				tr.Content = compressed
				msg.ToolResults[ri] = tr
				report.Fragments = append(report.Fragments, fragment)
			}
		}
		out[mi] = msg
	}

	if len(report.Fragments) == 0 {
		return messages, nil
	}
	for _, fragment := range report.Fragments {
		report.OriginalTokens += fragment.OriginalTokens
		report.CompressedTokens += fragment.CompressedTokens
		report.SavedTokens += fragment.SavedTokens
	}
	sort.SliceStable(report.Fragments, func(i, j int) bool {
		return report.Fragments[i].SavedTokens > report.Fragments[j].SavedTokens
	})
	return out, report
}

func (c *ContextCompressor) compressText(id, kind, source, content string) (string, protocol.ContextCompressionFragment, bool) {
	originalTokens := EstimateBudgetedTokens(content)
	if originalTokens < c.MinTokens {
		return content, protocol.ContextCompressionFragment{}, false
	}
	hash := contentSHA(content)
	storeKey := hash + ".json"
	_ = c.storeOriginal(storeKey, storedContextOriginal{
		ID:        id,
		Type:      kind,
		Source:    source,
		Hash:      hash,
		Content:   content,
		CreatedAt: time.Now().UnixMilli(),
	})

	preview := c.preview(content)
	compressed := fmt.Sprintf(
		"[Ricochet compressed %s `%s`: %d -> %d approx tokens. Original is stored locally as hash %s. Use retrieve_context_original with hash `%s` and optional line range when exact content is needed.]\n%s",
		kind,
		id,
		originalTokens,
		EstimateBudgetedTokens(preview),
		hash,
		hash,
		preview,
	)
	compressedTokens := EstimateBudgetedTokens(compressed)
	if compressedTokens >= originalTokens {
		return content, protocol.ContextCompressionFragment{}, false
	}
	return compressed, protocol.ContextCompressionFragment{
		ID:               id,
		Type:             kind,
		Source:           source,
		Hash:             hash,
		OriginalTokens:   originalTokens,
		CompressedTokens: compressedTokens,
		SavedTokens:      originalTokens - compressedTokens,
		StoreKey:         storeKey,
	}, true
}

func (c *ContextCompressor) preview(content string) string {
	lines := strings.Split(content, "\n")
	if len(lines) <= c.PreviewLines+c.PreviewTail {
		return TrimToApproxTokens(content, c.MaxTokens)
	}
	head := append([]string(nil), lines[:c.PreviewLines]...)
	tail := append([]string(nil), lines[len(lines)-c.PreviewTail:]...)
	preview := strings.Join(head, "\n") +
		fmt.Sprintf("\n\n[...Ricochet compressed %d middle lines...]\n\n", len(lines)-len(head)-len(tail)) +
		strings.Join(tail, "\n")
	return TrimToApproxTokens(preview, c.MaxTokens)
}

func (c *ContextCompressor) storeOriginal(storeKey string, record storedContextOriginal) error {
	if c.StoreDir == "" {
		return nil
	}
	if err := os.MkdirAll(c.StoreDir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(c.StoreDir, storeKey), data, 0600)
}

func RetrieveContextOriginal(storeDir, hash string, startLine, endLine int) (string, error) {
	if hash == "" {
		return "", fmt.Errorf("hash is required")
	}
	if storeDir == "" {
		storeDir = DefaultCompressionStoreDir()
	}
	data, err := os.ReadFile(filepath.Join(storeDir, hash+".json"))
	if err != nil {
		return "", err
	}
	var record storedContextOriginal
	if err := json.Unmarshal(data, &record); err != nil {
		return "", err
	}
	if startLine <= 0 && endLine <= 0 {
		return record.Content, nil
	}
	lines := strings.Split(record.Content, "\n")
	if startLine <= 0 {
		startLine = 1
	}
	if endLine <= 0 || endLine > len(lines) {
		endLine = len(lines)
	}
	if startLine > endLine || startLine > len(lines) {
		return "", fmt.Errorf("line range %d-%d is outside original content", startLine, endLine)
	}
	return strings.Join(lines[startLine-1:endLine], "\n"), nil
}

func shouldCompressMessage(msg protocol.Message) bool {
	if msg.Role == "system" {
		return false
	}
	return EstimateBudgetedTokens(msg.Content) >= defaultCompressionMinTokens
}

func compressionKindForTool(toolName string) string {
	switch toolName {
	case "execute_command", "read_terminal", "command_status":
		return "command_log"
	case "read_file", "read_definitions", "get_symbols":
		return "file_snippet"
	case "codebase_search", "web_search", "grep_search":
		return "rag_chunk"
	default:
		return "tool_output"
	}
}

func contentSHA(content string) string {
	sum := sha1.Sum([]byte(content))
	return hex.EncodeToString(sum[:])
}
