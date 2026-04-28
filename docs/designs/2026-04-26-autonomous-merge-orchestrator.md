# Autonomous Phase-Branch Merge Orchestrator

**Target version:** v2.9.0
**Cross-cutting reference:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) (event-sourcing integrity, MCP parity, basileus-forward)
**Issue:** [#1119](https://github.com/lvlup-sw/exarchos/issues/1119)
**Builds on:** [#1181](https://github.com/lvlup-sw/exarchos/pull/1181) (capability-aware delegation across 5 runtimes), [#1185](https://github.com/lvlup-sw/exarchos/pull/1185) (EventStore single composition root)
**Supersedes:** `docs/designs/2026-04-17-autonomous-merge-orchestrator.md`

## Overview

Subagent worktrees corrupt during the dispatch -> merge dance, and the team spends substantial cycles untangling failed merges by hand. The pre-existing dispatch guards in `dispatch-guard.ts` (DR-1 ancestry validation, DR-2 worktree assertion) catch some of the upstream causes at delegation time but do nothing about the merge itself: when a subagent's branch lands back on the integration branch, there is no automated preflight, no rollback, and no recovery. This design closes that loop.

The orchestrator is two flat handlers in `orchestrate/`. The first composes existing dispatch guards with a worktree drift check and emits a single preflight event. The second records a rollback SHA, delegates the merge to the existing VCS provider, and resets to the recorded SHA on any failure. Triggering is event-sourcing-native: the HSM defines a transition guarded on `task.completed` for tasks with worktree associations, and the existing `next-action@v1` projection surfaces `merge_orchestrate` as the next required action. Per-runtime delegation skills (post #1181) already direct every supported runtime to consume `next_actions`, so auto-dispatch is portable across Claude / Codex / OpenCode / Cursor / Copilot without any platform-specific hook.

## Reuse audit

The most important section of this design. Each row is a piece of infrastructure already in the tree that the orchestrator composes with rather than rebuilds.

| Concern | Existing infrastructure | Orchestrator usage |
|---|---|---|
| Branch ancestry check | `dispatch-guard.ts:51` `validateBranchAncestry(integrationBranch, requiredUpstream, gitExec)` | Imported and called as-is. |
| Current branch + protected-branch check | `dispatch-guard.ts:106` `getCurrentBranch`, `:126` `assertCurrentBranchNotProtected` | Imported and called as-is. |
| Main worktree assertion | `dispatch-guard.ts:147` `assertMainWorktree(cwd?)` | Imported and called as-is. |
| Composition pattern | `prepare-delegation.ts:295-360` (composes all four guards in sequence) | Followed verbatim. |
| Multi-VCS provider | `vcs/factory.ts:21` `createVcsProvider({ config: ctx.projectConfig })` (GitHub / GitLab / Azure DevOps) | **Not used by `merge_orchestrate`** — its merge is local-git (#1194). VCS provider remains in use by `merge_pr` and other synthesize-phase remote operations. |
| Local git merge | `execFileSync('git', ['merge', ...])` via `orchestrate/local-git-merge.ts` (#1194) | Production `vcsMerge` adapter. The executor's recorded `rollbackSha` corresponds to a real local ref the rollback `git reset --hard` can undo. |
| Worktree validation pattern | `verify-worktree.ts`, `verify-worktree-baseline.ts` | Drift detection extends this pattern in-place; no parallel module. |
| Git command exec | `setup-worktree.ts:32` `gitExec(repoRoot, args)` helper using `execFileSync('git', ['-C', repoRoot, ...])` | Same shape, 120s timeout matching `post-merge.ts:48`. |
| Event emission | `gate-utils.ts:emitGateEvent(store, featureId, gateName, gateType, passed, payload)` | All five orchestrator events emitted through this. |
| EventStore lifecycle | `DispatchContext.eventStore` (post-#1185 single composition root) | Threaded into both handlers as a constructor parameter. The CI gate at `scripts/check-event-store-composition-root.mjs` enforces this structurally. |
| State persistence | `~/.claude/workflow-state/<id>.state.json` (`workflow/state-store.ts`) | Extended with one optional `mergeOrchestrator` field. No parallel state file. |
| Auto-trigger mechanism | `projections/next-action/reducer.ts` (`next-action@v1`, DR-8) + per-runtime delegation skills' `next_actions` consumption (#1181) | HSM transition feeds the projection; runtime skill dispatches automatically. No hooks. |
| Idempotency | `tasks/tools.ts:261` `idempotencyKey` pattern | Auto-dispatched merges keyed `${streamId}:merge_orchestrate:${taskId}`. |

Net-new code lives in two flat handlers, two pure modules, and one `WorkflowState` schema field. Everything else composes.

## Architecture

### File layout

Flat, matching every other handler in `orchestrate/`. No sub-directory.

```
servers/exarchos-mcp/src/orchestrate/
  merge-orchestrate.ts            # Composer: preflight -> emit; resumes from WorkflowState.mergeOrchestrator
  merge-orchestrate.test.ts
  execute-merge.ts                # Executor: record rollback SHA -> local git merge -> reset on failure
  execute-merge.test.ts
  local-git-merge.ts              # Production vcsMerge adapter: local `git merge` of source into target (#1194)
  local-git-merge.test.ts         # Integration: real temp git repos, real merges, rollback round-trip
  pure/
    merge-preflight.ts            # Pure composer over dispatch-guard fns + drift detection
    merge-preflight.test.ts
    execute-merge.ts              # Pure rollback logic (SHA recording, reset decision tree)
    execute-merge.test.ts
  merge-orchestrate.parity.test.ts  # CLI <-> MCP parity assertion
```

### Handler contract

Schemas compose existing types from `dispatch-guard.ts` rather than redefining them.

```ts
// orchestrate/pure/merge-preflight.ts
import type { AncestryResult, WorktreeAssertionResult, CurrentBranchProtectionResult } from '../dispatch-guard.js';

export interface DriftResult {
  readonly clean: boolean;
  readonly uncommittedFiles: readonly string[];
  readonly indexStale: boolean;
  readonly detachedHead: boolean;
}

export interface MergePreflightResult {
  readonly passed: boolean;
  readonly ancestry: AncestryResult;
  readonly worktree: WorktreeAssertionResult;
  readonly currentBranchProtection: CurrentBranchProtectionResult;
  readonly drift: DriftResult;
}
```

```ts
// orchestrate/merge-orchestrate.ts
export interface MergeOrchestrateOutput {
  readonly phase: 'preflight' | 'executing' | 'completed' | 'rolled-back' | 'aborted';
  readonly preflight: MergePreflightResult;
  readonly mergeSha?: string;
  readonly rollbackSha?: string;
  readonly abortReason?: 'preflight-failed';
  readonly rollbackReason?: 'merge-failed' | 'verification-failed' | 'timeout';
}
```

The TypeScript types backing these are derived from the Zod schemas in the same file via `z.infer`, eliminating schema-runtime drift by construction (DIM-3).

### Composer flow

```
exarchos merge-orchestrate (CLI)     exarchos_orchestrate({action:"merge_orchestrate"}) (MCP)
         |                                              |
         +------------------+---------------------------+
                            v
            dispatch('exarchos_orchestrate', {action:'merge_orchestrate'}, ctx)
                            v
                handleMergeOrchestrate(args, ctx)             <- orchestrate/merge-orchestrate.ts
                            v
  1. Read WorkflowState.mergeOrchestrator (resume only if phase ∉ {'completed', 'aborted', 'rolled-back'})
                            v
  2. preflight(args, gitExec)                                 <- pure/merge-preflight.ts
       a. validateBranchAncestry  (existing)
       b. getCurrentBranch + assertCurrentBranchNotProtected  (existing)
       c. assertMainWorktree                                  (existing)
       d. drift detection: git status --porcelain, index vs HEAD, detached HEAD
                            v
  3. emitGateEvent(store, featureId, 'merge.preflight', 'merge', preflight.passed, { ... })
                            v
  4. IF !preflight.passed: persist WorkflowState.mergeOrchestrator = { phase: 'aborted', ... }; return
                            v
  5. handleExecuteMerge(args, ctx)                            <- orchestrate/execute-merge.ts
       a. rollbackSha = git rev-parse HEAD
       b. persist mergeOrchestrator = { phase: 'executing', rollbackSha, ... }
       c. delegate to vcs/merge-pr.ts (uses VcsProvider — platform-agnostic)
       d. emitGateEvent('merge.executed', success)
       e. ON FAILURE: git reset --hard <rollbackSha>; emitGateEvent('merge.rollback', { reason })
                            v
  6. persist mergeOrchestrator.phase = 'completed' | 'rolled-back'
                            v
  7. return MergeOrchestrateOutput
```

### Trigger mechanism (event-sourcing-native, no hooks)

The orchestrator is auto-dispatched through the HSM + next-action projection, not through any runtime-specific hook.

1. **HSM topology change.** The feature workflow HSM gains a transition predicate: when `task.completed` fires for a task whose state carries a `worktree` association, the workflow phase enters a `merge-pending` substate (or sets a guard) that requires `merge_orchestrate` before proceeding.
2. **Projection surfaces the action.** `projections/next-action/reducer.ts` already derives `next_actions` from `WorkflowState.phase` + HSM topology. With the new transition in place, the projection emits `merge_orchestrate` as the suggested next verb whenever `mergeOrchestrator.phase` is `pending` or absent for a completed delegated task.
3. **Runtime skill dispatches.** Every delegation skill rendered by #1181 (Claude / Codex / OpenCode / Cursor / Copilot) already consumes `next_actions` from envelope output and dispatches the listed verbs. No per-runtime change required.
4. **Idempotency.** Auto-dispatched merge calls use idempotency key `${streamId}:merge_orchestrate:${taskId}` -- the same pattern `tasks/tools.ts:261` uses for `task.completed`. Re-entries (after context-exhaustion resume, retried sessions, etc.) collapse to a no-op once the merge has run.

The trigger is therefore a pure function of state + HSM, fully reconstructable from the event log. No `handleTaskComplete` modification, no internal dispatch chain, no reactor framework.

## Requirements

### DR-MO-1: Topology preflight

Composes the existing dispatch guards into a single merge-time check.

**Capabilities**
- Reuse `validateBranchAncestry` to verify source descends from target.
- Reuse `getCurrentBranch` + `assertCurrentBranchNotProtected` to refuse merges initiated from a protected base.
- Reuse `assertMainWorktree` to refuse merges initiated from a subagent worktree.
- Detect orphaned source branches (no merge-base with target).

**Acceptance criteria**
1. Preflight fails (`passed: false`) when any constituent guard fails. Each guard's structured result appears verbatim under its named field in `MergePreflightResult`.
2. Preflight emits exactly one `merge.preflight` event whose payload includes the full result.
3. Preflight completes in under 2 seconds for repositories with up to 50 open branches.
4. All git invocations are injectable via `GitExec` (the existing type from `dispatch-guard.ts`). Tests exercise the composer with no live git.
5. The preflight pure function lives in `pure/merge-preflight.ts` and contains zero direct `execFileSync` calls; the impure handler injects `gitExec`.

### DR-MO-2: Merge execution with rollback

The executor records a recovery point before the merge, performs a *local* `git merge` of source into target, and resets to the recovery point on any failure.

> **Revised post-#1194:** earlier drafts of this section delegated the merge to `vcs/merge-pr.ts` (a remote VCS provider call). That made the recorded `rollbackSha` dead code in production — a server-side merge does not move local HEAD, so `git reset --hard <rollbackSha>` is a no-op. The orchestrator's preflight (worktree drift, ancestry, main-worktree assertion) and rollback (`git reset --hard`) are local-git semantics; the executor must use a matching local-git primitive. The remote PR merge is a different concern handled by `merge_pr` in the synthesize-phase shepherd loop.

**Capabilities**
- Record pre-merge `HEAD` via `git rev-parse HEAD` and persist to `WorkflowState.mergeOrchestrator.rollbackSha` *before* the merge command runs.
- Perform the merge via `buildLocalGitMergeAdapter` (`orchestrate/local-git-merge.ts`): checks out `targetBranch`, runs `git merge --no-ff` / `--squash` / rebase + ff-only depending on strategy, captures the new HEAD as `mergeSha`. No `prId`, no remote API call.
- On merge failure or post-merge verification failure, run `git reset --hard <rollbackSha>` and emit `merge.rollback` with a categorized reason (`merge-failed`, `verification-failed`, `timeout`).
- Emit distinct events for success (`merge.executed`) and rollback (`merge.rollback`).

**Acceptance criteria**
1. The rollback SHA is persisted to `WorkflowState.mergeOrchestrator` *before* any ref-mutating git command runs. A test asserts ordering by injecting a runner that fails after the persistence step.
2. After rollback, `git rev-parse HEAD` matches the recorded rollback SHA.
3. The rollback event payload includes `{ rollbackSha, reason, sourceBranch, targetBranch, taskId }`.
4. All `execFileSync('git', ...)` calls use the no-shell form and a 120s timeout, matching `post-merge.ts:48`.
5. Handler returns `ToolResult { success: false, error: { code, message } }` on rollback. The structured error matches existing handler conventions (e.g., `post-merge.ts`).

### DR-MO-4: Worktree drift detection

Detects when the working tree has drifted from a clean state and either reports actionable diagnostics (when uncommitted work is present) or is silent (when clean).

**Capabilities**
- `git status --porcelain` to enumerate uncommitted files.
- Index-vs-HEAD comparison via `git diff --cached --quiet` (exit 1 = stale index).
- Detached-HEAD detection (existing `getCurrentBranch` returns `null`).
- No auto-recovery in v2.9.0. If drift exists, preflight fails with diagnostics. Auto-`git reset` is deliberately out of scope to eliminate any path that could destroy uncommitted work.

**Acceptance criteria**
1. Drift detection runs as part of preflight (DR-MO-1). The result populates the `drift` field of `MergePreflightResult`.
2. A clean worktree completes drift detection in under 500ms.
3. Drift findings appear as fields on the `merge.preflight` event payload, not as separate events.
4. The diagnostic message (when emitted in the handler's text output) names each uncommitted file and the recommended user action (commit, stash, or discard).

## Out of scope for v2.9.0

These were in the original 2026-04-17 design and are deliberately deferred or reframed.

| Original requirement | Disposition |
|---|---|
| **DR-MO-3** (semantic conflict resolution, line-level + AST-aware) | Deferred to a follow-up. Rollback covers the failure mode for v2.9.0: any unresolvable conflict triggers a clean rollback rather than a partial-merge state. AST-aware resolution would add a parser dependency and substantial surface area without proportionate value while rollback exists. |
| **DR-MO-5** (separate JSON state file at `<stateDir>/merge-orchestrator/<featureId>.json`) | Reframed. State persistence uses the existing `WorkflowState` schema with a new optional `mergeOrchestrator` field. A parallel state file with its own atomic-write semantics, expiry policy, and corruption modes is the divergent-implementations antipattern (DIM-5) the codebase actively cleaned up in #1185. Resume-on-entry comes for free from the existing workflow state loader. |

## WorkflowState extension

One new optional field. The schema lives alongside the existing `WorkflowState` definition in `workflow/types.ts`.

```ts
export interface MergeOrchestratorState {
  readonly phase: 'pending' | 'executing' | 'completed' | 'rolled-back' | 'aborted';
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly taskId?: string;            // present when auto-dispatched via next_actions
  readonly rollbackSha?: string;       // populated before merge ref-mutation
  readonly mergeSha?: string;          // populated after successful merge
  readonly preflight?: MergePreflightResult;
}

// In WorkflowState:
mergeOrchestrator?: MergeOrchestratorState;
```

`workflow/state-store.ts` already provides atomic writes and version conflict detection (`VersionConflictError`), so no new persistence machinery is introduced.

## Event catalog

| Event type | Emitted by | Payload |
|---|---|---|
| `merge.preflight` | `merge-orchestrate.ts` (via `emitGateEvent`) | `{ featureId, sourceBranch, targetBranch, taskId?, ancestry, worktree, currentBranchProtection, drift }` |
| `merge.executed` | `execute-merge.ts` (via `emitGateEvent`) | `{ featureId, sourceBranch, targetBranch, taskId?, mergeSha, rollbackSha }` |
| `merge.rollback` | `execute-merge.ts` (via `emitGateEvent`) | `{ featureId, sourceBranch, targetBranch, taskId?, rollbackSha, reason }` |

All events flow through the `orchestrate` stream via `ctx.eventStore.append()` and carry `featureId` as the correlation key. The full merge lifecycle is reconstructable from the event log alone (#1109).

The two events from the original design (`merge.conflict.detected`, `merge.conflict.resolved`) are out of scope for v2.9.0 along with DR-MO-3.

## CLI surface

Top-level command: `exarchos merge-orchestrate`.

```
exarchos merge-orchestrate \
  --feature-id <id> \
  --source-branch <branch> \
  --target-branch <branch> \
  --strategy <squash|rebase|merge> \
  [--task-id <id>]              # set when invoked from a delegated task context
  [--resume]                    # resume from WorkflowState.mergeOrchestrator if present
  [--dry-run]                   # run preflight only, do not execute merge
```

Exit codes follow the existing `CLI_EXIT_CODES` contract:
- 0: merge completed successfully (or preflight passed for `--dry-run`)
- 1: invalid input
- 2: merge failed (preflight blocked or rollback executed)
- 3: uncaught exception

`--dry-run` exits after preflight without invoking the executor. This enables CI integration where merge readiness is checked before the merge window opens.

## MCP surface

`exarchos_orchestrate({ action: "merge_orchestrate", ... })` routes through `composite.ts` to `handleMergeOrchestrate`. Argument schema mirrors the CLI flags as camelCase, declared once via Zod and shared between the CLI parser and the MCP action schema (eliminating CLI-MCP drift).

```ts
{
  action: "merge_orchestrate",
  featureId: string,
  sourceBranch: string,
  targetBranch: string,
  strategy: "squash" | "rebase" | "merge",
  taskId?: string,
  resume?: boolean,
  dryRun?: boolean,
}
```

Return shape: `ToolResult` wrapping `MergeOrchestrateOutput`. CLI and MCP call the same handler with the same arguments. Parity is asserted by `merge-orchestrate.parity.test.ts`, which invokes the handler through both adapters and checks identical `ToolResult` shape.

## #1109 compliance matrix

| Constraint | How this design complies | Verification |
|---|---|---|
| **Event-sourcing integrity** | Every phase transition emits an event (3 event types covering the full v2.9.0 lifecycle). The trigger itself is derived from state + HSM via the existing `next-action@v1` projection -- not a side effect of a handler call. The merge lifecycle is fully reconstructable from the event log. | A test reconstructs the merge timeline from events alone for a passing run, a rollback run, and an aborted-by-preflight run. |
| **MCP parity** | One handler function (`handleMergeOrchestrate`) called by both the CLI adapter and the MCP composite router. One Zod schema shared by both. No CLI-only code paths. | `merge-orchestrate.parity.test.ts` invokes through both adapters and asserts identical `ToolResult` shape. |
| **Basileus-forward** | Handler accepts `DispatchContext` (not raw `stateDir`). VCS operations route through `VcsProvider` via `createVcsProvider({ config: ctx.projectConfig })`. State persistence uses the existing JSON `WorkflowState` schema (portable across transports). No `process.stdin` / `process.stdout` assumptions. | Code-review checklist: no raw `gh` / `git push` invocations, no `process.std*`, no module-global EventStore. The CI gate `scripts/check-event-store-composition-root.mjs` enforces the EventStore composition rule structurally. |

## Backend-quality compliance matrix

Per `axiom:backend-quality` dimensions.

| Dimension | Risk in original design | How this design addresses it |
|---|---|---|
| **DIM-1 Topology** | Original AC "checks are injectable" implied novel -- already enforced by existing `GitExec` injection. | No new injection scaffolding. Handlers receive `EventStore` via `DispatchContext` (post-#1185); pure modules receive `gitExec`. The CI gate at `scripts/check-event-store-composition-root.mjs` blocks regressions. |
| **DIM-2 Observability** | Catch-all rollback could hide failure causes. | `merge.rollback` payload includes a categorized `reason`. Handler `ToolResult` carries a structured error with `code` + `message`. No silent fallbacks; any caught exception is either re-emitted as a structured error or logged with cause. |
| **DIM-3 Contracts** | Original redefined `MergePreflightResultSchema` from scratch. | `MergePreflightResult` composes the existing `AncestryResult` / `WorktreeAssertionResult` / `CurrentBranchProtectionResult` types from `dispatch-guard.ts`. Zod schemas derive from the TS types via `z.infer`. One source of truth per concept. |
| **DIM-4 Test Fidelity** | Risk of over-mocked tests that pass while production wiring is broken. | Parity test invokes through real composite dispatchers. Integration test reconstructs the merge timeline from a real event store. EventStore is constructed the same way production constructs it (via `DispatchContext`). |
| **DIM-5 Hygiene** | Original sub-directory `merge-orchestrator/` diverged from the flat `orchestrate/` convention; original separate state file paralleled `WorkflowState`. | Flat layout matching every other handler. One state field on the existing `WorkflowState` schema. No parallel modules, no parallel persistence. |
| **DIM-6 Architecture** | Risk of executor coupling to git internals. | Executor delegates the merge to `vcs/merge-pr.ts` (already routes through `VcsProvider`). Pure modules in `pure/` contain no I/O. Handlers compose impure adapters with pure logic, matching `post-merge.ts`. |
| **DIM-7 Resilience** | Original specified 30s timeout, inconsistent with codebase. | 120s timeout on all `execFileSync` calls, matching `post-merge.ts:48`. Auto-recovery from drift is deliberately disabled in v2.9.0 to eliminate any code path that could destroy uncommitted work. |
| **DIM-8 Prose Quality** | Original had a few promotional phrasings ("fully autonomous", "fully reconstructable"). | This document avoids those. Direct, specific language. Acceptance criteria are testable, not aspirational. |

## Dependencies and sequencing

1. **DR-1 / DR-2 dispatch guards** in `dispatch-guard.ts` -- already landed. The orchestrator imports them; it does not reimplement.
2. **`VcsProvider` factory** in `vcs/factory.ts` -- already landed.
3. **EventStore single composition root** (#1185) -- in flight on `fix/v29-event-projection-cluster`. The orchestrator depends on `ctx.eventStore` being threaded through dispatch; this is true for all handlers post-#1185.
4. **Capability-aware delegation skill** (#1181) -- in flight on `feat/delegation-runtime-parity`. The auto-trigger via `next_actions` works in any of the 5 supported runtimes once #1181 lands.
5. **HSM transition + `next-actions-computer.ts` clause** -- net new in this feature. Adds the predicate that surfaces `merge_orchestrate` as the next action when `task.completed` fires on a worktree-bearing task.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Auto-rollback resets a worktree the user expected to keep modifying | High | Drift detection in DR-MO-4 fails preflight whenever uncommitted work is present, *before* the executor records a rollback SHA. The executor only ever resets to the SHA it just recorded -- never to an arbitrary point in history. |
| `WorkflowState.mergeOrchestrator` field corrupts on partial write | Medium | Reuses `workflow/state-store.ts` atomic-write semantics (already battle-tested for the rest of `WorkflowState`). On `VersionConflictError`, the orchestrator re-reads and retries, matching `handleTaskClaim`'s `MAX_CLAIM_RETRIES` pattern in `tasks/tools.ts`. |
| Auto-dispatch loops on transient failures | Medium | Idempotency key `${streamId}:merge_orchestrate:${taskId}` collapses re-entries. The `next-actions` projection only surfaces `merge_orchestrate` while `mergeOrchestrator.phase` is `pending` or absent; once `phase` becomes `rolled-back` or `aborted`, the projection no longer suggests it (manual re-dispatch required). |
| Git operations hang on large repos | Low | All `execFileSync('git', ...)` calls use a 120s timeout matching the codebase convention. Preflight has its own 2s soft target enforced by AC. |
| Trigger fires for workflow types that should not auto-merge | Low | The HSM transition is per-workflow-type. Workflow types that should not auto-merge simply do not include the transition -- no feature flags, no runtime branching. |

## Verification

- `npm run typecheck` clean across root and `servers/exarchos-mcp/`.
- `npm run test:run` clean (root + MCP server suites). New tests: `merge-orchestrate.test.ts`, `execute-merge.test.ts`, `pure/merge-preflight.test.ts`, `pure/execute-merge.test.ts`, `merge-orchestrate.parity.test.ts`.
- `node scripts/check-event-store-composition-root.mjs` -- exit 0 (the new handlers consume `ctx.eventStore`, never construct their own).
- Integration test reconstructs the merge timeline from an event stream containing only `task.completed` + `merge.preflight` + `merge.executed` (or `merge.rollback`).
- Manual: dispatch a feature workflow with two delegated subagent tasks; both auto-merge to the integration branch via `next_actions` without operator intervention.
