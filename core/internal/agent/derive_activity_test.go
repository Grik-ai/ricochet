package agent

import (
	"strings"
	"testing"
)

func TestDeriveActivityExecutePython(t *testing.T) {
	controller := &Controller{}
	script := `print('Project analysis completed')`
	result := "Project analysis completed\n"

	activity := controller.deriveActivity("execute_python", `{"script":"`+script+`"}`, result)
	if activity == nil {
		t.Fatal("expected execute_python to produce an activity")
	}

	if activity.Type != "command" {
		t.Fatalf("expected command activity, got %q", activity.Type)
	}
	if activity.Command != "python3 <script>" {
		t.Fatalf("expected sanitized python command, got %q", activity.Command)
	}
	if activity.Shell != "python" {
		t.Fatalf("expected python shell marker, got %q", activity.Shell)
	}
	if activity.Script != script {
		t.Fatalf("expected script body to be preserved for expandable details")
	}
	if !strings.Contains(activity.ResultPreview, "Project analysis completed") {
		t.Fatalf("expected result preview to contain stdout, got %q", activity.ResultPreview)
	}
	if strings.Contains(activity.Command, script) || strings.Contains(activity.ResultPreview, `"script"`) {
		t.Fatalf("raw tool arguments leaked into visible activity fields")
	}
}
