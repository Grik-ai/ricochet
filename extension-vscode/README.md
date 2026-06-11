# Ricochet VS Code Extension

<p align="center">
  <img src="assets/ricochet.png" width="96" alt="Ricochet logo">
</p>

<p align="center">
  <strong>AI coding agent for VS Code-compatible editors, powered by a local Go sidecar.</strong><br>
  Plan, edit, review, verify, and control your workspace remotely through Live Mode.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=grik.ricochet"><img src="https://img.shields.io/visual-studio-marketplace/v/grik.ricochet?style=flat&logo=visual-studio-code&label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="https://goreportcard.com/report/github.com/Grik-ai/ricochet"><img src="https://goreportcard.com/badge/github.com/Grik-ai/ricochet" alt="Go Report Card"></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/BYOK-enabled-2ea44f" alt="BYOK enabled">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#models-and-byok">Models and BYOK</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a>
</p>

---

Ricochet is a VS Code extension that connects a polished chat/review interface to `ricochet-core`, a native Go agent runtime. The extension handles editor integration, webview state, pending changes, diff review, checkpoints, and remote Live Mode controls while the core handles planning, tool execution, model routing, MCP, skills, and safeguards.

## Features

| Feature | Description |
| --- | --- |
| Agent chat | Ask Ricochet to inspect, plan, edit, run commands, and summarize work. |
| Plan / Act / Verify | Switch between planning, implementation, and verification workflows. |
| Pending changes | Review AI edits through native diffs before applying them to the workspace. |
| Checkpoints | Keep hidden git-backed checkpoints for task-level restore and inspection. |
| Task timeline | See reads, searches, commands, edits, approvals, artifacts, workers, and errors. |
| Swarm workers | Coordinate bounded subagents and batch workers for parallel investigation. |
| Skills console | Load project, bundled, legacy, and root-rule skills into the agent context. |
| MCP hub | Connect compatible Model Context Protocol servers and OAuth-backed tools. |
| Live Mode / Ether | Route a session through Telegram or Discord when you are away from the IDE. |
| Voice messages | Transcribe Telegram voice prompts through the configured Whisper flow. |
| Multi-session history | Resume previous chats and keep separate task state per session. |
| BYOK model picker | Use your own provider keys and choose free or paid models from the catalog. |

## Supported Editors

- VS Code
- Cursor
- Windsurf
- Other VS Code-compatible editors that can install marketplace extensions

## Models And BYOK

Ricochet can run without a Ricochet subscription in BYOK mode. You configure your own provider key, select a model, and the Go core sends requests to that provider.

Current provider defaults:

| Setting | Value |
| --- | --- |
| Default provider | `openrouter` |
| Default model | `qwen/qwen3-coder:free` |
| BYOK | Enabled |
| Marketplace id | `grik.ricochet` |

The catalog includes free model entries such as OpenRouter `Qwen 3 Coder (Free)`, plus other free entries from configured providers. Paid models are also supported, but any provider costs are billed by the provider through your own API key.

Provider families include OpenRouter, OpenAI-compatible APIs, DeepSeek, Mistral, Z.AI/GLM, OpenAI, Gemini, Anthropic, xAI, MiniMax, and Grik gateway models when configured.

## Installation

### Marketplace

```bash
ext install grik.ricochet
```

Then open the Ricochet activity bar view and configure a provider key in Settings.

### From Source

```bash
git clone https://github.com/Grik-ai/ricochet.git
cd ricochet

cd extension-vscode
npm install
npm run build
```

To launch an Extension Development Host, open the repository in VS Code and press `F5`, or run the extension watch task:

```bash
cd extension-vscode
npm run watch
```

## Extension Commands

Ricochet contributes these commands:

| Command | Purpose |
| --- | --- |
| `Ricochet: New Task` | Start a new agent session. |
| `Ricochet: Toggle Live Mode` | Enable or disable Telegram/Discord remote control. |
| `Ricochet: Open Agent` | Open the agent dashboard. |
| `Ricochet: Open History` | Browse previous sessions. |
| `Ricochet: Open Grik Account` | Open account and device login flows. |
| `Ricochet: Open Settings` | Configure models, providers, skills, MCP, and Live Mode. |
| `Ricochet: Install CLI Globally` | Install the bundled CLI on the system path. |
| `Ricochet: Refresh Pending Changes` | Refresh the pending changes tree. |
| `Ricochet: Accept/Reject File` | Apply or discard a pending file edit. |
| `Ricochet: Accept/Reject Hunk` | Apply or discard a specific diff hunk. |

## Workflow

1. The webview sends chat input and settings events to the extension.
2. The extension starts or reuses `ricochet-core` as a stdio sidecar.
3. The core streams assistant messages, task progress, tool lifecycle events, checkpoints, artifacts, and approval requests.
4. File edits are registered as pending changes in the extension and shown through native diff review.
5. Approved edits are applied to the workspace; rejected edits are discarded.
6. Live Mode can route the same session through Telegram or Discord and surface approval requests remotely.

## Architecture

```text
extension-vscode/
  src/extension.ts                 activation and command registration
  src/core-process.ts              sidecar lifecycle and JSON-RPC transport
  src/webview-provider.ts          webview bridge and message routing
  src/services/chat/               chat events, pending edit proposals, Live Mode
  src/services/diff/               native diff and pending edit review
  src/services/checkpoints/        shadow checkpoint integration
  src/services/session/            local session state
  src/services/mcp/                MCP bridge integration

webview/
  src/components/chat/             chat timeline, input, task summaries, approvals
  src/components/settings/         providers, models, skills, MCP, permissions
  src/components/checkpoints/      checkpoint list and restore UI
  src/hooks/                       chat, sessions, live mode, usage, network health

core/
  internal/agent/                  orchestration, planning, providers, workers
  internal/tools/                  filesystem, command, MCP, skill, batch tools
  internal/safeguard/              permissions, approvals, ignored paths
  internal/livemode/               Telegram/Discord session routing
```

## Configuration

Local settings are stored under `~/.ricochet/`:

| File or directory | Purpose |
| --- | --- |
| `settings.json` | Provider keys, selected model, Live Mode settings, extension preferences. |
| `permissions.json` | Auto-approval and "always allow" decisions. |
| `mcp_tokens.json` | OAuth tokens for MCP servers. |
| `sessions/` | Persistent chat and task history. |

Workspace configuration can live in `.ricochet/`, including project skills and MCP settings.

## Live Mode

Live Mode lets the active Ricochet session receive input from Telegram or Discord:

1. Configure the bot token and chat/user allowlist in Settings.
2. Toggle Live Mode from the chat title bar.
3. Send text or voice messages from your phone.
4. Review progress, completions, and approval prompts remotely.

## Development

Build the extension:

```bash
cd extension-vscode
npm install
npm run build
```

Run extension tests:

```bash
cd extension-vscode
npm test
```

Build the webview:

```bash
cd webview
npm install
npm run build
```

Build and test the Go core:

```bash
cd core
go build ./cmd/ricochet
go test ./...
```

Build all packaged targets:

```bash
./scripts/build-all.sh
```

## Contributing

Useful contributions include provider fixes, safer edit review flows, MCP integrations, UI polish, reproducible bug reports, tests, and documentation improvements.

## Support

Ricochet is an independent open-source project maintained by Igor Pryimak. If it helps you, please star the repository, open issues with clear reproduction steps, or send focused pull requests.

- GitHub: [github.com/Grik-ai/ricochet](https://github.com/Grik-ai/ricochet)

## License

Apache 2.0 © 2025 Igor Pryimak, TK BAZIS - M / GRIK - AI
