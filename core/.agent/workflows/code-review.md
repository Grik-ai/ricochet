---
name: code-review
description: Review code for actionable defects and regression risk.
version: "1"
command: /code-review
risk: low
inputs:
  - name: input
    description: Diff, branch, file, PR, or feature area to review.
    required: false
steps:
  - id: scope
    description: Establish review scope.
    type: agent
    action: |-
      Review target:
      {{input}}

      Determine the diff, files, or feature area under review. Read enough surrounding code to understand behavior and contracts before judging.
  - id: findings
    description: Identify actionable issues.
    type: agent
    action: |-
      Look for bugs, regressions, security issues, data-loss risks, concurrency problems, missing error handling, and missing tests for changed behavior. Do not list style nits or speculative preferences.
  - id: coverage
    description: Check verification gaps.
    type: agent
    action: |-
      Inspect tests or verification evidence related to the review scope. Identify missing tests only when they correspond to a concrete behavioral risk.
  - id: report
    description: Return review findings first.
    type: agent
    action: |-
      Report findings first, ordered by severity. Each finding must include severity, file path, line or tight range when available, why it is a real risk, and a concrete fix direction. If there are no findings, say so clearly and mention residual test gaps.
verification:
  - Inspect the relevant diff or files and enough surrounding code to validate each finding.
  - Check tests only for concrete behavior risks.
forbidden_actions:
  - Do not edit code during review.
  - Do not report style nits or speculative preferences.
  - Do not bury findings after a summary.
completion_criteria:
  - Findings are ordered by severity and include file/line when available.
  - Each finding explains impact and fix direction.
  - If no findings exist, final output says so and names residual risk.
---

# Code Review

Use this workflow for review requests. The output should prioritize defects over summary.
