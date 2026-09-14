---
name: delegate
description: "Dispatch implementation tasks to agent teammates in git worktrees from a prepared capsule, then settle the batch. Triggers: 'delegate', 'dispatch tasks', 'assign work', or /delegate. Compiles the batch with prepare, spawns teammates, submits their results with settle. Supports --fixes flag. Do NOT use for single-file changes or polish-track refactors."
metadata:
  author: exarchos
  version: 3.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: delegate
---

# Delegation Skill

Dispatch implementation tasks to subagents with proper context, worktree isolation, and TDD requirements. This skill follows a three-step flow: **Prepare, Dispatch, Settle.**

`prepare` compiles the workflow's outstanding tasks into one immutable **capsule** — the task graph, each task's result contract and verification terms, the authority the work is judged by — and pins it. The subagents run the batch with **no governance calls in between**. `settle` submits their results as one batch: it adjudicates every claim against the pinned capsule, runs each accepted task's verification itself, and leaves the tasks complete. The orchestrator then lands the worktrees and transitions.

The capsule is compiled for **feature** workflows. A workflow type `prepare` refuses (`WORKFLOW_TYPE_UNSUPPORTED`) takes the primitive path in the appendix at the end of this skill.

## Triggers

Activate this skill when:
- User runs `delegate` command
- Implementation plan is ready with extractable tasks
- User wants to parallelize work across subagents

**Exception — oneshot workflows skip delegation entirely.** The oneshot playbook runs an in-session TDD loop in the main agent's context, with no subagent dispatch or review phase. If `workflowType === "oneshot"`, do not call this skill — see `@skills/oneshot/SKILL.md` for the lightweight path.

## Core Principles

### Fresh Context Per Task (MANDATORY)

Each subagent MUST start with a clean, self-contained context. As established in the Anthropic best practices for multi-agent coordination:

- **No shared state assumptions.** Every subagent prompt must contain the full task description, file paths, TDD requirements, and acceptance criteria. Never say "see the plan" or "as discussed earlier."
- **No cross-agent references.** Subagent A must not depend on output from Subagent B unless explicitly sequenced with a dependency edge in the plan.
- **Isolated worktrees.** Each subagent operates in its own `git worktree`. Parallel agents in the same worktree will corrupt branch state.

Rationalization patterns that violate this principle are catalogued in `references/rationalization-refutation.md`.

### Delegation Modes

The default `subagent` mode dispatches each task using the runtime's spawn primitive: `Task`.


### Model selection — a reasoning TIER, never a version

The tier for a task is the capsule's `settlementContract.taskVerification[taskId].riskTier` — frozen from the plan when the batch was compiled (the planner's `**Risk Tier:**` stamp wins; the file-and-layer heuristic decides otherwise). Resolve the model tier from it via `agents.tier-models` (defaults `low → haiku`, `medium → sonnet`, `high → opus`; operator-overridable in `.exarchos.yml`, validated monotone so a higher risk tier can never resolve weaker). If no term exists for a task (e.g. a fixer dispatch outside a batch), omit `model` to inherit the session default.

`recommendedModel`, where a runtime still surfaces one, is a **reasoning tier** (`haiku` | `sonnet` | `opus`), not a model version.

Three rules follow, and they are the whole policy:

1. **Never write a model version anywhere** — not in a dispatch, an agent spec, a skill, or a prompt. No `claude-*-YYYYMMDD`, no `-latest`, no point releases. A version string pinned in content is a second model authority that outranks the operator's tier policy silently and rots on the next release. Pass the tier alias and let the harness resolve it against its own current catalog.
2. **Strength follows RISK, not role.** The agent choice selects the *role* (implementer / fixer / reviewer / scaffolder); the ladder selects the *strength*. An agent spec that pins a model id is a defect — that is why every shipped spec declares `model: inherit`.
3. **If you need a version, read the catalog — do not recall one.** Resolve the current tier→version mapping from the harness's own model list at dispatch time. Model recall from training data is stale by construction, and a guessed identifier fails closed at best and silently downgrades at worst.

`unless otherwise specified` means an explicit operator override in `.exarchos.yml` (`agents.default-model`, `agents.models`, `agents.tier-models`) — not a judgement call at dispatch time.

### Pre-Dispatch Schema Discovery

Before dispatching, query decision runbooks to classify the work and select the right strategy:

1. **Task complexity:** `exarchos_orchestrate({ action: "runbook", id: "task-classification" })` to get the cognitive complexity classification tree. Low-complexity tasks can use the scaffolder agent spec for faster execution.
2. **Dispatch strategy:** `exarchos_orchestrate({ action: "runbook", id: "dispatch-decision" })` for dispatch strategy (parallel vs sequential, team sizing, isolation mode).

---

## Step 1: Prepare

### Step 0 — Announce the tasks

Before compiling, the workflow stream must carry a `task.assigned` event for each task. The delegation timeline and the delegate-phase event contract read these; nothing else in this path does. One batch carries every task, so this is one call:

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

### Step 1 — Compile the batch

```typescript
exarchos_orchestrate({ action: "prepare", featureId: "<featureId>" })
```

`prepare` reads the workflow's plan and compiles every task not yet complete into one capsule, in custody, pinned by digest. Keep the receipt: `capsuleVersion` is what `settle` is keyed by, and the `capsule` is what every subagent's packet is built from.

| In the capsule | What you read off it |
|----------------|----------------------|
| `graph.tasks[]`, `graph.dependencies[]`, `graph.joins[]` | The batch, and the order it must run in — a `dependencies` edge `{ from, to }` means `to` waits for `from` |
| `settlementContract.taskVerification[taskId]` | The task's `riskTier` and `boundaryTouching`, frozen from the plan — the model tier, and the gates settlement will run |
| `knowledge.patterns[]` | One statement per tier in the batch naming those gates — splice it into the worker's prompt verbatim |
| `contracts.taskResults[taskId]` | What the task must report back: `worktreePath` (required), `branch`, and its provenance (`files`, `implements`, `tests`, `acceptanceTestRef`) |
| `contracts.deviationEnvelope` | What a worker may propose when a capsule assumption turns out wrong (`invalidated-assumption`, `missing-context`) — instead of guessing |
| `authority.invariants[]`, `authority.escalationBoundaries[]` | What the work is judged by and what it must escalate rather than decide — paste into every packet |
| `knowledge.rationale[]` | The design of record |
| `executionProfile.capabilities` | What this runtime had to hold to get here; `prepare` already refused an unfit one |

**Refusals, none of which compiled anything:**

| Code | Meaning | Do |
|------|---------|----|
| `WORKFLOW_TYPE_UNSUPPORTED` | Not a feature workflow | Take the primitive path (appendix) |
| `PHASE_NOT_PREPARABLE` | Not in `delegate` | Transition first |
| `NOTHING_TO_PREPARE` | Every planned task is complete | Transition to review |
| `UNKNOWN_DEPENDENCY`, `INVALID_TASK_ID`, `INVALID_TASK_STAMP`, `CAPSULE_UNSOUND` | The plan cannot be expressed as a batch | Fix the plan, `prepare` again |
| `RUNTIME_UNFIT` | This runtime lacks a capability settlement needs to verify the batch (named in the message) | Stop; do not dispatch — the batch could never settle here |

A retry with unchanged inputs returns the recorded capsule; a changed plan compiles the next version. **Prepare before every wave**, never once per workflow: the second wave's capsule is compiled from the tasks the first wave left.

### Worktrees

Each task works in its own worktree, materialized by the host under native isolation or laid out with `setup_worktree` (the canonical `.worktrees/<taskId>-<taskName>` path). Under native isolation, confirm each agent's working directory is under `.worktrees/` **before any agent edits files** (its first reported `pwd`); an agent in the shared checkout is stopped, given a worktree created by hand (`git worktree add -b <task-branch> .worktrees/<taskId>-<taskName> <integration-tip>`), and only then allowed to edit. The worktree path is what the task's claim will carry, and what settlement verifies against.

### Task Extraction

The capsule pins the **terms**; the plan carries the **body**. From the implementation plan, extract for each capsule task:
- Full task description (paste inline; never reference external files)
- Files to create/modify as **worktree-relative paths rooted inside the worktree** (e.g. `src/foo.ts`) — never an absolute parent-repo path, and never a `..` sequence that escapes the worktree root. Either form resolves outside the agent's worktree cwd and silently writes into the main worktree. This is the platform-agnostic line of defense — it must hold on every runtime.
- Test file paths (worktree-relative) and expected test names
- Dependencies on other tasks — from `graph.dependencies`, which is the plan's `blockedBy` compiled
- Property-based testing flag (`testingStrategy.propertyTests`)

For a complete worked example of this flow, see `references/worked-example.md`.

---

## Step 2: Dispatch

Build subagent prompts using `references/implementer-prompt.md` as the template. Each prompt MUST include the full task context — this is the fresh-context principle in action.

### Prompt Construction


**On runtimes with native agent definitions:**

The implementer agent definition already includes the system prompt, model, isolation, skills, hooks, and memory. The dispatch prompt should contain ONLY task-specific context:
1. Full task description (requirements, acceptance criteria)
2. Working directory (worktree path from Step 1)
3. File paths to create/modify and test file paths
4. Quality hints (if any)
5. PBT flag when `propertyTests: true`

**Full prompt template (default):**

For each task:
1. Fill the implementer prompt template with task-specific details
2. Set the `Working Directory` to the worktree path from Step 1
3. Include quality hints (if any) in the Quality Signals section
4. Include PBT section from `references/pbt-patterns.md` when `propertyTests: true`
5. Include testing patterns from `references/testing-patterns.md`

### The capsule's terms in the prompt

Every packet carries, from the capsule, verbatim:

1. **The task's verification terms** — its `riskTier` and `boundaryTouching`, and the `knowledge.patterns[]` statement for that tier. The worker then knows which gates settlement runs on its worktree (a low-tier task: static analysis; a medium one: the test-adequacy kill probe too; a boundary-touching one: contract drift beside them), and writes tests that can actually fail rather than performing ceremony.
2. **The result contract** — the `contracts.taskResults[taskId]` fields. The worker's completion report is the claim: `worktreePath`, `branch`, `files`, `implements`, `tests`. Nothing else on the report reaches settlement, and no evidence field exists to fill: the evidence is what settlement records when it runs the gates.
3. **The authority** — `authority.invariants[]` and `authority.escalationBoundaries[]`, and the **deviation envelope**: if a capsule assumption turns out wrong, the worker reports a deviation (`deviationKind` from `contracts.deviationEnvelope.allowedDeviationKinds`, with a statement) instead of working around it silently. A deviation holds the batch for a human; a silent workaround is refused at settlement or, worse, accepted.

**Dispatch THAT packet — not the static agent default.** The shipped `agents/implementer.md` bakes a fixed medium-tier note (a self-contained fallback for runtimes that pre-bind a named agent). Use it verbatim only when no capsule term exists (e.g. a fixer dispatch). The tier is pure data from the capsule; no workflow-type branching is involved.

### Decision Runbooks

For dispatch strategy decisions, query the decision runbook:
`exarchos_orchestrate({ action: "runbook", id: "dispatch-decision" })`

This runbook provides structured criteria for parallel vs sequential dispatch, team sizing, and failure escalation.


### Parallel Dispatch

Dispatch all independent tasks using the runtime's native spawn primitive in a **single message** so the dispatches run in parallel.

```typescript
Task({
  subagent_type: "implementer",
  description: "Implement task-001: [title]",
  prompt: "Task-specific context: requirements, file paths, acceptance criteria"
})

```

> **Note:** Include the full implementer prompt template from `references/implementer-prompt.md` in the dispatch payload so the spawned agent has a self-contained context — runtimes that pre-bind the implementer prompt to a named agent will discard the redundant content automatically.

For parallel grouping strategy and model selection, see `references/parallel-strategy.md`.


### Verification Ownership Contract (ONE owner per claim)

Every verification claim has **exactly one owner**. Re-verifying a claim you do
not own is duplicated work, not defense in depth — it inflates the wave's cost
and hides which run is authoritative when the two disagree.

| Claim | Owner | Where it runs | Everyone else |
|-------|-------|---------------|---------------|
| "This task's behavior is covered and its tests can fail" | **Settlement** | `settle` runs the task-completion runbook per accepted task, in-process, against the worktree the claim names, under the tier the capsule froze | The implementer runs its own tests in its worktree and reports; it runs no Exarchos gate. The lead **reads the findings**; it does not re-run the gates |
| "This task's diff is clean (types, lint, contracts, mocks)" | **Settlement** | Same composed segment | Same |
| "The wave as a whole did not cascade" | Lead | **Once** at the wave boundary — `check_integration_suite` after every wave merge lands | Implementers never run the cumulative suite |
| "The wave is complete" | Settlement + the transition guard | A settled batch leaves every accepted task complete; `all-tasks-complete` admits the transition | No separate completion check |

Two consequences bind the runbooks:

1. `task_complete` is the **terminal** step of the task-completion runbook, and
   settlement runs that runbook: every blocking gate has passed before a task
   is recorded complete, whoever drove it.
   `exarchos_orchestrate({ action: "runbook", id: "task-completion" })` lists the steps settlement composes; you do not run them.
2. `check_integration_suite` is a **wave-boundary backstop**, not a per-task
   gate. It runs exactly once per wave, after the merges, matching its own
   action description. Per-task cascade risk is covered by the task's own
   scoped gates.

The lead's only independent verification is a **spot check** — reading the
settlement's findings and the recorded evidence and, at most, sampling one
claim it has concrete reason to doubt. A blanket re-run of the per-task chain
is a contract violation.

---

## Step 3: Collect and Settle

### Subagent Monitoring

Collect background task results using the runtime's result-collection primitive (this may be a poll/await per task or inline replies, depending on the runtime):

```text
Task() reply (inline)
```

### Build the batch

From each subagent's completion report, build one **claim**. The fields are the result contract's, and nothing else — an undeclared field is a finding:

```typescript
const claims = reports.map((r) => ({
  taskId: r.taskId,
  fields: {
    worktreePath: r.worktreePath,        // required: where the work is
    branch: r.branch,
    files: r.files,
    implements: r.implements,
    tests: r.tests,
  },
  evidence: [],                          // settlement records the evidence; a claim cites none
}))
```

**Do NOT trust the implementer's self-assessment.** The claim says where the work is; settlement decides whether it is done. A worker that reported a deviation goes into `deviations` (`{ deviationKind, statement }`), not into a fudged claim.

**Verify worktree state** before settling — a dirty `git status` in a worktree is work the claim does not name.

### Settle

Every task the capsule requires (`settlementContract.requiredResults`) must have a claim. Submit the batch once, under an id you choose; the id is the settlement key, so a retry after a timeout reuses it and gets the same verdict:

```typescript
exarchos_orchestrate({
  action: "settle",
  featureId: "<featureId>",
  capsuleVersion: <capsuleVersion>,      // from the prepare receipt
  batchId: "<featureId>:wave-1",
  claims,
  deviations: [],
})
```

Settlement adjudicates every claim's shape against the capsule, then — for a batch with no finding — runs each task's verification through the executor and reads the outcome back. One call, every reason: the receipt's `findings` list everything wrong at once, and `verification[]` names the segment each task ran under (`operationId`, `outcome`, `failedLeaf`).

**`settled`** — every accepted task passed its gates and is recorded complete (`task.completed` from the same leaf the primitive path uses; the state document the transition guard reads is level). Go to Step 4.

**`rejected`** — read `findings`:
- A shape finding (`missing-field`, `undeclared-field`, `field-type-mismatch`, `unknown-task`, `missing-claim`, `inadmissible-evidence`): the batch was not verified. Fix the claim.
- `verification-failed`: the task's segment halted on the named leaf (the message carries the gate's own reason; `verification[].operationId` reads the segment's receipt back through `execute_intent`). Dispatch a fixer to that worktree (below). Tasks whose segments committed are complete and stay complete.

Then resubmit **every required task** under a **new** batch id — a settled batch id is claimed, and a correction is a new batch. Already-complete tasks are accepted without running again:

```typescript
exarchos_orchestrate({
  action: "settle",
  featureId: "<featureId>",
  capsuleVersion: <capsuleVersion>,
  batchId: "<featureId>:wave-1:retry-1",
  claims: correctedClaims,
})
```

**`deviation-pending`** — a worker proposed a deviation inside the envelope and the envelope requires approval. Nothing was verified; no task is complete. **Human checkpoint**: present the deviation. On approval the work stands as done — resubmit the batch without the deviation under a new id; on refusal, revise the plan and `prepare` again. (Recording the decision as its own fact is the divergence loop, not yet wired.)

**Errors** (nothing adjudicated): `CAPSULE_NOT_PREPARED` — the version was never prepared here; `CAPSULE_DIGEST_MISMATCH` — a submitted capsule is not the recorded one; `CAPSULE_UNRESOLVED` — the recorded capsule cannot be applied (a task without verification terms: `prepare` again); `OPERATION_DIGEST_MISMATCH` — the batch id was already settled under different claims: use a new id; `INVALID_INPUT` — a claim the segment cannot be built from (typically no `worktreePath`), corrected under the **same** id.


### Failure Recovery

When a task fails — a subagent reports failure, or settlement rejects its claim with `verification-failed`:
1. Read the failure output from the runtime's result-collection primitive (`Task() reply (inline)`) and the settlement finding's message
2. Diagnose root cause — do NOT trust the implementer's self-assessment (see R3 adversarial posture)
3. Fix the task using the fixer flow below
4. Resubmit the batch under a new id (Step 3); settlement re-verifies the fixed task and skips the ones already complete

For the full recovery flow with a concrete example, see `references/worked-example.md`.

### Fix Failed Tasks

Dispatch a fresh fixer agent using the runtime's native spawn primitive, carrying the full failure context and the original task description:

```typescript
Task({
  subagent_type: "fixer",
  description: "Fix failed task-001",
  prompt: "Your implementation failed. [failure context from test output and the settlement finding]. Apply adversarial verification: do NOT trust your previous self-assessment, re-read actual test output, identify root cause not symptoms. [Original task context, including the capsule's terms]."
})

```


After the fix completes, the fixed task's claim goes back into the batch. No per-task gate chain is run by hand: the resubmitted `settle` runs it.

---

## Step 4: Land and Transition

1. **Land each worktree.** A settled task whose completion carries a worktree detours the workflow through `merge-pending`; land it through `serialize_merge` (see "Worktree-Bearing Tasks" below), one worktree at a time, in dependency order.
2. **Wave backstop** — once, after every merge of the wave has landed, run the cumulative suite against the integration tip:

```typescript
exarchos_orchestrate({
  action: "check_integration_suite",
  featureId: "<featureId>",
  repoRoot: "<integration worktree>",
})
```

3. **Delegation completion gate (D4, advisory)** — an operational resilience check on the full branch diff before transitioning to review:

```typescript
exarchos_orchestrate({
  action: "check_operational_resilience",
  featureId: "<featureId>",
  repoRoot: ".",
  baseBranch: "main"
})
```

This is advisory — findings are recorded for the convergence view but do not block the delegation→review transition. Include findings in the delegation summary for review-phase attention.

4. **Schema sync** — if any task modified API files (`*Endpoints.cs`, `Models/*.cs`), run `npm run sync:schemas`

5. **Transition** — see the Transition section at the end: `exarchos_workflow transition` to `review`. The tasks are already complete; nothing is patched by hand.

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

For the full transition table, consult `@skills/checkpoint/references/phase-transitions.md`.

**Quick reference:** The `delegate` → `review` transition requires guard `all-tasks-complete` — all `tasks[].status` must be `"complete"` in workflow state.

> A settled batch leaves them so: settlement's completion leaf marks each accepted task complete on the stream and on the document the guard reads. If the transition is refused, a task was rejected or held — read the settlement receipt, not the task list. Do not patch `tasks[].status` by hand to get past the guard.

### Worktree-Bearing Tasks: Auto-Detour to `merge-pending`

When a `task.completed` event carries a worktree association (`data.worktree` or `data.worktreePath`), the HSM auto-transitions through `feature/merge-pending` before reaching `review`. The `next_actions` projection surfaces the merge verb (idempotency-keyed by `${streamId}:merge_orchestrate:${taskId}`) so a runtime that consumes `next_actions` will dispatch the merge automatically.

**Land it through `serialize_merge`.** The integration branch is shared — sibling worktree merges within the same wave (or a concurrent operator) can race for it. `serialize_merge` is THE integration-merge path: it holds an optimistic per-`integrationRef` single-writer lease, then composes `merge_orchestrate` unchanged to do the local `git merge` with a recorded recovery-point SHA — see `@skills/merge-orchestrator/SKILL.md`. Do **not** dispatch raw `merge_orchestrate` to land onto the integration branch — a live foreign lease makes it fail closed (`MERGE_LEASE_HELD`, naming `serialize_merge`). Raw `merge_orchestrate` is for a non-integration merge (a private / scratch branch no sibling will touch) or a crash-resumed caller re-presenting its original lease.

The HSM exits `merge-pending` back to `delegate` once the merge terminates (`completed` / `rolled-back` / `aborted`), at which point `delegate` either re-enters `merge-pending` for the next worktree-bearing task or transitions on to `review` when all delegation is complete.

This detour is invisible to the delegation skill itself — the all-tasks-complete guard still gates the `delegate → review` transition. The merge-pending substate just sits between task completion and the next dispatch decision.

### Task Status Values

| Status | When to use |
|--------|------------|
| `pending` | Task not yet started |
| `in_progress` | Task actively being worked on |
| `complete` | Task finished successfully |
| `failed` | Task encountered an error (requires fix cycle) |

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["update", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. Use
`exarchos_orchestrate({ action: "describe", actions: ["prepare", "settle"] })`
for the plane's own schemas — what `prepare` returns and what a claim may carry.

---

## When integration advances mid-wave

Runbook for recovering when a subagent worktree's branch has diverged from the
integration branch. Triggered by the integration merge's ancestry preflight
(run by the composed `merge_orchestrate` inside `serialize_merge`): the
failure message links here verbatim and includes the manual `git rebase`
command. Auto-rebase is **not** wired today — operators
must drive recovery by hand.

### Symptom

The merge-orchestrator reports an ancestry failure of the form:

```text
source branch <feature-branch> is not a descendant of <integration-branch>.
Rebase manually with: git rebase <integration-branch> (run from the <feature-branch> worktree).
Runbook: content/delivery/skills/delegate/SKILL.md#when-integration-advances-mid-wave
```

This means the integration branch advanced (typically because an earlier
worktree merge landed) while the failing worktree was still in flight.
Fast-forward merge is no longer safe — the working branch must catch up
first.

### Why this happens

With the worktree base pinned to local HEAD (see prerequisite below), each
subagent worktree is created at the integration branch's tip at dispatch time.
When the orchestrator merges sibling worktrees serially, each merge moves the
integration branch forward. A worktree that was dispatched against an older
integration tip will fail the ancestry preflight when its turn comes.

This is expected behavior under the current single-writer merge contract —
preflight is fail-only on purpose so the operator stays in control.


### Recovery procedure

Before each step, verify you are in the **main worktree** (not the failing
subagent worktree) and that `git status` is clean.

1. **Capture the rollback SHA** before doing anything destructive:

   ```bash
   git rev-parse <feature-branch> > /tmp/rollback.sha
   ```

   Keep this until the merge has been verified. If anything goes wrong,
   `git reset --hard "$(cat /tmp/rollback.sha)"` on the feature branch
   restores the pre-rebase state. The filename is intentionally
   branch-name-free so slash-delimited branches like `feature/dr-6`
   don't break the path with embedded `/` characters.

2. **Rebase the feature branch onto the current integration tip:**

   ```bash
   cd <feature-worktree-path>
   git fetch origin
   git rebase <integration-branch>
   ```

   Resolve any conflicts that surface. The conflicts are real — they reflect
   genuine drift between the two branches, not preflight noise. Do **not**
   pass `--strategy-option=theirs` blindly; that drops the subagent's work.

3. **Re-run the integration merge from the main worktree** — through
   `serialize_merge`, which re-composes `merge_orchestrate`'s ancestry
   preflight under the single-writer lease:

   ```typescript
   exarchos_orchestrate({
     action: "serialize_merge",
     featureId: "<featureId>",
     integrationRef: "<integration-branch>",
     sourceBranch: "<feature-branch>",
     strategy: "squash",           // squash | rebase | merge
     taskId: "<taskId>",
     dryRun: false,                // REQUIRED to execute — the action DEFAULTS to dry-run
   })
   ```

   `serialize_merge` **defaults to a dry-run** (preflight only, no lease
   claimed): omit `dryRun` and it reports whether the merge *would* apply
   without mutating anything. Pass `dryRun: false` to actually claim the
   single-writer lease and perform the merge. The action is declared
   **shared-mutating**, so a read-only caller (a session without write
   capability) is denied even the apply path; in that case fall back to a
   local-git merge from the main worktree (`git merge --squash
   <feature-branch>` then commit) and record the equivalent merge
   state/events yourself, since that merge sits outside the serialized lease.

   The preflight should now pass. Proceed with the orchestrator's normal
   merge flow. (Re-run raw `merge_orchestrate` directly only for a
   non-integration merge, or as the crash-resumed caller re-presenting its
   original `leaseOperationId`.)

### Rollback procedure

If the rebase produces conflicts you cannot resolve safely, or the merge
still fails after rebase:

1. **Reset the feature branch** to the captured rollback SHA:

   ```bash
   cd <feature-worktree-path>
   git rebase --abort   # if mid-rebase
   git reset --hard "$(cat /tmp/rollback.sha)"
   ```

2. **Mark the task `failed`** in workflow state and dispatch a fixer (see
   the Failure Recovery section above). Do **not** delete the worktree —
   the fixer needs the original branch state to diagnose the conflict.

3. **Record the incident** by emitting a `merge.aborted` event with
   `reason: "ancestry-rebase-conflict"` and the failing branch's pre-rebase
   SHA so the convergence view captures the rollback.

### Why no auto-rebase yet

Auto-rebase is not yet wired. Today the orchestrator stops at
the ancestry preflight on purpose: a botched auto-rebase across diverged
worktrees risks silently dropping subagent work, and the recovery path
above is short enough that operator-driven rebase is preferable to
clever-but-fragile automation.

---

## Transition

After the batch settles and the worktrees land, **auto-continue immediately** (no user confirmation):

1. Verify all `tasks[].status === "complete"` in workflow state — a settled batch left them so
2. Transition: `exarchos_workflow({ action: "transition", featureId: "<featureId>", target: "review" })`
3. Invoke: `[Invoke the exarchos:review skill with args: <plan-path>]`

This is NOT a human checkpoint — the workflow continues autonomously.

---

## Appendix: the primitive path (non-feature workflow types)

`prepare` compiles feature workflows. When it refuses `WORKFLOW_TYPE_UNSUPPORTED` — a debug or overhaul delegation — the per-task governance calls are made by hand, in this order:

1. **Readiness** — `exarchos_orchestrate({ action: "prepare_delegation", featureId: "<featureId>", planPath: "docs/specs/<the-decomposition-spec>.md", tasks: [...] })`. Pass `planPath` so it lifts each task's `**Risk Tier:**` / `**Boundary Touching:**` stamp; `ready: false` stops the wave. It returns `implementerPromptTemplate`, a `verificationNotes` map keyed by `"<riskTier>|<boundaryTouching>"`, and `taskClassifications[i].verificationNoteKey` — splice the task's note into the template before dispatching.
2. **Dispatch and collect** as in Steps 2 and 3, with the note in place of the capsule's terms.
3. **Per completed task**, run the task-completion runbook: `exarchos_orchestrate({ action: "runbook", id: "task-completion" })` and execute the returned steps in order. Stop on gate failure. If runbook unavailable, use `describe` to retrieve gate schemas: `exarchos_orchestrate({ action: "describe", actions: ["check_test_adequacy", "check_static_analysis", "task_complete"] })`. Its terminal step records the completion with the report's provenance:

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

4. **On a gate failure**, dispatch a fixer (Fix Failed Tasks above), then run the `task-fix` runbook: `exarchos_orchestrate({ action: "runbook", id: "task-fix" })`.
5. **Update workflow state** — set each passing task's status to `"complete"` via `exarchos_workflow update` with the tasks array, then land, backstop and transition as in Step 4.

---

## References

| Document | Purpose |
|----------|---------|
| `references/implementer-prompt.md` | Full prompt template for implementation tasks |
| `references/fixer-prompt.md` | Fix agent prompt with adversarial verification posture |
| `references/worked-example.md` | Complete delegation trace with recovery path (R1) |
| `references/rationalization-refutation.md` | Common rationalizations and counter-arguments (R2) |
| `references/parallel-strategy.md` | Parallel grouping and model selection |
| `references/testing-patterns.md` | Arrange/Act/Assert, naming, mocking conventions |
| `references/pbt-patterns.md` | Property-based testing patterns |
| `references/fix-mode.md` | Detailed fix-mode process |
| `references/state-management.md` | State patterns and benchmark labeling |
| `references/troubleshooting.md` | Common failure modes and resolutions |
| `references/adaptive-orchestration.md` | Adaptive team composition |
| `references/workflow-steps.md` | Cross-platform step-by-step delegation reference |
| `references/worktree-enforcement.md` | Worktree isolation rules |
