package checkpoints

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/igoryan-dao/ricochet/internal/protocol"
)

// CheckpointService provides workspace snapshot functionality using shadow git
type CheckpointService struct {
	taskID        string
	workspaceDir  string
	checkpointDir string
	dotGitDir     string
	initialized   bool
	baseHash      string
	checkpoints   []string
	nestedGitPath string
	OnEvent       func(protocol.CheckpointEvent)
	lastEvent     protocol.CheckpointEvent
	hasLastEvent  bool
	mu            sync.Mutex
}

const largeFileThresholdBytes = 1024 * 1024

// NewCheckpointService creates a new checkpoint service
func NewCheckpointService(taskID, workspaceDir, storageDir string) *CheckpointService {
	checkpointDir := filepath.Join(storageDir, "tasks", taskID, "checkpoints")
	return &CheckpointService{
		taskID:        taskID,
		workspaceDir:  workspaceDir,
		checkpointDir: checkpointDir,
		dotGitDir:     filepath.Join(checkpointDir, ".git"),
		checkpoints:   []string{},
	}
}

// Init initializes the shadow git repository
func (s *CheckpointService) Init() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	startedAt := time.Now()

	if s.initialized {
		return nil
	}
	if nested, err := s.findNestedGitRepository(); err != nil {
		s.emit("checkpoint_failed", "", "", startedAt, err)
		return err
	} else if nested != "" {
		s.nestedGitPath = nested
	}

	// Create checkpoint directory
	if err := os.MkdirAll(s.checkpointDir, 0755); err != nil {
		return fmt.Errorf("create checkpoint dir: %w", err)
	}

	// Check if .git already exists
	if _, err := os.Stat(s.dotGitDir); os.IsNotExist(err) {
		// Initialize new git repo
		if err := s.runGit("init"); err != nil {
			return fmt.Errorf("git init: %w", err)
		}

		// Configure git
		if err := s.runGit("config", "core.worktree", s.workspaceDir); err != nil {
			return fmt.Errorf("git config worktree: %w", err)
		}
		if err := s.runGit("config", "commit.gpgSign", "false"); err != nil {
			return fmt.Errorf("git config gpg: %w", err)
		}
		if err := s.runGit("config", "user.name", "Ricochet"); err != nil {
			return fmt.Errorf("git config user.name: %w", err)
		}
		if err := s.runGit("config", "user.email", "ricochet@example.com"); err != nil {
			return fmt.Errorf("git config user.email: %w", err)
		}

		// Stage all and initial commit
		if err := s.runGit("add", ".", "--ignore-errors"); err != nil {
			// Ignore staging errors - some files may be unreadable
		}

		if err := s.runGit("commit", "-m", "initial commit", "--allow-empty"); err != nil {
			return fmt.Errorf("initial commit: %w", err)
		}
	}
	// Refresh excludes on every init so existing shadow repos pick up new
	// Ricochet runtime-file rules without requiring users to recreate them.
	if err := s.writeExcludeFile(); err != nil {
		return fmt.Errorf("write exclude: %w", err)
	}

	// Get base hash
	out, err := s.runGitOutput("rev-parse", "HEAD")
	if err != nil {
		return fmt.Errorf("get HEAD: %w", err)
	}
	s.baseHash = strings.TrimSpace(out)
	s.initialized = true
	s.emit("checkpoint_initialized", s.baseHash, "shadow git initialized", startedAt, nil)

	return nil
}

// Save creates a checkpoint of current workspace state
func (s *CheckpointService) Save(message string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	startedAt := time.Now()

	if !s.initialized {
		err := fmt.Errorf("checkpoint service not initialized")
		s.emit("checkpoint_failed", "", message, startedAt, err)
		return "", err
	}

	return s.saveLocked(message, startedAt)
}

func (s *CheckpointService) saveLocked(message string, startedAt time.Time) (string, error) {
	// Stage all changes
	_ = s.runGit("add", ".", "--ignore-errors")

	// Commit
	if message == "" {
		message = fmt.Sprintf("Checkpoint at %s", time.Now().Format(time.RFC3339))
	}

	if err := s.runGit("commit", "-m", message, "--allow-empty"); err != nil {
		// Check if there were no changes
		if strings.Contains(err.Error(), "nothing to commit") {
			return "", nil // No changes
		}
		err = fmt.Errorf("commit: %w", err)
		s.emit("checkpoint_failed", "", message, startedAt, err)
		return "", err
	}

	// Get new commit hash
	out, err := s.runGitOutput("rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get HEAD after commit: %w", err)
	}

	hash := strings.TrimSpace(out)
	s.checkpoints = append(s.checkpoints, hash)
	s.emit("checkpoint_saved", hash, message, startedAt, nil)

	return hash, nil
}

// Restore restores workspace to a previous checkpoint
func (s *CheckpointService) Restore(commitHash string) error {
	_, err := s.RestoreWithOptions(protocol.CheckpointRestoreRequest{
		CheckpointHash:         commitHash,
		Mode:                   "full",
		CreateSafetyCheckpoint: true,
	})
	return err
}

func (s *CheckpointService) PreviewRestore(commitHash string) (protocol.CheckpointRestorePreview, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.initialized {
		return protocol.CheckpointRestorePreview{}, fmt.Errorf("checkpoint service not initialized")
	}

	return s.previewRestoreLocked(commitHash)
}

func (s *CheckpointService) previewRestoreLocked(commitHash string) (protocol.CheckpointRestorePreview, error) {
	if strings.TrimSpace(commitHash) == "" {
		return protocol.CheckpointRestorePreview{}, fmt.Errorf("checkpoint hash is required")
	}
	_ = s.runGit("add", ".", "--ignore-errors")

	currentHash, _ := s.runGitOutput("write-tree")
	currentHash = strings.TrimSpace(currentHash)
	stat, _ := s.runGitOutput("diff", "--cached", "--stat", commitHash)
	nameStatus, err := s.runGitOutput("diff", "--cached", "--name-status", "--find-renames", commitHash)
	if err != nil {
		return protocol.CheckpointRestorePreview{}, fmt.Errorf("git diff name-status: %w", err)
	}
	numstat, _ := s.runGitOutput("diff", "--cached", "--numstat", commitHash)
	counts := parseNumstat(numstat)
	files := make([]protocol.CheckpointFileChange, 0)
	for _, change := range parseNameStatus(nameStatus) {
		if stat, ok := counts[change.Path]; ok {
			change.Additions = stat.additions
			change.Deletions = stat.deletions
			change.Binary = stat.binary
		}
		abs := filepath.Join(s.workspaceDir, change.Path)
		if info, statErr := os.Stat(abs); statErr == nil {
			change.Large = info.Size() > largeFileThresholdBytes
			if !change.Binary {
				change.Binary = isLikelyBinaryFile(abs)
			}
		}
		change.Preview = s.filePreview(change.Path, change.Binary)
		files = append(files, change)
	}

	warnings := []string{}
	if s.nestedGitPath != "" {
		warnings = append(warnings, fmt.Sprintf("Nested git repository detected at %s; checkpoint excludes should be reviewed before restore.", s.nestedGitPath))
	}
	if len(files) > 25 {
		warnings = append(warnings, fmt.Sprintf("%d files would change; prefer selected restore or patch review for broad changes.", len(files)))
	}

	summary := "No file changes detected."
	if len(files) > 0 {
		summary = fmt.Sprintf("%d file(s) differ from checkpoint %s.", len(files), shortHash(commitHash))
	}

	return protocol.CheckpointRestorePreview{
		CheckpointHash: commitHash,
		CurrentHash:    currentHash,
		SafetyRequired: len(files) > 0,
		Summary:        summary,
		Files:          files,
		Warnings:       warnings,
		RestoreModes:   []string{"full", "selected_files", "patch_only", "export_snapshot"},
		DiffStat:       strings.TrimSpace(stat),
		GeneratedAt:    time.Now().UnixMilli(),
	}, nil
}

func (s *CheckpointService) RestoreWithOptions(req protocol.CheckpointRestoreRequest) (protocol.CheckpointRestoreResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	startedAt := time.Now()

	if !s.initialized {
		err := fmt.Errorf("checkpoint service not initialized")
		s.emit("checkpoint_failed", req.CheckpointHash, "restore", startedAt, err)
		return protocol.CheckpointRestoreResult{}, err
	}
	if req.Mode == "" {
		req.Mode = "full"
	}

	preview, err := s.previewRestoreLocked(req.CheckpointHash)
	if err != nil {
		s.emit("checkpoint_failed", req.CheckpointHash, "restore preview", startedAt, err)
		return protocol.CheckpointRestoreResult{}, err
	}

	result := protocol.CheckpointRestoreResult{
		Mode:         req.Mode,
		RestoredHash: req.CheckpointHash,
	}

	switch req.Mode {
	case "patch_only":
		patchPath, patchErr := s.createPatchLocked(req.CheckpointHash)
		if patchErr != nil {
			s.emit("checkpoint_failed", req.CheckpointHash, "patch", startedAt, patchErr)
			return result, patchErr
		}
		result.PatchPath = patchPath
	case "export_snapshot":
		exportPath, exportErr := s.exportSnapshotLocked(req.CheckpointHash)
		if exportErr != nil {
			s.emit("checkpoint_failed", req.CheckpointHash, "export", startedAt, exportErr)
			return result, exportErr
		}
		result.ExportPath = exportPath
	case "selected_files", "full":
		if req.CreateSafetyCheckpoint {
			safetyHash, saveErr := s.saveLocked(fmt.Sprintf("Safety checkpoint before restore to %s", shortHash(req.CheckpointHash)), startedAt)
			if saveErr != nil {
				s.emit("checkpoint_failed", req.CheckpointHash, "safety checkpoint", startedAt, saveErr)
				return result, fmt.Errorf("safety checkpoint: %w", saveErr)
			}
			result.SafetyCheckpointHash = safetyHash
		}
		if req.Mode == "selected_files" {
			restored, skipped, restoreErr := s.restoreSelectedLocked(req.CheckpointHash, req.Paths, preview.Files)
			result.FilesRestored = restored
			result.SkippedFiles = skipped
			if restoreErr != nil {
				s.emit("checkpoint_failed", req.CheckpointHash, "selected restore", startedAt, restoreErr)
				return result, restoreErr
			}
		} else {
			if err := s.runGit("clean", "-fd"); err != nil {
				err = fmt.Errorf("git clean: %w", err)
				s.emit("checkpoint_failed", req.CheckpointHash, "restore", startedAt, err)
				return result, err
			}
			if err := s.runGit("reset", "--hard", req.CheckpointHash); err != nil {
				err = fmt.Errorf("git reset: %w", err)
				s.emit("checkpoint_failed", req.CheckpointHash, "restore", startedAt, err)
				return result, err
			}
			for _, file := range preview.Files {
				result.FilesRestored = append(result.FilesRestored, file.Path)
			}
		}
	default:
		err := fmt.Errorf("unsupported checkpoint restore mode: %s", req.Mode)
		s.emit("checkpoint_failed", req.CheckpointHash, "restore", startedAt, err)
		return result, err
	}

	result.DurationMs = time.Since(startedAt).Milliseconds()
	s.emit("checkpoint_restored", req.CheckpointHash, req.Mode, startedAt, nil)
	return result, nil
}

func (s *CheckpointService) CreatePatch(commitHash string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized {
		return "", fmt.Errorf("checkpoint service not initialized")
	}
	return s.createPatchLocked(commitHash)
}

// GetDiff returns the diff between two commits or current state
func (s *CheckpointService) GetDiff(fromHash, toHash string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.initialized {
		return "", fmt.Errorf("checkpoint service not initialized")
	}

	args := []string{"diff", "--stat"}
	if toHash != "" {
		args = append(args, fmt.Sprintf("%s..%s", fromHash, toHash))
	} else {
		args = append(args, fromHash)
	}

	out, err := s.runGitOutput(args...)
	if err != nil {
		return "", fmt.Errorf("git diff: %w", err)
	}

	return out, nil
}

// List returns all checkpoint hashes
func (s *CheckpointService) List() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]string, len(s.checkpoints))
	copy(result, s.checkpoints)
	return result
}

// BaseHash returns the initial commit hash
func (s *CheckpointService) BaseHash() string {
	return s.baseHash
}

// IsInitialized returns whether the service is ready
func (s *CheckpointService) IsInitialized() bool {
	return s.initialized
}

func (s *CheckpointService) Status(enabled bool, checkpointOnWrites bool) protocol.CheckpointStatus {
	s.mu.Lock()
	defer s.mu.Unlock()

	status := protocol.CheckpointStatus{
		Enabled:            enabled,
		CheckpointOnWrites: checkpointOnWrites,
		Initialized:        s.initialized,
		BaseHash:           s.baseHash,
		CheckpointCount:    len(s.checkpoints),
	}
	if s.nestedGitPath != "" {
		status.Warning = "Nested git repository detected; restore may need manual review."
	}
	if s.hasLastEvent {
		status.LastCheckpointAt = s.lastEvent.Timestamp
		if s.lastEvent.Hash != "" {
			status.LastCheckpointHash = s.lastEvent.Hash
		}
		if s.lastEvent.Error != "" {
			status.Error = s.lastEvent.Error
		}
		if s.lastEvent.DurationMs > 5000 {
			status.Slow = true
			if status.Warning == "" {
				status.Warning = "Checkpoint operation is slow in this workspace."
			}
		}
	}
	return status
}

// writeExcludeFile writes .git/info/exclude with common patterns
func (s *CheckpointService) writeExcludeFile() error {
	excludes := []string{
		".ricochet/",
		"task_progress_current.md",
		"node_modules/",
		".git/",
		"__pycache__/",
		"*.pyc",
		".venv/",
		"venv/",
		".env",
		"*.log",
		".DS_Store",
		"dist/",
		"build/",
		"target/",
		".idea/",
		".vscode/",
		"*.swp",
		"*.swo",
	}
	if raw, err := os.ReadFile(filepath.Join(s.workspaceDir, ".gitignore")); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			excludes = append(excludes, line)
		}
	}

	infoDir := filepath.Join(s.dotGitDir, "info")
	if err := os.MkdirAll(infoDir, 0755); err != nil {
		return err
	}

	excludeFile := filepath.Join(infoDir, "exclude")
	return os.WriteFile(excludeFile, []byte(strings.Join(excludes, "\n")), 0644)
}

func (s *CheckpointService) SetEventHandler(handler func(protocol.CheckpointEvent)) {
	s.OnEvent = handler
}

func (s *CheckpointService) emit(event, hash, message string, startedAt time.Time, err error) {
	now := time.Now()
	payload := protocol.CheckpointEvent{
		Event:      event,
		Hash:       hash,
		BaseHash:   s.baseHash,
		Message:    message,
		DurationMs: now.Sub(startedAt).Milliseconds(),
		Timestamp:  now.UnixMilli(),
	}
	if err != nil {
		payload.Error = err.Error()
	}
	s.lastEvent = payload
	s.hasLastEvent = true
	if s.OnEvent == nil {
		return
	}
	s.OnEvent(payload)
}

func (s *CheckpointService) findNestedGitRepository() (string, error) {
	var found string
	err := filepath.WalkDir(s.workspaceDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if name == "node_modules" || name == ".venv" || name == "vendor" {
			return filepath.SkipDir
		}
		if name == ".git" {
			parent := filepath.Dir(path)
			if parent != s.workspaceDir {
				found = path
				return filepath.SkipAll
			}
			return filepath.SkipDir
		}
		return nil
	})
	return found, err
}

// runGit executes a git command in the checkpoint directory
func (s *CheckpointService) runGit(args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = s.checkpointDir

	// Sanitize environment - remove git vars that could interfere
	cmd.Env = s.sanitizedEnv()

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, string(output))
	}
	return nil
}

// runGitOutput executes git and returns stdout
func (s *CheckpointService) runGitOutput(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = s.checkpointDir
	cmd.Env = s.sanitizedEnv()

	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("%v: %s", err, string(exitErr.Stderr))
		}
		return "", err
	}
	return string(output), nil
}

// sanitizedEnv returns env without git-specific variables
func (s *CheckpointService) sanitizedEnv() []string {
	skipVars := map[string]bool{
		"GIT_DIR":                          true,
		"GIT_WORK_TREE":                    true,
		"GIT_INDEX_FILE":                   true,
		"GIT_OBJECT_DIRECTORY":             true,
		"GIT_ALTERNATE_OBJECT_DIRECTORIES": true,
		"GIT_CEILING_DIRECTORIES":          true,
	}

	var env []string
	for _, e := range os.Environ() {
		key := strings.Split(e, "=")[0]
		if !skipVars[key] {
			env = append(env, e)
		}
	}
	return env
}

type numstatEntry struct {
	additions int
	deletions int
	binary    bool
}

func parseNumstat(raw string) map[string]numstatEntry {
	out := map[string]numstatEntry{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		pathValue := parts[len(parts)-1]
		entry := numstatEntry{binary: parts[0] == "-" || parts[1] == "-"}
		if !entry.binary {
			fmt.Sscanf(parts[0], "%d", &entry.additions)
			fmt.Sscanf(parts[1], "%d", &entry.deletions)
		}
		out[pathValue] = entry
	}
	return out
}

func parseNameStatus(raw string) []protocol.CheckpointFileChange {
	changes := []protocol.CheckpointFileChange{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		code := parts[0]
		status := "changed"
		pathValue := parts[1]
		oldPath := ""
		switch {
		case strings.HasPrefix(code, "A"):
			status = "added"
		case strings.HasPrefix(code, "M"):
			status = "modified"
		case strings.HasPrefix(code, "D"):
			status = "deleted"
		case strings.HasPrefix(code, "R"):
			status = "renamed"
			if len(parts) >= 3 {
				oldPath = parts[1]
				pathValue = parts[2]
			}
		case strings.HasPrefix(code, "C"):
			status = "copied"
			if len(parts) >= 3 {
				oldPath = parts[1]
				pathValue = parts[2]
			}
		}
		changes = append(changes, protocol.CheckpointFileChange{
			Path:    pathValue,
			OldPath: oldPath,
			Status:  status,
		})
	}
	return changes
}

func (s *CheckpointService) filePreview(relPath string, binary bool) string {
	if binary {
		return ""
	}
	abs := filepath.Join(s.workspaceDir, relPath)
	raw, err := os.ReadFile(abs)
	if err != nil {
		return ""
	}
	text := string(raw)
	if len(text) > 800 {
		text = text[:800] + "\n..."
	}
	return text
}

func isLikelyBinaryFile(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if len(raw) > 8192 {
		raw = raw[:8192]
	}
	for _, b := range raw {
		if b == 0 {
			return true
		}
	}
	return false
}

func (s *CheckpointService) restoreSelectedLocked(commitHash string, paths []string, previewFiles []protocol.CheckpointFileChange) ([]string, []string, error) {
	if len(paths) == 0 {
		return nil, nil, fmt.Errorf("selected restore requires at least one path")
	}
	statusByPath := map[string]string{}
	for _, file := range previewFiles {
		statusByPath[file.Path] = file.Status
	}
	restored := []string{}
	skipped := []string{}
	for _, relPath := range paths {
		relPath = filepath.Clean(strings.TrimSpace(relPath))
		if relPath == "" || strings.HasPrefix(relPath, "..") || filepath.IsAbs(relPath) {
			skipped = append(skipped, relPath)
			continue
		}
		if statusByPath[relPath] == "added" {
			if err := os.RemoveAll(filepath.Join(s.workspaceDir, relPath)); err != nil {
				return restored, skipped, err
			}
			_ = s.runGit("rm", "--cached", "--ignore-unmatch", relPath)
			restored = append(restored, relPath)
			continue
		}
		if err := s.runGit("checkout", commitHash, "--", relPath); err != nil {
			skipped = append(skipped, relPath)
			continue
		}
		restored = append(restored, relPath)
	}
	_ = s.runGit("add", ".", "--ignore-errors")
	return restored, skipped, nil
}

func (s *CheckpointService) createPatchLocked(commitHash string) (string, error) {
	if strings.TrimSpace(commitHash) == "" {
		return "", fmt.Errorf("checkpoint hash is required")
	}
	_ = s.runGit("add", ".", "--ignore-errors")
	patch, err := s.runGitOutput("diff", "--cached", commitHash)
	if err != nil {
		return "", fmt.Errorf("git diff patch: %w", err)
	}
	patchDir := filepath.Join(s.checkpointDir, "patches")
	if err := os.MkdirAll(patchDir, 0755); err != nil {
		return "", err
	}
	patchPath := filepath.Join(patchDir, fmt.Sprintf("restore-%s-%d.patch", shortHash(commitHash), time.Now().UnixMilli()))
	if err := os.WriteFile(patchPath, []byte(patch), 0644); err != nil {
		return "", err
	}
	return patchPath, nil
}

func (s *CheckpointService) exportSnapshotLocked(commitHash string) (string, error) {
	if strings.TrimSpace(commitHash) == "" {
		return "", fmt.Errorf("checkpoint hash is required")
	}
	exportDir := filepath.Join(s.checkpointDir, "exports")
	if err := os.MkdirAll(exportDir, 0755); err != nil {
		return "", err
	}
	exportPath := filepath.Join(exportDir, fmt.Sprintf("snapshot-%s.tar", shortHash(commitHash)))
	if err := s.runGit("archive", "--format=tar", "-o", exportPath, commitHash); err != nil {
		return "", fmt.Errorf("git archive: %w", err)
	}
	return exportPath, nil
}

func shortHash(hash string) string {
	if len(hash) <= 8 {
		return hash
	}
	return hash[:8]
}
