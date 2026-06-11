package batch

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/igoryan-dao/ricochet/internal/protocol"
)

const (
	defaultMaxWorkers = 3
	hardMaxWorkers    = 5
)

type Manager struct {
	mu         sync.RWMutex
	cwd        string
	storageDir string
	statePath  string
	runs       map[string]protocol.BatchRun
}

type CreateRunRequest struct {
	SessionID            string   `json:"session_id,omitempty"`
	Goal                 string   `json:"goal"`
	MaxWorkers           int      `json:"max_workers,omitempty"`
	Workers              []string `json:"workers,omitempty"`
	VerificationCommands []string `json:"verification_commands,omitempty"`
	BaseCheckpointHash   string   `json:"base_checkpoint_hash,omitempty"`
}

type WorkerDiff struct {
	WorkerID string `json:"worker_id"`
	DiffStat string `json:"diff_stat,omitempty"`
	Patch    string `json:"patch,omitempty"`
}

type workerSpec struct {
	Title string
	Scope []string
}

func NewManager(cwd, storageDir string) (*Manager, error) {
	if strings.TrimSpace(cwd) == "" {
		return nil, fmt.Errorf("batch cwd is required")
	}
	if strings.TrimSpace(storageDir) == "" {
		return nil, fmt.Errorf("batch storage dir is required")
	}
	if err := os.MkdirAll(storageDir, 0755); err != nil {
		return nil, err
	}
	m := &Manager{
		cwd:        cwd,
		storageDir: storageDir,
		statePath:  filepath.Join(storageDir, "batch_runs.json"),
		runs:       map[string]protocol.BatchRun{},
	}
	if err := m.Load(); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return m, nil
}

func (m *Manager) Load() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	raw, err := os.ReadFile(m.statePath)
	if err != nil {
		return err
	}
	var runs map[string]protocol.BatchRun
	if err := json.Unmarshal(raw, &runs); err != nil {
		backup := fmt.Sprintf("%s.corrupt.%d", m.statePath, time.Now().UnixMilli())
		_ = os.Rename(m.statePath, backup)
		m.runs = map[string]protocol.BatchRun{}
		return m.saveLocked()
	}
	if runs == nil {
		runs = map[string]protocol.BatchRun{}
	}
	m.runs = runs
	m.reconcileInterruptedLocked()
	return nil
}

func (m *Manager) ListRuns() []protocol.BatchRun {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]protocol.BatchRun, 0, len(m.runs))
	for _, run := range m.runs {
		out = append(out, run)
	}
	return out
}

func (m *Manager) GetRun(id string) (protocol.BatchRun, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	run, ok := m.runs[id]
	return run, ok
}

func (m *Manager) CreateRun(req CreateRunRequest) (protocol.BatchRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	goal := strings.TrimSpace(req.Goal)
	if goal == "" {
		return protocol.BatchRun{}, fmt.Errorf("batch goal is required")
	}
	maxWorkers := normalizeMaxWorkers(req.MaxWorkers)
	workerSpecs := parseWorkerSpecs(req.Workers)
	if len(workerSpecs) == 0 {
		workerSpecs = []workerSpec{{Title: "Review, implement, verify, and summarize the assigned change", Scope: []string{"."}}}
	}
	if len(workerSpecs) > maxWorkers {
		workerSpecs = workerSpecs[:maxWorkers]
	}

	now := time.Now().UnixMilli()
	runID := "batch-" + uuid.NewString()[:8]
	baseBranch, _ := m.gitOutput(m.cwd, "branch", "--show-current")
	baseCommit, _ := m.gitOutput(m.cwd, "rev-parse", "--verify", "HEAD")
	run := protocol.BatchRun{
		ID:                 runID,
		SessionID:          req.SessionID,
		Goal:               goal,
		Status:             "draft",
		MaxWorkers:         maxWorkers,
		BaseBranch:         strings.TrimSpace(baseBranch),
		BaseCommit:         strings.TrimSpace(baseCommit),
		BaseCheckpointHash: strings.TrimSpace(req.BaseCheckpointHash),
		Workers:            make([]protocol.BatchWorker, 0, len(workerSpecs)),
		MergePlan: protocol.BatchMergePlan{
			Status:   "pending",
			Warnings: []string{"Workers produce reviewable artifacts only; apply requires an explicit user action."},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	for i, spec := range workerSpecs {
		workerID := fmt.Sprintf("%s-w%d", runID, i+1)
		run.Workers = append(run.Workers, protocol.BatchWorker{
			ID:                   workerID,
			RunID:                runID,
			Title:                spec.Title,
			Status:               "queued",
			ScopePaths:           spec.Scope,
			VerificationCommands: normalizeLines(req.VerificationCommands),
			Permissions:          []string{"read", "search", "path_scoped_edit", "test"},
		})
	}
	m.runs[runID] = run
	return run, m.saveLocked()
}

func (m *Manager) StartRun(runID string) (protocol.BatchRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	run, ok := m.runs[runID]
	if !ok {
		return protocol.BatchRun{}, fmt.Errorf("batch run not found: %s", runID)
	}
	if !m.isGitRepo() {
		return protocol.BatchRun{}, fmt.Errorf("batch worktree agents require a git repository with a valid HEAD")
	}
	if run.Status == "aborted" || run.Status == "completed" {
		return run, fmt.Errorf("batch run is terminal: %s", run.Status)
	}

	run.Status = "queued"
	run.UpdatedAt = time.Now().UnixMilli()
	for i := range run.Workers {
		worker := &run.Workers[i]
		if worker.Status == "completed" || worker.Status == "applied" || worker.Status == "cleaned" {
			continue
		}
		if worker.Path == "" {
			if err := m.prepareWorkerWorktree(&run, worker); err != nil {
				worker.Status = "failed"
				worker.Error = err.Error()
				worker.CompletedAt = time.Now().UnixMilli()
				continue
			}
		}
		worker.Status = "queued"
		worker.CompletedAt = 0
		worker.Error = ""
		worker.OutputPreview = ""
		if worker.ArtifactDir == "" {
			worker.ArtifactDir = filepath.Join(m.storageDir, "artifacts", run.ID, worker.ID)
		}
		if err := m.writeWorkerContract(run, *worker); err != nil {
			worker.Status = "failed"
			worker.Error = err.Error()
			worker.CompletedAt = time.Now().UnixMilli()
		}
	}
	m.runs[run.ID] = run
	return run, m.saveLocked()
}

func (m *Manager) AbortRun(runID string) (protocol.BatchRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[runID]
	if !ok {
		return protocol.BatchRun{}, fmt.Errorf("batch run not found: %s", runID)
	}
	now := time.Now().UnixMilli()
	run.Status = "aborted"
	run.UpdatedAt = now
	for i := range run.Workers {
		if run.Workers[i].Status == "queued" || run.Workers[i].Status == "ready" || run.Workers[i].Status == "running" {
			run.Workers[i].Status = "aborted"
			run.Workers[i].CompletedAt = now
		}
	}
	m.runs[run.ID] = run
	return run, m.saveLocked()
}

func (m *Manager) MarkRunRunning(runID string) (protocol.BatchRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[runID]
	if !ok {
		return protocol.BatchRun{}, fmt.Errorf("batch run not found: %s", runID)
	}
	run.Status = "running"
	run.UpdatedAt = time.Now().UnixMilli()
	m.runs[run.ID] = run
	return run, m.saveLocked()
}

func (m *Manager) MarkWorkerRunning(workerID string, agentSessionID string) (protocol.BatchRun, protocol.BatchWorker, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, runIndex, workerIndex, ok := m.findWorkerPositionLocked(workerID)
	if !ok {
		return protocol.BatchRun{}, protocol.BatchWorker{}, fmt.Errorf("batch worker not found: %s", workerID)
	}
	worker := run.Workers[workerIndex]
	now := time.Now().UnixMilli()
	if worker.Attempt <= 0 {
		worker.Attempt = 1
	}
	worker.AgentSessionID = agentSessionID
	worker.Status = "running"
	worker.StartedAt = now
	worker.CompletedAt = 0
	worker.Error = ""
	worker.OutputPreview = ""
	run.Status = "running"
	run.UpdatedAt = now
	run.Workers[workerIndex] = worker
	m.runs[runIndex] = run
	return run, worker, m.saveLocked()
}

func (m *Manager) CompleteWorker(workerID, status, summary, outputPreview, errText, verificationStatus string, tests []protocol.BatchTestResult) (protocol.BatchRun, protocol.BatchWorker, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, runIndex, workerIndex, ok := m.findWorkerPositionLocked(workerID)
	if !ok {
		return protocol.BatchRun{}, protocol.BatchWorker{}, fmt.Errorf("batch worker not found: %s", workerID)
	}
	worker := run.Workers[workerIndex]
	worker.Status = status
	worker.Summary = summary
	worker.OutputPreview = outputPreview
	worker.Error = errText
	worker.VerificationStatus = verificationStatus
	worker.Tests = tests
	worker.CompletedAt = time.Now().UnixMilli()
	run.Workers[workerIndex] = worker
	run.UpdatedAt = worker.CompletedAt
	m.runs[runIndex] = run
	return run, worker, m.saveLocked()
}

func (m *Manager) FinalizeRun(runID string) (protocol.BatchRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[runID]
	if !ok {
		return protocol.BatchRun{}, fmt.Errorf("batch run not found: %s", runID)
	}
	status := "completed"
	for _, worker := range run.Workers {
		switch worker.Status {
		case "queued", "running":
			status = "running"
		case "failed", "timeout", "interrupted":
			if status != "running" {
				status = "failed"
			}
		case "aborted":
			if status != "running" {
				status = "aborted"
			}
		}
	}
	run.Status = status
	run.UpdatedAt = time.Now().UnixMilli()
	m.runs[run.ID] = run
	return run, m.saveLocked()
}

func (m *Manager) QueueWorkerRetry(workerID string) (protocol.BatchRun, protocol.BatchWorker, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, runIndex, workerIndex, ok := m.findWorkerPositionLocked(workerID)
	if !ok {
		return protocol.BatchRun{}, protocol.BatchWorker{}, fmt.Errorf("batch worker not found: %s", workerID)
	}
	worker := run.Workers[workerIndex]
	if worker.Status == "running" {
		return protocol.BatchRun{}, protocol.BatchWorker{}, fmt.Errorf("worker is already running: %s", workerID)
	}
	worker.Status = "queued"
	worker.Attempt++
	if worker.Attempt <= 0 {
		worker.Attempt = 1
	}
	worker.Error = ""
	worker.OutputPreview = ""
	worker.CompletedAt = 0
	run.Status = "queued"
	run.UpdatedAt = time.Now().UnixMilli()
	run.Workers[workerIndex] = worker
	m.runs[runIndex] = run
	return run, worker, m.saveLocked()
}

func (m *Manager) WriteWorkerArtifacts(workerID, summary, patch, diffStat, testLog string, result map[string]interface{}) ([]protocol.BatchArtifact, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, runIndex, workerIndex, ok := m.findWorkerPositionLocked(workerID)
	if !ok {
		return nil, fmt.Errorf("batch worker not found: %s", workerID)
	}
	worker := run.Workers[workerIndex]
	if worker.ArtifactDir == "" {
		worker.ArtifactDir = filepath.Join(m.storageDir, "artifacts", run.ID, worker.ID)
	}
	if err := os.MkdirAll(worker.ArtifactDir, 0755); err != nil {
		return nil, err
	}
	artifacts := []protocol.BatchArtifact{}
	write := func(kind, name, content string) error {
		path := filepath.Join(worker.ArtifactDir, name)
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return err
		}
		info, _ := os.Stat(path)
		artifact := protocol.BatchArtifact{Type: kind, Path: path}
		if info != nil {
			artifact.Size = info.Size()
		}
		artifacts = append(artifacts, artifact)
		return nil
	}
	if err := write("summary", "summary.md", summary); err != nil {
		return nil, err
	}
	if err := write("patch", "diff.patch", patch); err != nil {
		return nil, err
	}
	if err := write("diff_stat", "diff.stat", diffStat); err != nil {
		return nil, err
	}
	if err := write("test_log", "test.log", testLog); err != nil {
		return nil, err
	}
	raw, _ := json.MarshalIndent(result, "", "  ")
	if err := write("worker_result", "worker_result.json", string(raw)); err != nil {
		return nil, err
	}
	worker.Artifacts = artifacts
	worker.Summary = summary
	worker.DiffStat = diffStat
	run.Workers[workerIndex] = worker
	run.UpdatedAt = time.Now().UnixMilli()
	m.runs[runIndex] = run
	if err := m.saveLocked(); err != nil {
		return artifacts, err
	}
	return artifacts, nil
}

func (m *Manager) WorkerArtifacts(workerID string) ([]protocol.BatchArtifact, error) {
	m.mu.RLock()
	worker, ok := m.findWorkerLocked(workerID)
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("batch worker not found: %s", workerID)
	}
	return worker.Artifacts, nil
}

func (m *Manager) WorkerDiff(workerID string) (WorkerDiff, error) {
	m.mu.RLock()
	worker, ok := m.findWorkerLocked(workerID)
	m.mu.RUnlock()
	if !ok {
		return WorkerDiff{}, fmt.Errorf("batch worker not found: %s", workerID)
	}
	if worker.Path == "" {
		return WorkerDiff{}, fmt.Errorf("batch worker has no worktree path")
	}
	if worker.DiffStat != "" || len(worker.Artifacts) > 0 {
		patch := readArtifact(worker.Artifacts, "patch")
		if patch != "" || worker.DiffStat != "" {
			return WorkerDiff{WorkerID: workerID, DiffStat: worker.DiffStat, Patch: patch}, nil
		}
	}
	stat, _ := m.gitOutput(worker.Path, "diff", "--stat")
	patch, err := m.gitOutputRaw(worker.Path, "diff", "--binary")
	if err != nil {
		return WorkerDiff{}, err
	}
	return WorkerDiff{WorkerID: workerID, DiffStat: stat, Patch: patch}, nil
}

func (m *Manager) ApplyWorker(workerID string) (protocol.BatchWorker, error) {
	diff, err := m.WorkerDiff(workerID)
	if err != nil {
		return protocol.BatchWorker{}, err
	}
	if strings.TrimSpace(diff.Patch) == "" {
		return protocol.BatchWorker{}, fmt.Errorf("worker has no patch to apply")
	}
	if err := m.gitApply(diff.Patch, true); err != nil {
		return protocol.BatchWorker{}, fmt.Errorf("patch check failed: %w", err)
	}
	if err := m.gitApply(diff.Patch, false); err != nil {
		return protocol.BatchWorker{}, fmt.Errorf("patch apply failed: %w", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	run, runIndex, workerIndex, ok := m.findWorkerPositionLocked(workerID)
	if !ok {
		return protocol.BatchWorker{}, fmt.Errorf("batch worker not found: %s", workerID)
	}
	worker := run.Workers[workerIndex]
	worker.Status = "applied"
	worker.CompletedAt = time.Now().UnixMilli()
	run.Workers[workerIndex] = worker
	run.MergePlan.Status = "applied"
	run.MergePlan.Selected = append(run.MergePlan.Selected, workerID)
	run.UpdatedAt = time.Now().UnixMilli()
	m.runs[runIndex] = run
	if err := m.saveLocked(); err != nil {
		return worker, err
	}
	return worker, nil
}

func (m *Manager) CleanupRun(runID string) (protocol.BatchRun, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.runs[runID]
	if !ok {
		return protocol.BatchRun{}, fmt.Errorf("batch run not found: %s", runID)
	}
	for i := range run.Workers {
		worker := &run.Workers[i]
		if worker.Path != "" {
			_ = m.git(m.cwd, "worktree", "remove", "--force", worker.Path)
			_ = os.RemoveAll(worker.Path)
		}
		worker.Status = "cleaned"
	}
	run.Status = "cleaned"
	run.UpdatedAt = time.Now().UnixMilli()
	m.runs[run.ID] = run
	return run, m.saveLocked()
}

func (m *Manager) prepareWorkerWorktree(run *protocol.BatchRun, worker *protocol.BatchWorker) error {
	worktreeID := "wt_" + worker.ID
	branch := fmt.Sprintf("ricochet/%s/%s", run.ID, slug(worker.Title))
	if len(branch) > 80 {
		branch = branch[:80]
	}
	target := filepath.Join(m.storageDir, "worktrees", run.ID, worker.ID)
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	if _, err := os.Stat(target); os.IsNotExist(err) {
		if err := m.git(m.cwd, "worktree", "add", "-b", branch, target, "HEAD"); err != nil {
			return err
		}
	}
	worker.WorktreeID = worktreeID
	worker.Branch = branch
	worker.Path = target
	return nil
}

func (m *Manager) writeWorkerContract(run protocol.BatchRun, worker protocol.BatchWorker) error {
	artifactDir := filepath.Join(m.storageDir, "artifacts", run.ID, worker.ID)
	if err := os.MkdirAll(artifactDir, 0755); err != nil {
		return err
	}
	contractPath := filepath.Join(artifactDir, "worker_contract.md")
	body := fmt.Sprintf(`# Ricochet Batch Worker Contract

Goal: %s

Worker: %s

Assigned scope: %s

Verification commands:
%s

Required loop:
1. Inspect only the assigned scope first.
2. Plan the smallest safe patch.
3. Edit only files needed for this worker.
4. Run the specified verification or explain why it is unavailable.
5. Write summary, diff.patch, test.log, and worker_result.json.

Stop conditions:
- Do not merge, push, or modify the primary workspace.
- Do not broaden the task beyond this worker title.
- If verification fails once after a self-fix attempt, stop and report failure.
`, run.Goal, worker.Title, strings.Join(worker.ScopePaths, ", "), formatVerificationCommands(worker.VerificationCommands))
	if err := os.WriteFile(contractPath, []byte(body), 0644); err != nil {
		return err
	}
	workerResultPath := filepath.Join(artifactDir, "worker_result.json")
	result := map[string]interface{}{
		"worker_id": worker.ID,
		"run_id":    run.ID,
		"status":    "ready",
		"worktree":  worker.Path,
		"branch":    worker.Branch,
		"scope":     worker.ScopePaths,
	}
	raw, _ := json.MarshalIndent(result, "", "  ")
	if err := os.WriteFile(workerResultPath, raw, 0644); err != nil {
		return err
	}
	return nil
}

func (m *Manager) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(m.statePath), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(m.runs, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(m.statePath, raw, 0644)
}

func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func (m *Manager) findWorkerLocked(workerID string) (protocol.BatchWorker, bool) {
	for _, run := range m.runs {
		for _, worker := range run.Workers {
			if worker.ID == workerID {
				return worker, true
			}
		}
	}
	return protocol.BatchWorker{}, false
}

func (m *Manager) findWorkerPositionLocked(workerID string) (protocol.BatchRun, string, int, bool) {
	for runID, run := range m.runs {
		for i, worker := range run.Workers {
			if worker.ID == workerID {
				return run, runID, i, true
			}
		}
	}
	return protocol.BatchRun{}, "", -1, false
}

func (m *Manager) isGitRepo() bool {
	if err := m.git(m.cwd, "rev-parse", "--verify", "HEAD"); err != nil {
		return false
	}
	return m.git(m.cwd, "rev-parse", "--is-inside-work-tree") == nil
}

func (m *Manager) git(cwd string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
	return nil
}

func (m *Manager) gitOutput(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
	return strings.TrimSpace(string(output)), nil
}

func (m *Manager) gitOutputRaw(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
	return string(output), nil
}

func (m *Manager) gitApply(patch string, checkOnly bool) error {
	args := []string{"apply"}
	if checkOnly {
		args = append(args, "--check")
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = m.cwd
	cmd.Stdin = strings.NewReader(patch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
	return nil
}

func normalizeMaxWorkers(value int) int {
	if value <= 0 {
		return defaultMaxWorkers
	}
	if value > hardMaxWorkers {
		return hardMaxWorkers
	}
	return value
}

func parseWorkerSpecs(lines []string) []workerSpec {
	specs := []workerSpec{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		title := line
		scope := []string{"."}
		if left, right, ok := strings.Cut(line, "|"); ok {
			title = strings.TrimSpace(left)
			scope = splitCSVPaths(right)
		}
		if title == "" {
			title = "Batch worker"
		}
		if len(scope) == 0 {
			scope = []string{"."}
		}
		specs = append(specs, workerSpec{Title: title, Scope: scope})
	}
	return specs
}

func splitCSVPaths(raw string) []string {
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		part = filepath.Clean(strings.TrimSpace(part))
		if part == "" || part == "." {
			out = append(out, ".")
			continue
		}
		out = append(out, part)
	}
	return normalizeLines(out)
}

func normalizeLines(lines []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || seen[line] {
			continue
		}
		seen[line] = true
		out = append(out, line)
	}
	return out
}

func formatVerificationCommands(commands []string) string {
	if len(commands) == 0 {
		return "- none specified"
	}
	var b strings.Builder
	for _, command := range commands {
		b.WriteString("- ")
		b.WriteString(command)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func readArtifact(artifacts []protocol.BatchArtifact, kind string) string {
	for _, artifact := range artifacts {
		if artifact.Type != kind || artifact.Path == "" {
			continue
		}
		raw, err := os.ReadFile(artifact.Path)
		if err == nil {
			return string(raw)
		}
	}
	return ""
}

func (m *Manager) reconcileInterruptedLocked() {
	changed := false
	now := time.Now().UnixMilli()
	for runID, run := range m.runs {
		runChanged := false
		for i := range run.Workers {
			if run.Workers[i].Status == "running" {
				run.Workers[i].Status = "interrupted"
				run.Workers[i].CompletedAt = now
				run.Workers[i].Error = "Worker was running when Ricochet stopped."
				runChanged = true
			}
		}
		if run.Status == "running" {
			run.Status = "interrupted"
			run.UpdatedAt = now
			runChanged = true
		}
		if runChanged {
			m.runs[runID] = run
			changed = true
		}
	}
	if changed {
		_ = m.saveLocked()
	}
}

func slug(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var out strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			out.WriteRune(r)
		case r >= '0' && r <= '9':
			out.WriteRune(r)
		default:
			if out.Len() > 0 && !strings.HasSuffix(out.String(), "-") {
				out.WriteRune('-')
			}
		}
	}
	result := strings.Trim(out.String(), "-")
	if result == "" {
		return uuid.NewString()[:8]
	}
	return result
}
