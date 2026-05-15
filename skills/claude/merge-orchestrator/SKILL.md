---
name: merge-orchestrator
description: "Land a subagent worktree branch onto an integration branch with preflight + recorded rollback. Triggers: operator (or `next_actions`) surfaces verb `merge_orchestrate` via Exarchos MCP. Local git operation — NOT remote PR merging (that is `merge_pr`)."
metadata:
  author: exarchos
  version: 1.1.0
  mcp-server: exarchos
  category: behavior
---

# Merge Orchestrator Skill

## Local Git, Not Remote VCS

This skill performs **local `git merge`** of a source (subagent) worktree branch into a target (integration) branch, recording a rollback SHA so a `git reset --hard` can undo the merge on any failure. It does **not** call the VCS provider (GitHub / GitLab / Azure DevOps) and does not require a PR id. For remote PR merging, see the companion skill that wraps the `merge_pr` action.

The mental model and the rationale for why these are two separate concerns are documented in `references/local-git-semantics.md`.

## Overview

This skill activates whenever an operator (or an automated `next_actions` dispatcher) invokes the `merge_orchestrate` action against Exarchos MCP. After the source branch has been prepared in a worktree, this skill:

1. Performs a worktree-availability preflight (target branch must not be checked out in a sibling worktree).
2. Composes additional preflight guards (ancestry, current-branch protection, main-worktree assertion, working-tree drift).
3. Records pre-merge `HEAD` of the target branch as a rollback anchor.
4. Performs a local `git merge` of the source branch into the target branch.
5. On any failure, runs `git reset --hard <rollbackSha>` and surfaces a categorized failure reason.
6. Emits dedicated event types so the merge timeline is reconstructable from the event log alone.

Resumable: terminal phases (`completed` / `rolled-back` / `aborted`) short-circuit on re-entry without re-emitting events. Idempotent: re-dispatch with the same `taskId` collapses via the `next_actions` idempotency key.

## Triggers

Activate this skill when:

- The operator runs `exarchos merge-orchestrate ...` (CLI).
- `mcp__plugin_exarchos_exarchos__exarchos_orchestrate({ action: "merge_orchestrate", ... })` is invoked directly.
- An automated `next_actions` envelope surfaces a `merge_orchestrate` verb with idempotency key `<streamId>:merge_orchestrate:<taskId>`.

Do **not** activate this skill:
- To merge a remote PR — that is `merge_pr`. The two are disjoint actions; see Disambiguation below.
- When the orchestrator's recorded `mergeOrchestrator.phase` is already terminal — the resume short-circuit runs but no fresh dispatch is needed.

## Process

> **Schema:** discover the action's argument schema with `mcp__plugin_exarchos_exarchos__exarchos_orchestrate({ action: "describe", actions: ["merge_orchestrate"] })`. Strategy is required (no schema-level default) — pick `squash` / `merge` / `rebase` deliberately.

### Step 1: Pick the merge strategy

| Strategy | Local git operation | When to choose |
|----------|---------------------|----------------|
| `merge`  | `git merge --no-ff --no-edit <source>` — explicit merge commit | Preserves the subagent's commit history with a visible merge boundary. |
| `squash` | `git merge --squash <source>` then `git commit` — single squash commit on target | Subagent commit history is noise; one logical change should land as one commit. |
| `rebase` | rebases an ephemeral copy of source onto target then ff-merges target — linear history | No merge commit; integration branch stays linear. The original source ref is preserved (the rebase runs on a temporary branch that is deleted afterward), so an executor rollback only needs to reset target. |

Strategy is required at the schema layer (#1127 collision check, #1109 §2 user-visible parity). There is no implicit default — operator intent is always explicit in the event log.

### Step 2: Invoke

Via MCP:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "merge_orchestrate",
  streamId: "<id>",
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
  --stream-id <id> \
  --source-branch <subagent-branch> \
  --target-branch <integration-branch> \
  --task-id <task-id> \
  --strategy squash
  # add --dry-run for preflight-only, --resume for terminal-phase short-circuit
```

CLI exit codes: 0 = success, 1 = invalid input, 2 = merge failed (preflight blocked or rollback executed), 3 = uncaught exception.

### Step 3: Interpret the result

The handler returns a `ToolResult` whose `data.phase` discriminates the outcome:

| `phase` | Meaning | Operator action |
|---------|---------|-----------------|
| `completed` | Local merge landed; `mergeSha` is the new HEAD of target. | None — workflow continues per the orchestrator's playbook. |
| `aborted` | Preflight failed; no merge attempted. `data.preflight` carries the structured guard sub-results (when produced by the body preflight) OR `data.reason` discriminates the early-abort cause. | See the abort-reason table below. Resolve the underlying condition and re-dispatch. |
| `rolled-back` | Merge was attempted, failed (`reason: 'merge-failed' / 'verification-failed' / 'timeout'`), and `git reset --hard <rollbackSha>` ran. The target branch is restored. | Inspect `data.reason`. If `data.rollbackError` is also present, the reset itself failed — the working tree is stranded and requires operator intervention. |

#### Abort-reason payload shapes

When `phase === 'aborted'`, the data payload discriminates the cause:

| `data.reason` | Payload fields | Cause | Operator remediation |
|---------------|----------------|-------|----------------------|
| `target-checked-out-elsewhere` | `siblingWorktreePath: string` (absolute path) | Target branch is already checked out in a sibling worktree of the same repository. Detected by the worktree-availability preflight (issue #1356) *before* any event emission, executor invocation, or state persistence. | Resolve the sibling worktree: either remove it (`git worktree remove <path>`), switch its checkout to another branch, or invoke `merge_orchestrate` against a different target. Then re-dispatch. |
| *(body preflight failures)* | `data.preflight: { ancestry, worktree, currentBranchProtection, drift }` | Body-preflight guard failed (ancestry mismatch, worktree drift, protected current branch, etc.). | Inspect `preflight.*` sub-results to identify which guard failed. Resolve the underlying condition (e.g., commit/stash drift, switch off a protected branch) and re-dispatch. |

The `target-checked-out-elsewhere` abort path is special: it suppresses both the `merge.requested` and `merge.preflight` events and skips state persistence entirely. This guarantees the event log is never contaminated with an attempt that could not have captured a correct rollback SHA (the executor would have read HEAD from the wrong worktree).

For the full recovery flow per outcome, see `references/recovery-runbook.md`.

### Step 4: Confirm event emissions

Three events are emitted directly to the orchestrator's event stream (stream id is the value passed as `streamId`) — **not** wrapped in `gate.executed`:

| Event type | When | Carries |
|------------|------|---------|
| `merge.preflight` | Always (after preflight runs, before any merge attempt) — except for the early-abort `target-checked-out-elsewhere` path, which emits nothing | Full structured guard sub-results + `failureReasons` if `passed: false` |
| `merge.executed`  | On successful local merge | `mergeSha`, `rollbackSha`, `taskId`, source/target branches |
| `merge.rollback`  | On post-merge failure followed by reset | `rollbackSha`, `reason`, `taskId`, source/target branches |

These events are auto-emitted by the handler — do **not** manually append them via `mcp__plugin_exarchos_exarchos__exarchos_event` during normal operation. Manual emission is only sanctioned during the documented manual-recovery flow in [`recovery-runbook.md`](references/recovery-runbook.md) when a merge has been completed out-of-band (e.g., conflict resolution) and the event log must be brought back in sync — follow that runbook's event-first sequencing.

> Discover the event payload schemas via `mcp__plugin_exarchos_exarchos__exarchos_event({ action: "describe", eventTypes: ["merge.preflight", "merge.executed", "merge.rollback"] })`.

## Disambiguation: `merge_orchestrate` vs `merge_pr`

Two related actions, two distinct concerns:

| Aspect | `merge_orchestrate` (this skill) | `merge_pr` (companion skill) |
|--------|----------------------------------|------------------------------|
| **Layer** | Local SDLC handoff | Remote PR primitive |
| **What it merges** | A subagent worktree branch into a target branch | A user-facing PR via the VCS provider API |
| **Identifier required** | `sourceBranch` + `targetBranch` | `prId` |
| **Underlying operation** | `git merge` (local) | `provider.mergePr()` (remote API) |
| **Rollback** | `git reset --hard <rollbackSha>` (real, undoes the merge) | None — the VCS provider owns merge state |
| **Events** | `merge.preflight` / `merge.executed` / `merge.rollback` | `pr.merged` |

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
| Use this skill to merge a remote PR | Use the `merge_pr` skill |
| Manually emit `merge.preflight` / `merge.executed` / `merge.rollback` in normal flow | Let the handler auto-emit; manual emission causes duplicates (one exception: documented manual-recovery flow in [`recovery-runbook.md`](references/recovery-runbook.md)) |
| Wrap merge events under `gate.executed` | Direct stream append with the dedicated event type — these are state transitions, not gate executions |
| Re-dispatch after a `rolled-back` outcome without inspecting the reason | Read `data.reason` and `data.rollbackError`; address the root cause first |
| Re-dispatch after `reason: 'target-checked-out-elsewhere'` without first freeing the sibling worktree | Remove or re-checkout the sibling worktree referenced by `data.siblingWorktreePath`, then re-dispatch |
| Omit `--strategy` / `strategy:` field expecting a default | Strategy is required; supply `squash` / `merge` / `rebase` explicitly |
| Invoke from a subagent worktree | Preflight refuses (main-worktree assertion); invoke from the main worktree |

## Schema Discovery

For the argument schema, call `mcp__plugin_exarchos_exarchos__exarchos_orchestrate({ action: "describe", actions: ["merge_orchestrate"] })`. Event payload shapes come from `mcp__plugin_exarchos_exarchos__exarchos_event({ action: "describe", eventTypes: ["merge.preflight", "merge.executed", "merge.rollback"] })`.

## Completion Criteria

- [ ] Preflight result `passed: true` (or operator has decided to proceed despite a documented preflight gap)
- [ ] `mergeOrchestrator.phase === 'completed'` in orchestrator state
- [ ] `merge.executed` event present in the stream with the recorded `mergeSha` and `rollbackSha`
- [ ] Target branch's HEAD matches the recorded `mergeSha`

If any criterion fails, consult `references/recovery-runbook.md` before re-dispatching.
