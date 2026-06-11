package context

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// CondenseProvider interface for LLM that can summarize context
type CondenseProvider interface {
	Summarize(ctx context.Context, prompt string) (string, error)
}

// CondenseManager handles intelligent context compression
type CondenseManager struct {
	MaxTokens  int
	Threshold  float64 // 0.7 = 70%
	Provider   CondenseProvider
	KeepRecent int // Number of recent messages to keep intact
}

// CondenseResult contains the result of condensation
type CondenseResult struct {
	Messages     []protocol.Message
	Summary      string
	WasCondensed bool
	TokensBefore int
	TokensAfter  int
	Error        error
}

// NewCondenseManager creates a new condense manager
func NewCondenseManager(maxTokens int, thresholdPercent int, provider CondenseProvider) *CondenseManager {
	return &CondenseManager{
		MaxTokens:  maxTokens,
		Threshold:  float64(thresholdPercent) / 100.0,
		Provider:   provider,
		KeepRecent: 8, // Keep last 8 messages intact
	}
}

// ShouldCondense checks if we're approaching context limits
func (cm *CondenseManager) ShouldCondense(messages []protocol.Message, systemPrompt string) (bool, float64) {
	if len(messages) <= cm.KeepRecent {
		return false, 0
	}

	// Calculate current token usage
	totalTokens := EstimateTokens(systemPrompt)
	for _, msg := range messages {
		totalTokens += EstimateMessageTokens(msg)
	}

	percentage := float64(totalTokens) / float64(cm.MaxTokens)
	return percentage >= cm.Threshold, percentage
}

// Condense attempts to summarize old messages using LLM
func (cm *CondenseManager) Condense(ctx context.Context, messages []protocol.Message, systemPrompt string) (*CondenseResult, error) {
	result := &CondenseResult{
		Messages:     messages,
		WasCondensed: false,
	}
	messages = InjectSyntheticToolResults(messages)
	result.Messages = messages

	if len(messages) <= cm.KeepRecent {
		return result, nil
	}

	// Calculate tokens before
	result.TokensBefore = EstimateTokens(systemPrompt)
	for _, msg := range messages {
		result.TokensBefore += EstimateMessageTokens(msg)
	}

	// Split messages: old ones to condense, recent ones to keep
	oldMessages := messages[:len(messages)-cm.KeepRecent]
	recentMessages := messages[len(messages)-cm.KeepRecent:]

	// Skip if no provider available
	if cm.Provider == nil {
		log.Printf("Context condensation: no provider available, skipping LLM summarization")
		return result, nil
	}

	// Build summarization prompt
	prompt := cm.buildCondensePrompt(oldMessages)

	// Call LLM for summarization
	summary, err := cm.Provider.Summarize(ctx, prompt)
	if err != nil {
		result.Error = fmt.Errorf("condensation failed: %w", err)
		return result, result.Error
	}

	// Create a summary message to replace old messages
	summaryMessage := protocol.Message{
		Role:    "user",
		Content: fmt.Sprintf("[Previous conversation summary]\n%s\n[End of summary]", summary),
	}

	// Build new message list: first message (pinned) + summary + recent
	// Ensure we don't duplicate the first message if it was part of recentMessages
	newMessages := []protocol.Message{}
	if len(messages) > 0 {
		newMessages = append(newMessages, messages[0])
	}
	newMessages = append(newMessages, summaryMessage)
	result.Messages = append(newMessages, recentMessages...)

	result.Summary = summary
	result.WasCondensed = true

	// Calculate tokens after
	result.TokensAfter = EstimateTokens(systemPrompt)
	for _, msg := range result.Messages {
		result.TokensAfter += EstimateMessageTokens(msg)
	}

	log.Printf("Context condensation: %d -> %d tokens, %d -> %d messages",
		result.TokensBefore, result.TokensAfter,
		len(messages), len(result.Messages))

	return result, nil
}

// stripThinking removes contents between <thinking> and </thinking> tags.
func stripThinking(text string) string {
	for {
		start := strings.Index(text, "<thinking>")
		if start == -1 {
			break
		}
		end := strings.Index(text, "</thinking>")
		if end == -1 {
			// If no closing tag, just remove from start to end of string if it's reasonably long
			// or just stop if we can't find a pair.
			break
		}
		text = text[:start] + "[...thinking compressed...]" + text[end+len("</thinking>"):]
	}
	return text
}

// InjectSyntheticToolResults keeps provider-facing history valid when a prior
// compaction, import, or interrupted stream left assistant tool calls without a
// matching tool result message. The synthetic result is explicit so the model
// knows the original output is unavailable.
func InjectSyntheticToolResults(messages []protocol.Message) []protocol.Message {
	if len(messages) == 0 {
		return messages
	}

	resultIDs := make(map[string]bool)
	for _, msg := range messages {
		for _, tr := range msg.ToolResults {
			if tr.ToolUseID != "" {
				resultIDs[tr.ToolUseID] = true
			}
		}
	}

	out := make([]protocol.Message, 0, len(messages))
	for _, msg := range messages {
		out = append(out, msg)
		if msg.Role != "assistant" || len(msg.ToolUse) == 0 {
			continue
		}

		synthetic := make([]protocol.ToolResultBlock, 0)
		for _, tu := range msg.ToolUse {
			if tu.ID == "" || resultIDs[tu.ID] {
				continue
			}
			synthetic = append(synthetic, protocol.ToolResultBlock{
				ToolUseID: tu.ID,
				Content:   fmt.Sprintf("[Synthetic Ricochet tool result: output for %s was unavailable after context compaction or interrupted execution. Re-run the tool if the exact output is needed.]", tu.Name),
				IsError:   true,
			})
			resultIDs[tu.ID] = true
		}
		if len(synthetic) > 0 {
			out = append(out, protocol.Message{Role: "user", ToolResults: synthetic})
		}
	}
	return out
}

func ExtractActiveCommandBlocks(messages []protocol.Message) []string {
	commands := make([]string, 0)
	for _, msg := range messages {
		content := msg.Content
		for {
			start := strings.Index(content, "<command>")
			if start == -1 {
				break
			}
			remaining := content[start+len("<command>"):]
			end := strings.Index(remaining, "</command>")
			if end == -1 {
				cmd := strings.TrimSpace(remaining)
				if cmd != "" {
					commands = append(commands, cmd)
				}
				break
			}
			cmd := strings.TrimSpace(remaining[:end])
			if cmd != "" {
				commands = append(commands, cmd)
			}
			content = remaining[end+len("</command>"):]
		}
	}
	return commands
}

// buildCondensePrompt creates the prompt for LLM summarization
func (cm *CondenseManager) buildCondensePrompt(messages []protocol.Message) string {
	var sb strings.Builder

	sb.WriteString(`Your task is to create a detailed summary of the conversation history so far. 
This summary must be thorough in capturing technical details, architectural decisions, and the current state of progress.

Your summary should be structured as follows:

1. Previous Conversation: High level details about what was discussed.
2. Current Work: Describe in detail what was being worked on prior to this request.
3. Key Technical Concepts: Frameworks, coding conventions, and architectural patterns discussed.
4. Relevant Files: Enumerate files examined or modified, and why they are important.
5. Pending Tasks & Next Steps: Outline outstanding work. For next steps, include direct quotes or specific instructions from the most recent messages to ensure no information loss.

Focus on information that will be essential for continuing the task without losing context.
Keep the summary concise but informative.

=== Conversation History ===
`)

	for i, msg := range messages {
		// Pin the first message (usually the initial task) - only if it's not already in summary
		isFirst := i == 0

		role := msg.Role
		if role == "assistant" {
			role = "Agent"
		} else {
			role = "User"
		}

		content := msg.Content
		// Strip thinking blocks from assistant messages
		if msg.Role == "assistant" {
			content = stripThinking(content)
		}

		// Truncate very long messages in the prompt (not in final history)
		if len(content) > 1000 {
			content = content[:1000] + "... [truncated for summary prompt]"
		}

		prefix := ""
		if isFirst {
			prefix = "[PINNED INITIAL TASK] "
		}

		sb.WriteString(fmt.Sprintf("\n%s[%s]: %s\n", prefix, role, content))

		// Include tool use info
		if len(msg.ToolUse) > 0 {
			for _, tu := range msg.ToolUse {
				sb.WriteString(fmt.Sprintf("  - Used tool: %s\n", tu.Name))
			}
		}
		if len(msg.ToolResults) > 0 {
			for _, tr := range msg.ToolResults {
				preview := stripThinking(tr.Content)
				if len(preview) > 500 {
					preview = preview[:500] + "... [tool result truncated for summary prompt]"
				}
				sb.WriteString(fmt.Sprintf("  - Tool result for %s: %s\n", tr.ToolUseID, preview))
			}
		}
	}

	if commands := ExtractActiveCommandBlocks(messages); len(commands) > 0 {
		sb.WriteString("\n=== Active Command Blocks To Preserve ===\n")
		for _, cmd := range commands {
			if len(cmd) > 500 {
				cmd = cmd[:500] + "... [command truncated]"
			}
			sb.WriteString("- " + cmd + "\n")
		}
	}

	sb.WriteString("\n=== End of History ===\n\nProvide a concise summary:")

	return sb.String()
}
