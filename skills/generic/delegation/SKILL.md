---
name: delegation
description: "Dispatch implementation tasks to agent teammates in git worktrees. Triggers: 'delegate', 'dispatch tasks', 'assign work', or /delegate. Spawns teammates, creates worktrees, monitors progress. Supports --fixes flag. Do NOT use for single-file changes or polish-track refactors."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: delegate
---

# Delegation Skill

Dispatch implementation tasks to Claude Code subagents with proper context, worktree isolation, and TDD requirements. This skill follows a three-step flow: **Prepare, Dispatch, Monitor.**

## Triggers

Activate this skill when:
- User runs `delegate` command
- Implementation plan is ready with extractable tasks
- User wants to parallelize work across subagents

**Exception — oneshot workflows skip delegation entirely.** The oneshot playbook runs an in-session TDD loop in the main agent's context, with no subagent dispatch or review phase. If `workflowType === "oneshot"`, do not call this skill — see `@skills/oneshot-workflow/SKILL.md` for the lightweight path.

## Core Principles

### Fresh Context Per Task (MANDATORY)

Each subagent MUST start with a clean, self-contained context. As established in the Anthropic best practices for multi-agent coordination:

- **No shared state assumptions.** Every subagent prompt must contain the full task description, file paths, TDD requirements, and acceptance criteria. Never say "see the plan" or "as discussed earlier."
- **No cross-agent references.** Subagent A must not depend on output from Subagent B unless explicitly sequenced with a dependency edge in the plan.
- **Isolated worktrees.** Each subagent operates in its own `git worktree`. Parallel agents in the same worktree will corrupt branch state.

Rationalization patterns that violate this principle are catalogued in `references/rationalization-refutation.md`.

### Delegation Modes

| Mode | Mechanism | Best for |
|------|-----------|----------|
| `subagent` (default) | `Task` with `run_in_background` | 1-3 independent tasks, CI, headless |
| `agent-team` | `Task` with `team_name` | 3+ interdependent tasks, interactive sessions |

**Auto-detection:** tmux + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` present means `agent-team`. Otherwise `subagent`. Override with `delegate --mode subagent|agent-team`.

Use the `recommendedModel` from `prepare_delegation` task classifications when available. If no classification exists (e.g., fixer dispatch), omit `model` to inherit the session default.

### Pre-Dispatch Schema Discovery

Before dispatching, query decision runbooks to classify the work and select the right strategy:

1. **Task complexity:** `exarchos_orchestrate({ action: "runbook", id: "task-classification" })` to get the cognitive complexity classification tree. Low-complexity tasks can use the scaffolder agent spec for faster execution.
2. **Dispatch strategy:** `exarchos_orchestrate({ action: "runbook", id: "dispatch-decision" })` for dispatch strategy (parallel vs sequential, team sizing, isolation mode).

---

## Step 1: Prepare

Use the `prepare_delegation` composite action to validate readiness in a single call. This replaces manual script invocations and individual checks.

> **Authoritative spec:** the canonical list of preconditions, blockers, and arguments for `prepare_delegation` lives in the runtime — query it with `exarchos_orchestrate({ action: "describe", actions: ["prepare_delegation"] })` if anything in this skill drifts from observed behavior. Treat the runtime `describe` output as the source of truth.

### Step 0 — Pre-emit (required before `prepare_delegation`)

Before calling `prepare_delegation`, the workflow stream must contain a `task.assigned` event for each task. The readiness view counts these events to populate `taskCount`; without them, `prepare_delegation` returns `{ ready: false, blockers: ["no task.assigned events found ..."] }`.

```typescript
exarchos_event({
  action: "batch_append",
  stream: "<featureId>",
  events: tasks.map((t) => ({
    type: "task.assigned",
    data: { taskId: t.id, title: t.title, branch: t.branch },
  })),
})
```

### Step 1 — Prepare (readiness check)

```typescript
exarchos_orchestrate({
  action: "prepare_delegation",
  featureId: "<featureId>",
  tasks: [{ id: "task-001", title: "...", modules: [...] }, ...]
})
```

The composite action performs:
1. **Worktree creation** — creates `.worktrees/task-<id>` with `git worktree add`, runs `npm install`
2. **State validation** — verifies workflow state is in `delegate` phase, plan exists, plan approved
3. **Quality signal assembly** — queries `code_quality` view; if `gatePassRate < 0.80`, returns quality hints to embed in prompts. Emits `gate.executed('plan-coverage')` on success (no pre-query needed)
4. **Benchmark detection** — sets `verification.hasBenchmarks` if any task has benchmark criteria
5. **Readiness verdict** — returns `{ ready: true, worktrees: [...], qualityHints: [...] }` or `{ ready: false, reason: "..." }`

**If `blocked: true` with `reason: "current-branch-protected"`:** the response includes a `hint` field (e.g. "checkout the feature/phase branch before dispatching delegation"). Apply the hint, then re-call.

**If `ready: false`:** Stop. Report the reason to the user. Do not proceed.

**If `ready: true`:** Extract the `worktrees` paths and `qualityHints` for prompt construction.

### Task Extraction

From the implementation plan, extract for each task:
- Full task description (paste inline; never reference external files)
- Files to create/modify with absolute worktree paths
- Test file paths and expected test names
- Dependencies on other tasks (for sequencing)
- Property-based testing flag (`testingStrategy.propertyTests`)

For a complete worked example of this flow, see `references/worked-example.md`.

---

## Step 2: Dispatch

Build subagent prompts using `references/implementer-prompt.md` as the template. Each prompt MUST include the full task context — this is the fresh-context principle in action.

### Prompt Construction

**Claude Code (native agent definitions):**

The `exarchos-implementer` agent spec already includes the system prompt, model, isolation, skills, hooks, and memory. The dispatch prompt should contain ONLY task-specific context:
1. Full task description (requirements, acceptance criteria)
2. Working directory (worktree path from Step 1)
3. File paths to create/modify and test file paths
4. Quality hints (if any)
5. PBT flag when `propertyTests: true`

**Cross-platform (full prompt template):**

For each task:
1. Fill the implementer prompt template with task-specific details
2. Set the `Working Directory` to the worktree path from Step 1
3. Include quality hints (if any) in the Quality Signals section
4. Include PBT section from `references/pbt-patterns.md` when `propertyTests: true`
5. Include testing patterns from `references/testing-patterns.md`

### Decision Runbooks

For dispatch strategy decisions, query the decision runbook:
`exarchos_orchestrate({ action: "runbook", id: "dispatch-decision" })`

This runbook provides structured criteria for parallel vs sequential dispatch, team sizing, and failure escalation.

### Parallel Dispatch

Dispatch all independent tasks using the runtime's native spawn primitive. On runtimes with subagent support, fan out in a **single message** so the dispatches run in parallel. On runtimes without a subagent primitive, execute each task sequentially against its prepared worktree and emit one operator-visible warning per batch so users know they are not getting parallelism.

```typescript
Execute each task sequentially in the current session, one at a time, against the prepared worktrees.
```

> **Note:** On Claude Code, the `exarchos-implementer` agent definition already contains the system prompt, model, isolation, skills, hooks, and memory — the dispatch prompt should carry ONLY task-specific context. On runtimes without native agent definitions, include the full implementer prompt template from `references/implementer-prompt.md` in the `prompt` field so the spawned agent has a self-contained context.

For parallel grouping strategy and model selection, see `references/parallel-strategy.md`.

### Agent Teams Dispatch

When using `--mode agent-team`, follow the 6-step saga in `references/agent-teams-saga.md`. The saga requires event-first execution: emit event, then execute side effect at every step.

Event emission contract for agent teams: see `references/agent-teams-saga.md` for full payload shapes and compensation protocol.

### Event Emission Contract (REQUIRED)

The delegate phase requires these events (checked by `check-event-emissions`):

| Event | When | Emitted By |
|-------|------|------------|
| `task.assigned` | Before `prepare_delegation` (one per task; see Step 0) | Orchestrator |
| `team.spawned` | After team creation, before dispatch | Orchestrator |
| `team.task.planned` | For each task in the plan (use `batch_append`) | Orchestrator |
| `team.teammate.dispatched` | After each subagent is spawned | Orchestrator |
| `task.progressed` | After each TDD phase (red/green/refactor) | Subagent |
| `team.disbanded` | After all subagents complete | Orchestrator |

See `references/agent-teams-saga.md` for full event schemas and emission order.

> **Note:** `task.progressed` events are emitted by subagents during TDD execution, not by the orchestrator. The orchestrator only emits team lifecycle events.

---

## Step 3: Monitor and Collect

### Subagent Monitoring

Poll background tasks and collect results:

```typescript
TaskOutput({ task_id: "<id>", block: true })
```

After each subagent reports completion:

> **Runbook:** For each completed task, execute the task-completion runbook:
> `exarchos_orchestrate({ action: "runbook", id: "task-completion" })`
> Execute the returned steps in order. Stop on gate failure.
> If the runbook action is unavailable, use `describe` to retrieve gate schemas and run manually:
> `exarchos_orchestrate({ action: "describe", actions: ["check_tdd_compliance", "check_static_analysis", "task_complete"] })`

1. **Extract provenance from subagent report** — parse the subagent's completion output and extract structured provenance fields (`implements`, `tests`, `files`). These fields are reported by the subagent following the Provenance Reporting section of the implementer prompt.

2. **Verify worktree state** — confirm each worktree has clean `git status` and passing tests

3. **Run blocking gates** — the `task-completion` runbook (referenced above) defines the exact gate sequence (TDD compliance, static analysis, then task_complete). On any gate failure, keep the task in-progress and report findings. All gate handlers auto-emit `gate.executed` events, so manual `exarchos_event` calls are not needed.

5. **Pass provenance in task completion** — when marking a task complete, pass the extracted provenance fields in the `result` parameter so they flow into the `task.completed` event:

```typescript
exarchos_orchestrate({
  action: "task_complete",
  taskId: "<taskId>",
  streamId: "<featureId>",
  result: {
    summary: "<task summary>",
    implements: ["DR-1", "DR-3"],
    tests: [{ name: "testName", file: "path/to/test.ts" }],
    files: ["path/to/impl.ts", "path/to/test.ts"]
  }
})
```

6. **Update workflow state** — set each passing `tasks[].status` to `"complete"` via `exarchos_workflow set`
7. **Delegation completion gate (D4, advisory)** — after ALL tasks pass, run an operational resilience check on the full branch diff before transitioning to review:

```typescript
exarchos_orchestrate({
  action: "check_operational_resilience",
  featureId: "<featureId>",
  repoRoot: ".",
  baseBranch: "main"
})
```

This is advisory — findings are recorded for the convergence view but do not block the delegation→review transition. Include findings in the delegation summary for review-phase attention.

8. **Schema sync** — if any task modified API files (`*Endpoints.cs`, `Models/*.cs`), run `npm run sync:schemas`

### Agent Teams Monitoring

- Teammates visible in tmux split panes
- `TeammateIdle` hook auto-runs quality gates and emits completion/failure events
- Orchestrator monitors via `exarchos_view delegation_timeline` for bottleneck detection
- See `references/agent-teams-saga.md` for disbanding and reconciliation

### Failure Recovery

When a task fails:
1. Read the failure output from `TaskOutput`
2. Diagnose root cause — do NOT trust the implementer's self-assessment (see R3 adversarial posture)
3. Fix the task using the resume-aware fixer flow below
4. Run the `task-fix` runbook gate chain after the fix completes

For the full recovery flow with a concrete example, see `references/worked-example.md`.

### Fix Failed Tasks

Dispatch a fix agent with the full failure context and the original task description. On runtimes that support session resume (e.g. Claude Code with an `agentId` in workflow state), prefer resuming the original agent so it retains its implementer context; otherwise dispatch a fresh fixer agent using the runtime's native spawn primitive.

```typescript
Execute each task sequentially in the current session, one at a time, against the prepared worktrees.
```

After fix completes, run the `task-fix` runbook gate chain:
`exarchos_orchestrate({ action: "runbook", id: "task-fix" })`
If runbook unavailable, use `describe` to retrieve gate schemas: `exarchos_orchestrate({ action: "describe", actions: ["check_tdd_compliance", "check_static_analysis", "task_complete"] })`

---

## Fix Mode (--fixes)

Handles review failures instead of initial implementation. Uses `references/fixer-prompt.md` template with adversarial verification posture, dispatches fix tasks per issue, then re-invokes review to re-integrate fixes.

**Arguments:** `--fixes <state-file-path>` — state JSON containing review results in `.reviews.<taskId>.specReview` or `.reviews.<taskId>.qualityReview`.

For detailed fix-mode process, see `references/fix-mode.md`.

> **Deprecated:** `--pr-fixes` has been superseded by `/exarchos:shepherd`. Use the shepherd skill for PR feedback workflows.

---

## Context Compaction Recovery

If context compaction occurs during delegation:
1. Query workflow state: `exarchos_workflow get` with `fields: ["tasks"]`
2. Check active worktrees: `ls .worktrees/` and verify branch state
3. Reconcile: `exarchos_workflow reconcile` replays the event stream and patches stale task state (CAS-protected)
4. Do NOT re-create branches or re-dispatch agents until confirmed lost

### Worktree State Schema

Worktree entries are stored as `worktrees["<wt-id>"]` in workflow state. Each entry requires:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `branch` | string | Yes | Git branch name |
| `taskId` | string | Conditional | Single task ID (use for 1-task worktrees) |
| `tasks` | string[] | Conditional | Multiple task IDs (use for multi-task worktrees) |
| `status` | `"active"` \| `"merged"` \| `"removed"` | Yes | Worktree lifecycle status |

Either `taskId` or `tasks` (non-empty array) is required — at least one must be present.

**Single-task example:**
```json
{ "branch": "feat/task-001", "taskId": "task-001", "status": "active" }
```

**Multi-task example:**
```json
{ "branch": "feat/integration", "tasks": ["task-001", "task-002"], "status": "active" }
```

---

## Phase Transitions and Guards

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

**Quick reference:** The `delegate` → `review` transition requires guard `all-tasks-complete` — all `tasks[].status` must be `"complete"` in workflow state.

> **Before transitioning to review:** You MUST first update all task statuses to `"complete"` via `exarchos_workflow set` with the tasks array. The phase transition will be rejected by the guard if any task is still pending/in_progress/failed. Update tasks first, then set the phase in a separate call.

### Task Status Values

| Status | When to use |
|--------|------------|
| `pending` | Task not yet started |
| `in_progress` | Task actively being worked on |
| `complete` | Task finished successfully |
| `failed` | Task encountered an error (requires fix cycle) |

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. Use
`exarchos_orchestrate({ action: "describe", actions: ["check_tdd_compliance", "task_complete"] })`
for orchestrate action schemas.

## Transition

After all tasks complete, **auto-continue immediately** (no user confirmation):

1. Verify all `tasks[].status === "complete"` in workflow state
2. Update state: `exarchos_workflow set` with `phase: "review"`
3. Invoke: `[Invoke the exarchos:review skill with args: <plan-path>]`

This is NOT a human checkpoint — the workflow continues autonomously.

---

## References

| Document | Purpose |
|----------|---------|
| `references/implementer-prompt.md` | Full prompt template for implementation tasks |
| `references/fixer-prompt.md` | Fix agent prompt with adversarial verification posture |
| `references/worked-example.md` | Complete delegation trace with recovery path (R1) |
| `references/rationalization-refutation.md` | Common rationalizations and counter-arguments (R2) |
| `references/agent-teams-saga.md` | 6-step agent-team saga with event payloads |
| `references/parallel-strategy.md` | Parallel grouping and model selection |
| `references/testing-patterns.md` | Arrange/Act/Assert, naming, mocking conventions |
| `references/pbt-patterns.md` | Property-based testing patterns |
| `references/fix-mode.md` | Detailed fix-mode process |
| `references/state-management.md` | State patterns and benchmark labeling |
| `references/troubleshooting.md` | Common failure modes and resolutions |
| `references/adaptive-orchestration.md` | Adaptive team composition |
| `references/workflow-steps.md` | Cross-platform step-by-step delegation reference |
| `references/worktree-enforcement.md` | Worktree isolation rules |
