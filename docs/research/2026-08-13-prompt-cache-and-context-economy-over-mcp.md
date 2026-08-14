# Research: leveraging the event log for cache hits, latency, and context economy over MCP

**Date:** 2026-08-13 · **Type:** discovery · **Deliverable:** document
**Companion to:** [`2026-08-13-recursive-ctes-and-projections.md`](2026-08-13-recursive-ctes-and-projections.md)

## The question

Given that Exarchos is event-sourced and speaks to agents over MCP, how should it use that
architecture to optimize prompt-cache hits, latency, signal density, and context economy?

The prior report surfaced one half of the answer almost incidentally: a byte-stable derived prefix
is what makes a provider's prompt cache hit. This report takes that seriously and asks what
Exarchos actually controls on the wire.

---

## Part 1 — What Exarchos controls, and what it doesn't

Exarchos is explicitly **not a model harness** (system-design §00 non-goals). The harness owns the
message array. But the request the model sees renders in a fixed order:

> **`tools` → `system` → `messages`**

and caching is a strict prefix match — any byte change invalidates everything after it. That gives
a sharp division of labour:

| Surface | Owner | Cache position | Blast radius of a change |
|---|---|---|---|
| **Tool definitions** (5 composite tools) | **Exarchos** | **position 0 — the very front** | invalidates tools **+ system + messages** (total rebuild) |
| System prompt | harness | after tools | invalidates system + messages |
| Skills / AGENTS.md text | **Exarchos** | wherever the harness injects it | depends on injection point |
| Tool results (`next_actions`, views, rehydrate) | **Exarchos** | in `messages` | invalidates messages from that point |

The asymmetry is the headline. **Exarchos owns the single most cache-sensitive bytes in the entire
request** — the tool block — and a change there is the only class of edit (besides switching models)
that forces a *total* rebuild of all three cache tiers.

Two further mechanics matter for an agentic workflow engine specifically:

- **The 20-block lookback.** Each cache breakpoint walks back at most 20 content blocks to find a
  prior entry. A phase that emits many `tool_use`/`tool_result` pairs in one turn blows past that
  window, and the *next* request's breakpoint silently finds nothing. Chattiness is therefore a
  cache property, not just a token property.
- **Concurrent requests cannot read a cache still being written.** An entry becomes readable only
  once the first response *begins streaming*. N agents launched simultaneously against the same
  prefix all pay the full write premium.

---

## Part 2 — What Exarchos already has (more than expected)

This is worth stating plainly, because it changes what the useful recommendations are.

| Concern | Existing mechanism | Status |
|---|---|---|
| Tool-result size | **INV-17 (`response-economy`)** — every action declares a budget, enforced at a dispatch-core measurement seam; unbounded output needs a schema-typed escape hatch (`detail`/`limit`/`fields`), pinned by a registry-enumeration snapshot test | **governed invariant** |
| Progressive disclosure | `slimDescription` on every tool + `describe(actions)` / `describe(eventTypes)` actions | **shipped** |
| Prefix stability | `computePrefixFingerprint` + committed `PREFIX_FINGERPRINT` + `scripts/check-prefix-fingerprint.mjs` in the `validate` chain (DR-12) | **shipped — but see F1** |
| Delta reads | `exarchos_event` query accepts `filter.sinceSequence` / `filter.since`; defaults to the 20 newest | **shipped and agent-reachable** |
| Snapshot acceleration | `projection_snapshots`, `view_cache` + `highWaterMark`, reconcile/rebuild | **shipped** |

Two of these deserve credit. **INV-17 already governs the tool-*result* half of context economy** —
that is the mature part of the picture, and the "high signal context" concern is largely answered by
an invariant with a measurement seam and a snapshot test.

And `slimDescription` + `describe(actions)` is a hand-rolled **progressive disclosure** scheme that
converges on exactly the shape the platform now ships natively (`defer_loading: true` + tool search),
which matters for `exarchos_orchestrate` — a single tool with roughly 60 actions.

---

## Findings

### F1 — The prefix-fingerprint gate hashes bytes production never sends

This is the sharpest finding, and it is a verified mismatch rather than an absence.

The gate exists and is well-built: it canonicalizes with sorted keys and explicitly defends against
`zod-to-json-schema` emit-order flipping the hash
([`fingerprint.ts:70-84`](../../servers/exarchos-mcp/src/projections/rehydration/fingerprint.ts)).
Its rationale is stated in prompt-cache terms — *"the prompt cache invalidates any time the bytes
agents see … change. Schema shape and tool description are the two 'invisible' drivers"*
(`fingerprint.ts:119-123`), and the test header says the point is catching an edit *"before it
silently invalidates prompt caches downstream."*

But the bytes it hashes are not the bytes on the wire:

| | Gate hashes | Production sends |
|---|---|---|
| **Which tools** | `exarchos_workflow` only (`fingerprint.ts:96`) | all 5 (`workflow`, `event`, `orchestrate`, `view`, `sync`) |
| **Which variant** | **non-slim** — `buildToolDescription(tool, false)` (`fingerprint.ts:102`) | **slim** — `buildToolDescription(tool, ctx.slimRegistration ?? false)` (`adapters/mcp.ts:568`) with `slimRegistration: true` set in production (`index.ts:257`, `:410`) |

So an edit to any `slimDescription` — the strings that literally occupy position 0 of every
request — passes the gate silently, as does any edit to the other four tools. The guarded artifact
is one tool's unshipped variant.

**In fairness to the gate:** its declared scope is the *rehydration document's* stable prefix
(DR-12), not the MCP wire prefix, and the docstring says the full tool surface is included because
"the rehydration document's prefix promises cover behavioral guidance that spans the full tool
surface." Within that narrower charter, hashing the non-slim description may be deliberate. The
defect is not that the gate is wrong about its own job — it is that **its prompt-cache rationale
describes a surface far broader than its mechanism covers, and the broader surface is unguarded.**

This is the repo's own lesson recurring: read the guard, not its name; assert the denominator.

### F2 — Parallel dispatch pays the cache write N times

Exarchos fans out subagent waves at `/delegate`, and the launcher **owns process spawn** by
invariant (INV-11: "process lifecycle and top-level placement"). Every subagent starts a fresh
session against the same tool block and the same skills text — an identical, large, cacheable prefix.

Because a cache entry is unreadable until the first response starts streaming, launching N agents
simultaneously means **all N pay the ~1.25× write premium and none get the ~0.1× read.** The fix is
purely a spawn-ordering change: start one, wait for first token, then release the rest — after which
they read what the first wrote.

This is squarely inside Exarchos's boundary. It is the launcher's job already, it requires no
protocol change, and it is the highest ratio of savings to effort in this report.

### F3 — The delta primitive exists; the idiom doesn't

I expected to find that Exarchos could only serve re-rendered snapshots. That is **wrong** —
`exarchos_event` exposes `filter.sinceSequence` and `filter.since` to agents directly
([`event-store/tools.ts:752-759`](../../servers/exarchos-mcp/src/event-store/tools.ts)), and the
internal task store already keeps a `lastReadSequence` cursor and reads only the delta
(`event-sourced-task-store.ts:1007`).

The gap is narrower and more interesting: **nothing routes an agent to the cursor on a re-read.**
The natural idiom after a context break is `rehydrate` / `get`, which returns a folded snapshot —
correct, but a fresh blob each time, sized by total state rather than by what changed. The cursor
path is available and unadvertised.

### F4 — Append-only log and append-only prompt want the same thing

The structural observation the other findings hang off:

> A prompt cache is invalidated by **mutation** of any prefix byte. An event log **never mutates —
> it only appends.** The two data structures have the same discipline.

That alignment is not being exploited. A read served as *"the events since cursor N"* is purely
additive to the agent's context: the prefix is untouched, the cache holds, and the token cost is
proportional to **what changed** rather than to **how much state exists**. A read served as a
re-rendered snapshot is a new blob every time: full token cost, growth tracking total state, and
near-duplicate content accumulating across repeated injections.

Exarchos has the log, the cursors, and the folds. What it lacks is the *convention* that a re-read
is an append.

---

## Recommendations

### R1 — Stagger the first spawn in a delegation wave *(highest value / effort ratio)*

One agent starts; the rest release once its first token arrives. Pure launcher scheduling, no
protocol change, no invariant touched — and it converts N cache writes into 1 write + (N−1) reads.

**Cost:** small, and entirely within the launcher's existing ownership.

### R2 — Extend the prefix fingerprint to the bytes actually shipped

Hash what production sends: all five tools, in the registration mode production uses. Keep the
existing canonicalization (it is the hard part and it is already right). Two concrete guards worth
adding alongside:

- Assert the **denominator** — the fingerprint's input set must enumerate every registered tool, so
  adding a sixth tool without covering it fails rather than passing quietly.
- Seed a violation in the test: change one `slimDescription` byte and confirm the gate goes red.
  A gate that cannot be made to fail is not yet a gate.

**Cost:** small. This is an extension of a working mechanism, not a new one.

### R3 — Make "re-read is an append" the documented idiom

Surface the cursor on `next_actions` after a context break, and say in the workflow guidance that a
re-read should carry `sinceSequence` from the last observed sequence. The mechanism is already
built (F3); this is convention and affordance, which is precisely what `next_actions` exists to
publish (INV-12).

**Cost:** guidance plus a `next_actions` affordance. No new state.

### R4 — Treat tool-block churn as a governed change, and consider `defer_loading`

Two related moves, both aimed at position 0:

- **Govern it.** INV-17 governs response economy (what comes *back*); nothing governs the stability
  of what goes *out* in the tool block, despite that being the only edit class that forces a total
  three-tier rebuild. Whether that becomes an invariant or a note on INV-17, the asymmetry is worth
  naming.
- **Consider the native mechanism.** `defer_loading: true` plus tool search *appends* schemas
  rather than swapping them, and `mid-conversation-tool-changes-2026-07-01` (Claude Opus 5 onward)
  adds and removes tools without invalidating the prefix. That is the platform's answer to exactly
  the problem `slimDescription` + `describe(actions)` solves by hand — most relevant for
  `exarchos_orchestrate`'s ~60 actions.

**Cost:** the governance note is cheap; adopting `defer_loading` is a real evaluation and should be
measured before committing, since the hand-rolled scheme already works.

### R5 — Measure before tuning anything else

`usage.cache_read_input_tokens` at zero across repeated identical-prefix requests is the signal that
a silent invalidator is at work. Without per-surface accounting there is no way to tell whether any
of the above changed anything — and `#1679`'s finding that slim registration is ~52% of session tax
is exactly the kind of number that should be re-measured after R1 and R2 land, not assumed to hold.

**Cost:** small, and it is the prerequisite that makes the rest falsifiable.

---

## What not to do

- **Don't move Exarchos toward owning the message chain.** It is not a model harness (§00), and the
  fix for every finding above sits inside its existing boundary — tool definitions, tool results,
  spawn ordering, and read conventions. Nothing here needs it to own the transcript.
- **Don't reach for 1-hour cache TTL reflexively.** The write premium doubles (2× vs 1.25×), so it
  needs three or more reads to break even against two. It suits bursty traffic with long idle gaps,
  which is a claim about Exarchos's actual usage pattern that nobody has measured yet.
- **Don't chase prefix stability by freezing tool descriptions.** The goal is that changes be
  *deliberate and detected*, not that they never happen — that is what a fingerprint gate is for,
  and why R2 extends the gate rather than proposing a moratorium.

---

## Summary

Exarchos already governs the half of context economy most projects miss — INV-17 puts a declared,
seam-enforced budget on every tool *result*. What is ungoverned is the other side of the wire: the
tool *definitions*, which sit at position 0 of every request and are the only edit class that
invalidates all three cache tiers at once. The gate that looks like it covers this hashes one tool's
non-slim description while production ships five tools' slim descriptions (F1).

The deeper opportunity is structural. An append-only log and a prompt cache both reward appending
and punish rewriting, and Exarchos already has the log, the cursors, and the folds. Serving a
re-read as *"events since cursor N"* rather than a re-rendered snapshot makes every injection
additive: the prefix survives, and cost tracks change rather than total state.

The cheapest concrete win is unrelated to any of that and available now: stagger the first spawn of
a delegation wave so one agent writes the cache and the rest read it (R2 makes the tool block worth
caching in the first place; R1 makes the wave stop paying for it N times).
