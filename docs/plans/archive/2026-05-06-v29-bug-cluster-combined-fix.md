# Implementation plan — v2.9.0 bug cluster combined fix

**Design:** `docs/designs/2026-05-06-v29-bug-cluster-combined-fix.md`
**Workflow:** `v29-bug-cluster`
**Date:** 2026-05-06
**Iron law:** No production code without a failing test first.

## Overview

Single PR, 9 commits, eight bugs closed. Tasks are grouped by commit family. Each task is a discrete TDD step (RED → GREEN → REFACTOR) at 2–5 minute granularity. Test names follow `Method_Scenario_Outcome`.

## Branch strategy

- **Integration branch:** `feature/v29-bug-cluster`
- **Per-commit branches:** `feature/v29-bug-cluster/<commit-id>` for parallel-safe commits, merged into integration in dependency order.

## Wave decomposition (parallelization)

```
Wave 1 (parallel — independent files):
  C1 AtomicAppender ───────────────────┐
  C4 workflow_status dedup ─────────────┤
  C5 capability declarations ───────────┼───→ Wave 2
  C7 HSMTransitionGuard.fail_closed ────┤
  C8 pruner multi-signal ──────────────┘

Wave 2 (depend on AtomicAppender):
  C2 event_batch_append migration ─────┐
  C6 SubagentStreamRouter ─────────────┴───→ Wave 3

Wave 3 (depend on C2):
  C3 handleCheckpoint payload-digest ──────→ Wave 4

Wave 4 (integration verification):
  C9 replay determinism + parity tests
```

---

## Commit C1 — `AtomicAppender` primitive

Closes #1230, #1228 at substrate level.

### Task 1.1 [RED] Test: concurrent appends produce unique sequences

1. Write failing test
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts`
   - Test: `AtomicAppender_concurrentAppends_uniqueMonotonicSequences`
   - Expected failure: module does not exist
2. Test asserts: 3 concurrent `append` calls on same `streamId` return disjoint sequence ranges; union sorted equals `[1,2,3]`.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 1.2 [RED] Test: failed JSONL write leaves idempotencyKey unclaimed

1. Write failing test
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts`
   - Test: `AtomicAppender_jsonlWriteFails_idempotencyKeyAdmissibleForRetry`
   - Expected failure: module does not exist
2. Test asserts: append with failing writer returns `{ok: false, reason: 'io-error'}`; subsequent retry with same idempotencyKey on a working writer returns `{ok: true}`.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 1.3 [RED] Test: structured failure on `.seq` write failure

1. Write failing test
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts`
   - Test: `AtomicAppender_seqFileWriteFails_returnsStructuredFailureNotSilentSuccess`
   - Expected failure: module does not exist
2. Test asserts: `.seq` write failure surfaces as `{ok: false, reason: 'io-error'}`, not `{success: true}`.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 1.4 [RED] Test: successful append commits all phases atomically

1. Write failing test
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts`
   - Test: `AtomicAppender_successfulAppend_commitsAllPhases`
   - Expected failure: module does not exist
2. Test asserts on success: events present in JSONL, `.seq` reflects max sequence, idempotencyKey cached. All three or none.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 1.5 [GREEN] Implement `AtomicAppender`

1. Implement minimum code to pass 1.1–1.4
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
   - Per-stream `Mutex` (use `async-mutex` or inline `Promise`-chain mutex)
   - Single `append(streamId, events, idempotencyKey)` method serialized under mutex
   - Phase order: validate → allocate sequences → write JSONL → write `.seq` → cache idempotencyKey (only if all prior succeeded)
   - Return discriminated `AppendResult`

**Dependencies:** Tasks 1.1–1.4
**Parallelizable:** No (within commit)

### Task 1.6 [REFACTOR] Extract per-stream lock manager

1. If lock acquisition logic clutters `append`, extract `StreamLockManager`.
2. Otherwise skip.

**Dependencies:** Task 1.5
**Parallelizable:** No

---

## Commit C2 — `handleEventBatchAppend` migration

Surfaces structured failures previously hidden by `success: true`.

### Task 2.1 [RED] Test: partial failure surfaces structured error (#1228 regression)

1. Write failing test
   - File: `servers/exarchos-mcp/src/event/tools.test.ts` (extend existing)
   - Test: `handleEventBatchAppend_appenderFails_returnsStructuredErrorNotSilentSuccess`
   - Expected failure: handler currently returns `{success: true}` regardless of underlying state.
2. Test asserts: when `AtomicAppender` returns `{ok: false}`, handler returns a structured error envelope, not `{success: true}`.

**Dependencies:** Commit C1 complete
**Parallelizable:** Wave 2

### Task 2.2 [RED] Test: concurrent batches no duplicate sequences (#1230 regression)

1. Write failing test
   - File: `servers/exarchos-mcp/src/event/tools.test.ts`
   - Test: `handleEventBatchAppend_concurrentCalls_noDuplicateSequences`
   - Expected failure: existing four-phase path allocates duplicates.
2. Test asserts: two concurrent `handleEventBatchAppend` calls produce events with disjoint sequence numbers in the resulting stream.

**Dependencies:** Commit C1 complete
**Parallelizable:** Wave 2

### Task 2.3 [GREEN] Migrate handler to `AtomicAppender`

1. Implement
   - File: `servers/exarchos-mcp/src/event/tools.ts` (`handleEventBatchAppend`)
   - Replace four-phase append with `appender.append(streamId, events, idempotencyKey)`
   - Map `AppendResult` to existing handler envelope (success preserved on `ok: true`; failure surfaced explicitly on `ok: false`).
2. Update any callers that branched on `{success: true}` shape.

**Dependencies:** Tasks 2.1, 2.2
**Parallelizable:** No (within commit)

### Task 2.4 [REFACTOR] Remove dead four-phase code

1. Delete unused helpers in `event-store/store.ts` once `handleEventBatchAppend` no longer references them.
2. Verify no other consumer exists via grep.

**Dependencies:** Task 2.3
**Parallelizable:** No

---

## Commit C3 — `handleCheckpoint` payload-digest idempotencyKey

Closes #1241.

### Task 3.1 [RED] Test: refinement in same phase lands two events

1. Write failing test
   - File: `servers/exarchos-mcp/src/workflow/tools.test.ts`
   - Test: `handleCheckpoint_refinementInSamePhase_landsTwoEvents`
   - Expected failure: current `idempotencyKey` shape (`${featureId}:checkpoint:${phase}:${_version}`) collides; second call deduped.
2. Test asserts: two `handleCheckpoint` calls in same phase with distinct `handoff` payloads → two `workflow.checkpoint` events visible via `eventStore.query`.

**Dependencies:** Commits C1, C2 complete
**Parallelizable:** Wave 3

### Task 3.2 [RED] Test: no-handoff checkpoint preserves legacy key shape

1. Write failing test
   - File: `servers/exarchos-mcp/src/workflow/tools.test.ts`
   - Test: `handleCheckpoint_noHandoffPayload_legacyKeyShapeStable`
   - Expected failure: until digest stable across `undefined` payloads, replay of historical events would diverge.
2. Test asserts: digest of `{}` and digest of missing handoff produce stable, equal idempotencyKey suffixes (replay backwards compat).

**Dependencies:** Commits C1, C2 complete
**Parallelizable:** Wave 3

### Task 3.3 [GREEN] Add `handoffDigest` to idempotencyKey

1. Implement
   - File: `servers/exarchos-mcp/src/workflow/tools.ts` (`handleCheckpoint`, line ~988)
   - `const handoffDigest = createHash('sha256').update(JSON.stringify(input.handoff ?? {})).digest('hex').slice(0, 16);`
   - `const idempotencyKey = \`${featureId}:checkpoint:${phase}:${_version}:${handoffDigest}\`;`
2. Route through `AtomicAppender` (already migrated in C2).

**Dependencies:** Tasks 3.1, 3.2
**Parallelizable:** No

### Task 3.4 [REFACTOR] None expected

Skip unless duplication emerges.

---

## Commit C4 — `workflow_status` projection dedup

Closes #1226.

### Task 4.1 [RED] Test: replay with duplicate task.completed dedups by taskId

1. Write failing test
   - File: `servers/exarchos-mcp/src/views/workflow-status-view.test.ts`
   - Test: `workflowStatus_replayWithDuplicateTaskCompleted_dedupsByTaskId`
   - Expected failure: current projection increments naively.
2. Test asserts: event log with duplicate `task.completed` for same `taskId` produces `tasksCompleted` counted once.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 4.2 [RED] Test: tasksCompleted never exceeds tasksTotal (#1226 regression)

1. Write failing test
   - File: `servers/exarchos-mcp/src/views/workflow-status-view.test.ts`
   - Test: `workflowStatus_tasksCompletedExceedsTotal_invariantHolds`
   - Expected failure: bug repro.
2. Test asserts: `tasksCompleted <= tasksTotal` invariant under any duplicate-event sequence.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 4.3 [GREEN] Add task-id-keyed dedup to projection fold

1. Implement
   - File: `servers/exarchos-mcp/src/views/workflow-status-view.ts:22–82`
   - Maintain `Set<taskId>` during fold; increment `tasksCompleted` only on first occurrence.
   - Apply same dedup to `tasksTotal` (via `Set<taskId>` from `task.assigned`/equivalent).

**Dependencies:** Tasks 4.1, 4.2
**Parallelizable:** No

### Task 4.4 [REFACTOR] Generalize dedup helper if used elsewhere

Skip unless other projections show the same pattern.

---

## Commit C5 — agent capability declarations

Closes #1220.

### Task 5.1 [RED] Test: FIXER spec declares `isolation:worktree`

1. Write failing test
   - File: `servers/exarchos-mcp/src/agents/definitions.test.ts`
   - Test: `FIXER_capabilities_includesIsolationWorktree`
   - Expected failure: capability missing today.
2. Test asserts: `FIXER.capabilities.includes('isolation:worktree') === true`.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 5.2 [RED] Test: SCAFFOLDER spec declares `isolation:worktree`

1. Write failing test
   - File: `servers/exarchos-mcp/src/agents/definitions.test.ts`
   - Test: `SCAFFOLDER_capabilities_includesIsolationWorktree`
   - Expected failure: capability missing today.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 5.3 [RED] Test: REVIEWER spec correctness for read-only posture

1. Write failing test
   - File: `servers/exarchos-mcp/src/agents/definitions.test.ts`
   - Test: `REVIEWER_capabilities_readOnlyDoesNotRequireIsolation`
   - Expected: passes today (verifies intentional state, prevents over-correction).
2. Test asserts: `REVIEWER.capabilities` does NOT include `'fs:write'` or `'shell:exec'`; correspondingly does NOT require isolation.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 5.4 [RED] Test: Claude adapter renders `isolation: worktree` for FIXER + SCAFFOLDER

1. Write failing test
   - File: `servers/exarchos-mcp/src/agents/adapters/claude.test.ts`
   - Test: `claudeAdapter_fixerSpec_rendersWorktreeIsolation`
   - Test: `claudeAdapter_scaffolderSpec_rendersWorktreeIsolation`
   - Expected failure: capability missing → frontmatter `isolation` field absent.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 5.5 [GREEN] Add `isolation:worktree` to FIXER + SCAFFOLDER capability arrays

1. Implement
   - File: `servers/exarchos-mcp/src/agents/definitions.ts:150–214` (FIXER)
   - File: `servers/exarchos-mcp/src/agents/definitions.ts:296–358` (SCAFFOLDER)
2. Three-line additions; no other change.

**Dependencies:** Tasks 5.1–5.4
**Parallelizable:** No

### Task 5.6 [REFACTOR] None expected

Skip.

---

## Commit C6 — `SubagentStreamRouter`

Closes #1224.

### Task 6.1 [RED] Test: parent-stream `task.completed` emitted before `team.disbanded`

1. Write failing test
   - File: `servers/exarchos-mcp/src/agents/subagent-stream-router.test.ts`
   - Test: `SubagentStreamRouter_onTaskCompleted_emittedBeforeDisbanded`
   - Expected failure: module does not exist.
2. Test asserts: parent stream has `task.completed` event with sequence < `team.disbanded` sequence for that team.

**Dependencies:** Commit C1 complete
**Parallelizable:** Wave 2

### Task 6.2 [RED] Test: `team.disbanded.tasksCompleted` matches parent-stream count

1. Write failing test
   - File: `servers/exarchos-mcp/src/agents/subagent-stream-router.test.ts`
   - Test: `SubagentStreamRouter_disbandedTasksCount_reflectsParentStreamNotInMemoryTally`
   - Expected failure: today's coordinator uses an in-memory accumulator that diverges from the stream.
2. Test asserts: with corrupted/diverged in-memory counter, `tasksCompleted` field on the emitted `team.disbanded` equals actual parent-stream `task.completed` count for that team.

**Dependencies:** Commit C1 complete
**Parallelizable:** Wave 2

### Task 6.3 [RED] Test: replayed `task.completed` is idempotent

1. Write failing test
   - File: `servers/exarchos-mcp/src/agents/subagent-stream-router.test.ts`
   - Test: `SubagentStreamRouter_replayedTaskCompleted_singleParentEvent`
   - Expected failure: module does not exist.
2. Test asserts: replaying child-stream `task.completed` twice with same `<childStreamId>:<taskId>` key produces a single parent-stream `task.completed` event.

**Dependencies:** Commit C1 complete
**Parallelizable:** Wave 2

### Task 6.4 [GREEN] Implement `SubagentStreamRouter`

1. Implement
   - File: `servers/exarchos-mcp/src/agents/subagent-stream-router.ts`
   - `onTaskCompleted(parentStreamId, childStreamId, taskId, payload)` — appends to parent stream via `AtomicAppender` with idempotencyKey `<childStreamId>:<taskId>:task.completed`.
   - `emitDisbanded(parentStreamId, summary)` — queries parent stream for `task.completed` count for the team; populates `tasksCompleted`; appends `team.disbanded`.

**Dependencies:** Tasks 6.1–6.3
**Parallelizable:** No

### Task 6.5 [GREEN] Migrate team coordinator to use router

1. Implement
   - File: team-coordinator location (likely `servers/exarchos-mcp/src/orchestrate/dispatch.ts` or `agents/team-coordinator.ts` — implementer to confirm)
   - Replace in-memory completion counter logic with `SubagentStreamRouter.onTaskCompleted` calls on child-event receipt.
   - Replace `team.disbanded` emission with `SubagentStreamRouter.emitDisbanded`.
2. Capture parent-stream id + team metadata at dispatch time so router has the data it needs at child-event-receipt time.

**Dependencies:** Task 6.4
**Parallelizable:** No

### Task 6.6 [REFACTOR] Remove dead in-memory counter

1. Delete the accumulator field and its update sites once router migration is complete.
2. Verify no other consumer.

**Dependencies:** Task 6.5
**Parallelizable:** No

---

## Commit C7 — `HSMTransitionGuard.fail_closed`

Closes #1225.

### Task 7.1 [RED] Test: `workflow.set` with phase + failed guard does not transition

1. Write failing test
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.test.ts`
   - Test: `workflowSet_phaseUpdateWithFailedGuard_doesNotEmitTransition`
   - Expected failure: today's `set` writes the transition regardless.
2. Test asserts: with state where `allTasksComplete` returns failure, `workflow.set(featureId, { phase: 'review' })` returns `ok: false`; event log contains no `workflow.transition` event with `to: 'review'` for that attempt.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 7.2 [RED] Test: failed guard emits only `workflow.guard-failed`

1. Write failing test
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.test.ts`
   - Test: `workflowSet_phaseUpdateWithFailedGuard_emitsGuardFailedOnly`
   - Expected failure: today's flow emits both `workflow.guard-failed` and `workflow.transition` ~6s apart.
2. Test asserts: failed attempt produces exactly one `workflow.guard-failed` event and zero `workflow.transition` events for that target.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 7.3 [RED] Test: non-phase `workflow.set` updates unchanged

1. Write failing test
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.test.ts`
   - Test: `workflowSet_nonPhaseUpdates_passThroughUnchanged`
   - Expected: passes today; pin behavior to prevent regression.
2. Test asserts: `workflow.set(featureId, { artifacts: {...} })` (no `phase` key) succeeds without invoking guard logic.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 7.4 [RED] Test: successful guard produces single `workflow.transition`

1. Write failing test
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.test.ts`
   - Test: `workflowSet_phaseUpdateWithPassingGuard_emitsSingleTransition`
   - Expected: must pass after fix.
2. Test asserts: with state satisfying guard, `workflow.set(featureId, { phase: 'review' })` returns `ok: true`; exactly one `workflow.transition` event present, zero `workflow.guard-failed`.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 7.5 [GREEN] Implement `HSMTransitionGuard.attempt`

1. Implement
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.ts`
   - `attempt(featureId, currentPhase, targetPhase, context)` — looks up transition definition; evaluates composite guard; on success emits `workflow.transition`; on failure emits `workflow.guard-failed` and returns structured failure.
   - Reuses existing guard composition logic in `workflow/guards.ts`.

**Dependencies:** Tasks 7.1–7.4
**Parallelizable:** No

### Task 7.6 [GREEN] Route `workflow.set` phase updates through guard

1. Implement
   - File: `servers/exarchos-mcp/src/workflow/tools.ts` (`workflow.set` handler)
   - When `updates.phase` is present, route through `HSMTransitionGuard.attempt`; apply the transition only on `ok: true`; surface the structured failure to the caller on `ok: false`.
   - Non-phase updates remain on the existing path.

**Dependencies:** Task 7.5
**Parallelizable:** No

### Task 7.7 [REFACTOR] None expected

Skip.

---

## Commit C8 — pruner multi-signal staleness

Closes #1117.

### Task 8.1 [RED] Test: stuck workflow flagged even with fresh read activity

1. Write failing test
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
   - Test: `selectPruneCandidates_phaseStuckButReadActive_flagsAsStale`
   - Expected failure: today's single-signal gate misses this case.
2. Test asserts: workflow with `phaseTransitionTimestamp` 7 days old but `lastActivityTimestamp` 1h old (refreshed by reads) is flagged stale.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 8.2 [RED] Test: branch inactivity + phase stuck → flagged

1. Write failing test
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
   - Test: `selectPruneCandidates_branchInactiveAndPhaseStuck_flagsAsStale`
   - Expected failure.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 8.3 [RED] Test: recent legitimate activity does not flag

1. Write failing test
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
   - Test: `selectPruneCandidates_recentTransitionAndCommit_doesNotFlag`
   - Expected: passes today; pin behavior to prevent false positives in fix.

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)

### Task 8.4 [GREEN] Add `phaseTransitionTimestamp` signal

1. Implement
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts:96–173`
   - Read most-recent `workflow.transition` event timestamp; expose as a signal in `selectPruneCandidates`.
   - Compose with existing `lastActivityTimestamp` per design (fresh on either signal alone is not enough; both stale → stale).

**Dependencies:** Tasks 8.1–8.3
**Parallelizable:** No

### Task 8.5 [GREEN] Add `branchActivity` signal

1. Implement
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts`
   - When workflow tracks a branch, run `git log -1 --format=%ct` (or library equivalent) and treat absence-of-activity as a stale signal.
   - Skip silently when no branch is tracked (don't penalize workflows without branches).

**Dependencies:** Task 8.4
**Parallelizable:** No

### Task 8.6 [REFACTOR] None expected

Skip.

---

## Commit C9 — integration verification

#1109 verification checklist closure.

### Task 9.1 [RED] Test: replay reconstructs identical projection state across all closed bugs

1. Write failing test
   - File: `servers/exarchos-mcp/src/event-store/replay-determinism.test.ts`
   - Test: `replay_v29BugClusterScenarios_reconstructsIdenticalState`
   - Expected: passes after all prior commits land; pin determinism.
2. Test asserts: for each bug-shaped scenario (concurrent appends, refinement checkpoints, child-stream task.completed, failed-guard transitions), build event log → project once → re-project from scratch → byte-compare.

**Dependencies:** Commits C1–C8 complete
**Parallelizable:** Wave 4

### Task 9.2 [RED] Test: CLI/MCP parity for `workflow_status`

1. Write failing test
   - File: `servers/exarchos-mcp/src/parity.test.ts` (extend existing if present)
   - Test: `assertParity_workflowStatus_cliAndMcpByteEqual`
   - Expected: passes after C4 lands.
2. Test asserts: identical event log → identical envelope (modulo timestamp normalization) from CLI and MCP invocations.

**Dependencies:** Commit C4 complete
**Parallelizable:** Wave 4

### Task 9.3 [RED] Test: CLI/MCP parity for `workflow_checkpoint`

1. Write failing test
   - File: `servers/exarchos-mcp/src/parity.test.ts`
   - Test: `assertParity_workflowCheckpoint_cliAndMcpByteEqual`

**Dependencies:** Commit C3 complete
**Parallelizable:** Wave 4

### Task 9.4 [GREEN] Address any test failures

If 9.1–9.3 pass on first run, commit is verification-only. Otherwise, route fix back to the responsible commit family.

**Dependencies:** Tasks 9.1–9.3
**Parallelizable:** No

---

## Test fixture / setup notes

Several tasks need shared fixtures. Implementer agents should:

- **Concurrent-append fixture:** A test helper that creates an `AtomicAppender` instance pointed at a tmp-dir stream path; cleans up on teardown.
- **Failing-writer injection:** A `writeFn` parameter on `AtomicAppender` constructor (for test injection only) so 1.2/1.3 can simulate IO failure deterministically.
- **In-memory counter corruption helper:** For 6.2, a way to corrupt the team-coordinator's accumulator post-hoc to exercise the "diverged from stream" assertion.
- **Guard-failure fixture:** For 7.x, a workflow state with `allTasksComplete` returning failure (e.g. `tasks: [{status: 'assigned'}]`) and `teamDisbandedEmitted` returning success (or vice versa).
- **Phase-stuck fixture:** For 8.1, a workflow state plus event log with a 7-day-old `workflow.transition` and a 1-hour-old read marker.

These fixtures are co-located with the tests that need them; not factored into `__fixtures__` unless reused across files.

## Risk register

- **Mutex semantics under errors.** `AtomicAppender`'s mutex must release on thrown exceptions. Test 1.3 partially covers; an explicit "mutex released after error" assertion is in scope for 1.5's REFACTOR step if needed.
- **Team coordinator file location.** Design names this as TBD. First implementer task on C6.5 should `grep` for existing `team.disbanded` emission site and confirm the coordinator's location before editing.
- **Existing in-tree callers of `workflow.set({ phase })`.** C7.6 may surface migrations. Implementer should `grep` for `workflow.set` calls with `phase` field and confirm each is intended.
- **Replay determinism on pre-existing event logs.** C9.1 is the canary. If older event logs in `~/.claude/workflow-state/` produce divergent projections post-fix, that's a migration discussion.

## Parallelization summary

| Wave | Commits | Concurrency |
|---|---|---|
| 1 | C1, C4, C5, C7, C8 | 5 parallel implementer agents (independent files) |
| 2 | C2, C6 | 2 parallel implementer agents (depend on C1's `AtomicAppender`) |
| 3 | C3 | 1 implementer agent (depends on C2's migrated handler) |
| 4 | C9 | 1 implementer agent (integration) |

Total: 9 commits, 38 tasks, 4 sequential waves with parallel slots within waves.

## Verification checklist (#1109 PR section)

- [ ] All 38 tasks complete with passing tests
- [ ] Replay determinism test (9.1) green
- [ ] CLI/MCP parity tests (9.2, 9.3) green
- [ ] No bypass paths to event store outside `AtomicAppender`
- [ ] No phase-write paths outside `HSMTransitionGuard.fail_closed`
- [ ] FIXER, SCAFFOLDER, (REVIEWER if applicable) capability declarations match posture
