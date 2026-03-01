---
name: mcp-tool-guidance
description: "Prefer specialized MCP tools over generic CLI approaches."
---

# MCP Tool Guidance

Use specialized MCP tools over generic approaches:

1. **Workflow state** — Exarchos MCP, never manual JSON
2. **Code structure** — Serena (`find_symbol`, `get_symbols_overview`) over grep
3. **GitHub operations** — GitHub MCP tools over `gh` CLI
4. **PR creation** — GitHub CLI (`gh pr create --base <base-branch> --title "..." --body "..."`)
5. **Library docs** — Context7 before web search
6. **State management** — `exarchos_workflow` set/get, never edit JSON directly

See `@skills/workflow-state/references/mcp-tool-reference.md` for detailed mappings.
