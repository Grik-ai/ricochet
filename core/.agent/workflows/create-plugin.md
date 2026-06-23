---
name: create-plugin
description: Create or update a Ricochet plugin using existing plugin conventions.
version: "1"
command: /create-plugin
risk: medium
inputs:
  - name: input
    description: Plugin name, goal, or update request.
    required: true
steps:
  - id: discover
    description: Inspect plugin conventions.
    type: agent
    action: |-
      Plugin request:
      {{input}}

      Inspect existing plugin directories, manifests, commands, skills, hooks, and tests. Identify the expected schema and naming conventions.
  - id: design
    description: Define the plugin surface.
    type: agent
    action: |-
      Define the plugin name, purpose, manifest fields, commands, skills, hooks, permissions, and test strategy. Ask only if the target name or behavior is materially ambiguous.
  - id: scaffold
    description: Create or update files.
    type: agent
    action: |-
      Scaffold the plugin using existing repository patterns. Keep the initial surface small, avoid unrelated config changes, and include clear metadata.
  - id: verify
    description: Validate the plugin.
    type: agent
    action: |-
      Validate manifest/schema loading and run any relevant tests. Report exact commands and any unverified integration points.
verification:
  - Validate manifest/schema loading.
  - Run relevant unit tests or a focused parser/load check.
forbidden_actions:
  - Do not invent a plugin format when existing conventions are discoverable.
  - Do not modify unrelated plugins or marketplace metadata.
completion_criteria:
  - Plugin files follow existing conventions.
  - Manifest and relevant loading path are verified or not-run reason is stated.
---

# Create Plugin

Use this workflow for creating or updating a Ricochet plugin.
