package safeguard

import (
	"path/filepath"
	"regexp"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

var safeReadOnlyCommands = map[string]bool{
	"awk":    true,
	"cat":    true,
	"date":   true,
	"diff":   true,
	"echo":   true,
	"fd":     true,
	"file":   true,
	"grep":   true,
	"head":   true,
	"id":     true,
	"ls":     true,
	"pwd":    true,
	"rg":     true,
	"sort":   true,
	"stat":   true,
	"tail":   true,
	"tree":   true,
	"type":   true,
	"uname":  true,
	"wc":     true,
	"which":  true,
	"whoami": true,
}

var safeGitSubcommands = map[string]bool{
	"blame":     true,
	"branch":    true,
	"diff":      true,
	"grep":      true,
	"log":       true,
	"ls-files":  true,
	"remote":    true,
	"rev-parse": true,
	"show":      true,
	"status":    true,
}

var shellControlTokens = []string{
	";", "&&", "||", "|", ">", "<", "`", "$(", "${", "\n", "\r",
}

var dangerousSubstitutionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\$\{[^}]*@[PQEAa][^}]*\}`),
	regexp.MustCompile(`\$\{[^}]*[=+\-?][^}]*\\[0-7]{3}[^}]*\}`),
	regexp.MustCompile(`\$\{[^}]*[=+\-?][^}]*\\x[0-9a-fA-F]{2}[^}]*\}`),
	regexp.MustCompile(`\$\{[^}]*[=+\-?][^}]*\\u[0-9a-fA-F]{4}[^}]*\}`),
	regexp.MustCompile(`\$\{![^}]+\}`),
	regexp.MustCompile("<<<\\s*(\\$\\(|`)"),
	regexp.MustCompile(`(^|[\s;|&(<])=\([^)]+\)`),
	regexp.MustCompile(`[*?+@!]\(e:[^:]+:\)`),
}

var simpleRedirectionPattern = regexp.MustCompile(`^\d*>&\d*$`)

var riskyApprovalCommands = map[string]bool{
	"*":          true,
	"bash":       true,
	"bun":        true,
	"deno":       true,
	"fish":       true,
	"git":        true,
	"node":       true,
	"npm":        true,
	"npx":        true,
	"perl":       true,
	"php":        true,
	"powershell": true,
	"pwsh":       true,
	"python":     true,
	"python3":    true,
	"ruby":       true,
	"sh":         true,
	"sudo":       true,
	"su":         true,
	"wget":       true,
	"curl":       true,
	"zsh":        true,
}

func ContainsDangerousSubstitution(command string) bool {
	for _, pattern := range dangerousSubstitutionPatterns {
		if pattern.MatchString(command) {
			return true
		}
	}
	return false
}

func IsRiskyCommandApprovalPrefix(prefix string) bool {
	prefix = strings.ToLower(strings.TrimSpace(prefix))
	if prefix == "" {
		return false
	}
	if ContainsDangerousSubstitution(prefix) {
		return true
	}
	if riskyApprovalCommands[prefix] {
		return true
	}
	fields := strings.Fields(prefix)
	if len(fields) == 0 {
		return false
	}
	command := filepath.Base(fields[0])
	if len(fields) == 1 {
		return riskyApprovalCommands[command]
	}
	switch command {
	case "bash", "sh", "zsh", "fish", "python", "python3", "node", "ruby", "perl", "php", "pwsh", "powershell":
		if fields[1] == "-c" || fields[1] == "-e" {
			return true
		}
	case "sudo", "su":
		return true
	case "git":
		return len(fields) == 1
	case "npm", "npx", "curl", "wget":
		return len(fields) == 1
	}
	return false
}

func CommandMentionsPathOutsideRoot(command, root string) bool {
	root = filepath.Clean(strings.TrimSpace(root))
	if root == "" || root == "." {
		return false
	}
	for _, field := range strings.Fields(command) {
		candidate := strings.Trim(field, `"'`)
		candidate = strings.TrimRight(candidate, ",)")
		if candidate == ".." || strings.HasPrefix(candidate, "../") || strings.Contains(candidate, "/../") {
			return true
		}
		if !filepath.IsAbs(candidate) {
			continue
		}
		path := filepath.Clean(candidate)
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func GetCommandDecision(command string, allowedCommands, deniedCommands []string) protocol.PermissionDecision {
	command = strings.TrimSpace(command)
	if command == "" {
		return protocol.PermissionAutoApprove
	}

	parts := SplitCommandChain(command)
	decisions := make([]protocol.PermissionDecision, 0, len(parts))
	for _, part := range parts {
		part = stripSimpleRedirection(part)
		decisions = append(decisions, GetSingleCommandDecision(part, allowedCommands, deniedCommands))
	}

	for _, decision := range decisions {
		if decision == protocol.PermissionAutoDeny {
			return protocol.PermissionAutoDeny
		}
	}
	if ContainsDangerousSubstitution(command) {
		return protocol.PermissionAskUser
	}
	for _, decision := range decisions {
		if decision != protocol.PermissionAutoApprove {
			return protocol.PermissionAskUser
		}
	}
	return protocol.PermissionAutoApprove
}

func GetSingleCommandDecision(command string, allowedCommands, deniedCommands []string) protocol.PermissionDecision {
	command = strings.TrimSpace(command)
	if command == "" {
		return protocol.PermissionAutoApprove
	}

	allowed := FindLongestPrefixMatch(command, allowedCommands)
	denied := FindLongestPrefixMatch(command, deniedCommands)
	switch {
	case allowed != "" && denied == "":
		return protocol.PermissionAutoApprove
	case allowed == "" && denied != "":
		return protocol.PermissionAutoDeny
	case allowed != "" && denied != "":
		if len(allowed) > len(denied) {
			return protocol.PermissionAutoApprove
		}
		return protocol.PermissionAutoDeny
	default:
		return protocol.PermissionAskUser
	}
}

func FindLongestPrefixMatch(command string, prefixes []string) string {
	command = strings.ToLower(strings.TrimSpace(command))
	longest := ""
	for _, prefix := range prefixes {
		candidate := strings.ToLower(strings.TrimSpace(prefix))
		if candidate == "" {
			continue
		}
		if candidate == "*" || strings.HasPrefix(command, candidate) {
			if len(candidate) > len(longest) {
				longest = candidate
			}
		}
	}
	return longest
}

func SplitCommandChain(command string) []string {
	var parts []string
	var current strings.Builder
	var quote byte
	escaped := false

	flush := func() {
		part := strings.TrimSpace(current.String())
		if part != "" {
			parts = append(parts, part)
		}
		current.Reset()
	}

	for i := 0; i < len(command); i++ {
		ch := command[i]
		if escaped {
			current.WriteByte(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			current.WriteByte(ch)
			escaped = true
			continue
		}
		if quote != 0 {
			current.WriteByte(ch)
			if ch == quote {
				quote = 0
			}
			continue
		}
		if ch == '\'' || ch == '"' {
			quote = ch
			current.WriteByte(ch)
			continue
		}
		switch ch {
		case ';', '\n', '\r':
			flush()
			continue
		case '|':
			flush()
			if i+1 < len(command) && command[i+1] == '|' {
				i++
			}
			continue
		case '&':
			flush()
			if i+1 < len(command) && command[i+1] == '&' {
				i++
			}
			continue
		}
		current.WriteByte(ch)
	}
	flush()
	if len(parts) == 0 {
		return []string{strings.TrimSpace(command)}
	}
	return parts
}

func HasAllowedCommandMatch(command string, allowedCommands []string) bool {
	for _, part := range SplitCommandChain(command) {
		if FindLongestPrefixMatch(stripSimpleRedirection(part), allowedCommands) == "" {
			return false
		}
	}
	return true
}

func stripSimpleRedirection(command string) string {
	fields := strings.Fields(command)
	filtered := fields[:0]
	for _, field := range fields {
		if simpleRedirectionPattern.MatchString(field) {
			continue
		}
		filtered = append(filtered, field)
	}
	return strings.Join(filtered, " ")
}

// IsSafeCommand returns true only for simple read-only commands that are safe to
// auto-approve. Commands with shell control operators, redirects, or write-capable
// subcommands require explicit approval.
func IsSafeCommand(command string) bool {
	command = strings.TrimSpace(command)
	if command == "" {
		return false
	}
	for _, token := range shellControlTokens {
		if strings.Contains(command, token) {
			return false
		}
	}

	parts := strings.Fields(command)
	if len(parts) == 0 {
		return false
	}

	name := filepath.Base(parts[0])
	if name == "git" {
		return isSafeGitCommand(parts[1:])
	}
	if name == "find" {
		return isSafeFindCommand(parts[1:])
	}

	return safeReadOnlyCommands[name]
}

func isSafeGitCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	subcommand := ""
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		subcommand = arg
		break
	}
	if subcommand == "" || !safeGitSubcommands[subcommand] {
		return false
	}
	for _, arg := range args {
		if arg == "--output" || strings.HasPrefix(arg, "--output=") {
			return false
		}
	}
	return true
}

func isSafeFindCommand(args []string) bool {
	for _, arg := range args {
		switch arg {
		case "-delete", "-exec", "-execdir", "-ok", "-okdir":
			return false
		}
	}
	return true
}
