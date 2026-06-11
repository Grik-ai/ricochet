package agent

import (
	"testing"

	"github.com/igoryan-dao/ricochet/internal/tools"
)

func TestBatchWorkerSafetyPathScope(t *testing.T) {
	c := &Controller{}
	session := &Session{
		ID:                  "s1",
		BatchWorkerID:       "w1",
		AllowedRoot:         "/repo/worktree",
		ScopePaths:          []string{"src"},
		IsolatedAutoApprove: true,
	}

	if err := c.validateBatchWorkerTool(session, "write_file", `{"path":"src/app.go"}`, tools.CategoryWrite); err != nil {
		t.Fatalf("inside scope denied: %v", err)
	}
	if err := c.validateBatchWorkerTool(session, "write_file", `{"path":"../main.go"}`, tools.CategoryWrite); err == nil {
		t.Fatalf("outside worktree write should be denied")
	}
	if err := c.validateBatchWorkerTool(session, "batch_edit", `{"edits":[{"path":"README.md","type":"write"}]}`, tools.CategoryWrite); err == nil {
		t.Fatalf("outside assigned scope batch edit should be denied")
	}
	if err := c.validateBatchWorkerTool(session, "execute_command", `{"command":"cat /repo/README.md"}`, tools.CategoryExecute); err == nil {
		t.Fatalf("absolute path outside worker root should be denied")
	}
}

func TestBatchWorkerSafetyCommands(t *testing.T) {
	if !batchWorkerCommandAllowed("npm test -- --run") {
		t.Fatalf("npm test should be allowed in isolated worker")
	}
	if !batchWorkerCommandAllowed("go test ./...") {
		t.Fatalf("go test should be allowed in isolated worker")
	}
	if batchWorkerCommandAllowed("git push origin main") {
		t.Fatalf("git push should be denied")
	}
	if batchWorkerCommandAllowed("echo $(rm -rf dist)") {
		t.Fatalf("dangerous substitution should be denied")
	}
}
