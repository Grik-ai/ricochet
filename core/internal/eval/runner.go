package eval

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/igoryan-dao/ricochet/internal/agent"
)

type Runner struct {
	config *Config
}

func NewRunner(cfg *Config) *Runner {
	if cfg == nil {
		cfg = &Config{
			MaxTurns:  10,
			MaxTokens: 4000,
		}
	}
	return &Runner{config: cfg}
}

// Run executes a single test case
func (r *Runner) Run(ctx context.Context, tc *TestCase) (*Result, error) {
	startTime := time.Now()
	result := &Result{
		TestCaseID: tc.ID,
		Logs:       []string{},
		Errors:     []string{},
	}

	// 1. Setup Sandbox
	tempDir, err := os.MkdirTemp("", "ricochet-eval-"+tc.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to create sandbox: %w", err)
	}
	defer os.RemoveAll(tempDir)

	result.Logs = append(result.Logs, fmt.Sprintf("Sandbox created: %s", tempDir))

	// 2. Initialize Files
	for relPath, content := range tc.InitialState.Files {
		absPath := filepath.Join(tempDir, relPath)
		if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
			return nil, fmt.Errorf("failed to create directory for %s: %w", relPath, err)
		}
		if err := os.WriteFile(absPath, []byte(content), 0644); err != nil {
			return nil, fmt.Errorf("failed to write file %s: %w", relPath, err)
		}
	}

	// 3. Initialize Agent Controller
	// We need to override CWD for the executor to point to tempDir
	// Note: NewNativeExecutor uses current CWD by default in NewController.
	// We might need to adjust NewController to accept a base CWD.

	// For evals, we'll temporarily change CWD (safe in a CLI context, but not great in general)
	origCwd, _ := os.Getwd()
	os.Chdir(tempDir)
	defer os.Chdir(origCwd)

	ctrlCfg := &agent.Config{
		Provider: agent.ProviderConfig{
			Provider: tc.Config.Model, // Use model name as provider for now or parse it
			Model:    tc.Config.Model,
		},
		SystemPrompt: "You are an evaluation assistant. Follow instructions precisely.",
		MaxTokens:    r.config.MaxTokens,
	}
	if tc.Config != nil {
		if tc.Config.MaxTokens > 0 {
			ctrlCfg.MaxTokens = tc.Config.MaxTokens
		}
	}

	ctrl, err := agent.NewController(ctrlCfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create controller: %w", err)
	}

	// 4. Run Chat Loop
	req := agent.ChatRequestInput{
		SessionID: "eval-session",
		Content:   tc.Prompt,
	}

	chatErr := ctrl.Chat(ctx, req, func(update interface{}) {
		// Only check ChatUpdate for tool calls
		if chatUpdate, ok := update.(agent.ChatUpdate); ok {
			if chatUpdate.Message != nil && chatUpdate.Message.Role == "assistant" && len(chatUpdate.Message.ToolCalls) > 0 {
				for _, tc := range chatUpdate.Message.ToolCalls {
					result.Logs = append(result.Logs, fmt.Sprintf("Tool called: %s", tc.Name))
				}
			}
		}
	})

	if chatErr != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("Chat error: %v", chatErr))
		result.Success = false
	} else {
		// 5. Verify Assertions
		v := &Verifier{workspace: tempDir}
		if errs := v.Verify(tc.Expected); len(errs) > 0 {
			result.Errors = append(result.Errors, errs...)
			result.Success = false
		} else {
			result.Success = true
		}
	}

	result.Duration = time.Since(startTime)
	// Tokens and Turns extraction could be added by tracking session state
	return result, nil
}
