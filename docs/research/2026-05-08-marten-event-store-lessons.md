# What Exarchos's Event Store Can Learn from Marten

**Date:** 2026-05-08
**Workflow:** `marten-event-store-lessons` (discovery)
**Pairs with:** [`docs/architecture/runtime.md`](../architecture/runtime.md), [`docs/designs/archive/2026-05-08-durable-event-store-substrate.md`](../designs/archive/2026-05-08-durable-event-store-substrate.md) (#1259)
**Verdict:** **Conditional adopt — five primitives, not the full Marten stack.** Exarchos's event store, even after #1259's SQLite flip, *is* simpler than Marten's. Most of that simplicity is correct: it matches the canonical framing (single-machine event-sourced process manager with cooperative agents). But Marten has crystallized five primitives that Exarchos currently leaves implicit or absent — adopting them would close real gaps without dragging in framework that doesn't fit our context.

## Concern stated by the requester

> "I am concerned [the event store is] too 'simple'. I wonder if there is anything that can be learned from Marten's design."

Reasonable concern. The audit's RT-1..RT-6 runtime guarantees describe what the substrate *must* do; they don't describe what would make it *good*. Marten — running over PostgreSQL, in production for years, with explicit support for both inline and async projections, subscriptions for external integration, and crystallized patterns like `FetchForWriting` — is the right reference point for stress-testing what we have.

The honest answer: Exarchos's event store is appropriately simple for its context, but it's also under-specified in five places where Marten has clearly thought through the tradeoffs. None of these gaps are urgent; all five become more relevant as the runtime matures into v3.0+ (SDK, Basileus federation).

## Method

1. Read Marten's [event-store overview](https://martendb.io/events/) and full [LLM docs digest](https://martendb.io/llms-full.txt) (1MB; ~26K lines covering 100+ topics).
2. Extract primitives across nine domains: append semantics, concurrency, metadata, subscriptions, versioning, projections (inline/live/async), aggregates/FetchForWriting, archiving, rebuild.
3. Map each primitive to one of three buckets against the canonical framing: **adopted** (already in Exarchos), **candidate** (gap with concrete value), **wrong-shape** (solves problems we don't have).
4. Rank candidates by impact and substrate-coupling.

## Marten architecture in one paragraph

Marten is a .NET event store on top of PostgreSQL. Events live in `mt_events`; stream metadata in `mt_streams`. Two append modes: **Rich** (captures version metadata at append time, slower) and **Quick** (server-timestamp, faster, fewer concurrency races). Projections come in three flavors: **Inline** (synchronous, in the same SaveChanges transaction), **Live** (computed on read, no storage), **Async** (background daemon, eventual consistency, can rebuild and version-deploy). **Subscriptions** are a separate concept — same daemon machinery, but for shipping events to external systems (Kafka, etc.) rather than building views. **FetchForWriting** is the canonical command-handler primitive: load aggregate → decide → append events → save with optimistic concurrency, all in one round-trip. **Tombstone events** are placeholders for failed transactions, so the async daemon's high-water mark doesn't stall on gaps. **Upcasters** transform old event payloads into new schemas at deserialization time. The whole design assumes `Newtonsoft.Json` (or `System.Text.Json`) serialization with type-name mapping for migration.

## Per-primitive analysis

### Already adopted (Exarchos has equivalent)

| Marten primitive | Exarchos equivalent | Notes |
|---|---|---|
| Append-only event log | SQLite `events` table (post-#1259) | RT-1, RT-3 |
| Per-stream sequence | `PRIMARY KEY (stream_id, sequence)` (post-#1259) | RT-2 |
| Optimistic concurrency on document writes | `withStateRetry` + `VersionConflictError` | RT-4 (state file) |
| Inline projection | Eager state-file write in handlers (today); reducer registration (post-#1284) | RT-1, partial — see audit S-3 / issue #1304 |
| Aggregate / FetchForWriting pattern | Composer handlers reading workflow state, deciding, appending events | Implicit; not formalized as a primitive — see C-2 below |
| Stream archiving | Pruner; `prune_stale_workflows` | Less sophisticated than Marten's `is_archived` + partitioned hot/cold storage |
| Projection rebuild | `reconcile` action | Cold rebuild; no per-stream optimized path |

### Candidates to adopt (concrete value)

Five primitives that map cleanly to existing or near-future Exarchos needs.

#### C-1: Idempotency keys at the append layer (CONFIRMS DECISION)

**Marten model:** Tombstone events for failed transactions; idempotency-key uniqueness enforced at storage.
**Exarchos status:** Already in #1259's design (`UNIQUE INDEX (idempotency_key)`) and tracked under issue #1303.
**Lesson:** Marten validates the choice. The audit finding S-2 → issue #1303 stands.

#### C-2: `FetchForWriting` as a first-class primitive

**Marten model:** `session.Events.FetchForWriting<Order>(orderId)` returns a stream wrapper carrying the aggregate, version, and an `AppendOne(event)` method. SaveChanges commits with optimistic concurrency. The pattern is so common Marten centralizes it.
**Exarchos status:** Composer handlers (`merge-orchestrate.ts`, `dispatch-guard.ts`, etc.) do this informally — read state, decide, append events, write. No primitive. Each handler reimplements the load/decide/append/save loop with subtle variations.
**Why adopt:** Three concrete benefits.
1. **Optimistic concurrency on event appends becomes structural.** Today, `eventStore.append` doesn't take `expectedSequence` consistently (audit finding S-1 → #1303). A `FetchForWriting`-style primitive bakes the version capture into the read path.
2. **Idempotency-key construction becomes uniform.** The primitive owns the prefix.
3. **Post-#1284 EventSourcedTaskStore alignment.** When TaskStore becomes a projection, the natural API for a handler that needs to "decide based on task state" is `fetchForWriting('task-store', taskId)`.

**Recommendation:** Add `eventStore.fetchForWriting<TState>(stream, reducerId)` to the post-#1259 `AtomicAppender` interface. Returns `{ aggregate, version, append(event), commit() }`. Handlers that follow the load/decide/append shape migrate to this in v2.11.

**Sketch:**
```ts
const session = await eventStore.fetchForWriting<MergeOrchestratorState>(
  featureId,
  'merge-orchestrator@v1',
);
// session.aggregate is the projection result, fully derived
// session.version is the stream tail at fetch time
if (session.aggregate.phase === 'completed') return existingResult;
session.append({ type: 'merge.preflight', data: { ... } });
session.append({ type: 'merge.executed', data: { ... } });
await session.commit(); // OCC: rejects if stream advanced since fetch
```

#### C-3: Causation / correlation IDs as opt-in event metadata

**Marten model:** `MetadataConfig.CausationIdEnabled = true` + `MetadataConfig.CorrelationIdEnabled = true` adds typed columns; values flow automatically from active OpenTelemetry spans.
**Exarchos status:** v2.10 has #1291 ("dispatch-boundary operationId — uuid threaded through every event from a single call") which is structurally identical. Marten validates the design.
**Lesson:** Adopt Marten's three-field shape: `operationId` (Marten: causation_id), `correlationId` (Marten: correlation_id), `causationId` (parent operation that produced this one). The third one is the most subtle but most useful — it lets a tool reconstruct *why* a given event was emitted (e.g. `merge.preflight` was caused by `task.completed` was caused by `task.assigned`).

**Recommendation:** Extend #1291's scope to declare all three fields explicitly. Make them opt-in at the storage layer (typed columns; not in the JSON payload). Wire them through `DispatchContext` so handlers don't manually pass them.

**Why over the inbound JSON-payload form:** Typed columns are queryable. "Show me all events caused by operation X" becomes `SELECT * FROM events WHERE causation_id = X` — useful for debugging, useful for v2.12 `ps` / `describe` verbs.

#### C-4: Subscriptions as a separate first-class concept from projections

**Marten model:** `ISubscription.ProcessEventsAsync(page, controller, operations, cancellationToken)`. Same async daemon machinery as projections, but the contract is "do something with events" rather than "fold events into state." Subscriptions can filter by event type or stream type at registration; can `SubscribeFromPresent` / `SubscribeFromSequence` / `SubscribeFromTime`; can publish to external systems with transactional outbox semantics via `IChangeListener`.
**Exarchos status:** No equivalent. Today, "side effects from events" are bolted onto handlers (e.g. `next-actions-computer` reads projection, but emission of events to external systems would have to be hand-wired). The runtime conflates "build a view" and "react to events" into the same handler-emit pattern.
**Why adopt:** Three forward-looking use cases:
1. **v2.12 `ps` / `wait` / `describe`** — these are conceptually subscribers over the event log. Today they'd have to query the events table on every poll. A subscription primitive lets them register interest once and receive batches.
2. **v3.0 SDK / authoring tier** — user-defined workflows may want to emit notifications, post to webhooks, integrate with external CI/CD. Subscriptions are the natural extension point.
3. **v3.1 Basileus federation** — the cross-product event flow (Exarchos → Basileus ontology) is structurally a subscription. Today this would be ad-hoc; with a subscription primitive, it's first-class.

**Recommendation:** Design a `Subscription` interface that mirrors Marten's shape but is dispatched synchronously per append (not via async daemon — we have no daemon). Single-process scope. Filter by event-type/stream-type at registration. The composite-tool registration pattern is the natural site.

**Caveat:** The async-daemon machinery is wrong-shape for us (see W-1). What we want is the *separation of concerns* (projection ≠ subscription) and the *registration shape* (filter + handler), not the async dispatch model.

#### C-5: Stream-type markers as an optimization hook

**Marten model:** `StartStream<Quest>(events)` records the aggregate type on the stream row. `UseMandatoryStreamTypeDeclaration = true` forces every stream to declare its type; this enables optimized projection rebuilds and event filtering on async projections.
**Exarchos status:** Streams are namespaced post-#1259 (`<feature-id>/<subagent-id>`) but the *workflow type* (feature / oneshot / debug / refactor / discovery) isn't recorded on the stream itself. The HSM topology registry holds the mapping, but it's a runtime lookup.
**Why adopt:** Three concrete optimizations:
1. **Projection rebuilds can filter to relevant streams.** A `feature`-workflow projection doesn't need to fold `oneshot` events. Today, `reconcile` walks all events for a stream; per-stream-type filtering would let projections skip irrelevant streams entirely.
2. **v2.12 `ps` filter** — `exarchos_view({action: 'ps', workflowType: 'feature'})` becomes a single indexed query.
3. **Forward-compat with v3.0 SDK** — when SDK-defined workflows produce arbitrary new types, the stream-type marker becomes the join key between SDK metadata and the event store.

**Recommendation:** Add `workflow_type` as a column on the SQLite `streams` table (post-#1259's namespacing). Set at workflow init time; immutable thereafter. Index on it. Make it mandatory — workflow.init declares the type, the dispatch core enforces it. Mirrors Marten's `UseMandatoryStreamTypeDeclaration = true`.

### Wrong-shape (do not adopt)

Five Marten primitives that solve problems we don't have.

#### W-1: Async daemon as a separate runtime process

**Marten model:** Background hosted service (`AddAsyncDaemon(DaemonMode.HotCold)`) that polls the events table, processes pages, advances the high-water mark, runs projections eventually-consistently.
**Why wrong-shape:** Exarchos has no long-running host. The runtime is invoked per-MCP-call and exits; agents start fresh sessions; CLI invocations are one-shot. There's nowhere for an async daemon to live. The synchronous-projection model fits our runtime topology; eventual consistency would require an architecture rewrite for no benefit at single-machine scale.
**Counter-consideration:** v3.2's "long-running headless daemon" (#1263 self-healing shepherd) is the closest analog. If that lands, async projections become viable. Until then, defer.

#### W-2: Multi-tenancy

**Marten model:** Per-tenant databases (or schemas, or partitions) with full isolation; tenant ID baked into every query.
**Why wrong-shape:** Single-user-per-machine framing. Multi-tenancy adds complexity (tenant resolution at every dispatch, per-tenant migration, per-tenant connection pooling) for zero benefit. If Basileus ever needs multi-tenancy, that's a Basileus concern (per the strategic framing memo); Exarchos's basileus-forward stance just means the storage backend is transport-agnostic, not multi-tenant-aware.

#### W-3: Hot/cold partitioning

**Marten model:** PostgreSQL native table partitioning splits archived events into a separate physical table; query planner skips the cold partition by default.
**Why wrong-shape:** SQLite doesn't support native partitioning; our typical workflow count is <50; pruning rather than partitioning is the right tool at our scale. The pruner already handles staleness.
**Counter-consideration:** If event volume ever explodes (e.g. v3.0 SDK enables high-volume workflows), revisit. For now, the pruner is the right tool.

#### W-4: Live aggregation as primary read path

**Marten model:** `AggregateStreamAsync<Invoice>(streamId)` reads all events and folds them on every read. No persisted view.
**Why wrong-shape:** We've already decided projections are caches over events (RT-1). Live aggregation is what `reconcile` does on demand; we don't want it on every read. Our `next-actions-computer` would be unusably slow if it folded the entire workflow event stream on every dispatch.
**Counter-consideration:** Live aggregation is useful as a *debugging* primitive — "show me what state X would be at sequence Y." Maybe a `view --live` flag in v2.12. Low priority.

#### W-5: Blue/green projection versioning with `ProjectionVersion`

**Marten model:** Increment `ProjectionVersion` → projection writes to a new table; old + new run in parallel; switch traffic when caught up.
**Why wrong-shape:** No deployments-with-traffic-switching. Each MCP server start is a fresh process; projections rebuild from events. Our migration story (#1259's `_meta.deprecation` envelope, schema versions) is appropriate to our deployment topology.

## What Marten validates

Three Exarchos design choices that Marten's published patterns affirm:

1. **Events as authority, projections as cache.** Marten's entire pitch is event sourcing, and its projection model treats projections as derivable. Our INV-1 holds.
2. **Optimistic concurrency at the append layer.** Marten's `AppendOptimistic` and our planned `expectedSequence` (#1303) are structurally identical. The choice is the same on a single machine as it is on PostgreSQL.
3. **Composite tools / namespace collapse.** Marten's API is large but namespaced (`session.Events.X`, `session.Documents.X`). Same instinct as our `exarchos_event` / `exarchos_workflow` composite-tool pattern.

## What Marten doesn't help with

Three concerns the audit raised that Marten has no opinion on:

1. **Cooperative agents.** Marten assumes a single hosting process; cooperation between concurrent agents is out of scope. Our handshake-authoritative capability resolution + posture system is novel.
2. **HSM / phase guards.** Marten has no notion of workflow state machines; that's all on Wolverine (its sibling library) or external state machines like Stateless. Our HSM topology is doing work Marten would push to a separate layer.
3. **Local recovery primitives** (`git --abort`, `reset --keep`). Domain-specific to a git-based runtime. Marten is general-purpose.

## Recommendations (prioritized)

### R-1 (P1, FORWARD-COMPAT): Make stream-type markers mandatory

**Driver:** C-5. Cheap to add now (workflow type already exists at init). Pays off in v2.12 (`ps` filtering), v3.0 (SDK), and projection rebuild optimization.

**Steps:**
1. Add `workflow_type` column to the SQLite `streams` table in #1259's schema.
2. `workflow.init` writes the type; immutable thereafter (enforced by trigger or handler discipline).
3. Index on `(workflow_type, status)` for v2.12 `ps` queries.
4. Mandatory — `init` rejects calls without a declared workflow type.

**Issue to file:** Yes. Sibling to #1259, lands in v2.10.

### R-2 (P1, RUNTIME-SHAPING): Add `fetchForWriting` primitive to the event store

**Driver:** C-2. Formalizes the load/decide/append/save pattern that handlers reimplement. Closes the gap from audit findings S-1 + S-2 by construction (the primitive owns OCC + idempotency).

**Steps:**
1. Design the API on `AtomicAppender`: `fetchForWriting<TState>(stream, reducerId): Promise<Session<TState>>`.
2. Session carries `{ aggregate, version, append, commit }`. Commit fails with `ConcurrencyError` if stream tail advanced.
3. Migrate one handler (suggested: `merge-orchestrate` post-#1304) as the reference implementation. Other handlers migrate opportunistically.
4. Document the pattern in `docs/architecture/runtime.md` §3 (L2 — Event store).

**Issue to file:** Yes. v2.11 (after #1284 lands so the projection-as-aggregate pattern is established).

### R-3 (P1, OBSERVABILITY): Adopt Marten's three-field metadata shape

**Driver:** C-3. Strengthens v2.10 #1291's scope. Causation IDs are the missing piece for "trace why this event happened."

**Steps:**
1. Extend #1291 to declare three fields: `operationId`, `correlationId`, `causationId`.
2. Add as typed columns on the events table (queryable; not in JSON payload).
3. Wire through `DispatchContext` — handlers don't pass these manually.
4. Default-population from the dispatch boundary: `operationId` = new UUID per dispatch; `correlationId` = inherited from parent if set; `causationId` = the event sequence that triggered this dispatch (if any).

**Issue to file:** Update #1291 with extended scope; or open a sibling issue if scope expansion is too large.

### R-4 (P2, EXTENSIBILITY): First-class subscription primitive

**Driver:** C-4. Forward-looking — pays off in v2.12, v3.0, v3.1. No urgent gap today.

**Steps:**
1. Design a `Subscription` interface: `{ id, eventTypes?, streamTypes?, handle(event, ctx) }`.
2. Register subscriptions at lifecycle init via `DispatchContext`.
3. Synchronous dispatch: every successful `append` notifies matching subscriptions before returning the AppendResult.
4. First consumer: v2.12 `wait` verb registers a subscription on the target stream + phase; resolves when the predicate matches.

**Issue to file:** Yes, but flag as gated on v2.12 design. Prefer to design `wait` first and let its needs shape the subscription primitive.

### R-5 (P3, FUTURE): Tombstone events for failed appends

**Driver:** Not on a current path; relevant when async projections land (v3.2+).

**Steps (deferred):**
1. When an append fails after sequence allocation, write a tombstone row at the failed sequence.
2. Reducers and projections skip tombstones during folds.
3. Async daemon high-water mark advances past tombstones without stalling.

**Issue to file:** Not now. Memory-only; revisit when async projections become a real surface.

## What we should NOT take from Marten

To make the no-list explicit so future designers don't drift:

| Marten primitive | Why we say no |
|---|---|
| Async daemon | No long-running host; fresh-process model |
| Multi-tenancy | Single user per machine |
| Hot/cold partitioning | SQLite doesn't support it; pruning suffices at our scale |
| Live aggregation as primary | Cached projections are correct; live is debug-only |
| Blue/green projection versioning | No traffic-switching deployments |
| Type-name auto-mapping with tolerant deserialization | Our event types are explicit Zod schemas; type-name evolution handled by registered output schemas + `_meta.deprecation` |
| Aggregate auto-discovery via reflection | TypeScript + Zod gives us static types; reflection isn't necessary |
| Event upcasters as runtime transformers | Schema versioning via `SCHEMA_VERSION` bumps + tolerant deserialization (Marten-like, but pre-deserialization at the storage layer) is sufficient |

The "wrong-shape" list isn't because those primitives are bad — it's because they solve problems that don't exist on a single machine with cooperative agents.

## The minimum-viable adoption set

If only one piece lands: **R-1 (mandatory stream-type markers)**. Cheapest, highest forward-compat leverage.

If two: **R-1 + R-2 (`fetchForWriting`)**. Together they make the post-#1259 substrate genuinely first-class — the primitive every command handler should use.

If three: **R-1 + R-2 + R-3 (causation IDs)**. Closes the observability gap that v2.10 #1291 starts.

R-4 (subscriptions) and R-5 (tombstones) are forward-looking; defer to v2.12+ when their consumers exist.

## Verdict

The concern is well-founded but bounded. Exarchos's event store post-#1259 is appropriately simple for its context — most of Marten's complexity solves problems we don't have. But there are three concrete primitives (mandatory stream-type markers, `fetchForWriting`, three-field metadata) that Marten has crystallized and that close real gaps in our design without dragging in framework that doesn't fit. Two more (subscriptions, tombstones) become relevant in v2.12+ but aren't urgent.

Adopt R-1 through R-3 in v2.10/v2.11. Defer R-4 to v2.12 design. Defer R-5 indefinitely.

The framing — *single-machine event-sourced process manager with cooperative agents* — survives intact. Marten doesn't change the framing; it sharpens five primitives within it.

## Sources

### Marten
- [Marten as Event Store](https://martendb.io/events/) — overview
- [Marten LLM full docs](https://martendb.io/llms-full.txt) — 1MB digest covering 100+ topics; sections inspected: Appending Events, Event Metadata, Event Subscriptions, Events Versioning, Optimistic Concurrency, Multi-Stream Projections, Inline Projections, Live Aggregation, Archiving, CQRS Command Handler Workflow (FetchForWriting), Rebuilding Projections, Resiliency Policies, Tombstone Events, Hot/Cold Partitioning
- [`temporal-pause-resume-compensate`](https://github.com/temporalio/temporal-pause-resume-compensate) — adjacent reference (Temporal SAGA)
- Oskar Dudycz, [*How to (not) do the events versioning?*](https://event-driven.io/en/how_to_do_event_versioning/)
- Greg Young, [*Versioning in an Event Sourced System*](https://leanpub.com/esversioning/read)

### Internal
- [`docs/architecture/runtime.md`](../architecture/runtime.md) — canonical runtime architecture (the framing this report tests against)
- [`docs/designs/archive/2026-05-08-durable-event-store-substrate.md`](../designs/archive/2026-05-08-durable-event-store-substrate.md) — #1259 v2.10 substrate spike
- [`docs/research/2026-05-08-1119-merge-orchestrator-audit.md`](2026-05-08-1119-merge-orchestrator-audit.md) — RT-1..RT-6 runtime guarantees source

### Issues referenced
- #1109 cross-cutting invariants
- #1259 durable event-store substrate
- #1284 EventSourcedTaskStore (precedent for projection pattern)
- #1287 outputSchema migration
- #1291 dispatch-boundary operationId (R-3 extends this)
- #1303 idempotency keys (audit follow-up; C-1 confirms)
- #1304 mergeOrchestrator as projection (audit follow-up; primary `fetchForWriting` consumer per R-2)
