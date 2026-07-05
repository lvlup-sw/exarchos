# MCP Tool Reference

Detailed tool usage, methods, and anti-patterns for all installed MCP servers.

## Exarchos (`mcp__plugin_exarchos_exarchos__*`)

Unified MCP server for workflow orchestration, event sourcing, CQRS views, and task coordination. **Always use for workflow tracking.** Exposes 5 composite tools with action discriminators. Note: inter-agent messaging uses Claude Code's native Agent Teams, not Exarchos.

### Composite Tools

| Tool | Actions | When to Use |
|------|---------|-------------|
| `mcp__plugin_exarchos_exarchos__exarchos_workflow` | `init`, `get`, `transition`, `update`, `cancel`, `cleanup`, `reconcile`, `rehydrate`, `checkpoint`, `describe` | Workflow CRUD: starting workflows, reading/updating state, transitioning phases, cancelling abandoned workflows, resolving merged workflows |
| `mcp__plugin_exarchos_exarchos__exarchos_event` | `append`, `query` | Event sourcing: recording workflow events, reading event history |
| `mcp__plugin_exarchos_exarchos__exarchos_orchestrate` | `task_claim`, `task_complete`, `task_fail` | Task coordination and lifecycle |
| `mcp__plugin_exarchos_exarchos__exarchos_view` | `pipeline`, `tasks`, `workflow_status`, `stack_status`, `stack_place` | CQRS materialized views for read-optimized queries |
| `mcp__plugin_exarchos_exarchos__exarchos_sync` | `now` | Force sync of materialized views |

### Workflow Tool Actions

| Action | When to Use |
|--------|-------------|
| `init` | Starting any `/exarchos:ideate`, `/exarchos:debug`, or `/exarchos:refactor` workflow |
| `get` | Restoring context, checking phase, reading task details. Use `query` for dot-path lookup (e.g., `query: "phase"`), or `fields` array for projection (e.g., `fields: ["phase", "tasks"]`) to reduce token cost |
| `transition` | Advance to a target phase (`target: "delegate"`). Canonical phase-mutation surface — emits `workflow.transition`, runs HSM guards, returns `validTargets` + `expectedShape` on guard failure |
| `update` | Mutate non-phase state fields (`updates: { "artifacts.spec": "..." }`). Rejects `phase` in `updates` with a structured `INVALID_INPUT` pointing at `transition`. Emits `state.patched` |
| `cancel` | Cleaning up abandoned workflows. Supports `dryRun: true` to preview cleanup actions |
| `cleanup` | Resolve a merged workflow to completed. Verifies merge, backfills synthesis metadata, force-resolves reviews, transitions to completed. Requires `mergeVerified: true` — pass after verifying PRs are merged via GitHub API |

**Resume + checkpoint (explicit verbs, no implicit hooks):**
- **`rehydrate <featureId>`** — Re-injects workflow state and phase-playbook guidance into the current context. Run this at the start of any session that resumes a workflow. Replaces the former auto-running SessionStart hook.
- **`checkpoint`** — Captures a structured handoff (state, next-steps, suggestions) into the event store. Run this before context exhaustion or session handoff. Replaces the former auto-running PreCompact hook.
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
> Optional companion (`npx create-exarchos`). Fallback: use `gh` CLI.

## Serena (`mcp__plugin_serena_serena__*`)
> Optional companion (`npx create-exarchos`). Fallback: use Grep/Read/Glob.

## Context7 (`mcp__plugin_context7_context7__*`)
> Optional companion (`npx create-exarchos`). Fallback: use WebSearch.

## Microsoft Learn (`mcp__microsoft-learn__*`)
> Optional companion (`npx create-exarchos`). Fallback: use WebSearch.

## Workflow Transition Errors

### INVALID_TRANSITION
No path exists from current phase to target. Check `validTargets` in the error — it lists reachable phases with guard descriptions. You may need to step through intermediate phases.

### GUARD_FAILED
The transition exists but the guard condition is unmet. Apply the prerequisite state with `update`, then retry the `transition` — the `update`/`transition` split is enforced by the workflow tool (phase changes go through HSM guards, non-phase mutations don't). See `references/phase-transitions.md` for guard prerequisites.

### CIRCUIT_OPEN
A compound state's fix cycle limit was reached. Escalate to user or cancel the workflow.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Manually edit workflow state JSON | Use `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"` |
| Skip state reconciliation on resume | Run `rehydrate <featureId>` — it folds events newer than the last snapshot via the rehydration projection |

> See companion documentation for additional tool anti-patterns (Serena, GitHub MCP, Context7). Install companions: `npx create-exarchos`.
