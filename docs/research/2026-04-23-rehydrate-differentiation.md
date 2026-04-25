# Rehydrate as a Differentiator: Cache Economics, Context Fidelity, and Memory Architecture

> **Status:** Discovery — `rehydrate-differentiation-research`
> **Date:** 2026-04-23
> **Workflow:** `/exarchos:discover`
> **Scope:** Research-only. No code changes. Escalation to `/exarchos:ideate` is recommended for any proposal adopted below.

---

## 1. Problem framing

### 1.1 Why `/rehydrate` matters more than it looks

Exarchos's positioning line is **"Your agents forget. Exarchos doesn't."** The commands that deliver on that line — `/checkpoint`, `/rehydrate`, `/reload`, and the SessionStart hook — are the ones users touch every time context gets heavy, every `/clear`, and every time they come back from lunch. Their quality is the product's felt quality.

Today's `/rehydrate` is *correct* (state lives in the event store, playbook and artifacts are re-injected in ~2-3k tokens) but it solves exactly one problem: **agent awareness after a fresh context**. It does not address the two problems that now dominate long-running Claude Code sessions:

1. **Cache-miss economics after idle.** Anthropic's prompt cache has a 5-minute default TTL and a 1-hour extended TTL. Past TTL, every token in the working prefix re-bills at full rate — 10× cache-read pricing. A 900k-token Opus session that idles past the TTL pays an extra ~$12-13 on resume instead of ~$1.35.
2. **Compaction invalidates the cache by definition.** Auto-compact rewrites the prefix. Every post-compact token is a cache miss until the next cache write settles. Claude Code mitigates this with prefix-reuse heuristics in its own compaction path, but the moment you `/clear` or auto-compact fires, the cache is gone.

`/rehydrate` is the surface where these two problems intersect. If Exarchos owns this surface, it becomes a *financial* differentiator, not just an ergonomic one.

### 1.2 The three axes that define "differentiating"

Research converged on three orthogonal axes. A truly differentiating rehydrate advances all three simultaneously:

| Axis | What it optimizes | Current Exarchos posture |
|------|-------------------|--------------------------|
| **Cache economics** | $/resume, tokens re-billed past TTL | Not addressed. Treats rehydrate as pure context reload. |
| **Context fidelity** | Does the agent actually know what to do? | Strong. Behavioral guidance + task table + artifacts in 2-3k tokens. |
| **Memory architecture** | What persists across `/clear` and across sessions? | Event store persists workflow state. No cross-workflow or cross-session learning. No semantic recall. |

The rest of this report maps each axis, contrasts Exarchos against state-of-the-art, and closes with a prioritized proposal set.

---

## 2. Cache economics: the underused lever

### 2.1 The mechanic in one paragraph

Anthropic's prompt caching works by marking content blocks with `cache_control: { type: "ephemeral", ttl: "5m" | "1h" }`. The first request writes the cache at 1.25× (5m) or 2× (1h) base input cost. Subsequent requests inside the TTL pay 0.1× for cache reads — a 90% discount. **Every cache read resets the TTL.** Past TTL, the cache is evicted and the next request pays full write cost again.

That last sentence is the lever. A trivial request (`max_tokens: 1`) that touches the cached prefix *refreshes the TTL without doing real work*. Third-party harnesses (OpenClaw, RemoteClaw) already ship "heartbeat" configurations that fire a ping at `TTL × 0.8` to prevent eviction between user turns. The economics: one ping costs a cache read on the cached prefix (~$0.30/MTok × 900k = $0.27 on Opus) and saves a full cache write on resume (~$18.75/MTok × 900k = $16.88). Break-even is one avoided miss per hour.

### 2.2 Claude Code's native compaction is already a three-tier system

From the Claude Code decomp (decodeclaude.com deep-dive and the "how Claude Code manages infinite conversations" post), compaction is **not** a single "summarize and hope" step. It's a hierarchy:

| Tier | Model call? | Cost | When used |
|------|-------------|------|-----------|
| **Microcompact** | No | ~$0 | Clears stale tool results only. Runs on a cadence. |
| **Full compact** | Yes (one forked turn) | Expensive (full-context summary) | Threshold-based, produces the structured "working state." |
| **Session memory compact** | **No** | ~$0 | Uses **pre-extracted notes** to skip the summarization model call entirely. |

The third tier is the breakthrough. If you already have a compact, structured "working state" on disk before compaction fires, you can skip the most expensive step Claude Code does. Exarchos is uniquely positioned to do this because it already maintains a normalized workflow state with events, tasks, artifacts, and review deltas — the raw material for "pre-extracted notes" is already in the event store.

### 2.3 Findings summary — cache economics

1. **1-hour cache TTL is available via `cache_control: { ttl: "1h" }`.** Most agents should use it for anything that persists past a turn.
2. **TTL resets on every cache access.** A `max_tokens: 1` heartbeat fires one cache read and extends the TTL.
3. **Compaction invalidates cache.** Reducing how often compaction fires (via context editing, microcompact-style tool-result clearing, memory offload) is itself cache-preserving.
4. **Prefix stability matters.** The cache key is the exact prefix. Any reordering, reformatting, or version bump in system prompt / tools / CLAUDE.md breaks the cache. Anthropic recommends structuring prompts with static content first, volatile content last.
5. **"Pre-extracted notes" skip the summary model call.** This is a first-principles optimization, not a heuristic. Exarchos's event store is exactly the shape needed.

---

## 3. Context fidelity: beyond the 2-3k playbook dump

### 3.1 Official Anthropic patterns (context-management launch, Sept 2025)

Anthropic shipped three first-party primitives explicitly for this:

- **`memory_20250818`** — file-based memory tool. Claude can create/read/update/delete files in a dedicated `/memories` directory. Persists across conversations. Client-controlled storage (you decide where the directory lives).
- **`clear_tool_uses_20250919`** — server-side context editing. Clears older tool results when the window grows past a threshold. Your client still holds the full history; Anthropic's server edits on the way into the model.
- **`clear_thinking_20251015`** — clears extended-thinking blocks on a configurable cadence.

**The composition matters.** When context-editing fires, Claude gets an automatic warning "preserve important information" and can write to memory files *before* the tool-result clear happens. This is the native version of "checkpoint before compact." Exarchos does this for workflow state today but not for the agent's in-flight reasoning.

### 3.2 The three-layer pattern is now the default

Four independent sources (Fazm blog, whoffagents dev.to, 32blog, Claude Code ultimate-guide) converge on the same architecture:

```
Layer 1: CLAUDE.md           → project conventions, loaded every session
Layer 2: HANDOFF.md          → current state, loaded every session
Layer 3: on-demand files     → loaded as the agent needs them
```

The reported effect is consistent: session startup drops from "10 minutes / 50k+ cached tokens" to "30 seconds / 2-5k cached tokens" because layer 3 is loaded *only when relevant*. This is just-in-time retrieval dressed as a markdown discipline. Exarchos's MCP `exarchos_workflow get … fields=[…]` projection achieves the same shape programmatically, but the rehydrate output doesn't yet exploit it — today it loads a fixed bundle of fields, not a demand-driven one.

### 3.3 Hierarchical summaries and relevance weighting

The CODITECT memory-context pattern (and the Anthropic research summary that tracks it) crystallizes what a good rehydrate *recall layer* should do:

1. **Progressive disclosure.** Overview first; expand on request. Measured 60-75% token reduction.
2. **Relevance scoring.** Weight recent and work-state items highest. Stale items (>30 days) receive 0.3× weight.
3. **Work-state primacy.** In-progress and blocked items are *never* filtered out.
4. **Signal over volume.** A few highly relevant items beat many marginally relevant ones.
5. **Hierarchical expansion.** Summary → detail on demand.

Exarchos's current rehydrate returns a fixed layout: playbook, phase, tasks, artifacts. There's no relevance scoring and no expansion protocol. The difference between "here's everything" and "here's what matters, ask for the rest" is the difference between a 3k rehydrate and a 600-token rehydrate with a 2k progressive expansion.

### 3.4 What Claude Code already does on compaction (that Exarchos doesn't)

After a full compact, Claude Code re-reads the few most recently accessed files, restores the todo list, restores plan state, and re-injects hook outputs. This is a **hot-file manifest** pattern: file paths the agent has touched recently are almost always still load-bearing.

Exarchos has no equivalent. The workflow state tracks artifacts (design, plan, PR) but not "files the agent was reading five minutes before `/clear`." On a real coding session the rehydrated agent often immediately re-greps to find the files it was already inside — pure waste.

---

## 4. Memory architecture: what state-of-the-art looks like

### 4.1 LangGraph's checkpointer model

LangGraph, which has the most mature agent-persistence story outside Anthropic, exposes a `BaseCheckpointSaver` interface with:

- **`thread_id`** as the primary key for a conversation thread
- **Per-superstep snapshots** with parent pointers (forms a linked list / DAG)
- **Time travel** — resume from any past snapshot as a *fork*, not a rewrite
- **Pluggable backends** — InMemory / Sqlite / Postgres
- **Checkpoint format versioning** — `v: 1` field, migration-friendly

Exarchos has an append-only event store per-featureId, which is structurally similar (events as deltas, workflow state as projection). Two LangGraph capabilities are absent today:

1. **Time-travel forks.** Exarchos can't branch a workflow at an arbitrary past event and explore an alternative.
2. **Step-level snapshots.** Checkpoints are triggered by thresholds (20 operations) or explicit `/checkpoint`, not per-transition.

### 4.2 Claude Agent SDK: `resume`, `fork`, and file-checkpointing

The Claude Agent SDK (Python and TypeScript) exposes:

- `resume: sessionId` — continues a previous conversation with full context
- `fork_session=True` — fork instead of continue (creates a branch)
- `list_sessions` / `get_session_info` / `get_session_messages` / `rename_session` / `tag_session` / `delete_session` — full lifecycle
- `enable_file_checkpointing` + `rewind_files(checkpoint_id)` — file-level undo tied to a user message UUID
- Tags on sessions — first-class metadata for organization (maps cleanly to Exarchos's `/tag` command)

Exarchos could expose `/exarchos:rehydrate --fork` and `/exarchos:rehydrate --at <event-id>` with negligible new machinery: the event store already supports projection from any sequence number via `reconcile`. What's missing is the user-facing verb.

### 4.3 Cross-session memory: the missing dimension

Everything in Exarchos today is *within-workflow*. A workflow finishes, the event stream is archived, and the next `/ideate` starts from zero. The auto-memory system in Claude Code (`MEMORY.md` + typed memories — the same mechanism logged in this conversation's system prompt) is the antidote: learnings, corrections, and project facts that survive every `/clear` and every new workflow.

Exarchos currently sits *beside* this mechanism. A rehydrate that also surfaces relevant auto-memory entries — "last time you touched rehydrate, we decided X" — would collapse the gap between *workflow continuity* and *project continuity*.

---

## 5. Gap analysis: current `/rehydrate` vs. the frontier

| Capability | Claude Code native | LangGraph | CODITECT-style memory | **Exarchos today** |
|------------|-------------------|-----------|-----------------------|--------------------|
| Workflow state after `/clear` | Partial (summary + recent files) | Yes (thread checkpoint) | Yes (JSON + MD checkpoints) | **Yes (event store + context.md)** |
| Cache-preserving resume | Some (cache sharing in compact) | N/A (generic) | N/A | **No** |
| 1h cache TTL for stable prefix | N/A (client-side decision) | N/A | N/A | **No** |
| Keep-warm heartbeat | No (open feature request) | N/A | N/A | **No** |
| Pre-extracted notes (skip compact model call) | Yes (session-memory compact) | No | No | **Partial (context.md exists but isn't used to short-circuit compact)** |
| Hot-file manifest | Yes | No | No | **No** |
| Progressive disclosure rehydrate | No | No | Yes | **No** |
| Relevance-scored recall | No | No | Yes (freshness weighting) | **No** |
| Time-travel / fork from past checkpoint | No (sessions only) | Yes | No | **Possible via event store, no UX** |
| Cross-workflow memory | Auto-memory (CLAUDE.md) | Store (JSON namespaces) | Hierarchical recall | **Adjacent but not integrated** |
| Context-editing compat (`clear_tool_uses`) | Yes | N/A | N/A | **No** |
| Memory tool compat (`memory_20250818`) | Yes (in Claude Code) | N/A | N/A | **No** |

The pattern is clear: Exarchos has the best **workflow-state** story but is missing everything that turns that state into a *performance* advantage — cache awareness, pre-extraction, hot-file tracking, progressive disclosure, and cross-workflow memory.

---

## 6. Prioritized proposals (initial, v1 — see §9 for refined set)

Ordered by **value-per-implementation-effort**. Each is a candidate for its own `/exarchos:ideate` kickoff.

### Tier 1 — Ship this quarter

- **P1. Cache-aware rehydrate output layout.** Stable prefix first, volatile state last. Zero-cost change; enables cache-read discount on repeated rehydrates.
- **P2. Hot-file manifest in the checkpoint.** Capture files touched in 5 min before compact; surface on resume.
- **P3. `/exarchos:warm` opt-in keep-alive loop.** `max_tokens: 1` ping at `TTL × 0.8`; daily cost cap; auto-cancels.
- **P4. Pre-extracted notes to short-circuit future compaction.** Reshape context.md into a load-bearing document Claude Code's session-memory compact tier can consume.

### Tier 2 — Next quarter

- **P5. Progressive-disclosure rehydrate** (default 500-token card, `/recall` for depth).
- **P6. Relevance-scored multi-workflow recall** (freshness + work-state weighting).
- **P7. Time-travel `/exarchos:rehydrate --at <event-seq>` and `--fork`.**
- **P8. `memory_20250818` and `clear_tool_uses_20250919` integration.**

### Tier 3 — Strategic

- **P9. Cache cost telemetry as `exarchos_view cost`.**
- **P10. Cross-workflow learning layer (auto-memory × workflow state).**

---

## 7. Open questions

1. **Warm-keep pricing guardrails.** What daily cost cap is right by default?
2. **Prefix stability discipline.** What CI check enforces byte-stable system prompt + MCP tool descriptions + CLAUDE.md?
3. **Compact-compat with native compaction.** Can pre-extracted notes be injected into Claude Code's native compact path via the PreCompact hook?
4. **Session-SDK alignment.** Should Exarchos's workflow ID be usable as a Claude session tag?
5. **Remote/hosted deployment.** Which of these land in the server vs. client-side plugin?

---

## 8. Recommended next step

Stand up `/exarchos:ideate rehydrate-tier-1` scoped to **P1, P2, P3, P4**. See §9 for the refined scope that supersedes this after review.

---

## 9. Refined recommendations (post-review, 2026-04-23)

Sections 6-8 are the initial prioritization. After review against [#1109 event-sourcing integrity + MCP parity + basileus-forward](https://github.com/lvlup-sw/exarchos/issues/1109), Azure's [Event Sourcing pattern](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing), and `axiom:backend-quality` DIM-1 through DIM-8, the recommendations restructure into four layers with explicit quality gates.

### 9.1 Foundation (architectural prerequisite)

**F1. Rehydration document as projection over the event stream, not a sidecar file.**
Eliminate the mental model of `context.md` as an independent on-disk artifact. Redefine it as a materialized projection over `<featureId>` events. Event stream is the single source of truth (Azure ES write model); the cached projection is a durable read-only view (CQRS read model). `reconcile` rebuilds on demand.
*Satisfies:* #1109 §1 reconstructible-from-events; Azure ES single-source-of-truth; DIM-1 topology.

**F2. Every checkpoint/rehydrate action emits events.**
New event types (schema-registered): `workflow.checkpoint_requested`, `workflow.checkpoint_written`, `workflow.checkpoint_superseded` (compensating), `workflow.rehydrated`, `workflow.file_touched`, `workflow.projection_degraded`. Today's `/exarchos:checkpoint` nudge violates #1109 §1 outright — it writes no event. Compensating events replace mutation (Azure ES immutability invariant).
*Satisfies:* #1109 §1 events-emitted; Azure ES compensation; DIM-2 visible degradation.

**F3. `exarchos_workflow.rehydrate` as single MCP-native dispatch, HATEOAS-wrapped.**
One action, one envelope. CLI (`exarchos workflow rehydrate …`), MCP tool call, `/exarchos:rehydrate` command, and Claude Code's SessionStart hook all route through it. Existing `exarchos_workflow.checkpoint` action is extended to materialize the projection (today it only resets the counter). Makes `/checkpoint` finally load-bearing.
*Satisfies:* #1109 §2 MCP parity, §3 basileus-forward; DIM-6 adapters depend on core.

### 9.2 Data model

**D1. Canonical document: versioned projection with explicit snapshot cadence.**
Schema `v: 1`. Ordered sections: `behavioralGuidance`, `workflowState`, `taskProgress`, `decisions`, `hotFiles` (≤10), `artifacts`, `blockers`, `nextAction`, `projectionSequence`. Snapshot cadence explicit: `workflow.snapshot_taken` every N events (default 50); rehydrate loads most-recent snapshot + events-since.
*Satisfies:* Azure ES intent-over-state, snapshots-as-optimization; DIM-3 versioned schema; DIM-7 bounded.

**D2. Hot-file manifest via the sideband daemon (universal floor).**
Hot files cannot depend on Claude Code tool-call hooks — that violates basileus-forward parity. `exarchos watch` daemon (#1149) is the collector via two paths: MCP-instrumented (records `Read`/`Edit`/`Write` tool calls it serves) and process-observed (`fs.watch`/`inotify`). Both emit `workflow.file_touched`. Projection over these events is the hot-file list. Every runtime gets the feature for free.
*Satisfies:* #1109 §3 universal floor; basileus ADR §2.4; DIM-1, DIM-7.
**Status:** Deferred from first wave per user direction (no daemon/collector in this scope).

**D3. Capability-resolver-aware ontology enrichment (opt-in).**
When the Ontology MCP channel is present per handshake-authoritative resolution, optionally enrich `workflowState` with ontology context. Degrades gracefully when channel absent. No yaml reads at runtime.
*Satisfies:* basileus ADR §2.1, §2.8; DIM-2.
**Status:** Deferred from first wave.

### 9.3 Quality gates (shipped with the design)

**Q1. Given-when-then test harness.** Given event stream, when `rehydrate` dispatched, then document asserts. In-memory SQLite, same wiring as production, no over-mocking. (Azure ES testing; DIM-4.)

**Q2. CLI/MCP parity gate in CI.** Invoke both facades over the same fixture; assert byte-identical envelope. **Shipping contract** — PR that fails does not merge. (#1109 §2; DIM-6.)

**Q3. Prefix-stability fingerprint in CI.** Hash the stable prefix (behavioral-guidance template, MCP tool descriptions, skill frontmatter). Fail on unintentional drift. (DIM-3.)

**Q4. Prose lint on the canonical document template.** `axiom:humanize` or equivalent on the template. (DIM-8.)

### 9.4 User-visible capabilities

**C1. Cache-aware document ordering.** Stable sections first; protected by Q3. (Former P1.)

**C2. Hot-file manifest in the rehydration document.** Populated from D2 daemon events. **Status:** Deferred with D2.

**C3. Load-bearing canonical document.** Structured and complete enough that Claude Code's native session-memory compact tier consumes it as pre-extracted notes. Same document serves non-Claude runtimes via the explicit resume path. (Former P4.)

### 9.5 Opt-in accelerators

**A1. Keep-warm heartbeat.** Opt-in `/exarchos:warm`; daily cost cap; emits `workflow.heartbeat_fired`; auto-cancels on compact/model-switch. **Status:** Deferred from first wave.

**A2. Claude Code hook adapters.** `PreCompact` → `checkpoint` action. `SessionStart` → `rehydrate` action. **Status:** Deferred under absolute parity principle.

**A3. Anthropic-native `cache_control: ttl=1h` breakpoint emission.** Runtime-conditional via capability resolver. Conditional *rendering*, not feature disparity — document bytes identical. (In-scope.)

### 9.6 Sequencing

One ideate → one plan → one delegate wave:

1. **F1 + F2 + F3** — architectural foundation. Nothing else lands before these.
2. **D1** — data model. D2 and D3 deferred.
3. **Q1 + Q2 + Q3 + Q4** — quality gates land *with* F1-D1, not after.
4. **C1 + C3** — fall out of foundation.
5. **A3** — conditional rendering accelerator.

### 9.7 PR checklist (mirrors #1109 verification)

Every PR in scope confirms:

- [ ] **Event-sourcing:** which events emitted; which projections read.
- [ ] **MCP parity:** Q2 gate passing; one CLI↔MCP pair byte-identical.
- [ ] **Basileus-forward:** capability resolver consulted; no runtime yaml reads.
- [ ] **Capability resolution:** handshake-authoritative.
- [ ] **axiom DIMs:** bounded collections; no silent catches; versioned schema; given-when-then tests; no circular deps; prose-linted template.

### 9.8 Recommended next step (supersedes §8)

Open `/exarchos:ideate rehydrate-foundation` scoped to **F1 + F2 + F3 + D1 + Q1 + Q2 + Q3 + Q4 + C1 + C3 + A3**. Absorbs v2.12 Output Contract scope (#1088, #1098, #1099, #1100). A1/A2, D2, D3 follow in later waves.

---

## Appendix — sources

Primary Anthropic sources (prompt caching, context editing, memory tool, managed agents, Claude Code session management, cookbook), Claude Agent SDK docs (Python, TypeScript, nothflare mirror, SDK demos), compaction deep-dives (decodeclaude, oldeucryptoboi, Morph, Claude Lab, 32blog), session-handoff patterns (Fazm, whoffagents dev.to, Claude Code ultimate guide, CODITECT memory-context/session-summarizer/research-summary), persistence/checkpointer prior art (LangGraph guides, BaseCheckpointSaver reference, dev.to LangGraph memory, Hostinger LangGraph persistence), and cache keep-warm prior art (openclaw heartbeat feature request, RemoteClaw/OpenClaw prompt-caching docs, OpenAI Extended Prompt Caching docs, context-engineering dev.to).

Full URL list on workflow `rehydrate-differentiation-research` `artifacts.sources`.
