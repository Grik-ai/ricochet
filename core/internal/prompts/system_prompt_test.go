package prompts

import (
	"strings"
	"testing"
)

func TestBuildSystemPrompt_ReliabilityContracts(t *testing.T) {
	result := BuildSystemPrompt(t.TempDir())

	for _, required := range []string{
		"EXECUTION CONTRACT",
		"RELIABILITY CONTRACT",
		"VERIFICATION AND REVIEW CONTRACT",
		"Prefer compact skill metadata first",
		"Use memory for future sessions",
		"Workflow command injection must be explicitly allowed",
		"discover enough context, plan only when it reduces risk",
		"Use the final chat answer for concise markdown summaries",
	} {
		if !strings.Contains(result, required) {
			t.Fatalf("system prompt missing %q", required)
		}
	}

	for _, forbidden := range []string{
		"For non-plan reports/analysis exceeding 500 words, use write_file",
		".ricochet/brain",
		"artifact/brain",
		"Create files in the project root with names like",
		"walkthrough.md",
		"project_analysis.md",
		"improvement_suggestions.md",
		"Never Ask the User",
	} {
		if strings.Contains(result, forbidden) {
			t.Fatalf("system prompt contains deprecated instruction %q", forbidden)
		}
	}
}
