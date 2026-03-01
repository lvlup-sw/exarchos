# Agent Teams Delegation Saga

Event-first delegation saga for Agent Teams mode. Every coordination action is preceded by an Exarchos event emission. The event stream is the authoritative record; native API calls are side effects.

**Architectural principle:** Events record intent. Native API calls execute effects.

## Delegation Saga (6 Steps)

The dispatch follows a saga pattern with compensable, pivot, and retryable transactions.

### Step 1: Create Team (COMPENSABLE)

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

### Gate: Team Verification

Before proceeding to Step 2:
1. Verify team config exists: `~/.claude/teams/{featureId}/config.json`
2. Verify config has valid `members` array
3. If check fails: emit `team.creation.failed` event, abort delegation

### Step 2: Create Native Tasks (COMPENSABLE)

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

### Step 3: Spawn Teammates (PIVOT -- point of no return)

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

> **Spawn prompt assembly:** `{spawnPrompt}` MUST include all universal sections from `implementer-prompt.md` (TDD Requirements, Files, Success Criteria, **Commit Strategy**, Completion) PLUS the Agent Teams-only sections (Coordination, Workflow Intelligence, Team Context, Historical Context). See the comparison table in `implementer-prompt.md` for the full section list. The Commit Strategy section with `git commit`/`git push` instructions is required — without it, teammates may skip pushing their work.

### Step 4: Monitor (RETRYABLE)

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

### Step 5: Disband (RETRYABLE)

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

### Step 6: Transition (RETRYABLE)

```yaml
exarchos_workflow set:
  featureId: {featureId}
  phase: "review"
  # auto-emits workflow.transition event
```

## Saga Compensation

When the saga fails at any step, compensate in reverse order:

| Failed At | Compensating Actions | Idempotency Check |
|-----------|---------------------|-------------------|
| Step 1 (team create) | `TeamDelete` | Check `~/.claude/teams/{featureId}/` exists before delete |
| Step 2 (task create) | Delete created tasks via `TaskUpdate(status: "deleted")` x created, then `TeamDelete` | Check `TaskList` for existing tasks before delete |
| Step 3 (spawn -- PIVOT) | `SendMessage(type: "shutdown_request")` x spawned teammates, delete tasks, `TeamDelete` | Check team config `members` array for active teammates |
| Step 4+ (monitoring) | `exarchos_workflow cancel` (handles full compensation) | Already idempotent via workflow state check |

Compensation steps themselves must be idempotent: deleting an already-deleted team is a no-op; shutting down an already-terminated teammate is a no-op.

If a compensating action itself fails after 3 retries, mark the workflow with `_compensationFailed: true` and emit `team.compensation.failed`. The SessionStart hook detects this on next session for manual resolution.

## Claude Code Agent Teams Constraints

| Constraint | Impact |
|------------|--------|
| **No session resumption** for teammates | Teammates are ephemeral. On restart, SessionStart detects orphaned teams but cannot restore them. Spawn new teammates if delegation is incomplete. |
| **One team per session** | Naturally enforces single-orchestrator invariant. No additional locking needed. |
| **No nested teams** | Teammates cannot spawn sub-teams. Team composition is flat. |
| **Permissions inherit from lead** | Do NOT set `mode` at spawn -- not respected. All teammates inherit the lead's permission mode. |
| **Teammates load MCP automatically** | Exarchos MCP tools are available without explicit instruction. The spawn prompt guides WHICH tools to use, not HOW to access them. |

**CRITICAL:** Ensure your session is using the opus model for coding tasks. All teammates inherit the session model -- use Task tool dispatch if you need per-task model selection.

## Event Payload Conventions

Keep event payloads lean. Move diagnostics to state files.

- `team.task.completed`: prefer `fileCount: number` over `filesChanged: string[]`
- `team.task.failed`: prefer `gateNames: string[]` (max 10) over `gateResults: Record<string, unknown>`
- `failureReason`: max 200 characters
- Move full diagnostics to state file `reviews[taskId]`, not event payloads

## State Bridge (TeammateIdle)

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

## Agent Teams Event Emission

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
