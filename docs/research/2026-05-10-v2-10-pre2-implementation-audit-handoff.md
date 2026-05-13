---
title: v2.10.0-preview.2 implementation audit — discovery handoff
status: handoff
date: 2026-05-10
discover_workflow: scoped
related_design: docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md
related_plan: docs/plans/2026-05-10-v2-10-0-preview-2-marten-primitives.md
related_research: docs/research/2026-05-08-marten-event-store-lessons.md
audience: discover workflow (research agent)
---

# Discovery Handoff: v2.10.0-preview.2 Implementation Audit

## Purpose

Targeted pre-delegation audit of two design concerns that surfaced during `/exarchos:ideate` review but were judged design-level rather than implementation-level. The audit should produce **concrete findings with severity + recommended fix**, not a literature review. Cite each finding to the source that establishes the principle being applied.

**NOT in scope:** generic event-sourcing risk inventory. The Marten lessons discovery report (`docs/research/2026-05-08-marten-event-store-lessons.md`) already covers that ground. This audit is two specific questions only.

## Bundle Context (read-only)

- **Design:** `docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md` — defines `decide` / `withSession` / `aggregateStream` primitives with Marten-faithful posture (strict single-stream, no internal retry, caller-supplied `operationId`, `alwaysEnforceConsistency: true` by default).
- **Plan:** `docs/plans/2026-05-10-v2-10-0-preview-2-marten-primitives.md` — 42 tasks across 4 waves. Wave 4 migrates `merge-orchestrate.ts:519` and `execute-merge.ts:249` to `withSession`.
- **Substrate:** `servers/exarchos-mcp/src/event-store/atomic-appender.ts` and `servers/exarchos-mcp/src/storage/sqlite-backend.ts` provide `BEGIN IMMEDIATE` + per-stream `StreamLockManager` + SQLITE_BUSY retry budget.

---

## Question 1: `withSession` retry + non-idempotent side effects ("process manager" problem)

### Concern

Wave 4 migrates merge-orchestrate to:

```ts
await withStateRetry(() =>
  store.withSession<MergeState>(featureId, 'merge-orchestrator@v1', async session => {
    const prMeta = await callGitHubPRMergeAPI(session.aggregate.prNumber);  // ← non-idempotent
    session.append({ type: 'merge.executed', data: { prMeta } });
  })
);
```

If `callGitHubPRMergeAPI` succeeds (PR is merged on GitHub) but the commit phase throws `ConcurrencyError` (another writer advanced the stream tail), `withStateRetry` re-enters the closure. The API call fires **again** against a PR that's already merged. Possible failure modes:

- GitHub returns 405 "Pull request already merged" — recoverable, but the retry's `merge.executed` event carries `prMeta` from the *first* call (lost when the body re-runs) or from the second call (which has a different shape — no merge metadata to capture).
- A different non-idempotent action (closing an issue, sending a Slack notification, deleting a branch) double-fires with no recoverable side-channel.

This is the canonical "process manager" problem in event-sourcing. The design doesn't address it; the plan inherits the gap.

### Sub-questions for the discover workflow

1. **What is the canonical pattern for splitting decide-from-side-effect in `withSession`-style primitives across the major event-sourcing frameworks?** Specifically: how do Marten + Wolverine, Akka Persistence Typed, Axon Framework, and EventStoreDB Client API separate "decide" (pure, retryable) from "side effect" (one-shot, post-commit or pre-commit with compensation)?

2. **Does the design's `withSession` need a runtime constraint forbidding non-idempotent side effects inside the closure, or can it ship with documentation only?** What do the production frameworks enforce vs document?

3. **For our specific merge-orchestrate case:** is the right migration shape (a) `decide`-then-execute (commit `merge.pending` first, then execute PR-merge in a follow-up handler triggered by the event), (b) execute-then-`decide` with idempotency via GitHub's merge-already-done semantics, or (c) `withSession` with explicit "side effects must be idempotent" gate?

### Authoritative sources for grounding

**Primary (frameworks):**
- **Marten** — `/jasperfx/marten` via context7. Specifically search: "FetchForWriting side effects", "Wolverine command middleware retry", "compensating actions". Marten docs source: `https://martendb.io/scenarios/command_handler_workflow.html`
- **Wolverine** (Marten's command bus sibling) — `https://wolverine.netlify.app/` — middleware pipeline for retry vs side effect placement. Search for `[Middleware]`, `IExecutor`, `OnFailedAttempt`.
- **Akka Persistence Typed** — `https://doc.akka.io/docs/akka/current/typed/persistence.html` — specifically `Effect.thenRun()` and `Effect.thenReply()` semantics. Akka's design guarantees side effects fire only after the event is persisted.
- **Axon Framework** — `https://docs.axoniq.io/reference-guide/v/4.10/axon-framework/saga` and `https://docs.axoniq.io/reference-guide/axon-framework/messaging-concepts/anatomy-message-handler` — `@SagaEventHandler` + retry middleware separation.
- **EventStoreDB** — `https://developers.eventstore.com/clients/grpc/appending-events.html` and `https://www.eventstore.com/blog/event-immutability-and-dealing-with-change` — process manager pattern.

**Primary (canonical literature):**
- **Pat Helland**, [*"Life Beyond Distributed Transactions"*](https://queue.acm.org/detail.cfm?id=3025012) (ACM Queue 2016) — the foundational paper on side-effect coordination across transaction boundaries; introduces the "almost-infinite scale" framing that motivates the process-manager pattern.
- **Greg Young**, [*"Why Event Sourced Systems Fail"*](https://fwdays.com/en/event/highload-fwdays-2020/review/why-event-sourced-systems-fail) — section on non-idempotent side effects + retry traps.
- **Vaughn Vernon**, *Implementing Domain-Driven Design* (Addison-Wesley 2013), Ch 13 "Domain Events" §"When and Where to Publish Events" + Ch 14 "Application" §"Transactions" — canonical placement of side effects.
- **Yves Reynhout**, [*"16 practical guidelines for ES"*](https://www.continuousimprover.com/2020/06/guidelines-event-sourcing.html) — guideline #11 specifically addresses non-idempotent side effects.
- **Microsoft Azure Architecture Center**, [*"Saga distributed transactions pattern"*](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga) — orchestration vs choreography; compensating transactions for non-idempotent operations. Use `microsoft-learn` MCP for fetch.
- **Microsoft Azure Architecture Center**, [*"Compensating Transaction pattern"*](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction) — explicit compensation design for partially-completed sequences.

**Secondary (industry practitioners):**
- **Jeremy D. Miller** (Marten lead) — blog posts at `https://jeremydmiller.com/category/marten/` and `https://jeremydmiller.com/category/wolverine/`. Search "side effects" or "outbox".
- **Bertrand Le Roy / Khalid Abuhakmeh** — JetBrains' .NET Annotated newsletters and posts covering Wolverine retry middleware.
- **Mark Seemann**, [*"Outside-in TDD"*](https://blog.ploeh.dk/2010/12/22/TheTDDApostate/) and his event-sourcing posts at `https://blog.ploeh.dk/tags/#Event%20sourcing-ref` — pure-function decide pattern.
- **EventSourcingDB**, [*"Common Issues"*](https://docs.eventsourcingdb.io/best-practices/common-issues/) — "handlers MUST be idempotent" is the floor.

**Already-loaded local sources:**
- `docs/research/2026-05-08-marten-event-store-lessons.md` §C-2 (R-2 fetchForWriting analysis)
- INV-1 reference doc at `.claude/skills/design-invariants/references/INV-1-event-sourcing.md` (cites the Azure pattern doc and Reynhout)

### Output shape for question 1

The discover workflow returns:

1. **Verdict:** one of `safe-as-designed | needs-runtime-constraint | needs-design-revision`.
2. **Findings:** zero or more concrete findings, each with `{severity: HIGH | MEDIUM | LOW, location: <design section or plan task>, description, source_citation, recommended_fix}`.
3. **Recommended migration shape for merge-orchestrate**: one of the three sub-question 3 options, with rationale.
4. **Cross-framework comparison table:** for each of {Marten/Wolverine, Akka Persistence Typed, Axon, EventStoreDB}, what they enforce (runtime) vs document (developer discipline) on this point.

---

## Question 2: Cross-process race over `BEGIN IMMEDIATE` + SQLITE_BUSY

### Concern

The `StreamLockManager` in `atomic-appender.ts:172` is an **in-process Promise-chain mutex**. It serializes `runExclusive(streamId, fn)` calls *within one Node process*. Two separate Node processes hitting the same `exarchos.db` rely entirely on SQLite's file-level locking (`BEGIN IMMEDIATE` + SQLITE_BUSY retry budget at `sqlite-backend.ts`).

The new `decide` / `withSession` primitives compose three operations across the lock:

1. **Read events** (outside `BEGIN IMMEDIATE` — uses `backend.readEvents(streamId)`)
2. **Fold + invoke decide function** (in JS, no DB)
3. **Commit** (inside `BEGIN IMMEDIATE` via `appendComputed` with `expectedSequence: tail`)

Within one process, the `runExclusive` mutex makes 1→2→3 atomic-by-convention. Across two processes:

- Process A reads events for stream X (tail = 3). Returns to JS.
- Process B reads events for stream X (tail = 3). Returns to JS.
- Process B's commit acquires `BEGIN IMMEDIATE`. Appends event 4. Commits.
- Process A's commit acquires `BEGIN IMMEDIATE`. Sees tail = 4, expected = 3. Returns `sequence-conflict`.

This is the *intended* path: OCC catches the race; A throws `ConcurrencyError`; `withStateRetry` reloops. **But:** the read phase (step 1) happens outside the lock, and there's a window between read and commit where process A's view of the world is stale. The decide function ran against tail=3 state but the truth was already tail=4.

For pure decide functions, OCC handles it correctly: the loser retries with fresh state. For `withSession` with side effects, item 1 applies (the API call fires against stale state, then OCC fires, then retry re-runs against fresh state).

**The specific question for the audit:** is there a scenario where SQLITE_BUSY budget exhaustion + cross-process contention produces a *silent* incorrect commit, where the loser's events end up persisted at a position they didn't intend? In particular:

- SQLITE_BUSY retry exhausted on the read path → does the loser see partial data?
- SQLITE_BUSY retry exhausted on the commit path → `appendComputed` returns `storage_busy`; how does `decide` surface this to the caller? Does `withStateRetry` retry the busy or treat it as terminal?
- WAL vs rollback mode interaction — does our schema use WAL? If not, readers block writers and the race window widens.

### Sub-questions for the discover workflow

1. **What is SQLite's exact concurrency contract for `BEGIN IMMEDIATE` under cross-process contention?** Specifically: under WAL mode vs rollback-journal mode, what happens to a reader inside the read-events-then-decide window when another writer commits between phases?

2. **Does `better-sqlite3` (our binding) inherit any subtle semantics that change the above?** It's synchronous-only — does that interact with our async `decide`'s `await` boundary between read and commit?

3. **How does `SqliteBusyExhaustedError` propagate through `appendComputed` → `decide` → `withSession` → `withStateRetry`?** Is it treated as retryable (it should be — it's a contention signal, not a logical error) or terminal? The current `AppendResult` shape has `reason: 'storage_busy'` separate from `reason: 'sequence-conflict'`; both should drive retry but via different paths.

4. **Are there known SQLite footguns we should be aware of?** Specifically check: PRAGMA setting requirements (journal_mode, synchronous, busy_timeout), fsync semantics on commit, NFS-style filesystem hazards (we're local-only today, but the basileus-forward invariant cares about transferability).

5. **What WAL-mode-specific behavior matters for our reads?** If we're not in WAL mode, can we enable it safely as part of this bundle? Performance impact on `decide`/`withSession` round-trip?

### Authoritative sources for grounding

**Primary (SQLite official):**
- **SQLite official documentation**, [*"File Locking And Concurrency In SQLite Version 3"*](https://www.sqlite.org/lockingv3.html) — canonical reference for SHARED / RESERVED / PENDING / EXCLUSIVE lock progression.
- **SQLite**, [*"Atomic Commit In SQLite"*](https://www.sqlite.org/atomiccommit.html) — D. Richard Hipp's definitive description of the commit protocol.
- **SQLite**, [*"Write-Ahead Logging"*](https://www.sqlite.org/wal.html) — WAL mode's reader-writer concurrency model.
- **SQLite**, [*"Transaction"*](https://www.sqlite.org/lang_transaction.html) — explicit semantics of `BEGIN DEFERRED | IMMEDIATE | EXCLUSIVE`.
- **SQLite**, [*"Isolation in SQLite"*](https://www.sqlite.org/isolation.html) — what SQLite guarantees vs doesn't.

**Primary (better-sqlite3):**
- **better-sqlite3** docs, [*API: Database#transaction*](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#transactionfunction---function) — synchronous transaction semantics + nested transaction handling.
- **better-sqlite3**, [*Performance considerations*](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — pragma recommendations.

**Primary (canonical literature):**
- **Martin Kleppmann**, *Designing Data-Intensive Applications* (O'Reilly 2017), Ch 7 "Transactions" §"Weak Isolation Levels" and §"Serializability" — what optimistic concurrency control guarantees and what it doesn't.
- **Jim Gray & Andreas Reuter**, *Transaction Processing: Concepts and Techniques* (Morgan Kaufmann 1992), Ch 7 "Isolation Concepts" — the foundational treatment of locking, OCC, MVCC.
- **Microsoft Azure Architecture Center**, [*"Optimistic Concurrency Patterns"*](https://learn.microsoft.com/en-us/azure/architecture/patterns/) — patterns for OCC error handling and retry. Use `microsoft-learn` MCP for fetch.
- **PostgreSQL docs**, [*"Concurrency Control"*](https://www.postgresql.org/docs/current/mvcc.html) — for *contrast* with SQLite (Marten's substrate is PostgreSQL MVCC; ours is SQLite locking).

**Secondary (industry practitioners):**
- **Ben Johnson** (Litestream author), [*"Why I built Litestream"*](https://litestream.io/blog/why-i-built-litestream/) and the Litestream docs — production patterns for SQLite at scale, including WAL semantics and process coordination.
- **Marc Brooker** (AWS Principal Engineer, ex-SQLite contributor), [*blog*](https://brooker.co.za/blog/) — multiple posts on SQLite concurrency under load. Search for "SQLite" + "transaction".
- **Aphyr / Kyle Kingsbury**, [*Jepsen analyses*](https://jepsen.io/analyses) — no SQLite analysis exists, but the methodology + general concurrency findings transfer.
- **D. Richard Hipp**, SQLite forum threads at `https://sqlite.org/forum/` — search for "BEGIN IMMEDIATE" + "concurrency".

**Already-loaded local sources:**
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts:172-192` — `StreamLockManager` implementation
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` — SQLITE_BUSY retry budget (T09, DR-12)
- `docs/architecture/runtime.md` §3 — L2 (event store) substrate model

### Output shape for question 2

The discover workflow returns:

1. **Verdict:** one of `safe-as-designed | needs-pragma-change | needs-design-revision`.
2. **Findings:** as for question 1.
3. **PRAGMA recommendations table:** for each of `journal_mode`, `synchronous`, `busy_timeout`, `temp_store`, `cache_size`, our current setting + recommended setting + rationale. Cite SQLite docs.
4. **`SqliteBusyExhaustedError` propagation diagram:** trace from substrate up through `appendComputed` → `decide` → `withSession` → `withStateRetry`. Identify any layer that should retry but doesn't, or vice versa.
5. **Cross-process race scenarios:** at least three concrete scenarios (e.g., MCP server + CLI; two MCP server instances if user runs `npx`; concurrent `workflow.init`) walked through end-to-end with expected behavior.

---

## Out-of-Scope for This Audit

The following surfaced during ideate/plan but are explicitly deferred:

- **Snapshot version-bump procedure** for `taskStoreReducer` and `mergeOrchestratorReducer` when `version` flips from 1 to 2. Track as a separate follow-up issue post-preview.2.
- **General event-sourcing risk inventory.** Covered by `docs/research/2026-05-08-marten-event-store-lessons.md`.
- **Marten-pattern verification of `decide` API shape.** Already done in `/ideate` via context7.
- **INV-1 / INV-2 / INV-5b structural compliance** of the new primitives. Covered by `/design-invariants` during plan review.
- **`axiom:audit` dimensions** (DIM-1..DIM-8) as code-quality gates. Will run post-implementation in `/exarchos:review`.

## Discovery Workflow Tooling

Available to the research agent:

- **context7** (`mcp__plugin_context7_context7__*`) — for Marten, Wolverine, Axon, Akka library docs
- **microsoft-learn** (`mcp__microsoft-learn__*`) — for Azure Architecture Center patterns
- **WebFetch / WebSearch** — for blog posts, papers, SQLite forum threads, EventStoreDB docs
- **exa** (`mcp__exa__*`) — secondary web search if WebSearch is rate-limited
- **Local repo grep / read** — for `atomic-appender.ts`, `sqlite-backend.ts`, `state-retry.ts`

## Deliverable

A research document at `docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md` with:

1. Executive verdict: `proceed-as-designed | proceed-with-revisions | block-on-revision` and the headline finding driving it.
2. Question 1 findings (output shape above).
3. Question 2 findings (output shape above).
4. Source bibliography with every citation grounded in a primary source above.
5. Concrete recommendations mapped to specific plan tasks (e.g., "Add Task 4.2.5: enforce side-effect idempotency contract in `withSession`").

**Word budget:** 1500–2500 words for findings prose; bibliography unbounded. Bias toward concrete (file:line citations, framework-specific behavior names, exact PRAGMA values) over abstract.

**Out-of-budget signals to flag:** any source that says "depends on your deployment context" without specifying which. We are single-machine local SQLite today; remote MCP is preview.4+. Flag any finding that doesn't apply at our scale.
