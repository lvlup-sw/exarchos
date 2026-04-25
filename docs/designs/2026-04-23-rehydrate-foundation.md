# Rehydrate Foundation: Projection Architecture, Canonical Document Contract, and v2.12 Proving Ground

> **Status:** Design — `rehydrate-foundation`
> **Date:** 2026-04-23
> **Workflow:** `/exarchos:ideate` → `/exarchos:plan`
> **Ships in:** v2.9.0rc1 (absorbs v2.12 Agent Output Contract scope)
> **Supersedes:** initial recommendations in `docs/research/2026-04-23-rehydrate-differentiation.md` §6; consolidates §9 into implementable form
> **Absorbs:** [#1088](https://github.com/lvlup-sw/exarchos/issues/1088), [#1098](https://github.com/lvlup-sw/exarchos/issues/1098), [#1099](https://github.com/lvlup-sw/exarchos/issues/1099), [#1100](https://github.com/lvlup-sw/exarchos/issues/1100)
> **Aligns with:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) event-sourcing integrity / MCP parity / basileus-forward

---

## Problem Statement

`/exarchos:rehydrate` is how workflow state re-enters the agent's context after `/clear`, compaction, or a new session. Today it ships ~2–3k tokens of playbook and state — correct but undifferentiated. Research (see the discovery report) surfaced three structural problems:

1. **`/exarchos:checkpoint` is a nudge, not a save.** Today it outputs a markdown summary and emits no event. The real save happens in a PreCompact hook (Claude Code only) that writes sidecar files. This violates event-sourcing integrity and creates hidden platform disparity.
2. **SessionStart injection and `/exarchos:rehydrate` are separate code paths producing divergent documents.** Users defensively run `/rehydrate` after session start because the auto-injection isn't authoritative. Two documents, two renders, zero shared contract.
3. **Projection logic lives inline across handlers.** `assemble-context.ts`, `pre-compact.ts`, `reconcile-state.ts`, and `next-action.ts` each apply events to state in ad-hoc ways. No shared abstraction. No reducer. No test harness matching Azure's given-when-then pattern.

**Design goal:** land the architectural foundation, canonical document contract, and v2.12 output-contract work as one coordinated wave. Make rehydrate a differentiating feature by making it correct, cache-aware, load-bearing, and platform-identical.

---

## Approaches Considered

Three architectural approaches were evaluated during ideate Phase 2 (2026-04-23). All three take the same scope; they differ in where reducer logic lives, how snapshots are represented, and how pure-function the reduction step is.

### Option 1 — Inline projection in the `rehydrate` handler

One new handler reads events via existing `EventStore`, reduces inline, wraps in HATEOAS envelope. Smallest diff; matches current handler patterns.

**Rejected:** projection logic scatters, future projections (hot files, time travel, cross-workflow recall) duplicate the reduce pattern, and snapshot invalidation becomes ad-hoc (DIM-6 coupling risk; Azure ES pattern not cleanly satisfied).

### Option 2 — First-class projection infrastructure (`ProjectionReducer`)

Pure-function abstraction registered at module-import time; sequence-keyed snapshot cache; `rehydrate` composes reducer + snapshot loader + event tailer. Pure reducer makes given-when-then tests (Q1) structural, not discipline-based. Every future projection plugs in by registering a reducer.

**Chosen** — rationale in the Chosen Approach section below.

### Option 3 — Document-first with rebuild-on-demand

No reducer, no snapshot; focused selectors per section compose the document from scratch. YAGNI-aligned, simplest.

**Rejected:** Azure ES explicitly names this pattern as a failure mode for non-trivial streams; `workflow.snapshot_taken` from F2 would be orphaned; perf tail risk on long-lived workflows.

---

## Chosen Approach: ProjectionReducer as the new projection standard

This design establishes **`ProjectionReducer<S, E>` as the canonical pattern for every projection over the Exarchos event store.** The rehydration projection is the first concrete reducer and the proving ground for the abstraction.

Two commitments follow:

- **(a) Existing projection-like code migrates to this pattern.** `assemble-context.ts`, the inline next-action computation in `pre-compact.ts`, relevant portions of `reconcile-state.ts`, the `exarchos_view` projections (pipeline, task boards, stack health), and any handler currently computing derived state inline are migration targets. Migration is incremental — DR-16 scopes what lands in this wave vs. follow-up work.
- **(b) New projections must be built on this pattern.** Every future projection (D2 hot-file manifest when the daemon lands, time-travel views, cross-workflow memory, cost telemetry, ontology enrichment) registers a reducer. The architectural review gate rejects inline projection work going forward.

The rationale: Azure's Event Sourcing pattern names the reducer/snapshot split as the textbook shape for any event-sourced read side; axiom DIM-6 (architecture) and DIM-4 (test fidelity) are only cleanly satisfiable when the reduction step is a pure function; #1109 event-sourcing integrity mandates projections be reconstructible from events alone, which is trivially true for a reducer and non-trivially true for anything else.

---

## Requirements

**In-scope:**

| Ref | Item |
|-----|------|
| F1 | Rehydration document as projection over event stream |
| F2 | Six new event types (checkpoint lifecycle, rehydration, snapshot, degradation) |
| F3 | `exarchos_workflow.rehydrate` action; `checkpoint` extended to materialize projection |
| D1 | Canonical document schema (versioned, ordered sections, minus `hotFiles`) |
| Q1–Q4 | Given-when-then tests; CLI/MCP parity gate; prefix-stability fingerprint; prose lint |
| C1 | Cache-aware document ordering |
| C3 | Load-bearing document structure |
| A3 | Conditional `cache_control: { ttl: "1h" }` markers (runtime-conditional rendering, not parity break) |
| #1088, #1098 | HATEOAS envelope (v2.12 proving ground) |
| #1099 | `next_actions` field integration |
| #1100 | NDJSON `--follow` streaming |

**Out of scope** (deferred, gated on sideband daemon #1149):

- D2 / C2 hot-file manifest (requires process-observation)
- A1 `/exarchos:warm` keep-alive command
- A2 Claude Code hook adapters (runtime-specific trigger; awaiting parity pattern)
- D3 Ontology-channel enrichment (basileus ADR §2.1, future)

**Parity invariant:** every feature in this wave ships to CLI and MCP simultaneously. A1/A2's deferral reflects this principle directly — we do not ship Claude Code-only triggers ahead of the universal floor.

---

## Technical Design

This section defines the concrete abstractions, data shapes, and dispatch wiring required to realize the chosen approach. Each DR below is implementable independently; their composition is the full design.

### 5.1 The ProjectionReducer abstraction

**DR-1. ProjectionReducer interface.**

Every projection over the event store implements:

```typescript
interface ProjectionReducer<State, Event> {
  readonly id: string;                          // unique, e.g. "rehydration@v1"
  readonly version: number;                     // schema version
  readonly initial: State;
  apply(state: State, event: Event): State;     // pure; same input → same output
}
```

A registry (`servers/exarchos-mcp/src/projections/registry.ts`) holds all registered reducers. Registration is at module import time — no runtime mutation after init (DIM-1 topology: no ambient state, no lazy fallbacks).

**Acceptance criteria:**
- `ProjectionReducer<S, E>` type exported from `projections/types.ts`.
- Registry API: `register(reducer)`, `get(id): reducer | undefined`, `list(): reducer[]`.
- Attempting to register a duplicate `id` throws at startup (fail-fast, not silent overwrite).
- No reducer may mutate its `state` argument — enforced by a test that deep-freezes inputs and expects apply to not throw.
- One reducer registered this wave: `rehydration@v1`.

### 5.2 Snapshot storage and invalidation

**DR-2. Projection snapshot cache.**

Snapshots are the Azure ES optimization: persisted `(state, sequence)` pairs so that `rehydrate` loads the most recent snapshot and folds only events-since.

Storage: append-only JSONL sidecar per stream, `<stateDir>/<streamId>.projections.jsonl`, one line per snapshot. Fields: `{ projectionId, projectionVersion, sequence, state, timestamp }`. Latest-for-projection read is a file-end scan. No separate index this wave.

Snapshot write cadence: every N events (default `SNAPSHOT_EVERY_N=50`, env-configurable). When reached, the `rehydrate` or `checkpoint` handler writes a new snapshot line and emits `workflow.snapshot_taken`.

**Acceptance criteria:**
- JSONL snapshot sidecar file written atomically (temp-file + rename).
- On read, snapshots with `projectionVersion < reducer.version` are ignored (forces replay-from-zero on version bump — DR-18).
- Snapshot file max size configurable; default 10 MB; older entries pruned oldest-first when exceeded. Pruning is bounded and logged (DIM-7 resilience).
- No in-memory ambient cache. Every call reads the file. (DIM-1: single source of truth is the event stream + file.)

### 5.3 Canonical document schema

**DR-3. Rehydration document v1.**

```typescript
interface RehydrationDocument {
  v: 1;
  projectionSequence: number;          // monotonic; consumers dedupe on this
  stableSections: {                     // cache-friendly prefix (DR-14)
    behavioralGuidance: { /* skill ref, tools, events, gates, scripts */ };
    workflowState: { workflowType, phase, synthesisPolicy? };
  };
  volatileSections: {                   // cache-unfriendly suffix (DR-14)
    taskProgress: Array<{ id, status, title, startedAt?, completedAt? }>;
    decisions: Array<{ at, summary }>;
    artifacts: { design?, plan?, pr? };
    blockers: Array<{ taskId, reason }>;
    nextAction: NextAction;              // structured per DR-8
  };
}
```

Section order is **load-bearing** — DR-12 fingerprint locks the stable prefix. Any byte-level change without a committed fingerprint update fails CI.

The schema is Zod-validated at every boundary (reducer output, envelope wrap, NDJSON serialize). No `as` assertions.

**Acceptance criteria:**
- Zod schema in `projections/rehydration/schema.ts`; TypeScript type derived via `z.infer`.
- Validation runs on every `rehydrate` invocation; failure emits `workflow.projection_degraded` and returns a degraded envelope with `{ passed: false, fallback: "minimal-state" }` rather than throwing (DR-18).
- No `hotFiles` field in v1. Adding it is a v2 schema with an explicit upcaster (future wave).

### 5.4 Event schema additions

**DR-4. Six new event types.**

Registered in the event store schema catalog; each has a Zod data schema and an emission-source note. Built-in, not custom.

| Event | Emitted by | Data |
|-------|-----------|------|
| `workflow.checkpoint_requested` | `checkpoint` action entry | `{ trigger: "manual"\|"threshold"\|"hook", reason? }` |
| `workflow.checkpoint_written` | After projection materialized + snapshot written | `{ projectionId, projectionSequence, byteSize }` |
| `workflow.checkpoint_superseded` | Compensating event (invalidation) | `{ priorSequence, reason }` |
| `workflow.rehydrated` | On `rehydrate` action success | `{ projectionSequence, deliveryPath: "command"\|"mcp"\|"cli"\|"session-start", tokenEstimate }` |
| `workflow.snapshot_taken` | Every N events during projection materialization | `{ projectionId, sequence }` |
| `workflow.projection_degraded` | Reducer error, snapshot corrupt, or validation fail | `{ projectionId, cause, fallbackSource }` |

**Acceptance criteria:**
- Each event type appears in the emission-guide returned by `exarchos_event({ action: "describe", emissionGuide: true })`.
- Each has at least one handler registration emitting it; at least one test per event asserting the emission on the correct path.
- Compensating events: a test asserts that a `checkpoint_superseded` event followed by a re-`checkpoint_written` produces the same projection as a cold replay would.

### 5.5 Unified dispatch and the checkpoint refactor

**DR-5. `exarchos_workflow.rehydrate` action.**

New MCP action. Signature:

```typescript
{ action: "rehydrate", featureId: string, fields?: string[] }
  → HATEOAS<RehydrationDocument>
```

Called identically by: CLI (`exarchos workflow rehydrate --featureId X`), MCP tool invocation, the `/exarchos:rehydrate` slash command, and any future SessionStart adapter.

**DR-6. `exarchos_workflow.checkpoint` made load-bearing.**

Today's `checkpoint` action only resets a counter and stamps metadata. This design extends it: on invocation, materialize the rehydration projection, write snapshot, emit `workflow.checkpoint_written`. `/exarchos:checkpoint` becomes a thin CLI adapter calling this action — load-bearing in user-mental-model terms (DIM-8 prose: no claim in docs that outlives the truth in code).

**Acceptance criteria:**
- Dispatch parity: `dispatch({ action: "rehydrate", … })` returns byte-identical envelope regardless of whether called from CLI bin, MCP handler, or in-process test harness.
- `/exarchos:checkpoint` command's rendered output includes the `projectionSequence` written by the underlying action.
- Zero runtime branching on "am I CLI or MCP" inside the handler (DIM-1 topology).

---

## Integration Points

This design integrates with three in-flight streams of work: the v2.12 output-contract milestone (§6.1), existing projection-like code in the codebase (§6.2), and planned future projections (§6.3).

### 6.1 v2.12 output contract: HATEOAS envelope + NDJSON

**DR-7. HATEOAS result envelope (absorbs #1098).**

```typescript
interface Envelope<T> {
  readonly success: boolean;
  readonly data: T;
  readonly next_actions: NextAction[];   // DR-8
  readonly _eventHints?: EventHint[];
  readonly _meta: { checkpointAdvised?: boolean; projectionSequence?: number };
  readonly _perf: { ms: number; bytes: number; tokens: number };
}
```

Every MCP action response wraps in this shape. Rehydrate, checkpoint, and all existing actions migrate.

**DR-8. `next_actions` field (absorbs #1099).**

```typescript
interface NextAction {
  readonly verb: string;                 // e.g. "exarchos_workflow.set"
  readonly reason: string;
  readonly validTargets?: string[];      // phases, featureIds, etc.
  readonly hint?: string;                // free-form human guidance
}
```

Rehydration document's `nextAction` section is exactly one `NextAction`; envelope's `next_actions` is a list of relevant follow-ups.

**DR-9. NDJSON `--follow` streaming (absorbs #1100).**

`exarchos event query --stream <id> --follow` emits one JSON object per event, newline-delimited, flushed per event. Protocol: `{type: "event", event: WorkflowEvent}` for events; `{type: "heartbeat", timestamp}` every 30s; `{type: "end", reason}` on clean close. Errors: `{type: "error", message}` then close.

**Acceptance criteria (all three DRs):**
- Envelope shape formalized in `servers/exarchos-mcp/src/format.ts`; all 4 composite tools produce it.
- `next_actions` populated by a reducer-like computed-field helper so the logic is pure and testable.
- NDJSON encoder/decoder tests prove round-trip for every event type in the registry.
- Q2 parity gate covers all three.

### 6.2 Migration targets (existing components)

**DR-16. Migrations landing in this wave.**

| Component | Current shape | Target | Rationale |
|-----------|---------------|--------|-----------|
| `cli-commands/assemble-context.ts` | Inline reducer → markdown | Replace with `rehydration@v1` reducer; render step becomes envelope serialization | Largest shape-match; highest leverage |
| `cli-commands/pre-compact.ts` | Walks state files, writes JSON sidecar, inlines `computeNextAction` | Call `exarchos_workflow.checkpoint` action; drop inline projection | #1109 §1 violation today |
| `workflow/next-action.ts` | Inline projection of `workflowType + phase → nextAction` | Registered reducer (`next-action@v1`); consumed by envelope's `next_actions` field | DR-8 proving ground |

Not migrating this wave (each scoped to a follow-up):

| Component | Why not now |
|-----------|-------------|
| `orchestrate/reconcile-state.ts` | Broader git/state reconciliation; migrating it risks destabilizing the install rewrite in-flight on another branch |
| `exarchos_view` projections (pipeline, task boards, stack health) | Each a substantial projection; deserves its own ideate once the reducer pattern is proven |
| `cli-commands/subagent-context.ts` | Couples to delegation design; migrate when delegation is next touched |
| `check_design_completeness` legacy state-path read | Gate handler currently reads `~/.claude/workflow-state/*.json`; should read MCP event store |

**Acceptance criteria:**
- Each in-wave migration includes a follow-up issue auto-generated on merge with scope and estimated effort.
- Each deferred migration logged as a follow-up issue with a link to this design.
- A lint rule (or at minimum a grep-based CI check) flags *new* code that computes inline projections over events, pointing to this design.

### 6.3 Future components built on this foundation

**DR-17. Architectural principle for new projections.**

Going forward, every feature that derives read-side state from events MUST:

1. Express the derivation as a `ProjectionReducer<S, E>` registered at module-import time.
2. Ship with given-when-then tests over the reducer.
3. Emit `workflow.snapshot_taken` at the configured cadence.
4. Define a versioned schema for its state type; bumps require an upcaster or explicit replay-from-zero policy.
5. Surface degradation via `workflow.projection_degraded` (or a projection-specific equivalent), never silent.

Planned components that will consume this (non-exhaustive):

| Future component | Reducer | Notes |
|------------------|---------|-------|
| D2 hot-file manifest | `hot-files@v1` over `workflow.file_touched` | Waits on sideband daemon #1149 |
| Time-travel / fork | `rehydration@v1` + bounded replay from a chosen sequence | Natural extension once snapshots are sequence-keyed |
| Cross-workflow memory | `cross-workflow-recall@v1` over multiple streams | Separate ideate |
| Cost telemetry (`exarchos_view cost`) | `cost-projection@v1` over usage/billing events | Separate ideate |
| Ontology enrichment | `ontology-enrichment@v1`, conditionally composed | Basileus ADR §2.1; gated on handshake |

**Acceptance criteria:**
- `docs/architecture/projections.md` (new, short) documents the pattern, the required test shape, and a link to the reducer interface.
- The CI lint or grep check in DR-16 references this principle by name in its failure message.

---

## Testing Strategy and Quality Gates

Four quality gates ship **with** this foundation, not after it. Each is a shipping contract: a PR that fails any gate does not merge.

**DR-10. Given-when-then test harness (Q1).**

Test shape in `projections/rehydration/rehydration.test.ts`:

```typescript
describe("rehydration projection", () => {
  it("given [workflow.started, task.completed], when folded, then taskProgress shows 1/N complete", () => {
    const events = [/* fixture */];
    const state = events.reduce(reducer.apply, reducer.initial);
    expect(state.volatileSections.taskProgress).toMatchObject(/* ... */);
  });
});
```

No filesystem mocks. No `EventStore` mocks. Pure reducer. (DIM-4 test fidelity.)

**DR-11. CLI/MCP parity gate (Q2), shipping contract.**

One CI test that for each MCP action: invokes via CLI bin (child process, JSON output) and via MCP handler (in-process); asserts envelope byte-equality. Fails the build on divergence. This is the invariant #1109 §2 names. Under this design it is non-negotiable — every PR passes or does not merge.

**DR-12. Prefix-stability fingerprint (Q3).**

A SHA-256 of `stableSections` template bytes (before `projectionSequence` and volatile fields fold in) committed to `projections/rehydration/PREFIX_FINGERPRINT`. CI computes and compares. Intentional updates commit the new hash with rationale in the PR body.

**DR-13. Prose lint on document template (Q4).**

`axiom:humanize` runs against the `stableSections.behavioralGuidance` template strings in CI. AI-writing patterns (vocabulary clustering, em-dash overuse, rule-of-three, inflated significance) fail the build. (DIM-8.)

**Acceptance criteria:**
- Q1: ≥1 given-when-then test per reducer-relevant event type.
- Q2: parity gate green in CI before merge; known divergence paths explicitly asserted.
- Q3: fingerprint file committed; CI check wired into `npm run validate` or equivalent.
- Q4: humanize exit code gates the build.

---

## Capabilities: cache-aware ordering and load-bearing structure

**DR-14. Cache-aware ordering + conditional cache_control (C1 + A3).**

The envelope's `data.stableSections` precedes `data.volatileSections` by schema order. On Anthropic-native runtimes (detected via capability resolver), the envelope serializer emits `cache_control: { type: "ephemeral", ttl: "1h" }` markers wrapping `stableSections`. On other runtimes, markers are omitted from the wire format. The document bytes that the *agent sees* are identical; only a consuming runtime's cache behavior differs. This is conditional *rendering*, not feature disparity.

**DR-15. Load-bearing document (C3).**

The document is structured and self-contained enough that an agent reading it cold has behavioral guidance, phase, task state, recent decisions, artifacts, blockers, and next action — no follow-up tool call required to resume work. Lint: a golden-test fixture runs a compact-style prompt against a sample document and asserts that the downstream agent's first action matches the `nextAction` field's verb.

**Acceptance criteria:**
- C1: fingerprint validates byte-stability of the prefix across two consecutive rehydrates on the same workflow.
- A3: capability resolver consulted; markers emitted only when resolver reports `anthropic_native_caching`.
- C3: golden test present; its fixture updated only via explicit PR note.

---

## Error handling and degradation (mandatory)

**DR-18. Projection degradation paths.**

Three failure modes, each with visible recovery (DIM-2):

1. **Reducer throws or validation fails.** Catch at the handler boundary; emit `workflow.projection_degraded { cause }`; return envelope `{ success: false, data: { minimal state from workflow state-store }, _meta: { degraded: true, reason } }`. Never silent-swallow.
2. **Snapshot file corrupt or unreadable.** Log at WARN; fall back to replay-from-zero; emit `workflow.projection_degraded { fallbackSource: "full-replay" }`; succeed.
3. **Event stream unavailable.** Emit `workflow.projection_degraded { fallbackSource: "state-store-only" }`; return whatever workflow state-store holds wrapped in the envelope with `degraded: true`.

No `catch {}` blocks. No silent defaults. Every fallback emits an event. (DIM-2 observability + Azure ES idempotency: re-invocation produces identical degraded envelope until the underlying condition resolves.)

**Acceptance criteria:**
- Three dedicated tests, one per failure mode, each asserting (i) the specific event type emitted, (ii) the envelope shape returned, (iii) no unhandled promise rejection.
- A chaos test feeds malformed events into the reducer; asserts no silent drops, at most one `projection_degraded` per invocation, no heap growth across 10k iterations (DIM-7).

---

## PR verification checklist

Every PR in this wave confirms:

- [ ] **Event-sourcing:** emits at least one of `workflow.checkpoint_*`, `workflow.rehydrated`, `workflow.snapshot_taken`, `workflow.projection_degraded`; reads only via registered reducer(s).
- [ ] **MCP parity:** Q2 gate green; byte-identical envelope proven on the PR's touched actions.
- [ ] **Basileus-forward:** no runtime yaml reads for capability fields; capability resolver consulted for A3's cache_control decision.
- [ ] **axiom DIMs:** pure reducer, no silent catches, versioned schema, bounded snapshot file, no circular deps, prose-linted template.
- [ ] **Migration discipline:** no new inline projection code introduced; if new projection needed, reducer registered.

---

## Appendix A — Requirements summary

| ID | Title | Error handling? |
|----|-------|-----------------|
| DR-1 | ProjectionReducer interface | partial (register dup throws) |
| DR-2 | Snapshot storage | yes (version skew, size cap) |
| DR-3 | Rehydration document v1 | yes (validation fail path) |
| DR-4 | Six new event types | — |
| DR-5 | `rehydrate` MCP action | — |
| DR-6 | `checkpoint` load-bearing | — |
| DR-7 | HATEOAS envelope | — |
| DR-8 | `next_actions` field | — |
| DR-9 | NDJSON `--follow` | yes (close paths, error frame) |
| DR-10 | Given-when-then tests | — |
| DR-11 | CLI/MCP parity gate | — |
| DR-12 | Prefix fingerprint | — |
| DR-13 | Prose lint | — |
| DR-14 | Cache-aware ordering + A3 | — |
| DR-15 | Load-bearing document | — |
| DR-16 | Migration targets | — |
| DR-17 | Principle for future projections | — |
| **DR-18** | **Projection degradation (mandatory)** | **yes (all three failure modes)** |

## Open Questions

The following remain unresolved and are surfaced for plan-review delta analysis.

1. Does the existing `state-store` implementation use SQLite or JSONL uniformly? (Affects DR-2 — whether snapshots are a JSONL sidecar or a SQLite table.)
2. Does `workflow/next-action.ts` have consumers outside `pre-compact.ts`? (Affects DR-16 migration blast radius.)
3. Is the `EventStore` Zod-registered for custom event types, or does DR-4 require extending the type discriminator in `event-store/schemas.ts`? (Discovered during research: the `discovery.report_committed` event registration failed this session — same path applies here.)
4. What is the current envelope shape returned by `exarchos_view` and `exarchos_orchestrate`? (Affects how much of DR-7 is formalization vs. net-new.)
5. Does `npm run validate` exist as an extensible lint target, or does Q1–Q4 need a new top-level script?
