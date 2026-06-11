package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/igoryan-dao/ricochet/internal/agent/hooks"
	agentLessons "github.com/igoryan-dao/ricochet/internal/agent/memory"
	"github.com/igoryan-dao/ricochet/internal/codegraph"
	"github.com/igoryan-dao/ricochet/internal/config"
	context_manager "github.com/igoryan-dao/ricochet/internal/context"
	"github.com/igoryan-dao/ricochet/internal/context/handoff"
	"github.com/igoryan-dao/ricochet/internal/ether"
	"github.com/igoryan-dao/ricochet/internal/git"
	"github.com/igoryan-dao/ricochet/internal/host"
	"github.com/igoryan-dao/ricochet/internal/index"
	mcpHubPkg "github.com/igoryan-dao/ricochet/internal/mcp"
	legacyMemory "github.com/igoryan-dao/ricochet/internal/memory"
	"github.com/igoryan-dao/ricochet/internal/modes"
	"github.com/igoryan-dao/ricochet/internal/prompts"
	"github.com/igoryan-dao/ricochet/internal/protocol"
	"github.com/igoryan-dao/ricochet/internal/qc"
	"github.com/igoryan-dao/ricochet/internal/rules"
	"github.com/igoryan-dao/ricochet/internal/safeguard"
	"github.com/igoryan-dao/ricochet/internal/skills"
	"github.com/igoryan-dao/ricochet/internal/terminal"
	"github.com/igoryan-dao/ricochet/internal/tools"
	"github.com/igoryan-dao/ricochet/internal/workflow"
)

var reasoningBlockPattern = regexp.MustCompile(`(?is)<(?:thinking|think)>.*?(?:</(?:thinking|think)>|$)`)
var danglingReasoningTagPattern = regexp.MustCompile(`(?is)</?(?:thinking|think)>`)

func visibleAssistantContent(content string) string {
	withoutBlocks := reasoningBlockPattern.ReplaceAllString(content, "")
	withoutTags := danglingReasoningTagPattern.ReplaceAllString(withoutBlocks, "")
	return strings.TrimSpace(withoutTags)
}

func taskProgressDebugFileEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RICOCHET_TASK_PROGRESS_DEBUG_FILE"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func contextWarnings(report *protocol.ContextBuildReport) []string {
	if report == nil {
		return nil
	}
	return report.Warnings
}

func contextSuggestions(report *protocol.ContextBuildReport) []string {
	if report == nil {
		return nil
	}
	return report.Suggestions
}

func providerSupportsDefaultEmbeddings(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "openai", "gemini":
		return true
	default:
		return false
	}
}

func persistTaskProgressDebugFile(cwd string, status string, summary string, steps []string) error {
	if !taskProgressDebugFileEnabled() {
		return nil
	}

	taskMdContent := fmt.Sprintf("# Task Progress\n\n**Status**: %s\n**Summary**: %s\n\n", status, summary)
	taskMdContent += "## Progress Log\n"
	for i, step := range steps {
		taskMdContent += fmt.Sprintf("%d. %s\n", i+1, step)
	}

	return os.WriteFile(filepath.Join(cwd, "task_progress_current.md"), []byte(taskMdContent), 0644)
}

func taskProgressStatusFromTodos(todos []protocol.Todo) string {
	todos = protocol.NormalizeTodoList(todos)
	if len(todos) == 0 {
		return ""
	}
	for _, todo := range todos {
		if todo.Status == "current" && strings.TrimSpace(todo.Text) != "" {
			return todo.Text
		}
	}
	completed := 0
	for _, todo := range todos {
		if todo.Status == "completed" {
			completed++
		}
	}
	if completed == len(todos) {
		return "Task checklist completed"
	}
	for _, todo := range todos {
		if strings.TrimSpace(todo.Text) != "" {
			return todo.Text
		}
	}
	return "Updated task checklist"
}

// Controller manages chat sessions and AI interactions
type Controller struct {
	mu                sync.RWMutex
	provider          Provider
	sessionManager    *SessionManager
	config            *Config
	executor          tools.Executor
	envTracker        *context_manager.EnvironmentTracker
	safeguard         *safeguard.Manager
	modes             *modes.Manager
	rules             *rules.Manager
	host              host.Host
	checkpointManager *CheckpointManager
	providersManager  *config.ProvidersManager
	indexer           *index.Indexer
	workspaceIndex    *index.WorkspaceIndexManager

	codegraph            *codegraph.Service
	handoffService       *handoff.Service
	workflows            *workflow.Manager
	workflowEngine       *workflow.Engine
	skills               *skills.Manager
	qcManager            *qc.Manager
	dynamicHooks         *hooks.DynamicHookManager
	memoryManager        *legacyMemory.Manager
	intelligenceManager  *agentLessons.Manager
	windowManager        *context_manager.WindowManager // Context window management (Tengu Effect)
	fileWatcher          *FileWatcher                   // Workspace monitor
	cwd                  string
	injectionProcessor   *InjectionProcessor
	mcpHub               *mcpHubPkg.Hub
	mcpManager           *mcpHubPkg.Manager
	mcpRegistry          *mcpHubPkg.Registry
	gitManager           *git.Manager       // Git integration
	loopDetector         *LoopDetector      // Detects repetitive content patterns
	planManager          *PlanManager       // Manages long-term plan
	swarm                *SwarmOrchestrator // Swarm Orchestrator
	helpAgent            *HelpAgent         // Handles help queries
	usageTracker         *UsageTracker      // Centralized token and cost tracking
	scratchpad           *ScratchpadManager // Cross-agent shared knowledge
	auditor              *ShadowAuditor     // Semantic verification (Shadow Agent)
	lifecycleRecorder    *LifecycleRecorder // Durable tool lifecycle event log
	defaultModel         string             // Default model for internal tasks
	autoApprovalMu       sync.Mutex
	autoApprovalRequests int
	autoApprovalCostBase float64
	contextStatusMu      sync.RWMutex
	lastContextStatus    map[string]*protocol.ContextStatus
	lastCompaction       map[string]*protocol.ContextCompactionEvent

	// Abort support
	abortMu     sync.Mutex
	abortCancel context.CancelFunc

	// UI Callbacks
	onTaskProgress func(protocol.TaskProgress)

	// Autonomous Events (Sprint 4.0)
	events            *EventEmitter
	lastMcpStatusHash string // Cache to prevent status emission spam
}

func isSimpleFastPathRequest(content string) bool {
	text := strings.ToLower(strings.TrimSpace(content))
	if text == "" {
		return false
	}

	complexSignals := []string{
		"analyze", "analyse", "architecture", "research", "internet", "trend", "roadmap", "plan for",
		"проанализ", "архитект", "исслед", "интернет", "тренд", "роадмап", "дорожн",
	}
	for _, signal := range complexSignals {
		if strings.Contains(text, signal) {
			return false
		}
	}

	editSignals := []string{
		"add", "insert", "append", "change", "replace", "update", "edit", "fix", "remove", "delete",
		"добав", "встав", "измени", "замени", "обнов", "отредакт", "исправ", "удали",
	}
	hasEditSignal := false
	for _, signal := range editSignals {
		if strings.Contains(text, signal) {
			hasEditSignal = true
			break
		}
	}
	if !hasEditSignal {
		return false
	}

	fileSignals := []string{
		" file", "file ", "файл", ".md", ".txt", ".json", ".toml", ".yaml", ".yml", ".rs", ".go", ".ts", ".tsx", ".js", ".jsx", "readme", "реадми", "ридми",
	}
	hasFileSignal := false
	for _, signal := range fileSignals {
		if strings.Contains(text, signal) {
			hasFileSignal = true
			break
		}
	}
	if !hasFileSignal {
		return false
	}

	return len([]rune(text)) < 260
}

func isComplexTaskRequest(content string) bool {
	text := strings.ToLower(strings.TrimSpace(content))
	if text == "" || strings.HasPrefix(text, "/") || isSimpleFastPathRequest(content) {
		return false
	}
	signals := []string{
		"analyze", "analyse", "architecture", "research", "investigate", "review project", "codebase", "roadmap", "plan",
		"проанализ", "анализ", "архитект", "исслед", "проект", "кодовую баз", "кодобаз", "дорожн", "план",
	}
	for _, signal := range signals {
		if strings.Contains(text, signal) {
			return true
		}
	}
	return len([]rune(text)) > 320
}

func provisionalMilestonesForRequest(content string) []string {
	text := strings.ToLower(strings.TrimSpace(content))
	if strings.Contains(text, "проанализ") || strings.Contains(text, "analyze") || strings.Contains(text, "analyse") || strings.Contains(text, "project") || strings.Contains(text, "проект") {
		return []string{
			"Understand project purpose",
			"Map architecture and modules",
			"Review key files and dependencies",
			"Identify risks and gaps",
			"Summarize findings",
		}
	}
	return []string{
		"Clarify objective and scope",
		"Inspect relevant project context",
		"Plan the implementation path",
		"Apply and verify changes",
		"Summarize results",
	}
}

func provisionalStatusForRequest(content string) string {
	text := strings.ToLower(strings.TrimSpace(content))
	if strings.Contains(text, "проанализ") || strings.Contains(text, "analyze") || strings.Contains(text, "analyse") || strings.Contains(text, "project") || strings.Contains(text, "проект") {
		return "Planning project analysis..."
	}
	return "Preparing task plan..."
}

func isSimpleFastPathPlanningTool(toolName string) bool {
	switch toolName {
	case "task_boundary", "update_plan", "update_todos", "create_task", "next_task", "complete_task", "list_tasks", "add_subtask", "delete_task", "subagent", "start_swarm", "ask_user_choice", "switch_mode", "submit_plan":
		return true
	default:
		return false
	}
}

func isPlanArtifactRequest(content string) bool {
	text := strings.ToLower(strings.TrimSpace(content))
	if text == "" {
		return false
	}
	if strings.Contains(text, ".md") || strings.Contains(text, "markdown file") || strings.Contains(text, "md file") || strings.Contains(text, "файл") {
		return false
	}
	planTerms := []string{
		"implementation plan",
		"plan of work",
		"work plan",
		"create a plan",
		"make a plan",
		"write a plan",
		"создай план",
		"сделай план",
		"план работ",
		"план реализации",
		"имплементационный план",
	}
	for _, term := range planTerms {
		if strings.Contains(text, term) {
			return true
		}
	}
	return false
}

// SubscribeEvents adds a listener for autonomous agent events
func (c *Controller) SubscribeEvents(l EventListener) {
	c.events.Subscribe(l)
}

// Config holds agent configuration
type Config struct {
	Provider           ProviderConfig               `json:"provider"`
	EmbeddingProvider  *ProviderConfig              `json:"embedding_provider,omitempty"`
	SystemPrompt       string                       `json:"system_prompt"`
	MaxTokens          int                          `json:"max_tokens"` // Max tokens for response generation
	Temperature        float64                      `json:"temperature"`
	TopP               float64                      `json:"top_p"`
	ContextWindow      int                          `json:"context_window"` // Context window limit for pruning
	EnableCodeIndex    bool                         `json:"enable_code_index"`
	Context            config.ContextSettings       `json:"context"`
	AutoApproval       *config.AutoApprovalSettings `json:"auto_approval"`
	ModeModels         config.ModeModelSettings     `json:"mode_models,omitempty"`
	Terminal           config.TerminalSettings      `json:"terminal,omitempty"`
	Tools              config.ToolsSettings         `json:"tools"`
	Swarm              SwarmConfig                  `json:"swarm"`
	CustomInstructions string                       `json:"custom_instructions,omitempty"`
}

// Session represents a chat session
type Session struct {
	ID                  string                       `json:"id"`
	StateHandler        *MessageStateHandler         `json:"-"` // Internal state handler
	FileTracker         *context_manager.FileTracker `json:"-"` // Tracks accessed files
	Todos               []protocol.Todo              `json:"todos"`
	MessageQueue        []protocol.QueuedMessage     `json:"message_queue,omitempty"`
	BatchWorkerID       string                       `json:"batch_worker_id,omitempty"`
	AllowedRoot         string                       `json:"allowed_root,omitempty"`
	ScopePaths          []string                     `json:"scope_paths,omitempty"`
	IsolatedAutoApprove bool                         `json:"isolated_auto_approve,omitempty"`
	TotalCost           float64                      `json:"total_cost"`
	PlanApproved        bool                         `json:"plan_approved"`
	PlanReviewRequested bool                         `json:"plan_review_requested"`
	CreatedAt           time.Time                    `json:"created_at"`
}

// ControllerOptions allows overriding default components
type ControllerOptions struct {
	Host             host.Host
	Modes            *modes.Manager
	Rules            *rules.Manager
	McpHub           *mcpHubPkg.Hub
	ProvidersManager *config.ProvidersManager
	Codegraph        *codegraph.Service
	WorkflowManager  *workflow.Manager
}

// NewController creates a new agent controller
func NewController(cfg *Config, opts ...ControllerOptions) (*Controller, error) {
	provider, err := NewProvider(cfg.Provider)
	if err != nil {
		return nil, fmt.Errorf("create provider: %w", err)
	}

	cwd, _ := os.Getwd()

	var h host.Host
	var mm *modes.Manager
	var rm *rules.Manager
	var mcpHub *mcpHubPkg.Hub
	var providersManager *config.ProvidersManager
	var cg *codegraph.Service
	var wm *workflow.Manager

	if len(opts) > 0 {
		h = opts[0].Host
		mm = opts[0].Modes
		rm = opts[0].Rules
		mcpHub = opts[0].McpHub
		providersManager = opts[0].ProvidersManager
		cg = opts[0].Codegraph
		wm = opts[0].WorkflowManager
	}

	if h == nil {
		h = host.NewNativeHost(cwd)
	}
	cwd = h.GetCWD()
	if mm == nil {
		mm = modes.NewManager(cwd)
	}
	if rm == nil {
		rm = rules.NewManager(cwd)
	}
	// mcpHub can be nil
	// cg (codegraph) can be nil (feature disabled or not provided)
	if wm == nil {
		wm = workflow.NewManager(cwd)
	}

	// Initialize safeguard manager
	safeguardMgr, err := safeguard.NewManager(cwd)
	if err != nil {
		log.Printf("Warning: Failed to initialize safeguard manager: %v", err)
	} else {
		if cfg.AutoApproval != nil {
			safeguardMgr.SetAutoApproval(cfg.AutoApproval)
		}
		// Set Tools Settings (DisableLLMCorrection)
		safeguardMgr.SetToolsSettings(&cfg.Tools)
	}

	// Initialize Session Manager
	// Store sessions in .ricochet/sessions
	configDir := filepath.Join(os.Getenv("HOME"), ".ricochet")
	sessionDir := filepath.Join(configDir, "sessions")
	sessionManager := NewSessionManager(sessionDir)

	// Initialize MCP Manager
	mcpManager := mcpHubPkg.NewManager(configDir)

	// Initialize MCP Registry
	mcpRegistry := mcpHubPkg.NewRegistry("") // Uses default registry URL

	// Initialize Git Manager
	gitMgr := git.NewManager(cwd)

	// Initialize Embedder.
	// If EmbeddingProvider is configured, use it. Otherwise only fall back to
	// providers with known native embedding endpoints. OpenAI-compatible chat
	// providers such as zhipu/deepseek/openrouter often expose chat but not
	// OpenAI's text-embedding-3-small model, so probing them on IDE startup is
	// expensive and noisy.
	var embedder index.Embedder
	if cfg.EmbeddingProvider != nil && cfg.EmbeddingProvider.Provider != "" {
		embProv, err := NewProvider(*cfg.EmbeddingProvider)
		if err != nil {
			log.Printf("Warning: Failed to create embedding provider: %v. Semantic vector index disabled.", err)
		} else {
			embedder = embProv
			log.Printf("Using separate embedding provider: %s", cfg.EmbeddingProvider.Provider)
		}
	} else if providerSupportsDefaultEmbeddings(provider.Name()) {
		embedder = provider
	} else {
		log.Printf("Semantic vector index disabled: provider %s has no configured embedding model. Local workspace map remains enabled.", provider.Name())
	}

	// Initialize indexer
	indexPath := filepath.Join(os.Getenv("HOME"), ".ricochet", "index.vdb")
	store, _ := index.NewLocalStore(indexPath)
	indexer := index.NewIndexer(store, embedder, cwd)
	workspaceIndex := index.NewWorkspaceIndexManager(cwd)

	// Initialize Memory RAG (Sprint 5.0)
	memoryIndexPath := filepath.Join(os.Getenv("HOME"), ".ricochet", "memory.vdb")
	memoryStore, _ := index.NewLocalStore(memoryIndexPath)
	memoryIndexer := agentLessons.NewIndexer(memoryStore, embedder)

	// Initialize Skill Manager
	skillMgr := skills.NewManager(cwd)
	if err := skillMgr.LoadSkills(); err != nil {
		log.Printf("Warning: Failed to load skills: %v", err)
	}

	// Initialize QC Manager
	qcMgr := qc.NewManager(cwd)

	// Initialize Dynamic Hook Manager (Hookify)
	hooksMgr := hooks.NewDynamicHookManager(cwd)

	// Initialize Memory Manager (Phase 15)
	memoryMgr, _ := legacyMemory.NewManager(cwd)

	// Initialize Intelligence Manager (lessons) & attach RAG indexer
	intelMgr := agentLessons.NewManager(cwd)
	intelMgr.SetIndexer(memoryIndexer)

	// Initialize Injection Processor (Phase 17)
	injectionProc := NewInjectionProcessor(cwd)

	// Initialize Plan Manager (Autonomous Agent)
	pmMgr := NewPlanManager(cwd)

	// Initialize Event Emitter early to allow subscriptions
	evtEmitter := NewEventEmitter()

	// Link Plan updates to Events
	pmMgr.OnChanged = func() {
		evtEmitter.Emit(Event{
			Type: EventPlanUpdated,
			Payload: map[string]interface{}{
				"timestamp": "now", // Heuristic
			},
		})
	}

	// PHASE 5: Initialize Auditor early for Executor link
	auditor := NewShadowAuditor(provider, cfg.Provider.Model)

	executor := tools.NewNativeExecutor(h, mm, safeguardMgr, mcpHub, indexer, cg, wm)

	// Register Subtask Tool (circular dependency handled via interface or setter later)
	// For now, we'll inject it into the executor if supported, or handle via special tool dispatch.
	// Ideally, NativeExecutor should accept custom tools.
	// Let's add it to the NativeExecutor manually or via a wrapper.
	// Since NativeExecutor is in `internal/tools`, we might need to extend it.
	// For simplicity in this phase, let's assume `executor` can register dynamic tools or we handle it in `Chat` loop.
	// BUT, the cleanest way is for NativeExecutor to know about it.
	// Actually, `RunSubtask` is on Controller. `SubtaskTool` calls `Executor.RunSubtask`.
	// So Controller *is* the Executor.

	// Register Subtask Tool (circular dependency handled via interface or setter later)
	subtaskTool := &tools.SubtaskTool{} // Executor set later to avoid circular init
	executor.RegisterTool(subtaskTool)

	// Register MCP Management Tools
	executor.RegisterTool(&tools.MCPListTool{Hub: mcpHub})
	executor.RegisterTool(&tools.MCPBrowseRegistryTool{Registry: mcpRegistry})
	executor.RegisterTool(&tools.MCPInstallTool{Hub: mcpHub, ConfigDir: configDir})
	executor.RegisterTool(&tools.MCPListResourcesTool{Hub: mcpHub})
	executor.RegisterTool(&tools.MCPReadResourceTool{Hub: mcpHub})
	executor.RegisterTool(&tools.MCPListPromptsTool{Hub: mcpHub})

	// PHASE 5: Linking Safety Dependencies
	executor.SetAuditor(auditor)
	// Controller will set itself as the session provider once fully initialized
	// but we can set it now since we have the sessionManager.

	// Trigger indexing in background
	if cfg.Context.WorkspaceIndexEnabled || cfg.EnableCodeIndex {
		workspaceIndex.Start(context.Background(), 5*time.Minute)
	}
	if cfg.EnableCodeIndex && embedder != nil {
		go func() {
			ctx := context.Background()
			if err := indexer.IndexAll(ctx); err != nil {
				log.Printf("Background indexing failed: %v", err)
			}
		}()
	} else if cfg.EnableCodeIndex {
		log.Printf("Skipping semantic background indexing: no embedding provider configured.")
	}

	// Also trigger CodeGraph rebuild if available. It is local-only and does
	// not require embeddings.
	if cfg.Context.WorkspaceIndexEnabled && cg != nil {
		go func() {
			start := time.Now()
			log.Printf("Building code graph...")
			if err := cg.Rebuild(cwd); err != nil {
				log.Printf("Code graph rebuild failed: %v", err)
			} else {
				log.Printf("Code graph built in %v (files: %d)", time.Since(start), len(cg.GetAllFiles()))

				// Compute PageRank (takes a few iterations)
				log.Printf("Computing PageRank...")
				prStart := time.Now()
				cg.CalculatePageRank()
				log.Printf("PageRank computed in %v", time.Since(prStart))
			}
		}()
	}

	// Initialize session manager
	// storageDir := paths.GetSessionDir(cwd) // Using sessionDir from above
	// sm := NewSessionManager(storageDir)

	// Initialize Checkpoint Manager (Phase 18)
	checkpointMgr := NewCheckpointManager(cwd)

	// Initialize Scratchpad
	scratchMgr, _ := NewScratchpadManager(h.GetCWD())

	ctrl := &Controller{
		provider:            provider,
		sessionManager:      sessionManager,
		config:              cfg,
		executor:            executor,
		envTracker:          context_manager.NewEnvironmentTracker(cwd),
		safeguard:           safeguardMgr,
		modes:               mm,
		rules:               rm,
		host:                h,
		cwd:                 cwd,
		providersManager:    providersManager,
		indexer:             indexer,
		workspaceIndex:      workspaceIndex,
		codegraph:           cg,
		workflows:           wm,
		skills:              skillMgr,
		qcManager:           qcMgr,
		dynamicHooks:        hooksMgr,
		memoryManager:       memoryMgr,
		intelligenceManager: intelMgr,
		windowManager:       context_manager.NewWindowManager(cfg.ContextWindow),
		checkpointManager:   checkpointMgr,
		planManager:         pmMgr,
		helpAgent:           NewHelpAgent(),
		usageTracker:        NewUsageTracker(providersManager),
		scratchpad:          scratchMgr,
		auditor:             auditor,
		lifecycleRecorder:   NewLifecycleRecorder(filepath.Join(configDir, "events", "tool_lifecycle.jsonl")),
		defaultModel:        cfg.Provider.Model,
		loopDetector:        NewLoopDetector(3),
		injectionProcessor:  injectionProc,
		mcpHub:              mcpHub,
		mcpManager:          mcpManager,
		mcpRegistry:         mcpRegistry,
		gitManager:          gitMgr,
		events:              evtEmitter,
		lastContextStatus:   make(map[string]*protocol.ContextStatus),
		lastCompaction:      make(map[string]*protocol.ContextCompactionEvent),
	}

	// Initialize Swarm Orchestrator
	ctrl.swarm = NewSwarmOrchestrator(ctrl, pmMgr, cfg.Swarm)

	// Register Task Management Tools
	executor.RegisterTool(&StartSwarmToolImpl{Orchestrator: ctrl.swarm})
	executor.RegisterTool(&UpdatePlanToolImpl{Plan: pmMgr})
	executor.RegisterTool(&CreateTaskToolImpl{Plan: pmMgr, Events: evtEmitter})
	executor.RegisterTool(&NextTaskToolImpl{Plan: pmMgr})
	executor.RegisterTool(&CompleteTaskToolImpl{
		Plan:     pmMgr,
		Events:   evtEmitter,
		Provider: provider,
		Model:    cfg.Provider.Model,
	})
	executor.RegisterTool(&ListTasksToolImpl{Plan: pmMgr})
	executor.RegisterTool(&AddSubtaskToolImpl{Plan: pmMgr})
	executor.RegisterTool(&DeleteTaskToolImpl{Plan: pmMgr})
	executor.RegisterTool(&UpdateTaskToolImpl{Plan: pmMgr})
	executor.RegisterTool(&tools.ListSkillsTool{Manager: skillMgr})
	executor.RegisterTool(&tools.InvokeSkillTool{Manager: skillMgr})
	executor.RegisterTool(&tools.RetrieveContextOriginalTool{})
	for _, name := range []string{"graph_status", "graph_explore", "route_lookup", "dependency_trace", "symbol_impact"} {
		executor.RegisterTool(&tools.WorkspaceGraphTool{NameValue: name, Manager: workspaceIndex})
	}
	executor.RegisterTool(&tools.ResearchDoctorTool{})
	executor.RegisterTool(&tools.DocumentParseTool{WorkspaceRoot: cwd})

	// Initialize Workflow Engine
	ctrl.workflowEngine = workflow.NewEngine(ctrl, &CommandExecutorAdapter{Host: h})

	// Close the loops
	subtaskTool.Executor = ctrl
	executor.RegisterTool(tools.NewIntelligenceTool(ctrl.StoreLesson))
	executor.SetSessionProvider(ctrl)
	executor.SetSwarmProvider(ctrl.swarm)

	// Start background systems
	if ctrl.fileWatcher != nil {
		go ctrl.fileWatcher.Start(context.Background())
	}

	// Start MCP status broadcaster
	go ctrl.startMcpBroadcaster()

	return ctrl, nil
}

// GetFileTracker implements tools.SessionProvider
func (c *Controller) GetFileTracker(sid string) *context_manager.FileTracker {
	session := c.sessionManager.GetSession(sid)
	if session == nil {
		return nil
	}
	return session.FileTracker
}

// RunSubtask executes a goal in an isolated session
type SubtaskRunOptions struct {
	MaxTurns                  int
	ReadOnly                  bool
	SuppressParentChatUpdates bool
	BatchWorkerID             string
	AgentSessionID            string
	AllowedRoot               string
	ScopePaths                []string
	IsolatedAutoApprove       bool
	VerificationCommands      []string
}

func (c *Controller) RunSubtask(ctx context.Context, parentSessionID string, goal string, contextInfo string, role string, preconditions []string, expectedOutcome string) (string, error) {
	return c.RunSubtaskWithOptions(ctx, parentSessionID, goal, contextInfo, role, preconditions, expectedOutcome, SubtaskRunOptions{})
}

func (c *Controller) RunSubtaskWithOptions(ctx context.Context, parentSessionID string, goal string, contextInfo string, role string, preconditions []string, expectedOutcome string, opts SubtaskRunOptions) (string, error) {
	log.Printf("[Controller] Starting SUBTASK: %s (Role: %s, Parent: %s)", goal, role, parentSessionID)
	if role == "researcher" {
		opts.ReadOnly = true
	}

	// 1. Create Child Session
	childSession := c.CreateSession()
	if strings.TrimSpace(opts.AgentSessionID) != "" {
		childSession = c.sessionManager.CreateSessionWithID(opts.AgentSessionID)
	}
	if opts.BatchWorkerID != "" {
		childSession.BatchWorkerID = opts.BatchWorkerID
		childSession.AllowedRoot = opts.AllowedRoot
		childSession.ScopePaths = append([]string{}, opts.ScopePaths...)
		childSession.IsolatedAutoApprove = opts.IsolatedAutoApprove
	}

	// 1.5 Context Inheritance: Copy Active Files from Parent
	if parentSessionID != "" {
		parentSession := c.sessionManager.GetSession(parentSessionID)
		if parentSession != nil {
			activeFiles := parentSession.FileTracker.GetFiles()
			if len(activeFiles) > 0 {
				log.Printf("Inheriting %d active files from parent session %s", len(activeFiles), parentSessionID)
				for _, f := range activeFiles {
					childSession.FileTracker.AddFile(f)
				}
			}
		}
	}

	// 2. Prime the session with specialized role
	var sysPrompt string
	switch role {
	case "architect":
		sysPrompt = fmt.Sprintf("You are a specialized System Architect Agent.\nGOAL: %s\nCONTEXT: %s\n\nROLE: Focus on high-level design patterns, system scalability, and trade-offs. Do not get bogged down in implementation details unless necessary. Provide a concrete plan or design document.", goal, contextInfo)
	case "qa":
		sysPrompt = fmt.Sprintf("You are a specialized QA/Security Agent.\nGOAL: %s\nCONTEXT: %s\n\nROLE: Critically analyze the code/plan for bugs, security vulnerabilities, and edge cases. Be pedantic but constructive. Propose tests.", goal, contextInfo)
	case "researcher":
		sysPrompt = fmt.Sprintf("You are a specialized Research Agent.\nGOAL: %s\nCONTEXT: %s\n\nROLE: Gather information, summarize findings, and provide citations/file paths. You are read-only: use read/search/definition/safe status tools only, do not edit files, run unsafe commands, use browser automation, or spawn nested subagents.", goal, contextInfo)
	case "batch-worker":
		sysPrompt = fmt.Sprintf("You are a Ricochet batch model-worker.\nGOAL: %s\nCONTEXT: %s\n\nROLE: Work only inside your isolated worktree and assigned scope. Follow inspect -> plan -> edit -> verify -> summarize. Never push, merge, rebase, modify the main workspace, use browser/MCP tools, or spawn nested subagents. Finish with TASK_COMPLETE: summary, or TASK_FAILED: reason.", goal, contextInfo)
	default: // "general"
		sysPrompt = fmt.Sprintf("You are a Sub-Agent focused on a specific task.\nGOAL: %s\nCONTEXT: %s\n\nPerform the task efficiently. When done, output a summary of your actions.", goal, contextInfo)
	}

	childSession.StateHandler.AddMessage(protocol.Message{Role: "system", Content: sysPrompt})

	// 2.5 Blueprint Enforcement: Run Preconditions
	if len(preconditions) > 0 {
		log.Printf("[Controller] Enforcing %d preconditions for subtask: %s", len(preconditions), goal)
		for _, cmd := range preconditions {
			_, err := c.host.ExecuteCommand(ctx, cmd, false)
			if err != nil {
				return "", fmt.Errorf("precondition failed: '%s' error: %w", cmd, err)
			}
		}
	}

	// 3. Run Auto-Pilot Loop
	// We check for "TASK_COMPLETE" in the output to break the loop.
	// If the agent pauses (returns text without completion), we urge it to continue.
	var finalSummary string
	maxTurns := 15
	if opts.MaxTurns > 0 {
		maxTurns = opts.MaxTurns
	}
	auditRejections := 0
	nextPrompt := ""
	completedExplicitly := false

	for i := 0; i < maxTurns; i++ {
		input := ChatRequestInput{
			SessionID:            childSession.ID,
			Content:              "Please continue working on the goal. If you are finished, output 'TASK_COMPLETE:' followed by a summary.",
			Via:                  "subtask",
			PlanMode:             opts.ReadOnly,
			MaxTurns:             opts.MaxTurns,
			BatchWorkerID:        opts.BatchWorkerID,
			AllowedRoot:          opts.AllowedRoot,
			ScopePaths:           opts.ScopePaths,
			IsolatedAutoApprove:  opts.IsolatedAutoApprove,
			VerificationCommands: opts.VerificationCommands,
		}
		if opts.BatchWorkerID != "" {
			input.Via = "batch_worker"
		}
		if nextPrompt != "" {
			input.Content = nextPrompt
			nextPrompt = ""
		}

		// First turn specific prompt
		if i == 0 {
			input.Content = fmt.Sprintf("STARTING SUBTASK: %s\nContext: %s", goal, contextInfo)
			if expectedOutcome != "" {
				input.Content += fmt.Sprintf("\nEXPECTED OUTCOME: %s", expectedOutcome)
			}
			input.Content += "\nPlease proceed."
		}

		var lastResponse string

		// Run Chat (Blocking wait for this turn)
		// We use a done channel to wait for Chat to return (which it does after its internal loop)
		// Wait, Chat wraps everything in a goroutine?
		// No, Chat function signature in Controller (line 499) returns error.
		// It executes synchronously?
		// Checking Chat implementation...
		// It creates a `ctx, cancel`.
		// It does `go func()`? No.
		// It calls `callback` synchronously?
		// Let's verify `Chat` is synchronous or blocking.
		// `Chat` calls `c.provider.Chat` which is blocking.
		// It loops `for currentTurn < maxTurns`.
		// So `Chat` blocks until it finishes a "turn" (which might be multiple tool calls).
		// Yes, `Chat` is blocking.

		err := c.Chat(ctx, input, func(update interface{}) {
			// Forward events to parent UI if callback exists
			// Retrieve parent callback from context... wait, RunSubtask HAS the context.
			// But we need to EXTRACT it from ctx first.
			if parentCb, ok := ctx.Value("chat_callback").(func(interface{})); ok {
				// We need to re-wrap the update to target the parent session
				// and visually indicate it's a subtask.
				switch u := update.(type) {
				case ChatUpdate:
					if u.Message == nil || u.Message.Role != "assistant" {
						return
					}
					// Rewrite Session ID to parent so it renders in main view
					u.SessionID = parentSessionID
					// Prefix content
					// Only prefix if it's content, not streaming chunks which might look weird if prefixed every time.
					// But we are not streaming deeply here yet? "IsStreaming" logic.
					// Let's just prefix the first chunk or all?
					// Simpler: Just forward it. The content will speak for itself.
					// Or append "[Subtask]" prefix.
					// Only forward assistant messages or system?
					// Forward everything for transparency.
					if !opts.SuppressParentChatUpdates {
						parentCb(u)
					}

					// Capture for local logic
					if u.Message != nil && u.Message.Role == "assistant" && !u.Message.IsStreaming {
						lastResponse = u.Message.Content
					}
				case protocol.TaskProgress:
					// Forward task progress
					// Inject Identity for TUI Badges
					u.AgentIdentifier = strings.ToUpper(role)
					switch role {
					case "architect":
						u.AgentColor = "#9D65FF" // Purple
					case "qa":
						u.AgentColor = "#FF9D00" // Orange
					case "researcher":
						u.AgentColor = "#00AFFF" // Blue
					case "swarm-worker":
						u.AgentColor = "#00FF99" // Green
					default:
						u.AgentColor = "#767676" // Gray
					}
					parentCb(u)
				}
			} else {
				// Fallback local capture if no parent callback (shouldn't happen in real run)
				if u, ok := update.(ChatUpdate); ok {
					if u.Message != nil && u.Message.Role == "assistant" && !u.Message.IsStreaming {
						lastResponse = u.Message.Content
					}
				}
			}
		})

		if strings.TrimSpace(lastResponse) != "" {
			finalSummary = lastResponse
		}

		if err != nil {
			if ctx.Err() != nil && strings.TrimSpace(finalSummary) != "" {
				result := tools.SubtaskResult{
					Status:       "timeout",
					Summary:      strings.TrimSpace(finalSummary),
					RecoveryHint: "Worker reached its bounded runtime and returned the best partial summary available.",
				}
				resJSON, _ := json.Marshal(result)
				return string(resJSON), nil
			}
			return "", fmt.Errorf("subtask error on turn %d: %w", i+1, err)
		}

		// Check for Completion Signal
		if strings.Contains(lastResponse, "TASK_COMPLETE") {
			summary := strings.TrimPrefix(strings.Split(lastResponse, "TASK_COMPLETE")[1], ":")

			// 🕵️ Shadow Audit Completion: Verify if goal is truly met
			auditRes, aErr := c.auditor.AuditCompletion(ctx, goal, summary)
			if aErr == nil && !auditRes.Approved {
				log.Printf("🕵️ Shadow Audit REJECTED Completion: %s", goal)
				auditRejections++
				if auditRejections > 1 {
					finalSummary = strings.TrimSpace(summary + "\n\nAudit warning: " + auditRes.Feedback)
					break
				}
				nextPrompt = fmt.Sprintf("🕵️ **Verification Failed**: Your task was marked as incomplete by the Auditor.\n\nFeedback: %s\n\nPlease address these issues and only report TASK_COMPLETE when finished.", auditRes.Feedback)
				continue
			}

			finalSummary = summary
			completedExplicitly = true
			break
		}

		// Check for Failure Signal (Phase 14)
		if strings.Contains(lastResponse, "TASK_FAILED") {
			failReason := strings.TrimPrefix(strings.Split(lastResponse, "TASK_FAILED")[1], ":")
			result := tools.SubtaskResult{
				Status:       "failed",
				Error:        strings.TrimSpace(failReason),
				RecoveryHint: "Check the error message and context. You may need to retry with different search terms or paths.",
			}
			resJSON, _ := json.Marshal(result)
			return string(resJSON), nil
		}

		// If no completion signal, loop continues with "Please continue..."
		// Unless the agent explicitly says "I cannot continue" or similar?
		// For now, we rely on the prompt instructing "TASK_COMPLETE".
	}

	// Default Success
	result := tools.SubtaskResult{
		Status:  "success",
		Summary: strings.TrimSpace(finalSummary),
	}
	if !completedExplicitly {
		result.Status = "timeout"
		if result.Summary == "" {
			result.Error = "Subtask reached its bounded turn limit before reporting completion explicitly."
		}
		result.RecoveryHint = "Use the partial worker activity or run a deep mission for a fuller report."
	}

	resJSON, _ := json.Marshal(result)
	return string(resJSON), nil
}

func (c *Controller) GetHost() host.Host {
	return c.host
}

func (c *Controller) GetCWD() string {
	return c.cwd
}

func (c *Controller) GetMcpManager() *mcpHubPkg.Manager {
	return c.mcpManager
}

func (c *Controller) GetGitManager() *git.Manager {
	return c.gitManager
}

func (c *Controller) GetIndexer() *index.Indexer {
	return c.indexer
}

func (c *Controller) GetWorkspaceIndexStatus() protocol.WorkspaceIndexStatus {
	if c.workspaceIndex == nil {
		return protocol.WorkspaceIndexStatus{Status: "disabled", Enabled: false}
	}
	return c.workspaceIndex.Status()
}

func (c *Controller) RebuildWorkspaceIndex(ctx context.Context) error {
	if c.workspaceIndex == nil {
		return nil
	}
	return c.workspaceIndex.Rebuild(ctx)
}

func (c *Controller) GetSkillsManager() *skills.Manager {
	return c.skills
}

func (c *Controller) GetPlanManager() *PlanManager {
	return c.planManager
}

// RunSubtaskInDir executes a goal in an isolated session with a specific working directory
func (c *Controller) RunSubtaskInDir(ctx context.Context, parentSessionID string, goal string, contextInfo string, role string, dir string, preconditions []string, expectedOutcome string) (string, error) {
	return c.RunSubtaskInDirWithOptions(ctx, parentSessionID, goal, contextInfo, role, dir, preconditions, expectedOutcome, SubtaskRunOptions{})
}

func (c *Controller) RunSubtaskInDirWithOptions(ctx context.Context, parentSessionID string, goal string, contextInfo string, role string, dir string, preconditions []string, expectedOutcome string, opts SubtaskRunOptions) (string, error) {
	// Create a temporary controller for this isolated run if directory differs
	if dir != "" && dir != c.cwd {
		log.Printf("[Controller] Creating isolated worker controller for dir: %s", dir)

		// Setup options for child controller. File and command operations run
		// in the isolated directory, while UI/RPC prompts still go through the
		// parent host (VS Code, TUI, etc.).
		controllerOpts := ControllerOptions{
			Host:             host.NewScopedHost(c.host, dir),
			Modes:            c.modes,
			Rules:            c.rules,
			McpHub:           c.mcpHub,
			ProvidersManager: c.providersManager,
			Codegraph:        c.codegraph,
			WorkflowManager:  c.workflows,
		}

		childCtrl, err := NewController(c.config, controllerOpts)
		if err != nil {
			return "", fmt.Errorf("failed to create child controller: %w", err)
		}
		if opts.AllowedRoot == "" {
			opts.AllowedRoot = dir
		}
		return childCtrl.RunSubtaskWithOptions(ctx, parentSessionID, goal, contextInfo, role, preconditions, expectedOutcome, opts)
	}

	return c.RunSubtaskWithOptions(ctx, parentSessionID, goal, contextInfo, role, preconditions, expectedOutcome, opts)
}

// GenerateCommitMessage asks the LLM to generate a commit message based on the diff
func (c *Controller) GenerateCommitMessage(ctx context.Context, diff string) (string, error) {
	if diff == "" {
		return "", fmt.Errorf("empty diff")
	}

	system := "You are a professional software engineer. Generate a concise, conventional commit message for the following git diff. Output ONLY the message, no extra text."
	user := fmt.Sprintf("Diff:\n%s", diff)

	messages := []protocol.Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}

	req := &ChatRequest{
		Model:    c.defaultModel,
		Messages: messages,
	}

	resp, err := c.provider.Chat(ctx, req)
	if err != nil {
		return "", err
	}

	return strings.TrimSpace(resp.Content), nil
}

// CommandExecutorAdapter adapts host.Host to workflow.CommandExecutor
type CommandExecutorAdapter struct {
	Host host.Host
}

func (a *CommandExecutorAdapter) Execute(command string) (string, error) {
	// We assume context background for now or TODO pass it
	res, err := a.Host.ExecuteCommand(context.Background(), command, false)
	if err != nil {
		return "", err
	}
	return res.Output, nil
}

func truncateString(s string, max int) string {
	if len(s) <= max {
		return s
	}
	// Safe UTF-8 truncation
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "... (truncated)"
}

// SetLiveMode sets the live mode provider for the executor
func (c *Controller) SetLiveMode(lm tools.LiveModeProvider) {
	if ne, ok := c.executor.(*tools.NativeExecutor); ok {
		ne.SetLiveMode(lm)
	}
}

// AbortCurrentSession cancels any running chat session
func (c *Controller) AbortCurrentSession() {
	c.abortMu.Lock()
	defer c.abortMu.Unlock()
	if c.abortCancel != nil {
		log.Printf("[Controller] Aborting current session...")
		c.abortCancel()
		c.abortCancel = nil
	}

	if c.swarm != nil {
		c.swarm.AbortAll()
	}
}

// CreateSession creates a new session
func (c *Controller) CreateSession() *Session {
	s := c.sessionManager.CreateSession()
	if c.workflows != nil {
		c.workflows.Hooks.Trigger("on_session_created")
	}
	// Automatic persistence on state change
	s.StateHandler.SetOnChanged(func() {
		c.SaveSession(s.ID)
	})
	return s
}

// CreateSessionWithID creates or retrieves a session with a specific ID
func (c *Controller) CreateSessionWithID(id string) *Session {
	s := c.sessionManager.CreateSessionWithID(id)
	if c.workflows != nil {
		c.workflows.Hooks.Trigger("on_session_created")
	}
	// Automatic persistence on state change
	s.StateHandler.SetOnChanged(func() {
		c.SaveSession(id)
	})
	return s
}

// GetSession returns a session by ID, creating if not exists
func (c *Controller) GetSession(id string) *Session {
	s := c.sessionManager.GetSession(id)
	// Ensure callback is attached (especially if loaded from disk)
	if s != nil && s.StateHandler.OnChanged == nil {
		s.StateHandler.SetOnChanged(func() {
			c.SaveSession(id)
		})
	}
	return s
}

// ListSessions returns all sessions
func (c *Controller) ListSessions() []*Session {
	return c.sessionManager.ListSessions()
}

func (c *Controller) SaveAllSessions() {
	if c.sessionManager != nil {
		c.sessionManager.SaveAll()
	}
}

func (c *Controller) SaveSession(id string) {
	if c.sessionManager != nil {
		c.sessionManager.Save(id)
	}
}

// ReloadProvider updates the AI provider and model at runtime
func (c *Controller) ReloadProvider(newConfig ProviderConfig) error {
	newProvider, err := NewProvider(newConfig)
	if err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	c.provider = newProvider
	c.config.Provider = newConfig
	c.defaultModel = newConfig.Model

	// Update secondary components that depend on the provider
	if c.indexer != nil {
		// If no separate embedding provider is configured, use the new main provider
		if c.config.EmbeddingProvider == nil || c.config.EmbeddingProvider.Provider == "" {
			if providerSupportsDefaultEmbeddings(newProvider.Name()) {
				c.indexer.SetProvider(newProvider)
			} else {
				c.indexer.SetProvider(nil)
			}
		}
	}

	if c.auditor != nil {
		c.auditor.SetProvider(newProvider, newConfig.Model)
	}

	return nil
}

func (c *Controller) resolveProviderForRequest(planMode bool) (Provider, ProviderConfig) {
	c.mu.RLock()
	defaultProvider := c.provider
	defaultConfig := c.config.Provider
	modeModels := c.config.ModeModels
	c.mu.RUnlock()

	if !modeModels.Enabled {
		return defaultProvider, defaultConfig
	}

	modeModel := modeModels.Act
	if planMode {
		modeModel = modeModels.Plan
	}
	if strings.TrimSpace(modeModel.Provider) == "" || strings.TrimSpace(modeModel.Model) == "" {
		return defaultProvider, defaultConfig
	}
	if modeModel.Provider == defaultConfig.Provider && modeModel.Model == defaultConfig.Model {
		return defaultProvider, defaultConfig
	}
	if c.providersManager == nil {
		return defaultProvider, defaultConfig
	}

	apiKey := c.providersManager.GetAPIKey(modeModel.Provider)
	if apiKey == "" {
		log.Printf("Mode model %s:%s skipped: API key unavailable", modeModel.Provider, modeModel.Model)
		return defaultProvider, defaultConfig
	}
	modeConfig := defaultConfig
	modeConfig.Provider = modeModel.Provider
	modeConfig.Model = modeModel.Model
	modeConfig.APIKey = apiKey
	modeConfig.BaseURL = c.providersManager.GetBaseURL(modeModel.Provider)

	modeProvider, err := NewProvider(modeConfig)
	if err != nil {
		log.Printf("Mode model %s:%s skipped: %v", modeModel.Provider, modeModel.Model, err)
		return defaultProvider, defaultConfig
	}
	return modeProvider, modeConfig
}

// HydrateSession restores a session with messages from history
func (c *Controller) HydrateSession(sessionID string, messages []protocol.Message) {
	// CreateSessionWithID acts as GetOrCreate - returning existing if found, or creating new
	session := c.CreateSessionWithID(sessionID)
	session.StateHandler.SetMessages(messages)
}

// DeleteSession deletes a session
func (c *Controller) DeleteSession(id string) error {
	return c.sessionManager.DeleteSession(id)
}

// ClearSession clears a session's messages
func (c *Controller) ClearSession(id string) {
	c.sessionManager.DeleteSession(id)
	c.sessionManager.CreateSession() // Recreate
}

func (c *Controller) GetUsageSnapshot(sessionID string) UsageSnapshot {
	if c.usageTracker == nil {
		return UsageSnapshot{SessionID: sessionID, Source: UsageSourceEstimated}
	}
	return c.usageTracker.GetSessionUsage(sessionID)
}

// SetMainSessionID binds the controller and its components (PlanManager) to a specific active session.
// This ensures that planning artifacts are scoped to the current interaction and not global.
func (c *Controller) SetMainSessionID(sessionID string) {
	if c.planManager != nil {
		if err := c.planManager.SetSessionID(sessionID); err != nil {
			log.Printf("[Controller] Failed to set plan session ID: %v", err)
		}
	}
}

// ChatRequest represents a request to chat
type ChatRequestInput struct {
	SessionID            string                           `json:"session_id"`
	Content              string                           `json:"content"`
	Via                  string                           `json:"via,omitempty"` // Message source: telegram, discord, ide
	PlanMode             bool                             `json:"plan_mode,omitempty"`
	MaxTurns             int                              `json:"max_turns,omitempty"`
	RunID                string                           `json:"run_id,omitempty"`
	ContextFiles         []protocol.ContextFileAttachment `json:"context_files,omitempty"`
	BatchWorkerID        string                           `json:"batch_worker_id,omitempty"`
	AllowedRoot          string                           `json:"allowed_root,omitempty"`
	ScopePaths           []string                         `json:"scope_paths,omitempty"`
	IsolatedAutoApprove  bool                             `json:"isolated_auto_approve,omitempty"`
	VerificationCommands []string                         `json:"verification_commands,omitempty"`
}

// ChatUpdate represents a chat update event
type ChatUpdate struct {
	SessionID     string                  `json:"session_id"`
	RunID         string                  `json:"run_id,omitempty"`
	Message       *ChatMessage            `json:"message,omitempty"`
	ContextStatus *protocol.ContextStatus `json:"context_status,omitempty"`
	Usage         *UsageSnapshot          `json:"usage,omitempty"`
}

// ChatMessage represents a message for the frontend
type ChatMessage struct {
	ID             string              `json:"id"`
	Role           string              `json:"role"`
	Content        string              `json:"content"`
	Reasoning      string              `json:"reasoning,omitempty"`
	Timestamp      int64               `json:"timestamp"`
	IsStreaming    bool                `json:"isStreaming,omitempty"`
	RunID          string              `json:"run_id,omitempty"`
	TurnID         string              `json:"turn_id,omitempty"`
	Sequence       int64               `json:"sequence,omitempty"`
	SegmentID      string              `json:"segment_id,omitempty"`
	ToolCalls      []ToolCallInfo      `json:"toolCalls,omitempty"`
	Activities     []ActivityItem      `json:"activities,omitempty"` // Files analyzed, edited, searched
	Steps          []ProgressStep      `json:"steps,omitempty"`      // Real-time progress updates
	Metadata       *TaskMetadata       `json:"metadata,omitempty"`
	Via            string              `json:"via,omitempty"`            // Message source: telegram, discord, ide
	SessionID      string              `json:"sessionId,omitempty"`      // Session context for this message
	Username       string              `json:"username,omitempty"`       // Remote username for Ether messages
	Artifacts      []protocol.Artifact `json:"artifacts,omitempty"`      // Interactive artifacts (plans, etc)
	CheckpointHash string              `json:"checkpointHash,omitempty"` // Workspace snapshot hash for restore
}

// ActivityItem represents a file operation (analyze, edit, search)
type ActivityItem struct {
	Type          string          `json:"type"`                    // search, analyze, edit, command, list_dir
	File          string          `json:"file,omitempty"`          // File or directory path
	LineRange     string          `json:"lineRange,omitempty"`     // "L16-815"
	Results       int             `json:"results,omitempty"`       // for search
	Additions     int             `json:"additions,omitempty"`     // for edit
	Deletions     int             `json:"deletions,omitempty"`     // for edit
	Query         string          `json:"query,omitempty"`         // for search
	Message       string          `json:"message,omitempty"`       // for task_boundary/notifications
	Command       string          `json:"command,omitempty"`       // for command execution
	ResultPreview string          `json:"resultPreview,omitempty"` // bounded output preview
	Entries       []ActivityEntry `json:"entries,omitempty"`       // for directory/search expansion
	Counts        *ActivityCounts `json:"counts,omitempty"`        // aggregate file/folder counts
	Status        string          `json:"status,omitempty"`        // completed/running/failed
	Error         string          `json:"error,omitempty"`
	ExitCode      int             `json:"exitCode,omitempty"`
	DurationMs    int64           `json:"durationMs,omitempty"`
	Cwd           string          `json:"cwd,omitempty"`
	Shell         string          `json:"shell,omitempty"`
	Script        string          `json:"script,omitempty"`
	StartedAt     int64           `json:"startedAt,omitempty"`
	CompletedAt   int64           `json:"completedAt,omitempty"`
	Timestamp     int64           `json:"timestamp"` // ms since epoch
}

type ActivityEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // file, dir, result
	Path string `json:"path,omitempty"`
}

type ActivityCounts struct {
	Files   int `json:"files,omitempty"`
	Folders int `json:"folders,omitempty"`
	Results int `json:"results,omitempty"`
}

// TaskMetadata tracks usage statistics
type TaskMetadata struct {
	TokensIn     int     `json:"tokensIn"`
	TokensOut    int     `json:"tokensOut"`
	TotalCost    float64 `json:"totalCost"`
	ContextLimit int     `json:"contextLimit"`
}

// ProgressStep represents a granular action taken by the agent
type ProgressStep struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Status  string   `json:"status"`            // pending, running, completed, error
	Details []string `json:"details,omitempty"` // Sub-items for breakdown
}

// ToolCallInfo represents tool call info for frontend
type ToolCallInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	Result    string `json:"result,omitempty"`
	Status    string `json:"status"`    // pending, running, completed, error
	Timestamp int64  `json:"timestamp"` // ms since epoch
}

// Chat sends a message and returns response via streaming
func (c *Controller) Chat(ctx context.Context, input ChatRequestInput, callback func(update interface{})) error {
	// Update terminal title to show agent is working
	terminal.SetTerminalTitle(terminal.StateWorking)
	defer terminal.SetTerminalTitle(terminal.StateReady)

	if input.SessionID != "" {
		c.SetMainSessionID(input.SessionID)
	}
	if input.RunID == "" {
		input.RunID = "run-" + uuid.New().String()
	}
	if !input.PlanMode && isPlanArtifactRequest(input.Content) {
		input.PlanMode = true
	}
	activeProvider, activeProviderConfig := c.resolveProviderForRequest(input.PlanMode)

	// Create cancellable context for abort support
	ctx, cancel := context.WithCancel(ctx)
	c.abortMu.Lock()
	c.abortCancel = cancel
	c.abortMu.Unlock()
	defer func() {
		c.abortMu.Lock()
		c.abortCancel = nil
		c.abortMu.Unlock()
	}()

	ctx = WithProviderNetworkMetadata(ctx, ProviderNetworkMetadata{
		Provider:  activeProviderConfig.Provider,
		Model:     activeProviderConfig.Model,
		SessionID: input.SessionID,
		RunID:     input.RunID,
	})
	ctx = WithProviderNetworkObserver(ctx, func(event ProviderNetworkEvent) {
		c.events.Emit(Event{
			Type:      EventType(event.Type),
			SessionID: input.SessionID,
			Payload:   event.Payload(),
		})
	})

	// --- HELPERS (Closures for UI communication) ---

	var totalToolCount int
	var totalTokenCount int
	taskFiles := make(map[string]bool)
	var accumulatedSteps []string
	var taskSummary string
	var protocolMode string
	var latestTodoView *protocol.TodoView
	var checklistSource string
	stepCounter := 0
	progressCounter := 0

	// Extract initial task name from user input
	dynamicTaskName := "Agent activity"
	if input.Content != "" {
		dynamicTaskName = input.Content
		if len(dynamicTaskName) > 60 {
			dynamicTaskName = dynamicTaskName[:60] + "..."
		}
		if idx := strings.Index(dynamicTaskName, "\n"); idx > 0 {
			dynamicTaskName = dynamicTaskName[:idx]
		}
	}

	inferProgressEvent := func(status string, toolCount int, result string) string {
		lowerStatus := strings.ToLower(strings.TrimSpace(status))
		switch {
		case result == "COMPLETED":
			return "completed"
		case result == "ERROR" || strings.Contains(lowerStatus, "error") || strings.Contains(lowerStatus, "failed"):
			return "error"
		case strings.Contains(lowerStatus, "waiting for approval") || strings.Contains(lowerStatus, "approval received"):
			return "approval"
		case strings.HasPrefix(lowerStatus, "running tool "):
			return "tool"
		case toolCount > 0:
			return "tool_result"
		default:
			return "phase"
		}
	}
	shouldAccumulateTaskStep := func(event string, status string) bool {
		lowerStatus := strings.ToLower(strings.TrimSpace(status))
		if status == "" {
			return false
		}
		switch event {
		case "tool", "tool_result", "approval", "completed", "error":
			return false
		}
		if strings.HasPrefix(lowerStatus, "read file ") ||
			strings.HasPrefix(lowerStatus, "list directory ") ||
			strings.HasPrefix(lowerStatus, "write to file ") ||
			strings.HasPrefix(lowerStatus, "edit file ") ||
			strings.HasPrefix(lowerStatus, "edited ") ||
			strings.HasPrefix(lowerStatus, "run command:") ||
			strings.HasPrefix(lowerStatus, "search for ") ||
			strings.HasPrefix(lowerStatus, "semantic search:") ||
			strings.HasPrefix(lowerStatus, "search web:") ||
			strings.HasPrefix(lowerStatus, "waiting for approval") ||
			strings.HasPrefix(lowerStatus, "approval received") {
			return false
		}
		return true
	}

	// Helper to emit task progress with step accumulation
	emitTaskProgressEvent := func(event string, status string, newFiles []string, toolCount int, tokenCount int, result string) {
		progressCounter++
		totalToolCount += toolCount
		totalTokenCount += tokenCount
		if event == "" {
			event = inferProgressEvent(status, toolCount, result)
		}
		for _, f := range newFiles {
			taskFiles[f] = true
		}
		var fileList []string
		for f := range taskFiles {
			fileList = append(fileList, f)
		}
		if shouldAccumulateTaskStep(event, status) && (len(accumulatedSteps) == 0 || accumulatedSteps[len(accumulatedSteps)-1] != status) {
			stepCounter++
			accumulatedSteps = append(accumulatedSteps, status)
		}
		if len(fileList) > 0 {
			taskSummary = fmt.Sprintf("Edited %d file(s)", len(fileList))
		} else if event == "phase" && status != "" {
			taskSummary = status
		} else if taskSummary == "" {
			taskSummary = "Working"
		}

		protocolMode = "execution"
		switch c.modes.GetActiveMode().Slug {
		case "architect":
			protocolMode = "planning"
		case "code":
			protocolMode = "execution"
		case "test":
			protocolMode = "verification"
		}

		lowerStatus := strings.ToLower(status)
		isActiveProgress := result != "COMPLETED" && result != "ERROR" && !strings.Contains(lowerStatus, "waiting for approval")
		completedAt := int64(0)
		if result == "COMPLETED" || result == "ERROR" || event == "completed" || event == "error" {
			completedAt = time.Now().UnixMilli()
		}
		progressTodos := []protocol.Todo(nil)
		if progressSession := c.GetSession(input.SessionID); progressSession != nil && len(progressSession.Todos) > 0 {
			progressTodos = append(progressTodos, progressSession.Todos...)
		}
		progressTodoView := latestTodoView
		progressChecklistSource := checklistSource
		if len(progressTodos) > 0 {
			progressChecklistSource = "todo"
		}

		progress := protocol.TaskProgress{
			SessionID:       input.SessionID,
			RunID:           input.RunID,
			TurnID:          input.RunID,
			Sequence:        int64(progressCounter),
			SegmentID:       fmt.Sprintf("%s-progress-%d", input.RunID, progressCounter),
			Event:           event,
			TaskName:        dynamicTaskName,
			Status:          status,
			Summary:         taskSummary,
			Steps:           accumulatedSteps,
			Files:           fileList,
			Todos:           progressTodos,
			TodoView:        progressTodoView,
			ChecklistSource: progressChecklistSource,
			IsActive:        isActiveProgress,
			CompletedAt:     completedAt,
			Mode:            protocolMode,
			ToolCount:       totalToolCount,
			TokenCount:      totalTokenCount,
			Result:          result,
		}

		if cwd, err := os.Getwd(); err == nil {
			_ = persistTaskProgressDebugFile(cwd, status, taskSummary, accumulatedSteps)
		}

		callback(progress)
	}
	emitTaskProgress := func(status string, newFiles []string, toolCount int, tokenCount int, result string) {
		emitTaskProgressEvent("", status, newFiles, toolCount, tokenCount, result)
	}
	emitProvisionalTaskPlan := func() {
		milestones := provisionalMilestonesForRequest(input.Content)
		if len(milestones) == 0 {
			return
		}
		progressCounter++
		checklistSource = "provisional"
		accumulatedSteps = append([]string(nil), milestones...)
		taskSummary = "Planning task"
		protocolMode = "planning"
		progress := protocol.TaskProgress{
			SessionID:       input.SessionID,
			RunID:           input.RunID,
			TurnID:          input.RunID,
			Sequence:        int64(progressCounter),
			SegmentID:       fmt.Sprintf("%s-provisional-plan", input.RunID),
			Event:           "provisional_plan",
			TaskName:        dynamicTaskName,
			Status:          provisionalStatusForRequest(input.Content),
			Summary:         taskSummary,
			Steps:           accumulatedSteps,
			ChecklistSource: "provisional",
			IsActive:        true,
			Mode:            protocolMode,
			ToolCount:       totalToolCount,
			TokenCount:      totalTokenCount,
		}
		callback(progress)
	}

	// Helper to emit chat updates matches the callback signature
	emitUpdate := func(msg ChatMessage) {
		if msg.RunID == "" {
			msg.RunID = input.RunID
		}
		callback(ChatUpdate{
			SessionID: msg.SessionID,
			RunID:     msg.RunID,
			Message:   &msg,
		})
	}

	// Inject Session ID into context for tools (e.g. SubtaskTool)
	ctx = protocol.WithSessionID(ctx, input.SessionID)
	ctx = protocol.WithRunID(ctx, input.RunID)
	// Inject Callback for subtask event forwarding
	ctx = context.WithValue(ctx, "chat_callback", callback)

	session := c.GetSession(input.SessionID)
	if session == nil {
		return fmt.Errorf("session '%s' not found. Type /new to start.", input.SessionID)
	}

	// TRIGGER: TaskCreated hook (Phase 0: Request Validation)
	if c.dynamicHooks != nil {
		createdArgs := map[string]interface{}{
			"prompt": input.Content,
			"mode":   input.PlanMode,
		}
		warnMsg, err := c.dynamicHooks.TriggerHooks(ctx, hooks.EventTaskCreated, createdArgs)
		if err != nil {
			// If TaskCreated blocks, we terminate immediately
			callback(ChatUpdate{
				SessionID: input.SessionID,
				Message: &ChatMessage{
					ID:        "veto-" + input.SessionID,
					Role:      "assistant",
					Content:   fmt.Sprintf("🛑 **Task Rejected by Policy Hook**\n\n%v", err),
					Timestamp: time.Now().UnixMilli(),
				},
			})
			return err
		}
		if warnMsg != "" {
			log.Printf("⚠️ TaskCreated Hook Warning: %s", warnMsg)
		}
	}

	// Add user message if content provided
	if input.Content != "" {
		if c.skills != nil {
			c.skills.ClearSkillScope(session.ID)
		}
		// 1. Prepare Session (Phase 1 & 2)
		// New session check deleted - Plan Mode constraints now injected directly into systemPrompt

		// SLASH COMMAND INTERCEPTION
		if strings.HasPrefix(input.Content, "/") {
			// 1. Model Switching: /model
			if strings.HasPrefix(input.Content, "/model") {
				args := strings.TrimSpace(strings.TrimPrefix(input.Content, "/model"))
				if args == "" {
					// List available models
					available := c.providersManager.GetAvailableProviders()
					var sb strings.Builder
					sb.WriteString("### 🤖 Available Models\n\n")
					for _, p := range available {
						icon := "🔹"
						if p.Available {
							icon = "✅"
						} else if p.HasKey {
							icon = "🔑"
						}
						sb.WriteString(fmt.Sprintf("%s **%s** (%s)\n", icon, p.Name, p.ID))
						for _, m := range p.Models {
							current := ""
							c.mu.RLock()
							if p.ID == c.config.Provider.Provider && m.ID == c.config.Provider.Model {
								current = " (current)"
							}
							c.mu.RUnlock()
							sb.WriteString(fmt.Sprintf("  - `%s:%s`%s\n", p.ID, m.ID, current))
						}
						sb.WriteString("\n")
					}
					sb.WriteString("**Usage**: `/model provider:model` (e.g. `/model anthropic:claude-3-5-sonnet`)")

					callback(ChatUpdate{
						SessionID: input.SessionID,
						Message: &ChatMessage{
							ID:        uuid.New().String(),
							Role:      "assistant",
							Content:   sb.String(),
							Timestamp: time.Now().UnixMilli(),
						},
					})
					return nil
				}

				// Switch model
				parts := strings.Split(args, ":")
				if len(parts) != 2 {
					callback(ChatUpdate{
						SessionID: input.SessionID,
						Message: &ChatMessage{
							ID:        uuid.New().String(),
							Role:      "assistant",
							Content:   "❌ Invalid format. Use: `/model provider:model`",
							Timestamp: time.Now().UnixMilli(),
						},
					})
					return nil
				}

				providerID := parts[0]
				modelID := parts[1]

				// Validate and get key
				apiKey := c.providersManager.GetAPIKey(providerID)
				if apiKey == "" {
					callback(ChatUpdate{
						SessionID: input.SessionID,
						Message: &ChatMessage{
							ID:        uuid.New().String(),
							Role:      "assistant",
							Content:   fmt.Sprintf("❌ No API key found for provider '%s'. Please configure it in settings or .env.", providerID),
							Timestamp: time.Now().UnixMilli(),
						},
					})
					return nil
				}

				// Re-initialize provider
				newConfig := ProviderConfig{
					Provider: providerID,
					Model:    modelID,
					APIKey:   apiKey,
					BaseURL:  c.providersManager.GetBaseURL(providerID),
				}

				newProvider, err := NewProvider(newConfig)
				if err != nil {
					callback(ChatUpdate{
						SessionID: input.SessionID,
						Message: &ChatMessage{
							ID:        uuid.New().String(),
							Role:      "assistant",
							Content:   fmt.Sprintf("❌ Failed to initialize provider: %v", err),
							Timestamp: time.Now().UnixMilli(),
						},
					})
					return nil
				}

				// Hot-swap
				c.mu.Lock()
				c.provider = newProvider
				c.config.Provider = newConfig
				c.defaultModel = modelID
				c.mu.Unlock()

				callback(ChatUpdate{
					SessionID: input.SessionID,
					Message: &ChatMessage{
						ID:        uuid.New().String(),
						Role:      "assistant",
						Content:   fmt.Sprintf("✅ Switched to **%s** (`%s`)", newProvider.Name(), modelID),
						Timestamp: time.Now().UnixMilli(),
					},
				})
				return nil
			}

			// 2. Plan→Code Handover: /implement
			if input.Content == "/implement" || strings.HasPrefix(input.Content, "/implement ") {
				go func() {
					callback(ChatUpdate{
						SessionID: input.SessionID,
						Message: &ChatMessage{
							ID:        uuid.New().String(),
							Role:      "assistant",
							Content:   "🔄 Generating implementation handover from planning session...",
							Timestamp: time.Now().UnixMilli(),
						},
					})

					err := c.ImplementPlan(ctx, input.SessionID, func(update interface{}) {
						callback(update)
					})
					if err != nil {
						callback(ChatUpdate{
							SessionID: input.SessionID,
							Message: &ChatMessage{
								ID:        uuid.New().String(),
								Role:      "assistant",
								Content:   fmt.Sprintf("❌ Handover failed: %v", err),
								Timestamp: time.Now().UnixMilli(),
							},
						})
					}
				}()
				return nil
			}

			cmdParts := strings.Split(input.Content, " ")
			cmdName := cmdParts[0]

			if c.workflows != nil {
				if wf, ok := c.workflows.GetWorkflow(cmdName); ok {
					go func() {
						// Notify workflow start
						callback(ChatUpdate{
							SessionID: input.SessionID,
							Message: &ChatMessage{
								ID:        uuid.New().String(),
								Role:      "assistant", // System?
								Content:   fmt.Sprintf("🚀 Starting workflow: **%s**...", wf.Description),
								Timestamp: time.Now().UnixMilli(),
							},
						})

						// Execute Workflow
						def := workflow.WorkflowDefinition{
							Name:        wf.Command,
							Description: wf.Description,
							Steps:       wf.Steps,
						}
						res, err := c.workflowEngine.Execute(ctx, def, map[string]interface{}{
							"input": strings.TrimSpace(strings.TrimPrefix(input.Content, cmdName)),
						})

						if err != nil {
							callback(ChatUpdate{
								SessionID: input.SessionID,
								Message: &ChatMessage{
									ID:        uuid.New().String(),
									Role:      "assistant",
									Content:   fmt.Sprintf("❌ Workflow failed: %v", err),
									Timestamp: time.Now().UnixMilli(),
								},
							})
							return
						}

						// Summarize results
						summary := "### Workflow Completed\n"
						for _, step := range res.History {
							icon := "✅"
							if step.Status == "failed" {
								icon = "❌"
							}
							summary += fmt.Sprintf("- %s **%s**: %s\n", icon, step.StepID, truncateString(step.Output, 100))
						}

						callback(ChatUpdate{
							SessionID: input.SessionID,
							RunID:     input.RunID,
							Message: &ChatMessage{
								ID:        uuid.New().String(),
								Role:      "assistant",
								Content:   summary,
								Timestamp: time.Now().UnixMilli(),
								RunID:     input.RunID,
							},
						})
					}()
					return nil // Early return, handled by goroutine
				}
			}
		}

		// ─── SMART INJECTIONS (Phase 17) ───
		expandedContent, infoMsgs := c.injectionProcessor.Process(input.Content)
		if attachedContext := c.buildContextFileAttachmentContext(input.Content, input.ContextFiles); attachedContext != "" {
			expandedContent += attachedContext
		}
		for _, msg := range infoMsgs {
			callback(ChatUpdate{
				SessionID: input.SessionID,
				RunID:     input.RunID,
				Message: &ChatMessage{
					ID:        uuid.New().String(),
					Role:      "assistant", // informational
					Content:   msg,
					Timestamp: time.Now().UnixMilli(),
					RunID:     input.RunID,
				},
			})
		}

		userMsg := protocol.Message{
			ID:      uuid.New().String(),
			Role:    "user",
			Content: expandedContent,
			Via:     input.Via,
		}

		session.StateHandler.AddMessage(userMsg)
		// Confirmation to UI (prevents optimistic message disappearance)
		emitUpdate(ChatMessage{
			ID:        userMsg.ID,
			Role:      "user",
			Content:   userMsg.Content,
			Timestamp: time.Now().UnixMilli(),
			Via:       userMsg.Via,
			RunID:     input.RunID,
		})

		if isComplexTaskRequest(input.Content) {
			emitProvisionalTaskPlan()
		}
	}

	// REMOVED: Redundant variable and helper definitions (moved to the top)

	// REMOVED: Unconditional "Starting..." task emission.
	// This prevents simple chats ("Hi") from creating a task tree node.
	// Real tasks will trigger progress updates via tools or specific logic steps.

	// MAX TURNS to prevent infinite loops
	maxTurns := 50
	if input.MaxTurns > 0 && input.MaxTurns < maxTurns {
		maxTurns = input.MaxTurns
	}
	currentTurn := 0
	stuckCounter := 0 // Counter for consecutive Loop Rule B errors (hard stop after 5)

	// Usage tracking
	var totalTokensIn int
	var totalTokensOut int

	for currentTurn < maxTurns {
		// Check for context cancellation (abortion)
		if ctx.Err() != nil {
			log.Printf("[Agent] Chat loop aborted: %v", ctx.Err())
			return ctx.Err()
		}
		currentTurn++
		turnID := fmt.Sprintf("%s-turn-%d", input.RunID, currentTurn)
		assistantMsgID := uuid.New().String()
		assistantMsg := ChatMessage{
			ID:          assistantMsgID,
			Role:        "assistant",
			Content:     "",
			Timestamp:   time.Now().UnixMilli(),
			IsStreaming: true,
			RunID:       input.RunID,
			TurnID:      turnID,
			Sequence:    int64(currentTurn),
			SegmentID:   turnID + "-assistant",
			Metadata: &TaskMetadata{
				TokensIn:     totalTokensIn,
				TokensOut:    totalTokensOut,
				TotalCost:    0,
				ContextLimit: c.config.MaxTokens,
			},
		}
		emitUpdate(assistantMsg)

		// 2. BUILD PROMPT (Sprint 3.0: Persistent Intelligence)
		activeMode := c.modes.GetActiveMode()
		systemPrompt := c.config.SystemPrompt
		simpleFastPath := isSimpleFastPathRequest(input.Content)

		// 1.5 DRAIN ETHER EVENTS (The Ether Bridge)
		etherEvents := ether.Get().Drain(input.SessionID)
		if len(etherEvents) > 0 {
			var sb strings.Builder
			sb.WriteString("\n\n[ETHER CONTEXT — events that occurred since the last turn]\n")
			for _, e := range etherEvents {
				sb.WriteString(fmt.Sprintf("- [%s] %s: %s\n", e.Timestamp.Format("15:04:05"), e.Type, e.Content))
			}
			// Inject into system prompt so it survives condensation and provides immediate context
			systemPrompt += sb.String()
			log.Printf("[Ether] Injected %d events into session %s", len(etherEvents), input.SessionID)
		}

		// Inject Active Mode role instructions
		systemPrompt += "\n\n" + activeMode.RoleDefinition + "\n" + activeMode.CustomInstructions
		if simpleFastPath {
			systemPrompt += "\n\n[SIMPLE WORK RUNTIME MODE]\nThis user request is classified as a simple bounded edit or direct action. Planning tools are unavailable. Do the smallest concrete action now: read the target file if needed, use replace_file_content for existing files or write_file for new files, then stop with a brief result. Do not ask for plan approval."
		}

		// Inject Global Custom Instructions (User Preferences)
		if c.config.CustomInstructions != "" {
			systemPrompt += "\n\n[USER CUSTOM INSTRUCTIONS]\n" + c.config.CustomInstructions
		}

		// Inject Plan Mode constraints if requested
		if input.PlanMode {
			systemPrompt += "\n\n[PLAN MODE CONSTRAINT]\nYou are in read-only mode for exploration and planning. You can use search and read tools, but avoid making any file changes or executing destructive commands. When the user asks for an implementation plan or plan of work, finish by calling submit_plan with the full markdown plan. Do not use write_file for implementation plans. Do not create Hub tasks with create_task/add_subtask/update_plan unless the user explicitly asks to create tasks or has chosen a Create tasks action."
		}

		// Inject Persistent Intelligence (Agent Lessons - Sprint 5.0 RAG)
		if c.intelligenceManager != nil {
			// Perform semantic retrieval based on current user query
			systemPrompt += "\n\n" + c.intelligenceManager.GetRelevantSystemPromptPart(ctx, input.Content)
		}

		// Inject Current Task context
		if c.planManager != nil {
			systemPrompt += c.planManager.GenerateContext()
		}

		// Prepare Tools config for provider
		defs := c.executor.GetDefinitions()
		var providerTools []protocol.Tool
		for _, d := range defs {
			if simpleFastPath && isSimpleFastPathPlanningTool(d.Name) {
				continue
			}
			if modes.IsToolAllowed(activeMode, d.Name) {
				providerTools = append(providerTools, protocol.Tool{
					Name:        d.Name,
					Description: d.Description,
					InputSchema: d.InputSchema,
				})
			}
		}

		// ─── CONTEXT WINDOW MANAGEMENT (The Tengu Effect) (Phase 1) ───
		// Manage context window (condensation + sliding window)
		// Use ContextWindow for pruning, not MaxTokens (response limit)
		contextLimit := c.config.ContextWindow
		if contextLimit <= 0 {
			contextLimit = 128000 // Default to 128k if not set
		}

		// Initialize Condense Adapter (Reflex Engine)
		condenseProvider := &condenseAdapter{
			p:     activeProvider,
			model: activeProviderConfig.Model,
		}

		// Configure Smart Context settings
		contextConfig := c.config.Context
		if contextConfig.CondenseThreshold <= 0 && contextConfig.SlidingWindowSize <= 0 && !contextConfig.AutoCondense && !contextConfig.ShowContextIndicator {
			contextConfig.AutoCondense = true
			contextConfig.ShowContextIndicator = true
		}
		if contextConfig.CondenseThreshold <= 0 {
			contextConfig.CondenseThreshold = 70
		}
		if contextConfig.SlidingWindowSize <= 0 {
			contextConfig.SlidingWindowSize = 20
		}
		ctxSettings := &context_manager.ContextSettings{
			AutoCondense:         contextConfig.AutoCondense,
			CondenseThreshold:    contextConfig.CondenseThreshold,
			SlidingWindowSize:    contextConfig.SlidingWindowSize,
			ShowContextIndicator: contextConfig.ShowContextIndicator,
			MaxFragmentTokens:    contextConfig.MaxFragmentTokens,
			ShowContributorPanel: contextConfig.ShowContributorPanel,
		}

		// Diagnostics
		currentMessages := session.StateHandler.GetMessages()
		log.Printf("[Agent] Starting context management. Limit: %d, WindowSize: %d, Msgs: %d, Provider: %s",
			contextLimit, c.config.ContextWindow, len(currentMessages), activeProviderConfig.Provider)

		// Create/Update WindowManager with settings and provider
		wm := context_manager.NewWindowManagerWithSettings(contextLimit, ctxSettings, condenseProvider)

		// HELP AGENT INTERCEPTION
		currentSystemPrompt := systemPrompt
		if c.helpAgent != nil && c.helpAgent.IsHelpQuery(input.Content) {
			currentSystemPrompt = c.helpAgent.GetSystemPrompt()
			log.Printf("🤖 Help Agent Activated for query: %s", input.Content)
		}

		contextResult, err := wm.ManageContext(ctx, currentMessages, currentSystemPrompt)
		if err != nil {
			log.Printf("[Agent] Warning: Context management failed: %v", err)
			contextResult = &context_manager.ContextResult{
				Messages:     currentMessages,
				SystemPrompt: currentSystemPrompt,
			}
		}

		// Update state with managed context
		session.StateHandler.SetMessages(contextResult.Messages)
		currentMessages = contextResult.Messages
		systemPrompt = contextResult.SystemPrompt // Potentially updated by condensation
		if contextResult.WasCondensed || contextResult.WasTruncated {
			eventName := "context_truncated"
			if contextResult.WasCondensed {
				eventName = "context_condensed"
			}
			compactionEvent := &protocol.ContextCompactionEvent{
				SessionID:      input.SessionID,
				RunID:          input.RunID,
				Event:          eventName,
				TokensBefore:   contextResult.TokensBefore,
				TokensAfter:    contextResult.TokensUsed,
				TokensMax:      contextResult.TokensMax,
				Percentage:     contextResult.Percentage,
				Summary:        contextResult.Summary,
				PreservedItems: session.FileTracker.GetRecentFiles(20),
				ActiveCommands: context_manager.ExtractActiveCommandBlocks(contextResult.Messages),
				Timestamp:      time.Now().UnixMilli(),
			}
			c.rememberContextCompaction(compactionEvent)
			callback(*compactionEvent)
			if contextResult.Summary != "" {
				_ = appendSessionMemory(c.cwd, input.SessionID, input.RunID, eventName, contextResult.Summary)
			}
		}

		if contextResult.WasCondensed {
			// Notify frontend
			callback(ChatUpdate{
				SessionID: input.SessionID,
				Message: &ChatMessage{
					ID:        uuid.New().String(),
					Role:      "system",
					Content:   "**Context Compacted**: History summarized via Reflex Engine to save tokens.",
					Timestamp: time.Now().UnixMilli(),
				},
			})
		}

		// Inject CodeGraph Repo Map if available (Repo Intelligence)
		// We insert it as a User message at the very beginning of HISTORY (or strictly after System Prompt).
		// Since we handle contextResult.Messages which are the messages sent to LLM,
		// we can prepend a User message if it's the first turn or if we want it persistent.
		// However, context manager might have pruned.
		// A better strategy is to append it to the System Prompt, or use a "Developer" role message if supported.
		// Let's modify System Prompt for this turn.

		finalSystemPrompt := contextResult.SystemPrompt
		if c.codegraph != nil {
			// Limit size: 5% of context window or max 100 files
			repoMap := c.codegraph.GenerateRepoMap(100)
			if repoMap != "" {
				finalSystemPrompt += "\n\n" + repoMap + "\n\n(This repository map is auto-generated based on Code Graph PageRank analysis)"
			}
		}
		if folded := context_manager.BuildFoldedFileContext(ctx, c.cwd, session.FileTracker.GetRecentFiles(12), 20000); folded.Content != "" {
			finalSystemPrompt += "\n\n### Folded Recently Read File Context\n" + folded.Content + "\n\n(These are compact signatures/imports for recently read files; read exact line ranges before editing.)"
		}

		// Build request
		// Build request with enhanced context including Active Mode and Project Rules
		// activeMode retrieved earlier
		modePrompt := fmt.Sprintf("\n\n### Current Mode: %s\n%s\n%s",
			activeMode.Name,
			activeMode.RoleDefinition,
			activeMode.CustomInstructions)

		activeFiles := session.FileTracker.GetFiles()
		rulesContext := c.rules.GetScopedInstructions(activeFiles) + c.rules.GetRulesForFiles(activeFiles)

		// Skill Injection (Hardcore Workflow)
		var skillContext string
		if c.skills != nil && input.Content != "" {
			// Gather active files from trackers
			activeFiles := session.FileTracker.GetFiles()

			matchedSkills := c.skills.FindApplicableSkills(input.Content, activeFiles)
			if len(matchedSkills) > 0 {
				var sb strings.Builder
				sb.WriteString("\n\n### 🧠 Active Skills (Auto-Activated)\n")
				for _, skill := range matchedSkills {
					sb.WriteString(fmt.Sprintf("#### Skill: %s (%s)\n%s\n\n", skill.Name, skill.Enforcement, skill.Content))
				}
				skillContext = sb.String()
				log.Printf("🧠 Skills Activated: %d skills injected into context", len(matchedSkills))
			}
		}

		// Combine system prompt parts (Base + Mode + Rules + Skills + RepoMap if any)
		// Usually Controller logic appends to c.config.SystemPrompt,
		// but here finalSystemPrompt already has repoMap if any.
		// Let's ensure we merge correctly.
		// If Repomap was appended to finalSystemPrompt, we should use that base.

		// Re-construct system prompt to be safe and ordered
		// Inject project-specific memory if available (Phase 15)
		memoryContext := c.memoryManager.GetSystemPromptPart()

		// Inject Persistent Intelligence (Sprint 3.0 Lessons)
		intelContext := c.intelligenceManager.GetSystemPromptPart()

		memoryContext += intelContext

		// Inject Plan Context (Autonomous Agent)
		planContext := c.planManager.GenerateContext()

		// ─── ELEGANT DELEGATION: Coordinator/Worker Context ───
		var delegationContext string
		if input.Via == "subtask" {
			delegationContext = "\n\n### 👷 YOUR ROLE: Worker Agent\n" +
				"You are a specialized worker focused on a specific sub-task. " +
				"Focus completely on your goal. Use the shared scratchpad below to report findings or read instructions from other agents.\n"
		} else {
			delegationContext = "\n\n### 🎓 YOUR ROLE: Coordinator Agent\n" +
				"You are orchestrating complex tasks across multiple workers. Your job is to:\n" +
				"- Synthesis findings from workers into a coherent plan.\n" +
				"- Choose between 'subagent' tool (spawn fresh context) or 'send_message' (continue existing context) for follow-ups.\n" +
				"- Use the 'subagent' tool to parallelize long-running research or implementation.\n" +
				"- Synthesize worker outputs before reporting to the user.\n"
		}

		// Inject Shared Scratchpad
		delegationContext += "\n" + c.scratchpad.GetSummary() + "\n"

		// ─── ZERO-TURN AWARENESS: Git Context Injection ───
		gitContext := c.getGitContext()

		// ─── PHASE 4: Session Summary (Distill History) ───
		var summaryContext string
		if contextResult.Summary != "" {
			summaryContext = "\n\n### 📝 SESSION SUMMARY (Pruned History)\n" +
				"The following is a technical summary of the history that was pruned to fit the context window:\n" +
				contextResult.Summary + "\n"
		}

		enhancedSystemPrompt := finalSystemPrompt + modePrompt + memoryContext + rulesContext + skillContext + planContext + delegationContext + gitContext + summaryContext + "\n\n" + c.envTracker.GetContext() + "\n" + session.FileTracker.GetContext()

		// Use contextResult.Messages as prunedMessages
		prunedMessages := contextResult.Messages

		// SAFETY: Sanitize messages to ensure Tool Call/Result integrity
		// This prevents API 400 errors if a previous session crashed/was pruned incorrectly
		prunedMessages = c.sanitizeMessages(prunedMessages, activeProviderConfig.Model)

		// =============================
		// EPHEMERAL MESSAGE INJECTION
		// =============================
		// Normalize mode name for ephemeral messages
		normalizedMode := normalizeModeName(activeMode.Name)

		// Detect if we're in task mode (basic heuristic: has todos or artifacts)
		isInTaskMode := len(session.Todos) > 0

		// TODO: Detect artifacts by checking for task.md, implementation_plan.md, etc.
		// TODO: Track tool failures across turns
		// TODO: Detect if plan exists

		// Build dynamic context for ephemeral reminders
		ephemeralCtx := prompts.EphemeralContext{
			Mode:             normalizedMode,
			IsInTaskMode:     isInTaskMode,
			ToolCallCount:    0, // Will be tracked in future turns
			HasPlan:          false,
			LastToolFailed:   false,
			ArtifactsCreated: []string{},
			SessionID:        input.SessionID,
			WorkspaceRoot:    c.cwd,
		}

		ephemeralMsg := prompts.BuildEphemeralMessage(ephemeralCtx)
		if ephemeralMsg != "" {
			// Inject into final user message if it's already a user message, otherwise append
			numMsgs := len(prunedMessages)
			if numMsgs > 0 && prunedMessages[numMsgs-1].Role == "user" {
				// To preserve original content, we wrap it in a readable format
				originalContent := prunedMessages[numMsgs-1].Content
				prunedMessages[numMsgs-1].Content = originalContent + "\n\n" + ephemeralMsg
				log.Printf("📨 Ephemeral message merged into last user message (mode=%s)", normalizedMode)
			} else {
				// Fallback to append if history is empty or ends with assistant message
				prunedMessages = append(prunedMessages, protocol.Message{
					Role:    "user",
					Content: ephemeralMsg,
				})
				log.Printf("📨 Ephemeral message appended (mode=%s)", normalizedMode)
			}
		}

		req := &ChatRequest{
			Model:        activeProviderConfig.Model,
			Messages:     prunedMessages,
			SystemPrompt: enhancedSystemPrompt,
			MaxTokens:    activeProviderConfig.MaxTokens,
			Temperature:  activeProviderConfig.Temperature,
			TopP:         activeProviderConfig.TopP,
			Tools:        providerTools,
		}

		// Calculate Input Tokens (Prompt) - Heuristic: len / 4
		promptTokens := len(enhancedSystemPrompt) / 4
		for _, m := range prunedMessages {
			promptTokens += len(m.Content) / 4
		}
		totalTokensIn += promptTokens

		// Log context status
		statusEmoji := ""
		if contextResult.WasCondensed {
			statusEmoji = " 📦"
		} else if contextResult.WasTruncated {
			statusEmoji = " ✂️"
		}
		log.Printf("Context: %.1f%% (%d/%d tokens, %d msgs)%s",
			contextResult.Percentage, contextResult.TokensUsed, contextResult.TokensMax, len(prunedMessages), statusEmoji)

		// Emit context status to frontend (No message sent here, allowing omitempty to skip it)
		contextStatus := c.contextStatusFromResult(input.SessionID, input.RunID, contextResult, session.TotalCost)
		callback(ChatUpdate{
			SessionID:     input.SessionID,
			RunID:         input.RunID,
			ContextStatus: contextStatus,
		})

		var currentTurnContent string
		var currentTurnReasoning string // Track reasoning separately for DeepSeek R1
		var currentTurnToolCalls []ToolCallInfo
		var actualUsage Usage
		var turnTokensOut int

		// Throttling for streaming updates to prevent webview crash
		var lastEmitTime time.Time
		const streamThrottleInterval = 50 * time.Millisecond
		var firstChunk = true

		// LOOP PREVENTION: Content deduplication and reasoning limits
		var lastEmittedContentLen int
		var reasoningChunkCount int
		const maxReasoningChunks = 1000 // Hardened limit (reduced from 2000)
		var consecutiveEmptyDeltas int
		const maxEmptyDeltas = 10

		var lastReasoningDelta string
		var consecutiveIdenticalReasoningDeltas int

		// Stream response from AI using standard ChatStream
		// We use prunedMessages (from context management) instead of session messages
		err = activeProvider.ChatStream(ctx, req, func(chunk *StreamChunk) error {
			switch chunk.Type {
			case "usage":
				if chunk.Usage != nil {
					actualUsage = mergeUsage(actualUsage, *chunk.Usage)
				}
			case "content_block_delta":
				// LOOP PREVENTION: Check for empty delta spam
				if len(chunk.Delta) == 0 {
					consecutiveEmptyDeltas++
					if consecutiveEmptyDeltas > maxEmptyDeltas {
						log.Printf("⚠️ Too many empty deltas (%d), possible loop detected", consecutiveEmptyDeltas)
						return nil // Skip but don't error
					}
				} else {
					consecutiveEmptyDeltas = 0 // Reset counter
				}

				currentTurnContent += chunk.Delta
				assistantMsg.Content += chunk.Delta
				assistantMsg.IsStreaming = true

				// Accumulate reasoning separately for DeepSeek R1 tool call support
				if chunk.ReasoningDelta != "" {
					// STUTTER DETECTION: Prevent character/token repetition loops
					if chunk.ReasoningDelta == lastReasoningDelta && len(chunk.ReasoningDelta) > 0 {
						consecutiveIdenticalReasoningDeltas++
					} else {
						consecutiveIdenticalReasoningDeltas = 0
					}
					lastReasoningDelta = chunk.ReasoningDelta

					if consecutiveIdenticalReasoningDeltas > 50 {
						log.Printf("⚠️ Stutter loop detected in reasoning, forcing completion")
						return fmt.Errorf("reasoning stutter detected - model is stuck in a repetitive loop")
					}

					currentTurnReasoning += chunk.ReasoningDelta
					assistantMsg.Reasoning += chunk.ReasoningDelta
					reasoningChunkCount++

					// LOOP PREVENTION: Max reasoning guard
					if reasoningChunkCount > maxReasoningChunks {
						log.Printf("⚠️ Max reasoning chunks exceeded (%d), forcing completion", reasoningChunkCount)
						return fmt.Errorf("reasoning limit exceeded - agent may be stuck in thought loop")
					}
				}

				// Update Output Tokens - Heuristic
				deltaTokens := len(chunk.Delta) / 4
				if deltaTokens < 1 && len(chunk.Delta) > 0 {
					deltaTokens = 1
				}
				turnTokensOut += deltaTokens
				totalTokensOut += deltaTokens
				assistantMsg.Metadata.TokensOut = totalTokensOut
				if c.usageTracker != nil {
					assistantMsg.Metadata.TotalCost = c.usageTracker.CalculateCost(activeProviderConfig.Provider, activeProviderConfig.Model, totalTokensIn, totalTokensOut, 0)
				}

				// Only visible assistant content should stream into the transcript.
				// Reasoning is kept for protocol/tool-call continuity, but it is not a
				// user-facing chat message by itself.
				now := time.Now()
				isReasoningTag := strings.Contains(chunk.Delta, "<thinking>") || strings.Contains(chunk.Delta, "</thinking>")
				shouldEmit := firstChunk || isReasoningTag || now.Sub(lastEmitTime) >= streamThrottleInterval

				// LOOP PREVENTION: Only emit if visible content actually changed.
				contentChanged := len(assistantMsg.Content) > lastEmittedContentLen

				if shouldEmit && contentChanged {
					emitUpdate(assistantMsg)
					lastEmitTime = now
					lastEmittedContentLen = len(assistantMsg.Content)
					firstChunk = false
				}

			case "tool_use":
				if chunk.ToolUse != nil {
					tc := ToolCallInfo{
						ID:        chunk.ToolUse.ID,
						Name:      chunk.ToolUse.Name,
						Arguments: string(chunk.ToolUse.Input),
						Status:    "pending",
						Timestamp: time.Now().UnixMilli(),
					}
					currentTurnToolCalls = append(currentTurnToolCalls, tc)
					assistantMsg.ToolCalls = append(assistantMsg.ToolCalls, tc)
					emitUpdate(assistantMsg)
				}

			case "message_stop", "message_delta":
				assistantMsg.IsStreaming = false
				if strings.TrimSpace(assistantMsg.Content) != "" || len(assistantMsg.ToolCalls) > 0 {
					emitUpdate(assistantMsg)
				}
			}
			return nil
		})

		if err != nil {
			if ctx.Err() == nil && isRetryableNetworkError(err) {
				log.Printf("Streaming interrupted by retryable network error, retrying turn without streaming: %v", err)
				emitTaskProgress("Network stream interrupted. Retrying with stable non-streaming request...", nil, 0, 0, "RUNNING")

				fallbackResp, fallbackErr := activeProvider.Chat(ctx, req)
				if fallbackErr == nil {
					currentTurnContent = fallbackResp.Content
					currentTurnReasoning = ""
					currentTurnToolCalls = nil

					for _, tc := range fallbackResp.ToolCalls {
						currentTurnToolCalls = append(currentTurnToolCalls, ToolCallInfo{
							ID:        tc.ID,
							Name:      tc.Name,
							Arguments: string(tc.Input),
							Status:    "pending",
							Timestamp: time.Now().UnixMilli(),
						})
					}

					actualUsage = fallbackResp.Usage
					if fallbackResp.Usage.OutputTokens > 0 {
						totalTokensOut = totalTokensOut - turnTokensOut + fallbackResp.Usage.OutputTokens
						turnTokensOut = fallbackResp.Usage.OutputTokens
					}
					assistantMsg.Content = fallbackResp.Content
					assistantMsg.Reasoning = ""
					assistantMsg.ToolCalls = currentTurnToolCalls
					assistantMsg.IsStreaming = false
					assistantMsg.Metadata.TokensOut = totalTokensOut
					if c.usageTracker != nil {
						assistantMsg.Metadata.TotalCost = c.usageTracker.CalculateCost(activeProviderConfig.Provider, activeProviderConfig.Model, totalTokensIn, totalTokensOut, actualUsage.CachedInputTokens)
					}
					emitUpdate(assistantMsg)
					err = nil
				} else {
					log.Printf("Stable non-streaming retry failed after stream interruption: %v", fallbackErr)
				}
			}

			if err != nil {
				log.Printf("Streaming error: %v", err)
				friendlyErr := TranslateError(err)
				assistantMsg.Content += "\n\n" + friendlyErr
				assistantMsg.IsStreaming = false
				emitUpdate(assistantMsg)

				// Provide immediate progress feedback for fatal errors
				emitTaskProgress(friendlyErr, nil, 0, 0, "ERROR")

				return err
			}
		}

		usageInput := promptTokens
		usageOutput := turnTokensOut
		usageSource := UsageSourceEstimated
		if actualUsage.InputTokens > 0 || actualUsage.OutputTokens > 0 {
			usageSource = UsageSourceActual
			if actualUsage.InputTokens > 0 {
				totalTokensIn = totalTokensIn - promptTokens + actualUsage.InputTokens
				usageInput = actualUsage.InputTokens
			}
			if actualUsage.OutputTokens > 0 && actualUsage.OutputTokens != turnTokensOut {
				totalTokensOut = totalTokensOut - turnTokensOut + actualUsage.OutputTokens
				usageOutput = actualUsage.OutputTokens
				turnTokensOut = actualUsage.OutputTokens
			}
		}
		if actualUsage.ReasoningOutputTokens == 0 && currentTurnReasoning != "" {
			actualUsage.ReasoningOutputTokens = len(currentTurnReasoning) / 4
		}
		if c.usageTracker != nil {
			operation := UsageOperationChat
			if input.Via == "subtask" {
				operation = UsageOperationWorker
			}
			usageEvent := UsageEvent{
				SessionID:             input.SessionID,
				RunID:                 input.RunID,
				TurnID:                turnID,
				Provider:              activeProviderConfig.Provider,
				Model:                 activeProviderConfig.Model,
				KeySource:             c.usageTracker.KeySource(activeProviderConfig.Provider),
				InputTokens:           usageInput,
				OutputTokens:          usageOutput,
				CachedInputTokens:     actualUsage.CachedInputTokens,
				CacheCreationTokens:   actualUsage.CacheCreationTokens,
				ReasoningOutputTokens: actualUsage.ReasoningOutputTokens,
				ContextTokens:         contextResult.TokensUsed,
				ContextWindow:         contextResult.TokensMax,
				Source:                usageSource,
				Operation:             operation,
				Timestamp:             time.Now().UnixMilli(),
			}
			usageEvent.EstimatedCostUSD = c.usageTracker.CalculateCost(usageEvent.Provider, usageEvent.Model, usageEvent.InputTokens, usageEvent.OutputTokens, usageEvent.CachedInputTokens)
			usageSnapshot := c.usageTracker.Track(usageEvent)
			session.TotalCost = usageSnapshot.EstimatedCostUSD
			assistantMsg.Metadata.TokensIn = totalTokensIn
			assistantMsg.Metadata.TokensOut = totalTokensOut
			assistantMsg.Metadata.TotalCost = usageSnapshot.EstimatedCostUSD
			if strings.TrimSpace(assistantMsg.Content) != "" || len(assistantMsg.ToolCalls) > 0 {
				emitUpdate(assistantMsg)
			}
			callback(ChatUpdate{
				SessionID: input.SessionID,
				RunID:     input.RunID,
				Usage:     &usageSnapshot,
			})
		}

		visibleTurnContent := visibleAssistantContent(currentTurnContent)

		// LOOP DETECTION: Track only public assistant text, not hidden reasoning.
		if c.loopDetector != nil && visibleTurnContent != "" {
			if loopErr := c.loopDetector.CheckContent(visibleTurnContent); loopErr != nil {
				log.Printf("🛑 Behavioral Loop Detected: %v", loopErr)
				emitTaskProgress("Loop warning: repeated narration; changing strategy.", nil, 0, 0, "")
			}
		}

		// Store assistant message for this turn in protocol history
		var storedToolUse []protocol.ToolUseBlock
		for _, tc := range currentTurnToolCalls {
			storedToolUse = append(storedToolUse, protocol.ToolUseBlock{
				ID:    tc.ID,
				Name:  tc.Name,
				Input: json.RawMessage(tc.Arguments),
			})
		}

		session.StateHandler.AddMessage(protocol.Message{
			ID:               assistantMsgID,
			Role:             "assistant",
			Content:          visibleTurnContent,
			ReasoningContent: currentTurnReasoning, // DeepSeek R1 requires this for tool calls
			ToolUse:          storedToolUse,
		})

		// If no tools used, we trigger TaskCompleted hooks (The Veto Loop)
		if len(currentTurnToolCalls) == 0 {
			// FALLBACK: If the agent finished with empty content and no tools, nudge it for a summary.
			// This prevents models from finishing 'silently' with only reasoning.
			if visibleTurnContent == "" && currentTurn < maxTurns {
				// Check if the VERY last message in history was already a nudge
				lastMsgs := session.StateHandler.GetMessages()
				wasLastMessageNudge := false
				if len(lastMsgs) > 0 {
					lastMsg := lastMsgs[len(lastMsgs)-1]
					if lastMsg.Role == "user" && strings.Contains(lastMsg.Content, "Please provide a clear report") {
						wasLastMessageNudge = true
					}
				}

				if wasLastMessageNudge {
					log.Printf("⚠️ Agent already nudged once but still returned empty content. Stopping turn.")
					break
				}

				nudgeMsg := "You have not provided a final summary or result. Please provide a clear report of your findings and complete the task as requested."
				if reasoningChunkCount > 300 {
					log.Printf("⚠️ Agent over-analyzed (%d chunks) with no output. Injecting urgent nudge.", reasoningChunkCount)
					nudgeMsg = "You have spent a significant amount of time 'thinking' without producing any visible output or tool calls. Please stop over-analyzing and immediately provide a concise report of your progress or take the next concrete action to resolve the user's request."
				} else {
					log.Printf("⚠️ Agent finished turn with no content and no tools. Requesting final report...")
				}

				session.StateHandler.AddMessage(protocol.Message{
					ID:      uuid.New().String(),
					Role:    "user",
					Content: nudgeMsg,
				})
				// Signal progress UI
				emitTaskProgress("Requesting final summary...", nil, 0, 0, "")
				continue
			}

			if c.dynamicHooks != nil {
				log.Printf("🧐 Triggering TaskCompleted (Veto Check)...")
				completeArgs := map[string]interface{}{
					"last_assistant_message": visibleTurnContent,
				}
				// Pass session state summary if available
				if len(session.Todos) > 0 {
					completeArgs["todos"] = session.Todos
				}

				warnMsg, vetoErr := c.dynamicHooks.TriggerHooks(ctx, hooks.EventTaskCompleted, completeArgs)
				if vetoErr != nil {
					// VETO! The task is NOT done according to the external script
					log.Printf("🛑 VETO: Task marked as incomplete: %v", vetoErr)

					// Broadbast event to subscribers (Sprint 4.0: Autonomous Channels)
					c.events.Emit(Event{
						Type:      EventVetoed,
						SessionID: input.SessionID,
						Payload: map[string]interface{}{
							"error": vetoErr.Error(),
						},
					})

					// Inject the hook's feedback as a user message to force the agent to continue
					feedback := fmt.Sprintf("⚠️ **Task is incomplete.** Please fix the following issues before finishing:\n\n%v", vetoErr)
					if warnMsg != "" {
						feedback += "\n\n" + warnMsg
					}

					session.StateHandler.AddMessage(protocol.Message{
						ID:      uuid.New().String(),
						Role:    "user",
						Content: feedback,
					})

					// Signal progress UI
					emitTaskProgress("Vetoed: Task still requires work", nil, 0, 0, feedback)

					// CONTINUE the loop instead of breaking
					continue
				}

				if warnMsg != "" {
					log.Printf("⚠️ TaskCompleted Warning: %s", warnMsg)
				}
			}
			if err := appendSessionMemory(c.cwd, session.ID, input.RunID, "assistant_final", visibleTurnContent); err != nil {
				log.Printf("[Memory] failed to append session memory: %v", err)
			}
			break
		}

		// TASK COMPLETE SIGNAL (The Handshake)
		// Only mark the mission complete when the assistant has no tool calls to execute.
		// Tool calls are still part of the same turn, so reporting completion here would
		// make the UI show "Mission Accomplished" before approval and execution.
		if len(currentTurnToolCalls) == 0 {
			emitTaskProgress("Mission Accomplished", nil, 0, 0, "COMPLETED")
		}

		// Initialize QC flag
		runQC := false

		// ─── BATCH TOOL CONFIRMATION (Phase 19) ───
		if len(currentTurnToolCalls) > 0 {
			// ─── PLAN MODE GUARDRAIL: Hard block Write/Execute tools ───
			var blockedResults []protocol.ToolResultBlock
			for _, tc := range currentTurnToolCalls {
				if err := c.validateToolUse(session, tc.Name, tc.Arguments, input.PlanMode); err != nil {
					// Return error to LLM instead of executing - this teaches the agent
					blockedResults = append(blockedResults, protocol.ToolResultBlock{
						ToolUseID: tc.ID,
						Content:   err.Error(),
						IsError:   true,
					})
				}
			}
			// If any tools were blocked, send errors back to LLM and continue to next turn
			if len(blockedResults) > 0 {
				session.StateHandler.AddMessage(protocol.Message{
					ID:          uuid.New().String(),
					Role:        "user",
					ToolResults: blockedResults,
				})
				continue // Go to next turn (AI will see the error and adjust)
			}

			needsApproval := false
			var summary strings.Builder
			summary.WriteString("The agent wants to execute the following tools:\n\n")

			for _, tc := range currentTurnToolCalls {
				if !c.isToolAutoApproved(session, tc, input.PlanMode) {
					needsApproval = true
				}
				summary.WriteString(fmt.Sprintf("• **%s**\n  %s\n", tc.Name, c.formatToolCall(tc)))
			}

			if needsApproval {
				// Set terminal title to show action required
				terminal.SetTerminalTitle(terminal.StateActionRequired)
				// Pause thinking status if we have one
				emitTaskProgress("Waiting for approval...", nil, 0, 0, "")

				choices := []string{
					"Yes",
					"Yes, and don't ask again for this tool",
					"No",
				}

				choiceIdx, err := c.host.AskUserChoice(session.ID, summary.String(), choices)
				if err != nil {
					return fmt.Errorf("approval failed: %w", err)
				}

				// If approved, immediately signal resuming to clear the 'Waiting for approval' UI state
				if choiceIdx == 0 || choiceIdx == 1 {
					c.resetAutoApprovalBudget(session)
					emitTaskProgress("Approval received. Resuming task...", nil, 0, 0, "")
				}

				// 0 = Yes
				// 1 = Yes + Whitelist (runtime only for now)
				// 2 = No

				if choiceIdx == 2 {
					// User denied. Send rejection messages for all tools.
					var toolResults []protocol.ToolResultBlock
					for _, tc := range currentTurnToolCalls {
						toolResults = append(toolResults, protocol.ToolResultBlock{
							ToolUseID: tc.ID,
							Content:   "User denied execution of this tool.",
							IsError:   true,
						})
					}
					session.StateHandler.AddMessage(protocol.Message{
						ID:          uuid.New().String(),
						Role:        "user",
						ToolResults: toolResults,
					})
					continue // Go to next turn (AI will react to rejection)
				}

				if choiceIdx == 1 {
					// Whitelist the tool categories in this batch for the current session
					for _, tc := range currentTurnToolCalls {
						if c.config.AutoApproval != nil {
							c.config.AutoApproval.Enabled = true
							category := tools.GetToolCategory(tc.Name)
							switch category {
							case tools.CategoryRead:
								c.config.AutoApproval.ReadFiles = true
							case tools.CategoryWrite:
								c.config.AutoApproval.EditFiles = true
							case tools.CategoryExecute:
								c.config.AutoApproval.ExecuteAllCommands = true
							case tools.CategoryBrowser:
								c.config.AutoApproval.UseBrowser = true
							case tools.CategoryMCP:
								c.config.AutoApproval.UseMCP = true
							}
						}
					}
					log.Printf("📥 Session Auto-Approval updated for tools: %v", currentTurnToolCalls)
				}
			}
		}

		// EXECUTE TOOLS
		log.Printf("Executing %d tools...", len(currentTurnToolCalls))
		var toolResults []protocol.ToolResultBlock
		for i, tc := range currentTurnToolCalls {
			toolStartedAt := time.Now()
			// Prettify tool name for progress
			// Prettify tool name for progress
			friendlyTool := c.formatToolCall(tc)
			// Use friendlyTool as the status so it shows up nicely in the tree
			emitTaskProgress(friendlyTool, nil, 0, 0, "")
			c.emitToolLifecycle(input, tc, "tool_started", toolStartedAt, "", nil, callback)

			// Update status to running in both turn list and message list
			currentTurnToolCalls[i].Status = "running"
			for j := range assistantMsg.ToolCalls {
				if assistantMsg.ToolCalls[j].ID == tc.ID {
					assistantMsg.ToolCalls[j].Status = "running"
				}
			}
			assistantMsg.IsStreaming = true
			emitUpdate(assistantMsg)

			// Execute
			log.Printf("Running tool %s: %s", tc.Name, tc.Arguments)

			var result string
			var err error
			var submittedArtifact *protocol.Artifact

			// LOOP DETECTOR: Rule A (Stupidity Check)
			if c.loopDetector != nil {
				if loopErr := c.loopDetector.CheckTool(tc.Name, tc.Arguments); loopErr != nil {
					log.Printf("🛑 Loop Rule A: %v", loopErr)
					err = loopErr
					// We act as if execution failed immediately
				}
			}

			// HOOKIFY: Dynamic Safety Checks (PreToolUse)
			if c.dynamicHooks != nil {
				var hookArgs map[string]interface{}
				if json.Unmarshal([]byte(tc.Arguments), &hookArgs) == nil {
					// Add tool name for script context
					hookArgs["tool"] = tc.Name
					warnMsg, blockErr := c.dynamicHooks.TriggerHooks(ctx, hooks.EventPreToolUse, hookArgs)
					if blockErr != nil {
						err = blockErr
						log.Printf("🚫 Hook Action Blocked: %v", err)
					} else if warnMsg != "" {
						log.Printf("⚠️ Hook Warning (Pre): %s", warnMsg)
						// Inject warning into result
						result = fmt.Sprintf("[HOOK WARNING] %s\n\n", warnMsg)
					}
				}
			}

			if err == nil {
				if simpleFastPath && isSimpleFastPathPlanningTool(tc.Name) {
					err = fmt.Errorf("simple work fast path is active; planning/approval tool %q is disabled for this request. Use direct file/edit tools instead", tc.Name)
				}
			}

			if err == nil {
				switch tc.Name {
				case "update_todos":
					var payload struct {
						Todos []protocol.Todo `json:"todos"`
					}
					if err = json.Unmarshal([]byte(tc.Arguments), &payload); err == nil {
						view := c.UpdateTodos(input.SessionID, payload.Todos)
						latestTodoView = &view
						checklistSource = "todo"
						status := taskProgressStatusFromTodos(view.Todos)
						if status == "" {
							status = "Updated task checklist"
						}
						emitTaskProgressEvent("task_progress", status, nil, 0, 0, "")
						result = "Task list updated successfully."
					} else {
						result = fmt.Sprintf("Error parsing todos: %v", err)
					}
				case "task_boundary":
					var payload struct {
						TaskName          string `json:"TaskName"`
						Mode              string `json:"Mode"`
						TaskSummary       string `json:"TaskSummary"`
						TaskStatus        string `json:"TaskStatus"`
						PredictedTaskSize int    `json:"PredictedTaskSize"`
					}
					if err = json.Unmarshal([]byte(tc.Arguments), &payload); err == nil {
						// 1. Update dynamic task name
						if payload.TaskName != "" && payload.TaskName != "%SAME%" {
							dynamicTaskName = payload.TaskName
						}
						// 2. Update mode if changed
						if payload.Mode != "" && payload.Mode != "%SAME%" {
							newMode := strings.ToLower(payload.Mode)
							// Map protocol modes back to agent slugs if needed
							switch newMode {
							case "planning":
								newMode = "architect"
							case "execution":
								newMode = "code"
							case "verification":
								newMode = "test"
							}
							c.modes.SetMode(newMode)
							log.Printf("🔄 Mode switched via task_boundary: %s (agent mode: %s)", payload.Mode, newMode)
						}
						// 3. Update summary if changed
						if payload.TaskSummary != "" && payload.TaskSummary != "%SAME%" {
							taskSummary = payload.TaskSummary
						}
						// 4. Emit progress update with the new status
						status := payload.TaskStatus
						if status == "%SAME%" {
							status = "" // Don't add a new step if status is same
						}
						emitTaskProgressEvent("phase", status, nil, 0, 0, "")
						result = "Task boundary updated."
					} else {
						result = fmt.Sprintf("Error parsing task_boundary args: %v", err)
					}
				case "switch_mode":
					var payload struct {
						Mode    string `json:"mode"`
						Handoff bool   `json:"handoff"`
					}
					if err = json.Unmarshal([]byte(tc.Arguments), &payload); err == nil {
						// 1. Execute mode switch
						// Wrap context with SessionID for tool execution (allows session-scoped host calls)
						toolCtx := protocol.WithToolUseID(protocol.WithRunID(protocol.WithSessionID(ctx, session.ID), input.RunID), tc.ID)
						result, err = c.executor.Execute(toolCtx, tc.Name, json.RawMessage(tc.Arguments))
						if err == nil && payload.Handoff {
							// 2. Trigger Handoff
							log.Printf("🧠 Triggering Intelligent Handoff...")
							cwd, _ := os.Getwd()

							// Summarize history (exclude current tool call)
							msgs := session.StateHandler.GetMessages()
							spec, hErr := c.handoffService.GenerateSpec(ctx, msgs)
							if hErr != nil {
								log.Printf("Handoff generation failed: %v", hErr)
								result += fmt.Sprintf("\n(Warning: Handoff failed: %v)", hErr)
							} else {
								sErr := c.handoffService.SaveSpec(cwd, spec)
								if sErr != nil {
									log.Printf("Handoff save failed: %v", sErr)
								} else {
									// 3. Condense Context: Re-initialize session but keep ID
									// For now, we just log it. Real pruning happens in ContextManager anyway.
									// But to "Start Fresh", we could archive messages.
									result += "\n\n🧠 **Intelligent Handoff Complete**\nContext condensed into `SPEC.md`. Mode switched."
								}
							}
						}
					} else {
						result = fmt.Sprintf("Error parsing switch_mode args: %v", err)
					}
				case "subagent":
					var payload struct {
						Prompt      string `json:"prompt"`
						Description string `json:"description"`
						TaskID      string `json:"task_id"`
					}
					if err = json.Unmarshal([]byte(tc.Arguments), &payload); err == nil {
						// Pass TaskID to SpawnWorker to enable Plan synchronization
						id, sErr := c.swarm.SpawnWorker(ctx, input.SessionID, payload.TaskID, payload.Description, payload.Prompt)
						if sErr != nil {
							result = fmt.Sprintf("Failed to spawn worker: %v", sErr)
						} else {
							result = fmt.Sprintf("🚀 Worker %s spawned (Task: %s). It will operate in the background and report back when finished.", id, payload.TaskID)
						}
					} else {
						result = fmt.Sprintf("Error parsing subagent args: %v", err)
					}

				case "write_scratchpad":
					var payload struct {
						Name    string `json:"name"`
						Content string `json:"content"`
					}
					if err = json.Unmarshal([]byte(tc.Arguments), &payload); err == nil {
						if wErr := c.scratchpad.WriteNote(payload.Name, payload.Content); wErr != nil {
							result = fmt.Sprintf("Failed to write to scratchpad: %v", wErr)
						} else {
							result = fmt.Sprintf("✅ Note '%s' saved to shared scratchpad.", payload.Name)
						}
					}

				case "read_scratchpad":
					result = c.scratchpad.GetSummary()

				case "command_status":
					toolCtx := protocol.WithToolUseID(protocol.WithRunID(protocol.WithSessionID(ctx, session.ID), input.RunID), tc.ID)
					result, err = c.executor.Execute(toolCtx, tc.Name, json.RawMessage(tc.Arguments))
					var payload struct {
						ID string `json:"id"`
					}
					if json.Unmarshal([]byte(tc.Arguments), &payload) == nil && strings.HasPrefix(payload.ID, "agent-") {
						result += "\n\nWorker status has been checked. Do not call command_status for this worker again immediately; continue with other useful analysis or wait for the worker lifecycle event/result."
					}

				case "update_plan":
					var payload struct {
						TaskID       string   `json:"task_id"`
						Status       string   `json:"status"`
						Dependencies []string `json:"dependencies"`
					}
					if err = json.Unmarshal([]byte(tc.Arguments), &payload); err == nil {
						// Update Status
						if upErr := c.planManager.UpdateTaskStatus(payload.TaskID, payload.Status); upErr != nil {
							result = fmt.Sprintf("Failed to update plan status: %v", upErr)
						} else {
							result = fmt.Sprintf("Updated task %s -> %s.", payload.TaskID, payload.Status)
						}

						// Update Dependencies if provided
						if len(payload.Dependencies) > 0 {
							if depErr := c.planManager.UpdateTaskDependencies(payload.TaskID, payload.Dependencies); depErr != nil {
								result += fmt.Sprintf(" (Failed to set deps: %v)", depErr)
							} else {
								result += fmt.Sprintf(" Set dependencies: %v.", payload.Dependencies)
							}
						}
					} else {
						result = fmt.Sprintf("Error parsing update_plan args: %v", err)
					}
				case "submit_plan":
					submittedArtifact, err = c.submitPlanArtifact(input.SessionID, tc.Arguments)
					if err == nil && submittedArtifact != nil {
						result = fmt.Sprintf("Implementation plan artifact submitted: %s\nPath: %s", submittedArtifact.ID, submittedArtifact.Path)
					}
				default:
					toolCtx := protocol.WithToolUseID(protocol.WithRunID(protocol.WithSessionID(ctx, session.ID), input.RunID), tc.ID)
					result, err = c.executor.Execute(toolCtx, tc.Name, json.RawMessage(tc.Arguments))
				}
			}
			isError := false
			if err != nil {
				log.Printf("Tool execution failed: %v", err)
				result = TranslateError(err)
				isError = true
				currentTurnToolCalls[i].Status = "error"

				// LOOP DETECTOR: Rule B (Insanity Check)
				if c.loopDetector != nil {
					if loopErr := c.loopDetector.CheckError(result); loopErr != nil {
						log.Printf("🛑 Loop Rule B: %v", loopErr)
						stuckCounter++
						result += fmt.Sprintf("\n\nCRITICAL: %v", loopErr)

						// HARD STOP: Force-break after 5 consecutive stuck errors
						if stuckCounter >= 5 {
							log.Printf("🛑 HARD STOP: Agent stuck in infinite loop (%d consecutive errors). Aborting.", stuckCounter)
							assistantMsg.Content = "🛑 Agent was stuck in an infinite loop and has been stopped. Please try a different approach or restart the conversation."
							assistantMsg.IsStreaming = false
							emitUpdate(assistantMsg)
							c.emitToolLifecycle(input, tc, "tool_failed", toolStartedAt, result, loopErr, callback)
							return fmt.Errorf("agent stuck: loop detected %d times consecutively", stuckCounter)
						}
						err = loopErr
					}
				}
			} else {
				currentTurnToolCalls[i].Status = "completed"
				stuckCounter = 0 // Reset stuck counter on successful tool execution
			}

			displayResult := truncateString(result, 1000)

			currentTurnToolCalls[i].Result = displayResult
			for j := range assistantMsg.ToolCalls {
				if assistantMsg.ToolCalls[j].ID == tc.ID {
					assistantMsg.ToolCalls[j].Status = currentTurnToolCalls[i].Status
					assistantMsg.ToolCalls[j].Result = displayResult
				}
			}
			assistantMsg.IsStreaming = true
			emitUpdate(assistantMsg)

			toolResults = append(toolResults, protocol.ToolResultBlock{
				ToolUseID: tc.ID,
				Content:   result,
				IsError:   isError,
			})

			// HOOKIFY: Dynamic Quality/Format Checks (PostToolUse)
			if !isError && c.dynamicHooks != nil {
				var hookArgs map[string]interface{}
				if json.Unmarshal([]byte(tc.Arguments), &hookArgs) == nil {
					hookArgs["tool"] = tc.Name
					hookArgs["result"] = result
					warnMsg, postErr := c.dynamicHooks.TriggerHooks(ctx, hooks.EventPostToolUse, hookArgs)
					if postErr != nil {
						// PostToolUse blocking is usually for failed quality checks (exit 2)
						// We treat it as an error for the current tool result
						log.Printf("🚫 PostTool Hook Blocked: %v", postErr)
						toolResults[len(toolResults)-1].Content += fmt.Sprintf("\n\n❌ **Post-Execution Check Failed**: %v", postErr)
						toolResults[len(toolResults)-1].IsError = true
						isError = true
					} else if warnMsg != "" {
						log.Printf("⚠️ PostTool Hook Warning: %s", warnMsg)
						toolResults[len(toolResults)-1].Content += fmt.Sprintf("\n\n⚠️ **Post-Execution Warning**: %s", warnMsg)
					}
				}
			}

			if isError {
				lifecycleErr := err
				if lifecycleErr == nil {
					lifecycleErr = fmt.Errorf("tool failed")
				}
				c.emitToolLifecycle(input, tc, "tool_failed", toolStartedAt, result, lifecycleErr, callback)
			} else {
				c.emitToolLifecycle(input, tc, "tool_finished", toolStartedAt, result, nil, callback)
			}

			// Emitting result for TUI high-fidelity output
			// Re-emit with the same friendly name so it updates the same node (or appends, tree logic handles it)
			emitTaskProgress(friendlyTool, nil, 1, 0, result)
			if !isError && visibleAssistantContent(currentTurnContent) == "" {
				if heartbeat := c.progressHeartbeatForTool(tc.Name, tc.Arguments); heartbeat != "" {
					emitTaskProgressEvent("phase", heartbeat, nil, 0, 0, "")
				}
			}

			// Track activities for the UI
			if !isError {
				activity := c.deriveActivity(tc.Name, tc.Arguments, result)
				if activity != nil {
					assistantMsg.Activities = append(assistantMsg.Activities, *activity)
				}

				// DETECT ARTIFACTS (Phase 4.0)
				artifact := submittedArtifact
				if artifact == nil {
					artifact = c.deriveArtifact(input.SessionID, tc.Name, tc.Arguments)
				}
				if artifact != nil {
					assistantMsg.Artifacts = append(assistantMsg.Artifacts, *artifact)
					if artifact.Type == "implementation_plan" && input.Via != "subtask" && tc.Name != "submit_plan" {
						emitUpdate(assistantMsg)
						emitTaskProgress("Waiting for plan decision...", nil, 0, 0, "")
						decision, decisionErr := c.requestPlanDecision(session, *artifact)
						if decisionErr != nil {
							log.Printf("⚠️ Plan decision prompt failed: %v", decisionErr)
						} else if decision != "" {
							emitTaskProgress("Plan decision: "+decision, nil, 0, 0, "")
						}
					}
				}

				if activity != nil || artifact != nil {
					emitUpdate(assistantMsg)
				}
			}

			// Track file access for context
			if !isError && (tc.Name == "read_file" || tc.Name == "write_file" || tc.Name == "view_file") {
				var argsMap map[string]interface{}
				if json.Unmarshal([]byte(tc.Arguments), &argsMap) == nil {
					if path, ok := argsMap["path"].(string); ok {
						session.FileTracker.AddFile(path)
					} else if path, ok := argsMap["TargetFile"].(string); ok {
						session.FileTracker.AddFile(path)
					} else if path, ok := argsMap["AbsolutePath"].(string); ok {
						session.FileTracker.AddFile(path)
					}
				}
			}

			// Track file edits for task progress
			if !isError && (tc.Name == "write_file" || tc.Name == "replace_file_content" || tc.Name == "write_to_file") {
				var argsMap map[string]interface{}
				if json.Unmarshal([]byte(tc.Arguments), &argsMap) == nil {
					var target string
					if t, ok := argsMap["TargetFile"].(string); ok {
						target = t
					} else if t, ok := argsMap["AbsolutePath"].(string); ok {
						target = t
					}

					if target != "" {
						emitTaskProgress(fmt.Sprintf("Edited %s", filepath.Base(target)), []string{target}, 0, 0, "")
					}
				}
			}

			// Auto-checkpoint after write operations (Phase 18)
			if !isError && c.checkpointManager != nil && c.config.Context.EnableCheckpoints && c.config.Context.CheckpointOnWrites && isWriteTool(tc.Name) {
				// Detect target file for specific snapshot
				var targetFiles []string
				var argsMap map[string]interface{}
				if json.Unmarshal([]byte(tc.Arguments), &argsMap) == nil {
					if t, ok := argsMap["TargetFile"].(string); ok {
						targetFiles = append(targetFiles, t)
					} else if t, ok := argsMap["path"].(string); ok {
						targetFiles = append(targetFiles, t)
					} else if t, ok := argsMap["AbsolutePath"].(string); ok {
						targetFiles = append(targetFiles, t)
					}
				}

				cpID, cpErr := c.checkpointManager.Save(fmt.Sprintf("Auto: After %s", tc.Name), targetFiles)
				if cpErr == nil && cpID != "" {
					assistantMsg.CheckpointHash = cpID
					log.Printf("📸 Auto-Checkpoint saved: %s (after %s)", cpID[:8], tc.Name)
				}
			}

			// Flag for QC if it's a code modification tool
			if !isError && (isWriteTool(tc.Name) || tc.Name == "apply_diff") {
				runQC = true
			}
		}

		// Check for context cancellation after tools but before QC/Audit
		if ctx.Err() != nil {
			log.Printf("[Agent] Post-tool execution aborted: %v", ctx.Err())
			return ctx.Err()
		}

		// Run Auto-QC if code was modified
		var qcMessage string
		if runQC && c.qcManager != nil {
			log.Printf("🤖 Running Phase 15 Auto-QC...")
			qcRes, err := c.qcManager.RunCheck(ctx)
			if err != nil {
				log.Printf("QC Error: %v", err)
			} else if !qcRes.Success {
				log.Printf("❌ Auto-QC FAILED: %s", qcRes.Command)
				// Create a structured error message to feedback into the loop
				qcMessage = fmt.Sprintf("\n\n⚠️ **Auto-QC Failed** (Command: `%s`)\n```\n%s\n```\nPlease fix these errors before proceeding.",
					qcRes.Command, truncateString(qcRes.Output, 2000))
			} else if qcRes.Output != "" {
				log.Printf("✅ Auto-QC PASSED: %s", qcRes.Command)
			}
		}

		// ─── SHADOW AUDIT (Pillar 2: Continuous Inspection) ───
		// Only audit critical tools for now to save tokens
		for _, tr := range toolResults {
			if tr.IsError {
				continue // Skip if already failed
			}
			// Find arguments for this tool use
			for _, tc := range currentTurnToolCalls {
				if tc.ID == tr.ToolUseID {
					// We only audit Write or Execute operations (excluding read-only commands)
					if isWriteTool(tc.Name) || (tc.Name == "execute_command" && !isReadOnlyCommand(tc.Arguments)) {
						// --- Blueprint Context Fetch ---
						var expectedOutcome string
						if c.planManager != nil {
							tasks := c.planManager.ListTasks("active")
							if len(tasks) > 0 {
								expectedOutcome = tasks[0].ExpectedOutcome
							} else {
								// Try in_progress column
								tasks = c.planManager.ListTasks("in_progress")
								if len(tasks) > 0 {
									expectedOutcome = tasks[0].ExpectedOutcome
								}
							}
						}

						approved, feedback, aErr := c.auditor.AuditAction(ctx, input.Content, tc.Name, tc.Arguments, tr.Content, expectedOutcome)
						if aErr == nil && !approved {
							log.Printf("🕵️ Shadow Audit REJECTED: %s", tc.Name)
							qcMessage += fmt.Sprintf("\n\n🕵️ **Shadow Audit Rejected**\n%s\nPlease fix and try again.", feedback)
						}
					}
					break
				}
			}
		}

		// Append tool results to session as a User message (standard for Anthropic)
		session.StateHandler.AddMessage(protocol.Message{
			ID:          uuid.New().String(),
			Role:        "user",
			ToolResults: toolResults,
			Content:     qcMessage, // Append QC failure message if any
		})

		// Loop continues to get AI's reaction to tool results
	}

	// TRIGGER: TaskCompleted / Session Conclusion
	if c.dynamicHooks != nil {
		log.Printf("🏁 Triggering Session Conclusion hooks...")
		stopArgs := map[string]interface{}{}
		if msgs := session.StateHandler.GetMessages(); len(msgs) > 0 {
			stopArgs["last_message"] = msgs[len(msgs)-1].Content
		}
		// Final notification hook (non-vetoable here as the loop is over)
		_, _ = c.dynamicHooks.TriggerHooks(ctx, hooks.EventTaskCompleted, stopArgs)
	}

	return nil
}

// sanitizeMessages ensures every tool call has a corresponding result and model-specific constraints are met
func (c *Controller) sanitizeMessages(msgs []protocol.Message, model string) []protocol.Message {
	if len(msgs) == 0 {
		return msgs
	}

	// ─── HYGIENE: Gemini Turn Ordering ───
	// Gemini (especially Cloud Code Assist) rejects histories starting with assistant turns.
	isGemini := strings.Contains(strings.ToLower(model), "gemini") || strings.Contains(strings.ToLower(model), "google")
	if isGemini {
		if msgs[0].Role == "assistant" {
			log.Printf("🧪 Hygiene: Prepending synthetic user bootstrap for Gemini turn ordering")
			msgs = append([]protocol.Message{{
				Role:    "user",
				Content: "(session bootstrap)",
			}}, msgs...)
		}
	}

	var clean []protocol.Message
	// We need to look ahead, so we iterate manually

	// Map of ToolCallID -> hasResult
	// But actually we just need strict pairs: Assistant(ToolUse) -> User(ToolResults)
	// If Assistant has ToolUse, next msg MUST be User with matching ToolResults

	skipNext := false

	for i := 0; i < len(msgs); i++ {
		if skipNext {
			skipNext = false
			continue
		}

		msg := msgs[i]

		// ─── HYGIENE: Strip Thought Signatures ───
		// Claude (Antigravity) sometimes includes thought_signature metadata that confuses other models.
		if msg.Role == "assistant" && strings.Contains(msg.Content, "thought_signature") {
			// Basic cleanup of technical metadata if present in content
			// This is a safety measure for cross-model compatibility.
			msg.Content = strings.ReplaceAll(msg.Content, "\"thought_signature\"", "\"_ts_cln\"")
			msg.Content = strings.ReplaceAll(msg.Content, "thought_signature", "_ts_cln")
		}

		// If it's a Tool Use message
		if msg.Role == "assistant" && len(msg.ToolUse) > 0 {
			// Check next message
			if i+1 >= len(msgs) {
				// Dangling tool calls at end of history
				log.Printf("⚠️ Sanitizer: Fixing %d dangling tool calls at end", len(msg.ToolUse))
				clean = append(clean, msg)

				results := []protocol.ToolResultBlock{}
				for _, tu := range msg.ToolUse {
					results = append(results, protocol.ToolResultBlock{
						ToolUseID: tu.ID,
						Content:   "Tool execution interrupted or result lost.",
						IsError:   true,
					})
				}
				clean = append(clean, protocol.Message{
					Role:        "user",
					ToolResults: results,
				})
				continue
			}

			nextMsg := msgs[i+1]
			if nextMsg.Role != "user" || len(nextMsg.ToolResults) == 0 {
				// Next message is NOT a result (e.g., User text or another Assistant msg)
				// We MUST provide a result for the tool call to be valid.
				log.Printf("⚠️ Sanitizer: Injecting missing result for tool call (ID: %s) followed by %s", msg.ToolUse[0].ID, nextMsg.Role)

				// Keep the tool call
				clean = append(clean, msg)

				// Create synthetic result
				syntheticResult := protocol.ToolResultBlock{
					ToolUseID: msg.ToolUse[0].ID,
					Content:   "Tool execution result missing (interrupted or lost).",
					IsError:   true,
				}

				// If next is User message, merge the synthetic result into it
				if nextMsg.Role == "user" {
					// Merge
					nextMsg.ToolResults = append([]protocol.ToolResultBlock{syntheticResult}, nextMsg.ToolResults...)
					clean = append(clean, nextMsg)
					skipNext = true
				} else {
					// Insert separate User message with result
					clean = append(clean, protocol.Message{
						Role:        "user",
						ToolResults: []protocol.ToolResultBlock{syntheticResult},
					})
					// Do NOT skip next (process it as normal next message)
				}
				continue
			}

			// Valid Pair: Assistant(Tool) -> User(Result)
			clean = append(clean, msg)
			clean = append(clean, nextMsg)
			skipNext = true
			continue
		}

		// Drop orphan tool results (User msg with results but no preceding call)
		// This happens if we dropped the call, or if history is corrupted.
		if msg.Role == "user" && len(msg.ToolResults) > 0 {
			// Check if this result matches any tool call in history
			found := false
			for _, prev := range clean {
				for _, tu := range prev.ToolUse {
					if tu.ID == msg.ToolResults[0].ToolUseID {
						found = true
						break
					}
				}
			}
			if !found {
				log.Printf("⚠️ Sanitizer: Dropping orphan tool result (ID: %s)", msg.ToolResults[0].ToolUseID)
				continue
			}
		}

		clean = append(clean, msg)
	}

	return clean
}

// GetState returns the current state for a session
func (c *Controller) GetState(sessionID string) map[string]interface{} {
	session := c.GetSession(sessionID)
	if session == nil {
		return map[string]interface{}{
			"messages":        []interface{}{},
			"liveModeEnabled": false,
			"mode":            "code",
			"todos":           []protocol.Todo{},
		}
	}

	stateMsgs := session.StateHandler.GetMessages()
	messages := make([]ChatMessage, 0)

	for i := 0; i < len(stateMsgs); i++ {
		msg := stateMsgs[i]

		// Skip tool result messages as they are merged into the preceding assistant message
		if msg.Role == "user" && len(msg.ToolResults) > 0 {
			continue
		}

		// If this is an assistant message and the previous message in our consolidated list
		// is also an assistant message, we merge them.
		if msg.Role == "assistant" && len(messages) > 0 && messages[len(messages)-1].Role == "assistant" {
			last := &messages[len(messages)-1]
			if msg.Content != "" {
				if last.Content != "" {
					last.Content += "\n" + msg.Content
				} else {
					last.Content = msg.Content
				}
			}

			// Add tool calls from this message
			toolCalls, activities, artifacts := c.processAssistantTurn(sessionID, stateMsgs, i)
			last.ToolCalls = append(last.ToolCalls, toolCalls...)
			last.Activities = append(last.Activities, activities...)
			last.Artifacts = append(last.Artifacts, artifacts...)
			continue
		}

		// New message
		id := msg.ID
		if id == "" {
			id = fmt.Sprintf("msg-%d", i)
		}

		chatMsg := ChatMessage{
			ID:        id,
			Role:      msg.Role,
			Content:   msg.Content,
			Timestamp: session.CreatedAt.Add(time.Duration(i) * time.Second).UnixMilli(),
		}

		if msg.Role == "assistant" {
			tc, activities, artifacts := c.processAssistantTurn(sessionID, stateMsgs, i)
			chatMsg.ToolCalls = tc
			chatMsg.Activities = activities
			chatMsg.Artifacts = artifacts
		}

		messages = append(messages, chatMsg)
	}

	return map[string]interface{}{
		"messages":        messages,
		"liveModeEnabled": false,
		"mode":            c.modes.GetActiveMode().Slug,
		"todos":           session.Todos,
	}
}

// processAssistantTurn finds tool calls and derives activities for the message at index i
func (c *Controller) processAssistantTurn(sessionID string, stateMsgs []protocol.Message, i int) ([]ToolCallInfo, []ActivityItem, []protocol.Artifact) {
	msg := stateMsgs[i]

	var results map[string]string
	var errors map[string]bool

	// Look ahead for results in the next message
	if i+1 < len(stateMsgs) {
		nextMsg := stateMsgs[i+1]
		if nextMsg.Role == "user" && len(nextMsg.ToolResults) > 0 {
			results = make(map[string]string)
			errors = make(map[string]bool)
			for _, res := range nextMsg.ToolResults {
				results[res.ToolUseID] = res.Content
				errors[res.ToolUseID] = res.IsError
			}
		}
	}

	var toolCalls []ToolCallInfo
	var activities []ActivityItem
	var artifacts []protocol.Artifact

	for _, tu := range msg.ToolUse {
		status := "pending"
		result := ""
		isError := false

		if res, ok := results[tu.ID]; ok {
			result = res
			if errors[tu.ID] {
				status = "error"
				isError = true
			} else {
				status = "completed"
			}
		}

		toolCalls = append(toolCalls, ToolCallInfo{
			ID:        tu.ID,
			Name:      tu.Name,
			Arguments: string(tu.Input),
			Result:    result,
			Status:    status,
			Timestamp: time.Now().UnixMilli(),
		})

		if !isError && result != "" {
			activity := c.deriveActivity(tu.Name, string(tu.Input), result)
			if activity != nil {
				activities = append(activities, *activity)
			}

			var artifact *protocol.Artifact
			if tu.Name == "submit_plan" {
				if planArtifact, planErr := c.buildPlanArtifactFromPayload(sessionID, string(tu.Input)); planErr == nil {
					artifact = planArtifact
				}
			} else {
				artifact = c.deriveArtifact(sessionID, tu.Name, string(tu.Input))
			}
			if artifact != nil {
				artifacts = append(artifacts, *artifact)
			}
		}
	}
	return toolCalls, activities, artifacts
}

func (c *Controller) deriveActivity(name string, arguments string, result string) *ActivityItem {
	var argsMap map[string]interface{}
	if err := json.Unmarshal([]byte(arguments), &argsMap); err != nil {
		return nil
	}

	activity := &ActivityItem{
		Timestamp: time.Now().UnixMilli(),
		Status:    "completed",
	}
	getStr := func(keys ...string) string {
		for _, key := range keys {
			if value, ok := argsMap[key].(string); ok && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
		return ""
	}

	switch name {
	case "read_file", "view_file", "view_file_outline", "read_definitions":
		if path := getStr("path", "AbsolutePath", "TargetFile", "file", "target"); path != "" {
			activity.Type = "analyze"
			activity.File = path
		}
	case "list_dir":
		if path := getStr("path", "DirectoryPath", "dir"); path != "" {
			activity.Type = "list_dir"
			activity.File = path
			entries, counts := parseListDirActivity(path, result)
			activity.Entries = entries
			activity.Counts = counts
		}
	case "task_boundary":
		activity.Type = "task_boundary"
		if tn := getStr("TaskName"); tn != "" {
			activity.File = tn
		}
		if ts := getStr("TaskStatus"); ts != "" {
			activity.Message = ts
		}
	case "write_file", "edit_file", "replace_file_content", "multi_replace_file_content":
		if path := getStr("TargetFile", "path", "file"); path != "" {
			activity.Type = "edit"
			activity.File = path
			activity.Additions = strings.Count(result, "+")
			activity.Deletions = strings.Count(result, "-")
			if content, ok := argsMap["content"].(string); ok {
				activity.Additions = countNonEmptyOrLineCount(content)
				activity.Deletions = 0
			}
		}
	case "search_files", "grep_search", "find_by_name", "codebase_search", "web_search":
		if query := getStr("query", "Query", "pattern", "Pattern"); query != "" {
			activity.Type = "search"
			activity.Query = query
			activity.Results = countNonEmptyLines(result)
			activity.Counts = &ActivityCounts{Results: activity.Results}
			activity.ResultPreview = truncateString(result, 2000)
		}
	case "execute_command", "run_command":
		activity.Type = "command"
		activity.Command = getStr("command", "CommandLine", "cmd")
		activity.ResultPreview = truncateString(result, 4000)
		activity.Status = "completed"
		activity.Shell = "sh"
		if cwd, err := os.Getwd(); err == nil {
			activity.Cwd = cwd
		}
	case "execute_python":
		activity.Type = "command"
		activity.Command = "python3 <script>"
		activity.Script = getStr("script")
		activity.ResultPreview = truncateString(result, 4000)
		activity.Status = "completed"
		activity.Shell = "python"
		if cwd, err := os.Getwd(); err == nil {
			activity.Cwd = cwd
		}
	}

	if activity.Type == "" {
		return nil
	}
	return activity
}

func parseListDirActivity(dir string, result string) ([]ActivityEntry, *ActivityCounts) {
	counts := &ActivityCounts{}
	var entries []ActivityEntry
	for _, line := range strings.Split(result, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "(empty directory)" {
			continue
		}

		entryType := "file"
		name := line
		if strings.HasSuffix(line, " (dir)") {
			entryType = "dir"
			name = strings.TrimSuffix(line, " (dir)")
			counts.Folders++
		} else if strings.HasSuffix(line, " (file)") {
			name = strings.TrimSuffix(line, " (file)")
			counts.Files++
		}

		entryPath := name
		if dir != "" && dir != "." {
			entryPath = filepath.ToSlash(filepath.Join(dir, name))
		}
		entries = append(entries, ActivityEntry{
			Name: name,
			Type: entryType,
			Path: entryPath,
		})
	}
	return entries, counts
}

func countNonEmptyLines(result string) int {
	count := 0
	for _, line := range strings.Split(result, "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}

func countNonEmptyOrLineCount(content string) int {
	if content == "" {
		return 0
	}
	trimmed := strings.TrimSuffix(content, "\n")
	if trimmed == "" {
		return 1
	}
	return strings.Count(trimmed, "\n") + 1
}

func (c *Controller) deriveArtifact(sessionID string, name string, arguments string) *protocol.Artifact {
	var argsMap map[string]interface{}
	if err := json.Unmarshal([]byte(arguments), &argsMap); err != nil {
		return nil
	}

	if name != "write_file" && name != "write_to_file" && name != "replace_file_content" && name != "multi_replace_file_content" {
		return nil
	}

	path := ""
	if p, ok := argsMap["path"].(string); ok {
		path = p
	} else if p, ok := argsMap["TargetFile"].(string); ok {
		path = p
	} else if p, ok := argsMap["AbsolutePath"].(string); ok {
		path = p
	}

	if path == "" {
		return nil
	}

	basename := filepath.Base(path)
	lowerBasename := strings.ToLower(basename)
	lowerPath := strings.ToLower(filepath.ToSlash(path))

	// Artifact Path Resolution (Isolation Logic)
	isInternalArtifactPath := strings.Contains(lowerPath, "/.ricochet/artifacts/") || strings.HasPrefix(lowerPath, ".ricochet/artifacts/")
	isMarkdownArtifact := strings.HasSuffix(lowerBasename, ".md") &&
		(strings.Contains(lowerBasename, "plan") ||
			strings.Contains(lowerBasename, "analysis") ||
			strings.Contains(lowerBasename, "report") ||
			strings.Contains(lowerBasename, "walkthrough") ||
			strings.Contains(lowerBasename, "task"))
	isResolvedArtifact := strings.HasSuffix(lowerBasename, ".resolved")
	isArtifact := isInternalArtifactPath || isMarkdownArtifact || isResolvedArtifact
	if !isArtifact {
		return nil
	}

	resolvedPath := path
	if !isInternalArtifactPath {
		cwd, _ := os.Getwd()
		resolvedPath = filepath.Join(cwd, ".ricochet", "artifacts", sessionID, basename)
	}

	artifact := &protocol.Artifact{
		ID:        fmt.Sprintf("%s:%s", sessionID, basename),
		Path:      resolvedPath,
		SessionID: sessionID,
		Status:    "proposed",
	}

	switch {
	case strings.Contains(lowerBasename, "implementation_plan") || strings.Contains(lowerBasename, "plan"):
		artifact.Type = "implementation_plan"
		artifact.Title = "Implementation Plan"
		artifact.Summary = "Detailed technical strategy and architecture for the requested changes."
	case strings.Contains(lowerBasename, "walkthrough"):
		artifact.Type = "walkthrough"
		artifact.Title = "Walkthrough"
		artifact.Summary = "Summary of completed changes and verification results."
	case strings.Contains(lowerBasename, "report"):
		artifact.Type = "report"
		artifact.Title = strings.TrimSuffix(basename, filepath.Ext(basename))
		artifact.Summary = "Assistant generated report."
	case strings.Contains(lowerBasename, "task"):
		artifact.Type = "task"
		artifact.Title = "Task Checklist"
		artifact.Summary = "Progress tracker for individual components and features."
	case strings.Contains(lowerBasename, "analysis"):
		artifact.Type = "other"
		artifact.Title = "Project Analysis"
		artifact.Summary = "Comprehensive analysis of the codebase and requested features."
	default:
		artifact.Type = "other"
		artifact.Title = "Artifact"
		artifact.Summary = "Assistant generated document."
	}

	if strings.HasSuffix(lowerBasename, ".resolved") {
		artifact.Title += " (Final)"
		artifact.Status = "final"
	}

	return artifact
}

func (c *Controller) submitPlanArtifact(sessionID string, arguments string) (*protocol.Artifact, error) {
	artifact, err := c.buildPlanArtifactFromPayload(sessionID, arguments)
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(filepath.Dir(artifact.Path), 0700); err != nil {
		return nil, fmt.Errorf("create plan artifact directory: %w", err)
	}

	if err := os.WriteFile(artifact.Path, []byte(artifact.Content+"\n"), 0600); err != nil {
		return nil, fmt.Errorf("write plan artifact: %w", err)
	}

	return artifact, nil
}

func (c *Controller) buildPlanArtifactFromPayload(sessionID string, arguments string) (*protocol.Artifact, error) {
	var payload struct {
		Title   string `json:"title"`
		Summary string `json:"summary"`
		Content string `json:"content"`
		Kind    string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(arguments), &payload); err != nil {
		return nil, fmt.Errorf("invalid submit_plan arguments: %w", err)
	}

	content := strings.TrimSpace(payload.Content)
	if content == "" {
		return nil, fmt.Errorf("submit_plan requires non-empty content")
	}

	title := strings.TrimSpace(payload.Title)
	if title == "" {
		title = "Implementation Plan"
	}

	summary := strings.TrimSpace(payload.Summary)
	if summary == "" {
		summary = summarizeArtifactContent(content)
	}
	if summary == "" {
		summary = "Review the implementation plan and choose how Ricochet should proceed."
	}

	kind := strings.TrimSpace(payload.Kind)
	if kind == "" {
		kind = "implementation_plan"
	}

	if sessionID == "" {
		sessionID = "default"
	}

	filename := "implementation_plan.md"
	if kind != "implementation_plan" {
		filename = safeArtifactSegment(kind) + ".md"
	}

	cwd, _ := os.Getwd()
	path := filepath.Join(cwd, ".ricochet", "artifacts", safeArtifactSegment(sessionID), filename)

	return &protocol.Artifact{
		ID:        fmt.Sprintf("%s:%s", sessionID, strings.TrimSuffix(filename, ".md")),
		Type:      "implementation_plan",
		Title:     title,
		Summary:   summary,
		Path:      path,
		Content:   content,
		SessionID: sessionID,
		Status:    "proposed",
	}, nil
}

func summarizeArtifactContent(content string) string {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(strings.TrimPrefix(line, "#"))
		if trimmed == "" || strings.HasPrefix(trimmed, "-") || strings.HasPrefix(trimmed, "*") {
			continue
		}
		if len(trimmed) > 220 {
			return trimmed[:217] + "..."
		}
		return trimmed
	}
	return ""
}

func safeArtifactSegment(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	segment := strings.Trim(b.String(), "-")
	if segment == "" {
		return "artifact"
	}
	return segment
}

// UpdateTodos updates the task list for a session and notifies the host.
func (c *Controller) UpdateTodos(sessionID string, todos []protocol.Todo) protocol.TodoView {
	normalized := protocol.NormalizeTodoList(todos)
	var previous []protocol.Todo
	session := c.GetSession(sessionID)
	if session != nil {
		previous = append(previous, session.Todos...)
		session.Todos = normalized
		c.sessionManager.Save(sessionID)
	}
	view := protocol.CalculateTodoView(previous, normalized)

	// Notify host about state change
	if c.host != nil {
		c.host.SendMessage(protocol.RPCMessage{
			Type: "task_state_updated",
			Payload: protocol.EncodeRPC(map[string]interface{}{
				"session_id": sessionID,
				"todos":      normalized,
				"todo_view":  view,
			}),
		})
	}
	return view
}

// condenseAdapter wraps the main AI provider to satisfy the CondenseProvider interface
type condenseAdapter struct {
	p     Provider
	model string
}

// Summarize asks the AI to summarize the text
func (a *condenseAdapter) Summarize(ctx context.Context, prompt string) (string, error) {
	req := &ChatRequest{
		Model: a.model,
		Messages: []protocol.Message{
			{Role: "user", Content: prompt},
		},
		MaxTokens: 4000, // Allow reasonable space for summary
	}

	resp, err := a.p.Chat(ctx, req)
	if err != nil {
		return "", err
	}
	return resp.Content, nil
}

// isWriteTool returns true if the tool modifies workspace files directly
func isWriteTool(name string) bool {
	writingTools := map[string]bool{
		"write_to_file":        true,
		"write_file":           true,
		"replace_file_content": true,
		"apply_diff":           true,
		"delete_file":          true,
		"create_directory":     true,
		"replace_in_file":      true,
		"insert_code_block":    true,
	}
	return writingTools[name]
}

// isReadOnlyCommand attempts to detect if a shell command is just reading data
func isReadOnlyCommand(args string) bool {
	lower := strings.ToLower(args)
	// Commands that are purely defensive/informational
	readKeywords := []string{
		"grep", "rg ", "fd ", "find ", "ls ", "pwd", "cat ", "head ", "tail ", "du ", "df ", "stat ", "jobs",
		"git status", "git diff", "git log", "git show", "git branch",
		"cargo check", "cargo test", "go test", "npm test", "pytest", "python -m unittest",
	}

	isRead := false
	for _, kw := range readKeywords {
		if strings.Contains(lower, kw) {
			isRead = true
			break
		}
	}

	if !isRead {
		return false
	}

	// But if it contains write-like operators, it's not read-only
	writeTokens := []string{">", ">>", "| tee", "rm ", "mv ", "cp ", "chmod", "chown", "mkdir", "touch", "npm install", "go mod", "pip install"}
	for _, wt := range writeTokens {
		if strings.Contains(lower, wt) {
			return false
		}
	}

	return true
}

// SetCheckpointManager sets the checkpoint manager for auto-saving
func (c *Controller) SetCheckpointManager(mgr *CheckpointManager) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.checkpointManager = mgr
}

// normalizeModeName converts mode names to match ephemeral message expectations
// Maps various mode names to: "planning", "execution", "verification", or "code"
func normalizeModeName(modeName string) string {
	lower := strings.ToLower(modeName)

	// Map common variations
	switch {
	case strings.Contains(lower, "plan"):
		return "planning"
	case strings.Contains(lower, "exec") || strings.Contains(lower, "implement") || strings.Contains(lower, "build"):
		return "execution"
	case strings.Contains(lower, "verify") || strings.Contains(lower, "test") || strings.Contains(lower, "check"):
		return "verification"
	default:
		// Default: code mode
		return "code"
	}
}

// Execute implements workflow.AgentExecutor interface
// It allows the workflow engine to trigger agent actions
func (c *Controller) formatToolCall(tc ToolCallInfo) string {
	var args map[string]interface{}
	// If unmarshal fails, return raw string to avoid hiding info
	if err := json.Unmarshal([]byte(tc.Arguments), &args); err != nil {
		return tc.Arguments
	}

	// Helper to get string from map with multiple possible keys
	getStr := func(keys ...string) (string, bool) {
		for _, k := range keys {
			if v, ok := args[k].(string); ok {
				return v, true
			}
		}
		return "", false
	}

	switch tc.Name {
	case "read_file", "view_file", "view_file_outline":
		if path, ok := getStr("path", "AbsolutePath", "file", "target"); ok {
			return fmt.Sprintf("Read file `%s`", c.displayPath(path))
		}
	case "list_dir":
		if path, ok := getStr("DirectoryPath", "path", "dir"); ok {
			return fmt.Sprintf("List directory `%s`", c.displayPath(path))
		}
	case "write_file", "write_to_file":
		if path, ok := getStr("path", "TargetFile", "file"); ok {
			return fmt.Sprintf("Write to file `%s`", c.displayPath(path))
		}
	case "replace_file_content", "multi_replace_file_content":
		if path, ok := getStr("TargetFile", "path", "file"); ok {
			return fmt.Sprintf("Edit file `%s`", c.displayPath(path))
		}
	case "execute_command", "run_command":
		if cmd, ok := getStr("command", "CommandLine", "cmd"); ok {
			return fmt.Sprintf("Run command: `%s`", cmd)
		}
	case "grep_search":
		if q, ok := getStr("Query", "query", "pattern"); ok {
			return fmt.Sprintf("Search for \"%s\"", q)
		}
	case "codebase_search":
		if q, ok := getStr("Query", "query"); ok {
			return fmt.Sprintf("Semantic search: \"%s\"", q)
		}
	case "web_search":
		if q, ok := getStr("query", "Query"); ok {
			return fmt.Sprintf("Search web: \"%s\"", q)
		}
	case "task_boundary":
		// Return empty string to HIDE this from the visual tree
		// The TUI listens to the actual event, so we don't need a tree node for the tool call itself
		return ""
	case "update_todos", "get_context_stats":
		return ""
	}

	// Fallback: try to find a meaningful "path" or "command" generic key
	if p, ok := getStr("path", "file"); ok {
		return fmt.Sprintf("%s `%s`", tc.Name, c.displayPath(p))
	}

	return tc.Arguments
}

func (c *Controller) progressHeartbeatForTool(_ string, _ string) string {
	// Tool calls and activities now carry structured status for the UI. Returning
	// prose here caused duplicate Markdown-rendered "Read/Explored" chatter.
	return ""
}

func (c *Controller) displayPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return path
	}

	cleanPath := filepath.Clean(path)
	if c.cwd != "" && filepath.IsAbs(cleanPath) {
		if rel, err := filepath.Rel(c.cwd, cleanPath); err == nil && rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".." {
			return rel
		}
	}

	if filepath.IsAbs(cleanPath) {
		return filepath.Base(cleanPath)
	}
	return cleanPath
}

func (c *Controller) Execute(ctx context.Context, prompt string) (string, error) {
	// Create a temporary session for this step execution
	session := c.CreateSession()

	req := ChatRequestInput{
		SessionID: session.ID,
		Content:   prompt,
		Via:       "workflow_engine",
	}

	var responseBuilder strings.Builder
	var mu sync.Mutex

	// Helper to collect response
	err := c.Chat(ctx, req, func(update interface{}) {
		if cu, ok := update.(ChatUpdate); ok {
			if cu.Message.Role == "assistant" && cu.Message.Content != "" {
				mu.Lock()
				responseBuilder.WriteString(cu.Message.Content)
				mu.Unlock()
			}
		}
	})

	if err != nil {
		return "", err
	}

	return responseBuilder.String(), nil
}

// GetMemory returns the current persistent memory
func (c *Controller) GetMemory() (string, error) {
	return c.memoryManager.GetSystemPromptPart(), nil
}

// AddMemory appends a new entry to persistent memory
func (c *Controller) AddMemory(content string) error {
	return c.memoryManager.AddLegacy(content)
}

// ClearMemory wipes the persistent memory
func (c *Controller) ClearMemory() error {
	return c.memoryManager.Clear()
}

// GetActiveHooks returns a list of active dynamic hooks
func (c *Controller) GetActiveHooks() []string {
	if c.dynamicHooks == nil {
		return nil
	}
	hooks := c.dynamicHooks.ListHooks()
	result := make([]string, len(hooks))
	for i, h := range hooks {
		result[i] = fmt.Sprintf("%s (%s)", h.Name, h.Event)
	}
	return result
}

// InitProject performs automated discovery and populates memory
func (c *Controller) InitProject(ctx context.Context) (string, error) {
	scanner := NewProjectScanner(c.envTracker.GetCwd(), c)
	summary, err := scanner.ScanProject(ctx)
	if err != nil {
		return "", err
	}

	// Save to memory
	err = c.memoryManager.SetRaw("project_summary", summary)
	if err != nil {
		return "", fmt.Errorf("failed to save memory: %w", err)
	}

	return summary, nil
}

// GetProvidersManager returns the providers manager
func (c *Controller) GetProvidersManager() *config.ProvidersManager {
	return c.providersManager
}

// --- Checkpoint Management (Phase 18) ---

// SaveCheckpoint creates a manual snapshot of current workspace files
func (c *Controller) SaveCheckpoint(name string, files []string) (string, error) {
	return c.checkpointManager.Save(name, files)
}

// ListCheckpoints returns all project snapshots
func (c *Controller) ListCheckpoints() ([]Checkpoint, error) {
	return c.checkpointManager.List()
}

// RestoreCheckpoint reverts project to a specific state
func (c *Controller) RestoreCheckpoint(idOrName string) error {
	return c.checkpointManager.Restore(idOrName)
}

// isToolAutoApproved checks if a tool call can proceed without manual confirmation.
// Uses Category-Based Permission System instead of hardcoded tool name lists.
func (c *Controller) isToolAutoApproved(session *Session, tc ToolCallInfo, planMode bool) bool {
	category := tools.GetToolCategory(tc.Name)

	if session != nil && session.BatchWorkerID != "" {
		return c.isBatchWorkerToolAutoApproved(session, tc, category)
	}

	// ─── META TOOLS: ALWAYS ALLOW (Silent) ───
	// These tools have no side effects on the project files or system.
	if category == tools.CategoryMeta {
		return true
	}

	// ─── READ TOOLS: ALWAYS ALLOW (Silent) ───
	// Read-only operations should NEVER interrupt the user's flow.
	// This is unconditional - reading files is always safe.
	if category == tools.CategoryRead {
		return true
	}

	autoApproval := c.config.AutoApproval
	autoApprovalEnabled := autoApproval != nil && autoApproval.Enabled

	// ─── WRITE TOOLS: Plan Mode = BLOCKED, Act Mode = SETTINGS-DRIVEN ───
	if category == tools.CategoryWrite {
		if planMode {
			// In Plan Mode, write tools are blocked (handled by validateToolUse)
			return false
		}
		if autoApprovalEnabled && c.autoApprovalBudgetAllows(session) {
			isExternal := c.toolTargetsExternal(tc.Arguments)
			if tc.Name == "delete_file" {
				if (!isExternal && autoApproval.DeleteFiles) || (isExternal && autoApproval.DeleteFilesExternal) {
					c.recordAutoApproval(session)
					return true
				}
				return false
			}
			if (!isExternal && autoApproval.EditFiles) || (isExternal && autoApproval.EditFilesExternal) {
				c.recordAutoApproval(session)
				return true
			}
		}
		return false
	}

	// ─── EXECUTE TOOLS: Plan Mode = BLOCKED, Act Mode = SETTINGS-DRIVEN ───
	if category == tools.CategoryExecute {
		if planMode {
			// In Plan Mode, execute tools are blocked
			return false
		}
		if !autoApprovalEnabled {
			return false
		}
		command := extractCommandArgument(tc.Arguments)
		if !c.autoApprovalBudgetAllows(session) {
			return false
		}
		if autoApproval.ExecuteAllCommands {
			allowed := []string{"*"}
			var denied []string
			if c.safeguard != nil && c.safeguard.Permissions != nil {
				allowed = c.safeguard.Permissions.Commands.Allow
				denied = c.safeguard.Permissions.Commands.Deny
			}
			if safeguard.GetCommandDecision(command, allowed, denied) == protocol.PermissionAutoApprove {
				c.recordAutoApproval(session)
				return true
			}
			return false
		}
		if autoApproval.ExecuteSafeCommands && safeguard.IsSafeCommand(command) && !safeguard.ContainsDangerousSubstitution(command) {
			c.recordAutoApproval(session)
			return true
		}
		return false
	}

	// ─── BROWSER TOOLS: Plan Mode = ASK, Act Mode = SETTINGS-DRIVEN ───
	if category == tools.CategoryBrowser {
		if autoApprovalEnabled && autoApproval.UseBrowser && c.autoApprovalBudgetAllows(session) {
			c.recordAutoApproval(session)
			return true
		}
		return false
	}

	// ─── MCP / UNKNOWN TOOLS: Default to requiring approval ───
	// Safety first for external/unknown tools
	if autoApprovalEnabled && autoApproval.UseMCP && c.autoApprovalBudgetAllows(session) {
		c.recordAutoApproval(session)
		return true
	}
	return false
}

func extractCommandArgument(arguments string) string {
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(arguments), &payload); err != nil {
		return ""
	}
	if command, ok := payload["command"].(string); ok {
		return command
	}
	return ""
}

func (c *Controller) toolTargetsExternal(arguments string) bool {
	files := batchWorkerAffectedFiles(arguments)
	if len(files) == 0 {
		return false
	}
	for _, file := range files {
		if !batchPathAllowed(c.cwd, nil, file) {
			return true
		}
	}
	return false
}

func (c *Controller) isBatchWorkerToolAutoApproved(session *Session, tc ToolCallInfo, category tools.ToolCategory) bool {
	if err := c.validateBatchWorkerTool(session, tc.Name, tc.Arguments, category); err != nil {
		return false
	}
	switch category {
	case tools.CategoryMeta, tools.CategoryRead:
		return true
	case tools.CategoryWrite:
		return session.IsolatedAutoApprove
	case tools.CategoryExecute:
		return session.IsolatedAutoApprove
	default:
		return false
	}
}

func (c *Controller) validateBatchWorkerTool(session *Session, toolName string, arguments string, category tools.ToolCategory) error {
	switch toolName {
	case "subagent", "start_subtask", "start_swarm", "browser_open", "browser_click", "browser_type", "browser_screenshot", "browser_navigate":
		return fmt.Errorf("⚠️ Action denied: batch worker '%s' cannot use nested agents or browser automation.", session.BatchWorkerID)
	}
	if category == tools.CategoryBrowser || category == tools.CategoryMCP {
		return fmt.Errorf("⚠️ Action denied: batch worker '%s' cannot use %s tools.", session.BatchWorkerID, category)
	}
	if category == tools.CategoryRead || category == tools.CategoryWrite {
		files := batchWorkerAffectedFiles(arguments)
		if category == tools.CategoryWrite && len(files) == 0 {
			return fmt.Errorf("⚠️ Action denied: batch worker '%s' write tool has no explicit target path.", session.BatchWorkerID)
		}
		for _, file := range files {
			if !batchPathAllowed(session.AllowedRoot, session.ScopePaths, file) {
				return fmt.Errorf("⚠️ Action denied: batch worker '%s' cannot access path outside assigned worktree/scope: %s", session.BatchWorkerID, file)
			}
		}
	}
	if category == tools.CategoryExecute {
		command := extractCommandArgument(arguments)
		if !batchWorkerCommandAllowed(command) || safeguard.CommandMentionsPathOutsideRoot(command, session.AllowedRoot) {
			return fmt.Errorf("⚠️ Action denied: batch worker '%s' cannot run unsafe command: %s", session.BatchWorkerID, command)
		}
	}
	return nil
}

func batchWorkerAffectedFiles(arguments string) []string {
	files := extractAffectedFiles(arguments)
	seen := map[string]bool{}
	out := []string{}
	add := func(path string) {
		path = strings.TrimSpace(path)
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		out = append(out, path)
	}
	for _, file := range files {
		add(file)
	}
	var payload map[string]interface{}
	if json.Unmarshal([]byte(arguments), &payload) != nil {
		return out
	}
	for _, key := range []string{"DirectoryPath", "targetFile", "old_path", "new_path"} {
		if val, ok := payload[key]; ok {
			add(toString(val))
		}
	}
	if edits, ok := payload["edits"].([]interface{}); ok {
		for _, raw := range edits {
			edit, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			for _, key := range []string{"path", "TargetFile", "targetFile", "file_path"} {
				if val, ok := edit[key]; ok {
					add(toString(val))
				}
			}
		}
	}
	return out
}

func batchPathAllowed(root string, scopes []string, rawPath string) bool {
	root = filepath.Clean(strings.TrimSpace(root))
	if root == "" || rawPath == "" {
		return true
	}
	path := filepath.Clean(strings.TrimSpace(rawPath))
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	if len(scopes) == 0 {
		return true
	}
	for _, scope := range scopes {
		scope = filepath.Clean(strings.TrimSpace(scope))
		if scope == "" || scope == "." {
			return true
		}
		if rel == scope || strings.HasPrefix(rel, scope+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func batchWorkerCommandAllowed(command string) bool {
	command = strings.TrimSpace(command)
	if command == "" {
		return false
	}
	lower := strings.ToLower(command)
	if safeguard.ContainsDangerousSubstitution(command) {
		return false
	}
	for _, denied := range []string{"git push", "git merge", "git rebase", "git reset --hard", "rm -rf /"} {
		if strings.Contains(lower, denied) {
			return false
		}
	}
	if safeguard.IsSafeCommand(command) {
		return true
	}
	for _, token := range []string{";", "&&", "||", "|", ">", "<", "`"} {
		if strings.Contains(command, token) {
			return false
		}
	}
	parts := strings.Fields(lower)
	if len(parts) == 0 {
		return false
	}
	switch parts[0] {
	case "go":
		return len(parts) >= 2 && (parts[1] == "test" || parts[1] == "vet")
	case "npm":
		return len(parts) >= 2 && (parts[1] == "test" || (parts[1] == "run" && len(parts) >= 3 && batchSafeScript(parts[2])))
	case "pnpm", "yarn":
		return len(parts) >= 2 && (parts[1] == "test" || parts[1] == "build" || parts[1] == "lint" || (parts[1] == "run" && len(parts) >= 3 && batchSafeScript(parts[2])))
	case "make":
		return len(parts) >= 2 && batchSafeScript(parts[1])
	case "cargo":
		return len(parts) >= 2 && (parts[1] == "test" || parts[1] == "build" || parts[1] == "check" || parts[1] == "clippy")
	}
	return false
}

func batchSafeScript(script string) bool {
	switch strings.TrimSpace(strings.ToLower(script)) {
	case "test", "build", "lint", "check", "typecheck", "verify":
		return true
	default:
		return false
	}
}

// validateToolUse implements the Plan Mode guardrail.
// Write/execute tools are blocked only while the user is explicitly in Plan Mode.
func (c *Controller) validateToolUse(session *Session, toolName string, arguments string, planMode bool) error {
	category := tools.GetToolCategory(toolName)

	if session != nil && session.BatchWorkerID != "" {
		if err := c.validateBatchWorkerTool(session, toolName, arguments, category); err != nil {
			return err
		}
	}

	if c.skills != nil && session != nil {
		if ok, scope := c.skills.ToolAllowedInActiveScope(session.ID, toolName); !ok {
			return fmt.Errorf("⚠️ Action denied: Tool '%s' is outside active skill '%s' allowed tools: %s.", toolName, scope.SkillName, strings.Join(scope.AllowedTools, ", "))
		}
	}

	// Plan Mode is read-only. Default/Act mode can make bounded edits directly.
	if planMode {
		if category == tools.CategoryWrite {
			return fmt.Errorf("⚠️ Action denied: Tool '%s' is forbidden in PLAN MODE. Please switch to Act Mode or complete your planning phase.", toolName)
		}
		if category == tools.CategoryExecute {
			return fmt.Errorf("⚠️ Action denied: Tool '%s' is forbidden in PLAN MODE. Shell commands require Act Mode.", toolName)
		}
	}

	if c.modes != nil {
		activeMode := c.modes.GetActiveMode()
		if !modeAllowsTool(activeMode, toolName, category) {
			return fmt.Errorf("⚠️ Action denied: Tool '%s' is not allowed in %s mode.", toolName, activeMode.Slug)
		}
	}

	return nil
}

// ApprovePlan marks a session's plan as approved for execution
func (c *Controller) ApprovePlan(sessionID string) {
	session := c.sessionManager.GetSession(sessionID)
	if session != nil {
		session.PlanApproved = true
		c.SaveSession(sessionID)
		log.Printf("📥 Plan approved for session %s. Act Mode enabled.", sessionID)
	}
}

func (c *Controller) HandlePlanDecision(sessionID, artifactID, artifactPath, decision string) (string, error) {
	if sessionID == "" {
		return "", fmt.Errorf("session_id is required for plan decision")
	}
	session := c.sessionManager.GetSession(sessionID)
	if session == nil {
		return "", fmt.Errorf("session %s not found", sessionID)
	}

	normalized := strings.ToLower(strings.TrimSpace(decision))
	switch normalized {
	case "implement", "proceed", "approve", "approved":
		session.PlanApproved = true
		session.PlanReviewRequested = false
		normalized = "implement"
	case "revise", "revision":
		session.PlanApproved = false
		session.PlanReviewRequested = false
		normalized = "revise"
	case "save", "save_only", "save only":
		normalized = "save"
	default:
		return "", fmt.Errorf("unknown plan decision %q", decision)
	}

	session.StateHandler.AddMessage(protocol.Message{
		ID:      uuid.New().String(),
		Role:    "system",
		Content: fmt.Sprintf("Plan decision for artifact %s at %s: %s. Use this exact artifact as the referenced plan; do not search for another implementation_plan.md.", artifactID, artifactPath, normalized),
	})
	c.SaveSession(session.ID)
	return normalized, nil
}

func (c *Controller) requestPlanDecision(session *Session, artifact protocol.Artifact) (string, error) {
	if session == nil || session.PlanReviewRequested || session.PlanApproved {
		return "", nil
	}

	session.PlanReviewRequested = true
	c.SaveSession(session.ID)

	choices := []string{
		"Implement plan",
		"Create tasks only",
		"Revise plan",
		"Save only",
	}
	question := fmt.Sprintf(
		"Implementation plan ready\nArtifact: %s\nPath: %s\nChoose what Ricochet should do next.",
		artifact.ID,
		artifact.Path,
	)

	choiceIdx, err := c.host.AskUserChoice(session.ID, question, choices)
	if err != nil {
		return "", err
	}
	if choiceIdx < 0 || choiceIdx >= len(choices) {
		choiceIdx = len(choices) - 1
	}

	decision := choices[choiceIdx]
	if decision == "Implement plan" {
		session.PlanApproved = true
	}

	session.StateHandler.AddMessage(protocol.Message{
		ID:      uuid.New().String(),
		Role:    "system",
		Content: fmt.Sprintf("Plan decision for artifact %s at %s: %s. Use this exact artifact as the referenced plan; do not search for another implementation_plan.md.", artifact.ID, artifact.Path, decision),
	})
	c.SaveSession(session.ID)
	return decision, nil
}

// GetSafeguard returns the safeguard manager
func (c *Controller) GetSafeguard() *safeguard.Manager {
	return c.safeguard
}

// SetOnTaskProgress sets the callback for task progress updates
func (c *Controller) SetOnTaskProgress(callback func(protocol.TaskProgress)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onTaskProgress = callback
}

// ReportTaskProgress sends a progress update to the UI
func (c *Controller) ReportTaskProgress(ctx context.Context, progress protocol.TaskProgress) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.onTaskProgress != nil {
		if progress.RunID == "" {
			progress.RunID = protocol.GetRunID(ctx)
		}
		c.onTaskProgress(progress)
	}
}

// StoreLesson saves a new piece of persistent intelligence
func (c *Controller) StoreLesson(category, content string) error {
	return c.intelligenceManager.Store(agentLessons.Learning{
		Key:       category,
		Value:     content,
		Source:    "user_store_tool",
		Timestamp: time.Now().Unix(),
	})
}

// getGitContext returns a concise summary of the current git state for prompt injection
func (c *Controller) getGitContext() string {
	if c.gitManager == nil || !c.gitManager.IsRepo() {
		return ""
	}

	status, err := c.gitManager.Status()
	if err != nil {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("\n\n### 📜 GIT CONTEXT (Current Workspace State)\n")
	sb.WriteString("This is a snapshot of your current working directory in Git.\n")

	if status == "" {
		sb.WriteString("- Status: Working tree is clean.\n")
	} else {
		sb.WriteString("- Status (Short):\n")
		// Limit status output to prevent context bloat
		lines := strings.Split(status, "\n")
		if len(lines) > 20 {
			sb.WriteString(strings.Join(lines[:20], "\n") + "\n... (more changes hidden)\n")
		} else {
			sb.WriteString(status + "\n")
		}
	}

	// Optional: Include a very short diff summary if there are changes
	if status != "" {
		diff, _ := c.gitManager.Diff()
		if diff != "" {
			sb.WriteString("- Changes Preview (Truncated):\n")
			// Very aggressive truncation for diff in system prompt
			if len(diff) > 1500 {
				sb.WriteString(diff[:1500] + "\n... (diff truncated for brevity)\n")
			} else {
				sb.WriteString(diff + "\n")
			}
		}
	}

	return sb.String()
}

// Subscribe adds a listener to agent events
func (c *Controller) Subscribe(l EventListener) {
	if c.events != nil {
		c.events.Subscribe(l)
	}
}
func (c *Controller) startMcpBroadcaster() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		if c.mcpHub == nil {
			continue
		}

		status := c.mcpHub.GetStatus()
		payload := make(map[string]interface{})
		for name, conn := range status {
			payload[name] = map[string]interface{}{
				"status":    conn.Status,
				"error":     conn.Error,
				"tools":     len(conn.Tools),
				"resources": len(conn.Resources),
				"prompts":   len(conn.Prompts),
				"latency":   conn.Latency.String(),
			}
		}

		// CHANGE DETECTION: Only emit if the status payload has actually changed
		statusJSON, _ := json.Marshal(payload)
		statusHash := string(statusJSON)
		if statusHash == c.lastMcpStatusHash {
			continue
		}
		c.lastMcpStatusHash = statusHash

		c.events.Emit(Event{
			Type: "mcp_hub_status",
			Payload: map[string]interface{}{
				"servers": payload,
			},
		})
	}
}
