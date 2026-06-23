# Swarm Coordination

Use swarm only when independent workers can reduce risk or latency. Good cases include broad repository discovery, competitor comparison, independent verification, and parallel investigation of separate modules.

## Activation

When swarm is appropriate, use the native swarm tool:

```json
{"confirm": true, "goal": "clear objective", "depth": "fast"}
```

Do not call shell CLIs to simulate swarm behavior.

## Delegation Rules

- Give each worker a bounded, non-overlapping scope.
- Prefer read-only research or verification tasks unless the workflow explicitly supports parallel edits.
- Do not assign multiple workers to modify the same files.
- Include expected evidence: file paths, commands, failing output, or concise conclusions.
- Spot-check worker findings before making final claims.

## Result Handling

Treat swarm results as supporting evidence, not automatic truth. Reconcile disagreements, verify claims that affect code, and report unresolved uncertainty directly.

If a worker is blocked, do not repeatedly poll without new information. Either change the scope, continue with available evidence, or report the blocker.
