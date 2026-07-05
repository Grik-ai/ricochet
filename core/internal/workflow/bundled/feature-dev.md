---
name: feature-dev
description: Implement a feature with scoped discovery, careful edits, and verification.
version: "1"
command: /feature-dev
risk: medium
inputs:
  - name: input
    description: Feature request or implementation target.
    required: true
steps:
  - id: discover
    description: Inspect relevant context before editing.
    type: agent
    action: |-
      User request:
      {{input}}

      Inspect the codebase before proposing or changing anything. Identify the entry points, existing patterns, tests, and project instructions that apply. Keep the scope narrow and call out any hard blocker.
  - id: plan
    description: Decide whether a formal plan is needed.
    type: agent
    action: |-
      Based on the discovered context, decide whether this change needs a formal implementation plan.

      Use submit_plan only if the task is complex, risky, ambiguous, or spans multiple modules. For a small safe change, proceed with a short internal checklist and state the assumption.
  - id: implement
    description: Make the smallest correct implementation.
    type: agent
    action: |-
      Implement the requested feature using the existing architecture and style. Read files before editing them, avoid unrelated refactors, and preserve user changes in the worktree.
  - id: verify
    description: Verify and report.
    type: agent
    action: |-
      Run the narrowest meaningful tests or checks for the touched area. If a check cannot run, explain exactly why. Final response must include changed behavior, verification performed, and residual risk.
verification:
  - Run the narrowest useful tests, build, or diagnostics for touched code.
  - Re-read touched files or diff before final response.
forbidden_actions:
  - Do not edit files before repository discovery.
  - Do not perform unrelated refactors.
  - Do not claim verification without a command result or direct inspection.
completion_criteria:
  - Requested behavior is implemented or blocker is explicitly reported.
  - Relevant checks are run or not-run reason is stated.
  - Final response lists changed behavior, verification, and residual risk.
---

# Feature Development

Use this workflow for implementation requests that should move from repository discovery to scoped edits and verification.
