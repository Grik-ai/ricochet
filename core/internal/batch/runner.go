package batch

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
)

type WorkerExecutionRequest struct {
	RunID                string
	WorkerID             string
	AgentSessionID       string
	ParentSessionID      string
	Goal                 string
	WorkerTitle          string
	Contract             string
	WorktreePath         string
	ScopePaths           []string
	Attempt              int
	SelfFix              bool
	VerificationFailure  string
	VerificationCommands []string
}

type WorkerExecutionResult struct {
	Status        string
	Summary       string
	OutputPreview string
}

type WorkerExecutor interface {
	ExecuteBatchWorker(ctx context.Context, req WorkerExecutionRequest) (WorkerExecutionResult, error)
}

type Runner struct {
	manager  *Manager
	executor WorkerExecutor
	onEvent  func(protocol.BatchEvent)

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func NewRunner(manager *Manager, executor WorkerExecutor) *Runner {
	return &Runner{
		manager:  manager,
		executor: executor,
		cancels:  map[string]context.CancelFunc{},
	}
}

func (r *Runner) SetEventHandler(handler func(protocol.BatchEvent)) {
	r.onEvent = handler
}

func (r *Runner) StartRun(ctx context.Context, runID string) (protocol.BatchRun, error) {
	if r.executor == nil {
		return protocol.BatchRun{}, fmt.Errorf("batch worker executor is not configured")
	}
	run, err := r.manager.StartRun(runID)
	if err != nil {
		return protocol.BatchRun{}, err
	}
	run, err = r.manager.MarkRunRunning(run.ID)
	if err != nil {
		return protocol.BatchRun{}, err
	}
	r.emit("run_started", run.ID, "", run.Status, &run, nil, "Batch model-workers started.")
	go r.scheduleRun(ctx, run.ID)
	return run, nil
}

func (r *Runner) AbortRun(runID string) (protocol.BatchRun, error) {
	run, ok := r.manager.GetRun(runID)
	if ok {
		r.mu.Lock()
		for _, worker := range run.Workers {
			if cancel := r.cancels[worker.ID]; cancel != nil {
				cancel()
			}
		}
		r.mu.Unlock()
	}
	run, err := r.manager.AbortRun(runID)
	if err != nil {
		return protocol.BatchRun{}, err
	}
	r.emit("run_aborted", run.ID, "", run.Status, &run, nil, "Batch run aborted.")
	return run, nil
}

func (r *Runner) RetryWorker(ctx context.Context, workerID string) (protocol.BatchRun, error) {
	run, worker, err := r.manager.QueueWorkerRetry(workerID)
	if err != nil {
		return protocol.BatchRun{}, err
	}
	r.emit("worker_retry_queued", run.ID, worker.ID, worker.Status, &run, &worker, "Worker retry queued.")
	go r.runWorker(ctx, run, worker)
	return run, nil
}

func (r *Runner) scheduleRun(ctx context.Context, runID string) {
	run, ok := r.manager.GetRun(runID)
	if !ok {
		return
	}
	maxWorkers := normalizeMaxWorkers(run.MaxWorkers)
	sem := make(chan struct{}, maxWorkers)
	var wg sync.WaitGroup
	for _, worker := range run.Workers {
		if worker.Status != "queued" {
			continue
		}
		worker := worker
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			r.runWorker(ctx, run, worker)
		}()
	}
	wg.Wait()
	finalRun, err := r.manager.FinalizeRun(runID)
	if err == nil {
		r.emit("run_finished", finalRun.ID, "", finalRun.Status, &finalRun, nil, "Batch run finished.")
	}
}

func (r *Runner) runWorker(ctx context.Context, run protocol.BatchRun, worker protocol.BatchWorker) {
	workerCtx, cancel := context.WithCancel(ctx)
	r.mu.Lock()
	r.cancels[worker.ID] = cancel
	r.mu.Unlock()
	defer func() {
		cancel()
		r.mu.Lock()
		delete(r.cancels, worker.ID)
		r.mu.Unlock()
	}()

	attempt := worker.Attempt
	if attempt <= 0 {
		attempt = 1
	}
	agentSessionID := fmt.Sprintf("bw_%s_a%d", strings.ReplaceAll(worker.ID, "-", "_"), attempt)
	updatedRun, runningWorker, err := r.manager.MarkWorkerRunning(worker.ID, agentSessionID)
	if err != nil {
		r.emit("worker_failed", run.ID, worker.ID, "failed", &run, &worker, err.Error())
		return
	}
	r.emit("worker_running", updatedRun.ID, runningWorker.ID, runningWorker.Status, &updatedRun, &runningWorker, "Worker is running.")

	contract := r.workerContract(updatedRun, runningWorker, "")
	result, execErr := r.executor.ExecuteBatchWorker(workerCtx, WorkerExecutionRequest{
		RunID:                updatedRun.ID,
		WorkerID:             runningWorker.ID,
		AgentSessionID:       agentSessionID,
		ParentSessionID:      updatedRun.SessionID,
		Goal:                 updatedRun.Goal,
		WorkerTitle:          runningWorker.Title,
		Contract:             contract,
		WorktreePath:         runningWorker.Path,
		ScopePaths:           runningWorker.ScopePaths,
		Attempt:              attempt,
		VerificationCommands: runningWorker.VerificationCommands,
	})

	status := statusFromExecution(result, execErr)
	summary := strings.TrimSpace(result.Summary)
	outputPreview := result.OutputPreview
	errText := ""
	if execErr != nil {
		errText = execErr.Error()
		if summary == "" {
			summary = errText
		}
	}

	tests, testLog, verificationStatus := r.runVerification(workerCtx, runningWorker)
	if verificationStatus == "failed" && workerCtx.Err() == nil && execErr == nil {
		fixContext := testLog
		fixContract := r.workerContract(updatedRun, runningWorker, fixContext)
		fixResult, fixErr := r.executor.ExecuteBatchWorker(workerCtx, WorkerExecutionRequest{
			RunID:                updatedRun.ID,
			WorkerID:             runningWorker.ID,
			AgentSessionID:       agentSessionID,
			ParentSessionID:      updatedRun.SessionID,
			Goal:                 updatedRun.Goal,
			WorkerTitle:          runningWorker.Title,
			Contract:             fixContract,
			WorktreePath:         runningWorker.Path,
			ScopePaths:           runningWorker.ScopePaths,
			Attempt:              attempt,
			SelfFix:              true,
			VerificationFailure:  fixContext,
			VerificationCommands: runningWorker.VerificationCommands,
		})
		if strings.TrimSpace(fixResult.Summary) != "" {
			summary = strings.TrimSpace(summary + "\n\nSelf-fix attempt:\n" + fixResult.Summary)
		}
		if fixErr != nil {
			errText = fixErr.Error()
			status = "failed"
		} else {
			status = statusFromExecution(fixResult, nil)
			outputPreview = fixResult.OutputPreview
			tests, testLog, verificationStatus = r.runVerification(workerCtx, runningWorker)
		}
	}

	if workerCtx.Err() != nil {
		status = "aborted"
		errText = workerCtx.Err().Error()
	}
	if verificationStatus == "failed" && status == "completed" {
		status = "failed"
		errText = "verification failed"
	}

	diffStat, _ := r.manager.gitOutput(runningWorker.Path, "diff", "--stat")
	patch, _ := r.manager.gitOutputRaw(runningWorker.Path, "diff", "--binary")
	artifacts, _ := r.manager.WriteWorkerArtifacts(runningWorker.ID, summary, patch, diffStat, testLog, map[string]interface{}{
		"worker_id":           runningWorker.ID,
		"run_id":              updatedRun.ID,
		"status":              status,
		"summary":             summary,
		"verification_status": verificationStatus,
		"attempt":             attempt,
	})
	completedRun, completedWorker, completeErr := r.manager.CompleteWorker(runningWorker.ID, status, summary, outputPreview, errText, verificationStatus, tests)
	if completeErr != nil {
		r.emit("worker_failed", updatedRun.ID, runningWorker.ID, "failed", &updatedRun, &runningWorker, completeErr.Error())
		return
	}
	completedWorker.Artifacts = artifacts
	eventName := "worker_completed"
	if status != "completed" {
		eventName = "worker_" + status
	}
	r.emit(eventName, completedRun.ID, completedWorker.ID, completedWorker.Status, &completedRun, &completedWorker, summary)
}

func (r *Runner) runVerification(ctx context.Context, worker protocol.BatchWorker) ([]protocol.BatchTestResult, string, string) {
	if len(worker.VerificationCommands) == 0 {
		return nil, "No verification commands specified.\n", "skipped"
	}
	results := []protocol.BatchTestResult{}
	var log strings.Builder
	status := "passed"
	for _, command := range worker.VerificationCommands {
		command = strings.TrimSpace(command)
		if command == "" {
			continue
		}
		log.WriteString("$ ")
		log.WriteString(command)
		log.WriteString("\n")
		if disallowedWorkerCommand(command, worker.Path) {
			status = "failed"
			log.WriteString("blocked: command is not allowed for batch workers\n")
			results = append(results, protocol.BatchTestResult{Command: command, Status: "failed", ExitCode: -1})
			continue
		}
		cmdCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		cmd := exec.CommandContext(cmdCtx, "sh", "-lc", command)
		cmd.Dir = worker.Path
		output, err := cmd.CombinedOutput()
		cancel()
		exitCode := 0
		resultStatus := "passed"
		if err != nil {
			status = "failed"
			resultStatus = "failed"
			exitCode = 1
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			}
		}
		log.Write(output)
		if len(output) == 0 {
			log.WriteString("(no output)\n")
		}
		results = append(results, protocol.BatchTestResult{Command: command, Status: resultStatus, ExitCode: exitCode})
	}
	if len(results) == 0 {
		return nil, "No verification commands specified.\n", "skipped"
	}
	return results, log.String(), status
}

func (r *Runner) workerContract(run protocol.BatchRun, worker protocol.BatchWorker, verificationFailure string) string {
	var b strings.Builder
	b.WriteString("You are a Ricochet batch model-worker running in an isolated durable git worktree.\n\n")
	b.WriteString("Goal: " + run.Goal + "\n")
	b.WriteString("Worker: " + worker.Title + "\n")
	b.WriteString("Allowed worktree root: " + worker.Path + "\n")
	b.WriteString("Assigned scope: " + strings.Join(worker.ScopePaths, ", ") + "\n")
	b.WriteString("Verification commands: " + strings.Join(worker.VerificationCommands, " && ") + "\n\n")
	if verificationFailure != "" {
		b.WriteString("Previous verification failed. Fix exactly this failure once, then stop:\n")
		b.WriteString(verificationFailure + "\n\n")
	}
	b.WriteString("Required loop: inspect -> plan -> edit -> verify -> summarize.\n")
	b.WriteString("Never push, merge, rebase, apply to the main workspace, spawn nested subagents, use browser automation, or modify files outside the assigned worktree/scope.\n")
	b.WriteString("When finished output TASK_COMPLETE: followed by a concise summary. If blocked output TASK_FAILED: followed by the reason.\n")
	return b.String()
}

func statusFromExecution(result WorkerExecutionResult, err error) string {
	if err != nil {
		return "failed"
	}
	switch strings.ToLower(strings.TrimSpace(result.Status)) {
	case "timeout":
		return "timeout"
	case "failed", "failure":
		return "failed"
	case "aborted":
		return "aborted"
	default:
		return "completed"
	}
}

func disallowedWorkerCommand(command string, allowedRoot string) bool {
	lower := strings.ToLower(strings.TrimSpace(command))
	if safeguard.ContainsDangerousSubstitution(command) {
		return true
	}
	if safeguard.CommandMentionsPathOutsideRoot(command, allowedRoot) {
		return true
	}
	for _, token := range []string{"git push", "git merge", "git rebase", "git reset --hard", "rm -rf /"} {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return false
}

func (r *Runner) emit(event, runID, workerID, status string, run *protocol.BatchRun, worker *protocol.BatchWorker, message string) {
	if r.onEvent == nil {
		return
	}
	r.onEvent(protocol.BatchEvent{
		Event:     event,
		RunID:     runID,
		WorkerID:  workerID,
		Status:    status,
		Run:       run,
		Worker:    worker,
		Message:   truncate(message, 1000),
		Timestamp: time.Now().UnixMilli(),
	})
}

func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}
