---
name: mcp-tool-guidance
description: "Prefer specialized MCP tools over generic CLI approaches."
---

# MCP Tool Guidance

Use specialized MCP tools over generic approaches:

1. **Workflow state** — Exarchos MCP, never manual JSON
2. **PR creation** — Graphite MCP (`gt submit --no-interactive --publish --merge-when-ready`), never `gh pr create`
3. **State management** — `exarchos_workflow` set/get, never edit JSON directly

> Additional tool guidance (Serena, GitHub MCP, Context7) is provided by the exarchos-dev-tools companion. Install: `npx @lvlup-sw/exarchos-dev`

## Quick Reference — `exarchos_workflow`

Before calling, consult `@skills/workflow-state/references/mcp-tool-reference.md` for full action signatures, error handling, and anti-patterns.

| Action | Key Parameters |
|--------|---------------|
| `get` | `featureId`, optional `query` (dot-path) or `fields` (string array for projection) |
| `set` | `featureId`, `updates` (object), `phase` (string) — send both in one call for guarded transitions |
| `init` | `featureId`, `workflowType` (`"feature"` / `"debug"` / `"refactor"`) |
| `cleanup` | `featureId`, `mergeVerified: true`, `prUrl`, `mergedBranches` |
| `cancel` | `featureId`, optional `dryRun: true` |
