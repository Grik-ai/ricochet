package context

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

const defaultMaxContextFragmentTokens = 10000

func normalizeMaxFragmentTokens(value int) int {
	if value <= 0 {
		return defaultMaxContextFragmentTokens
	}
	return value
}

func fragmentHash(content string) string {
	sum := sha1.Sum([]byte(content))
	return hex.EncodeToString(sum[:8])
}

// BuildContextReport produces a bounded, UI-safe accounting of what is about
// to be visible to the model. It intentionally omits raw content from the
// report so diagnostics can be shown without leaking large snippets into UI
// logs or additional prompt material.
func BuildContextReport(systemPrompt string, messages []protocol.Message, maxTokens int, maxFragmentTokens int) protocol.ContextBuildReport {
	maxFragmentTokens = normalizeMaxFragmentTokens(maxFragmentTokens)
	fragments := make([]protocol.ContextContributor, 0, len(messages)+1)
	warnings := make([]string, 0)
	suggestions := make([]string, 0)

	addContributor := func(id, typ, source, content string) {
		tokens := EstimateBudgetedTokens(content)
		if tokens == 0 && strings.TrimSpace(content) == "" {
			return
		}
		percent := 0.0
		if maxTokens > 0 {
			percent = float64(tokens) / float64(maxTokens) * 100
		}
		fragments = append(fragments, protocol.ContextContributor{
			ID:      id,
			Type:    typ,
			Source:  source,
			Tokens:  tokens,
			Percent: percent,
		})
		if tokens > maxFragmentTokens {
			warnings = append(warnings, fmt.Sprintf("%s is large (%d tokens)", id, tokens))
		}
		if maxTokens > 0 && tokens > maxTokens/5 {
			suggestions = append(suggestions, fmt.Sprintf("Reduce %s before the next turn; it is using more than 20%% of the context window.", id))
		}
	}

	addContributor("system_prompt", "system", "prompt", systemPrompt)
	for i, msg := range messages {
		msgID := msg.ID
		if msgID == "" {
			msgID = fmt.Sprintf("message_%03d", i+1)
		}
		if msg.Content != "" {
			addContributor(msgID, "message", msg.Role, msg.Content)
		}
		for _, tu := range msg.ToolUse {
			addContributor(fmt.Sprintf("%s:%s:args", msgID, tu.Name), "tool_use", tu.Name, string(tu.Input))
		}
		for _, tr := range msg.ToolResults {
			source := tr.ToolUseID
			addContributor(fmt.Sprintf("%s:%s:result", msgID, tr.ToolUseID), "tool_result", source, tr.Content)
		}
	}

	total := 0
	for _, contributor := range fragments {
		total += contributor.Tokens
	}
	percentage := 0.0
	if maxTokens > 0 {
		percentage = float64(total) / float64(maxTokens) * 100
	}
	if percentage >= 80 {
		warnings = append(warnings, fmt.Sprintf("Context is %.0f%% full", percentage))
		suggestions = append(suggestions, "Run compaction or narrow file/tool output before starting broad work.")
	}

	sort.SliceStable(fragments, func(i, j int) bool {
		return fragments[i].Tokens > fragments[j].Tokens
	})
	top := fragments
	if len(top) > 8 {
		top = append([]protocol.ContextContributor(nil), top[:8]...)
	} else {
		top = append([]protocol.ContextContributor(nil), top...)
	}

	return protocol.ContextBuildReport{
		TokensUsed:      total,
		TokensMax:       maxTokens,
		Percentage:      percentage,
		Fragments:       fragments,
		TopContributors: top,
		Warnings:        dedupeStrings(warnings),
		Suggestions:     dedupeStrings(suggestions),
		GeneratedAt:     time.Now().UnixMilli(),
	}
}

func NewContextFragment(id, typ, source, content string, priority int, maxTokens int) protocol.ContextFragment {
	maxTokens = normalizeMaxFragmentTokens(maxTokens)
	tokens := EstimateBudgetedTokens(content)
	fragment := protocol.ContextFragment{
		ID:        id,
		Type:      typ,
		Source:    source,
		Priority:  priority,
		Tokens:    tokens,
		MaxTokens: maxTokens,
		Hash:      fragmentHash(content),
		Content:   content,
	}
	if tokens > maxTokens {
		fragment.Content = TrimToApproxTokens(content, maxTokens)
		fragment.Tokens = EstimateBudgetedTokens(fragment.Content)
		fragment.Truncated = true
	}
	return fragment
}

func TrimToApproxTokens(content string, maxTokens int) string {
	maxTokens = normalizeMaxFragmentTokens(maxTokens)
	limit := maxTokens * 4
	if limit <= 0 || len(content) <= limit {
		return content
	}
	if limit < 80 {
		limit = 80
	}
	return strings.TrimSpace(content[:limit]) + "\n[...fragment truncated by Ricochet context budget...]"
}

func PreviewJSON(value any, maxChars int) string {
	if maxChars <= 0 {
		maxChars = 800
	}
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	text := string(data)
	if len(text) <= maxChars {
		return text
	}
	return text[:maxChars] + "..."
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
