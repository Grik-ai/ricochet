package context

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// ContextSettings mirrors config.ContextSettings for internal use
type ContextSettings struct {
	AutoCondense         bool
	CondenseThreshold    int
	SlidingWindowSize    int
	ShowContextIndicator bool
	MaxFragmentTokens    int
	ShowContributorPanel bool
}

// ContextResult contains the result of context management
type ContextResult struct {
	Messages     []protocol.Message
	WasCondensed bool
	WasTruncated bool
	Summary      string
	SystemPrompt string // Modified system prompt (e.g. with Condensed Context)
	TokensBefore int
	TokensUsed   int
	TokensMax    int
	Percentage   float64
	Report       *protocol.ContextBuildReport
}

// WindowManager handles context window optimization
type WindowManager struct {
	MaxTokens       int
	Settings        *ContextSettings
	CondenseManager *CondenseManager
}

// NewWindowManager creates a new window manager
func NewWindowManager(maxTokens int) *WindowManager {
	threshold := 70
	if val := os.Getenv("RICOCHET_COMPACT_PCT"); val != "" {
		if i, err := strconv.Atoi(val); err == nil {
			if i > 0 && i <= 100 {
				threshold = i
			}
		}
	}

	return &WindowManager{
		MaxTokens: maxTokens,
		Settings: &ContextSettings{
			AutoCondense:         true,
			CondenseThreshold:    threshold,
			SlidingWindowSize:    20,
			ShowContextIndicator: true,
			MaxFragmentTokens:    defaultMaxContextFragmentTokens,
			ShowContributorPanel: true,
		},
	}
}

// NewWindowManagerWithSettings creates a window manager with custom settings
func NewWindowManagerWithSettings(maxTokens int, settings *ContextSettings, condenseProvider CondenseProvider) *WindowManager {
	// Apply override if not provided in settings
	if settings != nil && os.Getenv("RICOCHET_COMPACT_PCT") != "" {
		if i, err := strconv.Atoi(os.Getenv("RICOCHET_COMPACT_PCT")); err == nil {
			settings.CondenseThreshold = i
		}
	}

	wm := &WindowManager{
		MaxTokens: maxTokens,
		Settings:  settings,
	}

	if settings != nil && settings.AutoCondense && condenseProvider != nil {
		wm.CondenseManager = NewCondenseManager(maxTokens, settings.CondenseThreshold, condenseProvider)
	}

	return wm
}

type toolCallKey struct {
	Name string
	Args string
}

// ManageContext is the main entry point for context management (The Tengu Flow)
func (wm *WindowManager) ManageContext(ctx context.Context, messages []protocol.Message, systemPrompt string) (*ContextResult, error) {
	result := &ContextResult{
		Messages:     messages,
		SystemPrompt: systemPrompt,
		TokensMax:    wm.MaxTokens,
	}

	// TIER 1: Optimize & Microcompact (Non-destructive, local)
	messages = wm.OptimizeToolResults(messages)
	messages = wm.Microcompact(messages) // Refactored from EvictFileContent
	tokensBeforeCompression := EstimateBudgetedTokens(systemPrompt)
	for _, msg := range messages {
		tokensBeforeCompression += EstimateMessageBudgetedTokens(msg)
	}
	compressionReport := wm.compressMessages(&messages)
	result.Messages = messages

	// Calculate usage after microcompaction
	sysTokens := EstimateBudgetedTokens(systemPrompt)
	totalTokens := sysTokens
	for _, msg := range messages {
		totalTokens += EstimateMessageBudgetedTokens(msg)
	}
	result.TokensUsed = totalTokens
	result.TokensBefore = tokensBeforeCompression
	result.Percentage = float64(totalTokens) / float64(wm.MaxTokens) * 100
	report := BuildContextReport(systemPrompt, messages, wm.MaxTokens, wm.maxFragmentTokens())
	report.Compression = compressionReport
	result.Report = &report

	log.Printf("[Context] Tier 1 usage: %d/%d (%.1f%%)", totalTokens, wm.MaxTokens, result.Percentage)

	// Check if already within limits
	if result.Percentage < float64(wm.Settings.CondenseThreshold) {
		return result, nil
	}

	// TIER 2: Full Compaction (LLM Summarization)
	if wm.Settings != nil && wm.Settings.AutoCondense && wm.CondenseManager != nil {
		shouldCondense, _ := wm.CondenseManager.ShouldCondense(messages, systemPrompt)
		if shouldCondense {
			log.Printf("[Context] Tier 2: Threshold reached, attempting LLM condensation...")
			condenseResult, err := wm.CondenseManager.Condense(ctx, messages, systemPrompt)
			if err == nil && condenseResult.WasCondensed {
				result.Messages = condenseResult.Messages
				result.WasCondensed = true
				result.Summary = condenseResult.Summary
				result.TokensBefore = condenseResult.TokensBefore
				result.TokensUsed = condenseResult.TokensAfter
				result.Percentage = float64(condenseResult.TokensAfter) / float64(wm.MaxTokens) * 100
				report := BuildContextReport(systemPrompt, result.Messages, wm.MaxTokens, wm.maxFragmentTokens())
				report.Compression = compressionReport
				result.Report = &report
				return result, nil
			}
			log.Printf("[Context] Tier 2: Full condensation failed/skipped. Falling back to Tier 3.")
		}
	}

	// TIER 3: Snip Compaction (Historical Truncation)
	if result.Percentage >= 90.0 || totalTokens > wm.MaxTokens {
		log.Printf("[Context] Tier 3: Emergency limit reached, snipping history...")

		// PHASE 4: Distill the history about to be pruned
		if wm.Settings != nil && wm.CondenseManager != nil && len(messages) > 10 {
			// Try to summarize the portion that will likely be pruned
			pruneCandidate := messages[:len(messages)-6] // Keep last 6 intact for summary focus
			summaryPrompt := wm.CondenseManager.buildCondensePrompt(pruneCandidate)
			summary, err := wm.CondenseManager.Provider.Summarize(ctx, summaryPrompt)
			if err == nil {
				result.Summary = summary
				log.Printf("[Context] Tier 3: Successfully generated tombstone summary for pruned history.")
			} else {
				log.Printf("[Context] Tier 3: Failed to generate summary: %v", err)
			}
		}

		pruned := wm.PruneMessages(messages, systemPrompt)
		result.Messages = pruned
		result.WasTruncated = true

		// Recalculate
		newTokens := EstimateBudgetedTokens(systemPrompt)
		for _, msg := range pruned {
			newTokens += EstimateMessageBudgetedTokens(msg)
		}
		result.TokensUsed = newTokens
		result.Percentage = float64(newTokens) / float64(wm.MaxTokens) * 100
		report := BuildContextReport(systemPrompt, result.Messages, wm.MaxTokens, wm.maxFragmentTokens())
		report.Compression = compressionReport
		result.Report = &report
	}

	return result, nil
}

func (wm *WindowManager) compressMessages(messages *[]protocol.Message) *protocol.ContextCompressionReport {
	if wm == nil || messages == nil {
		return nil
	}
	compressor := NewContextCompressor("")
	if wm.Settings != nil && wm.Settings.MaxFragmentTokens > 0 {
		compressor.MaxTokens = wm.Settings.MaxFragmentTokens
	}
	compressed, report := compressor.CompressMessages(*messages)
	if report == nil {
		return nil
	}
	*messages = compressed
	return report
}

func (wm *WindowManager) maxFragmentTokens() int {
	if wm == nil || wm.Settings == nil {
		return defaultMaxContextFragmentTokens
	}
	return normalizeMaxFragmentTokens(wm.Settings.MaxFragmentTokens)
}

// PruneMessages reduces the message list to fit within MaxTokens.
// It preserves the System Prompt (usually handled separately) and the most recent messages.
// This is a simple sliding window approach enhanced with file content eviction.
// IMPORTANT: This function ensures that tool result messages are always kept together
// with their corresponding assistant message containing tool_calls to avoid API errors.
func (wm *WindowManager) PruneMessages(messages []protocol.Message, systemPrompt string) []protocol.Message {
	// 0. Evict large file contents from old messages first to save tokens
	messages = wm.Microcompact(messages)

	// 1. Calculate tokens reserved for System Prompt
	sysTokens := EstimateBudgetedTokens(systemPrompt)
	availableTokens := wm.MaxTokens - sysTokens

	// Safety buffer (budgeted)
	availableTokens -= 1000

	if availableTokens <= 0 {
		// Extreme edge case: System prompt is too huge.
		// Return only last message or handle gracefully.
		if len(messages) > 0 {
			return messages[len(messages)-1:]
		}
		return messages
	}

	if len(messages) <= 2 {
		return messages
	}

	// Always keep the first message (initial task/system)
	firstMsg := messages[0]
	firstMsgTokens := EstimateMessageBudgetedTokens(firstMsg)
	availableTokens -= firstMsgTokens

	// Special handling: if first message is System, also try to pin the first User message (the actual objective)
	var secondPinnedMsg *protocol.Message
	if firstMsg.Role == "system" && len(messages) > 1 {
		secondMsg := messages[1]
		if secondMsg.Role == "user" {
			secondMsgTokens := EstimateMessageBudgetedTokens(secondMsg)
			if secondMsgTokens < availableTokens/2 { // Only pin if it doesn't take up more than half the remaining window
				secondPinnedMsg = &secondMsg
				availableTokens -= secondMsgTokens
			}
		}
	}

	if len(messages) == 0 {
		return messages
	}

	// PASS 1: Scan from the end to collect all tool result IDs that we will keep.
	// This helps us know which assistant messages with tool_calls are required.
	requiredToolCalls := make(map[string]bool)
	currentTokens := 0
	cutoffIndex := 1 // Index where we stop keeping messages (exclusive from start)

	// First pass: determine what we can keep and collect required tool call IDs
	for i := len(messages) - 1; i >= 1; i-- {
		msg := messages[i]
		tokens := EstimateMessageBudgetedTokens(msg)

		// Hard limit: always keep at least 3 most recent messages if we have them
		// and they are not huge (more than 20% of window each)
		isRecent := i >= len(messages)-3
		isSmall := tokens < availableTokens/5

		// Check if adding this message would exceed the limit
		if currentTokens+tokens > availableTokens && !(isRecent && isSmall) {
			// If we are at the very last message and it's still too big, we HAVE to cut it
			// though usually we keep at least the last message.
			if i == len(messages)-1 {
				cutoffIndex = i
				currentTokens += tokens
			} else {
				cutoffIndex = i + 1
			}
			break
		}

		// Track tool results - we need their corresponding assistant messages
		if msg.Role == "user" && len(msg.ToolResults) > 0 {
			for _, tr := range msg.ToolResults {
				requiredToolCalls[tr.ToolUseID] = true
			}
		}

		currentTokens += tokens
		cutoffIndex = i
	}

	// PASS 2: Extend the cutoff backwards to include any required assistant messages
	// that have tool_calls corresponding to our collected tool results.
	for cutoffIndex > 1 {
		// Check if messages in our "keep" range have tool results
		// that require an assistant message before the cutoff
		needsExtension := false

		for i := cutoffIndex; i < len(messages); i++ {
			msg := messages[i]
			if msg.Role == "user" && len(msg.ToolResults) > 0 {
				for _, tr := range msg.ToolResults {
					// Look backwards for the assistant message with this tool call
					for j := i - 1; j >= 1 && j >= cutoffIndex-1; j-- {
						prevMsg := messages[j]
						if prevMsg.Role == "assistant" && len(prevMsg.ToolUse) > 0 {
							for _, tu := range prevMsg.ToolUse {
								if tu.ID == tr.ToolUseID && j < cutoffIndex {
									// This assistant message is before our cutoff but required!
									cutoffIndex = j
									needsExtension = true
									break
								}
							}
						}
						if needsExtension {
							break
						}
					}
					if needsExtension {
						break
					}
				}
			}
			if needsExtension {
				break
			}
		}

		if !needsExtension {
			break
		}
	}

	// Build the keep list
	keep := messages[cutoffIndex:]

	// PASS 3: Final validation - ensure no orphaned tool results
	// Check that for every tool result, its corresponding assistant message is present
	keptToolCalls := make(map[string]bool)
	for _, msg := range keep {
		if msg.Role == "assistant" && len(msg.ToolUse) > 0 {
			for _, tu := range msg.ToolUse {
				keptToolCalls[tu.ID] = true
			}
		}
	}

	// Filter out any orphaned tool results
	var validKeep []protocol.Message
	for _, msg := range keep {
		if msg.Role == "user" && len(msg.ToolResults) > 0 {
			// Check if all tool results have their corresponding tool calls
			allValid := true
			for _, tr := range msg.ToolResults {
				if !keptToolCalls[tr.ToolUseID] {
					allValid = false
					log.Printf("Warning: removing orphaned tool result for tool call %s", tr.ToolUseID)
					break
				}
			}
			if !allValid {
				// Remove this message's tool results to avoid API error
				// Create a copy without tool results
				cleanMsg := protocol.Message{
					Role:    msg.Role,
					Content: msg.Content,
				}
				if cleanMsg.Content != "" {
					validKeep = append(validKeep, cleanMsg)
				}
				continue
			}
		}
		validKeep = append(validKeep, msg)
	}

	// 3. Construct final list with markers and pinned messages
	finalResult := []protocol.Message{firstMsg}
	if secondPinnedMsg != nil {
		finalResult = append(finalResult, *secondPinnedMsg)
	}

	if len(validKeep) < (len(messages)-1) && !(secondPinnedMsg != nil && len(validKeep) == len(messages)-2) {
		numPruned := len(messages) - 1 - len(validKeep)
		if secondPinnedMsg != nil {
			numPruned--
		}
		if numPruned > 0 {
			marker := protocol.Message{
				Role:    "user",
				Content: fmt.Sprintf("[Notice: %d older messages were hidden to stay within context limits. Context safety margin (fudge) applied.]", numPruned),
			}
			finalResult = append(finalResult, marker)
		}
	}
	finalResult = append(finalResult, validKeep...)

	return finalResult
}

// Microcompact (Tier 1) replaces large tool results with a placeholder for messages that are not recent.
// This is non-destructive to the summary, it only cleans out raw data to preserve reasoning tokens.
func (wm *WindowManager) Microcompact(messages []protocol.Message) []protocol.Message {
	// We keep the last 6 messages (3 turns) fully intact.
	keepIntact := 6
	if len(messages) <= keepIntact {
		return messages
	}

	// Work on a copy
	result := make([]protocol.Message, len(messages))
	copy(result, messages)

	clearedCount := 0
	// Process messages before the intact window, skipping the first (pinned) message
	for i := 1; i < len(result)-keepIntact; i++ {
		msg := &result[i]
		// If it's a user message containing tool results (which are usually the large ones)
		if msg.Role == "user" && len(msg.ToolResults) > 0 {
			for idx := range msg.ToolResults {
				tr := &msg.ToolResults[idx]
				// If content is large (>1024 chars), evict it
				if len(tr.Content) > 1024 {
					oldLen := len(tr.Content)
					tr.Content = fmt.Sprintf("[History: Tool Result from %s cleared (was %d chars) for context window efficiency]", tr.ToolUseID, oldLen)
					clearedCount++
				}
			}
		}
	}

	if clearedCount > 0 {
		log.Printf("[Context] Microcompact: Cleared %d heavy tool results from history.", clearedCount)
	}

	return result
}

// OptimizeToolResults reduces redundant tool outputs (like reading the same file multiple times)
func (wm *WindowManager) OptimizeToolResults(messages []protocol.Message) []protocol.Message {
	// Map to track the last seen result for each unique tool call
	// key: toolName + arguments
	// value: index of the message and index of the tool result block
	type resultPos struct {
		msgIdx    int
		resultIdx int
	}
	lastResults := make(map[toolCallKey]resultPos)

	// We need to look at assistant messages to find tool names/args
	// and user messages to find results
	toolIDToInfo := make(map[string]toolCallKey)

	// Create a deep copy of messages to avoid modifying the original during iteration
	// and to ensure we return modified messages
	optimizedMessages := make([]protocol.Message, len(messages))
	copy(optimizedMessages, messages)

	for i, msg := range optimizedMessages {
		if msg.Role == "assistant" && len(msg.ToolUse) > 0 {
			for _, tu := range msg.ToolUse {
				toolIDToInfo[tu.ID] = toolCallKey{
					Name: tu.Name,
					Args: string(tu.Input),
				}
			}
		}

		if msg.Role == "user" && len(msg.ToolResults) > 0 {
			for j, tr := range msg.ToolResults {
				info, ok := toolIDToInfo[tr.ToolUseID]
				if !ok {
					continue
				}

				// We only optimize safe, read-only tools with potentially large output
				if info.Name != "read_file" && info.Name != "list_dir" && info.Name != "grep_search" && info.Name != "find_by_name" {
					continue
				}

				// If we already saw this tool call, mark the previous one for condensation
				if prev, exists := lastResults[info]; exists {
					// Replace previous result with a placeholder
					prevMsg := &optimizedMessages[prev.msgIdx]
					// Make sure we have a slice copy if we're modifying it (though copy() above handled top level)
					prevMsg.ToolResults = append([]protocol.ToolResultBlock(nil), prevMsg.ToolResults...)
					prevMsg.ToolResults[prev.resultIdx].Content = fmt.Sprintf("[Previous output from %s for %s removed to save context. See latest version below.]", info.Name, info.Args)
					log.Printf("[Memory] Optimized redundant %s for %s", info.Name, info.Args)
				}

				// Update last seen
				lastResults[info] = resultPos{msgIdx: i, resultIdx: j}
			}
		}
	}

	return optimizedMessages
}
