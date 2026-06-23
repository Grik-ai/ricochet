---
name: dedupe
description: Find duplicate issues or reports without mutating them.
version: "1"
command: /dedupe
risk: low
inputs:
  - name: input
    description: Issue id, report text, or bug description.
    required: true
steps:
  - id: read
    description: Read the source item.
    type: agent
    action: |-
      Duplicate search request:
      {{input}}

      Read the source issue, report, or bug description. Extract the user-visible symptom, error text, affected component, environment, and timeline.
  - id: search
    description: Search candidate duplicates.
    type: agent
    action: |-
      Search using several query variants: exact error text, normalized symptom, affected component, and likely synonyms. Prefer high-signal candidates over broad matches.
  - id: compare
    description: Compare candidates.
    type: agent
    action: |-
      Compare candidates against the source item. Distinguish same root cause, same symptom but different cause, related issue, and not duplicate.
  - id: report
    description: Report top candidates.
    type: agent
    action: |-
      Report up to three best duplicate candidates with confidence, evidence, and why weaker candidates were rejected. Do not add labels or comments unless the user explicitly asks.
verification:
  - Search multiple variants of the source symptom.
  - Compare candidates against source details before ranking.
forbidden_actions:
  - Do not label, close, or comment on issues.
  - Do not call a candidate duplicate without evidence.
completion_criteria:
  - Up to three candidates are reported with confidence and evidence.
  - If none match, output says no likely duplicates found and why.
---

# Dedupe

Use this workflow to find likely duplicates while keeping the operation read-only.
