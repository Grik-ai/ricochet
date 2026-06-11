# Ricochet Project Manifest (Ground Truth)

> [!IMPORTANT]
> This file is the primary instruction manual for the Ricochet AI Agent. It defines the core architectural "Skyscraper" pillars and development protocols.

## 🏗️ Core Architecture (Pillars)
1. **Elegant Delegation**: Ricochet operates on a **Coordinator-Worker** model. The Coordinator synthesizes findings, while Workers handle isolated, task-specific sessions via the `subagent` tool.
2. **Shadow Agents (Continuous Inspection)**: Every critical write or command is auditable by a specialized **Verifier Agent** to prevent compound error. Never assume success without verification.
3. **Shared Ground Truth (Scratchpad)**: Cross-agent communication happens via the persistent `.ricochet/scratchpad/` index. Use `read_scratchpad` to sync findings.
4. **Context Efficiency**: Rules are modular and **path-scoped** in `.ricochet/rules/`. Only relevant rules are loaded into context.

## 🛠️ Key Commands
- `go run ./cmd/ricochet` — Start TUI
- `go build ./...` — Build project
- `go test ./...` — Run unit and integration tests

## 📜 Coding & Security Standards
- **Host Abstraction**: All OS interactions must go through `host.Host`.
- **Deterministic Hooks**: Safety rules in `.ricochet/hooks/` (shell scripts) can block dangerous actions (exit 2).
- **Tool Integrity**: Every tool call must have a corresponding result.

## 📁 Key Folders
- `/.ricochet`: Rules, hooks, and scratchpad memory.
- `/core`: Main Go business logic.
- `/extension-vscode`: Frontend UI components.
