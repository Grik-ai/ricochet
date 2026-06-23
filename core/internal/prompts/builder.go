package prompts

import "strings"

// BuildSystemPrompt constructs the full system prompt
func BuildSystemPrompt(cwd string) string {
	var sb strings.Builder

	sb.WriteString(GetRole())
	sb.WriteString("\n\n")
	sb.WriteString(GetCapabilities())
	sb.WriteString("\n\n")
	sb.WriteString(GetExecutionContract())
	sb.WriteString("\n\n")
	sb.WriteString(GetToolGuidelines())
	sb.WriteString("\n\n")
	sb.WriteString(GetRules())
	sb.WriteString("\n\n")
	sb.WriteString(GetMetaCognition())
	sb.WriteString("\n\n")
	// Note: Initial context (file tree) provides dynamic info but usually goes into the
	// first user message or a dedicated system section. For now we append it here.
	// In strict Chat implementations, this might be better placed in the first User message,
	// but putting it in System is also valid for establishing context.
	sb.WriteString(GetInitialContext(cwd))

	return sb.String()
}
