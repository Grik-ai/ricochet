package agent

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// AuditResult represents the outcome of a semantic check
type AuditResult struct {
	Approved bool
	Feedback string
}

// ShadowAuditor is a specialized agent role focused on detecting hallucinations,
// drift from blueprints, and logic errors in tool outputs.
type ShadowAuditor struct {
	provider     Provider
	defaultModel string
}

// NewShadowAuditor creates a new auditor
func NewShadowAuditor(provider Provider, model string) *ShadowAuditor {
	return &ShadowAuditor{
		provider:     provider,
		defaultModel: model,
	}
}

func (a *ShadowAuditor) SetProvider(provider Provider, model string) {
	a.provider = provider
	a.defaultModel = model
}

// AuditAction checks a single tool execution for correctness and adherence to the plan.
func (a *ShadowAuditor) AuditAction(ctx context.Context, goal string, toolName string, args string, result string, expectedOutcome string) (bool, string, error) {
	log.Printf("[ShadowAuditor] Auditing action in goal '%s': %s", goal, toolName)

	systemPrompt := `You are a specialized Shadow Auditor Agent. Your ONLY job is to verify if an Execution Agent's action was successful and correct.
CRITERIA:
1. HALLUCINATION: Did the agent claim success while the output shows failure?
2. DRIFT: Did the agent deviate from the specified goal?
3. LOGIC: Is the code/result logically consistent with the arguments?
4. EXPECTED OUTCOME: If a specific outcome is defined, did the result meet it?

SPECIAL NOTE ON DIAGNOSTICS:
If the tool is a diagnostic command (e.g., 'cargo check', 'git status', 'ls'), it is acceptable and expected for it to show errors, warnings, or empty sets. This is part of the agent's research process. ONLY reject if the agent ignores a catastrophic system error (e.g., 'Permission Denied', 'Command not found') and continues as if nothing happened.

If everything is correct according to these criteria, output 'APPROVED'.
If there is a clear error or drift, output 'REJECTED:' followed by a detailed explanation (feedback) on how to fix it.`

	userPrompt := fmt.Sprintf("GOAL: %s\n", goal)
	if expectedOutcome != "" {
		userPrompt += fmt.Sprintf("EXPECTED OUTCOME: %s\n", expectedOutcome)
	}
	userPrompt += fmt.Sprintf("TOOL: %s\nARGS: %s\nRESULT: %s\n\nPlease audit this action. BE CONCISE.", toolName, args, result)

	messages := []protocol.Message{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userPrompt},
	}

	req := &ChatRequest{
		Model:     a.defaultModel,
		Messages:  messages,
		MaxTokens: 300,
	}

	resp, err := a.provider.Chat(ctx, req)
	if err != nil {
		return false, "", err
	}

	content := strings.TrimSpace(resp.Content)
	if strings.HasPrefix(content, "APPROVED") {
		return true, "", nil
	}

	feedback := strings.TrimPrefix(content, "REJECTED:")
	return false, strings.TrimSpace(feedback), nil
}

// AuditCompletion verifies if a completed worker task actually met its criteria.
func (a *ShadowAuditor) AuditCompletion(ctx context.Context, goal string, summary string) (*AuditResult, error) {
	log.Printf("[ShadowAuditor] Auditing completion for goal: %s", goal)

	systemPrompt := `You are a specialized Verification Agent. Your job is to ensure a sub-task is TRULY complete.
Assess the final summary against the original goal.
If the goal is fully achieved, output 'COMPLETED'.
If there are missing requirements or bugs, output 'INCOMPLETE:' followed by what is missing.`

	userPrompt := fmt.Sprintf("ORIGINAL GOAL: %s\nFINAL SUMMARY: %s\n\nIs this task truly finished?", goal, summary)

	messages := []protocol.Message{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userPrompt},
	}

	req := &ChatRequest{
		Model:     a.defaultModel,
		Messages:  messages,
		MaxTokens: 500,
	}

	resp, err := a.provider.Chat(ctx, req)
	if err != nil {
		return nil, err
	}

	content := strings.TrimSpace(resp.Content)
	if strings.HasPrefix(content, "COMPLETED") {
		return &AuditResult{Approved: true}, nil
	}

	feedback := strings.TrimPrefix(content, "INCOMPLETE:")
	return &AuditResult{Approved: false, Feedback: strings.TrimSpace(feedback)}, nil
}

// AuditPlan verifies if the proposed plan is logically sound and feasible.
func (a *ShadowAuditor) AuditPlan(ctx context.Context, mission string, plan string) (*AuditResult, error) {
	log.Printf("[ShadowAuditor] Auditing plan for mission: %s", mission)

	systemPrompt := `You are a specialized Planning Auditor Agent. Your job is to detect high-level errors in an agent's proposed implementation plan.
CHECK FOR:
1. HALLUCINATED TOOLS: Does the plan rely on tools that don't exist?
2. MISSING STEPS: Does the plan skip critical setup or verification steps?
3. RISKY COMMANDS: Does the plan use dangerous commands (rm -rf, git push -f) without justification?
4. SCOPE CREEP: Does the plan include tasks unrelated to the mission?

If the plan is sound, output 'APPROVED'.
If the plan has issues, output 'FLAWED:' followed by specific feedback.`

	userPrompt := fmt.Sprintf("MISSION: %s\nPROPOSED PLAN:\n%s\n\nIs this plan logically sound?", mission, plan)

	messages := []protocol.Message{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userPrompt},
	}

	req := &ChatRequest{
		Model:     a.defaultModel,
		Messages:  messages,
		MaxTokens: 500,
	}

	resp, err := a.provider.Chat(ctx, req)
	if err != nil {
		return nil, err
	}

	content := strings.TrimSpace(resp.Content)
	if strings.Contains(content, "APPROVED") {
		return &AuditResult{Approved: true}, nil
	}

	feedback := strings.TrimPrefix(content, "FLAWED:")
	return &AuditResult{Approved: false, Feedback: strings.TrimSpace(feedback)}, nil
}
