# Checkpoint-handoff bundle: production wiring + v:2 envelope migration + auto-emitted events surface

**Date:** 2026-05-08
**Workflow:** `checkpoint-handoff-enrichment-bundle` (feature)
**Bundle:** #1240 (foundation) + #1246 (eventRef.sequence promotion) + #1227 (auto-emitted events surface)
**Spike substrate:** `docs/designs/2026-05-06-checkpoint-handoff-enrichment.md` (extends, does not replace)
**Status:** Design — ready for `/plan`.

## Context

Three issues compose to "the checkpoint-handoff feature lands at v:2":

1. **#1240** — production wiring of the spike's recommendation. Adds `HandoffSchema` to `WorkflowCheckpointData`, `latestHandoff`/`recentHandoffs` to `VolatileSectionsSchema`, an `applyWorkflowCheckpoint` reducer handler, and CLI flags `--context` / `--next-steps` / `--suggestions`.
2. **#1246** — promotes `HandoffEntrySchema.eventRef.sequence` from advisory to primary key. **Now unblocked** because #1230 (event-store sequence-uniqueness) shipped on `feature/v29-bug-cluster`.
3. **#1227** — fixes the conveyance gap between playbook prose ("`task_complete` emits the event") and the typed `events` array (which excludes `task.completed`/`task.failed` because they're auto-emitted, by design). Surfaces auto-emitted events as a sibling contract.

Hard blockers #1230 (sequence-uniqueness) and #1241 (idempotencyKey payload-digest) are both **closed**. The bundle is unblocked.

## Decisions taken in this ideation pass

The spike doc resolves most of the design space. Three open decisions resolved here:

| Decision | Choice | Rationale |
|---|---|---|
| **Q-V2** — eventRef.id deprecation in v:2 | **Strict — remove entirely** | Cleanest contract; smallest wire size (the issue's stated motivation). All in-tree consumers controlled; no external readers identified that look up handoff by id. |
| **Q-REV** — schema rev sequencing | **Single v:2 bump for the whole bundle** | Cleaner history; no v:1-with-handoff transient state on disk; readers know v:2 implies both features composing. |
| **Q-AUTO** — #1227 fix shape | **Sibling `autoEmittedEvents` field on playbook** | Schema-level surfacing; closes the dogfood-adherence false-flag symptom; preserves the existing "model never emits these directly" invariant. |

## Schema diff (consolidated v:2)

### Event-store layer

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

Additive on the event payload. Historical `workflow.checkpoint` events without `handoff` parse cleanly under `z.optional()`. **No `WorkflowCheckpointData` version** field — the event payload itself stays unversioned; only the rehydration projection envelope is versioned.

### Rehydration envelope (v:2, strict deprecation)

```ts
// servers/exarchos-mcp/src/projections/rehydration/schema.ts

// v:1 entry shape — used only by the read-back path; not constructed by writers.
const HandoffEntrySchemaV1 = z.object({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
  eventRef: z.object({
    id: z.string(),                        // PRIMARY in v:1
    timestamp: z.string(),
    sequence: z.number().int().optional(), // advisory in v:1 (#1230 era)
  }),
});

// v:2 entry shape — sequence is primary; id removed.
const HandoffEntrySchemaV2 = z.object({
  context: z.string().max(2048).optional(),
  nextSteps: z.array(z.string().max(256)).max(10).optional(),
  suggestions: z.array(z.string().max(256)).max(10).optional(),
  eventRef: z.object({
    sequence: z.number().int().nonnegative(), // PRIMARY in v:2
    timestamp: z.string(),
  }),
});

// Migration helper: v:1 entry → v:2 entry on read. Drops `eventRef.id`.
function upgradeHandoffEntryV1toV2(e: z.infer<typeof HandoffEntrySchemaV1>): z.infer<typeof HandoffEntrySchemaV2> {
  if (typeof e.eventRef.sequence !== 'number') {
    // v:1 docs written before #1230 fix may have non-monotonic sequence.
    // Fail-open per DR-18: drop the entry rather than fail the whole rehydrate.
    throw new HandoffEntryUpgradeError('v1 entry missing usable sequence');
  }
  return {
    context: e.context,
    nextSteps: e.nextSteps,
    suggestions: e.suggestions,
    eventRef: { sequence: e.eventRef.sequence, timestamp: e.eventRef.timestamp },
  };
}

// Volatile sections — gains the two handoff fields, strict-rejects the v:1 keys
// at v:2 boundary so writers cannot accidentally produce mixed-version output.
export const VolatileSectionsSchema = z.object({
  taskProgress: z.array(TaskProgressEntrySchema),
  decisions: z.array(DecisionEntrySchema),
  artifacts: ArtifactsSchema,
  blockers: z.array(BlockerEntrySchema),
  nextAction: VolatileNextActionSchema.optional(),
  latestHandoff: HandoffEntrySchemaV2.optional(),                 // NEW
  recentHandoffs: z.array(HandoffEntrySchemaV2).max(3).default([]), // NEW
}).strict();

// Top-level envelope — v:2 literal, no union (single-target).
export const RehydrationDocumentSchema = z.object({
  v: z.literal(2),
  projectionSequence: z.number().int().nonnegative(),
}).merge(StableSectionsSchema).merge(VolatileSectionsSchema);
```

### Read-side migration path

The reducer's `apply()` is unchanged in topology. The single change is at the **snapshot read boundary**: when loading a stored projection document, detect `v: 1` and run `upgradeRehydrationDocumentV1toV2` (composes the per-entry upgrade above plus envelope v-bump). All in-memory state thereafter is v:2-shaped.

```ts
// servers/exarchos-mcp/src/projections/rehydration/serialize.ts
export function loadRehydrationDocument(raw: unknown): RehydrationDocument {
  const probe = z.object({ v: z.union([z.literal(1), z.literal(2)]) }).safeParse(raw);
  if (!probe.success) throw new InvalidEnvelopeError(probe.error);
  if (probe.data.v === 2) return RehydrationDocumentSchema.parse(raw);
  return upgradeRehydrationDocumentV1toV2(RehydrationDocumentSchemaV1.parse(raw));
}
```

This is a **read-only** migration — no on-disk rewrite. New writes are always v:2. Old v:1 snapshots stay on disk; they're upgraded on every read until naturally retired (snapshot turnover via the existing snapshot-cadence policy).

### Reducer fold (v:2 only)

```ts
// servers/exarchos-mcp/src/projections/rehydration/reducer.ts
case 'workflow.checkpoint':
  return applyWorkflowCheckpoint(state, event);

function applyWorkflowCheckpoint(state, event) {
  const handoff = event.data?.handoff;
  if (!handoff || isEmptyHandoff(handoff)) return state;
  // Key by event.sequence — v:2 contract. #1230 guarantees uniqueness.
  const entry: HandoffEntryV2 = {
    context: handoff.context,
    nextSteps: handoff.nextSteps,
    suggestions: handoff.suggestions,
    eventRef: { sequence: event.sequence, timestamp: event.timestamp },
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    latestHandoff: entry,
    recentHandoffs: [entry, ...state.recentHandoffs].slice(0, 3),
  };
}
```

### Dispatch core (#1240)

`servers/exarchos-mcp/src/workflow/tools.ts handleCheckpoint` adds `handoff` to its input schema. CLI flags translate identically:

```bash
exarchos workflow checkpoint <featureId> \
  --summary "Phase exit: P4 shepherd" \
  --context "P4 shepherd loop ran for the v2.9 release branch; rebase boundary is the last green commit on main pre-merge-train, and the state-dir fix is gated on the npm run test:process Windows path." \
  --next-steps "Rebase --onto origin/main <boundary>" \
  --next-steps "Run npm run test:process to validate state-dir fix" \
  --suggestions "Cross-reference SHAs in CodeRabbit threads"
```

> **`--context` accepts inline strings only.** The `@<path>` substitution form (loading `--context` from a file) is **out of scope** for T5 and tracked separately under #1245 / v2.12.0. Operators wanting file-backed context must inline the relevant excerpt today.

Idempotency key adopts the spike's payload-digest form (#1241 already shipped this; verify on read):

```ts
idempotencyKey: `${featureId}:checkpoint:${phase}:${_version}:${handoffDigest}`
// where handoffDigest = sha256(JSON.stringify(handoff ?? {})).slice(0, 16)
```

The `@<path>` substitution on `--context` is **not** part of this bundle (it was relabeled to v2.12.0 as #1245). For this PR `--context` accepts only inline strings.

### Playbook contract (#1227)

```ts
// servers/exarchos-mcp/src/workflow/playbooks.ts

interface EventInstruction {
  type: string;
  when: string;
  fields?: readonly string[];
}

// NEW — sibling to events, not part of it.
interface AutoEmittedEventInstruction extends EventInstruction {
  source: 'auto';
  emittedBy: string;  // e.g. 'exarchos_orchestrate task_complete'
}

interface PhaseRegistration {
  phase: string;
  workflowType: string;
  // …existing fields…
  events: readonly EventInstruction[];                    // model-emitted (unchanged contract)
  autoEmittedEvents?: readonly AutoEmittedEventInstruction[]; // NEW — runtime-emitted
}

// Existing model-emitted contract: derived from getRegisteredEventTypes
// filtered to source === 'model'. Unchanged.
events: delegatePhaseEvents('delegate'),

// NEW companion: derived from the same registry filtered to source === 'auto'.
autoEmittedEvents: delegateAutoEmittedEvents('delegate'),
```

Auto-emitted-events function mirrors `delegatePhaseEvents` structurally:

```ts
function delegateAutoEmittedEvents(phase: 'delegate' | 'overhaul-delegate'): readonly AutoEmittedEventInstruction[] {
  return getRegisteredEventTypes(phase)
    .filter((type) => EVENT_EMISSION_REGISTRY[type as EventType] === 'auto')
    .map((type) => {
      const meta = DELEGATE_PHASE_AUTO_EVENT_METADATA[type];
      if (!meta) throw new Error(/* same SoT-consistency message */);
      return { type, source: 'auto' as const, ...meta };
    });
}

const DELEGATE_PHASE_AUTO_EVENT_METADATA: Readonly<Record<string, Pick<AutoEmittedEventInstruction, 'when' | 'fields' | 'emittedBy'>>> = {
  'task.completed': {
    when: 'After task_complete orchestrate action succeeds',
    fields: ['taskId', 'evidence', 'verified', 'files', 'implements'],
    emittedBy: 'exarchos_orchestrate task_complete',
  },
  'task.failed': {
    when: 'After task_fail orchestrate action',
    fields: ['taskId', 'error', 'diagnostics'],
    emittedBy: 'exarchos_orchestrate task_fail',
  },
};
```

Dogfood-adherence checks now consume both lists; agents reading the contract see the full picture; the existing comment at `playbooks.ts:168-172` (warning against manual emission) stays load-bearing and accurate.

## Test plan (extends spike Step 3 + Step 4)

| Suite | What it proves | New for this PR |
|---|---|---|
| **Roundtrip** (`checkpoint.test.ts`) | write→read recovers handoff identical to input | YES (#1240) |
| **Refinement-doesn't-dedupe** (`checkpoint.test.ts`) | second checkpoint same phase, different handoff, lands a new event | YES (#1240) |
| **Replay reconstruction** (`reducer.test.ts`) | folding events alone reconstructs `latestHandoff`/`recentHandoffs` | YES (#1240) |
| **CLI/MCP parity** (`parity.test.ts`) | byte-equal output across facades for identical input | YES (#1240) |
| **eventRef.sequence is primary** (`reducer.test.ts`) | v:2 entries' `eventRef.sequence` matches `event.sequence`; no `id` field present | YES (#1246) |
| **v:1 → v:2 read migration** (`serialize.test.ts`) | loading a v:1 snapshot upgrades each entry, drops `eventRef.id`, returns v:2 envelope | YES (#1246) |
| **v:1 entry without sequence → fail-open** (`serialize.test.ts`) | malformed v:1 entry is dropped (DR-18 path), rest of doc loads | YES (#1246) |
| **No mixed-version output** (`schema.test.ts`) | v:2 envelope rejects entries containing `eventRef.id` | YES (#1246) |
| **Playbook autoEmittedEvents** (`playbooks.test.ts`) | delegate phase exposes `autoEmittedEvents` containing `task.completed` + `task.failed` with correct `emittedBy` | YES (#1227) |
| **SoT consistency** (`playbooks.test.ts`) | adding an `auto` event to the registry without a metadata entry throws at module load | YES (#1227) |
| **No duplicate emission** (`playbooks.test.ts`) | events ∩ autoEmittedEvents = ∅ for every phase | YES (#1227) |

## Cross-cutting compliance (#1109)

| Constraint | Compliance posture |
|---|---|
| **C1 — event-sourcing integrity** | Handoff payload rides `workflow.checkpoint`; replay reconstructs the same `latestHandoff`/`recentHandoffs` from events alone — verified by the dedicated replay-reconstruction test. v:2 promotion changes the projection envelope, NOT the event payload, so historical events replay unchanged. **Acknowledged asymmetry:** for *legacy v:1 snapshots* containing entries with no usable sequence (pre-#1230 advisory data), snapshot+tail-fold load drops those entries with a degraded blocker, while fresh replay-from-events would recover them. This is bounded degradation accepted as the cost of read-side fail-open (DR-18); the divergence window closes at natural snapshot turnover. A regression test asserts fresh-replay recovers entries that snapshot-load drops, making the asymmetry auditable rather than silent. |
| **C2 — MCP parity** | Single `handleCheckpoint` core; CLI flags and MCP args bind to the same `CheckpointInput`. Verified by parity test. |
| **C3 — basileus-forward** | Handoff keyed by `(streamId, eventSequence)` post v:2. Addressable across remote-coordinated workflows; rehydrate delivery enum (`direct \| ndjson \| snapshot`) carries v:2 envelopes untouched. |
| **C4 — capability resolution** | Bundle is schema/code-driven only. No `.exarchos.yml` or capability-yaml field is read at runtime by T1/T4/T6; all configuration flows through Zod-validated input schemas and the existing event-emission registry SoT. No new capability surface introduced. |

## Backend-quality compliance (axiom)

| Dimension | Posture |
|---|---|
| **DIM-1 Topology** | One writer (`handleCheckpoint`), one event type (`workflow.checkpoint`), one projection (`rehydrationReducer`), one read-side upgrade point (`loadRehydrationDocument`). No parallel storage path. |
| **DIM-2 Observability** | Schema-rejected payloads return structured `VALIDATION_ERROR`; v:1→v:2 upgrade failures append a `degraded` blocker (DR-18 path); auto-emitted events now declared in playbook contract for dogfood checks. |
| **DIM-3 Contracts** | Single envelope rev to v:2 with explicit migration; no mixed-version output; `autoEmittedEvents` formalizes a previously implicit contract. |
| **DIM-4 Test fidelity** | Roundtrip + replay tests use real eventStore + projection store wiring (no mocks); v:1→v:2 migration test uses a real v:1 snapshot fixture. |
| **DIM-5 Hygiene** | Removes ad-hoc `docs/contexts/*.md` parallel-doc pattern; consolidates handoff under the event store. |
| **DIM-6 Architecture** | Reducer's per-event handler stays single-responsibility; `autoEmittedEvents` discovery uses the same SoT registry-driven derivation as `events` (no duplication). |
| **DIM-7 Resilience** | Per-field byte caps + bounded `recentHandoffs` window; v:1 read path fails open per entry (drop bad ones, keep the rest). |
| **DIM-8 Prose quality** | Schema-level length caps in handoff fields (existing); `autoEmittedEvents` `emittedBy` strings give human readers a single-source reference for "what fires when." |

## Implementation plan (TDD task decomposition for /plan)

Suggested parallelization: T1 → T2 || T3 (parallel) → T4 → T5 || T6 (parallel) → T7. The bracketed tests are RED before code; GREEN follows.

**T1 — Schema additions (DIM-3)**
- Files: `event-store/schemas.ts`, `projections/rehydration/schema.ts`
- Adds `HandoffEntryData` to `WorkflowCheckpointData`; adds `HandoffEntrySchemaV2` + envelope `v: literal(2)` + volatile-section additions to rehydration schema; introduces `HandoffEntrySchemaV1` for read-back only.
- Tests: `schema.test.ts` — accepts v:2 docs with handoff, rejects mixed-version output, accepts v:1 entries via the V1 schema.

**T2 — Reducer handler (DIM-1)**
- File: `projections/rehydration/reducer.ts`
- Adds `applyWorkflowCheckpoint`; extends dispatcher; emits v:2 entries.
- Tests: `reducer.test.ts` — fold roundtrip, replay reconstruction, eventRef.sequence is primary.

**T3 — Read-side upgrade (DIM-7)**
- Files: `projections/rehydration/serialize.ts` (NEW or extend existing), `projections/rehydration/upgrade.ts` (NEW)
- Implements `loadRehydrationDocument` probe + `upgradeRehydrationDocumentV1toV2`.
- Tests: `serialize.test.ts` — v:1 → v:2 migration, fail-open on bad v:1 entries, v:2 passes through unchanged.

**T4 — Dispatch core wiring (DIM-1, C2)**
- File: `workflow/tools.ts handleCheckpoint`
- Extends input schema with `handoff`; passes through to event append.
- Tests: `checkpoint.test.ts` — write→read roundtrip, refinement doesn't dedupe.

**T5 — CLI flags (#1240 surface)**
- File: `cli-commands/workflow-checkpoint.ts` (or wherever `commander` registers the subcommand)
- Adds `--context`, `--next-steps` (multi), `--suggestions` (multi); maps to `CheckpointInput.handoff`.
- Tests: `parity.test.ts` — CLI invocation byte-equals MCP invocation.

**T6 — Playbook autoEmittedEvents (#1227)**
- File: `workflow/playbooks.ts`
- Adds `AutoEmittedEventInstruction` type, `delegateAutoEmittedEvents` derivation, `DELEGATE_PHASE_AUTO_EVENT_METADATA` map, `autoEmittedEvents` field on delegate-phase registrations.
- Tests: `playbooks.test.ts` — auto-emitted contract present, SoT-consistency check, events ∩ autoEmittedEvents = ∅.

**T7 — Integration sweep**
- Run full suite. Fix any cross-test fallout. Update `docs/designs/2026-05-06-checkpoint-handoff-enrichment.md` status to "Implemented in #<this-PR>".

## Out-of-scope

- **#1242** (auto-summarized handoff fallback) — relabeled to v2.11.0.
- **#1243** (`?include=handoff` query gate) — closed; reopen only after measurement.
- **#1244** (markdown-aware lint at write time) — relabeled to v2.10.0.
- **#1245** (`@<path>` substitution on `--context`) — relabeled to v2.12.0.
- **V1 schema retirement** — `HandoffEntrySchemaV1` and `RehydrationDocumentSchemaV1` are read-back-only exports with a defined retirement criterion: retire once on-disk v:1 doc count == 0 (verifiable via filesystem scan). Tracked as #1296 (v3.0.0).
- Auto-summarization of recent events.
- Concurrent-checkpoint conflict semantics across parallel sessions.

## Open questions

None. All design surface is resolved. Implementation-time questions (e.g., where exactly the `commander` registration lives for the checkpoint subcommand) will surface during T5 and don't change the design.

## Verification checklist (#1109 PR section)

- [ ] Event-sourcing: `workflow.checkpoint` carries handoff payload; `rehydrationReducer` folds it deterministically; replay reconstructs identical `latestHandoff`.
- [ ] MCP parity: CLI and MCP route through `handleCheckpoint`; identical input shape; parity test passes.
- [ ] Basileus-forward: handoff keyed by `(streamId, eventSequence)` in v:2; addressable across transports.
- [ ] Capability resolution: no yaml-runtime read; no new capability surface introduced.
- [ ] v:1 → v:2 read migration is read-only (no on-disk rewrite); v:1 entries without usable sequence fail-open per DR-18.
- [ ] `autoEmittedEvents` contract derived from same SoT registry as `events`; no duplicate listing across the two arrays.

## Decision log (this ideation)

| Decision | Choice | Rejected alternative | Why |
|---|---|---|---|
| eventRef.id deprecation | Strict — remove in v:2 | Soft (deprecated optional) | We control all consumers; no value in carrying dead field; smaller wire matches issue motivation. |
| Schema rev sequencing | Single v:2 bump for the bundle | Two micro-revs (v:1 additive, then v:2) | Avoids transient v:1-with-handoff state; readers know v:2 implies both features. |
| #1227 fix shape | `autoEmittedEvents` sibling field | Compactguidance prose only | Schema-level fix closes dogfood-adherence false flags; preserves "model never emits these" invariant; doesn't invite duplicate emissions. |

## Milestone target

Defer to `/synthesize` time. Bundle lives in **v2.10.0** (Agent Output Contract) since it's the home #1240 was relabeled to. Confirm at PR open.
