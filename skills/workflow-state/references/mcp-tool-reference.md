# MCP Tool Reference

Detailed tool usage, methods, and anti-patterns for all installed MCP servers.

## Exarchos (`mcp__exarchos__*`)

Unified MCP server for workflow orchestration, event sourcing, CQRS views, and task coordination. **Always use for workflow tracking.** Exposes 5 composite tools with action discriminators. Note: inter-agent messaging uses Claude Code's native Agent Teams, not Exarchos.

### Composite Tools

| Tool | Actions | When to Use |
|------|---------|-------------|
| `mcp__exarchos__exarchos_workflow` | `init`, `get`, `set`, `cancel`, `cleanup` | Workflow CRUD: starting workflows, reading/updating state, cancelling abandoned workflows, resolving merged workflows |
| `mcp__exarchos__exarchos_event` | `append`, `query` | Event sourcing: recording workflow events, reading event history |
| `mcp__exarchos__exarchos_orchestrate` | `task_claim`, `task_complete`, `task_fail` | Task coordination and lifecycle |
| `mcp__exarchos__exarchos_view` | `pipeline`, `tasks`, `workflow_status`, `stack_status`, `stack_place` | CQRS materialized views for read-optimized queries |
| `mcp__exarchos__exarchos_sync` | `now` | Force sync of materialized views |

### Workflow Tool Actions

| Action | When to Use |
|--------|-------------|
| `init` | Starting any `/exarchos:ideate`, `/exarchos:debug`, or `/exarchos:refactor` workflow |
| `get` | Restoring context, checking phase, reading task details. Use `query` for dot-path lookup (e.g., `query: "phase"`), or `fields` array for projection (e.g., `fields: ["phase", "tasks"]`) to reduce token cost |
| `set` | Updating phase (`phase: "delegate"`), recording artifacts, marking tasks complete. Use `updates` for field changes and `phase` for transitions |
| `cancel` | Cleaning up abandoned workflows. Supports `dryRun: true` to preview cleanup actions |
| `cleanup` | Resolve a merged workflow to completed. Verifies merge, backfills synthesis metadata, force-resolves reviews, transitions to completed. Requires `mergeVerified: true` — pass after verifying PRs are merged via GitHub API |

**Hooks (automatic, no tool call needed):**
- **SessionStart hook** — Discovers active workflows, restores context, determines next action, and verifies state on resume (replaces former `workflow_list`, `workflow_summary`, `workflow_next_action`, `workflow_reconcile` tools)
- **PreCompact hook** — Saves checkpoints before context exhaustion (replaces former `workflow_checkpoint` tool)
- Valid phase transitions are documented in `references/phase-transitions.md` (replaces former `workflow_transitions` tool). `INVALID_TRANSITION` errors include valid targets with guard descriptions.

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
> Available with exarchos-dev-tools companion. Fallback: use `gh` CLI.

## Serena (`mcp__plugin_serena_serena__*`)
> Available with exarchos-dev-tools companion. Fallback: use Grep/Read/Glob.

## Context7 (`mcp__plugin_context7_context7__*`)
> Available with exarchos-dev-tools companion. Fallback: use WebSearch.

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

**Proactive use:** When the workflow involves stacked PRs or progressive merging (e.g., `/exarchos:delegate` with multiple tasks), use `mcp__graphite__run_gt_cmd` for stack management rather than raw git commands or `gh pr create`.

## Microsoft Learn (`mcp__microsoft-learn__*`)
> Available with exarchos-dev-tools companion. Fallback: use WebSearch.

## Workflow Transition Errors

### INVALID_TRANSITION
No path exists from current phase to target. Check `validTargets` in the error — it lists reachable phases with guard descriptions. You may need to step through intermediate phases.

### GUARD_FAILED
The transition exists but the guard condition is unmet. Send prerequisite `updates` and `phase` in a **single** `set` call — updates apply before guards evaluate. See `references/phase-transitions.md` for guard prerequisites.

### CIRCUIT_OPEN
A compound state's fix cycle limit was reached. Escalate to user or cancel the workflow.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Use `gh pr create` or `create_pull_request` | Use Graphite `gt submit --no-interactive --publish --merge-when-ready` for ALL PR creation |
| Manually edit workflow state JSON | Use `mcp__exarchos__exarchos_workflow` with `action: "set"` |
| Use `git commit` or `git push` | Use `gt create` + `gt submit --no-interactive --publish --merge-when-ready` |
| Skip state reconciliation on resume | The SessionStart hook handles reconciliation automatically |

> See companion reference for additional tool anti-patterns (Serena, GitHub MCP, Context7).
