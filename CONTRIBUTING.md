# Contributing

Thanks for improving Ricochet. Keep changes focused, reviewable, and safe for a public repository.

## Development Setup

Build all packaged targets:

```bash
./scripts/build-all.sh
```

Run focused checks:

```bash
cd core
go test ./...

cd ../webview
npm test -- --run
npm run build

cd ../extension-vscode
npm test -- --run
npm run build
```

Run the public repository hygiene check from the repository root:

```bash
bash scripts/check-public-hygiene.sh
```

## Pull Requests

- Keep unrelated refactors out of feature and bug-fix PRs.
- Add or update tests for behavior changes.
- Do not commit generated build outputs, logs, local env files, private scratch files, or workspace-private agent state.
- Keep public documentation user-facing. Move maintainer runbooks and release mechanics out of the public docs surface unless they are intentionally part of the open-source process.

## Provider And Account Changes

Ricochet supports both Grik hosted subscription models and BYOK provider keys.

- Do not put real API keys, access tokens, or private Grik gateway credentials in `core/config/providers.yaml`.
- Use environment-variable placeholders for BYOK providers.
- Keep Grik hosted account and billing behavior documented as service-managed.
- Ensure provider metadata returned to the UI never includes raw provider keys.

## Documentation Style

- Root README should help a new user install, sign in, pick a model, and understand safety.
- Security-sensitive details belong in `SECURITY.md`.
- Provider and key-storage details belong in `docs/providers.md`.
- Internal strategy, release runbooks, private agent workflows, and local paths should not be public-facing docs.
