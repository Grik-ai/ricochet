# Ricochet

<p align="center">
  <img src="extension-vscode/assets/ricochet.png" width="96" alt="Ricochet logo">
</p>

<p align="center">
  <strong>Open-source hybrid AI coding agent for VS Code, CLI, and remote messenger control.</strong><br>
  Plan work, edit safely, run tools, coordinate workers, and bring your own model key.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=grik.ricochet"><img src="https://img.shields.io/visual-studio-marketplace/v/grik.ricochet?style=flat-square&label=VS%20Code" alt="VS Code Marketplace"></a>
  <a href="https://github.com/Grik-ai/ricochet/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Grik-ai/ricochet?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/BYOK-enabled-2ea44f?style=flat-square" alt="BYOK enabled">
  <img src="https://img.shields.io/badge/default%20model-Qwen%203%20Coder%20Free-2ea44f?style=flat-square" alt="Default free model">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#models-and-byok">Models and BYOK</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a>
</p>

---

Ricochet is an autonomous coding agent that runs beside your editor instead of inside a single chat box. It combines a VS Code extension, a React webview, and a Go sidecar core that can inspect a workspace, propose plans, edit files with review, run commands, use MCP tools, and coordinate multiple workers for larger tasks.

It is designed for developers who want an agent that can move through a real codebase while still making changes reviewable and reversible.

## Features

| Capability | What it does |
| --- | --- |
| Agentic coding | Reads, searches, edits, runs commands, and keeps task context across a session. |
| Plan / Act / Verify | Creates implementation plans, executes scoped work, and summarizes verification. |
| Safe file edits | Workspace writes go through pending changes, native diffs, and Save/Reject review. |
| Checkpoints | Hidden git-backed checkpoints let you inspect and restore AI-generated changes. |
| Swarm workers | The coordinator can split independent work into bounded subagents or batch workers. |
| Skills and rules | Project rules, custom instructions, and skills guide the agent per workspace. |
| MCP hub | Connect GitHub, Postgres, filesystem, browser, and other Model Context Protocol tools. |
| Live Mode / Ether | Control Ricochet from Telegram or Discord and receive updates when away from the IDE. |
| Voice input | Telegram voice messages can be transcribed and routed into the active agent session. |
| BYOK model catalog | Use your own provider keys, including a default free OpenRouter model path. |

## How It Works

Ricochet keeps the UI thin and moves orchestration into a native sidecar:

```text
VS Code / Cursor / Windsurf
  extension host
    webview chat, settings, diff review, checkpoints
      JSON-RPC over stdio
        Go core
          agent controller, tools, MCP hub, skills, safeguards, live mode
            AI providers through BYOK keys
```

The extension owns IDE integration and review UX. The Go core owns planning, tool execution, provider routing, session state, permissions, checkpoints, and live messenger routing.

## Modes

- `Plan`: explores the repository and produces a first-class implementation plan before code changes.
- `Act` / `Implement`: applies changes through tools, pending edit review, and command execution.
- `Verify`: checks results, reports test/build status, and explains remaining risk.
- `Swarm`: delegates independent work to workers while the coordinator synthesizes results.
- `Live Mode` / `Ether`: binds a session to Telegram or Discord so the same agent can be controlled remotely.

## Models And BYOK

Ricochet is open-source and does not require a Ricochet subscription when you use BYOK. You provide the API key for the provider you want to use, and Ricochet routes requests through the configured provider.

Current defaults in `core/config/providers.yaml`:

| Setting | Value |
| --- | --- |
| Default provider | `openrouter` |
| Default model | `qwen/qwen3-coder:free` |
| BYOK | Enabled |

Free models are available in the catalog, including the default OpenRouter `Qwen 3 Coder (Free)` model and free entries from providers such as OpenRouter, Mistral, and Z.AI where configured. Paid provider models are also supported, but their usage is billed by the provider through your own key.

Supported provider families include OpenRouter, OpenAI-compatible APIs, DeepSeek, Mistral, Z.AI/GLM, OpenAI, Gemini, Anthropic, xAI, MiniMax, and Grik gateway models when configured.

## Install

### VS Code extension

Install Ricochet from the VS Code Marketplace:

```bash
ext install grik.ricochet
```

The extension also works in VS Code-compatible editors such as Cursor and Windsurf.

### CLI / TUI

The CLI can be launched from bundled binaries or built from source:

```bash
ricochet
```

For local development:

```bash
git clone https://github.com/Grik-ai/ricochet.git
cd ricochet
./scripts/build-all.sh
```

## Quick Start

1. Install the extension with `ext install grik.ricochet`.
2. Open the Ricochet sidebar.
3. Open Settings and add a provider key, for example `OPENROUTER_API_KEY`.
4. Choose a model from the model picker, or keep the default `qwen/qwen3-coder:free`.
5. Ask Ricochet to inspect, plan, implement, or verify a task.
6. Review pending file changes before saving them into your workspace.

## Configuration

Ricochet stores local settings under `~/.ricochet/`:

| Path | Purpose |
| --- | --- |
| `settings.json` | Provider keys, selected model, Live Mode settings, and preferences. |
| `permissions.json` | Auto-approval and "always allow" tool/path decisions. |
| `mcp_tokens.json` | OAuth tokens for MCP servers. |
| `sessions/` | Persistent chat and task session history. |

Workspace-specific behavior can also be configured with `.ricochet/` files, project rules, skills, and MCP settings.

## MCP And Skills

Ricochet can use Model Context Protocol servers and local skills to extend the agent:

- MCP servers add external tools such as GitHub, databases, browser automation, search, and custom services.
- Skills package reusable project knowledge, workflows, and constraints.
- Project rules and custom instructions are injected into the agent when relevant to the task.

## Live Mode / Ether

Live Mode lets you continue a Ricochet session from Telegram or Discord:

1. Create and configure a bot token in Ricochet settings.
2. Toggle Live Mode in the extension.
3. Send messages or voice notes from your phone.
4. Receive progress updates, completion summaries, and approval requests remotely.

Only one active window should own a given bot/session binding at a time.

## Architecture

```text
Ricochet/
  extension-vscode/     VS Code extension, commands, webview bridge, diff review
  webview/              React chat UI, settings, task timeline, checkpoints
  core/                 Go sidecar: agent, tools, providers, MCP, skills, safeguards
  scripts/              Build and packaging helpers
  RICOCHET.md           Internal agent/project manifest
```

Important subsystems:

- `core/internal/agent`: session orchestration, planning, lifecycle events, workers, provider routing.
- `core/internal/tools`: filesystem, command, MCP, skill, graph, batch, and research tools.
- `core/internal/safeguard`: permissions, approval rules, ignored paths, and checkpoints.
- `core/internal/livemode` and `core/internal/telegram`: remote control and voice-message handling.
- `extension-vscode/src/services`: sidecar process, chat bridge, pending changes, checkpoints, sessions, MCP, review UX.
- `webview/src/components`: chat, settings, agent dashboard, checkpoints, MCP, and account UI.

## Development

Build the Go core:

```bash
cd core
go build ./cmd/ricochet
```

Run Go tests:

```bash
cd core
go test ./...
```

Build the VS Code extension:

```bash
cd extension-vscode
npm install
npm run build
```

Build the webview:

```bash
cd webview
npm install
npm run build
```

Build all packaged targets:

```bash
./scripts/build-all.sh
```

## Contributing

Issues, bug reports, feature proposals, and pull requests are welcome. The most useful contributions are reproducible bug reports, provider/tool fixes, UX polish, documentation improvements, and focused tests.

## Support

Ricochet is an independent open-source project. If it helps you, please star the repository and share useful issues or pull requests:

- GitHub: [github.com/Grik-ai/ricochet](https://github.com/Grik-ai/ricochet)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Grik-ai/ricochet&type=date&legend=top-left)](https://www.star-history.com/#Grik-ai/ricochet&type=date&legend=top-left)

## License

Apache 2.0 © 2025 Igor Pryimak
