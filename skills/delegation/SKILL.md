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

| Mode | Mechanism | Visualization | Best for |
|------|-----------|---------------|----------|
| `subagent` (default) | `Task` tool with `run_in_background` | None — orchestrator polls `TaskOutput` | Quick tasks, CI, non-interactive |
| `agent-team` | Natural language delegation to teammates | tmux split panes | Interactive sessions, complex coordination |

**Auto-detection logic:**
- If inside tmux AND Agent Teams enabled → default to `agent-team`
- Otherwise → default to `subagent`
- User can override via `/delegate --mode subagent` or `/delegate --mode agent-team`

> **Verification:** Agent Teams availability is controlled by the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` environment variable in your session settings. Check `~/.claude/settings.json` for the `env` block.

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

**Use when:**
- Running in tmux with Agent Teams enabled
- Tasks benefit from visual monitoring
- Complex coordination between tasks
- Interactive development sessions

**Mechanism:** Event-first delegation saga. Every coordination action is preceded by an Exarchos event emission. The event stream is the authoritative record; native API calls are side effects.

**Architectural principle:** Events record intent. Native API calls execute effects.

#### Delegation Saga (6 Steps)

The dispatch follows a saga pattern with compensable, pivot, and retryable transactions.

**Step 1: Create Team** (COMPENSABLE)

```yaml
# Emit event (source of truth)
exarchos_event append:
  stream: {featureId}
  event:
    type: "team.spawned"
    teamName: {featureId}
    teamSize: {N}
    taskCount: {M}
    dispatchMode: "agent-team"

# Execute side effect
TeamCreate:
  team_name: {featureId}
  description: "SDLC delegation for {featureId}"
```

Idempotency: before retrying, check if `~/.claude/teams/{featureId}/` already exists.

**Step 2: Create Native Tasks** (COMPENSABLE)

Emit ALL task planning events in a single batched call (1 MCP call instead of N):

```yaml
# Emit ALL task events in one batch (source of truth)
exarchos_event batch_append:
  stream: {featureId}
  events:
    - type: "team.task.planned"
      taskId: "task-001"
      title: {task.title}
      modules: {task.files}
      blockedBy: {task.blockedBy}
    - type: "team.task.planned"
      taskId: "task-002"
      ...
```

`batch_append` atomicity: acquires the stream lock once, validates all events, writes with sequential sequence numbers in a single append. All-or-nothing -- if any event fails validation, none are written.

Then create native tasks and wire dependencies:

```yaml
# Execute side effects (one TaskCreate per task)
TaskCreate:
  subject: {task.title}
  description: {task.fullDescription}
  activeForm: "Implementing {task.title}"
  # Returns nativeTaskId

# Wire dependencies (after ALL tasks created -- requires sequential creation)
TaskUpdate:
  taskId: {nativeTaskId}
  addBlockedBy: [{blockerNativeTaskIds}]
```

Idempotency: before retrying, check `TaskList` for existing tasks with matching subjects to avoid duplicates.

After all tasks are created, store the correlation (orchestrator is the **sole writer** of `workflow.tasks[]`):

```yaml
exarchos_workflow set:
  featureId: {featureId}
  updates:
    tasks: [{...task, nativeTaskId: "returned-id"}]
```

**Step 3: Spawn Teammates** (PIVOT -- point of no return)

> This is the **pivot transaction**. Once teammates start working, their side effects (file writes, commits, worktree modifications) cannot be cleanly reversed. Steps 1-2 are compensable; Step 3+ are not fully reversible.

For each teammate:

```yaml
# Emit event (source of truth)
exarchos_event append:
  stream: {featureId}
  event:
    type: "team.teammate.dispatched"
    teammateName: {name}
    worktreePath: {path}
    assignedTaskIds: [{taskIds}]
    model: "opus"

# Execute side effect
# Note: teammates inherit the lead's permission mode (per Claude Code docs).
# Do NOT set `mode` at spawn -- it is not respected.
Task:
  subagent_type: "general-purpose"
  team_name: {featureId}
  name: {teammateName}
  model: "opus"
  prompt: {spawnPrompt}  # See implementer-prompt.md template
```

**Step 4: Monitor** (RETRYABLE)

The orchestrator enters delegate mode (Shift+Tab). Hooks operate autonomously:
- **SubagentStart** -- injects live coordination data only (task status changes, newly unblocked tasks). Historical intelligence and team context are already in the spawn prompt.
- **TeammateIdle** -- runs quality gates, emits `team.task.completed` or `team.task.failed` events. Does NOT mutate `workflow.tasks[]` (single-writer principle). The orchestrator reads these events and updates state.

**Tiered monitoring strategy** (minimizes token cost):

| Tier | Tool | When | Cost |
|------|------|------|------|
| Routine | `exarchos_view workflow_status` | Every 30-60s | ~85 tokens |
| On task completion | `exarchos_workflow get` (fields: tasks) | When TeammateIdle fires | ~200 tokens |
| On-demand | `exarchos_view delegation_timeline` | Task stall or all complete | ~120 tokens |

Do NOT triple-read on every cycle. `delegation_timeline` replays the full event stream -- reserve for final summary or anomaly detection.

When the orchestrator detects `team.task.completed` events, it updates `workflow.tasks[]`:
```yaml
exarchos_workflow set:
  featureId: {featureId}
  updates:
    tasks: [{...task, status: "complete", completedAt: timestamp}]
```

**Step 5: Disband** (RETRYABLE)

When all tasks complete:

```yaml
# Emit event
exarchos_event append:
  stream: {featureId}
  event:
    type: "team.disbanded"
    totalDurationMs: {calculated}
    tasksCompleted: {count}
    tasksFailed: {count}

# Shutdown remaining teammates
SendMessage:
  type: "shutdown_request"
  recipient: {each remaining teammate}

# Cleanup native team (after all teammates confirm shutdown)
TeamDelete
```

**Step 6: Transition** (RETRYABLE)

```yaml
exarchos_workflow set:
  featureId: {featureId}
  phase: "review"
  # auto-emits workflow.transition event
```

#### Saga Compensation

When the saga fails at any step, compensate in reverse order:

| Failed At | Compensating Actions | Idempotency Check |
|-----------|---------------------|-------------------|
| Step 1 (team create) | `TeamDelete` | Check `~/.claude/teams/{featureId}/` exists before delete |
| Step 2 (task create) | Delete created tasks via `TaskUpdate(status: "deleted")` x created, then `TeamDelete` | Check `TaskList` for existing tasks before delete |
| Step 3 (spawn -- PIVOT) | `SendMessage(type: "shutdown_request")` x spawned teammates, delete tasks, `TeamDelete` | Check team config `members` array for active teammates |
| Step 4+ (monitoring) | `exarchos_workflow cancel` (handles full compensation) | Already idempotent via workflow state check |

Compensation steps themselves must be idempotent: deleting an already-deleted team is a no-op; shutting down an already-terminated teammate is a no-op.

If a compensating action itself fails after 3 retries, mark the workflow with `_compensationFailed: true` and emit `team.compensation.failed`. The SessionStart hook detects this on next session for manual resolution.

#### Claude Code Agent Teams Constraints

| Constraint | Impact |
|------------|--------|
| **No session resumption** for teammates | Teammates are ephemeral. On restart, SessionStart detects orphaned teams but cannot restore them. Spawn new teammates if delegation is incomplete. |
| **One team per session** | Naturally enforces single-orchestrator invariant. No additional locking needed. |
| **No nested teams** | Teammates cannot spawn sub-teams. Team composition is flat. |
| **Permissions inherit from lead** | Do NOT set `mode` at spawn -- not respected. All teammates inherit the lead's permission mode. |
| **Teammates load MCP automatically** | Exarchos MCP tools are available without explicit instruction. The spawn prompt guides WHICH tools to use, not HOW to access them. |

**CRITICAL:** Ensure your session is using the opus model for coding tasks. All teammates inherit the session model -- use Task tool dispatch if you need per-task model selection.

## Adaptive Orchestration

When using Agent Teams mode, the orchestrator can leverage historical data for smarter team composition:

### Pre-Delegation Intelligence

Before creating the team, query the TeamPerformanceView for historical teammate metrics:
- `exarchos_view` with `action: 'team_performance'` — teammate efficiency, module expertise, quality gate pass rates
- Use `synthesizeIntelligence()` from SubagentStart hook for historical fix-cycle patterns per module

### Team Composition

Informed by historical metrics:
- **Team sizing:** Use `teamSizing.avgTasksPerTeammate` to determine optimal teammate count
- **Task assignment:** Match modules to teammates with relevant `moduleExpertise`
- **Cold start:** When no historical data exists, fall back to plan's parallel groups for sizing

### Guard-Aware Task Graph

Before creating the native Claude Code task list:
1. Build a dependency graph from plan task `blockedBy` fields
2. Identify the critical path through the dependency chain
3. Front-load independent tasks for maximum parallelism
4. On TeammateIdle, scan the task graph for newly unblocked tasks (tasks whose `blockedBy` dependencies are all completed) so teammates can claim them

## Controller Responsibilities

The orchestrator (you) MUST:

1. **Extract tasks upfront** - Read plan, extract all task details
2. **Provide full context** - Never make subagents read files for task info
3. **Include TDD requirements** - Use implementer prompt template
4. **Track progress** - Use TodoWrite for all tasks
5. **Set up worktrees** - For parallel execution

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

## Delegation Workflow

1. Prepare worktrees -- `scripts/setup-worktree.sh`
2. Extract task details from plan
3. Create TodoWrite entries for tracking
4. Dispatch parallel subagents via Task tool
5. Monitor progress via TaskOutput
6. Collect and verify -- `scripts/post-delegation-check.sh`
7. Schema sync if API files modified

For detailed step instructions, see `references/workflow-steps.md`.

## Parallel Execution Strategy

Dispatch parallel tasks in a single message with multiple Task calls. See `@skills/delegation/references/parallel-strategy.md` for group identification, dispatching patterns, and model selection.

## Worktree Enforcement (MANDATORY)

All tasks MUST run in isolated worktrees. Use `scripts/setup-worktree.sh` for setup.

For detailed enforcement rules, pre-dispatch checklist, and anti-patterns, see `references/worktree-enforcement.md`.

## State Management

This skill tracks task progress in workflow state for context persistence.

### Read Tasks from State

Instead of re-parsing plan, read task list using `mcp__exarchos__exarchos_workflow` with `action: "get"` with `query: "tasks"`. For status checks during monitoring, use `fields: ["tasks"]` to reduce response size.

### On Task Dispatch

Update task status when dispatched using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Update the task's status to "in_progress"
- Set the task's startedAt timestamp

If creating worktree, also set the worktree entry with branch, status, and either taskId (single task) or tasks (multi-task).

### On Task Complete

Update task status when subagent reports completion using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Update the task's status to "complete"
- Set the task's completedAt timestamp

### On All Tasks Complete

Update phase using `mcp__exarchos__exarchos_workflow` with `action: "set"`:
- Set `phase` to "review"

## Fix Mode (--fixes)

When invoked with `--fixes`, delegation handles review failures instead of initial implementation. Uses fixer-prompt template, dispatches fix tasks per issue, then re-invokes review.

**Arguments:** `--fixes <state-file-path>` where `<state-file-path>` is the workflow state JSON containing review results in `.reviews.<taskId>.specReview` or `.reviews.<taskId>.qualityReview`.

For detailed fix mode process, task structure, and transition flow, see `@skills/delegation/references/fix-mode.md`.

## Completion Criteria

- [ ] All tasks extracted from plan (or read from state)
- [ ] Worktrees created for parallel groups
- [ ] State file updated with worktree locations
- [ ] TodoWrite updated with all tasks
- [ ] Implementers dispatched with full context
- [ ] All tasks report completion
- [ ] All tests pass in worktrees
- [ ] Schema sync run if API files modified
- [ ] State file reflects all task completions

## Transition

After all tasks complete, **auto-continue immediately** (no user confirmation):

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

When using agent-team mode, follow the 6-step delegation saga documented in the "Agent Teams (Teammates)" section above. The saga prescribes the exact event sequence. Do NOT mix subagent-mode event patterns with agent-team-mode patterns.

### Claim Guard (Subagent Mode Only)

Use `exarchos_orchestrate` `task_claim` for optimistic concurrency in subagent mode. On `ALREADY_CLAIMED`, skip the task and check status via `exarchos_view` `tasks` before re-dispatching.

> **Note:** Claim guards are not needed in agent-team mode. Native task dependencies and the `addBlockedBy` mechanism handle coordination.

### State Bridge (TeammateIdle)

When using Agent Teams mode, the `TeammateIdle` hook fires when a teammate completes its work and becomes idle. It bridges real-time Agent Teams coordination with the Exarchos event stream:

- **On quality pass:** Emits `team.task.completed` event to the event stream. Does NOT mutate `workflow.tasks[]` -- the orchestrator is the sole writer (single-writer principle).
- **On quality fail:** Returns exit code 2 (sends feedback to teammate, keeps it working). Emits `team.task.failed` event with gate results.
- **Circuit breaker:** On repeated quality failures, emits `team.task.failed` with circuit open signal.
- **Graceful degradation:** If no matching workflow/worktree found, gate still passes.

**Single-writer principle:** The orchestrator reads `team.task.completed` events during its monitoring loop and updates `workflow.tasks[]` via `exarchos_workflow set`. This eliminates CAS race conditions between hook and orchestrator writes. The 30-60s latency between event emission and projection update is acceptable -- native task dependency unblocking is automatic (handled by Claude Code) and unaffected by this delay.

This implements a **layered coordination** model:
- Agent Teams handles real-time dispatch and self-coordination
- Exarchos event stream records all lifecycle events (source of truth)
- Orchestrator materializes events into `workflow.tasks[]` (working projection)

### Agent Teams Event Emission

When using Agent Teams mode, the delegation saga emits events at each lifecycle boundary:

**Orchestrator-emitted events (saga steps):**
- `team.spawned` -- Step 1: team creation (includes teamName, teamSize, taskCount, dispatchMode)
- `team.task.planned` -- Step 2: task planning via `batch_append` (includes taskId, title, modules, blockedBy)
- `team.teammate.dispatched` -- Step 3: teammate spawn (includes teammateName, worktreePath, assignedTaskIds, model)
- `team.disbanded` -- Step 5: team disbandment (includes totalDurationMs, tasksCompleted, tasksFailed)

**Hook-emitted events (automatic via TeammateIdle):**
- `team.task.completed` -- After quality gates pass (includes taskId, teammateName, durationMs, filesChanged, testsPassed). Hook emits only; does NOT mutate workflow state.
- `team.task.failed` -- After quality gates fail (includes taskId, teammateName, failureReason, gateResults). Hook emits only.
- `team.context.injected` -- From SubagentStart hook (includes phase, toolsAvailable)

**Superseded events:**
- `team.task.assigned` -- Superseded by the combination of `team.task.planned` (Step 2) + `team.teammate.dispatched` (Step 3). Existing event streams may still contain `team.task.assigned` events; CQRS views handle both old and new types during the transition period.

**Tool usage by delegation mode:**

| Delegation Mode | Task Completion Signal | State Update |
|----------------|----------------------|--------------|
| **Subagent mode** | `exarchos_orchestrate task_complete` (auto-emits `task.completed`) | Orchestrator calls `exarchos_workflow set` |
| **Agent team mode** | TeammateIdle hook emits `team.task.completed` | Orchestrator reads event, calls `exarchos_workflow set` |

> **Important:** Do NOT use `exarchos_orchestrate task_complete` or `task_fail` during agent team delegation. The TeammateIdle hook handles completion signaling. Using both would produce duplicate events in the stream.

### Intelligence Views

Two CQRS views provide team analytics:

- `exarchos_view` with `action: 'team_performance'` — Query before delegation for team sizing and module assignment. Returns teammate metrics (tasks completed, avg duration, module expertise, quality gate pass rates) and team sizing recommendations.
- `exarchos_view` with `action: 'delegation_timeline'` — Query after delegation for retrospective analysis. Returns task timeline with bottleneck detection (longest task, blocking dependencies).
