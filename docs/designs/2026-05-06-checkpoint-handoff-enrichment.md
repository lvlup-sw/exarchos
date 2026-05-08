# Spike: enrich `/exarchos:checkpoint` persisted state with handoff context

**Issue:** #1239
**Workflow:** `spike-checkpoint-handoff-enrichment` (discovery)
**Date:** 2026-05-06
**Status:** Implemented in `feature/v29-bug-cluster` (PR pending). Production wiring lives in `docs/designs/2026-05-08-checkpoint-handoff-bundle.md`; this doc is preserved for the original spike rationale.

## v2.9.0 bug-context that constrains this design

Three open milestone-14 bugs sit underneath the proposal and force concrete schema and dispatch choices. The recommendation has been adjusted to avoid compounding them.

| Issue | Constraint imposed on this design |
|---|---|
| **#1230** — event store assigns duplicate per-event `sequence` numbers; corrupts incremental rehydration fold | Handoff entries MUST NOT key by `event.sequence`. Key by `event.id` (canonical opaque) and carry `event.timestamp` for ordering. `eventSequence` is admissible only as an advisory hint, explicitly labeled non-unique pending #1230. |
| **#1228** — `batch_append` returns `success: true` while silently dropping events; idempotencyKey stays claimed | Handoff-bearing checkpoint MUST use a payload-digest-derived idempotencyKey, not the existing `${featureId}:checkpoint:${phase}:${_version}` form. Otherwise a second checkpoint within the same phase carrying refined handoff content is silently deduped. |
| **#1226** — `workflow_status` returns `tasksCompleted > tasksTotal` from inconsistent counter sources | Cross-reference only; reinforces the replay-reconstructable invariant the design already commits to. No schema change needed. |

These are not blockers for the spike (the design is forward-compatible); they are blockers for **landing production wiring** of the recommendation.

## Problem

`workflow.checkpoint` today persists a structural snapshot (operation counter, phase, projection sequence, snapshot record). Free-text handoff content — the *why*, the recent learnings, the deferred items, the next-action list — lives outside the event store, in ad-hoc context docs like `docs/contexts/2026-05-07-p4-shepherd-handoff.md`. A future session that runs `/rehydrate` recovers structural state but not operational context.

## Recommendation summary

Enrich `WorkflowCheckpointData` with three optional fields — `context`, `nextSteps`, `suggestions` — bounded in length, projected by the rehydration reducer into a top-level `latestHandoff` and capped `recentHandoffs[]` window. Single dispatch path for CLI and MCP. Fail-closed at write, fail-open at read.

## Cross-cutting compliance (#1109)

| Constraint | Compliance |
|---|---|
| C1 — event-sourcing integrity | Handoff payload rides on `workflow.checkpoint`. Replaying events reconstructs the same `latestHandoff`. No projection-only divergence. |
| C2 — MCP parity | Single Zod schema (`WorkflowCheckpointData`); CLI flags and MCP args bind to identical fields via the existing dispatch core (`workflow/tools.ts handleCheckpoint`). |
| C3 — basileus-forward | Handoff is keyed by `(streamId, eventSequence)` — addressable across remote-coordinated workflows; the existing rehydration delivery enum (`direct \| ndjson \| snapshot`) carries it untouched. |

## Backend-quality compliance (axiom)

| Dimension | Constraint applied to this design |
|---|---|
| DIM-1 Topology | One writer (`handleCheckpoint`), one event type (`workflow.checkpoint`), one projection (`rehydrationReducer`). No parallel storage path. |
| DIM-2 Observability | Schema-rejected payloads return a structured `VALIDATION_ERROR`; corrupt projection state surfaces as a `degraded` blocker, not a silent null. |
| DIM-3 Contracts | All fields under existing Zod schemas. `WorkflowCheckpointData` schema bumped via additive optional fields — no breaking change to historical events. |
| DIM-4 Test fidelity | Roundtrip integration test exercises the same `eventStore` + projection store wiring as production. |
| DIM-5 Hygiene | Removes the implicit `docs/contexts/*.md` parallel-doc pattern by giving the event store a first-class home for the same content. |
| DIM-7 Resilience | Per-field byte caps + bounded `recentHandoffs` window — handoff growth cannot bloat the rehydration envelope unboundedly. |
| DIM-8 Prose quality | Schema-level length caps discourage AI-padded content; doc-tooling can lint the field at write time (out of scope for the spike). |

## Investigation questions

### Q1. Schema shape

**Recommendation.** Three distinct optional fields under `WorkflowCheckpointData`:

```ts
const HandoffSchema = z.object({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
});

WorkflowCheckpointData = WorkflowCheckpointData.extend({
  handoff: HandoffSchema.optional(),
});
```

**Rationale.** The motivating doc (P4 shepherd handoff) cleanly separates situational color (`### 1. WORKFLOW_STATE_DIR …`), procedural lessons (`### 3. Rebase pattern …`), and a prioritized action list (`## Suggested first steps`). A single `handoff: string` field would force consumers to re-parse free text. Three keys preserve the structure without the overhead of a typed AST.

**Caps.** 2 KB per `context`, 256 B × 10 entries per list. Total ≤ 7 KB ≈ 1.7 K tokens. Empirically the P4 handoff doc is ~3.5 KB after stripping markdown — comfortably under cap.

**Defer.** Markdown-aware rendering (links, code fences) is a presentation concern for the rehydrate consumer; the schema stays opaque-string.

### Q2. Source

**Recommendation.** Author-supplied via `/checkpoint` arguments **only** for the spike. CLI:

```bash
exarchos workflow checkpoint <featureId> \
  --summary "Phase exit: P4 shepherd" \
  --context "@docs/contexts/2026-05-07-p4-shepherd-handoff.md" \
  --next-steps "Rebase --onto origin/main <boundary>" \
  --next-steps "Run npm run test:process to validate state-dir fix"
```

The `@<path>` convention reads file contents inline — same precedent as Claude Code's argument substitution.

**Rationale.** Auto-summarization is explicitly out-of-scope per the issue. Author-supplied content has clear provenance (the operator) and a clear quality bar (the operator decides when it is right).

**Defer.** Auto-summary as a follow-up issue. A reasonable shape: a sibling `workflow.handoff_summarized` event sourced from a downstream summarizer agent, folded over `latestHandoff` only when the operator did not supply one.

### Q3. Lifecycle

**Recommendation.** Each `workflow.checkpoint` event with a non-empty `handoff` writes a fresh entry. The rehydration projection exposes:

- `latestHandoff` — the single most-recent non-empty handoff, plus its `eventSequence` and `timestamp`.
- `recentHandoffs[]` — a bounded ring buffer (default N=3) of the most-recent non-empty handoffs.

**Rationale.** Latest-wins is the common case (the next session needs *the current* situation, not history). The capped window costs ~6 K tokens at the 8 KB cap × 3, which is acceptable for the high-value rehydrate path. The full history remains in the event stream for forensics — same trust boundary as any other event-sourced field.

**Pruning.** None at the projection layer. The window is bounded by the reducer; the event log retains everything. If a workflow accumulates >100 handoffs and operators want history truncated, that is a separate event-log retention policy, not a handoff concern.

### Q4. Persistence layer

**Recommendation.** Enrich `WorkflowCheckpointData` (event-sourced). No new event type. No projection-only path.

**Rationale.**

- A dedicated `workflow.handoff` event would split the 1:1 relationship between *checkpointing* and *handing off* — operators would need to remember both calls. Coupling them keeps the writer ergonomic.
- A projection-only field would violate Constraint 1 (event-sourcing integrity) — replaying events would not reconstruct the handoff.
- The existing `handleCheckpoint` in `workflow/tools.ts` already runs the snapshot materialization on append; adding handoff payload extends that path with zero new control flow.

**Schema migration.** Additive — historical events without `handoff` parse cleanly under `z.optional()`. Snapshot records carrying old `RehydrationDocument` shapes parse cleanly under additive volatile-section keys (the existing `.strict()` on `VolatileSectionsSchema` blocks unknown siblings, so this requires a `VolatileSectionsSchema` rev — see Q8).

**Idempotency key — adjusted for #1228.** The current `handleCheckpoint` uses `${featureId}:checkpoint:${phase}:${state._version}`. With handoff content as a first-class field, an operator iterating on a payload (call checkpoint, refine, call again before any version-bumping action) collides on this key — the second call returns success while the new handoff is silently dropped (the #1228 footgun). Switch to:

```ts
idempotencyKey: `${featureId}:checkpoint:${phase}:${_version}:${handoffDigest}`
// where handoffDigest = sha256(JSON.stringify(handoff ?? {})).slice(0, 16)
```

A no-handoff checkpoint keeps the prior key shape (digest of `{}` is stable). A handoff-bearing checkpoint keys uniquely on payload, so refinement calls land. This change is independent of the schema enrichment and can ship first.

### Q5. Rehydrate surface

**Recommendation.** Top-level fields on `RehydrationDocument`, **not** folded into `behavioralGuidance`.

```ts
VolatileSectionsSchema = z.object({
  // …existing fields…
  latestHandoff: HandoffEntrySchema.optional(),
  recentHandoffs: z.array(HandoffEntrySchema).max(3).default([]),
}).strict();
```

**Rationale.** `behavioralGuidance` is **declarative** — derived from skill metadata, stable across sessions for the same phase. Handoff is **situational** — operator-authored, volatile per checkpoint. Conflating them muddles the contract (DIM-3): consumers that just want the skill ref would have to ignore handoff content; consumers that want handoff would have to extract it from a free-form blob. Top-level siblings preserve the read-shape.

`HandoffEntrySchema` carries the three handoff fields plus an `eventRef` block so consumers can correlate against the event log without re-querying:

```ts
HandoffEntrySchema = HandoffSchema.extend({
  eventRef: z.object({
    id: z.string(),                                      // canonical opaque event id (unique)
    timestamp: z.string(),                               // wall-clock ordering
    sequence: z.number().int().optional(),               // advisory only — see note
  }),
});
```

**Why not key by `sequence`.** Bug #1230 demonstrates per-event `sequence` is currently non-unique and non-monotonic (workflow `preflight-data-migration` has 60 sequences appearing twice; max sequence diverges from snapshot sequence by ~56). Keying `latestHandoff.eventRef` on `sequence` would mean a `recentHandoffs[]` window with two entries claiming the same coordinate — a contract violation (DIM-3). The opaque `event.id` is the only durably-unique field today. Once #1230 lands, `sequence` becomes admissible as the primary key and the schema can deprecate `eventRef.id` via a `v: 2` envelope rev — but until then it stays advisory.

### Q6. Cross-runtime

**Recommendation.** Identical shape, single dispatch core. The `workflow/tools.ts` `handleCheckpoint` path already serves both facades (the `exarchos_workflow_checkpoint` MCP tool and the `exarchos workflow checkpoint` CLI subcommand both bottom out here). Add the handoff fields to its input schema and they appear symmetrically.

**Rationale.** Constraint 2 falls out of the existing topology — there is no MCP-side or CLI-side handoff branch. CLI flags are a thin presentation layer that constructs the same `CheckpointInput` object MCP receives.

**Verification gate.** Add a `assertParity` test pair (one CLI invocation, one MCP invocation, identical args, byte-equal output envelope after stripping timestamps).

### Q7. Token economics

**Recommendation.** No new TTL or cache-hint plumbing. Projection sequencing is already the cache-coherency mechanism (snapshot + tail-fold). The handoff window is bounded by length cap × N entries, so the rehydration envelope grows by at most ~6 K tokens.

**Optional gate.** If consumers want a slim envelope (e.g. for repeated polling), introduce `?include=handoff` on the rehydrate action — defaulting to `true` for direct delivery, `false` for ndjson streaming. **Defer** — only do this once measurement shows the unconditional inclusion is too expensive in practice.

**Rationale.** The rehydration document today is small (≤2 KB for typical workflows). Adding ~6 KB upper-bound is a 4× envelope budget the system has headroom for. Prematurely splitting the read path would add a topology branch (DIM-1) for a hypothetical cost.

### Q8. Failure mode

**Recommendation.** Asymmetric — fail-closed at write, fail-open at read.

- **Write side.** A malformed `handoff` payload (oversized, non-string, schema-violating) fails the entire `workflow.checkpoint` append with `VALIDATION_ERROR`. The operator learns immediately. The counter is not reset. The structural snapshot is not written.

- **Read side.** A handoff entry that fails schema parse during projection fold (e.g. the schema was tightened in a later version, an old event has a now-invalid shape) yields `latestHandoff: undefined` and appends a structured `degraded` blocker entry to the rehydration document — exactly the path `buildDegradedResponse` already takes for reducer-throw degradation (DR-18).

**Rationale.** Write-time failure is recoverable — the operator retries with a fixed payload. Read-time failure on a historical event is unrecoverable — failing the rehydrate would orphan the workflow. The DR-18 precedent already establishes the read-side fail-open posture.

**Schema versioning.** `VolatileSectionsSchema` already has a `.strict()` boundary; adding the handoff fields requires a schema rev. Approach:

1. New optional fields are additive — old documents missing them still parse.
2. The strict guard on volatile sections needs the new keys allow-listed; this is a ratcheting change but not a breaking one.
3. No `v: 2` envelope bump is required — `v: 1` widens additively. (If a future change *removes* a volatile field, that does need `v: 2`.)

## POC validation

Below is a roundtrip the spike must demonstrate. Implementation lives behind a feature branch; the spike does not commit it to the production schema.

### Step 1 — extend the schema (POC patch)

```ts
// servers/exarchos-mcp/src/event-store/schemas.ts
const HandoffEntryData = z.object({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
});

export const WorkflowCheckpointData = z.object({
  counter: z.number().int(),
  phase: z.string(),
  featureId: z.string(),
  handoff: HandoffEntryData.optional(),  // NEW
});
```

### Step 2 — reducer fold (POC patch)

```ts
// servers/exarchos-mcp/src/projections/rehydration/reducer.ts
case 'workflow.checkpoint':
  return applyWorkflowCheckpoint(state, event);

function applyWorkflowCheckpoint(state, event) {
  const handoff = event.data?.handoff;
  if (!handoff || isEmptyHandoff(handoff)) return state;
  // Key by event.id (canonical opaque, durably unique). event.sequence carried
  // only as an advisory hint pending #1230 — DO NOT dedupe on it.
  const entry = {
    ...handoff,
    eventRef: {
      id: event.id,
      timestamp: event.timestamp,
      sequence: event.sequence,
    },
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    latestHandoff: entry,
    recentHandoffs: [entry, ...state.recentHandoffs].slice(0, 3),
  };
}
```

### Step 3 — write→read roundtrip test

```ts
it('persists handoff via checkpoint and recovers it via rehydrate', async () => {
  await handleInit({ featureId, workflowType: 'discovery' }, ctx);
  await handleCheckpoint(
    {
      featureId,
      summary: 'spike validation',
      handoff: {
        context: 'WORKFLOW_STATE_DIR is the load-bearing env var',
        nextSteps: ['Rebase --onto origin/main <boundary>'],
        suggestions: ['Cross-reference SHAs in CodeRabbit threads'],
      },
    },
    ctx,
  );
  const doc = await handleRehydrate({ featureId }, ctx);
  expect(doc.latestHandoff?.context).toMatch(/WORKFLOW_STATE_DIR/);
  expect(doc.recentHandoffs).toHaveLength(1);

  // #1228 verification — `success: true` is not enough; query the stream to
  // confirm the event actually landed. Without this assertion a silent drop
  // (idempotencyKey poison) would let the test pass while the projection sat
  // empty.
  const events = await ctx.eventStore.query(featureId, { type: 'workflow.checkpoint' });
  expect(events).toHaveLength(1);
  expect(events[0].data.handoff?.context).toMatch(/WORKFLOW_STATE_DIR/);
});

it('refining handoff in same phase lands a second event (#1228 regression)', async () => {
  // Same phase, same _version — the prior idempotencyKey shape would dedupe
  // this. Payload-digest keying must let it through.
  await handleCheckpoint({ featureId, handoff: { context: 'first' } }, ctx);
  await handleCheckpoint({ featureId, handoff: { context: 'second' } }, ctx);
  const events = await ctx.eventStore.query(featureId, { type: 'workflow.checkpoint' });
  expect(events).toHaveLength(2);
  const doc = await handleRehydrate({ featureId }, ctx);
  expect(doc.latestHandoff?.context).toBe('second');
  expect(doc.recentHandoffs.map(h => h.context)).toEqual(['second', 'first']);
});
```

### Step 4 — replay reconstruction test (Constraint 1)

```ts
it('reconstructs latestHandoff from event replay alone', async () => {
  // … emit two checkpoint events with distinct handoff payloads …
  const events = await eventStore.query(featureId);
  const fresh = events.reduce(rehydrationReducer.apply, rehydrationReducer.initial);
  expect(fresh.latestHandoff?.context).toBe(secondPayload.context);
  expect(fresh.recentHandoffs.map(h => h.context))
    .toEqual([secondPayload.context, firstPayload.context]);
});
```

## Out-of-scope (per issue)

- Final wiring to the `/exarchos:checkpoint` skill argument-parsing layer.
- Auto-summarization of recent events into a handoff payload.
- Concurrent-checkpoint conflict semantics across parallel sessions.
- A markdown-aware rendering layer for the rehydration consumer.

## Open follow-up issues

All filed in milestone v2.9.0 alongside this spike.

- **#1240** — production wiring of the spike recommendation (the top-level implementation issue that consumes this design).
- **#1241** — idempotencyKey payload-digest fix. **Hard blocker for #1240** — must ship first or in the same PR; without it, refining handoff within the same phase is silently deduped (#1228 footgun).
- **#1242** — F1: auto-summarized handoff fallback (`workflow.handoff_summarized` event).
- **#1243** — F2: `?include=handoff` rehydrate gate; deferred until measurement shows unconditional inclusion is too expensive.
- **#1244** — F3: markdown / prose lint at handoff write time (DIM-8 enforcement).
- **#1245** — F4: `@<path>` argument substitution on `exarchos workflow checkpoint --context`.
- **#1246** — F5: promote `eventRef.sequence` from advisory to primary key once #1230 lands; bumps `RehydrationDocument` envelope to `v: 2`.

## Decision log

| Decision | Alternative considered | Why rejected |
|---|---|---|
| Three keys (`context`, `nextSteps`, `suggestions`) | Single `handoff: string` blob | Forces consumers to re-parse free text; loses the structure already present in motivating examples. |
| Enrich existing `workflow.checkpoint` event | New `workflow.handoff` event | Splits 1:1 relationship between checkpointing and handing off; doubles the writer-side API. |
| Top-level `latestHandoff` + `recentHandoffs[]` | Folded into `behavioralGuidance` | Conflates declarative skill data with situational operator-authored content. |
| Fail-closed write / fail-open read | Symmetric fail-open | Write-time failure is recoverable by retry; making it silent would propagate corrupt payloads into the projection. |
| Bounded window (N=3) | Unbounded `handoffs[]` array | Token-economic risk on long-running workflows; full history remains addressable via event-log query. |
| Key `eventRef` by `event.id` (opaque) | Key by `event.sequence` | #1230 demonstrates `sequence` is currently non-unique. Keying on it would let `recentHandoffs[]` carry colliding coordinates. Revisit after #1230 (F5). |
| Idempotency key includes `handoffDigest` | Reuse `${featureId}:checkpoint:${phase}:${_version}` | Without payload-digest, refinement calls within the same phase silently no-op (worsened by #1228's idempotencyKey poisoning). |

## Verification checklist (#1109 PR section)

- [x] Event-sourcing: `workflow.checkpoint` carries handoff payload; `rehydrationReducer` folds it deterministically.
- [x] MCP parity: CLI and MCP route through `handleCheckpoint`; identical input shape.
- [x] Basileus-forward: handoff is keyed by `(streamId, eventSequence)`; addressable across transports.
- [x] Capability resolution: no yaml-runtime read; no new capability surface introduced.
