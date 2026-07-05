---
name: commit-push-pr
description: Safely prepare a commit, push it, and open a PR when explicitly requested.
version: "1"
command: /commit-push-pr
risk: high
inputs:
  - name: input
    description: Commit, push, or PR request details.
    required: false
steps:
  - id: inspect
    description: Inspect repository state.
    type: agent
    action: |-
      Request:
      {{input}}

      Inspect branch, status, recent commits, and changed files. Separate user changes from files you changed. Stop if the target branch or destination is ambiguous.
  - id: verify
    description: Run relevant checks before committing.
    type: agent
    action: |-
      Run the relevant tests or build checks for the intended commit. If checks cannot run, report the reason before proceeding.
  - id: commit
    description: Commit only reviewed files.
    type: agent
    action: |-
      Stage only the specific files that belong to this change. Do not stage the whole tree. Write a concise commit message that reflects behavior, not implementation trivia.
  - id: push
    description: Push safely.
    type: agent
    action: |-
      Push the current branch only when the user requested push or PR creation. Do not force push. Stop and report if credentials, remote state, or branch policy blocks the push.
  - id: pr
    description: Create or update the PR.
    type: agent
    action: |-
      Detect and follow the repository PR template when present. Create or update the pull request with summary, tests run, and any known risk. Do not hide failing checks or unverified behavior.
verification:
  - Inspect git status before staging.
  - Review diff/stat before committing.
  - Run relevant tests or state not-run reason.
  - Confirm PR URL or report the exact blocker.
forbidden_actions:
  - Do not stage the whole tree.
  - Do not force push.
  - Do not commit unrelated user changes.
  - Do not open a PR without branch, diff, and test summary.
completion_criteria:
  - Only reviewed files are staged and committed.
  - Push/PR happens only when explicitly requested.
  - Final response includes commit hash or PR URL plus verification status.
---

# Commit, Push, PR

Use this workflow only when the user has requested commit, push, or pull request work.
