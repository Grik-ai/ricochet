package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// HandoverSummary represents the LLM-generated context for transitioning from Plan to Code
type HandoverSummary struct {
	Discoveries     []string `json:"discoveries"`      // Key findings from the planning phase
	RelevantFiles   []string `json:"relevant_files"`    // Files identified as needing changes
	Implementation  string   `json:"implementation"`    // High-level implementation approach
	Risks           []string `json:"risks,omitempty"`   // Potential risks or edge cases
	MigratedTodos   []protocol.Todo `json:"migrated_todos"` // Todos carried over from Plan
}

// GenerateHandover creates an LLM-powered handover summary from the planning session,
// migrates todos, and prepares context for a new implementation session.
// Inspired by KiloCode's plan-followup.ts pattern.
func (c *Controller) GenerateHandover(ctx context.Context, sessionID string) (*HandoverSummary, error) {
	session := c.GetSession(sessionID)
	if session == nil {
		return nil, fmt.Errorf("session '%s' not found", sessionID)
	}

	// 1. Collect conversation context from the planning session
	messages := session.StateHandler.GetMessages()
	if len(messages) == 0 {
		return nil, fmt.Errorf("no messages in planning session")
	}

	// Build a condensed conversation transcript for the LLM
	var conversationSummary strings.Builder
	conversationSummary.WriteString("=== PLANNING SESSION TRANSCRIPT ===\n\n")

	msgCount := 0
	for _, msg := range messages {
		if msg.Role == "system" {
			continue
		}
		// Skip tool call details, focus on user/assistant text
		if msg.Role == "tool" {
			continue
		}
		content := msg.Content
		if len(content) > 2000 {
			content = content[:2000] + "... (truncated)"
		}
		if content == "" {
			continue
		}
		conversationSummary.WriteString(fmt.Sprintf("**%s**: %s\n\n", strings.Title(msg.Role), content))
		msgCount++
	}

	if msgCount == 0 {
		return nil, fmt.Errorf("no meaningful messages in planning session")
	}

	// 2. Collect current todos
	var currentTodos []protocol.Todo
	if session.Todos != nil {
		currentTodos = session.Todos
	}

	// Also check PlanManager tasks
	planTasks := c.planManager.GetTasks()

	// 3. Ask LLM to generate handover summary
	handoverPrompt := fmt.Sprintf(`You are a senior engineer preparing a handover document from a PLANNING session to an IMPLEMENTATION session.

The planning session discussed the following:

%s

Current task plan:
%s

Current todos:
%s

Generate a JSON handover summary with the following structure:
{
  "discoveries": ["Key finding 1", "Key finding 2", ...],
  "relevant_files": ["path/to/file1.go", "path/to/file2.ts", ...],
  "implementation": "Short paragraph describing the implementation approach",
  "risks": ["Risk 1", "Risk 2", ...]
}

Focus on actionable information. Be concise. Output ONLY the JSON, no markdown fences.`,
		conversationSummary.String(),
		formatPlanTasks(planTasks),
		formatTodos(currentTodos),
	)

	// 4. Call LLM
	req := &ChatRequest{
		Model:     c.defaultModel,
		Messages:  []protocol.Message{{Role: "user", Content: handoverPrompt}},
		MaxTokens: 4000,
	}

	resp, err := c.provider.Chat(ctx, req)
	if err != nil {
		log.Printf("[Handover] LLM call failed: %v, using fallback", err)
		// Fallback: create a basic handover from available data
		return c.fallbackHandover(session, planTasks), nil
	}

	// 5. Parse LLM response
	summary := &HandoverSummary{}
	content := strings.TrimSpace(resp.Content)
	// Strip markdown fences if present
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	content = strings.TrimSpace(content)

	if err := json.Unmarshal([]byte(content), summary); err != nil {
		log.Printf("[Handover] Failed to parse LLM response: %v, using fallback", err)
		return c.fallbackHandover(session, planTasks), nil
	}

	// 6. Migrate todos
	summary.MigratedTodos = migrateTodos(currentTodos, planTasks)

	log.Printf("[Handover] Generated summary: %d discoveries, %d files, %d todos",
		len(summary.Discoveries), len(summary.RelevantFiles), len(summary.MigratedTodos))

	return summary, nil
}

// ImplementPlan creates a new session from the handover and switches to Code mode
func (c *Controller) ImplementPlan(ctx context.Context, planSessionID string, callback func(update interface{})) error {
	// 1. Generate handover
	handover, err := c.GenerateHandover(ctx, planSessionID)
	if err != nil {
		return fmt.Errorf("handover generation failed: %w", err)
	}

	// 2. Create new implementation session
	newSession := c.CreateSession()

	// 3. Migrate todos to new session
	newSession.Todos = handover.MigratedTodos

	// 4. Prime the new session with handover context
	var contextBuilder strings.Builder
	contextBuilder.WriteString("## Implementation Handover\n\n")
	contextBuilder.WriteString("### Key Discoveries\n")
	for _, d := range handover.Discoveries {
		contextBuilder.WriteString(fmt.Sprintf("- %s\n", d))
	}
	contextBuilder.WriteString("\n### Relevant Files\n")
	for _, f := range handover.RelevantFiles {
		contextBuilder.WriteString(fmt.Sprintf("- `%s`\n", f))
	}
	contextBuilder.WriteString("\n### Implementation Plan\n")
	contextBuilder.WriteString(handover.Implementation)
	if len(handover.Risks) > 0 {
		contextBuilder.WriteString("\n\n### Risks & Edge Cases\n")
		for _, r := range handover.Risks {
			contextBuilder.WriteString(fmt.Sprintf("- ⚠️ %s\n", r))
		}
	}
	contextBuilder.WriteString("\n\n### Remaining Tasks\n")
	for _, t := range handover.MigratedTodos {
		status := "[ ]"
		if t.Status == "completed" {
			status = "[x]"
		}
		contextBuilder.WriteString(fmt.Sprintf("%s %s\n", status, t.Text))
	}

	// Inject as system message
	newSession.StateHandler.AddMessage(protocol.Message{
		Role:    "system",
		Content: contextBuilder.String(),
	})

	// 5. Switch mode to "code" if mode manager is available
	if c.modes != nil {
		c.modes.SetMode("code")
	}

	// 6. Bind plan manager to new session
	c.SetMainSessionID(newSession.ID)

	// 7. Notify callback
	if callback != nil {
		callback(ChatUpdate{
			SessionID: newSession.ID,
			Message: &ChatMessage{
				ID:        newSession.ID,
				Role:      "assistant",
				Content:   fmt.Sprintf("🚀 **Implementation Session Started**\n\n%s\n\n---\n*Carried over %d todos from planning. Ready to code!*", contextBuilder.String(), len(handover.MigratedTodos)),
				Timestamp: 0,
			},
		})
	}

	log.Printf("[Handover] Implementation session %s created from plan session %s", newSession.ID, planSessionID)
	return nil
}

// fallbackHandover creates a basic handover when LLM is unavailable
func (c *Controller) fallbackHandover(session *Session, tasks []TaskItem) *HandoverSummary {
	var files []string
	if session.FileTracker != nil {
		files = session.FileTracker.GetFiles()
	}

	var discoveries []string
	for _, t := range tasks {
		if t.Status == "done" || t.Status == "completed" {
			discoveries = append(discoveries, fmt.Sprintf("Completed: %s", t.Title))
		}
	}

	return &HandoverSummary{
		Discoveries:    discoveries,
		RelevantFiles:  files,
		Implementation: "Continue with pending tasks from the planning phase.",
		MigratedTodos:  migrateTodos(session.Todos, tasks),
	}
}

// migrateTodos converts pending tasks and todos into the new session format
func migrateTodos(todos []protocol.Todo, tasks []TaskItem) []protocol.Todo {
	result := make([]protocol.Todo, 0)

	// Migrate existing todos that aren't completed
	for _, t := range todos {
		if t.Status != "completed" {
			result = append(result, t)
		}
	}

	// Convert pending plan tasks to todos
	for _, t := range tasks {
		if t.Status == "pending" || t.Status == "active" {
			result = append(result, protocol.Todo{
				Text:   t.Title,
				Status: "pending",
			})
		}
	}

	return result
}

// formatPlanTasks formats tasks for the handover prompt
func formatPlanTasks(tasks []TaskItem) string {
	if len(tasks) == 0 {
		return "(no tasks)"
	}
	var sb strings.Builder
	for _, t := range tasks {
		icon := "[ ]"
		switch t.Status {
		case "done", "completed":
			icon = "[x]"
		case "active":
			icon = "[>]"
		case "failed":
			icon = "[!]"
		}
		sb.WriteString(fmt.Sprintf("%s %s: %s\n", icon, t.ID, t.Title))
	}
	return sb.String()
}

// formatTodos formats todos for the handover prompt
func formatTodos(todos []protocol.Todo) string {
	if len(todos) == 0 {
		return "(no todos)"
	}
	var sb strings.Builder
	for _, t := range todos {
		icon := "[ ]"
		switch t.Status {
		case "completed":
			icon = "[x]"
		case "current":
			icon = "[>]"
		}
		sb.WriteString(fmt.Sprintf("%s %s\n", icon, t.Text))
	}
	return sb.String()
}
