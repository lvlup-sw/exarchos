# Design: Agent Teams Deep Integration via Hooks Pipeline

## Problem Statement

After issue #401, Exarchos has basic Agent Teams wiring: settings flags, dual dispatch mode, and a teammate gate that bridges task completions back to workflow state. But the event-sourcing architecture remains underutilized — teammates operate in a coordination silo (native task list) while Exarchos only observes terminal completions. No historical intelligence informs team composition. No structured events capture coordination dynamics. No CQRS views materialize team performance patterns.

The gap: Exarchos has a powerful event-sourced workflow brain. Agent Teams has powerful real-time coordination hands. They coexist but don't synthesize. The orchestrator makes the same delegation decisions regardless of past outcomes.

## Chosen Approach

**Progressive Event Enrichment via Hooks Pipeline** — use Claude Code's hook system as the integration seam. Rather than replacing or wrapping Agent Teams, build a hooks pipeline that enriches the event stream at every lifecycle boundary. The orchestrator stays native (uses Agent Teams naturally), but hooks inject Exarchos intelligence at key moments. New event types capture team coordination semantics. New CQRS views materialize team-aware projections that feed back into orchestration decisions.

**Architectural principle:** CQRS applied to the integration itself:
- **Agent Teams' native task list** = command side (real-time coordination, atomic claims, messaging)
- **Exarchos event store + views** = query side (workflow intelligence, history, guards, projections)
- **Hooks** = the event bridge between command and query sides

The orchestrator queries Exarchos views BEFORE creating teams (strategic intelligence) and hooks capture what happens DURING execution (operational telemetry) — no dual-write, no two-way sync.

## Technical Design

### 1. Hook Enrichment Pipeline

Each existing hook becomes a richer event-sourcing integration point:

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Hook Pipeline                                 │
│                                                                      │
│  SessionStart ──> Recovery advisor (detect orphaned team state)      │
│                                                                      │
│  SubagentStart ─> Context enrichment                                 │
│                   ├── Tool guidance (existing)                       │
│                   ├── Historical intelligence (NEW)                  │
│                   └── Team composition context (NEW)                 │
│                                                                      │
│  TeammateIdle ──> State bridge + event emission                      │
│                   ├── Quality gates (existing)                       │
│                   ├── Task status update (existing, #401)            │
│                   ├── Rich event emission (NEW)                      │
│                   └── Follow-up task detection (NEW)                 │
│                                                                      │
│  TaskCompleted ─> Parity with TeammateIdle enrichment                │
│                                                                      │
│  PreCompact ────> Checkpoint                                         │
│                   ├── Workflow state (existing)                      │
│                   └── Team composition snapshot (NEW)                │
└──────────────────────────────────────────────────────────────────────┘
```

#### SubagentStart Enrichment

Currently injects phase/role-filtered tool guidance. Extended to also inject:

**Historical intelligence** — Query event store for past events affecting the task's target modules. Surface patterns like "this module had 3 fix cycles in the last feature — common failures were missing null checks in validators."

```typescript
// Pseudocode for enriched SubagentStart handler
async function handleSubagentContext(input): Promise<CommandResult> {
  const phase = await findActiveWorkflowPhase(stateDir);
  const { available, denied } = filterToolsForPhaseAndRole(phase, 'teammate');

  // NEW: Historical intelligence
  const taskModules = extractModulesFromCwd(input.cwd);
  const moduleHistory = await queryEventStore({
    types: ['workflow.fix-cycle', 'task.completed', 'task.failed'],
    filter: { modules: taskModules },
    limit: 10
  });
  const intelligence = synthesizeIntelligence(moduleHistory);

  // NEW: Team composition context
  const teamStatus = await getActiveTeamStatus();

  return {
    guidance: formatToolGuidance(available, denied),
    context: formatHistoricalContext(intelligence),
    team: formatTeamContext(teamStatus)
  };
}
```

**Team composition context** — Tell the teammate who else is working and what they're doing, so they can coordinate file ownership and avoid conflicts.

#### TeammateIdle Enrichment

Currently (#401) runs quality gates and updates task status in state file. Extended to:

**Rich event emission** — Emit `team.task.completed` with structured payload: duration (calculated from task startedAt), files changed (from git diff), test results (from quality gate output), quality gate pass/fail details.

**Follow-up detection** — After updating task status, check if any blocked tasks are now unblocked. If the orchestrator's task graph has ready dependents, include this in the hook response so the orchestrator knows to check for newly-actionable work.

```typescript
// Extended TeammateIdle handler (after quality gates pass)
async function handleTeammateGate(input): Promise<CommandResult> {
  const qualityResult = await runQualityChecks(input.cwd);
  if (qualityResult.error) return qualityResult;

  const state = await findActiveWorkflowState(stateDir);
  if (!state) return { continue: true };

  // Existing (#401): Update task status
  const { task, worktree } = matchCwdToTask(state, input.cwd);
  if (task) {
    updateTaskStatus(state, task.id, 'complete');

    // NEW: Emit rich completion event
    await appendEvent({
      type: 'team.task.completed',
      featureId: state.featureId,
      payload: {
        taskId: task.id,
        teammateName: input.teammate_name,
        durationMs: Date.now() - new Date(task.startedAt).getTime(),
        filesChanged: await getChangedFiles(input.cwd),
        testsPassed: true,
        qualityGateResults: qualityResult.details
      }
    });

    // NEW: Check for unblocked follow-up tasks
    const unblockedTasks = findUnblockedTasks(state, task.id);
    if (unblockedTasks.length > 0) {
      return { continue: true, unblockedTasks };
    }
  }

  return { continue: true };
}
```

### 2. New Event Types

Extend the event schema (currently 22 types) with team coordination events. All events follow the existing schema pattern and are projectable via the outbox for future Basileus sync.

| Event Type | Emitted By | Payload | Purpose |
|-----------|-----------|---------|---------|
| `team.spawned` | Orchestrator | `{ teamSize, teammateNames, taskCount, dispatchMode }` | Team creation audit |
| `team.task.assigned` | Orchestrator | `{ taskId, teammateName, worktreePath, modules }` | Assignment tracking |
| `team.task.completed` | TeammateIdle hook | `{ taskId, teammateName, durationMs, filesChanged, testsPassed, qualityGateResults }` | Performance telemetry |
| `team.task.failed` | TeammateIdle hook | `{ taskId, teammateName, failureReason, gateResults }` | Failure analysis |
| `team.disbanded` | Orchestrator | `{ totalDurationMs, tasksCompleted, tasksFailed }` | Team lifecycle close |
| `team.context.injected` | SubagentStart hook | `{ phase, toolsAvailable, historicalHints }` | Context audit trail |

**Schema design principle:** Payloads are self-contained (no external references needed to interpret) and forward-compatible (new optional fields won't break existing consumers). This enables Basileus to materialize the same views from projected events without local state access.

### 3. New CQRS Views

#### TeamPerformanceView

Materializes from `team.*` events to provide adaptive orchestration intelligence.

```typescript
interface TeamPerformanceView {
  // Per-teammate metrics (across all workflows)
  teammates: Record<string, {
    tasksCompleted: number;
    avgDurationMs: number;
    qualityGatePassRate: number;
    avgFilesPerTask: number;
    moduleExpertise: string[]; // modules they've worked on most
  }>;

  // Per-module metrics
  modules: Record<string, {
    avgTaskDurationMs: number;
    fixCycleRate: number; // % of tasks that needed fix cycles
    commonFailurePatterns: string[];
    lastTouchedBy: string; // featureId
  }>;

  // Team sizing effectiveness
  teamSizing: {
    avgTasksPerTeammate: number;
    optimalTeamSize: number; // derived from duration/size correlation
    parallelizationEfficiency: number; // actual speedup vs linear
  };
}
```

**Used by orchestrator** before delegation:
1. Query `TeamPerformanceView` for optimal team size given task count and complexity
2. Identify high-risk modules (high fix-cycle rate) and inject warnings into spawn prompts
3. Track parallelization efficiency to calibrate between Agent Teams and subagent dispatch

#### DelegationTimelineView

Materializes the full delegation lifecycle for a single feature — from team spawn through task completion to disband. Provides bottleneck identification and critical path analysis.

```typescript
interface DelegationTimelineView {
  featureId: string;
  teamSpawnedAt: string;
  teamDisbandedAt: string | null;
  totalDurationMs: number;
  tasks: Array<{
    taskId: string;
    teammateName: string;
    assignedAt: string;
    completedAt: string | null;
    durationMs: number;
    status: 'assigned' | 'completed' | 'failed';
    criticalPath: boolean; // was this task on the longest dependency chain?
  }>;
  bottleneck: {
    taskId: string;
    durationMs: number;
    reason: string; // 'longest_task' | 'dependency_wait' | 'quality_gate_retry'
  } | null;
}
```

### 4. Adaptive Orchestration Flow

The orchestrator's delegation flow becomes intelligence-driven:

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Adaptive Delegation Flow                          │
│                                                                     │
│  1. PLAN READY                                                      │
│     │                                                               │
│  2. QUERY INTELLIGENCE                                              │
│     ├── exarchos_view: TeamPerformanceView                          │
│     │   → optimal team size, risky modules, teammate strengths      │
│     ├── exarchos_event: query past fix-cycles for target modules    │
│     │   → historical failure patterns                               │
│     └── exarchos_workflow: get task graph with dependencies         │
│         → guard-validated execution order                           │
│                                                                     │
│  3. COMPOSE TEAM (informed by intelligence)                         │
│     ├── Size team based on TeamPerformanceView.optimalTeamSize      │
│     ├── Assign tasks based on module expertise matching             │
│     └── Inject historical warnings into spawn prompts              │
│                                                                     │
│  4. EMIT EVENTS                                                     │
│     ├── team.spawned (audit)                                        │
│     └── team.task.assigned × N (per task)                           │
│                                                                     │
│  5. DISPATCH via Agent Teams (native)                               │
│     ├── Create team with N teammates                                │
│     ├── Create native task list from Exarchos task graph            │
│     └── Activate delegate mode (Shift+Tab)                         │
│                                                                     │
│  6. MONITOR (hooks pipeline operates autonomously)                  │
│     ├── SubagentStart → enriched context injection                  │
│     ├── TeammateIdle → quality gates + event emission               │
│     └── PreCompact → checkpoint team state                         │
│                                                                     │
│  7. SYNTHESIZE                                                      │
│     ├── All tasks complete → emit team.disbanded                   │
│     ├── Update DelegationTimelineView                              │
│     └── Transition to review phase                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 5. Guard-Aware Task Graph

Before creating the native Agent Teams task list, the orchestrator validates the task dependency graph through Exarchos guards. This prevents invalid task orderings from reaching teammates.

The orchestrator:
1. Reads the implementation plan's parallel groups
2. Validates each group's dependencies against HSM guards (e.g., "review tasks can't start until all implementation tasks complete")
3. Creates the native task list with validated dependency edges
4. Agent Teams handles real-time claim ordering using native file-locked self-claim

This gives us guard protection WITHOUT replacing the native task list — guards run at graph creation time, not at claim time.

### 6. SessionStart Recovery

When a session resumes after context compaction or restart, the SessionStart hook detects orphaned team state:

```typescript
// Extended session-start handler
async function handleSessionStart(): Promise<CommandResult> {
  const workflow = await findActiveWorkflow(stateDir);
  if (!workflow) return { nextAction: null };

  // Existing: determine next action from phase
  const nextAction = determineNextAction(workflow);

  // NEW: Check for orphaned team state
  if (workflow.phase === 'delegate' && workflow.teamState) {
    const activeTeammates = workflow.teamState.teammates.filter(
      t => t.status === 'active'
    );
    if (activeTeammates.length > 0) {
      return {
        nextAction,
        recovery: {
          type: 'orphaned_team',
          message: `Found ${activeTeammates.length} teammates from previous session. ` +
            `Agent Teams cannot resume teammates across sessions. ` +
            `Recommend: check completed work, re-dispatch remaining tasks.`,
          completedTasks: workflow.tasks.filter(t => t.status === 'complete'),
          remainingTasks: workflow.tasks.filter(t => t.status !== 'complete')
        }
      };
    }
  }

  return { nextAction };
}
```

## Integration Points

### Existing Infrastructure (No Changes Needed)

| Component | How It's Used |
|-----------|---------------|
| Event store (JSONL) | Receives new team event types via existing `event_append` |
| CQRS materializer | Receives new view definitions via existing projection pattern |
| HSM state machine | Orchestrator queries guards before task graph creation |
| Tool registry | Phase/role filtering already works for teammates via SubagentStart |
| Worktree management | Unchanged — teammates still work in isolated worktrees |
| Graphite integration | Unchanged — teammates still use `gt create` + `gt submit` |

### Modified Infrastructure

| Component | Change |
|-----------|--------|
| SubagentStart hook handler | Add historical intelligence + team context injection |
| TeammateIdle hook handler | Add rich event emission + follow-up detection |
| PreCompact hook handler | Add team composition snapshot |
| SessionStart hook handler | Add orphaned team recovery detection |
| Event schemas | Add 6 new team event types |
| Views | Add TeamPerformanceView + DelegationTimelineView |
| Delegation SKILL.md | Add adaptive orchestration flow documentation |

### Forward Compatibility (Basileus-Ready)

All new events use the existing event schema pattern:
```typescript
{
  type: 'team.task.completed',
  timestamp: '2026-02-16T...',
  featureId: 'agent-teams-deep-integration',
  idempotencyKey: 'team-task-completed-task-001-...',
  payload: { /* self-contained, no local references */ }
}
```

Events are projectable via the existing outbox/sync mechanism. The `sync.now` action drains new team events alongside existing workflow events. Basileus can materialize TeamPerformanceView and DelegationTimelineView from the same event stream without local state access.

## Testing Strategy

### Unit Tests
- Event schema validation for all 6 new event types (Zod)
- TeamPerformanceView materialization from fixture events
- DelegationTimelineView materialization with bottleneck detection
- SubagentStart enrichment handler (mock event store queries)
- TeammateIdle enrichment handler (mock state + event store)
- SessionStart recovery detection (mock orphaned team state)
- Guard-aware task graph validation

### Integration Tests
- Full hooks pipeline: SubagentStart → simulated work → TeammateIdle → event emission → view materialization
- Adaptive orchestration: seed event store with historical data → query TeamPerformanceView → verify team sizing recommendation
- Recovery flow: create checkpoint with team state → simulate restart → verify recovery advisory

### Validation Scripts
- `scripts/verify-team-events.sh` — Verify team event schema compliance
- `scripts/check-view-materialization.sh` — Verify CQRS views materialize correctly from event fixtures

## Open Questions

1. **Hook payload limits** — How much data can hooks inject via stdout? If historical intelligence is large, we may need to summarize aggressively or use a file-based sidecar.

2. **TeammateIdle timing** — The hook fires when a teammate goes idle, but we may not have access to the exact files they changed (git diff in their worktree). Need to verify what `cwd` provides — if it's the worktree path, we can run `git diff` there.

3. **Team performance cold start** — TeamPerformanceView has no data on first use. The orchestrator should fall back to sensible defaults (team size from plan's parallel groups) until enough events accumulate.

4. **Event cardinality** — With rich events per task per teammate, the JSONL store could grow significantly for large features. Consider event compaction or archival after workflow completion.

5. **Native task list projection** — Can we programmatically create Agent Teams tasks from the orchestrator? Currently the orchestrator uses natural language to instruct the lead. If Agent Teams exposes a task creation API, we could project the Exarchos task graph directly.
