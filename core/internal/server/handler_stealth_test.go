package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/igoryan-dao/ricochet/internal/config"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

type captureWriter struct {
	messages []protocol.RPCMessage
}

func (w *captureWriter) Send(msg interface{}) error {
	rpcMsg, ok := msg.(protocol.RPCMessage)
	if !ok {
		return fmt.Errorf("unexpected message type %T", msg)
	}
	w.messages = append(w.messages, rpcMsg)
	return nil
}

func TestGetModelsHonorsHidePromptTrainingModels(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("RICOCHET_DISABLE_OPENROUTER_MODEL_SYNC", "1")

	providersPath := filepath.Join(t.TempDir(), "providers.yaml")
	writeTestFile(t, providersPath, []byte(`
providers:
  test:
    enabled: true
    models:
      - id: "training"
        name: "Training"
        context_window: 1000
        supports_tools: true
        may_train_on_your_prompts: true
      - id: "unknown"
        name: "Unknown"
        context_window: 1000
        supports_tools: true
default_provider: "test"
default_model: "unknown"
byok:
  enabled: true
  show_server_providers: true
`))

	pm, err := config.NewProvidersManager(providersPath)
	if err != nil {
		t.Fatalf("NewProvidersManager: %v", err)
	}
	settings, err := config.NewStore()
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := settings.Update(func(s *config.Settings) {
		s.HidePromptTrainingModels = true
	}); err != nil {
		t.Fatalf("Update settings: %v", err)
	}

	h := &Handler{Providers: pm, Settings: settings}
	writer := &captureWriter{}
	h.HandleMessage(protocol.RPCMessage{ID: 1, Type: "get_models"}, writer)
	if len(writer.messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(writer.messages))
	}

	var payload struct {
		Providers                []config.AvailableProvider `json:"providers"`
		HidePromptTrainingModels bool                       `json:"hide_prompt_training_models"`
	}
	if err := json.Unmarshal(writer.messages[0].Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if !payload.HidePromptTrainingModels {
		t.Fatal("hide_prompt_training_models response flag = false, want true")
	}
	if len(payload.Providers) != 1 || len(payload.Providers[0].Models) != 1 {
		t.Fatalf("filtered providers = %#v, want one visible model", payload.Providers)
	}
	if got := payload.Providers[0].Models[0].ID; got != "unknown" {
		t.Fatalf("visible model = %q, want unknown", got)
	}
	if got := payload.Providers[0].HiddenPromptTrainingModelCount; got != 1 {
		t.Fatalf("hidden prompt-training count = %d, want 1", got)
	}
}

func TestGetSettingsIncludesHidePromptTrainingModels(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	settings, err := config.NewStore()
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := settings.Update(func(s *config.Settings) {
		s.HidePromptTrainingModels = true
	}); err != nil {
		t.Fatalf("Update settings: %v", err)
	}

	h := &Handler{Settings: settings}
	writer := &captureWriter{}
	h.HandleMessage(protocol.RPCMessage{ID: 1, Type: "get_settings"}, writer)
	if len(writer.messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(writer.messages))
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(writer.messages[0].Payload, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["hide_prompt_training_models"] != true {
		t.Fatalf("hide_prompt_training_models = %#v, want true", payload["hide_prompt_training_models"])
	}
}

func writeTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
