---
name: delegation
description: "Dispatch implementation tasks to agent teammates in git worktrees. Use when the user says 'delegate', 'dispatch tasks', 'assign work', 'delegate tasks', or runs /delegate. Spawns teammates, creates worktrees, monitors progress, and collects results. Supports --fixes flag for review finding remediation. Do NOT use for single-file changes or polish-track refactors."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: delegate
---

# Delegation Skill

## Overview

Dispatch implementation tasks to Claude Code subagents with proper context and TDD requirements.

## Triggers

Activate this skill when:
- User runs `/delegate` command
- Implementation plan is ready
- User wants to parallelize work
- Tasks are ready for execution

## Delegation Modes

### Dispatch Mode Selection

| Mode | Mechanism | Best for |
|------|-----------|----------|
| `subagent` (default) | `Task` with `run_in_background` | 1-3 independent tasks, CI, headless |
| `agent-team` | `Task` with `team_name` | 3+ interdependent tasks, interactive sessions |

**When to choose each mode:**

| Criteria | Subagent | Agent Team |
|----------|----------|------------|
| Environment | Any terminal | tmux or iTerm2 required |
| Task dependencies | Independent or simple chains | Complex dependency graphs (native `addBlockedBy`) |
| Monitoring | Orchestrator polls `TaskOutput` | Visual split panes + tiered hook monitoring |
| Coordination | Orchestrator-managed state | Event-first saga with hook-driven completion |

**Auto-detection:** If inside tmux (`$TMUX` non-empty) AND `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var is set → `agent-team`. Otherwise → `subagent`. User can override via `/delegate --mode subagent|agent-team`.

### Task Tool (Subagents)

**Use when:**
- Need immediate results
- Task requires orchestrator coordination
- Want in-session execution
- Working in worktrees

**Tool:** Claude Code `Task` tool with `model: "opus"`

**CRITICAL:** Always specify `model: "opus"` for coding tasks to use Opus 4.5.

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for coding
  description: "Implement user model",
  prompt: `[Full implementer prompt from template]`
})
```

### Agent Teams (Teammates)

Agent-team delegation follows a 6-step **event-first saga**: emit event → execute side effect. See "Delegation Workflow — Agent Team Mode" below.

For event payload details and full YAML examples, see `references/agent-teams-saga.md`.
For adaptive team composition using historical metrics, see `references/adaptive-orchestration.md`.

## Controller Responsibilities

The orchestrator (you) MUST:

1. **Extract tasks upfront** — Read plan, extract all task details
2. **Provide full context** — Never make subagents read files for task info
3. **Include TDD requirements** — Use implementer prompt template
4. **Track progress** — TodoWrite (subagent) or native TaskList (agent-team)
5. **Set up worktrees** — For parallel execution
6. **Single-writer discipline** (agent-team) — Only the orchestrator mutates `workflow.tasks[]`. Hooks emit events only.

## Implementer Prompt Template

Use `@skills/delegation/references/implementer-prompt.md` as template for Task tool prompts.

**Key sections:**
- Task description (full text, not file references)
- File paths to modify
- Test requirements (TDD phases)
- Property-based testing patterns (conditional)
- Success criteria
- Working directory (worktree path)

**Conditional PBT section:** When a task has `testingStrategy.propertyTests: true`, include the "Property-Based Testing Patterns" section from `references/pbt-patterns.md` in the implementer prompt. This section provides framework-specific patterns (fast-check for TypeScript, FsCheck for .NET) and integrates with the TDD RED phase. When `propertyTests: false`, omit the section entirely.

## Delegation Workflow — Subagent Mode

1. Prepare worktrees — `scripts/setup-worktree.sh`
2. Extract task details from plan
3. Create TodoWrite entries for tracking
4. Dispatch parallel subagents via Task tool
5. Monitor progress via TaskOutput
6. Collect and verify — `scripts/post-delegation-check.sh`
7. Schema sync if API files modified

For detailed step instructions, see `references/workflow-steps.md`.

## Delegation Workflow — Agent Team Mode (6-Step Saga)

Follow the event-first saga: **emit event → execute side effect** at every step.

| Step | Action | Type | Key API |
|------|--------|------|---------|
| Pre-flight | Read tasks, prepare worktrees | — | `exarchos_workflow get`, `setup-worktree.sh` |
| 1 | Create team | Compensable | `exarchos_event append` → `TeamCreate` |
| 2 | Create native tasks (batched) | Compensable | `exarchos_event batch_append` → `TaskCreate` x N |
| 3 | Spawn teammates (**pivot**) | Point of no return | `exarchos_event append` → `Task(team_name)` x N |
| 4 | Monitor | Retryable | `exarchos_view workflow_status` (tiered) |
| 5 | Disband | Retryable | `SendMessage(shutdown_request)` → `TeamDelete` |
| 6 | Transition | Retryable | `exarchos_workflow set phase: "review"` |

**Critical rules:**
- Emit `exarchos_event` BEFORE executing each native API call (event-first ordering)
- Use `batch_append` in Step 2 to emit all `team.task.planned` events atomically
- Store `nativeTaskId` in `workflow.tasks[]` after each `TaskCreate` return (Step 2)
- Use `@skills/delegation/references/implementer-prompt.md` with Agent Teams sections **included** for spawn prompts (Step 3)
- Do NOT set `mode` at spawn — teammates inherit the lead's permission mode
- Do NOT use `exarchos_orchestrate task_complete` — TeammateIdle hook handles completion
- On failure at any step: compensate in reverse order (Steps 1-2 are compensable; Step 3 is the pivot)

For step-by-step instructions, idempotency checks, compensation protocol, tiered monitoring strategy, and event payloads, see `references/agent-teams-saga.md`.

## Parallel Execution Strategy

Dispatch parallel tasks in a single message with multiple Task calls. See `@skills/delegation/references/parallel-strategy.md` for group identification, dispatching patterns, and model selection.

## Worktree Enforcement (MANDATORY)

All tasks MUST run in isolated worktrees. Use `scripts/setup-worktree.sh` for setup.

### Pre-Dispatch Validation

Before dispatching to each worktree:
1. Run: `scripts/verify-worktree.sh --cwd <path>`
2. If exit 1: stop dispatch, report invalid worktree

For detailed enforcement rules, pre-dispatch checklist, and anti-patterns, see `references/worktree-enforcement.md`.

## State Management

This skill tracks task progress in workflow state for context persistence.

### Read Tasks from State

Instead of re-parsing plan, read task list using `mcp__exarchos__exarchos_workflow` with `action: "get"` with `query: "tasks"`. For status checks during monitoring, use `fields: ["tasks"]` to reduce response size.

### Subagent Mode State

**On Task Dispatch:** Update task status using `exarchos_workflow set`:
- Set task status to "in_progress" and startedAt timestamp
- If creating worktree, also set the worktree entry

**On Task Complete:** Update task status using `exarchos_workflow set`:
- Set task status to "complete" and completedAt timestamp

**On All Tasks Complete:** `exarchos_workflow set` → phase: "review"

### Agent Team Mode State (Single-Writer)

Only the orchestrator mutates `workflow.tasks[]` via `exarchos_workflow set`. Hooks emit events but never mutate state directly.

- **Step 2:** Store `nativeTaskId` from each `TaskCreate` return value
- **Step 4:** Read `team.task.completed` events during monitoring, update task status
- **Staleness:** 30-60s projection lag is acceptable — native task dependency unblocking is automatic

For the three-layer consistency model, drift recovery, and eventual consistency details, see `references/agent-teams-saga.md`.

## Fix Mode (--fixes)

When invoked with `--fixes`, delegation handles review failures instead of initial implementation. Uses fixer-prompt template, dispatches fix tasks per issue, then re-invokes review.

**Arguments:** `--fixes <state-file-path>` where `<state-file-path>` is the workflow state JSON containing review results in `.reviews.<taskId>.specReview` or `.reviews.<taskId>.qualityReview`.

For detailed fix mode process, task structure, and transition flow, see `@skills/delegation/references/fix-mode.md`.

## Completion Criteria

- [ ] All tasks extracted from plan (or read from state)
- [ ] Worktrees created for parallel groups
- [ ] All worktrees validated via verify-worktree.sh
- [ ] State file updated with worktree locations
- [ ] TodoWrite updated with all tasks
- [ ] Implementers dispatched with full context
- [ ] All tasks report completion
- [ ] All tests pass in worktrees
- [ ] Schema sync run if API files modified
- [ ] State file reflects all task completions

## Transition

After all tasks complete, **auto-continue immediately** (no user confirmation):

### Pre-Chain Validation (MANDATORY)

Before invoking `/review`:
1. Verify all `tasks[].status === 'complete'` in workflow state
2. If incomplete tasks exist: "Not all tasks complete, cannot proceed to review"

### Chain Steps

1. Update state: `.phase = "review"`, mark all tasks complete
2. Output: "All [N] tasks complete. Auto-continuing to review..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "<plan-path>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.
State is saved, enabling recovery after context compaction.

## Known Limitations

**Agent Teams mode:**
- No session resumption with in-process teammates (`/resume` doesn't restore them)
- Task status can lag — teammates sometimes fail to mark tasks complete
- One team per session
- No nested teams (teammates can't spawn sub-teammates)
- Split panes require tmux or iTerm2 (not VS Code terminal, Windows Terminal, or Ghostty)
- **TeamPerformanceView cold start:** First delegation in a project has no historical data. Falls back to plan's parallel group strategy for team sizing. Metrics accumulate across delegations.

**Task Tool mode:**
- No visual monitoring
- Individual context windows per task
- Limited observability

## Troubleshooting

See `@skills/delegation/references/troubleshooting.md` for detailed troubleshooting covering MCP tool failures, state desync, worktree creation, teammate spawn timeouts, and task claim conflicts.

## Exarchos Integration

### Subagent Mode Events

When using subagent mode (`Task` tool), emit events at each delegation milestone:

1. **Delegation start:** `exarchos_event` append `workflow.started` (if not already emitted)
2. **Task dispatch:** Launch subagents via Claude Code `Task` tool
3. **Task assignment:** `exarchos_event` append `task.assigned` with taskId, title, branch, worktree
4. **Monitor:** `exarchos_view` `workflow_status` or `exarchos_workflow` `get` with `fields: ["tasks"]`
5. **Task completion:** `exarchos_orchestrate` `task_complete` (auto-emits `task.completed`). Record stack positions via `exarchos_view` `stack_place`
6. **All complete:** Auto-emitted by `exarchos_workflow` `set` when phase transitions -- emits `workflow.transition`

### Agent Team Mode Events

Follow the 6-step saga above. Do NOT mix subagent-mode patterns (e.g., `exarchos_orchestrate task_complete`) with agent-team mode — the TeammateIdle hook handles completion signaling.

For event payload schemas and the full event catalog, see `references/agent-teams-saga.md`.

### Claim Guard (Subagent Mode Only)

Use `exarchos_orchestrate` `task_claim` for optimistic concurrency in subagent mode. On `ALREADY_CLAIMED`, skip the task and check status via `exarchos_view` `tasks` before re-dispatching.

> **Note:** Claim guards are not needed in agent-team mode. Native task dependencies and the `addBlockedBy` mechanism handle coordination.
