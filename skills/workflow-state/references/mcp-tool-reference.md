# MCP Tool Reference

Detailed tool usage, methods, and anti-patterns for all installed MCP servers.

## Exarchos (`mcp__exarchos__*`)

Unified MCP server for workflow orchestration, event sourcing, CQRS views, and task coordination. **Always use for workflow tracking.** Exposes 5 composite tools with action discriminators. Note: inter-agent messaging uses Claude Code's native Agent Teams, not Exarchos.

### Composite Tools

| Tool | Actions | When to Use |
|------|---------|-------------|
| `mcp__exarchos__exarchos_workflow` | `init`, `get`, `set`, `cancel` | Workflow CRUD: starting workflows, reading/updating state, cancelling abandoned workflows |
| `mcp__exarchos__exarchos_event` | `append`, `query` | Event sourcing: recording workflow events, reading event history |
| `mcp__exarchos__exarchos_orchestrate` | `task_claim`, `task_complete`, `task_fail` | Task coordination and lifecycle |
| `mcp__exarchos__exarchos_view` | `pipeline`, `tasks`, `workflow_status`, `stack_status`, `stack_place` | CQRS materialized views for read-optimized queries |
| `mcp__exarchos__exarchos_sync` | `now` | Force sync of materialized views |

### Workflow Tool Actions

| Action | When to Use |
|--------|-------------|
| `init` | Starting any `/ideate`, `/debug`, or `/refactor` workflow |
| `get` | Restoring context, checking phase, reading task details. Use `query` for dot-path lookup (e.g., `query: "phase"`), or `fields` array for projection (e.g., `fields: ["phase", "tasks"]`) to reduce token cost |
| `set` | Updating phase (`phase: "delegate"`), recording artifacts, marking tasks complete. Use `updates` for field changes and `phase` for transitions |
| `cancel` | Cleaning up abandoned workflows. Supports `dryRun: true` to preview cleanup actions |

**Hooks (automatic, no tool call needed):**
- **SessionStart hook** — Discovers active workflows, restores context, determines next action, and verifies state on resume (replaces former `workflow_list`, `workflow_summary`, `workflow_next_action`, `workflow_reconcile` tools)
- **PreCompact hook** — Saves checkpoints before context exhaustion (replaces former `workflow_checkpoint` tool)
- Valid phase transitions are documented statically (replaces former `workflow_transitions` tool)

### Event Tool Actions

| Action | When to Use |
|--------|-------------|
| `append` | Recording workflow events (task.assigned, gate.executed, etc.). Use `expectedSequence` for optimistic concurrency |
| `query` | Reading event history. Use `filter` for type/time filtering, `limit`/`offset` for pagination |

### Orchestrate Tool Actions

| Action | When to Use |
|--------|-------------|
| `task_claim` | Claim a task for execution. Returns `ALREADY_CLAIMED` if previously claimed — handle gracefully |
| `task_complete` | Mark a task complete with optional `result` (artifacts, duration) |
| `task_fail` | Mark a task failed with `error` message and optional `diagnostics` |

### View Tool Actions

| Action | When to Use |
|--------|-------------|
| `pipeline` | Aggregated view of all workflows with stack positions. Use `limit`/`offset` for pagination |
| `tasks` | Task detail view with filtering and projection. Use `workflowId` to scope, `filter` for property matching, `fields` for projection (e.g., `fields: ["taskId", "status", "title"]`), `limit`/`offset` for pagination |
| `workflow_status` | Workflow phase, task counts, and metadata. Use `workflowId` to scope |
| `stack_status` | Get current stack positions from events. Use `streamId` to scope |
| `stack_place` | Record a stack position with `position`, `taskId`, `branch`, optional `prUrl` |

## GitHub (`mcp__plugin_github_github__*`)

GitHub platform integration. **Always use GitHub MCP tools for ALL GitHub operations. NEVER use `gh` CLI when an MCP equivalent exists.**

| Tool | When to Use |
|------|-------------|
| `get_file_contents` | Reading files from remote repos or other branches |
| `search_code` | Finding code patterns across repositories |
| `search_issues` | Checking for existing issues before creating new ones |
| `list_pull_requests` / `search_pull_requests` | Finding related PRs, checking PR status |
| `pull_request_read` | Reading PR details, diffs, review comments, status checks, files changed |
| `issue_read` / `issue_write` | Reading/managing issues |
| `list_commits` / `get_commit` | Examining commit history |
| `list_branches` / `create_branch` | Branch management |
| `add_issue_comment` | Commenting on issues |
| `pull_request_review_write` | Submitting PR reviews |
| `merge_pull_request` | Merging pull requests |
| `update_pull_request` | Updating PR title, body, or state |

### Key methods for `pull_request_read`

| Method | Instead of |
|--------|-----------|
| `get` | `gh pr view` |
| `get_diff` | `gh pr diff` |
| `get_status` | `gh pr checks` |
| `get_files` | `gh pr view --json files` |
| `get_review_comments` | `gh api repos/.../pulls/.../comments` |
| `get_reviews` | `gh pr view --json reviews` |
| `get_comments` | `gh pr view --json comments` |

**Proactive use:** When the user mentions a PR number, issue, or GitHub URL, use these tools to fetch context rather than asking the user to paste content. When checking PR merge status, review comments, or CI status, always use `pull_request_read` with the appropriate method.

## Serena (`mcp__plugin_serena_serena__*`)

Semantic code analysis with symbol-level understanding. **Prefer over grep/glob for code structure questions.**

| Tool | When to Use |
|------|-------------|
| `find_symbol` | Locating classes, functions, methods by name — faster and more precise than grep |
| `get_symbols_overview` | Understanding file/module structure without reading entire files |
| `find_referencing_symbols` | Finding all callers/users of a symbol — critical for safe refactoring |
| `search_for_pattern` | Regex search when symbol name is unknown |
| `replace_symbol_body` | Replacing entire function/class bodies with structural awareness |
| `insert_before_symbol` / `insert_after_symbol` | Adding code at precise structural locations |
| `rename_symbol` | Safe renames that update all references |
| `replace_content` | Regex-based replacement within files |

**Proactive use:** When exploring unfamiliar code, start with `get_symbols_overview` and `find_symbol` before reading full files. Use `find_referencing_symbols` before modifying any public API.

## Context7 (`mcp__plugin_context7_context7__*`)

Up-to-date library documentation. **Use instead of web search for library/framework questions.**

| Tool | When to Use |
|------|-------------|
| `resolve-library-id` | Finding the Context7 ID for a library |
| `query-docs` | Getting current API docs, examples, and usage patterns |

**Proactive use:** When writing code that uses external libraries, query Context7 for current API docs rather than relying on training data which may be outdated.

## Graphite (`mcp__graphite__*`)

Stacked PR management and merge queue. **Use for all PR stacking and submission.**

| Tool | When to Use |
|------|-------------|
| `run_gt_cmd` | Execute any `gt` command: `create`, `submit`, `modify`, `restack`, `sync`, `checkout` |
| `learn_gt` | Learn Graphite stacking workflow and available commands |

### Key commands via `run_gt_cmd`

| Instead of | Use |
|------------|-----|
| `git commit` + `git push` | `gt create -m "message"` then `gt submit --no-interactive --publish --merge-when-ready` |
| `gh pr create` | `gt submit --no-interactive --publish --merge-when-ready` (creates stacked PRs automatically) |
| Manual rebasing | `gt restack` (rebases all PRs in the stack) |
| `git checkout <branch>` | `gt checkout` (interactive branch selection) |

**Proactive use:** When the workflow involves stacked PRs or progressive merging (e.g., `/delegate` with multiple tasks), use `mcp__graphite__run_gt_cmd` for stack management rather than raw git commands or `gh pr create`.

## Microsoft Learn (`mcp__microsoft-learn__*`)

Official Microsoft/Azure documentation via remote HTTP MCP. **Use for any Microsoft technology questions.**

| Tool | When to Use |
|------|-------------|
| `search` | Quick overview of Azure/.NET/M365 topics |
| `get-code-samples` | Finding working code examples for Microsoft SDKs |
| `get-document` | Deep-reading full docs when search excerpts aren't enough |

**Proactive use:** When working with .NET, Azure, or any Microsoft SDK, search docs to verify API usage rather than guessing from training data.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Grep for class definitions | Use Serena `find_symbol` |
| Ask user to paste PR content | Use GitHub `pull_request_read` |
| Use `gh pr create` or `create_pull_request` | Use Graphite `gt submit --no-interactive --publish --merge-when-ready` for ALL PR creation |
| Use `gh pr view` | Use GitHub `pull_request_read` with method `get` |
| Use `gh pr list` | Use GitHub `list_pull_requests` or `search_pull_requests` |
| Use `gh pr diff` | Use GitHub `pull_request_read` with method `get_diff` |
| Use `gh pr checks` | Use GitHub `pull_request_read` with method `get_status` |
| Use `gh pr merge` | Use GitHub `merge_pull_request` |
| Use `gh api repos/.../pulls/.../comments` | Use GitHub `pull_request_read` with method `get_review_comments` |
| Use `gh api` for any GitHub data | Use the corresponding GitHub MCP tool |
| Use `gh issue view` or `gh issue list` | Use GitHub `issue_read` or `list_issues` / `search_issues` |
| Use `gh pr view --json` for structured data | Use GitHub MCP tools which return structured data natively |
| Guess library APIs from memory | Use Context7 `query-docs` |
| Manually edit workflow state JSON | Use `mcp__exarchos__exarchos_workflow` with `action: "set"` |
| Web search for .NET API reference | Use Microsoft Learn `search` |
| Read entire files to find a function | Use Serena `get_symbols_overview` then `find_symbol` with `include_body` |
| Use `git commit` or `git push` | Use `gt create` + `gt submit --no-interactive --publish --merge-when-ready` |
| Use grep/rg to search code patterns | Use Serena `search_for_pattern` for regex search |
| Use sed/awk for code replacement | Use Serena `replace_content` or `replace_symbol_body` |
| Read entire files to understand structure | Use Serena `get_symbols_overview` then `find_symbol` with `include_body` |
| Generate diffs with shell commands | Use GitHub `pull_request_read` or Graphite `gt diff` |
| Manually parse PR comments | Use GitHub `pull_request_read` for structured review data |
| Skip state reconciliation on resume | The SessionStart hook handles reconciliation automatically |
