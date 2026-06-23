package agent

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// InjectionProcessor handles @file and !cmd expansions
type InjectionProcessor struct {
	cwd string
}

// NewInjectionProcessor creates a new processor
func NewInjectionProcessor(cwd string) *InjectionProcessor {
	return &InjectionProcessor{cwd: cwd}
}

// Process expands injections in the input text
func (p *InjectionProcessor) Process(input string) (string, []string) {
	return p.ProcessIgnoringPaths(input, nil)
}

// ProcessIgnoringPaths expands injections while skipping paths already handled by
// a structured attachment channel.
func (p *InjectionProcessor) ProcessIgnoringPaths(input string, ignoredPaths []string) (string, []string) {
	result := input
	var infoMessages []string
	ignored := make(map[string]bool, len(ignoredPaths))
	for _, path := range ignoredPaths {
		normalized := normalizeInjectionPath(path)
		if normalized != "" {
			ignored[normalized] = true
		}
	}

	// 1. Process @path/to/file
	// Regex matches @ followed by a path-like string (letters, numbers, dots, slashes, underscores, hyphens)
	fileRegex := regexp.MustCompile(`@([a-zA-Z0-9\./\-_]+)`)
	matches := fileRegex.FindAllStringSubmatch(input, -1)

	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		path := match[1]
		if ignored[normalizeInjectionPath(path)] {
			continue
		}
		content, err := os.ReadFile(path)
		if err != nil {
			infoMessages = append(infoMessages, fmt.Sprintf("⚠️ Could not read file @%s: %v", path, err))
			continue
		}

		// Append to the end of the message as a context block
		injection := fmt.Sprintf("\n\n---\n**Content of @%s:**\n```\n%s\n```\n---", path, string(content))
		result += injection
		infoMessages = append(infoMessages, fmt.Sprintf("📎 Injected file content: @%s", path))
	}

	// 2. Process !command
	// Regex matches ! followed by a shell command (until end of line or specific delimiters)
	// For simplicity, let's use !{cmd} if possible, or just !cmd until space?
	// Gemini uses !{cmd}, let's support both for UX.
	shellRegex := regexp.MustCompile(`!\{([^}]+)\}`)
	shellMatches := shellRegex.FindAllStringSubmatch(input, -1)

	for _, match := range shellMatches {
		if len(match) < 2 {
			continue
		}
		cmdStr := match[1]

		// Execute command
		parts := strings.Fields(cmdStr)
		if len(parts) == 0 {
			continue
		}

		cmd := exec.Command(parts[0], parts[1:]...)
		cmd.Dir = p.cwd
		output, err := cmd.CombinedOutput()

		status := "success"
		if err != nil {
			status = fmt.Sprintf("failed: %v", err)
		}

		injection := fmt.Sprintf("\n\n---\n**Output of !{%s} (%s):**\n```\n%s\n```\n---", cmdStr, status, string(output))
		result += injection
		infoMessages = append(infoMessages, fmt.Sprintf("🖥️ Injected command output: !{%s}", cmdStr))
	}

	// 3. Smart Triggers (Phase 17)
	// Trigger: "test" or "fail" -> Suggest running tests
	if strings.Contains(strings.ToLower(input), "test") || strings.Contains(strings.ToLower(input), "fail") {
		// Just a hint for now. In future, we could look for test files.
		// infoMessages = append(infoMessages, "💡 Tip: You can run tests using `go test ./...` or `npm test`.")
	}

	// Trigger: "deploy" -> Look for deploy docs
	if strings.Contains(strings.ToLower(input), "deploy") {
		// Quick check for standard deploy docs
		docs := []string{"docs/deploy.md", "DEPLOY.md", "deployment.md"}
		for _, doc := range docs {
			if _, err := os.Stat(doc); err == nil {
				// Inject it!
				content, _ := os.ReadFile(doc)
				injection := fmt.Sprintf("\n\n---\n**Auto-Injected Context (@%s):**\n```\n%s\n```\n---", doc, string(content))
				result += injection
				infoMessages = append(infoMessages, fmt.Sprintf("📖 Found deployment docs: %s", doc))
				break // Only one
			}
		}
	}

	return result, infoMessages
}

func normalizeInjectionPath(path string) string {
	return strings.TrimPrefix(strings.TrimSpace(path), "@")
}
