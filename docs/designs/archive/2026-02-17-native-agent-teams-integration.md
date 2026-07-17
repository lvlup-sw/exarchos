# Design: Native Agent Teams Integration

## Problem Statement

Exarchos's delegation flow currently uses Agent Teams implicitly — the skill tells the orchestrator to "create a team" in natural language, and Claude Code figures out the rest. This creates three problems:

1. **Dual state** — Task status lives in both the native task list (`~/.claude/tasks/`) and Exarchos workflow state (`workflow.tasks[]`). They drift because no correlation exists between them.
2. **Opaque coordination** — Team creation, task assignment, and teammate spawning happen outside Exarchos's event stream. The event store has no record of these coordination actions, breaking event sourcing's "events are the source of truth" guarantee.
3. **Teammates are Exarchos-unaware** — Spawned teammates don't know how to query workflow state, emit progress events, or use Exarchos CQRS views. They operate in a coordination silo.

The goal: use Claude Code's native Agent Teams APIs (`TeamCreate`, `TaskCreate`/`TaskUpdate`/`TaskList`, `SendMessage`, `Task` with `team_name`) as directly as possible, with Exarchos providing the SDLC intelligence layer. Events first, native calls as side effects.

## Alternatives Considered

### Option 1: Skill-Directed Native Integration (Selected)

The delegation skill explicitly prescribes native API calls. Every coordination action is preceded by an Exarchos event emission. Hooks bridge the return path. No wrapper tools — the skill IS the integration layer.

**Best when:** You want minimal abstraction, maximum transparency, and Exarchos as the state/intelligence layer with native APIs doing coordination.

### Option 2: Orchestrate Composite Actions

Add actions to `exarchos_orchestrate` that wrap native API calls with event emission and state management. One MCP call = coordination + state. Atomic, but adds indirection. Fatal flaw: MCP servers can't call Claude Code's agent-side tools — the wrapper would need to return instructions, effectively becoming Option 1 with extra steps.

**Best when:** You want guaranteed atomicity and are willing to accept the indirection.

### Option 3: Event-Driven State Projection

The orchestrator uses native APIs freely with no prescribed sequence. Hooks observe all lifecycle events and project state from what happened. Maximum decoupling, but eventual consistency and no ability to enforce SDLC guards before coordination actions execute. Loses Exarchos's "in charge of orchestration" role.

**Best when:** You trust the orchestrator fully and want Exarchos as a passive intelligence layer only.

## Chosen Approach

**Skill-Directed Native Integration with Event-First Ordering.**

The delegation skill explicitly prescribes native API calls. Every coordination action is preceded by an Exarchos event emission. The event stream is the authoritative record; native API calls are side effects that execute the coordination. Hooks bridge the return path — lifecycle events flow back from native APIs into the Exarchos event store.

**Architectural principle:** Events record intent. Native API calls execute effects.

```
emit event → execute native API (side effect)
hook fires → emit event (return path)
CQRS views ← materialize from event stream (projections)
workflow.tasks[] ← updated via exarchos_workflow set (auto-emits events)
```

The delegation lifecycle is a **saga** — each step has a compensating action. If any step fails, prior steps are compensated via events + native API cleanup.

## Technical Design

### 1. Correlation Model

Native Agent Teams and Exarchos must share identifiers so hooks can correlate lifecycle events back to workflow tasks.

**Team name = featureId.** `TeamCreate` uses the workflow's `featureId` as the team name. This gives automatic directory correlation:

```
~/.claude/teams/{featureId}/config.json    ← native team config
~/.claude/tasks/{featureId}/               ← native task list
~/.claude/workflow-state/{featureId}.state.json  ← Exarchos state
~/.claude/workflow-state/{featureId}.events.jsonl ← Exarchos events
```

**Native task IDs in workflow state.** When `TaskCreate` returns a task ID, it's stored in `workflow.tasks[].nativeTaskId`. Hooks use this to correlate `TeammateIdle` events (which include `cwd`) back to the correct Exarchos task via worktree path matching.

```typescript
// workflow.tasks[] entry (extended)
interface WorkflowTask {
  id: string;              // Exarchos task ID (e.g., "task-001")
  nativeTaskId?: string;   // Claude Code TaskCreate ID
  title: string;
  status: "pending" | "in_progress" | "complete";
  branch: string;
  worktreePath: string;
  blockedBy: string[];     // Exarchos task IDs
  teammateName?: string;   // assigned teammate name
  startedAt?: string;
  completedAt?: string;
}
```

### 2. Delegation Saga

The delegation is a long-running saga with six steps. Each step follows the pattern: emit event → execute side effect. Compensation runs in reverse order on failure.

**Saga classification** (per [Microsoft Learn — Saga pattern](https://learn.microsoft.com/azure/architecture/patterns/saga)):
- **Orchestration-based** — the lead orchestrates all steps, not choreography
- **Compensable transactions:** Steps 1-2 (can be undone by deleting team/tasks)
- **Pivot transaction:** Step 3 (spawn teammates) — point of no return. Once teammates start working, their side effects (file writes, commits) can't be cleanly reversed.
- **Retryable transactions:** Steps 4-6 (monitoring, disband, transition — idempotent and re-executable)

```
┌──────────────────────────────────────────────────────────────────┐
│                    Delegation Saga                                │
│                                                                  │
│  Step 1: EMIT team.spawned → TeamCreate(featureId)     COMPENSABLE│
│          Compensate: TeamDelete()                                │
│          Idempotency: check ~/.claude/teams/{featureId}/ exists  │
│                                                                  │
│  Step 2: EMIT team.task.planned × N (BATCHED)          COMPENSABLE│
│          → TaskCreate × N (with addBlockedBy from plan)          │
│          → Store nativeTaskIds in workflow.tasks[]                │
│          Compensate: TaskUpdate(status: "deleted") × N           │
│          Idempotency: check TaskList for existing tasks          │
│                                                                  │
│  Step 3: EMIT team.teammate.dispatched × N             *** PIVOT │
│          → Task(team_name: featureId, ...) × N                   │
│          Compensate: SendMessage(type: "shutdown_request") × N   │
│          (Note: teammate work cannot be fully reversed)          │
│                                                                  │
│  Step 4: MONITOR (delegate mode + hooks pipeline)      RETRYABLE │
│          → TeammateIdle hooks emit team.task.completed/failed     │
│          → SubagentStart hooks inject live coordination data     │
│          Compensate: exarchos_workflow cancel                    │
│                                                                  │
│  Step 5: EMIT team.disbanded                           RETRYABLE │
│          → SendMessage(type: "shutdown_request") × remaining     │
│          → TeamDelete()                                          │
│                                                                  │
│  Step 6: TRANSITION to review                          RETRYABLE │
│          → exarchos_workflow set phase: "review"                  │
│          (auto-emits workflow.transition)                         │
└──────────────────────────────────────────────────────────────────┘
```

### 3. Event-First Dispatch Sequence

The delegation skill prescribes this exact sequence. The orchestrator follows it step by step.

#### Step 1: Create Team

```
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

#### Step 2: Create Native Tasks

Emit all task planning events in a single batched call to minimize token overhead (1 MCP call instead of N):

```
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

**`batch_append` atomicity:** The action acquires the stream's promise-chain lock once for the entire batch, validates all events against schema before appending any, then writes all events with sequential sequence numbers in a single file append. If any event fails validation, none are written (all-or-nothing). Per-event `idempotencyKey` fields are supported for retry safety.

Then create native tasks and wire dependencies:

```
# Execute side effects (one TaskCreate per task)
TaskCreate:
  subject: {task.title}
  description: {task.fullDescription}
  activeForm: "Implementing {task.title}"
  # Returns nativeTaskId

# Wire dependencies (after all tasks created)
TaskUpdate:
  taskId: {nativeTaskId}
  addBlockedBy: [{blockerNativeTaskIds}]

# Idempotency: before retrying, check TaskList for existing tasks
# with matching subjects to avoid duplicates
```

After all tasks are created, store the correlation (orchestrator is the **sole writer** of `workflow.tasks[]`):

```
exarchos_workflow set:
  featureId: {featureId}
  updates:
    tasks: [{...task, nativeTaskId: "returned-id"}]
```

#### Step 3: Spawn Teammates

For each teammate (determined by team sizing intelligence):

```
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
# Do NOT set `mode` at spawn — it is not respected. Change individually after spawn if needed.
Task:
  subagent_type: "general-purpose"
  team_name: {featureId}
  name: {teammateName}
  model: "opus"
  prompt: {spawnPrompt}  # See section 4
```

#### Step 4: Monitor

The orchestrator enters delegate mode. Hooks operate autonomously:

- **SubagentStart** → injects live coordination data only (current unblocked tasks, task list status changes). Historical intelligence and team context are already in the spawn prompt — hooks do NOT re-inject them.
- **TeammateIdle** → runs quality gates, emits `team.task.completed` or `team.task.failed` events. Does NOT mutate `workflow.tasks[]` — the orchestrator reads events and updates state (single-writer principle).
- **TaskCompleted** → parity enrichment for subagent mode

**Tiered monitoring strategy** (minimizes token cost):

| Tier | Tool | When | Response Cost |
|------|------|------|---------------|
| **Routine** | `exarchos_view workflow_status` | Every 30-60s | ~85 tokens |
| **On task completion** | `exarchos_workflow get` (fields: tasks) + update status from hook events | When TeammateIdle fires | ~200 tokens |
| **On-demand** | `exarchos_view delegation_timeline` | When a task stalls or all tasks complete | ~120 tokens |

The orchestrator does NOT triple-read on every cycle. `delegation_timeline` replays the full event stream — reserve it for final summary or anomaly detection.

#### Step 5: Disband

When all tasks complete:

```
# Emit event
exarchos_event append:
  stream: {featureId}
  event:
    type: "team.disbanded"
    totalDurationMs: {calculated}
    tasksCompleted: {count}
    tasksFailed: {count}

# Shutdown teammates
SendMessage:
  type: "shutdown_request"
  recipient: {each remaining teammate}

# Cleanup native team (after all teammates confirm shutdown)
TeamDelete
```

#### Step 6: Transition

```
exarchos_workflow set:
  featureId: {featureId}
  phase: "review"
  # auto-emits workflow.transition event
```

### 4. Teammate Spawn Prompt

Teammates automatically load project context (CLAUDE.md, MCP servers, skills) per [Claude Code Agent Teams docs](https://code.claude.com/docs/en/agent-teams#context-and-communication). They do NOT inherit the lead's conversation history. The spawn prompt provides task-specific context only — Exarchos MCP tools are already available without explicit instruction. The template includes:

```markdown
You are an implementer teammate in the "{featureId}" agent team.

## Working Directory
{worktreePath}

## Your Tasks
{taskDescriptions}

## Coordination (Native APIs)
- Use `TaskList` to see available tasks and their statuses
- Use `TaskUpdate` to mark tasks `in_progress` when you start and `completed` when done
- Use `SendMessage` to communicate findings to teammates or the lead

## Workflow Intelligence (Exarchos MCP)
- Use `exarchos_workflow get` to query current workflow state
- Use `exarchos_view tasks` to see task details across the team
- Use `exarchos_event append` to report TDD phase transitions:
    stream: "{featureId}"
    event: { type: "task.progress", taskId: "{taskId}", phase: "red|green|refactor" }

## Historical Context
{historicalIntelligence}

## Team Context
{teamComposition}

## TDD Requirements
Strict Red-Green-Refactor. See project rules for details.

## Commit Strategy
1. Work on feature branch in your worktree
2. `gt create {branchName} -m "feat: {description}"`
3. Notify lead when complete via `SendMessage`
```

### 5. Hook Changes

#### TeammateIdle (gates.ts) — Event Emitter Only

**Single-writer principle:** The TeammateIdle hook emits events but does NOT mutate `workflow.tasks[]`. The orchestrator is the sole writer of workflow state. This eliminates CAS race conditions and aligns with event sourcing purity.

Changes needed:

1. **Correlate via team config.** Read team config (try `~/.claude/teams/{featureId}/config.json` then `~/.claude/teams/{featureId}.json`) to map teammate name → Exarchos task via `workflow.tasks[].teammateName`.
2. **Emit events only.** After quality gates pass, emit `team.task.completed` event with structured payload. Do NOT call `commitTaskCompletion()` to mutate state. The orchestrator reads this event during monitoring and updates `workflow.tasks[]` via `exarchos_workflow set`.
3. **Remove `commitTaskCompletion()` call.** Replace with event emission only. The hook's return value signals the orchestrator to check for state updates.
4. **Retain circuit breaker.** On repeated quality failures, emit `team.task.failed` and signal circuit open — this remains unchanged.

**Follow-up detection latency tradeoff:** Removing `commitTaskCompletion()` means `workflow.tasks[]` projection updates now depend on the orchestrator's monitoring cadence (30-60s) instead of being immediate. However, **native task dependency unblocking is not affected** — per [Claude Code docs](https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks): "The system manages task dependencies automatically. When a teammate completes a task that other tasks depend on, blocked tasks unblock without manual intervention." The 30-60s latency only affects the Exarchos `workflow.tasks[]` projection, not actual teammate coordination. This is acceptable — the tradeoff eliminates CAS race conditions that caused silent update losses.

#### SubagentStart (subagent-context.ts) — Live Data Only

**Deduplication principle:** The spawn prompt already contains historical intelligence and team context (populated by the orchestrator at spawn time). The SubagentStart hook injects ONLY live coordination data that may have changed since the teammate was spawned.

Changes needed:

1. **Remove historical intelligence injection.** Do NOT call `queryModuleHistory()` or `synthesizeIntelligence()` — this data is already in the spawn prompt. Eliminates ~125 tokens of redundant injection per teammate.
2. **Remove static team context injection.** Do NOT inject team composition — already in spawn prompt. Eliminates ~30 tokens of redundant injection per teammate.
3. **Add live task status injection.** Read native task list from `~/.claude/tasks/{featureId}/` to inject current task statuses (which tasks completed since spawn, which are newly unblocked). This is the only data that changes between spawn and hook execution.
4. **Retain tool guidance.** Phase/role-filtered tool guidance remains — it's not in the spawn prompt and varies by phase.
5. **Skip injection for teammate sub-subagents during monitoring.** When the phase is `delegate` and the SubagentStart event originates from a teammate's subprocess (detected by cwd inside a worktree), skip all injection. Teammate sub-subagents (running tests, formatting, etc.) don't need coordination data — they inherit context from their parent teammate. This eliminates the largest actual token sink: repeated hook firings during active delegation.

#### SessionStart (session-start.ts) — Team Directory Detection

Current behavior handles orphaned teams. Changes needed:

1. **Check native team directory.** Try both `~/.claude/teams/{featureId}/config.json` and `~/.claude/teams/{featureId}.json` to detect orphaned native teams (team exists but no active teammates).
2. **Recommend cleanup.** If native team exists but workflow is past delegation phase, recommend `TeamDelete`.

### 6. Saga Compensation

When the delegation saga fails at any step, compensation runs in reverse. Per [Microsoft Learn](https://learn.microsoft.com/azure/architecture/patterns/saga#problems-and-considerations): "The system must handle transient failures effectively and ensure idempotence."

| Failed At | Type | Compensating Actions | Compensating Events | Idempotency Check |
|-----------|------|---------------------|-------------------|-------------------|
| Step 1 (team create) | Compensable | Delete team | `team.compensation` | Check `~/.claude/teams/{featureId}/` exists before delete |
| Step 2 (task create) | Compensable | Delete created tasks, delete team | `team.task.cancelled` × created, `team.compensation` | Check `TaskList` for existing tasks before delete |
| Step 3 (spawn) | **Pivot** | Shutdown spawned teammates, delete native tasks, delete team | `team.teammate.shutdown` × spawned, `team.task.cancelled` × created, `team.compensation` | Check team config `members` array for active teammates |
| Step 4 (monitoring) | Retryable | Shutdown all, cancel workflow | Full `exarchos_workflow cancel` saga | Already idempotent via workflow state check |

**Idempotency guidance for the skill:** Before retrying any failed step, verify the previous attempt's side effect. If `TeamCreate` fails mid-call, check if the team directory exists before retrying. If `TaskCreate` fails after some tasks were created, check `TaskList` to avoid duplicates. This follows the "reread values" countermeasure from the saga pattern.

Compensation is triggered by the orchestrator when it detects a failure. The skill prescribes the compensation sequence. `exarchos_workflow cancel` handles the full compensation for Step 4 failures (already implemented).

**Compensation failure fallback:** Per [Microsoft Learn](https://learn.microsoft.com/azure/architecture/patterns/saga#problems-and-considerations): *"Compensating transactions might not always succeed, which can leave the system in an inconsistent state."* If a compensating action itself fails (e.g., `TeamDelete` errors mid-rollback), the orchestrator must:

1. Retry the compensating action up to 3 times with exponential backoff.
2. If retries exhaust, mark the workflow with `_compensationFailed: true` and emit a `team.compensation.failed` event with the stuck step and error details.
3. The SessionStart hook detects `_compensationFailed` on next session and surfaces it for manual resolution.

Compensation steps themselves must be idempotent: deleting an already-deleted team must not error fatally; shutting down an already-terminated teammate must be a no-op.

### 7. State Consistency Model

Per [Microsoft Learn — Event Sourcing pattern](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing): "The event store acts as the single source of truth... materialized views function as a durable, read-only cache optimized for fast and efficient queries."

**Event stream** = source of truth (append-only, immutable)
**Native task list** = real-time coordination layer (mutable, ephemeral, session-scoped)
**workflow.tasks[]** = working projection (mutable, **single-writer: orchestrator only**)
**CQRS views** = read-only projections (materialized from events on query)

```
                    ┌─────────────────────┐
                    │   Event Stream       │
                    │   (JSONL, append)    │
                    │   SOURCE OF TRUTH    │
                    │                     │
                    │ team.spawned        │
                    │ team.task.planned   │
                    │ team.task.completed │◄── TeammateIdle hook (emitter)
                    │ team.disbanded      │
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────────┐
     │ CQRS Views │  │ workflow   │  │ Native Task    │
     │ (read-only │  │ .tasks[]   │  │ List           │
     │ projections│  │ (working   │  │ (coordination  │
     │ from events│  │  copy,     │  │  ephemeral,    │
     │ )          │  │ orchestr-  │  │  session-scoped│
     │            │  │ ator only) │  │ )              │
     └────────────┘  └────────────┘  └────────────────┘
                      ▲ SOLE WRITER
                      │
                  Orchestrator reads events,
                  updates via exarchos_workflow set
```

**Single-writer principle:** Only the orchestrator mutates `workflow.tasks[]` via `exarchos_workflow set`. Hooks emit events to the event stream but never mutate state directly. This eliminates:
- CAS race conditions between hook and orchestrator writes
- Silent update losses when CAS checks fail
- Dual-write inconsistencies

The orchestrator's monitoring loop reads `team.task.completed` events from the stream (or checks `exarchos_view workflow_status`) and updates `workflow.tasks[].status` accordingly.

**Invariants:**

1. **Single-orchestrator:** Only one orchestrator may target a given `featureId` at any time. Concurrent orchestrations against the same featureId produce lost-update anomalies. The `exarchos_workflow set` CAS check provides a detection mechanism but not prevention — the constraint is naturally enforced by Claude Code's [one team per session](https://code.claude.com/docs/en/agent-teams#limitations) limitation, combined with the convention of one session per feature.

2. **Reconstructibility:** `workflow.tasks[]` must be fully derivable from the event stream. Every mutation to `workflow.tasks[]` must have a corresponding event in the JSONL stream (`team.task.planned` for creation, `team.task.completed`/`team.task.failed` for status changes). If the projection diverges, replaying the event stream must produce an equivalent `tasks[]` state. This invariant is testable: `reconcileTasks()` (Task 009) verifies it.

3. **Append-only immutability:** Per [Microsoft Learn — Event Sourcing](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing): *"The event data should never be updated."* JSONL entries are never modified in place. Corrections are recorded as compensating events (e.g., `team.compensation`, `team.task.cancelled`), not edits to existing lines.

**Consistency guarantees:**
- Events are always written before side effects (native API calls)
- If a native call fails after event emission, a compensating event is emitted
- `workflow.tasks[]` is updated only by the orchestrator via `exarchos_workflow set`
- Native task list is ephemeral — it dies with the session. Events + workflow state survive.
- On session restart, `SessionStart` hook detects orphaned state and advises recovery

**Drift recovery:** If `workflow.tasks[]` and the native task list diverge (e.g., orchestrator missed an event), the orchestrator can reconcile by:
1. Reading native `TaskList` for current statuses
2. Comparing with `workflow.tasks[]`
3. Emitting correction events for any mismatches
4. Updating `workflow.tasks[]` via `exarchos_workflow set`

This is a manual reconciliation triggered by the orchestrator. The `exarchos_workflow reconcile` action is extended to handle task status reconciliation in addition to its current worktree/branch checks.

### 8. Eventual Consistency Windows

Per [Microsoft Learn — Event Sourcing](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing): *"The system will only be eventually consistent when creating materialized views... There's some delay between an application adding events to the event store... and the consumers of the events handling them."*

The three-layer architecture introduces specific consistency windows:

| Window | Source → Target | Max Staleness | Mitigation |
|--------|----------------|---------------|------------|
| **Event → workflow.tasks[]** | JSONL stream → working projection | Up to 60s (monitoring cadence) | Orchestrator polls `workflow_status` every 30-60s; reads events and updates tasks[] on each cycle |
| **workflow.tasks[] → native task list** | Exarchos state → Claude Code TaskList | Immediate (same write) | Orchestrator updates both in sequence: `exarchos_workflow set` then `TaskUpdate` |
| **Event → CQRS views** | JSONL stream → materialized views | On-demand (lazy materialization) | Views replay from events on each query; no cache staleness |
| **Native task list → teammates** | Claude Code TaskList → teammate's local view | Near-zero (native API) | Teammates read TaskList directly; native system handles consistency |

**Agent behavior on stale reads:** If a teammate reads a task as "pending" but another teammate has already completed it (event emitted but `workflow.tasks[]` not yet updated), the teammate will claim the task and discover the completed state when running quality gates. The TeammateIdle hook detects this (task already has completion event) and skips redundant emission. No work is lost — at worst, a teammate runs tests on already-passing code.

**Acceptable staleness:** The 30-60s window between event emission and projection update is the primary consistency gap. This is acceptable because:
- Teammates operate independently in isolated worktrees
- Native task dependency unblocking is **automatic** — per [Claude Code docs](https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks): "The system manages task dependencies automatically." The 30-60s latency only affects the Exarchos `workflow.tasks[]` projection, not actual teammate coordination.
- A 60s delay in projection updates is negligible relative to task execution time (typically 5-15 minutes)

### 9. Tool Role Clarification

#### `exarchos_orchestrate` during native team delegation

The existing `exarchos_orchestrate` tool has `task_complete` and `task_fail` actions that auto-emit `task.completed`/`task.failed` events. During **native agent team delegation**, these actions are **NOT used**. The completion signal path is:

1. TeammateIdle hook emits `team.task.completed` or `team.task.failed` event to the stream
2. Orchestrator reads these events during monitoring
3. Orchestrator updates `workflow.tasks[]` via `exarchos_workflow set`

Using `exarchos_orchestrate task_complete` in addition to the hook event would produce **duplicate completion events** in the stream, violating event sourcing expectations. `exarchos_orchestrate` remains the completion path for **subagent-mode** (non-team) delegation only.

| Delegation Mode | Task Completion Signal | State Update |
|----------------|----------------------|--------------|
| **Subagent mode** | `exarchos_orchestrate task_complete` (auto-emits `task.completed`) | Orchestrator calls `exarchos_workflow set` |
| **Agent team mode** | TeammateIdle hook emits `team.task.completed` | Orchestrator reads event, calls `exarchos_workflow set` |

#### `team.task.assigned` — superseded

The existing `team.task.assigned` event type is **superseded** by the combination of:
- `team.task.planned` — records task existence and metadata (Step 2)
- `team.teammate.dispatched` — records task→teammate assignment via `assignedTaskIds[]` (Step 3)

Existing event streams may still contain `team.task.assigned` events. New delegation sagas under this design emit the new pair instead. CQRS views and event consumers must handle both old and new event types during the transition period.

#### `batch_append` registry entry

The new `batch_append` action must be registered in `TOOL_REGISTRY` with phase affinity `delegate` and role `orchestrator`. This follows the existing composite tool convention — all actions are registered with correct phase/role sets for progressive disclosure.

### 10. Claude Code Agent Teams Constraints

Per the [official Agent Teams documentation](https://code.claude.com/docs/en/agent-teams#limitations):

| Constraint | Impact on Design |
|------------|-----------------|
| **No session resumption** for teammates | Teammates are ephemeral. On session restart, `SessionStart` detects orphaned team directories but cannot restore teammates. The orchestrator must spawn new teammates if delegation is incomplete. |
| **One team per session** | Naturally enforces single-orchestrator invariant (Invariant 1). No additional locking needed. |
| **No nested teams** | Teammates cannot spawn sub-teams. Team composition is flat. |
| **Permissions inherit from lead** | Do NOT set `mode` at spawn time — it is not respected per docs. All teammates inherit the lead's permission mode. |
| **Teammates load MCP servers automatically** | Exarchos MCP tools are available without explicit instruction in spawn prompt. The prompt provides WHICH tools to use and WHEN, not HOW to access them. |
| **Task status can lag** | Native task list may not reflect teammate completion immediately. The design's tiered monitoring and reconciliation (Task 009) handle this. |

## Integration Points

### No Changes Needed

| Component | Why |
|-----------|-----|
| CQRS materializer | Existing projection pattern handles new events |
| HSM state machine | Phase transitions unchanged |
| Quality gates | Gate CLI commands unchanged |
| Worktree management | `setup-worktree.sh` unchanged |
| Graphite integration | Stack management unchanged |

### Changes Needed

| Component | Change | Scope |
|-----------|--------|-------|
| **Event store (batch_append)** | Add `batch_append` action to accept array of events in single call | Code (new action) |
| **Delegation SKILL.md** | Rewrite dispatch flow with event-first saga, batched events, tiered monitoring | Content (Markdown) |
| **Implementer prompt template** | Add native API + Exarchos MCP usage sections | Content (Markdown) |
| **TeammateIdle hook (gates.ts)** | Single-writer: emit events only, remove `commitTaskCompletion()`. Add team config correlation. | Code (moderate) |
| **SubagentStart hook (subagent-context.ts)** | Deduplication: inject only live task status data, remove historical/team context re-injection. Skip injection entirely for teammate sub-subagents during monitoring phase. | Code (moderate) |
| **SessionStart hook (session-start.ts)** | Add native team directory detection (handle both path formats) | Code (minor) |
| **Event schemas** | Add `team.task.planned`, `team.teammate.dispatched` event types | Code (minor) |
| **workflow.tasks[] type** | Add `nativeTaskId`, `teammateName`, `blockedBy` fields | Code (minor) |

### Forward Compatibility

All new events use the existing schema pattern — self-contained payloads, no local references. They're projectable via the outbox for Basileus sync. The native task ID correlation is local-only metadata; remote projections use Exarchos task IDs.

## Testing Strategy

### Unit Tests
- `batch_append` action: verify multiple events appended atomically with sequential sequence numbers
- `batch_append` action: verify idempotency key deduplication across batch
- Event schema validation (Zod) for `team.task.planned`, `team.teammate.dispatched`
- Task ID correlation: verify `nativeTaskId` storage and retrieval in `workflow.tasks[]`
- TeammateIdle hook: verify event emission WITHOUT state mutation (single-writer compliance)
- TeammateIdle hook: verify team config correlation maps `cwd` → correct Exarchos task (both path formats)
- SubagentStart hook: verify ONLY live task data injected (no historical intelligence, no team context)
- SubagentStart hook: verify injection skipped entirely for teammate sub-subagents during delegate phase
- SessionStart hook: verify native team directory detection for orphaned teams (both path formats)
- Reconstructibility: verify `workflow.tasks[]` is derivable from event stream replay (invariant test)

### Integration Tests
- Full saga: emit batched events → create team → create tasks → spawn teammates → TeammateIdle emits events → orchestrator reads events and updates state
- Single-writer: verify hooks never call `commitTaskCompletion()` or mutate `workflow.tasks[]`
- Compensation: simulate spawn failure → verify compensating events + native cleanup
- Idempotency: simulate retry of Step 2 with partially-created tasks → verify no duplicates
- Reconciliation: create drift between native task list and workflow.tasks[] → verify reconciliation corrects it
- Compensation failure: simulate compensation step failure → verify retry + `_compensationFailed` marker after exhaustion

### Validation Scripts
- `scripts/verify-delegation-saga.sh` — Verify saga step ordering in event stream (events before side effects)
- Extend `scripts/post-delegation-check.sh` — Verify native task list and workflow.tasks[] are consistent

## Open Questions

1. **TaskCreate return value** — ~~Does Claude Code's `TaskCreate` tool return a task ID that the orchestrator can capture and store?~~ **Resolved:** The `TaskCreate` tool returns a task object. The [official docs](https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks) confirm tasks use file-locking and are stored at `~/.claude/tasks/{team-name}/`. The orchestrator can capture the returned ID. Fallback: match by `subject` string if the return value is opaque.

2. **Team cleanup timing** — `TeamDelete` fails if teammates are still active. The skill prescribes shutdown requests before delete, but teammates may take time to respond. Per [official docs](https://code.claude.com/docs/en/agent-teams#limitations): "teammates finish their current request or tool call before shutting down, which can take time." **Resolution:** The orchestrator polls for idle notifications (automatically delivered) before calling `TeamDelete`.

3. **Delegate mode enforcement** — The ADR prescribes delegate mode (Shift+Tab) during monitoring. Per [official docs](https://code.claude.com/docs/en/agent-teams#use-delegate-mode): "Delegate mode prevents [the lead from implementing] by restricting the lead to coordination-only tools." This is a UI action, not an API call. **Resolution:** The skill instructs the orchestrator to use it; the orchestrator constraint rule provides additional enforcement. Acceptable.

4. **Native task dependencies** — `TaskUpdate` supports `addBlockedBy` with native task IDs. The plan uses Exarchos task IDs for dependencies. The skill must map Exarchos task IDs to native task IDs after creation. This requires sequential TaskCreate calls (create all tasks first, then wire dependencies), not parallel. Per [official docs](https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks): "The system manages task dependencies automatically. When a teammate completes a task that other tasks depend on, blocked tasks unblock without manual intervention."
