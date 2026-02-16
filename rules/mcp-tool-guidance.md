# MCP Tool Guidance

Proactively use installed MCP servers. Don't fall back to generic approaches when a specialized tool exists.

## Tool Selection Priority

1. **Workflow state** — Use Exarchos MCP (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`), never manual JSON files
2. **Code structure** — Use Serena (`find_symbol`, `get_symbols_overview`, `find_referencing_symbols`) over grep for architecture questions
3. **GitHub operations** — Use GitHub MCP tools for ALL GitHub operations (PRs, issues, commits, merging). NEVER use `gh` CLI when an MCP equivalent exists
4. **PR creation** — Use Graphite MCP (`gt submit --no-interactive --publish --merge-when-ready`). NEVER use `gh pr create` or `create_pull_request`
5. **Library docs** — Use Context7 (`resolve-library-id`, `query-docs`) before web search
6. **Microsoft tech** — Use Microsoft Learn MCP for Azure/.NET/Microsoft questions

## Key Rules

- **GitHub MCP over gh CLI** — Use `pull_request_read` (not `gh pr view`), `list_pull_requests` (not `gh pr list`), `merge_pull_request` (not `gh pr merge`)
- **Serena over grep** — Use `find_symbol` and `get_symbols_overview` before reading full files
- **Graphite over git** — Use `gt create` + `gt submit` instead of `git commit` + `git push`
- **Exarchos for state** — Use `exarchos_workflow` set/get, never edit state JSON directly

For detailed tool actions, method mappings, and anti-patterns, see `@skills/workflow-state/references/mcp-tool-reference.md`.
