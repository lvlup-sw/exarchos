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

The default `subagent` mode dispatches each task using the runtime's spawn primitive: `[sequential execution]`.


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

### Step 1 — Compile the batch

```typescript
exarchos_orchestrate({ action: "prepare", featureId: "<featureId>" })
```

`prepare` reads the workflow's plan and compiles its **ready frontier** — every task not yet complete whose `blockedBy` tasks are all complete — into one capsule, in custody, pinned by digest, and announces each of them (`task.assigned`) in the same commit as its record — no call precedes it. Keep the receipt: `capsuleVersion` is what `settle` is keyed by, and the `capsule` is what every subagent's packet is built from.

| In the capsule | What you read off it |
|----------------|----------------------|
| `graph.tasks[]`, `graph.dependencies[]`, `graph.joins[]` | The batch, and the order it must run in — a `dependencies` edge `{ from, to }` means `to` waits for `from` |
| `settlementContract.taskVerification[taskId]` | The task's `riskTier` and `boundaryTouching`, frozen from the plan — the model tier, and the gates settlement will run — and its `baseRef`, the integration branch the task's worktree forks from and the kill probe measures its diff from |
| `knowledge.patterns[]` | One statement per tier in the batch naming those gates — splice it into the worker's prompt verbatim |
| `contracts.taskResults[taskId]` | What the task must report back: `worktreePath` (required), `branch`, and its provenance (`files`, `implements`, `tests`, `acceptanceTestRef`) |
| `contracts.deviationEnvelope` | What a worker may propose when a capsule assumption turns out wrong (`invalidated-assumption`, `missing-context`) — instead of guessing — and which of those kinds are material (`materialDeviationKinds`: `invalidated-assumption`), so that accepting one revises the design |
| `authority.invariants[]`, `authority.escalationBoundaries[]` | What the work is judged by and what it must escalate rather than decide — paste into every packet |
| `knowledge.rationale[]` | The design of record and, on a capsule compiled under a revised design (`design-v2` or later), the accepted changes after it: one statement per change — who decided it, the change proposed when one was given, and what the deviation stated — for eight changes at most, then one statement that counts the rest |
| `executionProfile.capabilities` | What this runtime had to hold to get here; `prepare` already refused an unfit one |

**Refusals, none of which compiled anything:**

| Code | Meaning | Do |
|------|---------|----|
| `WORKFLOW_TYPE_UNSUPPORTED` | Not a feature workflow | Take the primitive path (appendix) |
| `PHASE_NOT_PREPARABLE` | Not in `delegate` | Transition first |
| `NOTHING_TO_PREPARE` | Every planned task is complete | Transition to review |
| `NO_READY_TASKS` | Tasks are pending, but each waits on a task that is not complete (the message names them) | Settle or fix the blocking tasks first; tasks that wait on each other are a cycle to break in the plan |
| `BASE_UNRESOLVED` | The workflow records no integration branch (or not a safe ref name), so no task has a base | `exarchos_workflow({ action: "update", featureId: "<featureId>", updates: { "synthesis.integrationBranch": "<branch the tasks fork from>" } })`, then `prepare` again |
| `UNKNOWN_DEPENDENCY`, `INVALID_TASK_ID`, `INVALID_TASK_STAMP`, `CAPSULE_UNSOUND` | The plan cannot be expressed as a batch | Fix the plan, `prepare` again |
| `RUNTIME_UNFIT` | This runtime lacks a capability settlement needs to verify the batch (named in the message) | Stop; do not dispatch — the batch could never settle here |
| `REVISION_UNREADABLE` | The capsule would state the accepted changes of a design revision, and the settlement bundle that holds them (named in the message) cannot be read, or lacks a deviation or an accepted decision the revision names | Restore the bundle in the run-bundle store, then `prepare` again. There is no bypass: the workflow stops here until the bundle is restored |

A retry with unchanged inputs returns the recorded capsule; a changed plan, a changed integration branch or a design revision recorded since compiles the next version, stamped with the design version it was compiled at (`identity.designVersion`, `design-v<N>`). **Prepare before every wave**, never once per workflow: a capsule holds only the ready frontier, so the second wave's capsule is compiled once the first wave has settled.

### Worktrees

Each task works in its own worktree, materialized by the host under native isolation or laid out with `setup_worktree` (the canonical `.worktrees/<taskId>-<taskName>` path). Under native isolation, confirm each agent's working directory is under `.worktrees/` **before any agent edits files** (its first reported `pwd`); an agent in the shared checkout is stopped, given a worktree created by hand (`git worktree add -b <task-branch> .worktrees/<taskId>-<taskName> <baseRef>`, the task's `baseRef` from the capsule), and only then allowed to edit. The worktree path is what the task's claim will carry, and what settlement verifies against. Fork every worktree from the task's `baseRef`: settlement's kill probe measures the task's diff from that branch, and the claim cannot name another one.

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
3. **The authority** — `authority.invariants[]` and `authority.escalationBoundaries[]`, and the **deviation envelope**: if a capsule assumption turns out wrong, the worker reports a deviation (`deviationKind` from `contracts.deviationEnvelope.allowedDeviationKinds`, a statement of what did not hold, and the change it proposes) instead of working around it silently. A deviation holds the batch for a human; a silent workaround is refused at settlement or, worse, accepted.
4. **The accepted design changes** — on a capsule compiled under a revised design, the `knowledge.rationale[]` statements that follow the design of record. A worker starts from a clean context, so its packet is where it sees what changed.

**Dispatch THAT packet — not the static agent default.** The shipped `agents/implementer.md` bakes a fixed medium-tier note (a self-contained fallback for runtimes that pre-bind a named agent). Use it verbatim only when no capsule term exists (e.g. a fixer dispatch). The tier is pure data from the capsule; no workflow-type branching is involved.

### Decision Runbooks

For dispatch strategy decisions, query the decision runbook:
`exarchos_orchestrate({ action: "runbook", id: "dispatch-decision" })`

This runbook provides structured criteria for parallel vs sequential dispatch, team sizing, and failure escalation.


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
[task output is the assistant's next message]
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

**Do NOT trust the implementer's self-assessment.** The claim says where the work is; settlement decides whether it is done. A worker that reported a deviation goes into `deviations` (`{ deviationKind, statement, affectedTasks?, proposedChange? }`), not into a fudged claim.

**A deviation says what changes, and for which tasks.** `proposedChange` is the worker's, as reported; the orchestrator fills `affectedTasks`, because only it holds the plan. Report one deviation per failed assumption, and merge the reports of the same assumption into one: a batch carries at most sixteen deviations, and one deviation names at most thirty-two tasks. Give two deviations different statements when they differ — a held receipt within its response budget lists a deviation by its id, kind, statement and affected tasks, so two that differ only in the proposed change read alike to whoever decides. A receipt that comes back as a summary (Settle, below) lists a deviation by its id and kind only; its statement and affected tasks are in the settlement bundle `bundleRefs` names.

`affectedTasks` is what a design revision goes on to name, and a revision names only unfinished tasks outside the wave being settled. A task the plan shows finished (`deviation-names-finished-task`), a task this batch claims (`deviation-names-claimed-task`) or an id the plan does not hold (`deviation-unknown-task`) is refused: the batch is rejected, not held. Finished work is not reopened — plan its rework as a new task, and name that new task.

**Verify worktree state** before settling — a dirty `git status` in a worktree is work the claim does not name.

### Settle

Each task that the capsule requires (`settlementContract.requiredResults`) needs a claim, unless the stream already shows the task complete. A submitted batch carries at least one claim. Submit the batch once, under an id that you choose. The id is the settlement key, so a retry after a timeout reuses the id and gets the same verdict:

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

Settlement first reads the shape of each claim against the capsule. If that pass finds no fault, settlement runs the verification of each claimed task through the executor. It does not run a task again when the stream already shows that task complete. The receipt gives every reason in one call: `findings` lists each fault, and `verification[]` names the segment of each task (`operationId`, `outcome`, `failedLeaf`).

A receipt over its response budget comes back as a summary. The summary always keeps the round, `designRevision`, each pending deviation (id and kind) and each decision (id and decision). Under `corrective-capsule` it also keeps the count of the unresolved tasks (`counts.unresolved`). It holds the first page of findings (`firstPage`, without the messages) and at most four `verification[]` outcomes, failures first. Each failure has its `operationId` and `failedLeaf`. It holds each unresolved task as its `taskId` and `cause`. To fit the budget, the summary drops the findings page first and the outcomes second. Then it drops unresolved entries from the end, and `counts.unresolvedOmitted` says how many. The settlement bundle that `bundleRefs` names keeps the full findings and outcomes.

The receipt names one outcome, and each outcome has one next call:

| Outcome | What settlement verified | Next call |
|---------|--------------------------|-----------|
| `settled` | Each required task is complete | None. Go to Step 4 |
| `corrective-capsule` | The tasks that passed are complete, and at least one task is unresolved | `settle`: a new batch id, the same capsule, the unresolved tasks only |
| `rejected` | Nothing | `settle`: a new batch id, the same capsule, the corrected request |
| `deviation-pending` | Nothing | `settle`: the same batch id, `decisions` only |
| `recompile-required` | Nothing | `prepare`, then `settle` under the capsule that it returns |

`settle` compiles no capsule under any outcome. Only `prepare` compiles. The design calls `settled` "accepted" and `deviation-pending` "decision-required". The recorded names stay, because stored rows, bundles and replayed receipts carry them. The schema also lists `accepted-with-rationale`, and no batch gets that outcome in this build.

**`settled`** — each required task is recorded complete (`task.completed`, from the leaf that the primitive path uses). A claimed task passed its gates in this batch, unless the stream already showed it complete. A required task without a claim was complete already. The state document that the transition guard reads is level. Go to Step 4.

**`corrective-capsule`** — at least one task is unresolved. Settlement verified the batch, and the tasks that passed are complete (`acceptedTasks`). They stay complete. The outcome has the name that the design gives it, but `settle` compiled nothing.

Read `unresolved`. It has one entry for each task to correct: the `taskId`, the `cause` (the kind of its finding, `verification-failed`), and the `failedLeaf` and `operationId` of the segment that halted. The finding message names the leaf that halted and the reason. To read the receipt of the segment, call `execute_intent` with that `operationId`. In a summary, an entry holds the `taskId` and the `cause` only, and no finding has a message. The settlement bundle that `bundleRefs` names holds each message.

Dispatch a fixer to the worktree of each unresolved task (Fix Failed Tasks, below). Then settle a **new** batch id on the **same** capsule, and claim only the unresolved tasks:

```typescript
exarchos_orchestrate({
  action: "settle",
  featureId: "<featureId>",
  capsuleVersion: <capsuleVersion>,      // the same capsule
  batchId: "<featureId>:wave-1:correction-1",
  claims: unresolvedClaims,              // one claim for each `unresolved` entry
})
```

A recorded completion satisfies a required result, so a complete task needs no claim. The receipt of the correction lists each such task in `verification[]` as `already-complete`.

If a summary omits unresolved entries (`counts.unresolvedOmitted` is more than 0), claim every required task again. Settlement runs no gate again for a complete task, and returns that task as `already-complete`.

If the receipt also carries `designRevision`, call `prepare` first (see `designRevision`, below). Then settle under the capsule that `prepare` returns. Claim each task that this capsule requires and that is not complete.

**`rejected`** — the request or a deviation is in error. Settlement verified nothing, so the batch completed no task. Read `findings`:
- A shape finding (`missing-field`, `undeclared-field`, `field-type-mismatch`, `unknown-task`, `undeclared-result-shape`, `duplicate-claim`, `missing-claim`, `inadmissible-evidence`): correct the claim. `missing-claim` names a required task that is not complete and has no claim.
- A deviation finding (`deviation-outside-envelope`, `deviation-unknown-task`, `deviation-names-finished-task`, `deviation-names-claimed-task`): the batch was not held. Correct the deviation. A kind outside the envelope is an escalation. Each of the other three is an `affectedTasks` entry that a deviation cannot name (Build the batch, above).
- `deviation-rejected`: the decision refused the deviation (see `deviation-pending`, below).

Then settle the corrected request under a **new** batch id, on the same capsule. A batch id with a verdict is claimed, so a correction is a new batch:

```typescript
exarchos_orchestrate({
  action: "settle",
  featureId: "<featureId>",
  capsuleVersion: <capsuleVersion>,
  batchId: "<featureId>:wave-1:retry-1",
  claims: correctedClaims,
})
```

An earlier build also gave `rejected` for a superseded claim and for a failed verification. A replay returns such a receipt as that build stored it, and its `acceptedTasks` can be complete.

**`deviation-pending`** — a deviation waits for its decision. A worker proposed a deviation inside the envelope, and the envelope requires approval. Settlement verified nothing, and the batch completed no task. The `pendingDeviations` of the receipt names each deviation by its `deviationId`, and the stream holds one `deviation.proposed` row for each entry. **Human checkpoint**: show each deviation with the change that it proposes (the receipt does not carry the change). Then settle the **same** batch again with the decisions and **no claims**. Settlement reads the held batch back from its record:

```typescript
exarchos_orchestrate({
  action: "settle",
  featureId: "<featureId>",
  capsuleVersion: <capsuleVersion>,
  batchId: heldBatchId,            // the batch the held receipt names, not a new one
  decisions: pendingDeviations.map(({ deviationId }) => ({
    deviationId,
    decision: "accepted",          // or "rejected"
    actor: "human:<who decided>",
    rationale: "<why>",
  })),
})
```

Decide every pending deviation in that one call. Settlement refuses a decision that omits one (`DECISION_INCOMPLETE`).

Settlement records an `accepted` decision (`deviation.decided`). Then it verifies the held work, and the verification gives the outcome: `settled` or `corrective-capsule`. If a later design revision names a task of the held batch, the outcome is `recompile-required`, and settlement verifies nothing. A correction after an accepted decision does not state the deviation again. The deviation is decided, and a second statement of it is a new proposal that holds the new batch.

Settlement records a `rejected` decision too. The outcome is `rejected` with a `deviation-rejected` finding, and settlement verifies nothing. The work that stood on the deviation is not accepted. Correct that work, and settle it under a new batch id without the deviation. If the plan holds a rework task for the refused deviation, remove that task. Then `prepare` again, and settle under the capsule that `prepare` returns.

Settlement records a decision once. The same decision sent again returns its verdict. Settlement refuses a different decision on a decided batch.

**`designRevision` on the receipt** — the round accepted at least one deviation of a material kind and recorded one design revision for it (`design.revised`, design version N to N+1), whatever the round's verdict. The receipt names the two versions and the deviations (`priorDesignVersion`, `nextDesignVersion`, `deviationIds`). After a receipt that carries a design revision, revise the plan if the accepted change needs it, then `prepare` again — the tasks the revision names settle only under a capsule compiled after it. A `recompile-required` receipt calls for the same `prepare`.

The first `prepare` after the revision is the **continuation**: the same call as in Step 1, which compiles the ready frontier as always, under the new design version, and records the recompile (`capsule.recompiled`) in the same commit as its record. The receipt that comes back carries `recompile` — the capsule version it follows and the design versions it spans (`priorCapsuleVersion`, `priorDesignVersion`, `nextDesignVersion`), the tasks the revision named (`declaredTasks`), and the tasks the revision invalidated (`invalidatedTasks`): each unfinished task it named and each unfinished task that waits on one of those, directly or through other unfinished tasks. Finished work stands, and so does a task that waits on finished work alone. Its capsule carries the accepted change (`knowledge.rationale[]`). An invalidated task that is not ready yet is on that list and not in that capsule: a later `prepare` compiles it, under the same design version, once its blockers are complete. A replayed receipt repeats the recompile it recorded; it is not a new one, and nothing is appended.

**`recompile-required`** — the capsule was stale when the batch arrived. The stream recorded a design revision after the capsule. That revision names a task that the batch claims, or a required task that is not complete. The finding is `claim-superseded-by-revision`. Settlement verified nothing, and the unfinished tasks of the batch stay unfinished. A capsule with an unfinished required task that the revision names settles no new batch. A decision round can return this outcome too, and its decision stays recorded.

Call `prepare` again. Then settle under the capsule that `prepare` returns. Claim each task that this capsule requires and that is not complete. The work of a task that the revision names used the earlier terms. The new capsule states the accepted change (`knowledge.rationale[]`), so read that change before you claim the work again.

**Errors** (nothing adjudicated). Each of these codes is a failed call that adjudicated nothing:

- `CAPSULE_INVALID`: a submitted capsule does not satisfy the capsule contract.
- `CAPSULE_NOT_PREPARED`: no `prepare` call recorded this capsule version here.
- `CAPSULE_DIGEST_MISMATCH`: a submitted capsule is not the recorded one.
- `CAPSULE_UNRESOLVED`: settlement cannot apply the recorded capsule. If a task has no verification terms, `prepare` again.
- `OPERATION_DIGEST_MISMATCH`: the batch id has a verdict for a different request, or a different decision stands. Use a new batch id, or send the decision that stands.
- `BATCH_NOT_HELD`: the decisions name a batch that has no verdict, or a batch that is not held. No deviation waits for a decision.
- `DECISION_INCOMPLETE`: the decision answers fewer deviations than the batch waits on.
- `STATE_SYNC_FAILED`: the write of the state document failed. Settle the same batch again.
- `INVALID_INPUT`: settlement cannot build the segment from a claim (typically no `worktreePath`), a submitted batch carries no claim, or a decision carries claims or names no pending deviation. Correct the request and use the **same** batch id.


### Failure Recovery

When a task fails — a subagent reports failure, or settlement leaves the task unresolved (`corrective-capsule`, with a `verification-failed` finding):
1. Read the failure output from the runtime's result-collection primitive (`[task output is the assistant's next message]`) and the settlement finding's message
2. Diagnose root cause — do NOT trust the implementer's self-assessment (see R3 adversarial posture)
3. Fix the task using the fixer flow below
4. Settle a new batch id on the same capsule that claims the fixed task (Step 3). Settlement verifies that task, and a complete task needs no claim

For the full recovery flow with a concrete example, see `references/worked-example.md`.

### Fix Failed Tasks

Dispatch a fresh fixer agent using the runtime's native spawn primitive, carrying the full failure context and the original task description:

```typescript
Execute each task sequentially in the current session, one at a time, against the prepared worktrees.
```


After the fix completes, claim the fixed task in a new batch on the same capsule. Do not run a gate chain by hand: the new `settle` call runs it.

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

> A settled batch leaves them so: settlement's completion leaf marks each accepted task complete on the stream and on the document the guard reads. If the transition is refused, a task is not complete: its batch has an unresolved task, or the batch was rejected, held or stale. Read the settlement receipt, not the task list. Do not patch `tasks[].status` by hand to get past the guard.

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

1. **Readiness** — `exarchos_orchestrate({ action: "prepare_delegation", featureId: "<featureId>", planPath: "docs/specs/<the-decomposition-spec>.md", tasks: [...] })`. It announces the plan's tasks (`task.assigned`) itself before reading readiness, so no append precedes it. Pass `planPath` so it lifts each task's `**Risk Tier:**` / `**Boundary Touching:**` stamp; `ready: false` stops the wave. It returns `implementerPromptTemplate`, a `verificationNotes` map keyed by `"<riskTier>|<boundaryTouching>"`, and `taskClassifications[i].verificationNoteKey` — splice the task's note into the template before dispatching. It also returns `baseBranch`, the integration branch the tasks fork from: **record it** for step 3.
2. **Dispatch and collect** as in Steps 2 and 3, with the note in place of the capsule's terms.
3. **Per completed task**, run the task-completion runbook: `exarchos_orchestrate({ action: "runbook", id: "task-completion" })` and execute the returned steps in order. Stop on gate failure. Bind the `<baseRef>` template variable to the `baseBranch` recorded in step 1: the kill probe blocks with `base-missing` without it. If runbook unavailable, use `describe` to retrieve gate schemas: `exarchos_orchestrate({ action: "describe", actions: ["check_test_adequacy", "check_static_analysis", "task_complete"] })`. Its terminal step records the completion with the report's provenance:

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
