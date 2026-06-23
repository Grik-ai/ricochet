# Ricochet VS Code Extension

<p align="center">
  <img src="assets/ricochet.png" width="96" alt="Ricochet logo">
</p>

<p align="center">
  <strong>Reviewable AI coding inside VS Code-compatible editors.</strong><br>
  Chat with an agent, inspect its work timeline, review pending edits, and choose hosted or BYOK models.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=grik.ricochet"><img src="https://img.shields.io/visual-studio-marketplace/v/grik.ricochet?style=flat&logo=visual-studio-code&label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache 2.0 license"></a>
  <img src="https://img.shields.io/badge/Grik%20Account-supported-111827" alt="Grik Account supported">
  <img src="https://img.shields.io/badge/BYOK-supported-2ea44f" alt="BYOK supported">
</p>

## What The Extension Provides

| Feature | Description |
| --- | --- |
| Agent chat | Ask Ricochet to inspect, plan, edit, run commands, and verify work. |
| Task timeline | See file reads, searches, commands, edits, approvals, artifacts, and errors as typed events. |
| Pending changes | Review proposed file edits through native diff views before applying them. |
| Mission dashboard | Track live task progress, worker activity, Hub Tasks, and approvals. |
| Model picker | Use Grik hosted subscription models or configure BYOK providers. |
| Account view | Sign in with Grik and review account, credits, and local Ricochet usage estimates. |
| Checkpoints | Inspect and restore task-level workspace snapshots. |
| Live Mode | Optionally route the current session through Telegram or Discord. |

## Supported Editors

- VS Code
- Cursor
- Windsurf
- Other VS Code-compatible editors that can install marketplace extensions or VSIX packages

## Install

Install from the VS Code Marketplace:

```bash
ext install grik.ricochet
```

Or use the installer:

```bash
curl -fsSL https://grik.io/ricochet/install | sh
```

Package-manager entrypoints:

```bash
npx @grik-ai/ricochet-installer
pnpm dlx @grik-ai/ricochet-installer
bunx @grik-ai/ricochet-installer
brew install grik-ai/tap/ricochet && ricochet-install
```

## Quick Start

1. Open the Ricochet activity bar view.
2. Sign in with Grik, or open Provider Access and add a BYOK provider key.
3. Pick a model.
4. Ask Ricochet to inspect, plan, implement, or verify a task.
5. Review pending changes before saving them into the workspace.

## Model Access

Ricochet supports two access modes:

- **Grik Account** for hosted subscription models. Grik-managed credentials and billing limits are not stored in the repository.
- **BYOK providers** for users who want to use their own provider keys locally.

See [../docs/providers.md](../docs/providers.md) for the provider catalog and key storage model.

## Safety Notes

Ricochet can inspect files, propose edits, and run commands. Use workspace trust, review pending changes, and keep provider keys in local settings or environment variables.

Security details and disclosure guidance are in [../SECURITY.md](../SECURITY.md).

## Development

From the repository root:

```bash
./scripts/build-all.sh
```

Focused extension workflow:

```bash
cd extension-vscode
npm install
npm run build
npm test -- --run
```

Open the repository in VS Code and press `F5` to launch an Extension Development Host.
