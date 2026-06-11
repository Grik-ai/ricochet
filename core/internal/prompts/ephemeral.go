package prompts

import (
	"fmt"
	"strings"
)

type EphemeralContext struct {
	Mode             string // "planning", "execution", "verification"
	HasPlan          bool
	HasActiveTask    bool
	ToolCallCount    int
	LastToolFailed   bool
	IsInTaskMode     bool
	ArtifactsCreated []string
	SessionID        string // For scoping artifacts
	WorkspaceRoot    string // Original source root
}

// BuildEphemeralMessage generates a conditional reminder based on current context
func BuildEphemeralMessage(ctx EphemeralContext) string {
	if !ctx.IsInTaskMode && ctx.Mode != "planning" && ctx.Mode != "execution" && ctx.Mode != "verification" {
		return ""
	}

	var reminders []string

	if ctx.Mode == "planning" && !ctx.HasPlan {
		reminders = append(reminders, `<planning_reminder>
💡 TIP: You are in PLANNING mode.
- Focus on research and architecture.
- Submit an implementation plan artifact with submit_plan before making any changes.
- Do not run modifying commands until the user approves your plan.
</planning_reminder>`)
	}

	if ctx.Mode == "execution" {
		if ctx.HasPlan {
			reminders = append(reminders, `<execution_reminder>
⚡ You are in EXECUTION mode.
- Follow the approved implementation plan.
- Update task.md as you progress.
- Keep the user informed of your status.
- Use replace_file_content for targeted edits.
</execution_reminder>`)
		} else {
			reminders = append(reminders, `<execution_reminder>
🚨 CRITICAL: You are in EXECUTION mode but have no implementation plan!
- This is highly discouraged. Large tasks require a plan.
- Consider switching back to PLANNING mode or creating a plan immediately.
</execution_reminder>`)
		}
	}

	if ctx.LastToolFailed {
		reminders = append(reminders, `<error_recovery_reminder>
🚨 CAUTION: The last tool call failed.
- Analyze the error before retrying.
- If you're stuck, use search_web to find a solution or ask the user for help.
</error_recovery_reminder>`)
	}

	if ctx.ToolCallCount > 5 {
		reminders = append(reminders, `<progress_reminder>
⏱️ You've made several tool calls in this turn.
- Ensure you're not in a loop.
- Consider summarizing progress.
</progress_reminder>`)
	}

	if len(ctx.ArtifactsCreated) > 0 {
		reminders = append(reminders, `<artifact_reminder>
📄 You have active artifacts: `+strings.Join(ctx.ArtifactsCreated, ", ")+`
- Keep them updated as you work.
</artifact_reminder>`)
	}

	// Session-scoped artifact reminder
	artifactPath := ".resolved"
	if ctx.SessionID != "" {
		artifactPath = fmt.Sprintf(".ricochet/brain/%s/filename.resolved", ctx.SessionID)
	}

	reminders = append(reminders, fmt.Sprintf(`<communication_reminder>
📢 LARGE OUTPUT RULE:
- For requested implementation plans, use submit_plan instead of write_file.
- For non-plan reports/analysis exceeding 500 words, use write_file.
- **DIRECTORY**: Save internal reports to: %s
- Use the '.resolved' extension for final artifacts.
</communication_reminder>`, artifactPath))

	if len(reminders) == 0 {
		return ""
	}

	return fmt.Sprintf("\n<EPHEMERAL_MESSAGE>\nYou have the following system-injected reminders:\n\n%s\n</EPHEMERAL_MESSAGE>", strings.Join(reminders, "\n\n"))
}

// BuildToolSpecificReminder adds context for specific tools
func BuildToolSpecificReminder(toolName string, failureCount int) string {
	if failureCount < 2 {
		return ""
	}

	return fmt.Sprintf("⚠️ The tool '%s' has failed %d times. Check your arguments and file context before retrying.", toolName, failureCount)
}
