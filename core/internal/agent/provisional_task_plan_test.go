package agent

import "testing"

func TestComplexTaskRequestGetsProvisionalMilestones(t *testing.T) {
	if !isComplexTaskRequest("проанализируй проект") {
		t.Fatal("expected project analysis prompt to be complex")
	}

	milestones := provisionalMilestonesForRequest("проанализируй проект")
	if len(milestones) != 5 {
		t.Fatalf("expected 5 provisional milestones, got %d", len(milestones))
	}
	if milestones[0] != "Understand project purpose" {
		t.Fatalf("unexpected first milestone: %q", milestones[0])
	}
	if status := provisionalStatusForRequest("проанализируй проект"); status != "Planning project analysis..." {
		t.Fatalf("unexpected provisional status: %q", status)
	}
}

func TestSimpleFastPathDoesNotGetProvisionalMilestones(t *testing.T) {
	prompt := "fix typo in README.md"
	if !isSimpleFastPathRequest(prompt) {
		t.Fatal("test prompt should be classified as simple fast path")
	}
	if isComplexTaskRequest(prompt) {
		t.Fatal("simple fast path prompt should not be complex")
	}
}
