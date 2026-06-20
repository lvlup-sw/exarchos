# Event Sourcing in Exarchos — Mechanics, Concurrent-vs-Distributed Benefits, and How Fully We Leverage It

> **Type:** Discovery / research deliverable
> **Date:** 2026-06-18
> **Workflow:** `event-sourcing-leverage-study` (discovery)
> **Question source:** "Empirically understand how event-sourcing is mechanically applied and leveraged here."
> **Status:** Findings grounded in code at file:line; conclusions are the author's assessment.
> **See also:** [`documentation/architecture/event-sourcing.md`](../../documentation/architecture/event-sourcing.md),
> [`docs/architecture/runtime.md`](../architecture/runtime.md), [`docs/architecture/projections.md`](../architecture/projections.md),
> [`.exarchos/invariants.md`](../../.exarchos/invariants.md) (INV-1, INV-7, INV-8, INV-13, INV-15)

---

## TL;DR

1. **Replay is a left-fold over an append-only log, optimized by snapshots.** Reading state =
   load the latest snapshot → query only the events after it → fold them through a pure reducer.
   `/exarchos:rehydrate` and `reconcile` are two consumers of this one idea, with a subtle but
   important difference: rehydrate folds through the **pure `rehydration@v1` reducer**; reconcile
   folds through an **imperative `applyEventToState`** that mutates a state record in place. Cold
   rebuild (`rebuildProjection`) and three degraded paths give the system its crash-recovery story.

2. **In a *concurrent* (single-machine, multi-process) system, event sourcing buys recoverability,
   lockless coordination, and audit — and the ordering guarantees are *physical*, enforced by the
   SQLite substrate, not *emergent* from consensus.** The append-only log is the rendezvous point
   that lets the CLI, the MCP server, and parallel sub-agents coordinate via optimistic concurrency
   (a sequence CAS + a `(streamId, sequence)` PRIMARY KEY) instead of distributed locks. In a
   *distributed* system, event sourcing additionally buys replication, cross-service integration,
   and availability under partition — but those benefits *require* machinery (consensus, leader
   election, sagas, vector clocks) that Exarchos deliberately rejects (INV-15). We use the half of
   event sourcing that is cheap on one machine and skip the half that is only worth its cost across
   machines.

3. **We leverage event sourcing thoroughly on the *write/store* side and incompletely on the
   *state-resolution read* side.** v2.11.0 ("Verification & Reliability") was, in large part, an
   event-sourcing-maturation milestone: it converted two major mutable stores into projections
   (**#1284 EventSourcedTaskStore**, **#1304 merge-orchestrator-as-projection**) and removed
   regex-scrape fallbacks from gates (#1407). The remaining gap is the read path:
   **`resolveWorkflowState` is file-first** (`resolve-state.ts:80-88`) — it returns
   `<featureId>.state.json` *without consulting the event store* when the file exists, inverting
   INV-1's authority order. This is tracked, open, and explicitly framed as the next domino in the
   "stores-as-projections" cluster (**#1504**). Secondary maturity gaps: the `time-travel@v1` /
   `hot-file-manifest@v1` projections are still documented-but-absent, and event upcasting is
   scaffolded but unexercised.

---

## 0. Orientation: the one idea, five layers

Everything below is a consequence of a single architectural decision, stated in
[`runtime.md §11`](../architecture/runtime.md): *Exarchos is a single SQLite database with a typed
dispatch core in front of it; events are the authority, projections are caches over events.* The
layering ([`runtime.md §3`](../architecture/runtime.md)) puts the event store at L2, projections at
L3, and everything above (dispatch, composite tools, adapters, agents) consuming derived state.
INV-1 (event-sourcing-integrity) is the load-bearing rule: *every read-model is a left-fold over
events; state mutations are events, not in-place updates.*

The three questions in this study map cleanly onto that idea:

| Question | What it probes | Primary code surface |
|---|---|---|
| Q1 — How do events replay state? | the **read/fold** path | `workflow/rehydrate.ts`, `projections/*`, `workflow/state-store.ts` |
| Q2 — Concurrent vs distributed benefit? | the **write/coordinate** path | `event-store/atomic-appender.ts`, `storage/sqlite-backend.ts` |
| Q3 — Are we fully leveraging it? | the **authority** of events vs files | `orchestrate/resolve-state.ts`, projection inventory |

---

## 1. Q1 — How we use events to replay state (`/exarchos:rehydrate`)

### 1.1 The core algorithm: snapshot warm-start + tail fold

State is never stored as a primary fact — it is *computed* by folding events. The naïve version
("fold from sequence 0 every time") is correct but O(n) in the event count; Exarchos optimizes it
with snapshots. The warm-start path in
[`workflow/rehydrate.ts`](../../servers/exarchos-mcp/src/workflow/rehydrate.ts) is:

```
1. snapshot   = readLatestSnapshot(backend, featureId, "rehydration@v1", version)   // rehydrate.ts ~L384
2. document   = snapshot ? snapshot.state : rehydrationReducer.initial               // ~L125
3. sinceSeq   = snapshot?.sequence ?? 0                                              // ~L453
4. tailEvents = await eventStore.query(featureId, { sinceSequence: sinceSeq })       // ~L465
5. for (ev of tailEvents) document = rehydrationReducer.apply(document, ev)           // ~L505  (pure fold)
6. append workflow.rehydrated  (only when the stream is non-empty)                    // ~L600-611
7. return { success:true, data: document, _meta:{ workflowExists, projectionAsOf } }  // ~L654
```

Two details are load-bearing and have each caused a production bug:

- **`snapshot.sequence` is the *event-store* sequence, not the projection's internal count.**
  The reducer increments a `projectionSequence` only on *handled* events
  ([`projections.md §1`](../architecture/projections.md): "`projectionSequence` … incremented …
  once per **handled** event"). The snapshot instead records the highest *event-store* sequence
  folded in, so that the `sinceSequence` cursor skips exactly the events already absorbed —
  including events the reducer *ignored*. Storing the projection count here would re-fetch unhandled
  events on every read (`projections/store.ts`, `SnapshotRecord.sequence` doc comment; the
  divergence was #1178).

- **Empty streams are side-effect-free.** A cold probe of an unknown `featureId` (no snapshot, no
  events) returns `reducer.initial` with `_meta.workflowExists:false` and emits **no**
  `workflow.rehydrated` event (`rehydrate.ts` ~L590). This is the canonical existence check
  ([CLAUDE.md "State surfaces"]) — never filesystem `.state.json` presence.

### 1.2 The pure reducer: `rehydration@v1`

The fold function in
[`projections/rehydration/reducer.ts`](../../servers/exarchos-mcp/src/projections/rehydration/reducer.ts)
is a `switch` on `event.type` that returns a new document per event and **never mutates its input**
(the `assertReducerImmutable` harness deep-freezes intermediate states to enforce this —
[`projections.md §2b`](../architecture/projections.md)). It folds:

| Event family | Effect on the document |
|---|---|
| `task.assigned` / `task.completed` / `task.failed` | upsert `taskProgress`; bump `projectionSequence`; auto-detour to `merge-pending` if a completed task carries a worktree association (#1208) |
| `workflow.started` / `workflow.transition` / `workflow.guard-failed` / `workflow.checkpoint` | set phase / workflow metadata; record handoffs (sliding window of 3) |
| `state.patched` | apply an artifacts diff (unset-then-set) + monotonic plan-task promotion |
| `review.completed` / `review.escalated` | record review outcomes |
| `merge.executed` / `merge.rollback` / `merge.aborted` | record terminal merge outcome |
| `team.*`, `task.progressed` | recognised-but-non-folding (no `projectionSequence` bump) |
| anything else | `default: return state` — identity (forward-compatible) |

The purity contract ([`projections.md §1`](../architecture/projections.md)) is what makes warm-start
and cold-rebuild produce *byte-identical* results: `apply` is deterministic, does no I/O, reads no
clock/random/env. That equivalence is the whole reason snapshots are safe to cache.

### 1.3 Cold rebuild: the recovery floor

When the snapshot can't be trusted, `rebuildProjection`
([`projections/rebuild.ts`](../../servers/exarchos-mcp/src/projections/rebuild.ts)) folds the **entire**
log from sequence 0 with no `sinceSequence` filter:

```ts
const events = await eventStore.query(streamId);     // full stream, no cursor
let state = reducer.initial;
for (const event of events) state = reducer.apply(state, event);
return state;
```

This is the "replay the log" recovery primitive ([`runtime.md §5`](../architecture/runtime.md)):
state files are caches that can *always* be rebuilt; they are never authoritative.

### 1.4 Snapshot cadence and storage

- **When to snapshot:** `shouldTakeSnapshot(eventCountSinceLast, cadence)` — a pure predicate that
  fires on positive multiples of the cadence (default 50, `SNAPSHOT_EVERY_N`)
  ([`projections/cadence.ts`](../../servers/exarchos-mcp/src/projections/cadence.ts)).
- **Where:** the `projection_snapshots` SQLite table, keyed
  `(stream_id, projection_id, projection_version, sequence)`, capped at `SNAPSHOT_MAX_RECORDS`
  (default 500) with oldest-row eviction *in the same transaction*, and `INSERT OR IGNORE` for
  idempotent re-writes ([`projections.md §5`](../architecture/projections.md)). Pre-#1343 this was a
  JSONL sidecar; the substrate cut moved it into SQLite for cross-process safety.

### 1.5 Three degraded paths (DR-18)

`rehydrate.ts` treats degradation as a *handled success*, not a hard failure — it always returns a
usable document and tags the envelope. The three causes and their fallbacks
([`projections.md §4`](../architecture/projections.md), `buildDegradedResponse` ~L207-265):

| Cause | Trigger | Fallback source |
|---|---|---|
| `reducer-throw` | `apply` raises mid-fold (corrupt event shape) | `state-store-only` (minimal doc from `.state.json`) |
| `snapshot-corrupt` | snapshot fails schema validation | `full-replay` (`rebuildProjection` cold fold) |
| `event-stream-unavailable` | `eventStore.query` raises | `state-store-only` |

Each emits exactly one `workflow.projection_degraded { cause, fallbackSource }` (best-effort — if the
store is *also* down, the WARN is logged and swallowed, and the envelope's `cause` stays
authoritative). The returned `_meta.degraded:true` + `_meta.fallbackSource` lets a consuming agent
know it is working from reduced-fidelity state.

### 1.6 `rehydrate` vs `reconcile` — same idea, two folders

Both re-derive state from events, but they are *not* the same code path, and the difference is worth
calling out because it is a latent maintenance hazard.

| Aspect | `rehydrate` (`workflow/rehydrate.ts`) | `reconcile` (`workflow/state-store.ts` `reconcileFromEvents`) |
|---|---|---|
| Cursor | snapshot `sequence` | state file `_eventSequence` |
| Fold mechanism | **pure** `rehydrationReducer.apply` | **imperative** `applyEventToState` (mutates a state record in place) |
| Output | in-memory `RehydrationDocument` + `workflow.rehydrated` event | rewritten `.state.json` (CAS via `expectedVersion`) |
| Empty stream | returns `initial`, `workflowExists:false`, no emission | merges hook-event sidecars first, then creates state from `workflow.started` |
| Idempotency | re-runnable; emits on success | idempotent: "no new events" → `{ reconciled:false, eventsApplied:0 }` |

`reconcile` is the bridge that keeps the *secondary* `.state.json` stamp consistent with the log
(crash recovery, sidecar merge, sequence re-sequencing —
[`event-sourcing.md "Reconciliation"`](../../documentation/architecture/event-sourcing.md)). The fact
that it folds via a *second, imperative* implementation rather than reusing the pure reducer is a
**duplication risk**: two fold implementations over the same event types can drift. (See §3.5.)

---

## 2. Q2 — Why event sourcing pays off in a *concurrent* system, and how that differs from a *distributed* one

### 2.1 The frame: concurrent, not distributed

[`runtime.md §1`](../architecture/runtime.md) states the frame precisely: *Exarchos is a concurrent
system, not a distributed one — no network between participants, no untrusted actors, no clock skew,
no replication.* INV-15 (single-machine-frame) makes this a design rule: *no saga, no
Scheduler-Agent-Supervisor, no 2PC, no leader election, no vector clocks, no BFT consensus, no
distributed locks.* The sources of concurrency are all on one box
([`runtime.md §4`](../architecture/runtime.md)):

- the CLI and the MCP server running at once (developer in a shell + agent in an IDE);
- multiple sub-agents in parallel git worktrees, each with its own MCP client;
- the orchestrator agent and its sub-agents all writing to the same feature workflow.

### 2.2 What event sourcing buys *here* (the concurrent regime)

**(a) Recoverability on an unreliable session — the original motivation.**
Agent sessions die mid-operation (context compaction, closed laptop, crash). With mutable state, a
crash mid-write leaves a half-updated JSON file of indeterminate meaning
([`event-sourcing.md "Why event sourcing"`](../../documentation/architecture/event-sourcing.md)). With
an append-only log, a SQLite transaction is all-or-nothing (`BEGIN IMMEDIATE … COMMIT`), so there is
no half-event; and any derived state can be rebuilt by replay ([`runtime.md §5`](../architecture/runtime.md),
RT-1/RT-6). Recovery is "fold the log," not "guess what the half-written file meant."

**(b) Lockless coordination — the log is the rendezvous point.**
This is the concurrency-specific payoff. Multiple writers don't take an application lock; they race
to append, and the substrate arbitrates. Concretely, the guarantees are *physical*, enforced by the
storage layer ([`atomic-appender.ts`](../../servers/exarchos-mcp/src/event-store/atomic-appender.ts),
[`sqlite-backend.ts`](../../servers/exarchos-mcp/src/storage/sqlite-backend.ts)):

| Guarantee (RT-#) | Mechanism | Where |
|---|---|---|
| Single writer per stream (in-process) | `StreamLockManager` — a per-stream Promise-chain mutex | `atomic-appender.ts` (`runExclusive`) |
| Total order within a stream | `PRIMARY KEY (streamId, sequence)` | `sqlite-backend.ts` events DDL |
| Atomic append | one `BEGIN IMMEDIATE` txn wrapping idempotency-claim + event INSERT + sequence upsert | `sqlite-backend.ts` `atomicAppend` |
| Lost-update prevention (OCC) | `expectedSequence` CAS vs the high-water mark *before* the txn → `sequence-conflict` | `atomic-appender.ts` (~L919-931) |
| Idempotent at-least-once delivery | `UNIQUE (streamId, idempotencyKey)` + pre-txn cache-hit lookup returns the *original* committed events | `sqlite-backend.ts` `idempotency_claims`; `atomic-appender.ts` (~L897, ~L1075) |
| Cross-process contention | WAL mode + `busy_timeout=5000` (C-layer) then a 5-attempt JS backoff (`SqliteBusyExhaustedError`) | `sqlite-backend.ts` pragmas + retry loop |

The classic concurrency hazard — the *lost update*, where two writers read-modify-write and one
silently clobbers the other — is eliminated by OCC on the event sequence plus the composite PK: the
loser's transaction raises a constraint violation, is translated to `sequence-conflict`, and retries
against the new tail ([`runtime.md §4`](../architecture/runtime.md)). No mutex service, no lease.

**(c) Reconciliation across processes.**
The specific concurrent failure that motivates `reconcile` is: a hook *subprocess* writes events to
a sidecar while the main MCP server is restarting; on next startup the sidecar is merged and
reconciliation brings state up to date ([`event-sourcing.md "Reconciliation"`](../../documentation/architecture/event-sourcing.md)).
That is a *two-processes-sharing-a-store* problem — pure concurrency, no distribution.

**(d) Audit trail / observability for free.**
Because every transition, guard failure, task assignment, and gate execution is an event, "what
happened during this workflow?" is answerable by reading the log
([`runtime.md §6`](../architecture/runtime.md)). Liveness is *event-emitted*
(`<surface>.executing_started`, INV-10) rather than polled.

**(e) Crash-safe external side effects (the process-manager split, INV-13).**
Non-idempotent external mutations (GitHub API, git on shared branches) split into `*.requested`
(intent + full payload, before) and `*.executed` (result, after)
([`merge-orchestrate.ts`](../../servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts),
[`runtime.md §4 "Process-manager handlers"`](../architecture/runtime.md)). On retry, the `*.requested`
event idempotency-collapses so the side effect fires once; on crash recovery, the next invocation
sees `*.requested` without `*.executed` and runs an *idempotent precheck* against external state
("does the PR already exist?") to decide whether to re-emit or skip.

### 2.3 What event sourcing would *additionally* buy in a *distributed* system

Event sourcing is equally famous in distributed architectures, but the benefits there are a
*different set*, and they come bundled with costs Exarchos refuses to pay:

| Distributed benefit | Why it matters there | Why Exarchos doesn't need it (and the cost it avoids) |
|---|---|---|
| **Replication / availability** | the log can be streamed to other nodes; each rebuilds state independently; survive node loss | one machine, one store — no node to fail over to. Avoids replication lag, quorum writes. |
| **Cross-service integration / decoupling** | events are the integration contract in EDA; each service keeps its own projection; producers/consumers are temporally decoupled | one dispatch core, one event store. The CLI and MCP are *facades* over the same core (INV-2), not separate services exchanging events. |
| **Partition tolerance / eventual consistency** | replicas converge by replaying the same ordered log despite network splits | no network between participants → no partitions to tolerate. State is *immediately* consistent via the single substrate. |
| **Global total order** | needs a consensus protocol (Raft/Paxos) or a single elected leader/sequencer; clock skew forces vector/Lamport clocks | total order is a *local* `(streamId, sequence)` PK constraint — physical, not consensus-derived (RT-2). |
| **Cross-service transactions** | needs sagas with compensating actions across services | "compensation is rewinding **local** state, not sending commands to remote services" ([`runtime.md §8`](../architecture/runtime.md)); INV-14 prefers the operation's own recovery primitive (`git merge --abort` → `git reset --keep`, never `--hard`). |

The crisp distinction:

> In a **concurrent** system, event sourcing's value is **recoverability + lockless coordination +
> auditability**, and its ordering/atomicity guarantees are **physical** — handed to you by one
> ACID substrate (Mohan et al. *ARIES*; Bernstein & Goodman — the citations behind INV-7, not
> distributed-systems papers). In a **distributed** system, event sourcing *additionally* delivers
> **replication, decoupled service integration, and availability under partition** — but those
> require **consensus, leader election, sagas, and logical clocks** to manufacture the single
> ordered log that a concurrent system gets for free from the filesystem.

Exarchos uses the half of event sourcing that is *cheap on one machine* (log-as-truth, projections,
replay, OCC) and explicitly rejects the half that only earns its keep across machines
([`runtime.md §8 "What this deliberately is not"`](../architecture/runtime.md)). INV-3
(basileus-forward) keeps the door open: storage backends are transport-agnostic and capability
resolution is handshake-authoritative, so the *same* event-sourced core could one day back a remote
(Basileus) tier — but that is a future tier, not today's frame.

---

## 3. Q3 — Are we fully leveraging event sourcing, given v2.11.0?

**Short answer: We leverage it thoroughly on the write/store side, and incompletely on the
state-resolution read side. v2.11.0 ("Verification & Reliability") was largely an
event-sourcing-maturation milestone — it closed two of the three big "mutable-store → projection"
conversions and left the third (read-path authority) open as #1504.**

### 3.1 v2.11.0 as an event-sourcing milestone

Milestone #15 is themed "Verification & Reliability," and a substantial fraction of its *closed*
work is event-sourcing integrity, not just verification ladders:

| Issue (closed) | Event-sourcing significance |
|---|---|
| **#1284** EventSourcedTaskStore — TaskStore as projection over `task.*` | converts a mutable SDK store into a left-fold projection |
| **#1304** merge-orchestrator state → projection over `merge.*` | removes an in-memory side-database; state becomes a deterministic fold |
| **#1407** remove regex-scrape fallback from `check_*` gates | gates derive from events/projections, not text-scraping |
| **#1119 / #1302** autonomous merge orchestrator + audit follow-up | the INV-13 two-event split |

Sibling cluster framing comes straight from #1504's own body: *"Sibling of the INV-1
stores-as-projections cluster — #1304 (mergeOrchestrator → projection), #1284
(EventSourcedTaskStore), umbrella epic #1342."* So the codebase is mid-way through a deliberate
campaign to make every read-model a projection. Two dominoes fell in v2.11.0; one remains.

### 3.2 Fully leveraged (✅)

**TaskStore is the exemplar.**
[`task-store/event-sourced-task-store.ts`](../../servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts)
implements the MCP SDK `TaskStore` interface by emitting four `task.*` lifecycle events on every
mutating call and *reconstructing per-task state by folding those events on read*. It uses OCC
(`commitWithOcc` against `expectedSequence`), lazy cache rebuild on miss (full re-fold) vs. tail
validation on hit (incremental re-fold), and — critically for cross-process determinism — binds
`expiresAt` to the *event timestamp*, not `Date.now()`, "so the writer's in-memory cache matches
what a replaying reader process computes" (an explicit INV-1 determinism note in the source).

**Merge-orchestrator is a pure projection.**
[`projections/merge-orchestrator/reducer.ts`](../../servers/exarchos-mcp/src/projections/merge-orchestrator/reducer.ts)
registers `merge-orchestrator@v1`, a stream-scoped left-fold over
`merge.preflight | merge.requested | merge.executed | merge.rollback | merge.completed`, preserving
audit metadata across phase transitions. The executor reaches state via
`appender.decide<MergeOrchestratorState>(featureId, "merge-orchestrator@v1", …)` and short-circuits
to an idempotent no-op when the projection already shows forward progress
([`execute-merge.ts`](../../servers/exarchos-mcp/src/orchestrate/execute-merge.ts)).

**CQRS views read from events, not files.**
The `exarchos_view` materializers
([`views/tools.ts`](../../servers/exarchos-mcp/src/views/tools.ts)) register ~14 projections
(`workflow_status`, `tasks`, `pipeline`, `telemetry`, `provenance`, `convergence`, …) behind a
`ViewMaterializer` that queries the event store and folds — none read `.state.json`. This is proper
CQRS: write side and read side share only the event log.

**Substrate guarantees** (OCC, idempotency, atomic append, reconcile, snapshot caching) are
production-grade and covered in §2.2.

### 3.3 The central gap (🔴): file-first `resolveWorkflowState` (#1504, OPEN)

This is the most important finding. INV-1 says the event log is the source of truth and `.state.json`
is a *derived stamp*. The shared resolver inverts that order. Verified first-hand in
[`orchestrate/resolve-state.ts:77-115`](../../servers/exarchos-mcp/src/orchestrate/resolve-state.ts):

```ts
export async function resolveWorkflowState(opts: ResolveOpts): Promise<ResolveResult> {
  // ── Try state file first ──────────────────────────────────────────────────
  if (opts.stateFile && existsSync(opts.stateFile)) {
    try {
      const raw = readFileSync(opts.stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { state: parsed };                       // ← returns the FILE, no event-store check
    } catch { /* fall through to event store */ }
  }
  // ── Fall back to event store materialization ──────────────────────────────
  if (opts.featureId && opts.eventStore) {
    const events = await opts.eventStore.query(opts.featureId);
    let view = workflowStateProjection.init();
    for (const event of events) view = workflowStateProjection.apply(view, event);
    return { state: view as unknown as Record<string, unknown> };
  }
  return { error: { /* NO_STATE_SOURCE */ } };
}
```

The event store — the authoritative log — is consulted **only as a fallback** when the file is
absent or unparseable. A *stale-but-valid* file silently wins over the projection. #1504 (OPEN)
frames it exactly: *"a stale on-disk file silently shadows the authoritative projection. This is
exactly the drift `reconcile_state` exists to repair; every consumer of `resolveWorkflowState` is
exposed until then."*

**Why it bites (a genuine concurrency hazard, §2.1 sources):**

1. Process A appends `merge.executed` to the store ✔, then crashes *before* rewriting `.state.json`.
2. Process B (fresh CLI or restarted MCP server) calls `resolveWorkflowState` for the same feature.
3. B finds the stale `.state.json`, returns it file-first, and never sees `merge.executed`.
4. B proceeds as if the merge never happened.

The consumers exposed today (per #1504): `post_delegation_check`, `reconcile_state`,
`finalize_oneshot`, `request_synthesize`, plus the 7 gate handlers migrated under
`refactor-1486-subissues`. This is consistent with the standing project memory note
("State-source: resolveWorkflowState, not .state.json — 7 gate handlers still read the file") and
with the documented advisory behaviors of `check_design_completeness` and `post_delegation_check`
trailing recent events.

**The fix is deletion, not reordering (maintainer steer, 2026-06-18).** `.state.json` is **legacy**:
SQLite (the event log + projections) is the *sole* source of truth, and the file read/write path is
removable — not a fallback worth keeping. So rather than #1504's conservative "reorder to event-first
with the file as a validated fast-path," the resolver should **drop the `stateFile` branch entirely**
and materialize only from the event log (see R1). #1504 is the cautious version of this same move;
R1 supersedes it.

### 3.4 Secondary gaps (🟡)

- **Documented-but-absent projections.** [`projections.md §3`](../architecture/projections.md) lists
  `hot-file-manifest@v1` and `time-travel@v1` as future projections; the registry barrel
  ([`projections/index.ts`](../../servers/exarchos-mcp/src/projections/index.ts)) registers only
  `taskstore` and `merge-orchestrator` (plus `rehydration@v1` and `next-action@v1` registered via
  their own paths). A **time-travel projection is the canonical "full potential" use of an audit
  log** — "show me workflow state as of timestamp T" is trivial given an ordered event log and a
  pure reducer, but is not yet built. This is the clearest example of latent, unrealized leverage.

- **Event upcasting scaffolded but unexercised.**
  [`event-store/event-migration.ts`](../../servers/exarchos-mcp/src/event-store/event-migration.ts)
  defines an `EventMigration` interface, a `migrateEvent` upcaster, and forward-compatible
  tolerance of unknown versions — but `eventMigrations` is an **empty array** and
  `EVENT_SCHEMA_VERSION` is still `'1.0'`. Schema evolution (e.g. #1296's retirement of
  `HandoffEntrySchemaV1`) will need this path; it has not been exercised end-to-end. For a system
  whose whole premise is an immortal log, a battle-tested upcasting story is a maturity prerequisite
  the moment the first breaking event-shape change ships.

- **Two fold implementations (§1.6).** `rehydrate` folds via the pure `rehydration@v1` reducer;
  `reconcile` folds via imperative `applyEventToState` in `state-store.ts`. Same events, two
  reducers — a drift risk. Consolidating reconcile onto the pure reducer would make "one fold, many
  callers" literally true.

- **In-memory `_events` cap (acceptable).** The legacy in-state `_events` array is FIFO-capped at
  `EVENT_LOG_MAX` (default 100). This is a *pre-event-store* artifact for legacy workflow machines;
  the durable SQLite log is unbounded and historical queries go to the store (`queryByType`), so
  this is not a real gap — but it is a reminder that some legacy surfaces predate the substrate.

### 3.5 Scorecard

| Surface | ES leverage | Evidence |
|---|---|---|
| TaskStore | ✅ full projection | `event-sourced-task-store.ts` |
| Merge orchestrator | ✅ full projection | `projections/merge-orchestrator/reducer.ts`, `execute-merge.ts` |
| CQRS read views | ✅ event-sourced CQRS | `views/tools.ts` |
| Append/concurrency substrate | ✅ OCC + idempotency + atomic | `atomic-appender.ts`, `sqlite-backend.ts` |
| Rehydrate/snapshot/reconcile | ✅ replay + recovery | `rehydrate.ts`, `projections/*`, `state-store.ts` |
| **`resolveWorkflowState`** | 🔴 **legacy `.state.json` read path** (SQLite is SoT; file deletable) | `resolve-state.ts:80-88` — **#1504** |
| Time-travel / hot-file-manifest | 🟡 documented, absent | `projections.md §3` vs `projections/index.ts` |
| Event upcasting | 🟡 scaffolded, unexercised | `event-migration.ts` (empty registry) |
| `reconcile` fold | 🟡 imperative duplicate of pure reducer | `state-store.ts` vs `rehydration/reducer.ts` |

---

## 4. Recommendations (detailed)

Five recommendations, ordered by leverage. R1 *deletes* a legacy artifact; R2 and R4 turn an
already-correct intent into a **structurally-enforced** one (drift becomes unrepresentable, not merely
tested); R3 generalizes a tiny primitive into a family of capabilities; R5 is a standing guardrail.
A recurring theme across R2/R4 — and the project's existing idiom (INV-11 "unrepresentable by
construction"; the "nothing imports `Database` outside `sqlite-backend.ts`" CI gate;
`scripts/check-withsession-idempotency.sh`) — is that the *right* place to enforce an invariant is
the type system or a CI gate, not a code review. Dependency order: **R1 → R2** (R1 removes the legacy
fold so R2 unifies the remaining two), with **R3, R4 independent**.

### R1 — Delete the legacy `.state.json` path; SQLite is the sole resolver (supersedes #1504)

**Correction (maintainer steer, 2026-06-18).** The earlier framing — "make the resolver event-first,
keep the file as a validated fast-path" — over-preserved a legacy artifact. **`.state.json` is not a
co-equal source to validate; it is legacy code that can be deleted.** SQLite is the *only* source of
truth. So R1 is a *deletion*, not a reordering — and strictly simpler than #1504's "reorder" proposal.

**The change.**
1. Remove the `stateFile` branch from `resolveWorkflowState`
   ([`resolve-state.ts:80-88`](../../servers/exarchos-mcp/src/orchestrate/resolve-state.ts)) — and,
   ultimately, the `stateFile` parameter. The resolver becomes: materialize `workflowStateProjection`
   from the event log, period.
2. Stop *writing* `.state.json` (the `writeStateFile`/reconcile path in
   [`state-store.ts`](../../servers/exarchos-mcp/src/workflow/state-store.ts)). With no reader, the
   writer is dead weight; removing it also retires the file's `_eventSequence` cursor and CAS
   `_version` bookkeeping.
3. Migrate the ~10 exposed call sites still passing `stateFile` (`post-delegation-check.ts:209`,
   `reconcile-state.ts:271`, `pre-synthesis-check.ts:493`, `extract-fix-tasks.ts:130`,
   `investigation-timer.ts:66`, `finalize-oneshot.ts:70`, `verify-review-triage.ts:122`,
   `assess-refactor-scope.ts:91`, `select-debug-track.ts:132`, `request-synthesize.ts:90`) to the
   event-store-only form the *already-safe* callers use (`composite.ts:181` — "NEVER reads
   `.state.json`", `prepare-synthesis.ts:204`, `design-completeness.ts:42`).

**The one precondition (the real work).** Per [CLAUDE.md "State surfaces"], `.state.json` was a
"planner's stamp for plan facts the projection can't derive." Before deleting it, **audit every field
the file carries against `workflowStateProjection` coverage and event-source any gap** — for any datum
currently *only* in the file, ensure there is an event the projection folds. The projection is already
broad (artifacts, tasks, reviews, synthesis, `phaseObligation`, `_checkpoint`, `_history`), so most
file-only fields are mechanical bookkeeping (`_version` CAS, `_eventSequence` cursor, the capped
`_events` array) that simply *disappear* with the file. That field-coverage audit is the gate on
deletion.

**Why this is also a simplification.** Deleting the file removes, in one stroke: the file-vs-log
staleness hazard (no second source to drift), the reconcile-writes-file path, the file CAS machinery,
*and one of the three folds* — `applyEventToState` exists precisely to write the file (see R2).

**Sequencing.** Land after the `refactor-1486` gate-handler migration (so every gate already routes
through the resolver). The field-coverage audit is the long pole; the code deletion is small.

**Testing.** (a) CI gate: no production code reads or writes `*.state.json` (mirror the existing
"nothing imports `Database` outside `sqlite-backend.ts`" gate). (b) Field-coverage test: assert
`workflowStateProjection` exposes every field former consumers read from the file. (c) Behavioral:
existing gate/handler suites pass with the resolver event-only. **Effort:** S (code) + M (audit);
**Risk:** low once the audit is clean; **Invariant:** INV-1.

### R2 — Collapse to one canonical reducer, enforced *structurally*

**Problem (verified, sharper than §1.6).** There are **three** independent folds over workflow
events, plus a fourth manually-synced table:

1. `workflowStateProjection` — `ViewProjection` (`version:'1.1'`) in
   [`views/workflow-state-projection.ts`](../../servers/exarchos-mcp/src/views/workflow-state-projection.ts);
   backs the `workflow-state` CQRS view *and* the `resolveWorkflowState` materializer.
2. `rehydration@v1` — `ProjectionReducer` in `projections/rehydration/reducer.ts`; backs `rehydrate`.
3. `applyEventToState` — *imperative* in-place mutation in `workflow/state-store.ts`; backs
   `reconcile` (and goes away with the file in R1).
4. `INITIAL_PHASE` (`workflow-state-projection.ts:15-20`) — a phase map the source comments flag as
   manually "kept in sync with `getInitialPhase` in `workflow/state-machine.ts`."

For INV-1's "every read-model is a left-fold" to *actually* hold, all of these must agree on how each
event mutates state. A test that they currently agree is necessary but not sufficient — it does not
stop the *next* event type from being handled in one fold and silently forgotten in another.

**Consolidate.** Promote `workflowStateProjection` (most complete, already the materializer) to a
single registered `workflow-state@v1` `ProjectionReducer` alongside `taskstore`/`merge-orchestrator`;
`reconcile` (until R1 removes it) and every other reader fold through *that*. Bridge the
`ViewProjection` ↔ `ProjectionReducer` interfaces (both are `initial/init` + `apply`).

**Enforce it structurally (the ask) — three independent guards, strongest first:**

- **Compile-time exhaustiveness.** Switch the canonical reducer over the discriminated union of
  `WorkflowEvent['type']` with `default: assertNever(event.type)`. Adding an event type to the union
  without handling it (or explicitly listing it in a `// observability-only` no-op set) becomes a
  **type error**, not a latent gap. Strongest guard; costs one helper.
- **Single-fold CI gate.** `scripts/check-single-workflow-fold.mjs` (sibling of
  `check-withsession-idempotency.sh`) fails the build if any file *outside* the canonical module
  contains a `switch (event.type)` fold over `WorkflowEvent`. New parallel folds become unmergeable.
- **Registry singularity.** The registry already throws on duplicate `id`
  ([`projections.md §1`](../architecture/projections.md)); extend it to reject a *second* reducer
  claiming the `workflow-state` domain — exactly one registered authority by construction.

**Sequencing.** Pairs with R1 (R1 deletes fold #3; R2 unifies #1/#2 and the phase table). **Testing.**
the `assertNever` guard *is* the completeness test; add a golden replay equating the pre-/post-
consolidation projection over a representative log (cheap once R3 lands). **Effort:** M; **Risk:** med
(touches `reconcile` until R1 lands); **Invariant:** INV-1.

### R3 — Make the *bounded fold* a first-class primitive (time-travel is one of many uses)

**Reframing (maintainer steer).** "Time-travel as of T" undersells it. The enabling change is tiny — a
*cursor on the fold* — but a bounded/parameterized fold over an immutable ordered log is a
**primitive that unlocks a family of capabilities**, most of which the codebase wants independently.

**The primitive.** Extend `rebuildProjection`
([`projections/rebuild.ts`](../../servers/exarchos-mcp/src/projections/rebuild.ts)) with a cursor, and
add two thin derived operators:

```ts
projectAt(reducer, store, stream, { untilSequence?: N, untilTimestamp?: T })   // bounded fold
diffStates(a, b)                                                               // structural delta of two folds
bisect(reducer, store, stream, predicate)                                     // first event where predicate flips
```

Warm-start still applies: start from the latest snapshot whose `sequence <= N` (the
`projection_snapshots` DESC index already supports an upper-bounded read), fold the bounded tail.
Purity guarantees `projectAt(N)` equals an independent fold of `events[0..N]`.

**The family it unlocks (near-term → speculative):**

| Capability | What it is | Serves |
|---|---|---|
| Lifecycle verbs | `describe`/`wait`/`ps` "state now / at phase X" | v2.12 (the originally-outlined use) |
| **State diff** | `diffStates(at(N-1), at(N))` → "what did the *delegate* phase actually change?" | review; rehydrate UX (#1475 "since my last handoff") |
| **Forensics / RCA** | replay to the event *before* a `gate.executed` failure; reproduce the exact corrupt state a degraded path hit | debugging; the RCA tree |
| **State bisect** | `git bisect` for workflow state — binary-search the event that introduced a bad invariant | regression root-causing |
| **Counterfactual / alt-reducer replay** | fold a historical log through a *candidate* reducer version | **de-risks R2 + R4** — prove a new/upcasted reducer projects history identically (or intentionally differently) |
| **Golden replay fixtures** | event-log slices become deterministic test inputs / versioned eval datasets | CI; the eval suite (#1365) |
| **Time-series analytics** | fold-to-each-checkpoint → phase dwell-time, gate pass-rate over time, convergence curves | telemetry / quality / convergence views |
| Audit / compliance | exact state at any timestamp ("who knew what when") | provenance |

The counterfactual-replay row is the quiet win: it makes R2's consolidation and R4's upcasting
*verifiable against real history* rather than synthetic fixtures.

**Surface.** `exarchos_workflow({action:'get', asOf})` / `exarchos_view({asOf})` for the read verbs;
`diffStates`/`bisect` as internal primitives first, promoted to verbs as demand appears.
**Testing.** `projectAt(N)` ≡ from-scratch fold of `events[0..N]`; `diffStates` round-trips; `bisect`
finds a known-planted transition. **Effort:** S (primitive) + S each (operators); **Risk:** low
(read-only); **Invariant:** INV-1, INV-10. Keep it a *local* bounded fold (R5) — not streaming to
replicas.

### R4 — Wire event upcasting, enforced *structurally*

**Problem (sharpened — *unwired*, not merely unexercised).**
[`event-store/event-migration.ts`](../../servers/exarchos-mcp/src/event-store/event-migration.ts)
defines `migrateEvent` + the `EventMigration` interface, but `eventMigrations` is `[]`,
`EVENT_SCHEMA_VERSION` is `'1.0'`, and **`migrateEvent` has no production call site** — `query`
([`store.ts:495`](../../servers/exarchos-mcp/src/event-store/store.ts)) delegates straight to
`backend.queryEvents` with no upcasting hook; cache-hit branches (`store.ts:373,481`) pass
`schemaVersion` through verbatim. (A `store.test.ts:788` comment claims "migrateEvent() is called
during query," but no such call exists.)

**Why it matters.** An append-only log means a v1 event written today must stay readable by a v3
reducer later. Rewriting old events violates INV-1, so read-time upcasting is the *only* sanctioned
evolution path. Unwired, the first breaking shape change (e.g. #1296's `HandoffEntrySchemaV1`
retirement) either breaks replay or forces a forbidden in-place log migration.

**Wire it — at one mandatory choke point.** Map every event through `migrateEvent` inside
`store.ts:query` (the single seam every reader passes through: rehydrate, reconcile, views,
`resolveWorkflowState`). Identity no-op today; load-bearing the moment a migration registers.

**Enforce it structurally (the ask) — make bypass and omission unrepresentable:**

- **No-bypass gate.** A CI gate (sibling of the `Database`-import gate) forbids constructing a
  `WorkflowEvent` from a raw backend row anywhere *except* the one `query` choke point — so no reader
  can sidestep the upcaster. Reads converge on one upcasting seam by construction.
- **Version-coverage gate.** A build-time test asserts: for every event type, every `schemaVersion`
  `< EVENT_SCHEMA_VERSION` has a migration path to current. Bumping `EVENT_SCHEMA_VERSION` *or*
  changing an event's Zod shape without registering the matching migration **fails the build** — the
  same "collision throws at startup" idiom already used for registration-schema conflicts.
- **Golden-log replay corpus.** A pinned set of historical-version event rows that must keep replaying
  green across version bumps — exactly what R3's bounded fold + alt-reducer replay makes cheap to
  assert.

**Bonus the substrate already gives you.** Snapshots invalidate on `schemaVersion` mismatch
([`views/snapshot-store.ts:130`](../../servers/exarchos-mcp/src/views/snapshot-store.ts)), so a version
bump forces a clean cold rebuild *through* the upcaster — no stale snapshot survives a migration.
**Effort:** S to wire + S per gate; **Risk:** low (identity today); **Invariant:** INV-1.

### R5 — Keep the frame honest (INV-15) without foreclosing INV-3

The structural guards in R2/R4 enforce *internal* invariants; INV-15 is the *external* one — none of
R1–R4 should import distributed machinery. Run each design through the `check_invariant_conformance`
gate (INV-1/INV-7/INV-15 are substrate-axis, always-load):

- R3's bounded fold stays a *local* primitive — not event-streaming to replicas.
- R4's upcasting stays *read-time schema evolution* — not cross-service schema negotiation.
- R1/R2 stay OCC + single-writer + a single SQLite SoT; no distributed lock, no second store.

The nuance: honor INV-15 *today* while not foreclosing **INV-3** (basileus-forward). Keep storage
transport-agnostic and capability resolution handshake-authoritative — the bounded fold, the upcaster,
and the event-only resolver are all transport-agnostic by construction, so the same core could one day
back a remote tier at no present cost.

### Sequencing & effort summary

| # | Recommendation | Structural enforcement | Depends on | Effort | Risk | Issue |
|---|---|---|---|---|---|---|
| R1 | **Delete** legacy `.state.json`; SQLite sole resolver | CI: no `*.state.json` read/write | after `refactor-1486` + field-coverage audit | S+M | Low | #1504 (retitled; supersedes "reorder") |
| R2 | One canonical `workflow-state@v1` reducer | `assertNever` exhaustiveness + single-fold CI gate + registry singularity | R1 | M | Med | **#1554** |
| R3 | Bounded-fold primitive (`projectAt`/`diff`/`bisect`) + `asOf` verb | — | — | S–M | Low | **#1555** |
| R4 | Wire upcasting at the `query` choke point | no-bypass gate + version-coverage gate + golden corpus | — | S | Low | **#1556** (→ #1296) |
| R5 | INV-15 conformance; don't foreclose INV-3 | `check_invariant_conformance` | ongoing | — | — | — |

---

## 5. Sources

- [`documentation/architecture/event-sourcing.md`](../../documentation/architecture/event-sourcing.md)
- [`docs/architecture/runtime.md`](../architecture/runtime.md) (§1 frame, §3 layers, §4 concurrency, §5 recovery, §6 observability, §8 not-this, RT-1..6)
- [`docs/architecture/projections.md`](../architecture/projections.md) (reducer contract, snapshot/cadence/rebuild, degradation)
- [`.exarchos/invariants.md`](../../.exarchos/invariants.md) — INV-1, INV-7, INV-8, INV-13, INV-14, INV-15
- Code: `workflow/rehydrate.ts`, `workflow/state-store.ts`, `projections/{rebuild,store,cadence,registry,types,index}.ts`, `projections/rehydration/reducer.ts`, `projections/merge-orchestrator/reducer.ts`, `event-store/atomic-appender.ts`, `event-store/event-migration.ts`, `storage/sqlite-backend.ts`, `orchestrate/{merge-orchestrate,execute-merge,resolve-state}.ts`, `task-store/event-sourced-task-store.ts`, `views/tools.ts`
- GitHub milestone v2.11.0 (#15): #1284, #1304, #1407, #1119/#1302, and the open #1504 (file-first → event-first)
