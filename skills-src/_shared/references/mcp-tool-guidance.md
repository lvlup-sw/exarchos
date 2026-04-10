---
name: mcp-tool-guidance
description: "Prefer specialized MCP tools over generic CLI approaches."
---

# MCP Tool Guidance

Use specialized MCP tools over generic approaches:

1. **Workflow state** — Exarchos MCP, never manual JSON
2. **PR creation** — GitHub CLI (`gh pr create --base <base-branch> --title "..." --body "..."`)
3. **State management** — `exarchos_workflow` set/get, never edit JSON directly

> Additional tool guidance (Serena, GitHub MCP, Context7) is provided by optional companions. Install: `npx create-exarchos`

## Describe Before You Guess

The four Exarchos composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) each have a `describe` action that returns live schemas. **Use `describe` before guessing parameter shapes:**

| Need to know… | Call |
|----------------|------|
| Event payload fields | `exarchos_event describe eventTypes=["team.spawned", ...]` |
| Guard prerequisites for a phase transition | `exarchos_workflow describe playbook="<workflowType>"` |
| Orchestrate action parameters | `exarchos_orchestrate describe actions=["task_complete", ...]` |
| View action parameters | `exarchos_view describe actions=["synthesis_readiness", ...]` |

This eliminates trial-and-error discovery. One `describe` call costs fewer tokens than a failed call + retry.

## Quick Reference — `exarchos_workflow`

Before calling, consult `@skills/workflow-state/references/mcp-tool-reference.md` for full action signatures, error handling, and anti-patterns.

| Action | Key Parameters |
|--------|---------------|
| `get` | `featureId`, optional `query` (dot-path) or `fields` (string array for projection) |
| `set` | `featureId`, `updates` (object), `phase` (string) — send both in one call for guarded transitions |
| `init` | `featureId`, `workflowType` (`"feature"` / `"debug"` / `"refactor"`) |
| `cleanup` | `featureId`, `mergeVerified: true`, `prUrl`, `mergedBranches` |
| `cancel` | `featureId`, optional `dryRun: true` |
