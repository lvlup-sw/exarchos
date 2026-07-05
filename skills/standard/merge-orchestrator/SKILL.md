---
name: merge-orchestrator
description: "The composed executor that lands a subagent worktree branch onto an integration branch with preflight + recorded recovery point. For a shared integration branch route through `serialize_merge` (the single-writer lease that composes this action); invoke `merge_orchestrate` directly only for a non-integration merge or when you already hold the lease. Triggers: operator (or `next_actions`) surfaces the merge verb via Exarchos MCP. Local git operation — NOT remote PR merging (that is `merge_pr`)."
metadata:
  author: exarchos
  version: 1.2.0
  mcp-server: exarchos
  category: behavior
---

# Merge Orchestrator Skill

## Local Git, Not Remote VCS

This skill performs **local `git merge`** of a source (subagent) worktree branch into a target (integration) branch, recording a **recovery point** SHA so the INV-14 recovery ladder (`git merge --abort` → `git reset --keep`, never `--hard`) can rewind the merge on any failure. It does **not** call the VCS provider (GitHub / GitLab / Azure DevOps) and does not require a PR id. For remote PR merging, see the companion skill that wraps the `merge_pr` action.

The mental model and the rationale for why these are two separate concerns are documented in `references/local-git-semantics.md`.

## Single-Writer Entry Point: `serialize_merge`

For a **shared integration branch** — landing a subagent worktree branch onto the integration ref during the `delegate → merge-pending → delegate` loop, where a sibling worktree merge can race — **`serialize_merge` is THE integration-merge path.** It acquires an optimistic per-`integrationRef` lease (at most one in-flight merge per integration ref), then composes **this** action UNCHANGED under that lease. Route integration merges through `serialize_merge`; do **not** dispatch raw `merge_orchestrate` for them.

Invoke `merge_orchestrate` directly **only** where no concurrent merge can race the target:

- **Non-integration merge** — the target is a private / scratch / solo branch no other agent will touch.
- **Crash-resumed caller** — a new pid finishing a merge it already leased, re-presenting the ORIGINAL claim's `leaseOperationId`.
- **The composed executor call** that `serialize_merge` itself makes (it threads its lease `operationId` so its own call passes the guard).

**DR-2 lease guard.** Raw `merge_orchestrate` against an integration ref that carries a live *foreign* lease (holder `operationId` ≠ the presented `leaseOperationId`, holder liveness ∈ {alive, unknown}) fails **closed** with a structured `MERGE_LEASE_HELD` error and **no git side effect** — the message names `serialize_merge` as the path. A no-lease or provably-dead-holder target proceeds exactly as before (back-compat; a dead holder is not a blocker). So the routing above is enforced at the handler chokepoint, not merely by convention — reach for `serialize_merge`.

## Overview

This skill activates whenever an operator (or an automated `next_actions` dispatcher) invokes the `merge_orchestrate` action against Exarchos MCP. After the source branch has been prepared in a worktree, this skill:

1. Performs a worktree-availability preflight (target branch must not be checked out in a sibling worktree).
2. Composes additional preflight guards (ancestry, current-branch protection, main-worktree assertion, working-tree drift).
3. Records pre-merge `HEAD` of the target branch as a recovery point (a write-ahead-log marker, persisted before any ref mutation).
4. Performs a local `git merge` of the source branch into the target branch.
5. On any failure, runs the INV-14 recovery ladder (`git merge --abort` → `git reset --keep <recoveryPointSha>`, never `--hard`) and surfaces a categorized failure reason.
6. Emits dedicated event types so the merge timeline is reconstructable from the event log alone.

Resumable: terminal phases (`completed` / `rolled-back` / `aborted`) short-circuit on re-entry without re-emitting events. Idempotent: re-dispatch with the same `taskId` collapses via the `next_actions` idempotency key.

## Triggers

Activate this skill when:

- The operator runs `exarchos merge-orchestrate ...` (CLI).
- `exarchos:exarchos_orchestrate({ action: "merge_orchestrate", ... })` is invoked directly.
- An automated `next_actions` envelope surfaces the merge verb (idempotency key `<streamId>:merge_orchestrate:<taskId>`) for the `merge-pending` detour.

> **Route shared-integration merges through `serialize_merge`.** When the trigger is a shared integration branch (the `merge-pending` detour is the common case), land it via `serialize_merge` per the single-writer entry point above — `serialize_merge` composes this action under a lease. A direct raw `merge_orchestrate` dispatch is for a non-integration or already-lease-held merge only; against a leased integration ref it fails closed (`MERGE_LEASE_HELD`).

Do **not** activate this skill:
- To merge a remote PR — that is `merge_pr`. The two are disjoint actions; see Disambiguation below.
- When the orchestrator's recorded `mergeOrchestrator.phase` is already terminal — the resume short-circuit runs but no fresh dispatch is needed.

## Process

> **Schema:** discover the action's argument schema with `exarchos:exarchos_orchestrate({ action: "describe", actions: ["merge_orchestrate"] })`. Strategy is required (no schema-level default) — pick `squash` / `merge` / `rebase` deliberately.

### Step 1: Pick the merge strategy

| Strategy | Local git operation | When to choose |
|----------|---------------------|----------------|
| `merge`  | `git merge --no-ff --no-edit <source>` — explicit merge commit | Preserves the subagent's commit history with a visible merge boundary. |
| `squash` | `git merge --squash <source>` then `git commit` — single squash commit on target | Subagent commit history is noise; one logical change should land as one commit. |
| `rebase` | rebases an ephemeral copy of source onto target then ff-merges target — linear history | No merge commit; integration branch stays linear. The original source ref is preserved (the rebase runs on a temporary branch that is deleted afterward), so an executor recovery only needs to rewind target to the recovery point. |

Strategy is required at the schema layer (collision check + user-visible parity). There is no implicit default — operator intent is always explicit in the event log.

### Step 2: Invoke

> **Integration merge?** The direct invocation below is the raw executor form — use it for a **non-integration** or already **lease-held** merge. For a shared integration branch, invoke `serialize_merge` instead (it composes this exact call under a single-writer lease); see the single-writer entry point above.

Via MCP (illustrative — the canonical arg names come from `describe`):

```typescript
exarchos:exarchos_orchestrate({
  action: "merge_orchestrate",
  // workflow-correlation identifier — name per the action's schema
  sourceBranch: "<subagent-branch>",
  targetBranch: "<integration-branch>",
  taskId: "<task-id>",          // present when auto-dispatched from next_actions
  strategy: "squash",            // required
  dryRun: false,                 // optional — preflight only, no executor invocation
  resume: false,                 // optional — short-circuit on terminal phases
})
```

Via CLI:

```bash
exarchos merge-orchestrate \
  --source-branch <subagent-branch> \
  --target-branch <integration-branch> \
  --task-id <task-id> \
  --strategy squash
  # plus the workflow-correlation id flag — see `--help`
  # add --dry-run for preflight-only, --resume for terminal-phase short-circuit
```

CLI exit codes: 0 = success, 1 = invalid input, 2 = merge failed (preflight blocked or recovery executed), 3 = uncaught exception.

### Step 3: Interpret the result

The handler returns a `ToolResult` whose `data.phase` discriminates the outcome:

| `phase` | Meaning | Operator action |
|---------|---------|-----------------|
| `completed` | Local merge landed; `mergeSha` is the new HEAD of target. | None — workflow continues per the orchestrator's playbook. |
| `aborted` | Preflight failed; no merge attempted. `data.preflight` carries the structured guard sub-results (when produced by the body preflight) OR `data.reason` discriminates the early-abort cause. | See the abort-reason table below. Resolve the underlying condition and re-dispatch. |
| `rolled-back` | Merge was attempted, failed (`reason: 'merge-failed' / 'verification-failed' / 'timeout'`), and the INV-14 recovery ladder (`git merge --abort` → `git reset --keep <recoveryPointSha>`) ran. The target branch is rewound to the recovery point. (The phase value stays `rolled-back` — a load-bearing state token unchanged by the recovery reframe.) | Inspect `data.reason`. If `data.recoveryError` / `data.recoveryErrorDetail` is also present, the reset itself failed — the working tree is stranded and requires operator intervention. |

#### Abort-reason payload shapes

When `phase === 'aborted'`, the data payload discriminates the cause:

| `data.reason` | Payload fields | Cause | Operator remediation |
|---------------|----------------|-------|----------------------|
| `target-checked-out-elsewhere` | `siblingWorktreePath: string` (absolute path) | Target branch is already checked out in a sibling worktree of the same repository. Detected by the worktree-availability preflight *before* any event emission, executor invocation, or state persistence. | Resolve the sibling worktree: either remove it (`git worktree remove <path>`), switch its checkout to another branch, or re-run the merge against a different target. Then re-dispatch (through `serialize_merge` for a shared integration ref). |
| *(body preflight failures)* | `data.preflight: { ancestry, worktree, currentBranchProtection, drift }` | Body-preflight guard failed (ancestry mismatch, worktree drift, protected current branch, etc.). | Inspect `preflight.*` sub-results to identify which guard failed. Resolve the underlying condition (e.g., commit/stash drift, switch off a protected branch) and re-dispatch. |

The `target-checked-out-elsewhere` abort path is special: it suppresses both the `merge.requested` and `merge.preflight` events and skips state persistence entirely. This guarantees the event log is never contaminated with an attempt that could not have captured a correct recovery point (the executor would have read HEAD from the wrong worktree).

For the full recovery flow per outcome, see `references/recovery-runbook.md`.

### Step 4: Confirm event emissions

Events are emitted directly to the orchestrator's event stream (stream id is the value passed as `streamId`) — **not** wrapped in `gate.executed`:

| Event type | When | Carries |
|------------|------|---------|
| `merge.preflight` | Always (after preflight runs, before any merge attempt) — except for the early-abort `target-checked-out-elsewhere` path, which emits nothing | Full structured guard sub-results + `failureReasons` if `passed: false` |
| `merge.requested` | After preflight passes, before the executor runs (Phase A intent record from the two-event split) — suppressed on the early-abort `target-checked-out-elsewhere` path | `sourceBranch`, `targetBranch`, `strategy`, `taskId` |
| `merge.executed`  | On successful local merge | `mergeSha`, `rollbackSha`, `taskId`, source/target branches |
| `merge.rollback`  | On post-merge failure followed by recovery — **legacy** wire shape, kept during the v2.11.x deprecation window | `rollbackSha`, `reason`, `taskId`, source/target branches |
| `merge.recovered` | On post-merge failure followed by recovery — the canonical **successor** to `merge.rollback`; dual-emitted alongside it during the deprecation window | `recoveryPointSha`, `reason`, `recoveryError?`, `recoveryErrorDetail?`, `taskId`, source/target branches |

> **Recovery vocabulary.** The canonical frame is database-transaction, not saga: a **recovery point** (the recorded HEAD SHA, persisted before the merge as a write-ahead-log marker) and a **recovery event** (`merge.recovered`). `merge.recovered` is the additive successor to `merge.rollback`; during the v2.11.x deprecation window the executor **dual-emits** both for the same logical recovery. The legacy `merge.rollback` / `merge.executed` events keep their `rollbackSha` / `rollbackError` wire fields until v2.12 removes the legacy emission; `merge.recovered` carries the resolved `recoveryPointSha` / `recoveryErrorDetail` names alongside the unchanged INV-14 `recoveryError` discriminator. The phase value `'rolled-back'` is intentionally retained.

These events are auto-emitted by the handler — do **not** manually append them via `exarchos:exarchos_event` during normal operation. Manual emission is only sanctioned during the documented manual-recovery flow in [`recovery-runbook.md`](references/recovery-runbook.md) when a merge has been completed out-of-band (e.g., conflict resolution) and the event log must be brought back in sync — follow that runbook's event-first sequencing.

> Discover the event payload schemas via `exarchos:exarchos_event({ action: "describe", eventTypes: ["merge.preflight", "merge.requested", "merge.executed", "merge.rollback", "merge.recovered"] })`.

## Disambiguation: `merge_orchestrate` vs `merge_pr`

Two related actions, two distinct concerns:

| Aspect | `merge_orchestrate` (this skill) | `merge_pr` (companion skill) |
|--------|----------------------------------|------------------------------|
| **Layer** | Local SDLC handoff | Remote PR primitive |
| **What it merges** | A subagent worktree branch into a target branch | A user-facing PR via the VCS provider API |
| **Identifier required** | `sourceBranch` + `targetBranch` | `prId` |
| **Underlying operation** | `git merge` (local) | `provider.mergePr()` (remote API) |
| **Recovery** | INV-14 recovery ladder: `git merge --abort` → `git reset --keep <recoveryPointSha>` (real, rewinds the merge; never `--hard`) | None — the VCS provider owns merge state |
| **Events** | `merge.preflight` / `merge.requested` / `merge.executed` / `merge.rollback` (legacy) / `merge.recovered` (successor) | `pr.merged` |

If you reach for `merge_orchestrate` thinking "I want to merge a PR," you want `merge_pr` instead.

## Resume Semantics

When invoked with `resume: true`, the handler reads existing `mergeOrchestrator` state. Terminal phases (`completed` / `rolled-back` / `aborted`, members of `EXCLUDED_MERGE_PHASES`) short-circuit and return the recorded result with no new events and no executor call. Non-terminal phases (`pending` / `executing`) fall through to a fresh preflight + executor run, which is safe because the underlying git operations are idempotent on already-merged branches.

When invoked without `resume`, prior state is deliberately ignored — fresh-dispatch semantics.

Note: the `target-checked-out-elsewhere` early-abort path runs *before* the resume state read, so it short-circuits regardless of `resume` and never persists state.

## Dry-Run

`dryRun: true` runs the body preflight, emits `merge.preflight`, and short-circuits before the executor runs and before any state persistence. Returns `{ dryRun: true, preflight, phase: 'pending' | 'aborted' }`. Useful for CI integrations that check merge readiness before the merge window opens. Dry-run still observes the worktree-availability early abort — a sibling-worktree conflict aborts with `reason: 'target-checked-out-elsewhere'` even under `dryRun`.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Dispatch raw `merge_orchestrate` to land onto a **shared integration branch** | Route through `serialize_merge` (single-writer lease); raw `merge_orchestrate` is for a non-integration / lease-held merge — a live foreign lease makes it fail closed (`MERGE_LEASE_HELD`) |
| Use this skill to merge a remote PR | Use the `merge_pr` skill |
| Manually emit `merge.preflight` / `merge.requested` / `merge.executed` / `merge.rollback` / `merge.recovered` in normal flow | Let the handler auto-emit; manual emission causes duplicates (one exception: documented manual-recovery flow in [`recovery-runbook.md`](references/recovery-runbook.md)) |
| Wrap merge events under `gate.executed` | Direct stream append with the dedicated event type — these are state transitions, not gate executions |
| Re-dispatch after a `rolled-back` outcome without inspecting the reason | Read `data.reason` and `data.recoveryErrorDetail` (with the `data.recoveryError` discriminator); address the root cause first |
| Re-dispatch after `reason: 'target-checked-out-elsewhere'` without first freeing the sibling worktree | Remove or re-checkout the sibling worktree referenced by `data.siblingWorktreePath`, then re-dispatch |
| Omit `--strategy` / `strategy:` field expecting a default | Strategy is required; supply `squash` / `merge` / `rebase` explicitly |
| Invoke from a subagent worktree | Preflight refuses (main-worktree assertion); invoke from the main worktree |

## Diagnostics

Set `EXARCHOS_PREFLIGHT_DEBUG=1` in the environment before invoking `merge_orchestrate` to attach a structured debug payload to `merge.preflight` events. The payload is gated on **two** conditions, both of which must hold:

1. `EXARCHOS_PREFLIGHT_DEBUG=1` is present in the orchestrator process environment.
2. The preflight's ancestry guard failed (i.e., `ancestry.passed === false`).

Passing preflights do **not** carry the debug payload even when the env var is set — the failure-only gating is deliberate (event-store growth concern). A future `EXARCHOS_PREFLIGHT_DEBUG=2` channel may add verbose / passing-preflight diagnostics; that is out of scope for phase 1.

The debug block carries nine fields:

| Field | Source | Purpose |
|-------|--------|---------|
| `gitVersion` | `git --version` | Differentiate behaviors across git releases. |
| `repoRoot` | `git rev-parse --show-toplevel` | Distinguish symlinked or normalized vs raw repo paths. |
| `worktreeList` | `git worktree list --porcelain` | Surface sibling worktree topology that could affect ref resolution. |
| `refsHeadsSource` | `git for-each-ref refs/heads/<source>` | SHA + packed-state of the source branch ref. |
| `refsHeadsTarget` | `git for-each-ref refs/heads/<target>` | SHA + packed-state of the target branch ref. |
| `mergeBaseCommand` | constructed | Exact argv re-run by the helper, including `'git'` prefix — copy-pasteable for the operator. |
| `mergeBaseExitCode` | rerun of `git merge-base --is-ancestor <target> <source>` | The exit code that drove the ancestry failure. |
| `mergeBaseStdout` | same invocation | Captured stdout. |
| `mergeBaseStderr` | same invocation | Captured stderr (collapsed into stdout under the default git adapter). |

Fail-closed: any individual git invocation that fails inside the debug helper degrades to an empty string / default value for that field rather than throwing. The debug attachment must never mask the underlying preflight failure the operator is trying to investigate.

**Reporting workflow.** When you capture a debug-bearing event, attach the full `data.debug` block to a new GitHub issue tagged with relevant scope labels (e.g., `windows`, `merge-orchestrator`, `preflight`). Phase-2 root-cause analysis depends on at least one real-host event with this payload.

## Schema Discovery

For the argument schema, call `exarchos:exarchos_orchestrate({ action: "describe", actions: ["merge_orchestrate"] })`. Event payload shapes come from `exarchos:exarchos_event({ action: "describe", eventTypes: ["merge.preflight", "merge.requested", "merge.executed", "merge.rollback", "merge.recovered"] })`.

`mergeOrchestrator.*` fields on workflow state are written by this skill and `mergeOrchestrator.phase` is read by gates; the underlying `phase` workflow field is immutable and must be changed via `transition`, not `update`. See the [Reserved fields](../checkpoint/SKILL.md#reserved-fields) section in the `checkpoint` skill for the full immutable-key list and the typed `RESERVED_FIELD` error envelope.

## Completion Criteria

- [ ] Preflight result `passed: true` (or operator has decided to proceed despite a documented preflight gap)
- [ ] `mergeOrchestrator.phase === 'completed'` in orchestrator state
- [ ] `merge.executed` event present in the stream with the recorded `mergeSha` and `rollbackSha` (the legacy wire field for the recovery point, retained during the v2.11.x deprecation window)
- [ ] Target branch's HEAD matches the recorded `mergeSha`

If any criterion fails, consult `references/recovery-runbook.md` before re-dispatching.
