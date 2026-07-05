---
name: issue-triage
description: Triage issues with evidence before labels or comments.
version: "1"
command: /issue-triage
risk: medium
inputs:
  - name: input
    description: Issue id, query, or bounded issue list.
    required: true
steps:
  - id: collect
    description: Collect issue context.
    type: agent
    action: |-
      Triage request:
      {{input}}

      Read the target issue or bounded issue list. Capture title, body, labels, linked PRs, recent comments, and affected area.
  - id: reproduce
    description: Search for supporting evidence.
    type: agent
    action: |-
      Search the repository for the named behavior, errors, modules, and recent related changes. Prefer read-only investigation first.
  - id: classify
    description: Classify confidence and next action.
    type: agent
    action: |-
      Classify each issue as bug, feature, question, duplicate candidate, invalid, blocked, or needs-reproduction. Include confidence and the evidence behind the label.
  - id: act
    description: Apply safe triage actions or report.
    type: agent
    action: |-
      If mutation is allowed and the evidence is strong, apply labels or comments narrowly. Otherwise report recommended actions and ask only for the specific permission that is missing.
verification:
  - Read the target issue or bounded issue list.
  - Search repository or issue history for supporting evidence.
forbidden_actions:
  - Do not label, close, or comment without strong evidence and permission.
  - Do not classify issues from title alone.
completion_criteria:
  - Each issue has classification, confidence, evidence, and next action.
  - Mutations are applied only when explicitly allowed; otherwise recommendations are reported.
---

# Issue Triage

Use this workflow for bounded issue triage. Prefer evidence over volume.
