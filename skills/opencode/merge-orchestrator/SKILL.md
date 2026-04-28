---
name: merge-orchestrator
description: "Land a subagent worktree branch onto the integration branch with preflight + recorded rollback. Triggers: HSM `merge-pending` substate, `merge_orchestrate` next_action verb. Local git operation — NOT remote PR merging (that is `merge_pr` in the synthesize phase)."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: merge-pending
---

# Merge Orchestrator Skill

## Local Git, Not Remote VCS

This skill performs **local `git merge`** of a subagent's worktree branch into the integration branch, recording a rollback SHA so a `git reset --hard` can undo the merge on any failure. It does **not** call the VCS provider (GitHub / GitLab / Azure DevOps) and does not require a PR id. For remote PR merging during the synthesize phase, see `@skills/synthesis/SKILL.md` (`merge_pr` action).

The mental model and the rationale for why these are two separate concerns are documented in `references/local-git-semantics.md`.

## Overview

Closes the loop between `/delegate` (which spawns subagents into worktrees) and the integration branch that needs their work. After a delegated task completes inside a worktree, this skill:

1. Composes preflight guards (ancestry, current-branch protection, main-worktree assertion, working-tree drift).
2. Records pre-merge `HEAD` of the integration branch as a rollback anchor.
3. Performs a local `git merge` of the source (subagent) branch into the target (integration) branch.
4. On any failure, runs `git reset --hard <rollbackSha>` and surfaces a categorized failure reason.
5. Emits dedicated event types so the merge timeline is reconstructable from the event log alone.

Resumable: terminal phases (`completed` / `rolled-back` / `aborted`) short-circuit on re-entry without re-emitting events. Idempotent: re-dispatch with the same `taskId` collapses via the `next_actions` idempotency key.

## Triggers

Activate this skill when:

- The HSM is parked in `feature/merge-pending` (entry guard fires when the most recent `task.completed` carries a worktree association).
- The `next_actions` envelope surfaces a `merge_orchestrate` verb with idempotency key `${streamId}:merge_orchestrate:${taskId}`.
- The user runs `exarchos merge-orchestrate ...` (CLI) or invokes `mcp__exarchos__exarchos_orchestrate({ action: "merge_orchestrate", ... })` directly.

Do **not** activate this skill:
- During the synthesize phase to merge a remote PR — that is `merge_pr`.
- When the workflow's `mergeOrchestrator.phase` is already terminal — the resume short-circuit runs but no fresh dispatch is needed.

## Process

> **Schema:** discover the action's argument schema with `mcp__exarchos__exarchos_orchestrate({ action: "describe", actions: ["merge_orchestrate"] })`. Strategy is required (no schema-level default) — pick `squash` / `merge` / `rebase` deliberately.

### Step 1: Pick the merge strategy

| Strategy | Local git operation | When to choose |
|----------|---------------------|----------------|
| `merge`  | `git merge --no-ff --no-edit <source>` — explicit merge commit | Preserves the subagent's commit history with a visible merge boundary. |
| `squash` | `git merge --squash <source>` then `git commit` — single squash commit on target | Subagent commit history is noise; one logical change should land as one commit. |
| `rebase` | rebases source onto target then ff-merges — linear history | No merge commit; integration branch stays linear. Source branch history is rewritten (acceptable for ephemeral subagent branches). |

Strategy is required at the schema layer (#1127 collision check, #1109 §2 user-visible parity). There is no implicit default — operator intent is always explicit in the event log.

### Step 2: Invoke

Via MCP:

```typescript
mcp__exarchos__exarchos_orchestrate({
  action: "merge_orchestrate",
  featureId: "<id>",
  sourceBranch: "<subagent-branch>",
  targetBranch: "<integration-branch>",
  taskId: "<task-id>",        // present when auto-dispatched from next_actions
  strategy: "squash",          // required
  dryRun: false,               // optional — preflight only, no executor invocation
  resume: false,               // optional — short-circuit on terminal phases
})
```

Via CLI:

```bash
exarchos merge-orchestrate \
  --feature-id <id> \
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
| `completed` | Local merge landed; `mergeSha` is the new HEAD of target. | None — workflow exits `merge-pending` back to `delegate` (HSM) and continues. |
| `aborted` | Preflight failed; no merge attempted. `data.preflight` carries the structured guard sub-results. | Inspect `preflight.ancestry / worktree / currentBranchProtection / drift` to identify which guard failed. Resolve the underlying condition (e.g., commit/stash drift, switch off a protected branch) and re-dispatch. |
| `rolled-back` | Merge was attempted, failed (`reason: 'merge-failed' / 'verification-failed' / 'timeout'`), and `git reset --hard <rollbackSha>` ran. The integration branch is restored. | Inspect `data.reason`. If `data.rollbackError` is also present, the reset itself failed — the working tree is stranded and requires operator intervention. |

For the full recovery flow per outcome, see `references/recovery-runbook.md`.

### Step 4: Confirm event emissions

Three events are emitted directly to the workflow's event stream (stream id = `featureId`) — **not** wrapped in `gate.executed`:

| Event type | When | Carries |
|------------|------|---------|
| `merge.preflight` | Always (after preflight runs, before any merge attempt) | Full structured guard sub-results + `failureReasons` if `passed: false` |
| `merge.executed`  | On successful local merge | `mergeSha`, `rollbackSha`, `taskId`, source/target branches |
| `merge.rollback`  | On post-merge failure followed by reset | `rollbackSha`, `reason`, `taskId`, source/target branches |

These events are auto-emitted by the handler — do **not** manually append them via `mcp__exarchos__exarchos_event` during normal operation. Manual emission is only sanctioned during the documented manual-recovery flow in [`recovery-runbook.md`](references/recovery-runbook.md) when a merge has been completed out-of-band (e.g., conflict resolution) and the event log must be brought back in sync — follow that runbook's event-first sequencing.

> Discover the event payload schemas via `mcp__exarchos__exarchos_event({ action: "describe", eventTypes: ["merge.preflight", "merge.executed", "merge.rollback"] })`.

## Disambiguation: `merge_orchestrate` vs `merge_pr`

Two related actions, two distinct concerns:

| Aspect | `merge_orchestrate` (this skill) | `merge_pr` (synthesis skill) |
|--------|----------------------------------|------------------------------|
| **Layer** | Local SDLC handoff | Remote PR primitive |
| **Phase affinity** | `merge-pending` (between delegate and review) | `synthesize` |
| **What it merges** | A subagent worktree branch into the integration branch | A user-facing PR via the VCS provider API |
| **Identifier required** | `sourceBranch` + `targetBranch` | `prId` |
| **Underlying operation** | `git merge` (local) | `provider.mergePr()` (remote API) |
| **Rollback** | `git reset --hard <rollbackSha>` (real, undoes the merge) | None — the VCS provider owns merge state |
| **Events** | `merge.preflight` / `merge.executed` / `merge.rollback` | `pr.merged` |

If you reach for `merge_orchestrate` thinking "I want to merge a PR," you want `merge_pr` instead.

## Resume Semantics

When invoked with `resume: true`, the handler reads existing `mergeOrchestrator` state. Terminal phases (`completed` / `rolled-back` / `aborted`, members of `EXCLUDED_MERGE_PHASES`) short-circuit and return the recorded result with no new events and no executor call. Non-terminal phases (`pending` / `executing`) fall through to a fresh preflight + executor run, which is safe because the underlying git operations are idempotent on already-merged branches.

When invoked without `resume`, prior state is deliberately ignored — fresh-dispatch semantics.

## Dry-Run

`dryRun: true` runs preflight, emits `merge.preflight`, and short-circuits before the executor runs and before any state persistence. Returns `{ dryRun: true, preflight, phase: 'pending' | 'aborted' }`. Useful for CI integrations that check merge readiness before the merge window opens.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Use this skill to merge a remote PR | Use `merge_pr` in the synthesize phase |
| Manually emit `merge.preflight` / `merge.executed` / `merge.rollback` | Let the handler auto-emit; manual emission causes duplicates |
| Wrap merge events under `gate.executed` | Direct stream append with the dedicated event type — these are state transitions, not gate executions |
| Re-dispatch after a `rolled-back` outcome without inspecting the reason | Read `data.reason` and `data.rollbackError`; address the root cause first |
| Omit `--strategy` / `strategy:` field expecting a default | Strategy is required; supply `squash` / `merge` / `rebase` explicitly |
| Invoke from a subagent worktree | Preflight refuses (main-worktree assertion); invoke from the main worktree |

## Phase Transitions and Guards

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

**Quick reference:**
- `delegate` → `merge-pending` requires guard `merge-pending-entry` — fires when the most recent `task.completed` carries a worktree association AND `mergeOrchestrator.phase` is not in `EXCLUDED_MERGE_PHASES`.
- `merge-pending` → `delegate` requires guard `merge-pending-exit` — fires when `mergeOrchestrator.phase` enters a terminal value (`completed` / `rolled-back` / `aborted`).

The HSM exits `merge-pending` back to `delegate` regardless of merge outcome — `delegate` then re-evaluates whether more worktree-bearing tasks remain and either re-enters `merge-pending` for the next, or transitions on to `review` when all delegation is complete.

## Schema Discovery

Use `mcp__exarchos__exarchos_orchestrate({ action: "describe", actions: ["merge_orchestrate"] })` for the argument schema. Use `mcp__exarchos__exarchos_workflow({ action: "describe", playbook: "feature" })` for the full feature-workflow phase playbook (which includes `merge-pending`). Use `mcp__exarchos__exarchos_event({ action: "describe", eventTypes: ["merge.preflight", "merge.executed", "merge.rollback"] })` for event payload shapes.

## Completion Criteria

- [ ] Preflight result `passed: true` (or operator has decided to proceed despite a documented preflight gap)
- [ ] `mergeOrchestrator.phase === 'completed'` in workflow state
- [ ] `merge.executed` event present in the stream with the recorded `mergeSha` and `rollbackSha`
- [ ] HSM has exited `merge-pending` back to `delegate`
- [ ] Integration branch's HEAD matches the recorded `mergeSha`

If any criterion fails, consult `references/recovery-runbook.md` before re-dispatching.
