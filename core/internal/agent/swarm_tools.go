package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/tools"
)

// StartSwarmToolImpl implements the logic for starting the swarm
type StartSwarmToolImpl struct {
	Orchestrator *SwarmOrchestrator
}

func (t *StartSwarmToolImpl) Definition() protocol.Tool {
	def := tools.StartSwarmTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *StartSwarmToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	if t.Orchestrator == nil {
		return "", fmt.Errorf("swarm orchestrator not initialized")
	}

	var input struct {
		Confirm    bool   `json:"confirm"`
		Goal       string `json:"goal"`
		MinWorkers int    `json:"min_workers"`
		Depth      string `json:"depth"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if !input.Confirm {
		return "", fmt.Errorf("confirm must be true to start swarm")
	}

	parentID := protocol.GetSessionID(ctx)
	spawned := make([]string, 0)

	runnable := []TaskItem(nil)
	if t.Orchestrator.plan != nil {
		runnable = t.Orchestrator.plan.GetRunnableTasks()
	}

	if len(runnable) > 0 {
		limit := t.Orchestrator.maxWorkers
		if limit <= 0 {
			limit = 5
		}
		for i, task := range runnable {
			if i >= limit {
				break
			}
			contextInfo := task.Context
			if contextInfo == "" {
				contextInfo = task.Description
			}
			id, err := t.Orchestrator.SpawnWorker(ctx, parentID, task.ID, task.Title, contextInfo)
			if err != nil {
				return "", err
			}
			spawned = append(spawned, fmt.Sprintf("%s -> %s", id, task.Title))
		}
		return fmt.Sprintf("Swarm started with %d worker(s) from the runnable plan:\n%s", len(spawned), strings.Join(spawned, "\n")), nil
	}

	depth := strings.ToLower(strings.TrimSpace(input.Depth))
	if depth == "" {
		depth = "fast"
	}
	if depth != "fast" && depth != "deep" {
		depth = "fast"
	}

	goal := strings.TrimSpace(input.Goal)
	if goal == "" {
		goal = "Analyze the current project comprehensively and identify architecture, reliability, security, testing, and developer-experience improvements."
	}

	requestedWorkers := input.MinWorkers
	if depth == "fast" {
		requestedWorkers = 1
	} else if requestedWorkers < 3 {
		requestedWorkers = 4
	}

	defaultWorkers := []struct {
		description string
		prompt      string
	}{
		{
			description: "Architecture Analysis",
			prompt:      "You are a senior software architect. Analyze module boundaries, control flow, state management, provider/tool abstractions, and subagent orchestration. Report concrete risks and targeted improvements with file references.",
		},
		{
			description: "Reliability and Runtime Analysis",
			prompt:      "You are a reliability engineer. Analyze error handling, cancellation, concurrency, background worker lifecycle, logging, retries, filesystem/git isolation, and recovery behavior. Report concrete failure modes and fixes with file references.",
		},
		{
			description: "Security and Permission Analysis",
			prompt:      "You are a security reviewer for an IDE coding agent. Analyze command execution, file write boundaries, approval flows, secret handling, MCP/tool permissions, and workspace isolation. Report vulnerabilities and mitigations with file references.",
		},
		{
			description: "Testing and Developer Experience Analysis",
			prompt:      "You are a senior test engineer. Analyze existing tests, missing regression coverage, build scripts, extension/core integration risks, and developer workflow pain points. Propose focused tests and quick wins with file references.",
		},
		{
			description: "Frontend and Extension UX Analysis",
			prompt:      "You are a VS Code extension UX engineer. Analyze chat streaming, permission UI, task progress, session state, logs, and error surfacing. Report UX/runtime issues and practical fixes with file references.",
		},
	}

	if requestedWorkers > len(defaultWorkers) {
		requestedWorkers = len(defaultWorkers)
	}

	workerOpts := WorkerOptions{Depth: depth}
	if depth == "fast" {
		workerOpts.MaxTurns = 8
		workerOpts.Timeout = 2 * time.Minute
		workerOpts.ReadOnly = true
		workerOpts.SuppressParentChatUpdates = true
	}

	for i, worker := range defaultWorkers {
		if i >= requestedWorkers {
			break
		}
		prompt := fmt.Sprintf("Overall user goal: %s\n\n%s\n\nWork independently. Do not edit files unless explicitly necessary; focus on a concise, evidence-backed report.", goal, worker.prompt)
		if depth == "fast" {
			prompt += "\n\nFAST BOUNDED MODE: inspect only the highest-signal files, prefer grouped reads/searches, use the scratchpad only for concise notes, and finish with TASK_COMPLETE within 8 turns or a best-effort summary."
		}
		id, err := t.Orchestrator.SpawnWorkerWithOptions(ctx, parentID, "", worker.description, prompt, workerOpts)
		if err != nil {
			return "", err
		}
		spawned = append(spawned, fmt.Sprintf("%s -> %s", id, worker.description))
	}

	concurrency := t.Orchestrator.maxWorkers
	if concurrency <= 0 {
		concurrency = len(spawned)
	}
	if depth == "fast" {
		return fmt.Sprintf("Fast bounded swarm started with %d compact worker(s), running up to %d at a time:\n%s", len(spawned), concurrency, strings.Join(spawned, "\n")), nil
	}
	if concurrency < len(spawned) {
		return fmt.Sprintf("Deep swarm queued %d specialized worker(s), running up to %d at a time:\n%s", len(spawned), concurrency, strings.Join(spawned, "\n")), nil
	}

	return fmt.Sprintf("Deep swarm started with %d specialized worker(s):\n%s", len(spawned), strings.Join(spawned, "\n")), nil
}

// UpdatePlanToolImpl implements the logic for updating the plan
type UpdatePlanToolImpl struct {
	Plan *PlanManager
}

func (t *UpdatePlanToolImpl) Definition() protocol.Tool {
	def := tools.UpdatePlanTool
	return protocol.Tool{
		Name:        def.Name,
		Description: def.Description,
		InputSchema: def.InputSchema,
	}
}

func (t *UpdatePlanToolImpl) Execute(ctx context.Context, args json.RawMessage) (string, error) {
	var input struct {
		TaskID       string   `json:"task_id"`
		Status       string   `json:"status"`
		Dependencies []string `json:"dependencies"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if t.Plan == nil {
		return "", fmt.Errorf("plan manager not initialized")
	}

	// Update status
	if err := t.Plan.UpdateTaskStatus(input.TaskID, input.Status); err != nil {
		return "", err
	}

	// Update dependencies if provided
	if len(input.Dependencies) > 0 {
		if err := t.Plan.SetDependencies(input.TaskID, input.Dependencies); err != nil {
			return "", err
		}
	}

	return fmt.Sprintf("✅ Task %s updated to %s", input.TaskID, input.Status), nil
}
