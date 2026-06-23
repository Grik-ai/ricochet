package remote

import "strings"

var safeSlashCommands = map[string]bool{
	"/status":   true,
	"/sessions": true,
	"/queue":    true,
	"/cancel":   true,
	"/new":      true,
	"/switch":   true,
	"/steer":    true,
	"/help":     true,
}

func IsSafeSlashCommand(input string) bool {
	input = strings.TrimSpace(input)
	if input == "" || !strings.HasPrefix(input, "/") {
		return true
	}
	name := input
	if fields := strings.Fields(input); len(fields) > 0 {
		name = fields[0]
	}
	return safeSlashCommands[name]
}

func SafeSlashCommands() []string {
	return []string{"/status", "/sessions", "/queue", "/cancel", "/new", "/switch <session-id>", "/steer <message>", "/help"}
}
