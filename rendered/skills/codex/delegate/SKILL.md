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

The default `subagent` mode dispatches each task using the runtime's spawn primitive: `spawn_agent`.


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
exarchos_orchestrate({ action: "prepare", featureId: "<featureId>", repoRoot: "<absolute path of the worktree that holds baseRef>" })
```

`prepare` reads the workflow's plan and compiles its **ready frontier** — every task not yet complete whose `blockedBy` tasks are all complete — into one capsule, in custody, pinned by digest, and announces each of them (`task.assigned`) in the same commit as its record — no call precedes it. Keep the receipt: `capsuleVersion` is what `settle` is keyed by, and the `capsule` is what every subagent's packet is built from.

`repoRoot` is required, and it must be an absolute path. Pass the tree that holds `baseRef`: the worktree where the integration branch is checked out. `prepare` reads the repository, the config and the invariant catalogs from that checkout, never from the directory of the server. It pins the repository and the checkout in the capsule (`settlementContract.scope`), and the commit of `baseRef` for each task (`baseCommit`).

| In the capsule | What you read off it |
|----------------|----------------------|
| `graph.tasks[]`, `graph.dependencies[]`, `graph.joins[]` | The batch, and the order it must run in — a `dependencies` edge `{ from, to }` means `to` waits for `from` |
| `settlementContract.taskVerification[taskId]` | The task's `riskTier` and `boundaryTouching`, frozen from the plan — the model tier, and the gates settlement will run — its `baseRef`, the integration branch the kill probe measures its diff from, and its `baseCommit`, the commit of `baseRef` at `prepare`, where the task's worktree starts |
| `settlementContract.scope` | The repository (`repository`, its git common dir), the checkout that `prepare` read (`checkout`) and the digest of the config files of that checkout (`configDigest`). Settlement refuses a claimed worktree outside this scope, and a config that changed after `prepare` |
| `knowledge.patterns[]` | One statement per tier in the batch naming those gates — splice it into the worker's prompt verbatim |
| `contracts.taskResults[taskId]` | What the task must report back: `worktreePath` (required), `branch`, and its provenance (`files`, `implements`, `tests`, `acceptanceTestRef`) |
| `contracts.deviationEnvelope` | What a worker may propose when a capsule assumption turns out wrong (`invalidated-assumption`, `missing-context`) — instead of guessing — and which of those kinds are material (`materialDeviationKinds`: `invalidated-assumption`), so that accepting one revises the design |
| `authority.invariants[]`, `authority.escalationBoundaries[]` | What the work is judged by and what it must escalate rather than decide — paste into every packet |
| `authority.delegatedDecisions[]` | The decisions that the capsule leaves to the worker, each with an `id`. A claim can record a choice under one of these ids as a `rationale`. Paste them into every packet |
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
| `BASE_UNRESOLVED` | The repository of the checkout holds no commit of the integration branch, or a completed blocker of a batch task landed on a commit that the base does not hold (both named in the message) | Create the branch, or pass a `repoRoot` that holds it. Land the blocker, then `prepare` again. A blocker that landed by a squash or a rebase outside `serialize_merge` needs a recorded `merge.executed` row (`references/troubleshooting.md`) |
| `SCOPE_UNRESOLVED` | `repoRoot` is not in a git work tree or is in another repository than the latest capsule, the config of the checkout does not load, a registered catalog does not resolve, or the config does not make `check_static_analysis` blocking (named in the message) | Correct the cause that the message names, then `prepare` again (`references/troubleshooting.md`) |
| `UNKNOWN_DEPENDENCY`, `INVALID_TASK_ID`, `INVALID_TASK_STAMP`, `CAPSULE_UNSOUND` | The plan cannot be expressed as a batch | Fix the plan, `prepare` again |
| `RUNTIME_UNFIT` | This runtime lacks a capability settlement needs to verify the batch (named in the message) | Stop; do not dispatch — the batch could never settle here |
| `REVISION_UNREADABLE` | The capsule would state the accepted changes of a design revision, and the settlement bundle that holds them (named in the message) cannot be read, or lacks a deviation or an accepted decision the revision names | Restore the bundle in the run-bundle store, then `prepare` again. There is no bypass: the workflow stops here until the bundle is restored |

A retry with unchanged inputs returns the recorded capsule; a changed plan, a changed integration branch or base commit, another checkout, an edit of a config file or of the design record, or a design revision recorded since compiles the next version, stamped with the design version it was compiled at (`identity.designVersion`, `design-v<N>`). **Prepare before every wave**, never once per workflow: a capsule holds only the ready frontier, so the second wave's capsule is compiled once the first wave has settled.

### Worktrees

Each task works in a linked worktree of its own, materialized by the host under native isolation or laid out with `setup_worktree` (the canonical `.worktrees/<taskId>-<taskName>` path). A task never runs in the checkout that `prepare` read or in the primary worktree of the repository. `settle` and `task_complete` refuse both (`the-checkout`), because each task of a prepared workflow runs in its own linked worktree. Under native isolation, confirm each agent's working directory is under `.worktrees/` **before any agent edits files** (its first reported `pwd`); an agent in the shared checkout is stopped, given a worktree created by hand (`git worktree add --detach .worktrees/<taskId>-<taskName> <baseCommit>`, the task's `baseCommit` from the capsule), and only then allowed to edit. The hand-made worktree is detached, so the base step of the agent makes the branch of the task. The worktree path is what the task's claim will carry, and what settlement verifies against.

The worker starts from `<baseCommit>`. After its entry checks and before any file change, an implementer or a scaffolder runs `git switch -c <own branch> <baseCommit>` (the base step of its agent definition), so its worktree holds the base on each runtime. `<own branch>` is a name that no branch holds yet. It is not the branch of the worktree that `setup_worktree` or `git worktree add -b` made, because git refuses `git switch -c` for a branch that exists. A fixer continues the earlier branch of its task (Fix Failed Tasks, below). Settlement refuses a worktree whose HEAD does not hold `<baseCommit>` (`base-not-held`) and a worktree on `baseRef` (`on-the-base-branch`). The kill probe measures the task's diff from `baseRef`. Leave each worktree clean: settlement refuses a worktree whose `git status --porcelain` is not empty (`uncommitted-changes`). A linked `node_modules` needs the ignore rule `node_modules`, without a trailing slash.

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

1. **The task's verification terms** — its `riskTier` and `boundaryTouching`, and the `knowledge.patterns[]` statement for that tier. The worker then knows which gates settlement runs on its worktree (a low-tier task: static analysis; a medium one: the test-adequacy kill probe too; a boundary-touching one: contract drift beside them), and writes tests that can actually fail rather than performing ceremony. The terms also give the base: the prompt names `<baseCommit>`, the `baseCommit` of the task, in the place of the integration tip, and the worker starts its own branch there.
2. **The result contract** — the `contracts.taskResults[taskId]` fields. The worker's completion report is the claim: `worktreePath`, `branch`, `files`, `implements`, `tests`. No evidence field exists to fill: the evidence is what settlement records when it runs the gates. A worker that did not complete its task reports a status and a reason, and no result fields (Build the batch, Step 3).
3. **The authority** — `authority.invariants[]` and `authority.escalationBoundaries[]`, and the **deviation envelope**: if a capsule assumption turns out wrong, the worker reports a deviation (`deviationKind` from `contracts.deviationEnvelope.allowedDeviationKinds`, a statement of what did not hold, and the change it proposes) instead of working around it silently. A deviation holds the batch for a human; a silent workaround is refused at settlement or, worse, accepted.
4. **The delegated decisions** — `authority.delegatedDecisions[]`, each with its `id` and its statement. The worker makes these choices and needs no approval for them. It can record a choice in its report as a rationale that names the `id`. A rationale cannot name another id: a choice outside the delegated decisions goes in a deviation.
5. **The accepted design changes** — on a capsule compiled under a revised design, the `knowledge.rationale[]` statements that follow the design of record. A worker starts from a clean context, so its packet is where it sees what changed.

**Dispatch THAT packet — not the static agent default.** The shipped `agents/implementer.md` bakes a fixed medium-tier note (a self-contained fallback for runtimes that pre-bind a named agent). Use it verbatim only when no capsule term exists (e.g. a fixer dispatch). The tier is pure data from the capsule; no workflow-type branching is involved.

### Decision Runbooks

For dispatch strategy decisions, query the decision runbook:
`exarchos_orchestrate({ action: "runbook", id: "dispatch-decision" })`

This runbook provides structured criteria for parallel vs sequential dispatch, team sizing, and failure escalation.


### Parallel Dispatch

Dispatch all independent tasks using the runtime's native spawn primitive in a **single message** so the dispatches run in parallel.

```typescript
spawn_agent({
  agent_type: "default",
  message: "Implement task-001: [title]\n\nTask-specific context: requirements, file paths, acceptance criteria"
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
wait_agent({ task_id })
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

**A task that is not completed gets a status, not a result.** A claim has an optional `status`. The default is `completed`. When the task has no result that settlement can verify, send one of the other three values:

| `status` | Send it when |
|----------|--------------|
| `failed` | The worker attempted the task and has no result to verify |
| `blocked` | The task cannot proceed until something outside the task changes |
| `skipped` | The task was not attempted in this run |

```typescript
const notCompleted = {
  taskId: "<taskId>",
  status: "blocked",                     // or "failed", or "skipped"
  reason: "<why the task is not completed>",
}
```

A claim with one of these three values needs a `reason` of at most 280 characters. It carries no `fields`, no `evidence` and no `rationale`. A completed claim carries no `reason`. Settlement refuses a claim that breaks one of these rules as invalid input (`INVALID_INPUT`), and it adjudicates nothing.

Settlement runs no gate for such a claim, and it records no completion from it. The task stays unresolved and is never complete from that claim. Settlement still verifies the completed claims of the batch (see `corrective-capsule`, below). The status is on the claim only: settlement records no `task.failed` row, and `tasks[].status` does not change. If the stream already shows the task complete, the recorded completion stands, and the claim gives no finding.

**A choice inside the delegated freedom goes on the claim as a rationale.** The capsule lists the decisions that it leaves to the worker (`authority.delegatedDecisions`), each with an `id`. The capsule that `prepare` compiles lists two: `implementation-approach` and `execution-order`. A completed claim can record a choice under one of these ids:

```typescript
const withChoice = {
  taskId: r.taskId,
  fields: { worktreePath: r.worktreePath /* and the other fields of the result contract */ },
  evidence: [],
  rationale: [
    { delegatedDecision: "implementation-approach", statement: "<the choice, in the words of the worker>" },
  ],
}
```

A claim records at most four choices, and a `statement` holds at most 280 characters. A rationale changes no gate: settlement runs the same verification for the task with it and without it. It is not evidence, and it does not accept a claim that has a finding. An id that the capsule does not list is the finding `rationale-not-delegated`, and the batch is rejected. A choice outside the delegated decisions is a deviation, so it goes in `deviations`.

**A deviation says what changes, and for which tasks.** `proposedChange` is the worker's, as reported; the orchestrator fills `affectedTasks`, because only it holds the plan. Report one deviation per failed assumption, and merge the reports of the same assumption into one: a batch carries at most sixteen deviations, and one deviation names at most thirty-two tasks. Give two deviations different statements when they differ — a held receipt within its response budget lists a deviation by its id, kind, statement and affected tasks, so two that differ only in the proposed change read alike to whoever decides. A receipt that comes back as a summary (Settle, below) lists a deviation by its id and kind only; its statement and affected tasks are in the settlement bundle `bundleRefs` names.

`affectedTasks` is what a design revision goes on to name, and a revision names only unfinished tasks. Settlement refuses three kinds of entry, and the batch is then rejected, not held:

- a task that the plan shows finished (`deviation-names-finished-task`)
- a task that this batch claims as completed (`deviation-names-claimed-task`)
- an id that the plan does not hold (`deviation-unknown-task`)

Finished work is not reopened — plan its rework as a new task, and name that new task.

**A worker whose own task rests on a wrong assumption reports the task as blocked.** The claim for the task has the status `blocked` and a reason, and the deviation names the task in `affectedTasks`. A deviation can name a task of its own batch only when the claim reports that task as `failed`, `blocked` or `skipped`. Such a claim returns no result, so the deviation changes work that is still to do. The decision round leaves that task unresolved (see `deviation-pending`, below).

**Verify worktree state** before settling — a dirty `git status` in a worktree is work the claim does not name. Settlement refuses such a worktree (`uncommitted-changes`). Commit the files of the task, remove each file that a gate run left, and commit none of those.

### Settle

Each task that the capsule requires (`settlementContract.requiredResults`) needs a claim, unless the stream already shows the task complete. A submitted batch carries at least one claim. Submit the batch once, under an id that you choose. The id is the settlement key:

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

**A client error or an interrupt does not stop the call.** The server does not read the cancel request of the client, so the first call can still run to its end. Then:

- Retry from the same session, with the same batch id. The server runs one call for each batch id at a time. The retry waits for the first call, and then gets the verdict that the first call recorded.
- A retry from another session or from the CLI runs in another server process. It does not wait. It can run the gates of a task again, on the same worktree, while the first call still runs them.
- Do not edit, commit or dispatch work in a task worktree until a verdict returns. The probe of each task reverts the task source in its worktree, and then writes its snapshot back over the tracked files. A change in that window is lost, and a commit in that window holds the reverted source.

Settlement first reads each claim and each deviation against the capsule. When the capsule pins a scope, it also observes with git the worktree of each completed claim, before any gate runs: a worktree outside the scope gives the finding `worktree-out-of-scope` for its task (below). A finding that makes the batch stale, rejected or held stops the batch, and settlement then verifies nothing at its read. If no finding stops the batch, settlement runs the verification of each completed claim that has no finding, through the executor. A claim that reports a status does not stop the batch, and its task gets no verification. Settlement does not run a task again when the stream already shows that task complete. The receipt gives every reason in one call: `findings` lists each fault, and `verification[]` names the segment of each task (`operationId`, `outcome`, `failedLeaf`).

A receipt over its response budget comes back as a summary. The summary always keeps the round, `designRevision`, each pending deviation (id and kind) and each decision (id and decision). Under `corrective-capsule` it also keeps the count of the unresolved tasks (`counts.unresolved`). It holds the first page of findings (`firstPage`, without the messages) and at most four `verification[]` outcomes, failures first. Each failure has its `operationId` and `failedLeaf`. It holds each unresolved task as its `taskId` and `cause`. To fit the budget, the summary drops the findings page first and the outcomes second. Then it drops unresolved entries from the end, and `counts.unresolvedOmitted` says how many. The settlement bundle that `bundleRefs` names keeps the full findings and outcomes.

The receipt names one outcome, and each outcome has one next call:

| Outcome | What settlement verified | Next call |
|---------|--------------------------|-----------|
| `settled` | Each required task is complete | None |
| `accepted-with-rationale` | Each required task is complete, and a claim records a delegated choice | None |
| `corrective-capsule` | The tasks that passed are complete, and at least one task is unresolved | Settle a new batchId on the same capsule with only the `unresolved` tasks |
| `rejected` | Nothing | Settle the correction under a new batchId |
| `deviation-pending` | Nothing | Settle the same batchId with `decisions` only |
| `recompile-required` | Nothing | Prepare, then settle under the new capsule |

Settlement reads the stream again after its segments and inside its commit. If the rows change between two reads, the outcome can change. A task that a segment verified before a read changed stays complete. Thus a `recompile-required` or `rejected` receipt can list in `verification[]` tasks that settlement verified before a read changed.

After `settled` or `accepted-with-rationale`, go to Step 4. A receipt with a `designRevision` takes the next call of `recompile-required` under each outcome (see `designRevision`, below).

`settle` compiles no capsule under any outcome. Only `prepare` compiles. The design calls `settled` "accepted" and `deviation-pending` "decision-required". It calls the choice that `accepted-with-rationale` records a permitted deviation. The recorded names stay, because stored rows, bundles and replayed receipts carry them.

**`settled`** — each required task is recorded complete (`task.completed`, from the leaf that the primitive path uses). A claimed task passed its gates in this batch, unless the stream already showed it complete. A required task without a claim was complete already. The state document that the transition guard reads is level. Go to Step 4.

**`accepted-with-rationale`** — the batch is settled, and an accepted claim records a delegated choice (Build the batch, above). Each required task is recorded complete, as under `settled`, and the same gates ran. The `execution.settled` row names each choice by its task and its decision id (`rationales`). The settlement bundle that `bundleRefs` names keeps each statement. The receipt has no field for the choices, because the outcome says that a claim records one. Go to Step 4.

A finding decides the outcome before a rationale does. Thus a batch with an unresolved task is `corrective-capsule`, and its row still names the choices of the tasks that passed. The correction of that batch is `settled`, unless one of its own claims records a choice.

**`corrective-capsule`** — at least one task is unresolved. Settlement verified the batch, and the tasks that passed are complete (`acceptedTasks`). They stay complete. The outcome has the name that the design gives it, but `settle` compiled nothing.

Read `unresolved`. It has one entry for each task to correct, with the `taskId` and the `cause`. The `cause` is the kind of the finding against the task:

| `cause` | What it says | Before the correction |
|---------|--------------|-----------------------|
| `verification-failed` | A gate of the task halted. The entry also has the `failedLeaf` and the `operationId` of the segment | Dispatch a fixer to the worktree of the task (Fix Failed Tasks, below) |
| `worktree-out-of-scope` | The claimed worktree fails a scope rule of the capsule, so no gate ran. The finding message names the rule (`unobservable`, `not-a-worktree-root`, `other-repository`, `the-checkout`, `on-the-base-branch`, `other-branch`, `base-not-held`, `uncommitted-changes` or `shared-worktree`) and the recovery | Do what the message says: fork a worktree of its own from `baseRef` at `baseCommit`, or commit the listed files of the task and remove each file that a gate run left. `references/troubleshooting.md` gives each rule |
| `task-failed` | The claim reported the task as `failed` | Dispatch a fixer, or dispatch the task again |
| `task-blocked` | The claim reported the task as `blocked` | Remove the block. If a deviation named the task, the receipt can carry `designRevision` (below) |
| `task-skipped` | The claim reported the task as `skipped` | Dispatch the task |

A halt at a gate leaf gives `verification-failed` when the leaf kept its contract. A gate that did not run to a verdict is also `verification-failed`: its admission was refused, it had no handler, or its handler failed. A segment can also halt at the completion leaf, at a leaf that the runbook does not name, or because a leaf broke its contract (`INTENT_EMISSION_CONTRACT_VIOLATED`), also at a gate leaf. Such a halt is not a gate verdict. After the segments, settlement reads the completion rows again. If the stream now records a halted task complete, completion wins: the task is complete, and `verification[]` lists it as `already-complete`. Otherwise a halt that is not a gate verdict fails the call with no verdict (Errors, below).

The finding message of a halted segment names the leaf and the reason. The finding message of a reported status gives the reason of the worker. In a summary, an entry holds the `taskId` and the `cause` only, and no finding has a message. The settlement bundle that `bundleRefs` names holds each message.

To read the receipt of a halted segment, send the call that settlement made for the task. Take the `operationId` from the `verification[]` entry or the `unresolved` entry of the task. Use only that `operationId`, because another id runs the whole segment again, `task_complete` too, outside settlement. A capped summary keeps no `operationId` on an `unresolved` entry, so then take it from the `verification` list of the settlement bundle that `bundleRefs` names. Take `riskTier`, `boundaryTouching` and `baseRef` from the terms of the task in the capsule (`settlementContract.taskVerification[taskId]`). Take `capsuleVersion` from the batch, and the other arguments from the claim:

```typescript
exarchos_orchestrate({
  action: "execute_intent",
  intent: "task-completion",
  featureId: "<featureId>",
  operationId: "<operationId>",          // of the segment of the task
  args: {
    taskId: "<taskId>",
    worktreePath: "<worktreePath>",      // from the claim
    branch: "<branch>",                  // from the claim, only when the claim has one
    riskTier: "<riskTier>",              // from the capsule terms of the task
    boundaryTouching: <boundaryTouching>,
    baseRef: "<baseRef>",
    result: claimFields,                 // each field of the claim, in the key order of the claim
    capsuleVersion: <capsuleVersion>,    // the capsule of the batch
  },
})
```

The call runs nothing again. It returns the recorded receipt. For a halted segment, that is the code `INTENT_SEGMENT_FAILED`, the message of the leaf, and `error.intentReceipt`. Other arguments, or the keys of `result` in another order, make a different request. The call then fails with `INTENT_REPLAY_DIGEST_MISMATCH`, and nothing runs.

Then settle a **new** batch id on the **same** capsule, and claim only the unresolved tasks:

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

If a task is still not completed, claim it with its status and reason again. That batch is `corrective-capsule` again, and the task stays unresolved. Settlement sets no limit on the number of corrections, so decide when to stop and ask a human.

If a summary omits unresolved entries (`counts.unresolvedOmitted` is more than 0), claim every required task again. Settlement runs no gate again for a complete task, and returns that task as `already-complete`.

If the receipt also carries `designRevision`, call `prepare` first (see `designRevision`, below). Then settle under the capsule that `prepare` returns. Claim each task that this capsule requires and that is not complete. A blocked task that its own deviation named takes this path. The revision names the task, so a new batch on the earlier capsule is `recompile-required`.

The tasks of `acceptedTasks` are complete, so `prepare` can compile a task that waits on one of them. A worktree forks from the `baseRef` of its task, the integration branch, and that branch holds only landed work. Land each task of `acceptedTasks` (Step 4, item 1) before you create the worktree of a task that waits on it.

**`rejected`** — the request or a deviation is in error. At its read, settlement verified nothing. A task that a segment verified before a read changed stays complete, and `verification[]` lists it. Read `findings`:
- A shape finding (`missing-field`, `undeclared-field`, `field-type-mismatch`, `unknown-task`, `undeclared-result-shape`, `duplicate-claim`, `missing-claim`, `inadmissible-evidence`): correct the claim. `missing-claim` names a required task that is not complete and has no claim. A claim with a status and a reason is a claim. Send one for a task that is not completed.
- `rationale-not-delegated`: a rationale names a decision id that the capsule does not list. The finding message lists the ids of the capsule. Remove the entry, or report the choice as a deviation.
- A deviation finding (`deviation-outside-envelope`, `deviation-unknown-task`, `deviation-names-finished-task`, `deviation-names-claimed-task`): the batch was not held. Correct the deviation. A kind outside the envelope is an escalation. Each of the other three is an `affectedTasks` entry that a deviation cannot name (Build the batch, above). On a decision round, `deviation-names-finished-task` comes from a held batch (`deviation-pending`, below).
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

**`deviation-pending`** — a deviation waits for its decision. A worker proposed a deviation inside the envelope, and the envelope requires approval. At its read, settlement verified nothing, and the batch completed no task. The `pendingDeviations` of the receipt names each deviation by its `deviationId`, and the stream holds one `deviation.proposed` row for each entry. **Human checkpoint**: show each deviation with the change that it proposes (the receipt does not carry the change). A person decides each deviation. You do not decide it, and the worker that proposed it does not decide it. In a run with no person, stop at the held batch: report the held receipt and its pending deviations, and send no decision. When a person has decided, settle the **same** batch again with the decisions and **no claims**. Settlement reads the held batch back from its record:

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

Settlement records an `accepted` decision (`deviation.decided`). Then it verifies the held work, and the result gives the outcome: `settled`, `accepted-with-rationale` or `corrective-capsule`. The held claims keep each status, reason and rationale. If a later design revision names a task of the held batch, the outcome is `recompile-required`, and settlement verifies nothing at its read. If an accepted deviation names a task that is finished at the read of the round, the outcome is `rejected` with `deviation-names-finished-task`. That deviation records no revision, and each other accepted material deviation still records its revision. Plan the rework of the finished task as a new task, and name the new task. A correction after an accepted decision does not state the deviation again. The deviation is decided, and a second statement of it is a new proposal that holds the new batch.

**A blocked task that its own deviation names.** The held batch reports the task as `blocked`, and the deviation names that task. After an `accepted` decision, settlement verifies the completed claims of the batch. The blocked task is unresolved, so the outcome is `corrective-capsule` with the cause `task-blocked`.

If the deviation kind is material, the receipt also carries `designRevision`, and the revision names the blocked task. Call `prepare` first. The continuation compiles the task under the new design version, and its capsule states the accepted change. Land each task of `acceptedTasks` (Step 4, item 1) before you create the worktree of a task that waits on it. Dispatch the task from the new packet, and settle it under the new capsule. A batch on the earlier capsule is `recompile-required`, whether it claims the task, reports it again or omits it.

If the deviation kind is not material, the receipt carries no `designRevision`. Remove the block. Then settle the task in a new batch on the same capsule.

Settlement records a `rejected` decision too. The outcome is `rejected` with a `deviation-rejected` finding, and settlement verifies nothing at its read. The work that stood on the deviation is not accepted. Correct that work, and settle it under a new batch id without the deviation. If the plan holds a rework task for the refused deviation, remove that task. Then `prepare` again, and settle under the capsule that `prepare` returns.

Settlement records a decision once. The same decision sent again returns its verdict. Settlement refuses a different decision on a decided batch.

**`designRevision` on the receipt** — the round accepted at least one deviation of a material kind and recorded one design revision for it (`design.revised`, design version N to N+1), whatever the round's verdict. The receipt names the two versions and the deviations (`priorDesignVersion`, `nextDesignVersion`, `deviationIds`). After a receipt that carries a design revision, revise the plan if the accepted change needs it, then `prepare` again — the tasks the revision names settle only under a capsule compiled after it. A `recompile-required` receipt calls for the same `prepare`.

The first `prepare` after the revision is the **continuation**: the same call as in Step 1, which compiles the ready frontier as always, under the new design version, and records the recompile (`capsule.recompiled`) in the same commit as its record. The receipt that comes back carries `recompile` — the capsule version it follows and the design versions it spans (`priorCapsuleVersion`, `priorDesignVersion`, `nextDesignVersion`), the tasks the revision named (`declaredTasks`), and the tasks the revision invalidated (`invalidatedTasks`): each unfinished task it named and each unfinished task that waits on one of those, directly or through other unfinished tasks. Finished work stands, and so does a task that waits on finished work alone. Its capsule carries the accepted change (`knowledge.rationale[]`). An invalidated task that is not ready yet is on that list and not in that capsule: a later `prepare` compiles it, under the same design version, once its blockers are complete. A replayed receipt repeats the recompile it recorded; it is not a new one, and nothing is appended.

**`recompile-required`** — the capsule was stale when the batch arrived. The stream recorded a design revision after the capsule. That revision names a task that the batch claims, or a required task that is not complete. The finding is `claim-superseded-by-revision`. A revision that commits while settlement works gives this outcome too. At its read, settlement verified nothing, and the unfinished tasks of the batch stay unfinished. A task that a segment verified before the revision committed stays complete, and `verification[]` lists it. A capsule with an unfinished required task that the revision names settles no new batch. A decision round can return this outcome too, and its decision stays recorded.

Call `prepare` again. Then settle under the capsule that `prepare` returns. Claim each task that this capsule requires and that is not complete. The work of a task that the revision names used the earlier terms. The new capsule states the accepted change (`knowledge.rationale[]`), so read that change before you claim the work again.

Say that a revision that names a task commits while the segment of that task runs. Then `task_complete`, the last leaf of the segment, refuses the task with `TASK_SUPERSEDED_BY_REVISION`. The read after the segments then gives `recompile-required`. A direct call of `task_complete` refuses a task that a revision names after its capsule in the same way. Then `prepare` again, and complete the task under the new capsule.

**Errors** (nothing adjudicated). Each of these codes is a failed call that adjudicated nothing:

- `CAPSULE_INVALID`: a submitted capsule does not satisfy the capsule contract.
- `CAPSULE_NOT_PREPARED`: no `prepare` call recorded this capsule version here.
- `CAPSULE_DIGEST_MISMATCH`: a submitted capsule is not the recorded one.
- `CAPSULE_UNRESOLVED`: settlement cannot apply the recorded capsule. If a task has no verification terms, `prepare` again. A batch that needs a segment gets it for two more causes. The capsule pins no scope, or a task of the batch has no `baseCommit`: `prepare` again, then claim the tasks in a new batch. The config files of the checkout changed after `prepare`: `prepare` again with the same `repoRoot`, then claim the tasks in a new batch. On a decision round a new `prepare` does not help, because a held batch stays on its capsule version, so the message names other routes (`references/troubleshooting.md`).
- `OPERATION_DIGEST_MISMATCH`: the batch id has a verdict for a different request, or a different decision stands. Use a new batch id, or send the decision that stands. A batch with no verdict whose segments an earlier build ran gets this code too, because this build adds `capsuleVersion` to the request of each segment. Settle the claims of such a batch under a new batch id.
- `CONCURRENCY_CONFLICT`: the reads that decide the verdict changed before each of three commits, so the call recorded no verdict. Settle the same batch id again. The retry replays the segments that verified tasks and runs none of their gates again.
- `BATCH_NOT_HELD`: the decisions name a batch that has no verdict, or a batch that is not held. No deviation waits for a decision.
- `DECISION_INCOMPLETE`: the decision answers fewer deviations than the batch waits on.
- `STATE_SYNC_FAILED`: the write of the state document failed, and the facts on the stream stand. Run `exarchos_workflow reconcile`, then settle the same batch again. If the refusal comes back, stop and report it to a person. A version gap in the stored document makes each retry fail. On a retry of a batch that has a verdict, `error.settlementReceipt` holds that verdict. Over the receipt budget, it holds the capped summary.
- `INTENT_SEGMENT_FAILED` or `INTENT_EMISSION_CONTRACT_VIOLATED`: the segment of a task halted, and the halt is not a gate verdict. The leaf is not a gate, or the leaf broke its contract. The completion leaf halts so when `task_complete` refuses the task, or after eight sequence conflicts in a row. That halt fails the call only when the batch still verifies at the read after the segments. The message names the task and the leaf. The segment record stays, so a retry of the same batch id gets the same halt, unless the stream then records the task complete. Correct the cause, then settle the claims once under a new batch id. If the same halt comes back, stop and report it to a person. A static-analysis gate that skips (no toolchain) does not halt the segment. `task_complete` then refuses with `GATE_NOT_PASSED`. That is such a halt, and a new batch id gets it again. A commit or a switch of the branch in the worktree while the segment runs also makes `task_complete` refuse (`other-tree`, `tree-out-of-scope`): leave each task worktree alone until a verdict returns.
- `INVALID_INPUT`: settlement cannot build the segment from a claim (typically no `worktreePath`), a submitted batch carries no claim, or a decision carries claims or names no pending deviation. A claim that breaks a rule of its `status`, `reason` or `rationale` gets this code too (Build the batch, above). Correct the request and use the **same** batch id.


### Failure Recovery

When a task fails — a subagent reports failure, or settlement leaves the task unresolved (`corrective-capsule`):
1. Read the failure output from the runtime's result-collection primitive (`wait_agent({ task_id })`) and the settlement finding's message
2. Diagnose root cause — do NOT trust the implementer's self-assessment (see R3 adversarial posture)
3. Fix the task using the fixer flow below
4. Settle a new batch id on the same capsule that claims the fixed task (Step 3). Settlement verifies that task, unless the stream already shows it complete. Such a task comes back `already-complete`, and no gate runs again. A complete task needs no claim. To rework a complete task, plan a new task (Rollback procedure, below)

A worker that reports failure before the batch is settled does not stop the batch. There are two correct paths. Fix the task first, and claim it as completed in the same batch. Or claim the task with the status `failed` and its reason, and settle the batch now. The second path completes the other tasks at once, and it costs one more `settle` call for the correction. Use the status `blocked` or `skipped` in the same way for a task that waits or that no worker ran.

For the full recovery flow with a concrete example, see `references/worked-example.md`.

### Fix Failed Tasks

Dispatch a fresh fixer agent using the runtime's native spawn primitive, carrying the full failure context and the original task description:

```typescript
spawn_agent({
  agent_type: "default",
  message: "Fix failed task-001\n\nYour implementation failed. [failure context from test output and the settlement finding]. Apply adversarial verification: do NOT trust your previous self-assessment, re-read actual test output, identify root cause not symptoms. [Original task context, including the capsule's terms]."
})

```


The fix continues the earlier branch of the task, and it does not start a new branch. Without native isolation, dispatch the fixer to the earlier worktree of the task. With native isolation, commit the listed files of the task, remove each file that a gate run left, and remove the earlier worktree before the dispatch, so the fixer can switch its own worktree to the earlier branch. `references/fix-mode.md` gives the recipe of each runtime, and the recovery of a fix on a new branch.

After the fix completes, claim the fixed task in a new batch on the same capsule, with the worktree of the fixer and the same `branch` as the earlier claim. Do not run a gate chain by hand: the new `settle` call runs it.

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
2. Read the settlement record of each batch: `exarchos_event({ action: "query", stream: "<featureId>", filter: { type: "execution.settled" } })`. Each row names its `batchId`, `capsuleVersion`, `outcome` and `acceptedTasks`, and under `corrective-capsule` its `unresolvedTasks`
3. Check active worktrees: `ls .worktrees/` and verify branch state
4. Reconcile: `exarchos_workflow reconcile` replays the event stream and patches stale task state
5. Do NOT re-create branches or re-dispatch agents until confirmed lost

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

> A settled batch leaves them so: settlement's completion leaf marks each accepted task complete on the stream and on the document the guard reads. If the transition is refused, a task is not complete: its batch has an unresolved task, or the batch was rejected, held or stale. Read the settlement record, not the task list. The call `exarchos_event({ action: "query", stream: "<featureId>", filter: { type: "execution.settled" } })` returns one row for each settlement round, with its `outcome` and, under `corrective-capsule`, its `unresolvedTasks`. Do not patch `tasks[].status` by hand to get past the guard.

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

These are the values of `tasks[].status` in the workflow state. The `status` of a claim (Step 3) is a different field. A claim that reports `failed` does not set the task to `failed`.

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

Each subagent worktree starts at the `baseCommit` of its task, the commit of
the integration branch when `prepare` compiled the batch (the base step of the
agent). When the orchestrator merges sibling worktrees serially, each merge
moves the integration branch forward. A worktree that started at an older
integration commit will fail the ancestry preflight when its turn comes.

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

2. **Plan the rework as a new task.** The task is already complete on the
   stream: its completion row started this merge. A claim on it comes back
   `already-complete`, and no gate runs again. Finished work is not
   reopened. Add a new task for the rework to the plan, run `prepare`, and
   dispatch a fixer for the new task (see the Failure Recovery section
   above). Do **not** delete the worktree — the fixer needs the original
   branch state to diagnose the conflict.

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

1. **Readiness** — `exarchos_orchestrate({ action: "prepare_delegation", featureId: "<featureId>", planPath: "docs/specs/<the-decomposition-spec>.md", repoRoot: "<absolute path of the integration worktree>", tasks: [...] })`. It announces the plan's tasks (`task.assigned`) itself before reading readiness, so no append precedes it. Pass `planPath` so it lifts each task's `**Risk Tier:**` / `**Boundary Touching:**` stamp; `ready: false` stops the wave. Pass `repoRoot` as an absolute path: the branch read, the protected-branch check, the ancestry preflight, the stash probe and a relative `planPath` then read that tree. Without `repoRoot`, it reads the directory of the server and returns a warning. It returns `implementerPromptTemplate`, a `verificationNotes` map keyed by `"<riskTier>|<boundaryTouching>"`, and `taskClassifications[i].verificationNoteKey` — splice the task's note into the template before dispatching. It also returns `baseBranch`, the integration branch the tasks fork from: **record it** for step 3.
2. **Dispatch and collect** as in Steps 2 and 3, with the note in place of the capsule's terms.
3. **Per completed task**, run the task-completion runbook: `exarchos_orchestrate({ action: "runbook", id: "task-completion" })` and execute the returned steps in order. Stop on gate failure. Bind the `<baseRef>` template variable to the `baseBranch` recorded in step 1: the kill probe blocks with `base-missing` without it. Bind `<taskId>` and `<worktreePath>` to the task: `check_static_analysis` runs per task in its worktree, with `taskId` and `repoRoot`, and `task_complete` accepts only a passing run for the same task, on the tree that `result.worktreePath` names, at its current commit. A run with `taskId` and no `repoRoot` scans nothing (`repo-root-missing`). If runbook unavailable, use `describe` to retrieve gate schemas: `exarchos_orchestrate({ action: "describe", actions: ["check_test_adequacy", "check_static_analysis", "task_complete"] })`. Its terminal step records the completion with the report's provenance:

```typescript
exarchos_orchestrate({
  action: "task_complete",
  taskId: "<taskId>",
  streamId: "<featureId>",
  result: {
    summary: "<task summary>",
    worktreePath: "<absolute worktree path of the task>",
    implements: ["DR-1", "DR-3"],
    tests: [{ name: "testName", file: "path/to/test.ts" }],
    files: ["path/to/impl.ts", "path/to/test.ts"]
  }
})
```

4. **On a gate failure**, dispatch a fixer (Fix Failed Tasks above), then run the `task-fix` runbook: `exarchos_orchestrate({ action: "runbook", id: "task-fix" })`.
5. **Land and transition** — `task_complete` marked each passing task complete in workflow state, so do not write `tasks[].status` by hand. Land, backstop and transition as in Step 4.

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
