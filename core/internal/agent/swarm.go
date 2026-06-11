package agent

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// SwarmConfig holds configuration for the orchestrator
type SwarmConfig struct {
	MaxWorkers int `json:"max_workers"`
}

// SubtaskInfo tracks a background worker task
type SubtaskInfo struct {
	ID          string
	TaskID      string // New: link to PlanManager task
	ParentID    string
	RunID       string
	Description string
	Status      string
	StartTime   time.Time
	Result      string
	Cancel      context.CancelFunc // Added to support aborting
}

type WorkerOptions struct {
	Depth                     string
	MaxTurns                  int
	Timeout                   time.Duration
	ReadOnly                  bool
	SuppressParentChatUpdates bool
}

// SwarmOrchestrator (Refactored) manages delegation of tasks to workers.
// No longer uses a ticker loop; operations are driven by the Coordinator Agent.
type SwarmOrchestrator struct {
	controller *Controller
	plan       *PlanManager
	mu         sync.RWMutex
	subtasks   map[string]*SubtaskInfo
	maxWorkers int
	sem        chan struct{}
}

// NewSwarmOrchestrator creates a new orchestrator for delegation
func NewSwarmOrchestrator(c *Controller, pm *PlanManager, cfg SwarmConfig) *SwarmOrchestrator {
	if cfg.MaxWorkers <= 0 {
		cfg.MaxWorkers = 2
		if c != nil {
			provider := strings.ToLower(c.config.Provider.Provider + " " + c.config.Provider.Model)
			if strings.Contains(provider, "zhipu") || strings.Contains(provider, "glm") {
				cfg.MaxWorkers = 1
			}
		}
	}
	return &SwarmOrchestrator{
		controller: c,
		plan:       pm,
		subtasks:   make(map[string]*SubtaskInfo),
		maxWorkers: cfg.MaxWorkers,
		sem:        make(chan struct{}, cfg.MaxWorkers),
	}
}

// SpawnWorker creates a new sub-agent as a background task
func (so *SwarmOrchestrator) SpawnWorker(ctx context.Context, parentID, taskID, goal, contextInfo string) (string, error) {
	return so.SpawnWorkerWithOptions(ctx, parentID, taskID, goal, contextInfo, WorkerOptions{})
}

func (so *SwarmOrchestrator) SpawnWorkerWithOptions(ctx context.Context, parentID, taskID, goal, contextInfo string, opts WorkerOptions) (string, error) {
	so.mu.Lock()

	childCtx, cancel := context.WithCancel(ctx)

	id := "agent-" + uuid.New().String()[:8]
	info := &SubtaskInfo{
		ID:          id,
		TaskID:      taskID,
		ParentID:    parentID,
		RunID:       protocol.GetRunID(ctx),
		Description: goal,
		Status:      "queued",
		StartTime:   time.Now(),
		Cancel:      cancel,
	}
	so.subtasks[id] = info
	queued, _ := so.workerCountsLocked()
	so.mu.Unlock()

	so.controller.ReportTaskProgress(ctx, protocol.TaskProgress{
		SessionID:       parentID,
		Event:           "worker_spawned",
		TaskName:        goal,
		Status:          "queued",
		Mode:            "execution",
		IsActive:        true,
		AgentIdentifier: id,
		AgentColor:      "#00FF99",
		WorkerQueued:    queued,
		WorkerRunning:   so.maxWorkers,
		ParentTaskID:    taskID,
		Summary:         fmt.Sprintf("Worker queued. Concurrency limit: %d at a time.", so.maxWorkers),
	})

	// If linked to a plan task, mark it as active
	if taskID != "" && so.plan != nil {
		so.plan.SetColumn(taskID, "in_progress")
	}

	// Run in background
	go func(ctx context.Context) {
		// --- Rate Limit Mitigation: Coordinated Sequential Jitter ---
		// We use a broader staggering range to prevent concurrent API spikes
		so.mu.RLock()
		workerCount := 0
		for _, s := range so.subtasks {
			if s.Status == "running" || s.Status == "queued" {
				workerCount++
			}
		}
		so.mu.RUnlock()

		// Stagger: 1s per active worker + 1-5s random jitter (reduced from 10s for better UX)
		delay := time.Duration(workerCount*1) * time.Second
		jitter := time.Duration(time.Now().UnixNano()%5000) * time.Millisecond
		time.Sleep(delay + jitter)

		// Acquire semaphore
		select {
		case so.sem <- struct{}{}:
		case <-ctx.Done():
			return
		}
		defer func() { <-so.sem }()

		so.updateStatus(id, "running")
		so.controller.ReportTaskProgress(ctx, protocol.TaskProgress{
			SessionID:       parentID,
			Event:           "worker_running",
			TaskName:        goal,
			Status:          "running",
			Mode:            "execution",
			IsActive:        true,
			AgentIdentifier: id,
			AgentColor:      "#00FF99",
			WorkerQueued:    queued,
			WorkerRunning:   so.maxWorkers,
			ParentTaskID:    taskID,
			Summary:         "Worker is running.",
		})

		// --- Isolation: Create Git Worktree or Snapshot ---
		worktreePath := filepath.Join(os.TempDir(), "ricochet-worktree-"+id)
		isolationEnabled := false
		if so.controller.GetGitManager().IsRepo() && so.controller.GetGitManager().HasValidHead() {
			log.Printf("[Swarm] Creating isolation worktree for %s at %s", id, worktreePath)
			branchName := "worker-" + id
			if err := so.controller.GetGitManager().CreateWorktree(worktreePath, "-b", branchName); err == nil {
				if syncErr := so.controller.GetGitManager().SyncDirtyFilesToWorktree(worktreePath); syncErr != nil {
					log.Printf("[Swarm] Failed to sync dirty workspace into %s: %v", worktreePath, syncErr)
					_ = so.controller.GetGitManager().RemoveWorktree(worktreePath)
				} else {
					isolationEnabled = true
					defer so.controller.GetGitManager().RemoveWorktree(worktreePath)
				}
			} else {
				log.Printf("[Swarm] Failed to create isolation worktree for %s: %v", id, err)
			}
		} else {
			log.Printf("[Swarm] Git worktree isolation unavailable for %s; repository has no valid HEAD or is not a repo", id)
		}

		if !isolationEnabled {
			snapshotPath := filepath.Join(os.TempDir(), "ricochet-snapshot-"+id)
			sourceRoot := so.controller.GetCWD()
			if sourceRoot == "" && so.controller.GetHost() != nil {
				sourceRoot = so.controller.GetHost().GetCWD()
			}
			log.Printf("[Swarm] Creating workspace snapshot for %s at %s", id, snapshotPath)
			if err := copyWorkspaceSnapshot(sourceRoot, snapshotPath); err != nil {
				log.Printf("[Swarm] Failed to create workspace snapshot for %s: %v", id, err)
			} else {
				worktreePath = snapshotPath
				isolationEnabled = true
				defer os.RemoveAll(snapshotPath)
			}
		}

		effectiveCwd := so.controller.GetCWD()
		if isolationEnabled {
			effectiveCwd = worktreePath
		}

		// --- Blueprint Fetch ---
		var preconditions []string
		var expectedOutcome string
		if taskID != "" && so.plan != nil {
			tasks := so.plan.ListTasks("")
			for _, t := range tasks {
				if t.ID == taskID {
					preconditions = t.Preconditions
					expectedOutcome = t.ExpectedOutcome
					break
				}
			}
		}

		// Update TUI
		so.controller.ReportTaskProgress(ctx, protocol.TaskProgress{
			TaskName:        goal,
			Status:          "In Progress",
			Mode:            "execution",
			IsActive:        true,
			AgentIdentifier: id,
			AgentColor:      "#00FF99",
		})

		runCtx := ctx
		var timeoutCancel context.CancelFunc
		if opts.Timeout > 0 {
			runCtx, timeoutCancel = context.WithTimeout(ctx, opts.Timeout)
			defer timeoutCancel()
		}

		// Run the actual subtask logic
		output, err := so.controller.RunSubtaskInDirWithOptions(runCtx, parentID, goal, contextInfo, "worker", effectiveCwd, preconditions, expectedOutcome, SubtaskRunOptions{
			MaxTurns:                  opts.MaxTurns,
			ReadOnly:                  opts.ReadOnly,
			SuppressParentChatUpdates: opts.SuppressParentChatUpdates,
		})

		so.mu.Lock()
		finalResult := ""
		if err != nil {
			info.Status = "failed"
			info.Result = fmt.Sprintf("Error: %v", err)
			finalResult = info.Result
			if taskID != "" && so.plan != nil {
				so.plan.UpdateTaskStatus(taskID, "failed")
			}
		} else {
			if strings.Contains(output, `"status":"timeout"`) {
				info.Status = "timeout"
			} else {
				info.Status = "completed"
			}
			info.Result = output
			finalResult = info.Result
			if taskID != "" && so.plan != nil {
				so.plan.CompleteTask(taskID, output)
			}
		}
		so.mu.Unlock()

		// Final TUI update
		status := "completed"
		color := "#00FF99"
		eventName := "worker_completed"
		if strings.Contains(output, `"status":"timeout"`) {
			status = "timeout"
			color = "#EAB308"
			eventName = "mission_timed_out"
		}
		if err != nil {
			status = "failed"
			color = "#FF0000"
			eventName = "worker_failed"
		}

		structuredResult := fmt.Sprintf("<task-notification>\n<task-id>%s</task-id>\n<plan-task-id>%s</plan-task-id>\n<status>%s</status>\n<summary>%s</summary>\n<result>%s</result>\n</task-notification>", id, taskID, status, goal, finalResult)

		so.controller.ReportTaskProgress(ctx, protocol.TaskProgress{
			TaskName:        goal,
			SessionID:       parentID,
			Event:           eventName,
			Status:          status,
			IsActive:        false,
			AgentIdentifier: id,
			AgentColor:      color,
			Summary:         structuredResult,
			Result:          finalResult,
			ParentTaskID:    taskID,
		})

		log.Printf("[Swarm] Worker %s finished context: %s", id, status)
	}(childCtx)

	return id, nil
}

func copyWorkspaceSnapshot(srcRoot, dstRoot string) error {
	if strings.TrimSpace(srcRoot) == "" {
		return fmt.Errorf("empty workspace root")
	}
	if info, err := os.Stat(srcRoot); err != nil {
		return err
	} else if !info.IsDir() {
		return fmt.Errorf("workspace root is not a directory: %s", srcRoot)
	}

	skipDirs := map[string]bool{
		".git":         true,
		".ricochet":    true,
		"node_modules": true,
		"target":       true,
		"dist":         true,
		"build":        true,
		".next":        true,
		".turbo":       true,
		".venv":        true,
		"__pycache__":  true,
	}

	if err := os.RemoveAll(dstRoot); err != nil {
		return err
	}
	return filepath.WalkDir(srcRoot, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(srcRoot, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return os.MkdirAll(dstRoot, 0755)
		}
		if d.IsDir() && skipDirs[d.Name()] {
			return filepath.SkipDir
		}

		target := filepath.Join(dstRoot, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}

		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		return copySnapshotFile(path, target, info.Mode())
	})
}

func copySnapshotFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

func (so *SwarmOrchestrator) updateStatus(id, status string) {
	so.mu.Lock()
	defer so.mu.Unlock()
	if info, ok := so.subtasks[id]; ok {
		info.Status = status
	}
}

func (so *SwarmOrchestrator) workerCountsLocked() (queued int, running int) {
	for _, s := range so.subtasks {
		switch s.Status {
		case "queued":
			queued++
		case "running":
			running++
		}
	}
	return queued, running
}

// GetSubtaskStatus returns a string representation of the worker status
func (so *SwarmOrchestrator) GetSubtaskStatus(id string) (string, bool) {
	info, ok := so.GetSubtask(id)
	if !ok {
		return "", false
	}

	res := fmt.Sprintf("Worker: %s\nStatus: %s\nGoal: %s\nStarted: %v\nResult: %s",
		id, info.Status, info.Description, info.StartTime.Format(time.RFC3339), info.Result)
	return res, true
}

// GetSubtask returns info about a specific worker
func (so *SwarmOrchestrator) GetSubtask(id string) (*SubtaskInfo, bool) {
	so.mu.RLock()
	defer so.mu.RUnlock()
	info, ok := so.subtasks[id]
	return info, ok
}

// ListSubtasks returns all managed workers
func (so *SwarmOrchestrator) ListSubtasks() []*SubtaskInfo {
	so.mu.RLock()
	defer so.mu.RUnlock()
	res := make([]*SubtaskInfo, 0, len(so.subtasks))
	for _, s := range so.subtasks {
		res = append(res, s)
	}
	return res
}

// AbortAll cancels all currently running subtasks
func (so *SwarmOrchestrator) AbortAll() {
	so.mu.Lock()
	defer so.mu.Unlock()
	count := 0
	for _, info := range so.subtasks {
		if info.Status == "running" || info.Status == "queued" {
			if info.Cancel != nil {
				info.Cancel()
				count++
			}
			info.Status = "failed"
			info.Result = "Aborted by user"
			progressCtx := context.Background()
			if info.RunID != "" {
				progressCtx = protocol.WithRunID(progressCtx, info.RunID)
			}
			so.controller.ReportTaskProgress(progressCtx, protocol.TaskProgress{
				SessionID:       info.ParentID,
				RunID:           info.RunID,
				Event:           "worker_aborted",
				TaskName:        info.Description,
				Status:          "aborted",
				Mode:            "execution",
				IsActive:        false,
				AgentIdentifier: info.ID,
				AgentColor:      "#FF5555",
				ParentTaskID:    info.TaskID,
				Summary:         "Worker aborted by user.",
			})
		}
	}
	if count > 0 {
		log.Printf("[Swarm] Aborted %d active subtasks.", count)
	}
}
