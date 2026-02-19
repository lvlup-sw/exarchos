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

See `@skills/workflow-state/references/mcp-tool-reference.md` for detailed mappings.
