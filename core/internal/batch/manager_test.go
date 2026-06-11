package batch

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

func TestManagerCreatesDurableWorktreeAndAppliesWorkerPatch(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.name", "Ricochet Test")
	runGit(t, repo, "config", "user.email", "test@ricochet.local")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("before\n"), 0644); err != nil {
		t.Fatalf("write readme: %v", err)
	}
	runGit(t, repo, "add", ".")
	runGit(t, repo, "commit", "-m", "initial")

	manager, err := NewManager(repo, filepath.Join(t.TempDir(), "batch"))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	run, err := manager.CreateRun(CreateRunRequest{
		Goal:               "Update docs",
		MaxWorkers:         9,
		BaseCheckpointHash: "base-checkpoint",
		Workers:            []string{"Docs worker", "Tests worker", "UI worker", "Core worker", "Review worker", "Overflow worker"},
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if run.MaxWorkers != hardMaxWorkers || len(run.Workers) != hardMaxWorkers {
		t.Fatalf("worker cap mismatch: max=%d len=%d", run.MaxWorkers, len(run.Workers))
	}
	if run.BaseCheckpointHash != "base-checkpoint" {
		t.Fatalf("base checkpoint = %q", run.BaseCheckpointHash)
	}

	started, err := manager.StartRun(run.ID)
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	worker := started.Workers[0]
	if worker.Path == "" || worker.Branch == "" {
		t.Fatalf("worker worktree not prepared: %#v", worker)
	}
	if _, err := os.Stat(filepath.Join(worker.Path, "README.md")); err != nil {
		t.Fatalf("worker readme missing: %v", err)
	}

	if err := os.WriteFile(filepath.Join(worker.Path, "README.md"), []byte("after\n"), 0644); err != nil {
		t.Fatalf("worker edit: %v", err)
	}
	diff, err := manager.WorkerDiff(worker.ID)
	if err != nil {
		t.Fatalf("WorkerDiff: %v", err)
	}
	if !strings.Contains(diff.Patch, "after") {
		t.Fatalf("diff patch missing worker change:\n%s", diff.Patch)
	}

	applied, err := manager.ApplyWorker(worker.ID)
	if err != nil {
		t.Fatalf("ApplyWorker: %v", err)
	}
	if applied.Status != "applied" {
		t.Fatalf("applied status = %s", applied.Status)
	}
	raw, err := os.ReadFile(filepath.Join(repo, "README.md"))
	if err != nil {
		t.Fatalf("read main readme: %v", err)
	}
	if string(raw) != "after\n" {
		t.Fatalf("main readme = %q", string(raw))
	}

	cleaned, err := manager.CleanupRun(run.ID)
	if err != nil {
		t.Fatalf("CleanupRun: %v", err)
	}
	if cleaned.Status != "cleaned" {
		t.Fatalf("cleaned status = %s", cleaned.Status)
	}
}

func runGit(t *testing.T, cwd string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
}

func TestRunnerStartsWorkersAsynchronouslyAndWritesArtifacts(t *testing.T) {
	repo := makeTestRepo(t)
	manager, err := NewManager(repo, filepath.Join(t.TempDir(), "batch"))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	run, err := manager.CreateRun(CreateRunRequest{
		Goal:                 "Update docs",
		MaxWorkers:           1,
		Workers:              []string{"Docs worker | README.md"},
		VerificationCommands: []string{"grep worker README.md"},
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	events := make(chan protocolEvent, 16)
	runner := NewRunner(manager, fakeExecutor{})
	runner.SetEventHandler(func(event protocol.BatchEvent) {
		events <- protocolEvent{event: event.Event, status: event.Status}
	})

	started, err := runner.StartRun(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	if started.Status != "running" {
		t.Fatalf("started status = %s", started.Status)
	}

	completed := waitForWorkerStatus(t, manager, run.Workers[0].ID, "completed")
	if completed.Summary == "" || completed.ArtifactDir == "" {
		t.Fatalf("worker missing summary/artifact dir: %#v", completed)
	}
	diff, err := manager.WorkerDiff(completed.ID)
	if err != nil {
		t.Fatalf("WorkerDiff: %v", err)
	}
	if !strings.Contains(diff.Patch, "worker") {
		t.Fatalf("artifact patch missing worker edit:\n%s", diff.Patch)
	}
	if len(events) == 0 {
		t.Fatalf("expected batch events")
	}
}

func TestRunnerAbortCancelsRunningWorker(t *testing.T) {
	repo := makeTestRepo(t)
	manager, err := NewManager(repo, filepath.Join(t.TempDir(), "batch"))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	run, err := manager.CreateRun(CreateRunRequest{
		Goal:       "Blocked work",
		MaxWorkers: 1,
		Workers:    []string{"Blocking worker"},
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	executor := blockingExecutor{started: make(chan struct{})}
	runner := NewRunner(manager, executor)
	if _, err := runner.StartRun(context.Background(), run.ID); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	<-executor.started
	if _, err := runner.AbortRun(run.ID); err != nil {
		t.Fatalf("AbortRun: %v", err)
	}
	worker := waitForWorkerStatus(t, manager, run.Workers[0].ID, "aborted")
	if worker.Status != "aborted" {
		t.Fatalf("worker status = %s", worker.Status)
	}
}

func TestManagerRecoversCorruptStateFile(t *testing.T) {
	storage := t.TempDir()
	if err := os.WriteFile(filepath.Join(storage, "batch_runs.json"), []byte("{not-json"), 0644); err != nil {
		t.Fatalf("write corrupt state: %v", err)
	}
	manager, err := NewManager(makeTestRepo(t), storage)
	if err != nil {
		t.Fatalf("NewManager should recover corrupt state: %v", err)
	}
	if got := len(manager.ListRuns()); got != 0 {
		t.Fatalf("expected empty recovered run list, got %d", got)
	}
	matches, err := filepath.Glob(filepath.Join(storage, "batch_runs.json.corrupt.*"))
	if err != nil {
		t.Fatalf("glob corrupt backup: %v", err)
	}
	if len(matches) != 1 {
		t.Fatalf("expected one corrupt backup, got %#v", matches)
	}
}

func TestRunnerBlocksVerificationOutsideWorkerRoot(t *testing.T) {
	repo := makeTestRepo(t)
	manager, err := NewManager(repo, filepath.Join(t.TempDir(), "batch"))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	run, err := manager.CreateRun(CreateRunRequest{
		Goal:                 "Verify scope",
		MaxWorkers:           1,
		Workers:              []string{"Scope worker"},
		VerificationCommands: []string{"cat /etc/passwd"},
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	runner := NewRunner(manager, fakeExecutor{})
	if _, err := runner.StartRun(context.Background(), run.ID); err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	worker := waitForWorkerStatus(t, manager, run.Workers[0].ID, "failed")
	if worker.VerificationStatus != "failed" {
		t.Fatalf("expected verification failure, got %#v", worker)
	}
}

type protocolEvent struct {
	event  string
	status string
}

type fakeExecutor struct{}

func (fakeExecutor) ExecuteBatchWorker(_ context.Context, req WorkerExecutionRequest) (WorkerExecutionResult, error) {
	if err := os.WriteFile(filepath.Join(req.WorktreePath, "README.md"), []byte("worker\n"), 0644); err != nil {
		return WorkerExecutionResult{}, err
	}
	return WorkerExecutionResult{Status: "completed", Summary: "updated README", OutputPreview: "updated README"}, nil
}

type blockingExecutor struct {
	started chan struct{}
}

func (e blockingExecutor) ExecuteBatchWorker(ctx context.Context, _ WorkerExecutionRequest) (WorkerExecutionResult, error) {
	close(e.started)
	<-ctx.Done()
	return WorkerExecutionResult{Status: "aborted", Summary: "aborted"}, ctx.Err()
}

func waitForWorkerStatus(t *testing.T, manager *Manager, workerID, status string) protocol.BatchWorker {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		runs := manager.ListRuns()
		for _, run := range runs {
			for _, worker := range run.Workers {
				if worker.ID == workerID && worker.Status == status {
					return worker
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("worker %s did not reach %s", workerID, status)
	return protocol.BatchWorker{}
}

func makeTestRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.name", "Ricochet Test")
	runGit(t, repo, "config", "user.email", "test@ricochet.local")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("before\n"), 0644); err != nil {
		t.Fatalf("write readme: %v", err)
	}
	runGit(t, repo, "add", ".")
	runGit(t, repo, "commit", "-m", "initial")
	return repo
}
