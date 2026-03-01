---
name: delegation
description: "Dispatch implementation tasks to agent teammates in git worktrees. Use when the user says 'delegate', 'dispatch tasks', 'assign work', 'delegate tasks', or runs /delegate. Spawns teammates, creates worktrees, monitors progress, and collects results. Supports --fixes flag for review finding remediation. Do NOT use for single-file changes or polish-track refactors."
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
- User runs `/delegate` command
- Implementation plan is ready with extractable tasks
- User wants to parallelize work across subagents

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

**Auto-detection:** tmux + `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` present means `agent-team`. Otherwise `subagent`. Override with `/delegate --mode subagent|agent-team`.

**CRITICAL:** Always specify `model: "opus"` for coding tasks.

---

## Step 1: Prepare

Use the `prepare_delegation` composite action to validate readiness in a single call. This replaces manual script invocations and individual checks.

```typescript
exarchos_orchestrate({
  action: "prepare_delegation",
  featureId: "<featureId>",
  tasks: [{ id: "task-001", title: "...", modules: [...] }, ...]
})
```

The composite action performs:
1. **Worktree creation** — creates `.worktrees/task-<id>` with `git worktree add`, runs `npm install`
2. **State validation** — verifies workflow state is in `delegate` phase, plan exists
3. **Quality signal check** — queries `code_quality` view; if `gatePassRate < 0.80`, returns quality hints to embed in prompts
4. **Benchmark detection** — sets `verification.hasBenchmarks` if any task has benchmark criteria
5. **Readiness verdict** — returns `{ ready: true, worktrees: [...], qualityHints: [...] }` or `{ ready: false, reason: "..." }`

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

For each task:
1. Fill the implementer prompt template with task-specific details
2. Set the `Working Directory` to the worktree path from Step 1
3. Include quality hints (if any) in the Quality Signals section
4. Include PBT section from `references/pbt-patterns.md` when `propertyTests: true`
5. Include testing patterns from `references/testing-patterns.md`

### Parallel Dispatch

Dispatch all independent tasks in a **single message** with multiple `Task` calls:

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task-001: [title]",
  prompt: `[Full implementer prompt — self-contained]`
})
```

For parallel grouping strategy and model selection, see `references/parallel-strategy.md`.

### Agent Teams Dispatch

When using `--mode agent-team`, follow the 6-step saga in `references/agent-teams-saga.md`. The saga requires event-first execution: emit event, then execute side effect at every step.

Event emission contract for agent teams: see `references/agent-teams-saga.md` for full payload shapes and compensation protocol.

---

## Step 3: Monitor and Collect

### Subagent Monitoring

Poll background tasks and collect results:

```typescript
TaskOutput({ task_id: "<id>", block: true })
```

After all tasks report completion:

1. **Verify worktree state** — confirm each worktree has clean `git status` and passing tests
2. **TDD compliance gate** — for each completed task, invoke the compliance check BEFORE marking the task as complete:

```typescript
exarchos_orchestrate({
  action: "check_tdd_compliance",
  featureId: "<featureId>",
  taskId: "<taskId>",
  branch: "<task-branch>"
})
```

Gate on the result:
- If `result.data.passed === true`: Task passes TDD compliance. Proceed to mark it complete.
- If `result.data.passed === false`: Keep task in-progress. Report TDD compliance findings to the user and include violations in the task failure diagnostics. Do NOT mark the task as complete.

The handler auto-emits `gate.executed` events, so manual `exarchos_event` calls for post-delegation checks are not needed.

3. **Update workflow state** — set each passing `tasks[].status` to `"complete"` via `exarchos_workflow set`
4. **Schema sync** — if any task modified API files (`*Endpoints.cs`, `Models/*.cs`), run `npm run sync:schemas`

### Agent Teams Monitoring

- Teammates visible in tmux split panes
- `TeammateIdle` hook auto-runs quality gates and emits completion/failure events
- Orchestrator monitors via `exarchos_view delegation_timeline` for bottleneck detection
- See `references/agent-teams-saga.md` for disbanding and reconciliation

### Failure Recovery

When a task fails:
1. Read the failure output from `TaskOutput`
2. Diagnose root cause — do NOT trust the implementer's self-assessment (see R3 adversarial posture)
3. Re-dispatch with a fixer prompt (`references/fixer-prompt.md`) in the **same worktree**
4. The fixer agent gets fresh context with the failure details embedded

For the full recovery flow with a concrete example, see `references/worked-example.md`.

---

## Fix Mode (--fixes)

Handles review failures instead of initial implementation. Uses `references/fixer-prompt.md` template with adversarial verification posture, dispatches fix tasks per issue, then re-invokes review to re-integrate fixes.

**Arguments:** `--fixes <state-file-path>` — state JSON containing review results in `.reviews.<taskId>.specReview` or `.reviews.<taskId>.qualityReview`.

For detailed fix-mode process, see `references/fix-mode.md`. For PR feedback workflows (`--pr-fixes`), see `references/pr-fixes-mode.md`.

---

## Context Compaction Recovery

If context compaction occurs during delegation:
1. Query workflow state: `exarchos_workflow get` with `fields: ["tasks"]`
2. Check active worktrees: `ls .worktrees/` and verify branch state
3. Reconcile: `exarchos_workflow reconcile` replays the event stream and patches stale task state (CAS-protected)
4. Do NOT re-create branches or re-dispatch agents until confirmed lost

---

## Transition

After all tasks complete, **auto-continue immediately** (no user confirmation):

1. Verify all `tasks[].status === "complete"` in workflow state
2. Update state: `exarchos_workflow set` with `phase: "review"`
3. Invoke: `Skill({ skill: "exarchos:review", args: "<plan-path>" })`

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
| `references/pr-fixes-mode.md` | PR feedback fix workflows |
| `references/state-management.md` | State patterns and benchmark labeling |
| `references/troubleshooting.md` | Common failure modes and resolutions |
| `references/adaptive-orchestration.md` | Adaptive team composition |
| `references/workflow-steps.md` | Legacy step-by-step delegation reference |
| `references/worktree-enforcement.md` | Worktree isolation rules |
