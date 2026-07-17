# v2.9.0 bug cluster — combined-fix design (Approach B)

**Workflow:** `v29-bug-cluster` (feature)
**Date:** 2026-05-06
**Status:** Shipped (2026-05-08) — primitives + C2 consumer migration both landed on `feature/v29-bug-cluster`
**Closes:** #1230, #1228, #1241, #1226, #1224, #1220, #1225, #1117, #1293
**Related spikes:** #1239 (parent — checkpoint handoff enrichment), #1259 (follow-up — durable substrate, v2.10.0)
**Cross-cutting:** #1109 (event-sourcing + MCP parity + basileus-forward)

> **C2 closure note (2026-05-08):** the originally-deferred consumer
> migration (the second half of the F1 family fix) shipped in #1293 on
> this branch. PR #1265's primitives now have all consumers wired to
> them; legacy four-phase `EventStore.append` machinery deleted.
> Race regression tests (`store.race.test.ts`) close the cross-path
> window CodeRabbit and Sentry both flagged on the post-fix re-review.
> Migration design: [`docs/designs/2026-05-08-eventstore-appender-consumer-migration.md`](2026-05-08-eventstore-appender-consumer-migration.md).

## Problem

Eight open bugs in milestone v2.9.0 collectively block production wiring of the checkpoint handoff enrichment work (#1240–#1246) and any further feature work that touches the event store, subagent dispatch, or workflow state machine. They are not eight independent defects — they cluster into three root-cause families.

| Family | Bugs | Substrate |
|---|---|---|
| F1 — Event-store atomicity gap | #1230, #1228, #1241, #1226 | Multi-phase non-transactional append in `servers/exarchos-mcp/src/event-store/store.ts` |
| F2 — Cross-stream propagation under subagent isolation | #1220 (priority:high), #1224 | Capability declaration mismatch in agent specs + missing parent-stream emission in team coordinator |
| F3 — Capability/contract enforcement gaps | #1225, #1117 | HSM transition write path bypasses guard evaluation; pruner staleness uses single read-refreshed signal |

The fixes are not interchangeable orderings. F1 must be transactional before #1241's payload-digest key has stable semantics. F2 must land #1220 and #1224 together — fixing #1220 alone (more agents → more isolated streams) would worsen #1224. F3 is two independent fixes coupled only by the milestone.

## Recommendation summary

Three invariant-bearing primitives in `servers/exarchos-mcp/src/`, each with a concrete consumer-side patch closing one or more bugs, plus three surgical fixes for bugs that don't warrant a new primitive. One PR, ~8 commits, eight bugs closed, #1109 verification checklist green by construction.

The three primitives are **interface-shaped to be replaceable** in the v2.10.0 durability spike (#1259). Approach B is the surgical move that codifies invariants today; Approach C swaps substrate behind those interfaces tomorrow without consumer changes.

## Cross-cutting compliance (#1109)

| Constraint | Compliance |
|---|---|
| C1 — event-sourcing integrity | F1 restores replay determinism (sequence uniqueness + commit-on-success idempotency). F2 ensures parent-stream events match committed work. F3 prevents guard-violating transitions from reaching the event log. Replay reconstructs identical state. |
| C2 — MCP parity | Single dispatch core unchanged. Both facades route through the same handlers. New primitives are server-internal. |
| C3 — basileus-forward | Primitives are transport-agnostic. The cross-stream router (F2) is the local analog of remote workflow propagation; #1259 generalizes it. |

## Backend-quality compliance (axiom)

| Dimension | Constraint applied to this design |
|---|---|
| DIM-1 Topology | Single writer per family — `AtomicAppender` for events, `SubagentStreamRouter` for cross-stream propagation, `HSMTransitionGuard.fail_closed` for phase transitions. No parallel paths. |
| DIM-2 Observability | Every fail-closed path emits a structured rejection (e.g. `IDEMPOTENCY_CLAIMED`, `GUARD_FAILED`); no silent drops. `success: true` becomes a contract: returns true only after durable commit. |
| DIM-3 Contracts | `AtomicAppender.append` returns `Result<{sequences}, Reason>` — explicit success/failure replaces today's silent-drop semantics. Posture-derived isolation declared at the spec level (#1220 surgical fix). |
| DIM-4 Test fidelity | Roundtrip tests exercise the same wiring as production: real `AtomicAppender`, real projection store, no mocked event boundaries. `assertParity` for CLI/MCP. |
| DIM-5 Hygiene | The four-phase append in `store.ts` collapses to one entry point. `team.disbanded.tasksCompleted` stops being a doubly-bookkept counter. |
| DIM-6 Architecture | Primitives have single responsibility and no upward dependencies. Replaceable behind their interface (proves out in #1259). |
| DIM-7 Resilience | Bounded retry on `AtomicAppender` failure with structured reasons. Pruner gains multi-signal staleness scoring (no single point of mis-classification). |

## Primitive 1 — `AtomicAppender`

**Closes:** #1230, #1228, #1241 (#1226 closed via consumer-side dedup once duplicates can't enter the stream)

### Why

Today the append path in `servers/exarchos-mcp/src/event-store/store.ts:529–751` is four phases with no atomic boundary:

1. Read sequence counter (in-memory or `.seq` file)
2. Write JSONL
3. Write `.seq` file (best-effort; can fail silently)
4. Cache `idempotencyKey` (skipped if step 2 or 3 throws)

Concurrent appenders allocate overlapping sequences (#1230). Partial failures leave `idempotencyKey` claimed-as-pending without an event in the log (#1228 phantom claim). The handler returns `success: true` regardless. Refinement of `handleCheckpoint` (#1241) collides on the version-only key, lands on the phantom-claim path, returns `success: true`, drops the event.

### Interface

```ts
// servers/exarchos-mcp/src/event-store/atomic-appender.ts
export type AppendResult =
  | { ok: true; sequences: number[]; eventIds: string[] }
  | { ok: false; reason: 'idempotency-claimed' | 'sequence-conflict' | 'io-error'; cause?: Error };

export interface AtomicAppender {
  append(streamId: string, events: EventInput[], idempotencyKey: string): Promise<AppendResult>;
  query(streamId: string, opts?: QueryOpts): Promise<Event[]>;
  // Existing read paths unchanged.
}
```

### Behavior contract

- **Atomicity.** A successful return guarantees: sequences allocated, events written to JSONL, `.seq` file durably updated, `idempotencyKey` cached. A failed return guarantees: zero of the above (no partial commit).
- **Sequence uniqueness.** Within a stream, no two successful appends ever return overlapping sequence ranges. Enforced by serializing append operations on a per-stream lock — single writer per stream at any instant.
- **Idempotency commit-on-success.** `idempotencyKey` is added to the cache *only* after JSONL write and `.seq` write both succeed. A failed append leaves the key uncommitted; retries are admissible.
- **Failure observability.** Every failure mode returns a structured `reason`. No `catch { return { success: true } }`. Callers receive enough information to decide retry vs surface vs degrade.

### Implementation sketch (v2.9.0)

Per-stream `Mutex` (using `async-mutex` or a small inline implementation) wrapping the four-phase write. `idempotencyKey` cache mutation moved to *after* the JSONL + `.seq` writes both resolve. Failures unwind any partial state by *not* writing it — there is no rollback because there are no commits to roll back. The mutex is in-process; cross-process contention on the same JSONL file is out of scope for v2.9.0 and is exactly what the #1259 spike resolves with SQLite WAL.

### Consumer changes

- `handleEventBatchAppend` in `servers/exarchos-mcp/src/event/tools.ts` — switch from current path to `appender.append(...)`; surface structured failures instead of `success: true` over silent drops.
- `handleCheckpoint` in `servers/exarchos-mcp/src/workflow/tools.ts:988` — change `idempotencyKey` from `${featureId}:checkpoint:${phase}:${state._version}` to `${featureId}:checkpoint:${phase}:${state._version}:${handoffDigest}` where `handoffDigest = sha256(JSON.stringify(input.handoff ?? {})).slice(0, 16)`. A no-handoff checkpoint keeps the prior key shape (digest of `{}` is stable), so historical replay is unaffected. This change is independent of the substrate — it ships in this PR alongside the appender, not after.

### B → C seam

The `AtomicAppender` interface is the seam #1259's SQLite implementation drops into. Same return shape, same failure reasons, same per-stream serialization semantics. Consumers don't move.

## Primitive 2 — `SubagentStreamRouter`

**Closes:** #1224. Couples with #1220 surgical fix below.

### Why

Subagents in isolated worktrees emit `task.completed` events to their child stream. The team coordinator runs in the main worktree, accumulates an in-memory completion count, and emits `team.disbanded` with that count — but never propagates the underlying `task.completed` events to the parent stream. The parent's projection sees a `team.disbanded` claim with no supporting events. The all-tasks-complete guard (in #1225's transition) relies on parent-stream presence, so the workflow looks done when it isn't.

Because today's append substrate doesn't support concurrent writers across processes well (JSONL + lockfile is brittle), the simplest v2.9.0 fix is an explicit emit on the coordinator's side. #1259 generalizes this to a query over namespaced shared streams.

### Interface

```ts
// servers/exarchos-mcp/src/agents/subagent-stream-router.ts
export interface SubagentStreamRouter {
  onTaskCompleted(parentStreamId: string, childStreamId: string, taskId: string, payload: TaskCompletedPayload): Promise<void>;
  emitDisbanded(parentStreamId: string, summary: DisbandedSummary): Promise<void>;
}
```

### Behavior contract

- **Causal ordering.** For each task that completed in a child stream, the corresponding `task.completed` event lands in the parent stream *before* `team.disbanded`. Single-writer ordering is enforced by routing both events through `AtomicAppender` on the parent stream.
- **Source of truth.** `team.disbanded.tasksCompleted` is computed from the parent stream's `task.completed` event count at emission time, never from an in-memory accumulator. The double-bookkeeping that produces #1224's off-by-N gets removed.
- **Idempotency.** Each child task gets a single `task.completed` parent-stream event keyed by `<childStreamId>:<taskId>`. Replays don't multiply.

### Implementation sketch

The team coordinator (current location to be confirmed during implementation; likely in `servers/exarchos-mcp/src/orchestrate/dispatch.ts` or `agents/team-coordinator.ts`) is refactored to:

1. On child-stream `task.completed` — route through `SubagentStreamRouter.onTaskCompleted` which appends a `task.completed` event to the parent stream via the parent's `AtomicAppender`.
2. On disband — query the parent stream for `task.completed` count *for this team's tasks*, populate `tasksCompleted` from that, append `team.disbanded`.

Concrete child-stream → parent-stream wiring depends on whether the coordinator already holds parent-stream references at child-event-receipt time. If not, the team metadata (parent stream id, task id list) is captured at dispatch time and threaded through.

### Consumer changes

- `team-coordinator` (path TBD at implementation) — replace counter accumulator with router calls.
- Any test fixtures that asserted on the in-memory counter shape — move to assertions against the parent stream.

### B → C seam

The router becomes a thin pass-through over namespaced SQLite reads in #1259: parent-stream "view" is `SELECT * FROM events WHERE stream_id LIKE '<parent>/%' ORDER BY sequence`. The interface stays; the implementation flattens to a query.

## Primitive 3 — `HSMTransitionGuard.fail_closed`

**Closes:** #1225.

### Why

The HSM transition table at `servers/exarchos-mcp/src/workflow/hsm-definitions.ts:201–206` declares the `delegate→review` transition with a non-advisory composite guard (`all-tasks-complete+team-disbanded`). Guards are correctly evaluated and emit `workflow.guard-failed` when they fail. But the `workflow.set({ phase: 'review' })` orchestration write path doesn't consult guards — it writes the transition directly. So the transition lands ~6s after `workflow.guard-failed` fires for the same target phase. The event log records both events.

This is a missing fail-closed invariant on the dispatcher. The substrate fix in #1259 removes the `workflow.set({ phase })` API entirely; the v2.9.0 fix introduces strict mode as an opt-in flag that becomes the primary flag in this codebase.

### Interface

```ts
// servers/exarchos-mcp/src/workflow/hsm-transition-guard.ts
export interface HSMTransitionGuard {
  attempt(featureId: string, currentPhase: string, targetPhase: string, context: GuardContext): Promise<TransitionResult>;
}

export type TransitionResult =
  | { ok: true; transitionEvent: WorkflowTransitionEvent }
  | { ok: false; reason: 'guard-failed'; failures: GuardFailure[] }
  | { ok: false; reason: 'no-transition-defined' };
```

### Behavior contract

- **Single decision point.** Every phase transition flows through `HSMTransitionGuard.attempt`. There is no second write path that bypasses guard evaluation.
- **Atomicity of guard + transition.** A successful return appends the `workflow.transition` event. A failed return appends only `workflow.guard-failed`. Both events are never appended for the same target phase in the same attempt.
- **Strict by default.** `workflow.set({ phase })` is patched to delegate to `attempt`; the existing `set` API on non-phase fields is unchanged. Callers passing a `phase` field receive a structured failure, not a silent write.

### Implementation sketch

`workflow.set` in `servers/exarchos-mcp/src/workflow/tools.ts` adds a check: if `updates` includes `phase`, route through `HSMTransitionGuard.attempt(currentPhase, updates.phase, ...)` and apply the transition event only on `ok: true`. The existing guard composition logic in `workflow/guards.ts` is reused; this primitive owns the dispatch contract, not the guard evaluation.

### Consumer changes

- `workflow.set` handler — phase routing.
- Any in-tree caller of `workflow.set({ phase })` that relied on the bypass — surfaced at type level once the route is added; migrated to use the same call (semantics now correct).

### B → C seam

#1259 removes the `phase` field from `workflow.set`'s input schema entirely; callers migrate to `workflow.transition(target)`. Strict mode goes from "the way it works" to "the only way it can work."

## Surgical fixes (no primitive needed)

### #1226 — `workflow_status` projection dedup

`servers/exarchos-mcp/src/views/workflow-status-view.ts:22–82` increments `tasksCompleted` on every `task.completed` event seen during projection fold. Once `AtomicAppender` and `SubagentStreamRouter` make duplicate `task.completed` events impossible at write time, replay-time duplication can still occur for events written before this PR. Add task-id-keyed dedup in the projection: maintain a `Set<taskId>` during fold; increment only on first occurrence per task. Same fix applies symmetrically to `tasksTotal` if the bug repros there.

This is the right shape regardless of substrate — projections should be idempotent under replay.

### #1117 — pruner multi-signal staleness

`servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts:96–173` gates staleness on `_checkpoint.lastActivityTimestamp`, refreshed by any MCP read. Add two secondary signals to `selectPruneCandidates`:

- **`phaseTransitionTimestamp`** — last `workflow.transition` event's timestamp. Captures "stuck in phase X for N days" even when reads keep activity fresh.
- **`branchActivity`** — `git log -1 --format=%ct` on the feature branch when the workflow tracks a branch. Captures "branch hasn't moved" as an independent signal.

Shipped composition (per `prune-stale-workflows.ts:248`):
`isStale = phaseStale && (lastActivityStale || branchInactive)`. The phase-stale gate is the dominant predicate — recent phase progress alone keeps a workflow fresh — and the inner OR closes the false-fresh path that #1117 originally caught (orchestrator polls keep `lastActivityTimestamp` artificially fresh, but no branch activity over the window flips `branchInactive` true and the workflow is flagged). When neither secondary signal is supplied, the legacy single-signal `lastActivityStale` path is preserved for backward compat.

#1259 generalizes this to phase-declared activity contracts. v2.9.0 ships hardcoded signal composition; v2.10/v2.11 generalizes to a contract.

### #1220 — agent capability declaration

`servers/exarchos-mcp/src/agents/definitions.ts` — the FIXER spec at `:150–214` and the SCAFFOLDER spec at `:296–358` declare `fs:write` + `shell:exec` but lack `'isolation:worktree'` in their capability arrays. The Claude adapter at `agents/adapters/claude.ts:135–137` only renders worktree isolation when that capability is present. Three-line fix: add `'isolation:worktree'` to both capability arrays. Reviewer spec gets the same review (per #1220's title — "all task-isolated agent types").

The declarative type-level enforcement (impossible-to-misdeclare specs) is the #1259 C5 work; v2.9.0 does the data fix.

## Bug → fix matrix

| Bug | Closed by | How |
|---|---|---|
| #1230 | `AtomicAppender` | Per-stream serialization makes duplicate sequence allocation impossible at append time. |
| #1228 | `AtomicAppender` | Idempotency commit-on-success eliminates phantom-claim path; `success: true` becomes truthful. |
| #1241 | `AtomicAppender` + payload-digest idempotencyKey | Refinement calls within same phase land as distinct events because key digests differ. |
| #1226 | Projection dedup (surgical) + `AtomicAppender` upstream | Projection becomes replay-idempotent; new events can't duplicate. |
| #1224 | `SubagentStreamRouter` | Parent-stream `task.completed` emission before `team.disbanded`; counts queried not accumulated. |
| #1220 | Capability declaration (surgical) | Add `'isolation:worktree'` to FIXER/SCAFFOLDER specs. |
| #1225 | `HSMTransitionGuard.fail_closed` | `workflow.set({ phase })` routes through guard; transition appears in log only on `ok: true`. |
| #1117 | Multi-signal pruner (surgical) | Add `phaseTransitionTimestamp` + `branchActivity` signals to staleness scoring. |

## Test strategy (TDD red-green per fix)

Each fix lands as a separate commit with a failing test first. Co-located test files per existing convention.

### Family F1 (event-store atomicity)

```ts
// store.test.ts
it('serializes concurrent appends — no duplicate sequences', async () => {
  const appender = new AtomicAppender(streamPath);
  const results = await Promise.all([
    appender.append('s1', [evt1], 'k1'),
    appender.append('s1', [evt2], 'k2'),
    appender.append('s1', [evt3], 'k3'),
  ]);
  const sequences = results.flatMap(r => r.ok ? r.sequences : []);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences.sort()).toEqual([1, 2, 3]);
});

it('does not commit idempotencyKey when JSONL write fails', async () => {
  const appender = new AtomicAppender(streamPath, { writeFn: failingWriter });
  const r = await appender.append('s1', [evt1], 'k1');
  expect(r.ok).toBe(false);
  // Retry must be admissible — key must be unclaimed.
  const r2 = await appender.append('s1', [evt1], 'k1', { writeFn: succeedingWriter });
  expect(r2.ok).toBe(true);
});

// tools.test.ts
it('checkpoint refinement in same phase lands two events (#1241 regression)', async () => {
  await handleCheckpoint({ featureId, handoff: { context: 'first' } }, ctx);
  await handleCheckpoint({ featureId, handoff: { context: 'second' } }, ctx);
  const events = await ctx.eventStore.query(featureId, { type: 'workflow.checkpoint' });
  expect(events).toHaveLength(2);
});
```

### Family F2 (cross-stream + capability)

```ts
// subagent-stream-router.test.ts
it('emits parent-stream task.completed before team.disbanded', async () => {
  await router.onTaskCompleted('parent', 'child-1', 'task-1', payload);
  await router.emitDisbanded('parent', summary);
  const events = await parentStream.query();
  const completedIdx = events.findIndex(e => e.type === 'task.completed');
  const disbandedIdx = events.findIndex(e => e.type === 'team.disbanded');
  expect(completedIdx).toBeLessThan(disbandedIdx);
});

it('team.disbanded.tasksCompleted reflects parent-stream count, not in-memory tally', async () => {
  // Arrange: 3 child tasks complete, but coordinator's in-memory counter is corrupted.
  // Assert: emitted disbanded.tasksCompleted equals parent-stream task.completed count.
});

// definitions.test.ts (#1220)
it('FIXER spec declares isolation:worktree', () => {
  expect(FIXER.capabilities).toContain('isolation:worktree');
});
it('SCAFFOLDER spec declares isolation:worktree', () => {
  expect(SCAFFOLDER.capabilities).toContain('isolation:worktree');
});
```

### Family F3 (guards + pruner)

```ts
// hsm-transition-guard.test.ts
it('workflow.set with phase routes through guard; failed guard does not transition', async () => {
  // Arrange: state where allTasksComplete returns failure.
  const r = await workflow.set(featureId, { phase: 'review' });
  expect(r.ok).toBe(false);
  const events = await eventStore.query(featureId);
  expect(events.find(e => e.type === 'workflow.transition' && e.data.to === 'review')).toBeUndefined();
  expect(events.find(e => e.type === 'workflow.guard-failed')).toBeDefined();
});

// prune-stale-workflows.test.ts
it('flags stuck workflow even when read activity is fresh', async () => {
  // Arrange: workflow with phase X entered 7 days ago; lastActivityTimestamp updated 1h ago by read.
  const candidates = await selectPruneCandidates(entries, config, now);
  expect(candidates.map(c => c.featureId)).toContain('stuck-workflow');
});
```

### Replay determinism (#1109 C1 verification)

```ts
it('replay reconstructs identical projection state across all closed bugs', async () => {
  // For each bug-shaped scenario: build event log, project once, project again from scratch, byte-compare.
});
```

## Implementation sequencing

Single PR, ~8 commits, in this order:

1. `AtomicAppender` interface + impl + tests (closes #1230, #1228 at substrate level)
2. `handleEventBatchAppend` migrated to `AtomicAppender`
3. `handleCheckpoint` payload-digest key + migrated to `AtomicAppender` (closes #1241)
4. `workflow_status` projection dedup (closes #1226)
5. FIXER/SCAFFOLDER capability declarations (closes #1220)
6. `SubagentStreamRouter` interface + impl + tests + team-coordinator migration (closes #1224)
7. `HSMTransitionGuard.fail_closed` + `workflow.set` routing (closes #1225)
8. Pruner multi-signal staleness (closes #1117)

Each commit is independently reviewable. Each closes its bug(s) with regression tests. The PR description includes the #1109 verification checklist.

## Migration / risk

- **No on-disk format change.** JSONL + `.seq` substrate is unchanged. Existing event logs in `~/.claude/workflow-state/` continue to work. The `AtomicAppender` mutex is in-process; existing readers (replay, projection) see no change.
- **Backwards compatibility.** `workflow.set({ phase })` callers continue to function; semantics are now correct (guard-checked) rather than fail-open. The public API is unchanged.
- **Existing tests.** Unit tests that mocked the four-phase append path may need updates to mock `AtomicAppender` instead. Integration tests that exercised the silent-drop path will fail by design — they should be updated to assert structured failure.
- **Capability declaration fix.** Adding `'isolation:worktree'` to FIXER/SCAFFOLDER changes the dispatch shape for those agents. Existing in-flight team dispatches that relied on the broken behavior will now correctly isolate; this is the desired outcome but should be smoke-tested before release.

## Future work — Approach C (#1259)

The three primitives in this design are interface-shaped to be replaced wholesale by Approach C (the v2.10.0 spike). The B → C evolution map:

| B primitive | C replacement | Consumer change |
|---|---|---|
| `AtomicAppender` (mutex over JSONL+seq) | SQLite + WAL-backed; `PRIMARY KEY (stream_id, sequence)` enforces uniqueness; `UNIQUE` index on `idempotency_key` makes claim/commit atomic | None. Same interface. |
| `SubagentStreamRouter` (explicit parent emit) | Thin pass-through over namespaced SQLite reads (`stream_id LIKE 'parent/%'`) | Coordinator stops accumulating counts; queries the store. |
| `HSMTransitionGuard.fail_closed` (strict-mode flag) | Strict mode is the only mode; `workflow.set({ phase })` removed | Callers migrate from `set({ phase })` to `transition(target)`. |
| Surgical capability declaration | Posture-derived capability (`AgentPosture` type) | Specs migrate from capability arrays to a `posture` field. |
| Surgical multi-signal pruner | Phase-declared activity contract; pruner becomes a generic scorer | Phase playbooks add `staleness_signals`. |

This is the essential property: B is C-shaped, not C-blocked. Three of five C moves require zero consumer changes; two are additive.

## Open follow-up issues

- **#1259** — durable substrate spike (v2.10.0). Investigates SQLite-backed `AtomicAppender`, namespaced shared streams, single-path HSM API, posture-derived capabilities, phase activity contracts.
- **#1240–#1246** — checkpoint handoff enrichment work. Hard-blocked on this PR. Lands after merge.
- **#1118** — codify event-sourcing principles. Partial advance; #1259 completes.

## Decision log

| Decision | Alternative considered | Why rejected |
|---|---|---|
| Three primitives + three surgical fixes | All-surgical (Approach A) | Bug-shaped fixes don't codify invariants; same class re-emerges. |
| Three primitives + three surgical fixes | Full substrate refactor (Approach C) | Substrate refactor *becomes* the next feature work; misses v2.9.0 release window. |
| In-process mutex on `AtomicAppender` | File-system advisory lock | Cross-process coordination is exactly what #1259 solves with SQLite WAL; in-process is sufficient for v2.9.0's concurrency model. |
| Explicit parent emit in `SubagentStreamRouter` | Shared event store with namespaced streams | Shared store requires cross-process atomic writers — out of scope for v2.9.0; in scope for #1259. |
| `HSMTransitionGuard.fail_closed` as routing in `workflow.set` | Remove `workflow.set({ phase })` API | API removal is a breaking change; defer to #1259. |
| Surgical multi-signal pruner | Phase activity contract | Contract needs a schema location decision (yaml topology vs Zod); defer to #1259. |
| Surgical capability declaration | Posture-derived capability | Type-level enforcement requires schema rev across all agent specs; defer to #1259. |
| Payload-digest checkpoint key in this PR | Defer to #1240 | Hard prerequisite for #1240 per #1241; ship together to avoid silent-dedup regression window. |

## Verification checklist (#1109 PR section)

- [ ] **Event-sourcing:** `AtomicAppender` events emitted; `SubagentStreamRouter` parent-stream events emitted; `HSMTransitionGuard.fail_closed` `workflow.transition` / `workflow.guard-failed` events emitted. Replay reconstructs identical projection state (verified by replay determinism test).
- [ ] **MCP parity:** No new CLI/MCP branch. `assertParity` test pair confirms identical output for `workflow_status`, `event_batch_append`, `workflow_checkpoint`, `workflow_set` after the fix.
- [ ] **Basileus-forward:** No hard-coded MCP-local-only assumption. `SubagentStreamRouter` interface is the local analog of #1259's namespaced-stream model.
- [ ] **Capability resolution:** No yaml-runtime read introduced. The capability declaration fix is on-disk producer-side; #1139 covers the runtime consumer.
