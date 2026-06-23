# Ricochet

<p align="center">
  <img src="extension-vscode/assets/ricochet.png" width="96" alt="Ricochet logo">
</p>

<p align="center">
  <strong>Open-source AI coding agent for VS Code-compatible editors and the terminal.</strong><br>
  Plan changes, inspect code, run tools, review edits, and keep control of what lands in your workspace.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=grik.ricochet"><img src="https://img.shields.io/visual-studio-marketplace/v/grik.ricochet?style=flat-square&label=VS%20Code" alt="VS Code Marketplace"></a>
  <a href="https://github.com/Grik-ai/ricochet/stargazers"><img src="https://img.shields.io/github/stars/Grik-ai/ricochet?style=flat-square&label=stars" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="Apache 2.0 license"></a>
  <img src="https://img.shields.io/badge/Grik%20Account-supported-111827?style=flat-square" alt="Grik Account supported">
  <img src="https://img.shields.io/badge/BYOK-supported-2ea44f?style=flat-square" alt="BYOK supported">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#account-and-models">Account and Models</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#development">Development</a>
</p>

---

Ricochet is a local-first coding agent. The editor UI stays focused on the conversation, task timeline, pending file changes, approvals, and checkpoints. A native Go core handles planning, tool execution, provider routing, sessions, and terminal/TUI workflows.

Use Ricochet with a Grik Account for hosted subscription models, or bring your own provider key for supported BYOK providers.

## Features

| Feature | What it does |
| --- | --- |
| Agent chat | Ask Ricochet to inspect, plan, edit, run commands, and summarize work. |
| Reviewable edits | AI-generated file changes are surfaced for review before they are applied. |
| Task timeline | Reads, searches, commands, edits, approvals, artifacts, and errors appear as structured progress. |
| Checkpoints | Restore or compare task-level workspace snapshots. |
| Model choice | Use Grik hosted models or configure BYOK providers such as OpenRouter, OpenAI-compatible APIs, Anthropic, OpenAI, Mistral, DeepSeek, Z.AI, xAI, and MiniMax. |
| MCP and skills | Connect external tools through MCP and add project-specific instructions. |
| CLI/TUI | Run Ricochet from the terminal when you do not want to work inside the editor. |
| Live Mode | Optional Telegram or Discord control for receiving updates and responding while away from the IDE. |

## Install

Install from the VS Code Marketplace:

```bash
ext install grik.ricochet
```

Or use the installer for VS Code-compatible editors:

```bash
curl -fsSL https://grik.io/ricochet/install | sh
```

Package-manager entrypoints run the same installer:

```bash
npx @grik-ai/ricochet-installer
pnpm dlx @grik-ai/ricochet-installer
bunx @grik-ai/ricochet-installer
brew install grik-ai/tap/ricochet && ricochet-install
```

Target a specific editor:

```bash
curl -fsSL https://grik.io/ricochet/install | sh -s -- --editor cursor
```

## Quick Start

1. Open the Ricochet sidebar in VS Code, Cursor, or Windsurf.
2. Sign in with Grik, or open Provider Access and add a BYOK provider key.
3. Choose a model from the model picker.
4. Ask Ricochet to inspect, plan, implement, or verify a task.
5. Review pending changes before applying them to your workspace.

## Account And Models

Ricochet supports two model access paths:

- **Grik Account**: sign in to use hosted subscription models. Provider credentials and billing limits are managed by Grik services, not by this repository.
- **BYOK providers**: store your own provider keys locally and send requests directly to that provider.

The public provider catalog lives in `core/config/providers.yaml`. It contains model metadata and environment-variable placeholders only. It must not contain real API keys, billing credentials, private Grik gateway secrets, or user tokens.

For details, see [docs/providers.md](docs/providers.md).

## Safety

Ricochet can read files, propose edits, and run commands in your workspace. Treat it like a local development tool with access to the project you open.

- Review file edits before applying them.
- Keep provider keys in local user settings or environment variables.
- Do not commit `.env`, `.keys`, `.local`, logs, binaries, or workspace-private agent files.
- Use permissions and checkpoints to keep high-impact changes visible.

For threat model and disclosure details, see [SECURITY.md](SECURITY.md).

## Development

Build everything:

```bash
./scripts/build-all.sh
```

Run focused checks:

```bash
cd core && go test ./...
cd ../webview && npm test -- --run && npm run build
cd ../extension-vscode && npm test -- --run && npm run build
cd .. && bash scripts/check-public-hygiene.sh
```

Development setup and contribution guidance are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Grik-ai/ricochet&type=date&legend=top-left)](https://www.star-history.com/#Grik-ai/ricochet&type=date)

## License

Apache 2.0. See [LICENSE](LICENSE).
