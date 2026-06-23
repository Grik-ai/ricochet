package prompts

import (
	"strings"
	"testing"
)

func TestBuildEphemeralMessage_Empty(t *testing.T) {
	ctx := EphemeralContext{
		Mode:          "code",
		IsInTaskMode:  false,
		ToolCallCount: 0,
	}

	result := BuildEphemeralMessage(ctx)
	if result != "" {
		t.Errorf("Expected empty message for non-task mode, got: %s", result)
	}
}

func TestBuildEphemeralMessage_Planning(t *testing.T) {
	ctx := EphemeralContext{
		Mode:         "planning",
		IsInTaskMode: true,
		HasPlan:      false,
	}

	result := BuildEphemeralMessage(ctx)
	if !strings.Contains(result, "PLANNING mode") {
		t.Error("Expected PLANNING mode reminder")
	}
	if !strings.Contains(result, "submit_plan") {
		t.Error("Expected mention of submit_plan")
	}
	if !strings.Contains(result, "<EPHEMERAL_MESSAGE>") {
		t.Error("Expected ephemeral message wrapper")
	}
}

func TestBuildEphemeralMessage_Execution(t *testing.T) {
	ctx := EphemeralContext{
		Mode:         "execution",
		IsInTaskMode: true,
		HasPlan:      true,
	}

	result := BuildEphemeralMessage(ctx)
	if !strings.Contains(result, "EXECUTION mode") {
		t.Error("Expected EXECUTION mode reminder")
	}
	if !strings.Contains(result, "replace_file_content") {
		t.Error("Expected tool guidance")
	}
}

func TestBuildEphemeralMessage_MultipleReminders(t *testing.T) {
	ctx := EphemeralContext{
		Mode:             "execution",
		IsInTaskMode:     true,
		HasPlan:          true,
		ToolCallCount:    10,
		ArtifactsCreated: []string{"task.md", "plan.md"},
		LastToolFailed:   true,
	}

	result := BuildEphemeralMessage(ctx)

	// Should have multiple reminders
	if !strings.Contains(result, "<execution_reminder>") {
		t.Error("Missing execution reminder")
	}
	if !strings.Contains(result, "<progress_reminder>") {
		t.Error("Missing progress reminder")
	}
	if !strings.Contains(result, "<artifact_reminder>") {
		t.Error("Missing artifact reminder")
	}
	if !strings.Contains(result, "<error_recovery_reminder>") {
		t.Error("Missing error recovery reminder")
	}
	if !strings.Contains(result, "<communication_reminder>") {
		t.Error("Missing communication reminder")
	}

	// Count reminders
	reminderCount := strings.Count(result, "_reminder>")
	if reminderCount < 10 { // Each reminder has open and close tag
		t.Errorf("Expected multiple reminders, got %d tags", reminderCount)
	}
}

func TestBuildEphemeralMessage_NoPlanWarning(t *testing.T) {
	ctx := EphemeralContext{
		Mode:         "execution",
		IsInTaskMode: true,
		HasPlan:      false, // No plan!
	}

	result := BuildEphemeralMessage(ctx)
	if !strings.Contains(result, "no implementation plan") {
		t.Error("Expected warning about missing plan")
	}
	if !strings.Contains(result, "CRITICAL") {
		t.Error("Expected CRITICAL warning")
	}
}

func TestBuildToolSpecificReminder(t *testing.T) {
	// No reminder for single failure
	result := BuildToolSpecificReminder("replace_file_content", 1)
	if result != "" {
		t.Error("Should not show reminder for single failure")
	}

	// Show reminder for 2+ failures
	result = BuildToolSpecificReminder("replace_file_content", 2)
	if !strings.Contains(result, "replace_file_content") {
		t.Error("Expected tool name in reminder")
	}
	if !strings.Contains(result, "failed 2 times") {
		t.Error("Expected failure count")
	}
}

func TestEphemeralMessage_Structure(t *testing.T) {
	ctx := EphemeralContext{
		Mode:         "verification",
		IsInTaskMode: true,
	}

	result := BuildEphemeralMessage(ctx)

	// Check structure
	if !strings.HasPrefix(result, "\n<EPHEMERAL_MESSAGE>") {
		t.Error("Should start with EPHEMERAL_MESSAGE tag")
	}
	if !strings.HasSuffix(result, "</EPHEMERAL_MESSAGE>") {
		t.Error("Should end with closing EPHEMERAL_MESSAGE tag")
	}
	if !strings.Contains(result, "system-injected reminders") {
		t.Error("Should have introduction text")
	}
}

func TestEphemeralMessage_CommunicationContract(t *testing.T) {
	ctx := EphemeralContext{
		Mode:         "verification",
		IsInTaskMode: true,
		SessionID:    "session-123",
	}

	result := BuildEphemeralMessage(ctx)

	if strings.Contains(result, "write_file") {
		t.Fatalf("ephemeral reminder should not route reports through write_file:\n%s", result)
	}
	if strings.Contains(result, ".ricochet/brain") {
		t.Fatalf("ephemeral reminder should not mention the old brain artifact path:\n%s", result)
	}
	if !strings.Contains(result, "submit_plan") {
		t.Fatalf("ephemeral reminder should preserve submit_plan guidance:\n%s", result)
	}
	if !strings.Contains(result, ".ricochet/artifacts/session-123/filename.resolved") {
		t.Fatalf("ephemeral reminder should use session-scoped artifact path:\n%s", result)
	}
}
