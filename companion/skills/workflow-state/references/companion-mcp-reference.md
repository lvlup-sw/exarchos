# Companion MCP Tool Reference

> Installed by exarchos-dev-tools companion (`npx @lvlup-sw/exarchos-dev`)

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

## Microsoft Learn (`mcp__microsoft-learn__*`)

Official Microsoft/Azure documentation via remote HTTP MCP. **Use for any Microsoft technology questions.**

| Tool | When to Use |
|------|-------------|
| `search` | Quick overview of Azure/.NET/M365 topics |
| `get-code-samples` | Finding working code examples for Microsoft SDKs |
| `get-document` | Deep-reading full docs when search excerpts aren't enough |

**Proactive use:** When working with .NET, Azure, or any Microsoft SDK, search docs to verify API usage rather than guessing from training data.

## Companion Tool Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Grep for class definitions | Use Serena `find_symbol` |
| Ask user to paste PR content | Use GitHub `pull_request_read` |
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
| Web search for .NET API reference | Use Microsoft Learn `search` |
| Read entire files to find functions or understand structure | Use Serena `get_symbols_overview` then `find_symbol` with `include_body` |
| Use grep/rg to search code patterns | Use Serena `search_for_pattern` for regex search |
| Use sed/awk for code replacement | Use Serena `replace_content` or `replace_symbol_body` |
| Generate diffs with shell commands | Use GitHub `pull_request_read` or `git diff main...HEAD` |
| Manually parse PR comments | Use GitHub `pull_request_read` for structured review data |
