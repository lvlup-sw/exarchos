# MCP Tool Guidance

Proactively use the installed MCP servers. Don't fall back to generic approaches when a specialized tool exists.

## Available MCP Servers

### Workflow State (`mcp__workflow-state__*`)

Persistent state machine for workflow orchestration. **Always use for workflow tracking.**

| Tool | When to Use |
|------|-------------|
| `workflow_init` | Starting any `/ideate`, `/debug`, or `/refactor` workflow |
| `workflow_get` | Restoring context, checking phase, reading task details |
| `workflow_set` | Updating phase, recording artifacts, marking tasks complete |
| `workflow_summary` | Quick context restoration after session restart |
| `workflow_next_action` | Determining what to auto-continue after phase completion |
| `workflow_reconcile` | Verifying state matches git reality on resume; with `repair: true`, auto-fixes common corruption (missing `_events`, invalid `_eventSequence`, null `_checkpoint`, bad task statuses) |
| `workflow_checkpoint` | Saving progress before likely context exhaustion |
| `workflow_cancel` | Cleaning up abandoned workflows |
| `workflow_transitions` | Checking valid phase transitions |
| `workflow_list` | Finding active workflows at session start |

### GitHub (`mcp__plugin_github_github__*`)

GitHub platform integration. **Prefer over `gh` CLI when structured data is needed.**

| Tool | When to Use |
|------|-------------|
| `get_file_contents` | Reading files from remote repos or other branches |
| `search_code` | Finding code patterns across repositories |
| `search_issues` | Checking for existing issues before creating new ones |
| `list_pull_requests` / `search_pull_requests` | Finding related PRs |
| `pull_request_read` | Reading PR details, diffs, review status |
| `create_pull_request` | Creating PRs with structured metadata |
| `issue_read` / `issue_write` | Reading/managing issues |
| `list_commits` / `get_commit` | Examining commit history |
| `list_branches` / `create_branch` | Branch management |
| `add_issue_comment` | Commenting on issues |
| `pull_request_review_write` | Submitting PR reviews |

**Proactive use:** When the user mentions a PR number, issue, or GitHub URL, use these tools to fetch context rather than asking the user to paste content.

### Serena (`mcp__plugin_serena_serena__*`)

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

### Context7 (`mcp__plugin_context7_context7__*`)

Up-to-date library documentation. **Use instead of web search for library/framework questions.**

| Tool | When to Use |
|------|-------------|
| `resolve-library-id` | Finding the Context7 ID for a library |
| `query-docs` | Getting current API docs, examples, and usage patterns |

**Proactive use:** When writing code that uses external libraries, query Context7 for current API docs rather than relying on training data which may be outdated.

### Graphite (`mcp__graphite__*`)

Stacked PR management and merge queue. **Use for all PR stacking and submission.**

| Tool | When to Use |
|------|-------------|
| `run_gt_cmd` | Execute any `gt` command: `create`, `submit`, `modify`, `restack`, `sync`, `checkout` |
| `learn_gt` | Learn Graphite stacking workflow and available commands |

**Key commands via `run_gt_cmd`:**

| Instead of | Use |
|------------|-----|
| `git commit` + `git push` | `gt create -m "message"` then `gt submit --no-interactive` |
| `gh pr create` | `gt submit --no-interactive` (creates stacked PRs automatically) |
| Manual rebasing | `gt restack` (rebases all PRs in the stack) |
| `git checkout <branch>` | `gt checkout` (interactive branch selection) |

**Proactive use:** When the workflow involves stacked PRs or progressive merging (e.g., `/delegate` with multiple tasks), use `mcp__graphite__run_gt_cmd` for stack management rather than raw git commands or `gh pr create`.

### Microsoft Docs (`mcp__plugin_microsoft-docs_microsoft-learn__*`)

Official Microsoft/Azure documentation. **Use for any Microsoft technology questions.**

| Tool | When to Use |
|------|-------------|
| `microsoft_docs_search` | Quick overview of Azure/.NET/M365 topics |
| `microsoft_code_sample_search` | Finding working code examples for Microsoft SDKs |
| `microsoft_docs_fetch` | Deep-reading full docs when search excerpts aren't enough |

**Proactive use:** When working with .NET, Azure, or any Microsoft SDK, search docs to verify API usage rather than guessing from training data.

## Tool Selection Priority

When deciding which tool to use:

1. **Workflow tracking** — Always use workflow-state MCP for state, never manual JSON files
2. **Code structure** — Prefer Serena's `find_symbol` / `get_symbols_overview` over grep for understanding code architecture
3. **GitHub operations** — Use GitHub MCP for all PR/issue operations (`create_pull_request`, `merge_pull_request`, `pull_request_read`, `issue_read`); reserve `gh` CLI only for niche operations not covered by MCP
4. **Stacked PRs** — Use Graphite MCP for stack management, PR submission, and merge queue
5. **Library docs** — Use Context7 before web search for library documentation
6. **Microsoft tech** — Use Microsoft Docs MCP for any Azure/.NET/Microsoft question

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Grep for class definitions | Use Serena `find_symbol` |
| Ask user to paste PR content | Use GitHub `pull_request_read` |
| Use `gh pr create` | Use GitHub `create_pull_request` |
| Use `gh pr merge` | Use GitHub `merge_pull_request` |
| Use `gh api repos/.../pulls/.../comments` | Use GitHub `pull_request_read` |
| Guess library APIs from memory | Use Context7 `query-docs` |
| Manually edit workflow state JSON | Use `workflow_set` MCP tool |
| Web search for .NET API reference | Use `microsoft_docs_search` |
| Read entire files to find a function | Use Serena `get_symbols_overview` then `find_symbol` with `include_body` |
| Use `gh pr create` for stacked PRs | Use `mcp__graphite__run_gt_cmd` with `gt create` + `gt submit` |
| Use `git commit` + `git push` during delegation | Use `gt create` + `gt submit --no-interactive` for progressive stacking |
