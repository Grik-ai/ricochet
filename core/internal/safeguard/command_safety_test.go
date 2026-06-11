package safeguard

import (
	"testing"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestIsSafeCommand(t *testing.T) {
	tests := []struct {
		name    string
		command string
		want    bool
	}{
		{name: "list directory", command: "ls -la", want: true},
		{name: "ripgrep search", command: "rg -n AutoApproval core/internal", want: true},
		{name: "git status", command: "git status --short", want: true},
		{name: "git show", command: "git show HEAD", want: true},
		{name: "git reset is unsafe", command: "git reset --hard HEAD", want: false},
		{name: "git diff output writes", command: "git diff --output patch.diff", want: false},
		{name: "find read only", command: "find . -name '*.go'", want: true},
		{name: "find delete is unsafe", command: "find . -name '*.tmp' -delete", want: false},
		{name: "rm is unsafe", command: "rm -rf dist", want: false},
		{name: "npm can execute scripts", command: "npm test", want: false},
		{name: "redirect is unsafe", command: "echo ok > file.txt", want: false},
		{name: "pipe is not auto approved", command: "cat file.txt | grep token", want: false},
		{name: "subshell is unsafe", command: "echo $(rm -rf dist)", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsSafeCommand(tt.command); got != tt.want {
				t.Fatalf("IsSafeCommand(%q) = %v, want %v", tt.command, got, tt.want)
			}
		})
	}
}

func TestGetCommandDecision(t *testing.T) {
	tests := []struct {
		name    string
		command string
		allow   []string
		deny    []string
		want    protocol.PermissionDecision
	}{
		{name: "simple allow", command: "git status", allow: []string{"git"}, want: protocol.PermissionAutoApprove},
		{name: "specific deny wins", command: "git push origin main", allow: []string{"git"}, deny: []string{"git push"}, want: protocol.PermissionAutoDeny},
		{name: "more specific allow wins", command: "git push --dry-run", allow: []string{"git push --dry-run"}, deny: []string{"git push"}, want: protocol.PermissionAutoApprove},
		{name: "chain denied if any part denied", command: "git status && rm file", allow: []string{"git"}, deny: []string{"rm"}, want: protocol.PermissionAutoDeny},
		{name: "unknown asks user", command: "npm test", allow: []string{"git"}, deny: []string{"rm"}, want: protocol.PermissionAskUser},
		{name: "dangerous substitution asks user", command: `echo "${var@P}"`, allow: []string{"*"}, want: protocol.PermissionAskUser},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := GetCommandDecision(tt.command, tt.allow, tt.deny); got != tt.want {
				t.Fatalf("GetCommandDecision(%q) = %s, want %s", tt.command, got, tt.want)
			}
		})
	}
}

func TestRiskyCommandApprovalPrefix(t *testing.T) {
	tests := []struct {
		prefix string
		want   bool
	}{
		{prefix: "bash", want: true},
		{prefix: "python -c", want: true},
		{prefix: "node -e", want: true},
		{prefix: "git", want: true},
		{prefix: "git status", want: false},
		{prefix: "npm test", want: false},
		{prefix: "go test", want: false},
	}
	for _, tt := range tests {
		if got := IsRiskyCommandApprovalPrefix(tt.prefix); got != tt.want {
			t.Fatalf("IsRiskyCommandApprovalPrefix(%q) = %v, want %v", tt.prefix, got, tt.want)
		}
	}
}

func TestCommandMentionsPathOutsideRoot(t *testing.T) {
	root := "/repo/worktree"
	if !CommandMentionsPathOutsideRoot("cat /repo/README.md", root) {
		t.Fatalf("absolute path outside root should be detected")
	}
	if !CommandMentionsPathOutsideRoot("go test ../...", root) {
		t.Fatalf("relative parent escape should be detected")
	}
	if CommandMentionsPathOutsideRoot("go test ./...", root) {
		t.Fatalf("local recursive test should be allowed")
	}
	if CommandMentionsPathOutsideRoot("cat /repo/worktree/README.md", root) {
		t.Fatalf("absolute path inside root should be allowed")
	}
}
