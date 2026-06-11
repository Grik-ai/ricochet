package skills

// Simple struct for embedded skills
type EmbeddedSkill struct {
	Name             string
	DisplayName      string
	Description      string
	WhenToUse        string
	ArgumentHint     string
	ArgumentNames    []string
	AllowedTools     []string
	Model            string
	Effort           string
	ExecutionContext string
	Content          string
	Enforcement      string
	Triggers         TriggerConfig
}

// PluginDevSkills returns the set of embedded skills for plugin development
func PluginDevSkills() []EmbeddedSkill {
	return []EmbeddedSkill{
		{
			Name:         "plugin-structure",
			DisplayName:  "Plugin Structure",
			Description:  "Understand the Ricochet Plugin structure.",
			WhenToUse:    "Use when the user asks how to create, inspect, or package Ricochet plugins.",
			AllowedTools: []string{"list_dir", "read_file", "grep_search", "find_by_name", "list_available_skills", "invoke_skill"},
			Content: `
# Ricochet Plugin Structure

A Ricochet plugin is a directory containing a manifest and components.

## Directory Layout
- ` + "`" + `plugin.json` + "`" + `: Manifest file (Required)
- ` + "`" + `commands/` + "`" + `: Slash command definitions (*.md)
- ` + "`" + `agents/` + "`" + `: Specialized agent personas (*.md)
- ` + "`" + `hooks/` + "`" + `: Event hooks (hooks.json)
- ` + "`" + `skills/` + "`" + `: Knowledge modules (SKILL.md)

## Manifest (plugin.json)
` + "```json" + `
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Does amazing things",
  "author": { "name": "Me" }
}
` + "```" + `
`,
			Enforcement: "Load when user asks about creating plugins or plugin structure.",
			Triggers: TriggerConfig{
				Keywords: []string{"plugin structure", "create plugin", "plugin.json"},
			},
		},
		{
			Name:         "agent-development",
			DisplayName:  "Agent Development",
			Description:  "Guide for creating specialized agent personas.",
			WhenToUse:    "Use when the user wants to create, revise, or reason about specialized Ricochet agents.",
			AllowedTools: []string{"list_dir", "read_file", "grep_search", "find_by_name", "list_available_skills", "invoke_skill"},
			Content: `
# Agent Development Guide

To create a new agent persona in Ricochet:

1.  **Create File**: ` + "`" + `agents/my-agent.md` + "`" + `
2.  **Frontmatter**:
    ` + "```yaml" + `
    ---
    name: my-agent
    description: Use this agent when [trigger condition]...
    color: cyan
    model: inherit
    ---
    ` + "```" + `
3.  **System Prompt**:
    -   Define the **Role** ("You are an expert...")
    -   Define **Responsibilities**
    -   Define **Process** (Step 1, Step 2...)
    -   Use <example> blocks in description to help Ricochet know when to pick this agent.

## Best Practices
-   Be specific about when to trigger.
-   Give the agent a distinct personality/expertise.
-   Limit tools if necessary.
`,
			Enforcement: "Load when user wants to create a new agent.",
			Triggers: TriggerConfig{
				Keywords: []string{"create agent", "new agent", "agent persona"},
			},
		},
		{
			Name:         "mcp-integration",
			DisplayName:  "MCP Integration",
			Description:  "Guide for integrating MCP servers into plugins.",
			WhenToUse:    "Use when the user asks about adding external tools, MCP servers, or plugin integrations.",
			AllowedTools: []string{"list_dir", "read_file", "grep_search", "find_by_name", "list_available_skills", "invoke_skill"},
			Content: `
# MCP Integration Guide

Plugins can bundle MCP servers to extend Ricochet's capabilities.

## Configuration (.mcp.json)
Create ` + "`" + `.mcp.json` + "`" + ` in your plugin root:

` + "```json" + `
{
  "mcpServers": {
    "sqlite": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "mcp/sqlite"]
    }
  }
}
` + "```" + `

## Usage
-   Ricochet will automatically start these servers when the plugin is loaded.
-   Tools exposed by the server will be available to the agent.
`,
			Enforcement: "Load when user wants to add an MCP server or external integration.",
			Triggers: TriggerConfig{
				Keywords: []string{"mcp server", "mcp integration", ".mcp.json"},
			},
		},
		{
			Name:             "debug",
			DisplayName:      "Debug Ricochet",
			Description:      "Diagnose Ricochet runtime, logs, tool lifecycle, and session state without making source edits.",
			WhenToUse:        "Use when Ricochet behaves unexpectedly, tools stall, logs are requested, or the user asks why the agent did something.",
			AllowedTools:     []string{"list_dir", "read_file", "grep_search", "find_by_name", "command_status", "get_context_stats", "list_available_skills", "invoke_skill"},
			Effort:           "medium",
			ExecutionContext: "fork",
			Content: `
# Ricochet Debug Skill

Work read-only unless the user explicitly asks for a fix.

1. Identify the active session, run id, model, mode, and recent tool lifecycle events.
2. Inspect relevant logs, settings, and session state.
3. Summarize the failure mode as: symptom, likely cause, evidence, next action.
4. Do not kill processes, delete files, or rewrite configuration from this skill.
`,
			Enforcement: "suggest",
			Triggers: TriggerConfig{
				Keywords:       []string{"debug ricochet", "logs", "why stuck", "tool lifecycle", "диагностика", "логи", "завис"},
				IntentPatterns: []string{"(?i)(debug|diagnose|inspect).*(ricochet|agent|session)"},
			},
		},
		{
			Name:             "stuck",
			DisplayName:      "Stuck Session Triage",
			Description:      "Analyze a slow or frozen session and produce a safe recovery recommendation.",
			WhenToUse:        "Use when the user says the agent is stuck, slow, looping, waiting forever, or not responding.",
			AllowedTools:     []string{"command_status", "get_context_stats", "read_file", "grep_search", "list_dir", "list_available_skills", "invoke_skill"},
			Effort:           "medium",
			ExecutionContext: "fork",
			Content: `
# Ricochet Stuck Session Skill

Do diagnostic work only.

1. Check whether a command, approval, condense, provider call, or tool batch is active.
2. Look for repeated failures, retry loops, blocked approvals, and context exhaustion.
3. Report the least destructive recovery path first.
4. Ask before cancelling, killing, deleting, or resetting anything.
`,
			Enforcement: "suggest",
			Triggers: TriggerConfig{
				Keywords:       []string{"stuck", "frozen", "hang", "looping", "завис", "застрял", "тормозит"},
				IntentPatterns: []string{"(?i)(agent|session|ricochet).*(stuck|frozen|hang|loop)"},
			},
		},
		{
			Name:             "verify",
			DisplayName:      "Verify Result",
			Description:      "Independently verify recent changes, tests, UX, and acceptance criteria.",
			WhenToUse:        "Use before declaring a task done, after edits, or when the user asks to double-check work.",
			AllowedTools:     []string{"list_dir", "read_file", "grep_search", "find_by_name", "get_diagnostics", "execute_command", "command_status", "list_available_skills", "invoke_skill"},
			Effort:           "high",
			ExecutionContext: "fork",
			Content: `
# Ricochet Verify Skill

Verify, do not broaden scope.

1. Reconstruct the requested outcome and acceptance criteria.
2. Inspect the touched files and likely integration points.
3. Run the narrowest useful tests or builds when allowed.
4. Report pass/fail with residual risk and exact commands used.
`,
			Enforcement: "suggest",
			Triggers: TriggerConfig{
				Keywords:       []string{"verify", "check your work", "проверь", "верифицируй", "проверка"},
				IntentPatterns: []string{"(?i)(verify|validate|check).*(result|changes|task|work)"},
			},
		},
		{
			Name:             "remember",
			DisplayName:      "Remember Lessons",
			Description:      "Extract useful durable lessons from the session and propose memory updates with approval.",
			WhenToUse:        "Use when the user says remember this, asks to save project knowledge, or after a repeated project-specific lesson.",
			AllowedTools:     []string{"read_file", "grep_search", "list_dir", "list_available_skills", "invoke_skill"},
			Effort:           "medium",
			ExecutionContext: "fork",
			Content: `
# Ricochet Remember Skill

Never silently store secrets or personal data.

1. Extract concise candidate memories from the current session.
2. Classify each candidate as project, user, or session memory.
3. Detect duplicates, conflicts, stale facts, and secret-looking values.
4. Ask for approval before writing durable memory.
`,
			Enforcement: "suggest",
			Triggers: TriggerConfig{
				Keywords:       []string{"remember", "save this", "запомни", "сохрани знание", "memory"},
				IntentPatterns: []string{"(?i)(remember|save).*(lesson|preference|memory|rule)"},
			},
		},
		{
			Name:             "skillify",
			DisplayName:      "Create Skill",
			Description:      "Turn a repeated workflow or successful session into a reusable Ricochet SKILL.md.",
			WhenToUse:        "Use when the user wants to make a reusable skill, capture a workflow, or formalize a repeated process.",
			AllowedTools:     []string{"list_dir", "read_file", "grep_search", "find_by_name", "list_available_skills", "invoke_skill", "write_file", "create_directory"},
			ArgumentHint:     "short workflow name or goal",
			ArgumentNames:    []string{"workflow_name"},
			Effort:           "high",
			ExecutionContext: "fork",
			Content: `
# Ricochet Skillify Skill

Create a reusable skill only after the workflow is clear.

1. Identify trigger phrases, inputs, outputs, required tools, and safety limits.
2. Draft a compact SKILL.md with frontmatter: name, description, when_to_use, allowed_tools, context, effort.
3. Store references/scripts/templates separately when they are large.
4. Ask before writing the skill into project or user skill storage.
`,
			Enforcement: "suggest",
			Triggers: TriggerConfig{
				Keywords:       []string{"make a skill", "create skill", "skillify", "сделай скилл", "создай skill"},
				IntentPatterns: []string{"(?i)(turn|convert|make).*(workflow|session|task).*(skill|reusable)"},
			},
		},
		{
			Name:             "research",
			DisplayName:      "External Research",
			Description:      "Run opt-in external research with source availability checks, citations, confidence, and a bounded markdown brief.",
			WhenToUse:        "Use when the task needs current external information, market/user feedback, GitHub repository comparison, HN/Reddit/YouTube context, or a cited research brief.",
			AllowedTools:     []string{"research_doctor", "web_search", "read_file", "write_scratchpad", "list_available_skills", "invoke_skill"},
			ArgumentHint:     "research question or topic",
			ArgumentNames:    []string{"topic"},
			Effort:           "high",
			ExecutionContext: "fork",
			Content: `
# Ricochet Research Skill

Research is opt-in and source-bounded.

1. Start with ` + "`" + `research_doctor` + "`" + ` to list available sources and missing adapters.
2. Convert the user question into 3-6 focused queries.
3. Use explicit source tools only; do not use cookies, logged-in sessions, or paid APIs unless configured by the user.
4. Score findings by source quality, recency, engagement when available, and agreement across sources.
5. Return a markdown brief with citations, confidence, open questions, and recommended Ricochet actions.
`,
			Enforcement: "suggest",
			Triggers: TriggerConfig{
				Keywords:       []string{"research", "market", "competitors", "reddit", "youtube", "hacker news", "исследуй", "отзывы", "рынок"},
				IntentPatterns: []string{"(?i)(research|compare|investigate).*(market|competitor|trend|feedback|reviews)"},
			},
		},
		{
			Name:             "document-parse",
			DisplayName:      "Document Parse",
			Description:      "Parse local documents into bounded markdown/context blocks, with OCR/PDF support only when an explicit OCR engine is configured.",
			WhenToUse:        "Use when the user attaches or references PDFs, screenshots, images, specs, invoices, or long documents that need structured extraction.",
			AllowedTools:     []string{"document_parse", "read_file", "list_dir", "list_available_skills", "invoke_skill"},
			ArgumentHint:     "local file path",
			ArgumentNames:    []string{"path"},
			Effort:           "medium",
			ExecutionContext: "inline",
			Content: `
# Ricochet Document Parse Skill

Keep document ingestion privacy-first and bounded.

1. Use ` + "`" + `document_parse` + "`" + ` for local files; do not upload documents silently.
2. For PDF/image OCR, report when no local OCR engine is configured and ask before enabling one.
3. Preserve structure as markdown blocks: text, tables, formulas, images, and metadata when available.
4. Inject only line-ranged or block-ranged snippets into model context.
5. Cache parsed artifacts by hash and mention truncation clearly.
`,
			Enforcement: "suggest",
			Triggers: TriggerConfig{
				Keywords:       []string{"parse document", "pdf", "ocr", "screenshot", "image text", "документ", "распознай", "скриншот"},
				IntentPatterns: []string{"(?i)(parse|extract|ocr).*(pdf|image|screenshot|document)"},
			},
		},
	}
}
