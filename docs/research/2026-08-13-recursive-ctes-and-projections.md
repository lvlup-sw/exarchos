# Research: recursive CTEs and "sneaky projections" — what they mean, and what Exarchos should take

**Date:** 2026-08-13 · **Type:** discovery · **Deliverable:** document

## Source

A comment on the [DeepSeek Harness developer preview](https://news.ycombinator.com/item?id=49285244)
HN thread (534 points, 2026-08-13), from a commenter describing their own agent ("dreamcoder"),
responding to the Harness's *Every Run is Traceable* pitch:

> Everything the model sees is recorded in an append-only session log: system prompts, reasoning,
> tool calls and results, subagent scheduling, and every context injection. In the Trajectory view,
> you can inspect these records by source. Resume, fork, search, and replay all operate on the same
> event stream.

> It has an event sourced architecture in SQLite and it resolves queries using recursive CTEs (and
> sneaky projections to speed things up) to deliver exactly that. Identical, stable message chains
> to AI and complete introspection.

The resemblance to Exarchos is real but partial, and the partiality is the interesting part.
Exarchos already ships the *projections* half — with more rigor than the comment describes.
It ships none of the *recursive* half, and the reason turns out to be structural rather than an
oversight of effort.

---

## Part 1 — "resolves queries using recursive CTEs"

### The mechanical answer

The load-bearing idea is that **a conversation is a tree, not a list.**
Each message stores a pointer to its parent; a "conversation" is the path from a chosen leaf back
to the root. The path is *derived at read time*, never stored.

```sql
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES messages(id),   -- NULL at the root
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_parent ON messages(parent_id);
```

A recursive CTE walks that pointer chain in a single query:

```sql
WITH RECURSIVE chain(id, parent_id, role, content, depth) AS (
    -- anchor: start at the tip
    SELECT id, parent_id, role, content, 0
      FROM messages
     WHERE id = :leaf
  UNION ALL
    -- recursive step: hop to the parent, repeat until parent_id IS NULL
    SELECT m.id, m.parent_id, m.role, m.content, c.depth + 1
      FROM messages m
      JOIN chain c ON m.id = c.parent_id
)
SELECT role, content FROM chain ORDER BY depth DESC;  -- root → tip
```

### What the shape buys

| Operation | Implementation | Cost |
|---|---|---|
| **Resume** | insert a child of the current leaf | one row |
| **Fork** | insert a *second* child of an interior node | one row, **no copying** |
| **Replay** | pick any node, walk to root | one query |
| **Search** | query the table, then walk to rebuild context | index + one walk |

Fork is the tell. Because branching is "add a second child," two divergent conversations **share
their common prefix by identity, not by duplication.** Nothing is copied, so nothing can drift.

### Why "identical, stable message chains"

This phrase is the actual payoff, and it is easy to read past.

The chain is reconstructed by walking immutable rows.
The prefix of a forked branch *is the same rows* as the original, so it serializes byte-identically
every single time.
Compare the usual approach — application code assembling a message array from a mutable list, plus
filters, plus re-summarization — where a re-render can silently reorder or reword the prefix between
turns.

There are two consequences, and only the first is normally stated:

1. **Introspection and reproducibility.** Replay shows exactly what the model saw.
2. **Prompt-cache stability.** Providers cache on exact prefix match. A byte-stable prefix hits the
   cache; a re-derived one may quietly miss it. At scale this is a cost and latency property, not
   an audit nicety — and it is likely the reason the author bothered.

So the event-sourcing here is not primarily an audit feature. It is load-bearing for economics.

### The shape generalizes past chat

Any transitive question has this form. A useful production datapoint: the
[aeqi.ai runtime](https://aeqi.ai/docs/architecture/data) resolves authorization the same way —
*"Authority via recursive CTE on demand. No ACL table."* — computing the transitive closure of a
role graph at query time rather than materializing permissions. Same trade: derive, don't store.

### The cost that forces Part 2

- Resolution is O(depth) index probes.
- It runs on *every* turn, so total work across a session is **O(n²)**.
- SQLite executes a recursive CTE as a nested loop over the index — no parallelism, no shortcuts.
- Cycles loop forever without an explicit depth bound or visited-set guard.

That cost is exactly what the second half of the comment is buying off.

---

## Part 2 — "sneaky projections to speed things up"

"Sneaky" is doing precise work here: the projections are **invisible**.
They change no semantics. They are pure accelerators, and the recursive query remains the definition
of what the answer *is*.

Four standard techniques, in ascending cost:

1. **Materialized path.** Store lineage on the row: `child.path = parent.path || '/' || child.id`.
   The chain becomes a prefix scan — no recursion at all.
   The classic objection to materialized paths is re-parenting: moving a node means rewriting an
   entire subtree. **Append-only forbids re-parenting, so the one real weakness does not apply.**
   This is the cheapest big win in an append-only store, and probably what "sneaky" refers to.
2. **Closure table.** Materialize `(ancestor, descendant, depth)` rows — the full transitive closure.
   O(1) ancestor lookup, O(n·depth) storage.
3. **Snapshot + tail.** Cache the fold at sequence N; on read, load the snapshot and apply only the
   tail. *(This is what Exarchos already does.)*
4. **Incremental maintenance.** Update the read model inside the same transaction as the append.

### The discipline that makes it safe

> **The recursive query is the specification. The projection is the implementation.**

They must be provably equivalent, or the "sneaky projection" is just a second source of truth —
precisely the failure Exarchos already paid for once and retired in #1504.

---

## Part 3 — the pairing is the idea

Neither half is novel alone. Together they are *declarative definition + tested accelerator*, and
that pairing has a property a hand-written fold does not: **it is a testable pair.**

A single hand-written fold is simultaneously the definition and the implementation of its answer.
It therefore has no oracle. Nothing can disagree with it.
Two implementations of the same question — one declarative in SQL, one procedural in TypeScript —
can be differentially tested against each other.

That is the transferable insight, and it is a *testing* insight, not an architecture one.

---

## Part 4 — mapping onto Exarchos

### What Exarchos already has, and has better

Measured against [`docs/system-design.html`](../system-design.html):

| Post's claim | Exarchos equivalent | Verdict |
|---|---|---|
| event-sourced SQLite architecture | INV-1: the log is the sole authority; every read model is a pure fold | **stated as a governed invariant, not a technique** |
| projections to speed things up | `projection_snapshots` + `view_cache` (`highWaterMark`) + reconcile/rebuild | **shipped, with a rebuild guarantee** |
| complete introspection | `bisect.ts`, `project-at.ts`, `cursor.ts`, replay-determinism suite | **shipped** |
| — | EFF-001 closed cross-process serialization (three-process fixture) | **far beyond a session-log tool** |
| — | `.state.json` retired (#1504); "filesystem presence is never an existence signal" | **the discipline that keeps projections honest** |

Half the post is already Exarchos, held to a higher standard than the comment describes.

### What Exarchos does not have

**Zero occurrences of `WITH RECURSIVE` in the codebase** (verified across `.ts` and `.sql`,
excluding `node_modules`).

The honest framing matters here, because the obvious conclusion is wrong:

> Recursive CTEs are **not** a faster way to do what Exarchos already does.
> They are how to answer a class of question Exarchos currently **cannot ask at all**: transitive ones.

---

## Findings

### F1 — The causal graph is stored, indexed, and not constructible

Exarchos carries the three-field correlation packet (#1291) on every event:

- `events` has `operation_id`, `correlation_id`, `causation_id`
  ([`sqlite-backend.ts:117-119`](../../servers/exarchos-mcp/src/storage/sqlite-backend.ts)).
- Both correlation columns are indexed — `idx_events_correlation`, **`idx_events_causation`**
  (V6 migration, #1437).
- One-hop equality filters exist, both stream-scoped (`sqlite-backend.ts:1713-1716`) and global
  (`~:1867`, ordered `timestamp, streamId, sequence`).

So far this reads like "the data is there, we just never walk it." It is worse than that:

1. **There is no event id to point at.** Event identity is the composite primary key
   `(streamId, sequence)`. `operationId` is minted fresh **per `dispatch()` call**
   ([`dispatch-context.ts:49`](../../servers/exarchos-mcp/src/dispatch/dispatch-context.ts)),
   so it identifies an operation, not an event. `causationId` is typed `UUID` and documented as
   *"the immediate upstream event id"* — a referent that does not exist.

2. **Nothing advances the chain.** `mintDispatchContext` inherits `causationId`
   **verbatim** (`dispatch-context.ts:79`, `:92-94`), and the AsyncLocalStorage stamping path in
   `event-store/store.ts:50` stamps that one value onto *every* event in the dispatch. The contract
   comment is explicit that this is insufficient — *"Survives ONE hop; callers update it as they
   emit each follow-on event"* (`dispatch-context.ts:17-19`) — but no production caller does. All
   three assignment sites (`sqlite-backend.ts:2721`, `views/lifecycle/inspect.ts:111`,
   `atomic-appender.ts:620`) are pass-throughs that copy an existing value.

**Net:** `causationId` is a **flat label, not an edge.** Since `correlationId` already labels (and
self-binds to `operationId` so it is never undefined), `causationId` is presently close to redundant
with it, while carrying an indexed column and an unimplementable contract.

This is not an argument for recursive CTEs. It is the prerequisite for one:
**you cannot traverse a graph whose edges have no defined referent.**

### F2 — The DKG is a graph specification that never names its traversal mechanism

[`docs/specs/2026-08-05-design-knowledge-graph.md`](../specs/2026-08-05-design-knowledge-graph.md)
is where recursion actually lands:

- **DR-5** — the corpus derives `supersededBy` and "the edge table from typed body references," and
  justifies existing as a separate store precisely because it has *"its own access pattern
  (**cross-feature traversal** and retrieval), which the event store cannot serve."*
- **DR-6** — reads must serve "the current decision **and what it superseded**," and "what
  constrains this change."
- **DR-12** — `AS OF R` folds to cursor ≤ R, excluding claims superseded at or before R.

Traversal is named as *the justifying access pattern*, the substrate is already SQLite + FTS5, and
the spec never states how a traversal executes.

**The nuance that keeps this recommendation honest:** the *common* read does not need recursion.
If the projection materializes `supersededAtRevision`, then "current as of R" is
`WHERE supersededAtRevision IS NULL OR supersededAtRevision > R` — O(1), no walk. DR-3's
"projection folds forward" already points at this.

Recursion is genuinely required for only three things:

- **(a) Lineage** — "this decision and everything it superseded," DR-6's explicit requirement, at
  depth > 1 (A ← B ← C).
- **(b) Cross-feature traversal** — claim → link → claim at arbitrary depth, DR-5's named pattern.
- **(c) Constraint composition** — if constraints ever inherit or compose transitively.

Targeted, not blanket.

### F3 — The projections have no independent oracle

DR-13 requires that dropping `dkg.db` and replaying from event zero reproduces a byte-identical
corpus. That proves the snapshot has not drifted from the log. **It does not prove the fold is
correct** — a wrong fold replays deterministically to the same wrong answer, and passes.

DR-13's "two adapters (SQLite + in-memory)" are two *storage* adapters sharing **one** fold
implementation. They vary the substrate, not the logic. There is no second opinion anywhere.

A recursive CTE over the edge table is a genuinely independent, declarative second implementation of
the same question. This is the single highest-value transfer from the post, and it costs no
production risk because it lives entirely in the test surface.

### F4 — The stability requirement already exists here under another name

DR-12's **C3** — *"the same claims at the same revision compose byte-identically"* — is the same
requirement as the post's *"identical, stable message chains,"* applied to composed specs instead of
message chains. Exarchos arrived at it independently, for the same reason: a derived artifact that
is not byte-stable cannot be trusted or cached.

Two caveats:

- Exarchos is explicitly **"not a model harness"** (system-design §00 non-goals). The message-chain
  application does **not** transfer; the harness owns the transcript. Only the structural property does.
- DR-12 currently achieves C3 by **sort** (`ORDER BY (kind, ordinal, seq)`), which is correct for a
  flat set. If composition ever follows edges (F2b), order becomes traversal-dependent and sort
  alone stops being sufficient.

---

## Recommendations

### R1 — Give the causal edge a referent, or retire it *(cheap; unblocks the rest)*

Current state is the worst of both worlds: an indexed column with a contract nothing implements.
Pick one:

- **Make it real** — introduce a per-event identifier and have emitters advance `causationId` to the
  event that caused them; or
- **Retire it** — delete `causationId` and let `correlationId` carry labeling, which it already does.

If neither is scheduled now, track it as **"built · unreached"** with an owner and an expiry, per the
system-design doc's own convention (the #1713 module-intent gate precedent) — *"either wired or
deleted by that date, never silently forgotten."* Today it is unreached without being tracked as such.

**Cost:** small. The decision is harder than the code.

### R2 — Adopt the recursive query as an executable oracle for DKG folds *(highest value)*

When the corpus lands, express supersession-lineage and edge-traversal as recursive CTEs and
**differential-test the TypeScript fold against them.** This upgrades DR-13 from *deterministic* to
*correct*, and it is the one recommendation that addresses a gap replay-determinism structurally
cannot see (F3).

**Cost:** moderate, entirely in the test surface. No production risk.

### R3 — Name the traversal mechanism in the DKG spec *(spec edit)*

DR-5 and DR-6 require transitive answers. Add an acceptance criterion stating how they execute, plus:

- an explicit **depth bound** (SQLite recursive CTEs do not terminate on a cycle), and
- a **cycle guard** on `supersedes`. DR-11 detects *contradictions* at merge, which is a different
  property; two branches asserting mutual supersession and then merging is a plausible cycle source
  worth guarding rather than assuming away.

**Cost:** spec edit.

### R4 — Materialized path for claim lineage *(defer)*

Append-only makes this nearly free to maintain (Part 2, technique 1). But do not pre-optimize: the
existing snapshot machinery may already suffice, and there is currently no measurement. Revisit only
after R2 provides an oracle to validate it against.

**Cost:** defer.

---

## What not to take from the post

- **Do not restructure workflow state as a tree.** Workflow phases are a state machine (INV-9, "only
  one action mutates a phase"), not a branching conversation. Fork/resume-from-any-node semantics
  solve a problem Exarchos deliberately does not have.
- **Do not move existing folds into SQL.** The TypeScript folds are pure, registry-bound, and
  portable across both storage adapters — DR-13 *requires* that portability so a third backend stays
  a configuration change. Pushing folds into SQLite would trade that away for no gain. Recursive CTEs
  belong on the *new* transitive questions, not as a rewrite of what already works.

---

## Summary

The post describes two halves. Exarchos has shipped one of them more rigorously than the post states
(INV-1 plus snapshot-cached, rebuildable projections), and has none of the other.

The missing half is not a performance technique — it is the ability to ask transitive questions.
Exarchos has one such surface today (`causationId`, structurally inert, F1) and one arriving
(the DKG, whose justifying access pattern is traversal with no named mechanism, F2).

The most valuable single idea is not the recursive CTE itself. It is the pairing:
**a declarative recursive query as the specification, and the fast projection as an implementation
tested against it.** Exarchos's folds currently have no oracle, and replay-determinism cannot supply
one. That is a real, addressable gap, and it costs only test code.
