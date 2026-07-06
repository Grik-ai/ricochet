package host

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestPTYManagerReadOutputIsIncremental(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("/bin/sh is not available")
	}
	manager := NewPTYManager()
	session, err := manager.Start("/bin/sh", nil, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	defer manager.Close(session.ID)

	if err := manager.WriteInput(session.ID, "printf 'ricochet_pty_test\\n'\n"); err != nil {
		t.Fatalf("WriteInput returned error: %v", err)
	}

	var first string
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		out, err := manager.ReadOutput(session.ID)
		if err != nil {
			t.Fatalf("ReadOutput returned error: %v", err)
		}
		first += out
		if strings.Contains(first, "ricochet_pty_test") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(first, "ricochet_pty_test") {
		t.Fatalf("expected shell output, got %q", first)
	}

	second, err := manager.ReadOutput(session.ID)
	if err != nil {
		t.Fatalf("second ReadOutput returned error: %v", err)
	}
	if strings.Contains(second, "ricochet_pty_test") {
		t.Fatalf("expected incremental read without duplicated output, got %q", second)
	}
}
