# RCA: v2.9.0-rc.1 Event/Projection Cluster (#1179, #1180, #1182, #1183, #1184)

**Date:** 2026-04-26
**Anchor issue:** #1182 (event-store sequence corruption)
**Cluster:** #1179, #1180, #1183, #1184
**Workflow:** `debug-v29-event-store-cluster`
**Reproduction artifact:** `~/.claude/workflow-state/delegation-runtime-parity.events.jsonl` (140 lines, 106 unique sequences)

## Summary

Five bugs filed against v2.9.0-rc.1 share two root causes:

1. **Multiple `EventStore` instances per process** write to the same `events.jsonl` with independent in-memory `sequenceCounters` Maps. The PID lock added by #971 only protects against cross-process contention — it cannot protect against same-process duplication. Result: duplicate and non-monotonic sequence numbers in the main event log (#1182).
2. **Projection/view layer reads events but ignores state.patched updates** for subtrees the original projection author considered "owned" by dedicated event types. When the dedicated events aren't emitted (or are corrupted by root cause 1), projections silently drop facts that exist in `state.json` (#1179, #1184). #1180 is the documentation/contract drift this strategy creates. #1183 is the snapshot writer either reading sequence cursors corrupted by root cause 1, or independently failing to refresh the snapshot file after emitting `workflow.checkpoint_written`.

#1178 (`feat(rehydrate-foundation)`, merged 2026-04-25 just before rc.1) did not introduce root cause 1 — that has been latent since #1021/#59789196 (2026-03-13). #1178 introduced the projection/rehydration read paths that depend on monotonic sequences and consistent task projections, which is what made the latent bug observable as user-facing wrong-state symptoms.

## Root Cause #1 — Multiple in-process EventStore instances

### Evidence

`servers/exarchos-mcp/src/views/tools.ts:139-146`:

```typescript
let cachedEventStore: EventStore | null = null;
let cachedEventStoreDir: string | null = null;

export function getOrCreateEventStore(stateDir: string): EventStore {
  if (cachedEventStore && cachedEventStoreDir === stateDir) {
    return cachedEventStore;
  }
  cachedEventStore = new EventStore(stateDir);   // <- second instance, no .initialize()
  cachedEventStoreDir = stateDir;
  return cachedEventStore;
}
```

Five production sites instantiate `new EventStore(stateDir)`:

| Site | Calls `.initialize()`? | Same process as primary? |
|------|------------------------|--------------------------|
| `index.ts:191` (primary, threaded via DispatchContext) | yes (via `core/context.ts`) | n/a |
| `core/context.ts:106` (initializeContext) | yes | yes |
| `cli-commands/assemble-context.ts:361` | yes | separate CLI process — PID lock works |
| `review/tools.ts:110` | **no** | yes |
| `views/tools.ts:143` | **no** | yes |

The two no-init sites bypass the PID lock entirely. Each creates an instance with its own empty `sequenceCounters: Map<string, number>`. Both write to the same JSONL files. The `.seq` file is reread on demand to seed the counter, but in-memory state in a long-lived primary EventStore drifts.

### Reproduction (from the live state)

`delegation-runtime-parity.events.jsonl`, lines 6 and 7:

```
seq=6  ts=2026-04-26T00:03:20.668Z  type=gate.executed         # written second, later timestamp
seq=6  ts=2026-04-26T00:03:20.666Z  type=workflow.transition   # written first, earlier timestamp
```

Two events with sequence 6, written ~2ms apart, line order does not match timestamp order. The same pattern repeats throughout the file: sequences 6–25 each appear twice; later in the file, lower sequence numbers appear after higher ones (`...17, 7, 18, 19, ..., 34, 8, 35, ...`) — the second EventStore instance is on its own slow counter that occasionally emits an event into the shared JSONL well after the primary has moved on.

### Why #971's fix doesn't catch this

#971 added a PID lock at `<stateDir>/.event-store.lock`. `acquirePidLock()` rejects acquisition when the existing PID is a different live process (`store.ts:395`). Two `EventStore` instances in the **same process** have the same PID. The lock check sees its own process is alive, treats the lock as held, and the second instance enters sidecar mode — except the no-init sites never call `initialize()` at all, so neither lock acquisition nor sidecar mode is engaged. The second instance just writes directly to the main JSONL with a stale `sequenceCounters` view.

### Why this surfaced now

`getOrCreateEventStore` is consumed by orchestrate handlers (e.g. `check_event_emissions` writing `gate.executed`, `task_complete` writing `task.completed`). Before #1178 added projection/rehydration read paths that depend on monotonic sequence ordering, the duplicate-sequence corruption was silently present but inert — `query()` ordered by timestamp where it could, and consumers didn't dedupe. After #1178, the rehydration projection (`projections/rehydration/reducer.ts`) folds events strictly in sequence order with sequence-keyed dedup, so duplicates of seq N silently overwrite each other and out-of-order events break invariants.

## Root Cause #2 — Projection layer ignores state subtrees it considers "event-owned"

### Evidence

`servers/exarchos-mcp/src/projections/rehydration/reducer.ts:296-300` (the user already cited this in #1179):

> The plan references `workflow.set`, but `workflow set` emits `state.patched` under the hood. Other subtrees (e.g. `tasks`) are surfaced via their own dedicated events (task.\*) and are not re-derived from state.patched here.

`taskProgress` is folded only from `task.assigned | task.completed | task.failed`. `state.patched` updates to `state.tasks` are deliberately ignored. So:

- A workflow with 24 planned tasks shows only the 16 that were dispatched and emitted `task.assigned`. The 8 pending tasks are invisible to rehydrate.
- The rehydrate envelope's `_eventHints.missing` flags `team.task.planned` as missing, but the reducer doesn't handle that event either — emitting it would not fix the symptom (#1180).

`servers/exarchos-mcp/src/views/composite.ts` (synthesis_readiness, workflow_status, convergence) follows the same pattern: read from event-derived projections, ignore `state.json` subtrees.

### Symptoms across the cluster

| Symptom | Issue | Driver |
|---------|-------|--------|
| `taskProgress` drops pending tasks | #1179 | Reducer ignores `state.patched.patch.tasks` |
| `eventHints` recommends events the reducer doesn't consume | #1180 | Three sources of truth (hints, playbook, reducer) maintained separately |
| `synthesis_readiness.specPassed/qualityPassed: false` when state says `passed` | #1184 (1) | Projection doesn't fold `state.patched` reviews |
| `tests`/`typecheck` null treated as "not passing" | #1184 (2) | Boolean coercion of `null` |
| `tasksTotal=8` while `tasksCompleted=24` | #1184 (3) | `total` and `completed` sourced from different reducers |
| `tasks` view returns 8 of 24 | #1184 (4) | Same root cause as #1179 |
| `convergence` misses D1/D2/D4/D5 | #1184 (5) | View only reads `gate.executed`; review skill emits dimension findings into `state.reviews.findingsByDimension` instead |
| Snapshot file never refreshed after `workflow.checkpoint_written` | #1183 | Snapshot writer either not wired to event, or sequence cursor blocked by #1182 corruption — needs verification once root cause 1 is fixed |

## Fix Plan

### Phase 1 — Repair event-store sequence integrity (#1182)

**Task 1182-A:** Remove `getOrCreateEventStore` and its callers. All EventStore consumers must receive the instance via `DispatchContext`. Where DispatchContext isn't available (one-off CLI utilities), they must call `initialize()` and accept the cross-process semantics.

**Task 1182-B:** Audit the remaining production sites (`review/tools.ts:110`) and either thread DispatchContext or call `initialize()`. The CLI path (`cli-commands/assemble-context.ts:361`) already initializes — leave it.

**Task 1182-C:** Add a regression test: launch N concurrent appenders against the same stream from the same process (not just cross-process), assert post-condition `unique(sequences) == count(events)` and monotonic order.

**Task 1182-D:** Repair the corrupted `delegation-runtime-parity.events.jsonl` for local dogfooding (or document that the workflow must be re-initialized — the file isn't load-bearing).

### Phase 2 — Verify or fix snapshot writer (#1183)

After Phase 1 lands, re-run `exarchos_workflow checkpoint` against a fresh workflow and inspect `<id>.workflow-state.snapshot.json`'s `savedAt` timestamp. If the snapshot is now refreshed correctly, #1183 was downstream of #1182 — close. If still stale, the snapshot writer has its own bug per the issue's hypothesis (wrong event subscription, gate condition, or stream).

### Phase 3 — Fix projection/view layer (#1179, #1184)

**Task 1179:** In `projections/rehydration/reducer.ts`, fold `state.patched.patch.tasks` into `taskProgress` as a plan-state assertion. Status-aware upsert: pending entries from state.patched, completed/failed entries from task.* events override.

**Task 1184-1:** Composite views (`synthesis_readiness`, `workflow_status`, `convergence`) should read review status, task counts, and dimension findings from `state.json` directly (the source of truth), not from event-derived projections. Where the view layer wants to remain event-driven, fold `state.patched` updates the same way as the reducer fix above.

**Task 1184-2:** In `synthesis_readiness`, distinguish null tests/typecheck ("not measured") from false ("failed") in the blocker reason text.

### Phase 4 — Resolve contract drift (#1180)

After #1179's reducer decides which events the projection actually consumes, update the rehydration `_eventHints.missing` array and the delegate playbook to reflect that decision. Pick a single source of truth.

## Acceptance Criteria

For any workflow where `exarchos_workflow get` reports phase=synthesize and reviews APPROVED:

- `events.jsonl` has strictly monotonic, unique sequences (#1182)
- `.seq` matches the highest sequence in `events.jsonl` (#1182)
- `synthesis_readiness.ready` is `true` (#1184)
- `synthesis_readiness.review.specPassed/qualityPassed` match `state.reviews.*.status` (#1184)
- `workflow_status.tasksTotal` equals `state.tasks.length` (#1184)
- `view.tasks` returns all entries from `state.tasks` (#1184)
- `convergence` reflects all dimensions covered by `state.reviews.findings` (#1184)
- Rehydrate `taskProgress` returns all planned tasks with correct status mix (#1179)
- After `exarchos_workflow checkpoint`, snapshot `savedAt` is within 1s of event timestamp (#1183)
- `eventHints.missing` only lists events the reducer actually consumes (#1180)

## Out of Scope

- The five sub-bugs in #1184 may not all collapse into one fix; treat each as a separate small task contingent on the Phase 3 plan.
- The `delegation-runtime-parity` workflow that produced the reproduction is itself a closed feature workflow — its corrupted log doesn't need to be repaired for the cluster fix to land. Repair it only if needed for ongoing local dogfooding.

## Final implementation (2026-04-26)

Phase 1 shipped in two iterations:

**Iteration 1** (commit `7b262ee4`, since superseded): Registry-with-lazy-fallback pattern. Module-global `canonicalEventStore` set by `registerCanonicalEventStore()`, returned by `getOrCreateEventStore()` with a logged-warning lazy-create fallback for tests.

**Iteration 2** (commits `0b9db7d6`, `06da8d31`, `c1ae6f8d`, `0f892032`): Constructor injection through `DispatchContext`. Driven by research convergence (Seemann, Fowler, Microsoft .NET DI guidelines): the lazy fallback was the recurrence trap that originally caused #1182, just relocated behind a logged warning that CI noise would swallow.

The final implementation:
- `views/tools.ts` no longer exports `getOrCreateEventStore` or `registerCanonicalEventStore`. The module-globals are gone.
- All 16 production handlers (orchestrate × 14, review × 1, telemetry × 1) accept `EventStore` as a typed parameter. The composite dispatcher (`orchestrate/composite.ts`, `views/composite.ts`) threads `ctx.eventStore` to each.
- CLI entrypoints (`pre-compact`, `evals/run-evals-cli`, `assemble-context`) bootstrap their own `EventStore` via `new EventStore + initialize` — separate process boundaries, PID lock holds.
- Test fixtures (~17 files) updated to construct the EventStore in `beforeEach` and pass it as the third arg to handler calls.
- `scripts/check-event-store-composition-root.mjs` allowlist shrinks to 4 paths: `index.ts`, `core/context.ts`, `cli-commands/{assemble-context, pre-compact}.ts`, `evals/run-evals-cli.ts`.
- `__tests__/event-store/single-composition-root.test.ts` asserts the new contract: `getOrCreateEventStore` and `registerCanonicalEventStore` must NOT exist as exports; concurrent appends through `ctx.eventStore` produce monotonic unique sequences.

Validation: typecheck clean (root + MCP server), root suite 625/625, MCP suite 5720/5725 (5 pre-existing `gates.test.ts` baseline failures unchanged).

Tracking workflow: `refactor-eventstore-constructor-injection`. Plan: `docs/plans/2026-04-26-eventstore-constructor-injection.md`.
