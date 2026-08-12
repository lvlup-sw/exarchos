---
title: v2.10.0-preview.2 implementation audit — findings
status: final
date: 2026-05-10
discover_workflow: scoped
handoff: docs/research/2026-05-10-v2-10-pre2-implementation-audit-handoff.md
related_design: docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md
related_plan: docs/plans/2026-05-10-v2-10-0-preview-2-marten-primitives.md
invariants_applied: [INV-1, INV-5b]
dimensions_applied: [DIM-1, DIM-3, DIM-7]
verdict: proceed-with-revisions
---

# v2.10.0-preview.2 Implementation Audit — Findings

## Executive Verdict

**`proceed-with-revisions`.** The R-2 primitive design is structurally correct: OCC via `BEGIN IMMEDIATE` plus strict PK `INSERT` is well-grounded, WAL is already on, the `ConcurrencyError` envelope is INV-5b-compliant, and the Marten-faithful "no internal retry" posture matches every production framework we surveyed. But three concrete gaps must close before Wave 3/4 lands:

**Headline finding:** Wave 4's hypothetical migration — wrapping a non-idempotent GitHub PR-merge call inside `withSession`'s closure under `withStateRetry` — is the *canonical* process-manager anti-pattern. Every framework we audited (Marten/Wolverine, Akka Persistence Typed, Axon, EventStoreDB) structurally separates the pure "decide" body from the post-commit side effect; none allow non-idempotent side effects in a retried closure. The design ships without that guardrail, the plan inherits the gap, and the migration target (`merge-orchestrate.ts:519`) does in fact perform external git/VCS operations adjacent to state persistence. **Fix:** `withSession` MUST document the idempotency contract and Wave 4 MUST migrate to a `merge.requested → merge.executed` two-event split rather than collapsing both into one retried closure.

The remaining two findings are scoped and bounded: a side-effect-coherence gap in the design's per-event idempotency routing (Question 1 / INV-1), and a `storage_busy` propagation gap in the retry layer (Question 2). Neither blocks the bundle; both must land in Wave 3 to avoid silent regressions.

### CI gate coverage (added 2026-05-12, marten-followups Wave C)

Two `scripts/check-*.sh` grep gates wired into `.github/workflows/ci.yml` (job: `grep-gates`) enforce the substrate-correctness invariants this audit surfaced:

| Gate | Issue | Audit finding | Script |
|---|---|---|---|
| `withSession` idempotency contract | #1342 P1.D | F1.1 (mitigated) | `scripts/check-withsession-idempotency.sh` |
| `BEGIN IMMEDIATE` substrate-only | #1342 P1.E | layering invariant (preventive) | `scripts/check-begin-immediate-substrate.sh` |

Both gates run pre-test (~5s combined), respect `.gitignore`, and feed the blocking `ci-gate` aggregator. They prevent regression on the contracts the audit identified but did not (and could not, statically) close at the type-system layer.

---

## Question 1 — `withSession` retry + non-idempotent side effects

**Verdict:** `needs-runtime-constraint` (contract-level) + `needs-design-revision` (Wave 4 migration shape).

The substrate's OCC is correct. The design's `withSession` contract, however, ships *implicit* permission for non-idempotent side effects inside the closure — by allowing arbitrary `await` work between `session.aggregate` access and commit, and by composing under a `withStateRetry` middleware that re-enters the closure on `ConcurrencyError`. The handoff's hypothetical merge-orchestrate snippet is a faithful application of that contract; if it ships, retry storms re-fire the GitHub merge API and lose the canonical `prMeta` between attempts.

This is *the* canonical event-sourcing process-manager problem (Helland 2016; Reynhout 2020 guideline #11; Greg Young 2020). Every framework that lets you write code inside a retry boundary handles it by structurally banning side effects from that boundary — they live on the *other side* of the commit, either in a post-commit hook (Akka), an outbox dispatcher (Wolverine), or a dedicated saga/process-manager handler subscribed to the persisted event (Axon, EventStoreDB).

### Findings

**F1.1 — HIGH — `withSession` closure permits non-idempotent side effects without contract.**
*Status (2026-05-12):* **Mitigated by CI grep gate.** `scripts/check-withsession-idempotency.sh` (#1342 P1.D, Wave C) fails CI when any production `.withSession({...})` call site is missing both `operationId` and `allowNonIdempotent: true`. Wired into `.github/workflows/ci.yml` as the `grep-gates` job; runs ~5s pre-test and feeds the blocking `ci-gate` aggregator.
*Location:* design §"R-2 / `withSession` — imperative escape hatch" (lines 252–276); plan Task 3.8 (`servers/exarchos-mcp/src/event-store/with-session.test.ts`).
The session contract carries `aggregate`, `version`, and `append(event)`. Nothing in the design forbids arbitrary I/O between `aggregate` access and `fn` resolve. Composing under `withStateRetry` (state-retry.ts:34) re-enters the closure on `ConcurrencyError`, re-firing every side effect.
*Source:* Akka Persistence Typed *Effect.thenRun semantics* (Akka docs: "Side effects are not run when the actor is restarted… any side effects are executed on an at-most-once basis"); Wolverine *Aggregate Handler Workflow* (handler returns events/messages; outbox holds outbound until commit); Reynhout, *16 practical guidelines for ES* §11.
*Recommended fix:* (a) Add a runtime-enforced "no side-effects inside closure" assertion in `withSession` — e.g., a `session.requireIdempotent()` opt-in for callers that genuinely need imperative form, and a documented contract that callers MUST either supply an `operationId` or prove the closure pure. (b) Document a `decide`-first preferred path; `withSession` is the escape hatch, not the default.

**F1.2 — HIGH — Wave 4 migration shape (PR API inside `withSession`) is the textbook anti-pattern.**
*Status (2026-05-12):* **Mitigated.** Wave 4 of v2.10.0-preview.2 shipped the canonical `merge.requested → merge.executed` split for `merge-orchestrate.ts`. The marten-followups Wave B (#1342 P1.B) rolled the same pattern to the remaining five non-idempotent handlers — all branches merged into `feature/wave-b-two-event-split`: `create_pr`, `add_pr_comment`, `create_issue`, `delete-feature-branches`, `cleanup-worktrees`. Each handler's `*.requested` event carries the full intent payload (audit requirement INV-1 LOW); each handler runs an idempotent precheck before invoking the side effect (audit requirement INV-1 MEDIUM). Reference catalog with idempotent-check shapes: `docs/architecture/runtime.md` §4 "Process-manager handlers (two-event split)".
*Location:* design §"Reference Migration Scope" table row `merge-orchestrate.ts:519`; plan Task 4.2 GREEN step.
The design literally proposes `withStateRetry(() => withSession(... async session => { ...PR API call...; session.append(...) }))`. On `ConcurrencyError` from the inner OCC, the wrapper retries — calling the PR merge API again against a (now) already-merged PR. GitHub returns 405 the second time and the captured `prMeta` carries the wrong data (or is lost entirely).
*Source:* Microsoft Azure Architecture Center, *Saga distributed transactions pattern* — "Pivot transactions serve as the point of no return… After a pivot transaction succeeds, compensable transactions are no longer relevant." The GitHub merge IS a pivot transaction; it can't be inside a retry boundary.
*Recommended fix:* Adopt the two-event split. Wave 4 emits `merge.requested` from the decide-closure (pure, retryable), and a separate handler — triggered by `merge.requested` — performs the GitHub merge call with its own `operationId`-keyed idempotency, then appends `merge.executed` (or `merge.failed` with compensation). See "Recommended migration shape" below for the concrete sketch.

**F1.3 — HIGH — Per-event idempotency-key routing (design §"Idempotency-key derivation") breaks single-decision atomicity.**
*Location:* design lines 290–298 — "Routes through `appender.append(streamId, [event], idemKey)` per event, in order, under the per-stream lock."
This contradicts the same design's prior statement (line 244) that non-empty events are committed via `appendComputed` (one transaction). Per-event routing means N events from one `decide` call land as N separate `BEGIN IMMEDIATE` transactions. A crash between transactions leaves the stream with a partial event sequence; projection folds see inconsistent state. The `idempotency_claims` table already supports multi-event claims (eventIds/sequences/timestamps are stored as JSON arrays — sqlite-backend.ts:111-120), so the right shape is one claim per `operationId` covering all events from that decision.
*Source:* INV-1 §"Stores-as-projections rule" + Azure *Event Sourcing pattern* ("the event store is the permanent source of information"); the existing substrate's `atomicAppend` already commits multiple events under one idempotency claim in one transaction (atomic-appender.ts:443-466).
*Recommended fix:* Resolve the contradiction in favor of single-transaction commit. The idempotency-key derivation becomes `${streamId}:${reducerId}:${operationId}` (no per-event suffix); routes through `appendComputed(streamId, idemKey, () => events)` once. Remove the per-event paragraph from the design.

**F1.4 — MEDIUM — `withStateRetry` re-entry is unbounded with respect to side-effect duplication.**
*Location:* state-retry.ts:21 (`MAX_STATE_RETRIES = 3`); plan Task 4.1 extends to recognize `ConcurrencyError`.
Even with the design revised (F1.2), the *general* `withSession` contract still re-runs the closure up to 3 times. Without F1.1's runtime guard, a future caller can inadvertently put a non-idempotent operation in the closure and the test suite won't catch it (race conditions are notoriously hard to test). The Marten posture (no internal retry) places retry responsibility at a *bounded* outer layer; we match that, but the outer layer must enforce idempotency contracts or the bound doesn't help.
*Source:* Greg Young, *Why Event Sourced Systems Fail* §"retry traps"; Pat Helland, *Life Beyond Distributed Transactions* — at-least-once requires idempotency at every layer that can replay.
*Recommended fix:* Add a per-call assertion in `withSession` that the caller has either declared idempotency via `operationId` or explicitly opted out via `session.allowNonIdempotent: true` (documented escape hatch with comment-required justification). This is a documentation/runtime hybrid — the runtime check is cheap and the test asserts the failure mode.

### Recommended migration shape for merge-orchestrate

**Adopt option (a) from the handoff: decide-then-execute via a two-event split.** This is the Wolverine/Marten outbox shape, the Akka `thenRun` shape, and the Axon saga shape — all four production frameworks converge on this answer.

Concrete shape (Wave 4 replacement for the design's hypothetical):

```ts
// merge-orchestrate.ts:519 — committer (decide closure stays pure)
await withStateRetry(() =>
  store.decide<MergeState>(featureId, 'merge-orchestrator@v1', (state, ctx) => {
    if (state.phase === 'completed') return []; // idempotent on retry: state-checked
    return [{
      type: 'merge.requested',
      data: { prNumber: state.prNumber, requestedBy: ctx.requestedBy },
      correlationId: ctx.operationId,
    }];
  }, { operationId: ctx.operationId })
);

// merge.requested subscription (NEW file: orchestrate/execute-merge-on-request.ts)
// Triggered by the merge.requested event. Performs the PR API call with its own
// idempotency budget; appends merge.executed (or merge.failed) on completion.
on('merge.requested', async event => {
  const prMeta = await callGitHubPRMergeAPI(event.data.prNumber); // owns its own retry/idempotency
  await store.withSession<MergeState>(event.streamId, 'merge-orchestrator@v1', async session => {
    session.append({ type: 'merge.executed', data: { prMeta }, causationId: event.eventId });
  }, { operationId: `merge-executed:${event.eventId}` });
});
```

The PR API call sits *outside* any retry-loop closure. Its own idempotency is the responsibility of GitHub's 405-on-already-merged response plus our own `merge.executed`-already-emitted check (the reducer's `state.phase === 'executed'` short-circuit). The decide-closure that records `merge.executed` only writes the event; it doesn't re-fire the API. Cross-framework, this is canonical.

**Caveat for v2.10-preview.2:** The plan's Wave 4 doesn't include a "subscription" or "event-driven follow-up handler" — those are deferred to R-4 (design's "Out of Scope" §"R-4 subscriptions"). Without R-4, the two-event split has nowhere to live. **Recommendation:** carve a minimal in-process callback site for `merge.requested → merge.executed` inside the existing `merge-orchestrate.ts` flow as a *sequential* call (read state → emit `merge.requested` → call API → emit `merge.executed`) WITHOUT a retry boundary around the API call. Each `decide` is its own bounded retry; the API call is between them, fired once, and idempotency is sourced from GitHub's semantics + the reducer's phase-check. This avoids needing R-4 today while still landing the correct shape.

### Cross-framework comparison

| Framework | Decide ↔ side-effect separation | What is *enforced* (runtime) | What is *documented* (developer discipline) |
|---|---|---|---|
| **Marten + Wolverine** | Handler returns `IEnumerable<object>` (events + outbound messages). Wolverine middleware wraps `FetchForWriting` + `SaveChangesAsync`. Outbound messages go through Marten's outbox table — committed in the same transaction as events. | The outbox is structural: outbound messages cannot be dispatched until the transaction commits. `ConcurrencyException` triggers `OnException<ConcurrencyException>().RetryWithCooldown(...)` middleware; the handler re-runs but produces idempotent outbound (events + outbox rows). | "Use the outbox; don't call `SaveChangesAsync()` yourself" (Wolverine docs §"Transactional Middleware"). |
| **Akka Persistence Typed** | Command handler returns `Effect` (description of events + thenRun side effects). `Effect.persist(events).thenRun(state => sideEffect())` — `thenRun` fires AFTER persistence, exactly once, NOT on recovery. | Structural: side effects are passed as continuations bound to the post-persist callback. Cannot be placed in the event handler (which is replayed). "At-most-once" guarantee. | Akka docs explicitly call out: "Side effects are not run when the actor is restarted or started again after being stopped." |
| **Axon Framework** | `@CommandHandler` produces events. `@SagaEventHandler` reacts to events to coordinate process managers; non-idempotent operations live in saga handlers with compensating actions. | Saga state is persisted; handlers are dispatched at-least-once with retry middleware (`@MessageHandlerInterceptor`); compensating actions are explicit. | "Saga events are at-least-once; handlers must be idempotent or perform compensation." |
| **EventStoreDB / Kurrent** | Append with `expectedRevision`. On `WrongExpectedVersionException`: caller catches, re-loads, re-decides. No internal retry. Process managers are separate consumers subscribed to streams. | Optimistic concurrency only — no built-in retry, no outbox. The client treats `WrongExpectedVersion` as a terminal exception. | Caller MUST be idempotent on retry; process managers MUST be idempotent on at-least-once delivery. Documented in the gRPC client guide and EventStoreDB best-practices. |

**Convergent enforcement:** All four frameworks structurally place non-idempotent side effects OUTSIDE the retry boundary. None ship a `withSession`-style imperative escape hatch without either an outbox (Wolverine), a post-commit hook (Akka), or a saga handler (Axon, EventStoreDB). Our design's `withSession` is the *only* one of the five surveyed that allows arbitrary I/O inside the retried closure — that's the gap to close.

---

## Question 2 — Cross-process race over `BEGIN IMMEDIATE` + SQLITE_BUSY

**Verdict:** `safe-as-designed` for sequence correctness (no silent miscommits), `needs-pragma-change` for the `busy_timeout` safety net, and `needs-design-revision` for `storage_busy` propagation through the new primitives.

The cross-process race that concerned the handoff *is* correctly handled by the existing substrate. WAL mode is already on (sqlite-backend.ts:346). Snapshot isolation guarantees that a reader sees a consistent point-in-time view (SQLite WAL docs: "the end mark is unchanged for the duration of the transaction… each reader can potentially have its own end mark"). The OCC check fires either pre-transaction (atomic-appender.ts:411-424) OR via the strict-INSERT collision inside `BEGIN IMMEDIATE` (translateAtomicAppendError, atomic-appender.ts:579-597). Both routes surface as `sequence-conflict` with a fresh `actual` re-read (T64 fix at line 510-532). **There is no path to a silent incorrect commit.**

However, two operational gaps remain.

### Findings

**F2.1 — MEDIUM — `storage_busy` AppendResult is not threaded through `decide`/`withSession` to `withStateRetry`.**
*Location:* atomic-appender.ts:479 returns `{ ok: false, reason: 'storage_busy', cause: err }`; plan Task 3.5 only translates `sequence-conflict → ConcurrencyError`; plan Task 4.1 only adds `ConcurrencyError` recognition to `withStateRetry`. The `storage_busy` reason is silently dropped — the decide primitive presumably returns it to the caller (or throws), and `withStateRetry` (which catches `VersionConflictError` only, state-retry.ts:39) does not retry it.
*Source:* DR-12 (sqlite-backend.ts:158-172) calls `storage_busy` "a contention signal, not a logical error"; SQLite *File Locking* doc explicitly lists `SQLITE_BUSY` as a transient contention signal that callers SHOULD retry. INV-5b acceptance Q2 requires `validTargets` to drive retry — `STORAGE_BUSY` needs the same envelope.
*Recommended fix:* (a) Define a typed `StorageBusyError extends Error` (sibling to `ConcurrencyError`). (b) `decide`/`withSession` translate `AppendResult { reason: 'storage_busy' }` to `throw new StorageBusyError(...)`. (c) `withStateRetry` catches both `ConcurrencyError` AND `StorageBusyError` and retries; the existing exponential-backoff matches (50ms × 2^attempt, jitter) — appropriate for transient contention. (d) `formatError` maps `StorageBusyError` to `STORAGE_BUSY` envelope code with `validTargets: ['retry']`, `_meta.retryable: true`.

**F2.2 — LOW — `busy_timeout` is intentionally 0; safety net absent if JS retry budget exhausts under unexpected contention.**
*Location:* sqlite-backend.ts:158-172 — DR-12 routes BUSY recovery through JS layer ONLY (4 inter-attempt sleeps totalling ~75ms).
This is fine for single-process and low-concurrency cross-process scenarios. It does NOT fit the production-recommendation envelope (busy_timeout = 5000ms is the canonical default in better-sqlite3 production guides; see Powersync, OneUptime, phiresky). Two MCP server instances both hitting `BEGIN IMMEDIATE` against the same DB could exhaust 75ms easily. The JS layer DOES emit observability for each retry — but `busy_timeout` at the C layer is a cheap belt-and-suspenders that doesn't conflict (the JS retry kicks in only AFTER `busy_timeout` exhausts at the C layer, so total budget becomes ~5s instead of 75ms).
*Source:* SQLite *PRAGMA busy_timeout* docs; better-sqlite3 production-setup guides (oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view).
*Recommended fix:* Set `PRAGMA busy_timeout = 5000` in `applyConnectionPragmas` (sqlite-backend.ts:345-349). This is non-breaking — current JS retry stays as is; `busy_timeout` just gives SQLite a 5s window to resolve contention before throwing. If the JS layer reports zero retries, you know `busy_timeout` did its job; if it reports retries, the JS layer is genuinely the last line of defense. **Caveat:** Bert Hubert's article ("What to do about SQLITE_BUSY errors despite setting a timeout") notes that `busy_timeout` doesn't help when a connection holds a lock indefinitely — but our `BEGIN IMMEDIATE` is bounded to one append call, so this caveat doesn't apply.

**F2.3 — LOW — `aggregateStream` read is not snapshot-stable across multiple internal queries.**
*Location:* design §"`aggregateStream` — read-only" (lines 280–286); plan Task 3.11.
The design says `aggregateStream` "Reads events for `streamId`, folds via reducer, returns folded state + tail version." Under the hood this is `backend.readEvents(streamId)` (one query) → fold in JS → done. In WAL mode each implicit-transaction SELECT gets its own snapshot. If `aggregateStream` ever grows to do TWO queries (e.g., events + snapshot lookup, which `readProjection` already does in `projections/store.ts`), they could observe different snapshots — the events snapshot is point T, the snapshot-row snapshot is point T+1 with a write between them. The fold would then apply T+1's events on top of T's snapshot, possibly double-counting or missing events depending on which side of the write the snapshot fell.
*Source:* SQLite *Isolation in SQLite* — each transaction sees its own snapshot; without an explicit `BEGIN` wrapping both reads, they're independent transactions. better-sqlite3 docs §"transactions" reinforce this.
*Recommended fix:* When `aggregateStream` (or `readProjection`) does multi-query reads, wrap them in an explicit `BEGIN`/`COMMIT` (or `db.transaction(fn)` from better-sqlite3) to share one snapshot. Today `aggregateStream` is a single SELECT so this is preventive. Add to the Wave 3 task list: any future composite read MUST be transaction-wrapped.

### PRAGMA recommendations

| PRAGMA | Current | Recommended | Source | Rationale |
|---|---|---|---|---|
| `journal_mode` | `WAL` ✓ | `WAL` | SQLite *Write-Ahead Logging*; better-sqlite3 perf guide | Already correct. Snapshot isolation for readers + concurrent writer = our model. |
| `synchronous` | `NORMAL` ✓ | `NORMAL` | better-sqlite3 perf (compile-time `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`) | Already correct. FULL adds fsync-per-commit cost without meaningful durability gain in our single-machine context. |
| `busy_timeout` | `0` (default) | `5000` | SQLite *PRAGMA busy_timeout*; oneuptime/phiresky production guides | **Change recommended** (F2.2). C-layer safety net for cross-process contention before JS retry kicks in. |
| `temp_store` | `default` (FILE) | `MEMORY` | phiresky perf-tuning; oneuptime setup guide | Optional improvement. Temp tables/indices stay in RAM — small wins on complex queries. Low priority. |
| `cache_size` | `default` (-2000, 2MB) | `-64000` (64MB) | better-sqlite3 perf guide; oneuptime | Optional. Hot-page cache improves projection cold-fold latency. Defer until profiling shows a need. |
| `mmap_size` | `268435456` (256MB) ✓ | `268435456` | better-sqlite3 perf guide | Already correct. |
| `wal_autocheckpoint` | `default` (1000 pages) | `1000` | SQLite *WAL* docs | Already correct (default). |
| `foreign_keys` | `default` (OFF) | `ON` | better-sqlite3 perf guide §"safety" | Optional but cheap. No current FK constraints in schema; flipping on is preventive for future migrations. |

**Concrete change for this bundle:** add `PRAGMA busy_timeout = 5000` to `applyConnectionPragmas`. Defer the rest — they're optional improvements, not gaps.

### `SqliteBusyExhaustedError` propagation diagram

```
  SQLite C layer
       │  raises SQLITE_BUSY
       ▼
  SqliteBackend.atomicAppend (sqlite-backend.ts:705)
       │  bounded retry (5 attempts, ~75ms total)
       │  budget exhausted → throw SqliteBusyExhaustedError (sqlite-backend.ts:186)
       ▼
  AtomicAppender.appendSqliteLocked (atomic-appender.ts:478)
       │  catches SqliteBusyExhaustedError
       │  returns AppendResult { ok: false, reason: 'storage_busy', cause }
       ▼
  AtomicAppender.appendComputed / decide / withSession  ← GAP HERE (F2.1)
       │  Design (line 246): only translates 'sequence-conflict' → ConcurrencyError
       │  'storage_busy' falls through as AppendResult or thrown raw error
       ▼
  withStateRetry (state-retry.ts:34)              ← GAP HERE (F2.1)
       │  Only catches VersionConflictError today
       │  Plan Task 4.1 adds ConcurrencyError
       │  storage_busy: not retried, surfaces to caller as terminal failure
       ▼
  wrap() / formatError                            ← GAP HERE (F2.1)
       │  No envelope mapping for STORAGE_BUSY today
       │  Plan Task 3.13 maps ConcurrencyError → CONCURRENCY_CONFLICT envelope only
       ▼
  Caller receives ambiguous error
```

**Required additions** (mapped to plan):
- Wave 3 new task (3.2.5 or 3.14): typed `StorageBusyError` class + `decide`/`withSession` translation of `AppendResult.reason === 'storage_busy'` → throw `StorageBusyError`.
- Wave 3 new task (3.13.5 or extension of 3.13): map `StorageBusyError → STORAGE_BUSY` envelope in `wrap()`/`formatError` with `validTargets: ['retry']`.
- Wave 4 extension to Task 4.1: `withStateRetry` catches both `ConcurrencyError` AND `StorageBusyError`.

### Cross-process race scenarios

**Scenario A — MCP server + CLI invocation hitting the same DB.** Both processes hold the same `exarchos.db`. CLI emits `task.completed` against `feature-X` (sequence 10). MCP server, mid-`decide` against `feature-X` at sequence 9, fires `appendComputed`. Process: MCP's pre-transaction OCC check reads `baseSeq=9` → CLI commits sequence 10 (BEGIN IMMEDIATE, succeeds) → MCP's `BEGIN IMMEDIATE` → strict INSERT on `(feature-X, 10)` collides → SQLITE_CONSTRAINT → translated to `sequence-conflict` with re-read `actual=10` → `withStateRetry` retries → MCP re-folds, re-decides, commits sequence 11. **Outcome: correct. No silent miscommit. Net latency cost: one extra fold.**

**Scenario B — Two MCP server instances if user runs `npx` twice.** Both processes converge on the same DB via lifecycle init. Both call `workflow.init({featureId: 'feat-Y', workflowType: 'feature'})` concurrently. Process: both attempt `INSERT INTO streams` against the same `streamId` — PRIMARY KEY collision in `BEGIN IMMEDIATE` → one wins, one throws `SQLITE_CONSTRAINT`. The R-1 design's `workflow.init` writer must surface this as a structured `WORKFLOW_ALREADY_EXISTS` error (likely already the case via INV-5b — verify in Wave 1 Task 1.3). **Outcome: correct. R-1's `NOT NULL` workflow_type column doesn't change this — the streamId PK does the work.**

**Scenario C — Concurrent `decide` + `decide` on same stream (intra-process).** Wave 3 Task 3.5's race fixture exactly tests this. The first-tier `StreamLockManager.runExclusive` (atomic-appender.ts:172-193) serializes them within one process — second `decide` enters only after first releases its lock. **Outcome: correct. Note:** the existing race fixture in atomic-appender.race.test.ts uses callback-driven injection to simulate the cross-process timing; that pattern carries over to decide.race.test.ts (Wave 3 Task 3.5).

**Scenario D (new) — `storage_busy` budget exhaustion in commit phase.** Process A and Process B both queue many appends against different streams; SQLite write-lock contention exhausts the 75ms JS budget for one of A's appends. Process: A's `appendSqliteLocked` returns `{ ok: false, reason: 'storage_busy' }`. With F2.1 unfixed: caller sees an opaque error envelope, `withStateRetry` doesn't retry, the workflow appears failed. With F2.1 fixed: caller sees `STORAGE_BUSY` envelope, `withStateRetry` retries (within bounded attempts), most cases self-heal. **Outcome (post-fix): correct. Highlights why F2.1 matters operationally.**

---

## Recommendations Mapped to Plan Tasks

| Finding | Map to plan | Specific change | Status (2026-05-12) |
|---|---|---|---|
| F1.1, F1.4 | Wave 3 Task 3.8 (`with-session.test.ts`) | Add test `WithSession_RequiresIdempotencyDeclarationOrExplicitOptOut`. Implementation: `withSession` validates that EITHER `operationId` is supplied OR `opts.allowNonIdempotent === true`. Reject with `INVALID_SESSION_OPTIONS` otherwise. Document in design § "withSession — imperative escape hatch". | **Mitigated** by marten-followups Wave C grep gate `scripts/check-withsession-idempotency.sh` (#1342 P1.D). |
| F1.2 | Wave 4 Task 4.2 (merge-orchestrate migration) — REWRITE | Replace the "PR API call inside withSession" example with the two-event split (`merge.requested → callPRAPI → merge.executed`). Add Task 4.2a: design + ship `merge.requested` event schema in `event-store/schemas.ts`. Add Task 4.2b: integration test `MergeOrchestrate_RequestThenExecute_DoesNotRefireApiOnRetry`. | **Mitigated.** Wave 4 of preview.2 + marten-followups Wave B (`feature/wave-b-two-event-split`) extended the split to all 5 remaining handlers. |
| F1.3 | Design fix (no plan change) | Resolve contradiction at design lines 244 vs 290–298. Remove per-event idempotency-key derivation; commit derives one key per `decide` call: `${streamId}:${reducerId}:${operationId}`. Routes through `appendComputed` once with the full events array. The `idempotency_claims` table already supports this shape — see sqlite-backend.ts:111-120 (events_json is JSON-array). | (carried per original plan; not in marten-followups scope) |
| F2.1 | NEW Wave 3 Tasks 3.2a, 3.13a; Wave 4 Task 4.1 extension | (a) Add `StorageBusyError` class (sibling to `ConcurrencyError`, same RED/GREEN shape as Task 3.1). (b) `decide`/`withSession` translate `reason: 'storage_busy'` → throw `StorageBusyError`. Update Task 3.3 / 3.8 to add this path. (c) Extend Task 3.13 to also map `StorageBusyError` → `STORAGE_BUSY` envelope with `validTargets: ['retry']`, `_meta.retryable: true`. (d) Extend Task 4.1 to catch both error types. | (carried per original plan; not in marten-followups scope) |
| F2.2 | NEW Wave 1 Task 1.8 (or Wave 3 Task 3.2 extension) | Add `PRAGMA busy_timeout = 5000` to `applyConnectionPragmas` (sqlite-backend.ts:345). RED test: assert `PRAGMA busy_timeout` returns 5000 after `initialize()`. GREEN: one-line addition. Non-breaking; cheap insurance. | (carried per original plan; not in marten-followups scope) |
| F2.3 | Wave 3 Task 3.11 documentation | Add a note in `aggregateStream` (and future composite reads) requiring transaction-wrapping for multi-query reads. No code change needed today (single SELECT). | (carried per original plan; not in marten-followups scope) |
| #1342 P1.E | Marten-followups Wave C | Add CI grep gate `scripts/check-begin-immediate-substrate.sh` enforcing the SQLite `BEGIN IMMEDIATE` primitive lives only inside `storage/` and `event-store/`. Wired into the `grep-gates` job in `.github/workflows/ci.yml` on GitHub Actions. | **Done** (Wave C). |
| #1343 | Marten-followups Wave A | PID lock demotion + JSONL→SQLite snapshot migration. Multi-process serialization is now SQLite-WAL-only; `EventStore.initialize()` is a no-op marker. | **Done** (Wave A). |

## Out-of-Budget Signals

The handoff asked to flag findings that don't apply at our scale. Two surveyed sources gave "depends on your deployment" answers worth noting:

- **Jepsen analyses** (Aphyr/Kingsbury) frame concurrency anomalies primarily for distributed systems with network partitions. None of the methodology surfaces a local-single-machine SQLite hazard that our OCC + WAL doesn't already cover. **Not applicable at our scale.**
- **Ben Johnson's Litestream posts** discuss WAL semantics under remote replication and process coordination. We're single-machine local SQLite today; basileus-forward (INV-3) cares about transferability but not multi-writer remote scenarios. **Defer to preview.4+ when remote MCP lands.**

The Marc Brooker blog and SQLite forum threads turned up no concrete BEGIN IMMEDIATE pitfalls beyond what's already documented and addressed by our retry + OCC stack.

---

## Source Bibliography

### Frameworks (Primary)

- **Marten** — `/jasperfx/marten` via context7. Specifically: `FetchForWriting`, `AlwaysEnforceConsistency`, `ConcurrencyException`. URL: <https://martendb.io/scenarios/command_handler_workflow.html>.
- **Wolverine** — *Aggregate Handlers and Event Sourcing* (<https://wolverinefx.net/guide/durability/marten/event-sourcing.html>), *Dealing with Concurrency* (<https://wolverinefx.net/tutorials/concurrency.html>), *Transactional Middleware* (<https://wolverinefx.io/guide/durability/marten/transactional-middleware>), *Marten as Transactional Outbox* (<https://wolverinefx.net/guide/durability/marten/outbox.html>).
- **Jeremy D. Miller (Marten/Wolverine lead)** — *Retry on Errors in Wolverine* (<https://jeremydmiller.com/2025/01/29/retry-on-errors-in-wolverine/>) — documents `OnException<ConcurrencyException>().RetryWithCooldown(...)` middleware pattern.
- **Akka Persistence Typed** — *Persistence* (<https://doc.akka.io/libraries/akka-core/current/typed/persistence.html>) — `Effect.persist().thenRun()` and `thenReply()` semantics; at-most-once side effects.
- **Axon Framework** — Reference guide §"Sagas" and §"Messaging Concepts / Anatomy of a Message Handler" (<https://docs.axoniq.io/reference-guide/v/4.10/axon-framework/saga>).
- **EventStoreDB / Kurrent** — *Appending Events* (<https://docs.kurrent.io/clients/grpc/appending-events.html>, previously developers.eventstore.com).

### Canonical literature

- **Pat Helland**, *Life Beyond Distributed Transactions: An Apostate's Opinion* (ACM Queue 2016, <https://queue.acm.org/detail.cfm?id=3025012>) — process-manager pattern; at-least-once requires idempotency.
- **Greg Young**, *Why Event Sourced Systems Fail* (<https://fwdays.com/en/event/highload-fwdays-2020/review/why-event-sourced-systems-fail>) — retry traps.
- **Vaughn Vernon**, *Implementing Domain-Driven Design* (Addison-Wesley 2013), Ch 13 "Domain Events" §"When and Where to Publish Events" + Ch 14 "Application" §"Transactions".
- **Yves Reynhout**, *16 practical guidelines for event sourcing* (<https://www.continuousimprover.com/2020/06/guidelines-event-sourcing.html>) — guideline #11: non-idempotent side effects + retry traps; design for at-least-once delivery; idempotent handlers; persistent tracking.
- **Microsoft Azure Architecture Center**, *Saga distributed transactions pattern* (<https://learn.microsoft.com/azure/architecture/patterns/saga>) — pivot transactions, compensating transactions, data-anomaly countermeasures (reread values, semantic lock, commutative updates).
- **Microsoft Azure Architecture Center**, *Compensating Transaction pattern* (<https://learn.microsoft.com/azure/architecture/patterns/compensating-transaction>) — explicit compensation design.
- **Microsoft Learn**, *Cloud-native data patterns / Distributed transactions* (<https://learn.microsoft.com/dotnet/architecture/cloud-native/distributed-data>).
- **EventSourcingDB**, *Common Issues / Idempotent handlers* (<https://docs.eventsourcingdb.io/best-practices/common-issues/>) — "Handlers MUST be idempotent"; at-least-once delivery is the floor.

### SQLite + better-sqlite3 (Primary)

- **SQLite**, *Write-Ahead Logging* (<https://www.sqlite.org/wal.html>) — snapshot isolation; end-mark contract; reader-writer concurrency.
- **SQLite**, *BEGIN TRANSACTION* (<https://www.sqlite.org/lang_transaction.html>) — DEFERRED/IMMEDIATE/EXCLUSIVE semantics; one-writer-at-a-time in WAL.
- **SQLite**, *Isolation in SQLite* (<https://www.sqlite.org/isolation.html>) — snapshot guarantees; no dirty reads across processes.
- **SQLite**, *File Locking And Concurrency in SQLite Version 3* (<https://www.sqlite.org/lockingv3.html>) — SHARED/RESERVED/PENDING/EXCLUSIVE lock progression.
- **SQLite**, *PRAGMA Statements* (<https://www.sqlite.org/pragma.html>) — `busy_timeout`, `journal_mode`, `synchronous`, `cache_size`, `temp_store`, `mmap_size`.
- **better-sqlite3**, *Performance considerations* (<https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md>) — WAL trade-offs; `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`.
- **better-sqlite3**, *API: Database#transaction* (<https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function>) — synchronous-transaction semantics.

### SQLite (Secondary — operational/production)

- **OneUptime**, *How to Set Up SQLite for Production Use* (<https://oneuptime.com/blog/post/2026-02-02-sqlite-production-setup/view>) — recommended pragma set; `busy_timeout = 5000`.
- **PowerSync**, *SQLite Optimizations For Ultra High-Performance* (<https://powersync.com/blog/sqlite-optimizations-for-ultra-high-performance>) — cache_size / temp_store guidance.
- **phiresky**, *SQLite performance tuning* (<https://phiresky.github.io/blog/2020/sqlite-performance-tuning/>) — pragma tuning at scale.
- **Bert Hubert**, *What to do about SQLITE_BUSY errors despite setting a timeout* (<https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/>) — `busy_timeout` caveats (long-held connections).
- **DeepWiki**, *better-sqlite3 WAL Mode and Performance Tuning* (<https://deepwiki.com/WiseLibs/better-sqlite3/3.4-wal-mode-and-performance-tuning>).

### Internal (Already-loaded local sources)

- `servers/exarchos-mcp/src/event-store/atomic-appender.ts` — `AtomicAppender`, `StreamLockManager`, `AppendResult` shapes, `translateAtomicAppendError`.
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` — `SqliteBackend`, `atomicAppend`, `applyConnectionPragmas`, `SqliteBusyExhaustedError`, `SQLITE_BUSY_RETRY_POLICY`.
- `servers/exarchos-mcp/src/workflow/state-retry.ts` — `withStateRetry`, `MAX_STATE_RETRIES`, `VersionConflictError` catch.
- `servers/exarchos-mcp/src/verbs/merge/merge-orchestrate.ts:519` — current `withStateRetry` call site (wraps `persistState` only — does NOT currently wrap the executor's git ops; design Wave 4 proposes to expand the boundary).
- `servers/exarchos-mcp/src/verbs/pure/execute-merge.ts:249` — same shape.
- `docs/research/2026-05-08-marten-event-store-lessons.md` §C-2 — R-2 `fetchForWriting` motivation.
- `.claude/skills/design-invariants/references/INV-1-event-sourcing.md` — stores-as-projections rule; severity guide.
- `docs/architecture/runtime.md` §3 — L2 (event store) substrate model.
