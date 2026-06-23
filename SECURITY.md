# Security

Ricochet is a local development tool. It can inspect workspace files, propose file edits, run shell commands, call model providers, and connect optional MCP or messenger integrations. Treat it with the same care you would apply to any tool that can operate inside your source tree.

## Threat Model

- Ricochet runs on the user's machine and works inside the opened workspace.
- Agent actions may read files, create proposed edits, run commands, and use configured tools.
- Permissions, approvals, checkpoints, and pending-change review are safety controls, not a complete sandbox.
- Provider API keys and Grik account tokens are user secrets. They must stay in local user storage, environment variables, or the OS secret store.
- Grik hosted provider credentials and billing limits are managed by Grik services. They are not stored in `core/config/providers.yaml`.

## Secret Handling

Do not commit:

- `.env`, `.env.local`, `.env.keys`, `*.keys`, or `*.local`
- provider API keys, access tokens, refresh tokens, bot tokens, or OAuth client secrets
- local logs, built binaries, private agent workflows, local scratch plans, or workspace-private `.ricochet/` state

The provider catalog in `core/config/providers.yaml` is public metadata. It should contain model IDs, endpoint metadata, and environment-variable placeholders only.

## Reporting Vulnerabilities

Please report security issues privately instead of opening a public issue.

Include:

- affected version or commit
- clear reproduction steps
- expected and observed impact
- whether secrets, local files, command execution, or account data are involved

Maintainers should acknowledge the report, investigate the scope, prepare a fix, and publish advisory details only after a safe release is available.

## Supported Security Boundaries

- User approval for sensitive operations
- Pending-change review before workspace edits are applied
- Workspace checkpoints for recovery
- Local secret storage for provider/account tokens
- Clear distinction between Grik hosted subscription access and BYOK provider keys

## Not A Security Boundary

- Model output text
- Markdown rendering alone
- The existence of a checkpoint
- UI labels around permissions
- Local configuration files that contain secrets
