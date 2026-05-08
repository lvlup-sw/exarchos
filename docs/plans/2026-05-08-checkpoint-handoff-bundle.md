# Implementation Plan: Checkpoint-Handoff Bundle (#1240 + #1246 + #1227)

**Date:** 2026-05-08
**Workflow:** `checkpoint-handoff-enrichment-bundle`
**Design:** `docs/designs/2026-05-08-checkpoint-handoff-bundle.md`
**Base branch:** `feature/v29-bug-cluster`
**Target milestone:** v2.10.0 (defer until synthesize)
**Iron Law:** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

## Parallelization map

```
Wave 1 (foundation, parallel)        Wave 2 (parallel, depend on T1)
┌────────────┐  ┌────────────┐       ┌────────┐  ┌────────┐  ┌────────┐
│ T1 schema  │  │ T6 playbook│       │ T2     │  │ T3     │  │ T4     │
│ additions  │  │ auto-events│       │ reducer│  │ upgrade│  │ dispatch│
└────────────┘  └────────────┘       └────────┘  └────────┘  └────────┘
                                                                 │
                              Wave 3 (depends on T4)              ▼
                              ┌────────────────────────┐    ┌────────┐
                              │ T5 CLI flags + parity  │    │ ...    │
                              └────────────────────────┘    └────────┘
                                       │
                              Wave 4 (final integration)
                                       ▼
                              ┌────────────────────────┐
                              │ T7 integration sweep   │
                              └────────────────────────┘
```

**Wave 1:** T1 + T6 (independent)
**Wave 2:** T2 + T3 + T4 (all depend on T1)
**Wave 3:** T5 (depends on T4)
**Wave 4:** T7 (depends on all)

---

## Task 1: Schema additions (event-store + rehydration v:2)

**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/projections/rehydration/schema.ts`
**Tests:** `servers/exarchos-mcp/src/projections/rehydration/schema.test.ts`
**Branch:** `task/T1-schema-additions`

### Tests (RED first)

1. **`WorkflowCheckpointData_HandoffField_AcceptsValidPayload`** — parses event payload with full handoff (context + nextSteps + suggestions); rejects oversized context (>2048 bytes); rejects nextSteps array >10 entries.
2. **`WorkflowCheckpointData_NoHandoff_BackwardCompatible`** — historical events without `handoff` parse cleanly under `optional()`.
3. **`HandoffEntrySchemaV2_RequiresSequence_RejectsId`** — v:2 entry requires `eventRef.sequence` (nonneg int); rejects payloads containing `eventRef.id` (strict mode).
4. **`HandoffEntrySchemaV1_AllowsId_SequenceOptional`** — v:1 entry shape matches pre-#1230 advisory contract.
5. **`RehydrationDocumentSchema_V2Literal_RejectsV1Documents`** — `v: literal(2)`; v:1 docs rejected by main schema (read path uses separate V1 schema).
6. **`VolatileSectionsSchema_HandoffFields_StrictBoundary`** — `latestHandoff` optional, `recentHandoffs` defaults to `[]`, max 3 entries; unknown sibling keys rejected.

### Implementation (GREEN)

- `event-store/schemas.ts`: add `HandoffEntryData` z.object; extend `WorkflowCheckpointData` with `handoff: HandoffEntryData.optional()`.
- `projections/rehydration/schema.ts`:
  - Add `HandoffEntrySchemaV1` (id required, sequence optional advisory).
  - Add `HandoffEntrySchemaV2` (sequence required nonneg, NO id).
  - Extend `VolatileSectionsSchema` with `latestHandoff: HandoffEntrySchemaV2.optional()` + `recentHandoffs: z.array(HandoffEntrySchemaV2).max(3).default([])`.
  - Bump envelope: `v: z.literal(1)` → `v: z.literal(2)`.
  - Export `RehydrationDocumentSchemaV1` (frozen v:1 envelope shape) for read-back path.
  - Update `initialRehydrationDocument` to satisfy v:2 (recentHandoffs default).

### REFACTOR

Inline the V1/V2 entry schemas if they share enough fields via `.merge()`; preserve readability over DRY if the merge obscures the contract.

**Dependencies:** None (foundation).
**Parallelizable:** Yes (Wave 1 with T6).

---

## Task 2: Reducer handler `applyWorkflowCheckpoint`

**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`
**Tests:** `servers/exarchos-mcp/src/projections/rehydration/reducer.test.ts`
**Branch:** `task/T2-reducer-handler`

### Tests (RED first)

1. **`applyWorkflowCheckpoint_NonEmptyHandoff_SetsLatestHandoff`** — single event with handoff → state.latestHandoff equals input fields; eventRef.sequence === event.sequence; eventRef.timestamp === event.timestamp; NO eventRef.id.
2. **`applyWorkflowCheckpoint_EmptyHandoff_NoStateChange`** — event with `handoff: undefined` or all-empty fields → state unchanged (no projectionSequence increment for handoff-empty events).
3. **`applyWorkflowCheckpoint_MultipleEvents_RecentHandoffsBoundedToThree`** — 5 sequential events → recentHandoffs.length === 3; ordering is most-recent-first (event 5, 4, 3).
4. **`applyWorkflowCheckpoint_ReplayFromInitial_ReconstructsLatest`** — fold a fresh stream of N events from `initialRehydrationDocument` → final state matches incremental fold (DR-3 replay invariant).
5. **`applyWorkflowCheckpoint_EventRefSequenceIsPrimary_NoIdField`** — assert by Object.keys that recentHandoffs entries' eventRef contain only {sequence, timestamp}; no `id` key.
6. **`applyWorkflowCheckpoint_FreshReplayRecoversSnapshotDroppedEntries`** — set up: a v:1 snapshot whose recentHandoffs include an entry with no usable sequence; the snapshot-load path drops it (T3 test 4 verifies). This test asserts fresh-replay-from-events of the SAME stream recovers that entry's content under v:2 (because the underlying `workflow.checkpoint` event has a valid post-#1230 sequence). Makes the C1 snapshot-vs-replay asymmetry auditable.

### Implementation (GREEN)

- Add `applyWorkflowCheckpoint(state, event)` to reducer.
- Extend dispatcher case in `apply()` for `'workflow.checkpoint'`.
- Define `isEmptyHandoff(handoff)` helper (all three fields undefined or empty).
- Construct v:2 entry: `{...handoffFields, eventRef: { sequence: event.sequence, timestamp: event.timestamp }}`.
- Return new state with `projectionSequence + 1`, `latestHandoff: entry`, `recentHandoffs: [entry, ...prev].slice(0, 3)`.

### REFACTOR

Extract entry construction into `toHandoffEntryV2(event)` if reducer body grows past 30 lines.

**Dependencies:** T1.
**Parallelizable:** Yes (Wave 2 with T3, T4).

---

## Task 3: Read-side v:1 → v:2 migration

**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/projections/rehydration/serialize.ts` (extend), `servers/exarchos-mcp/src/projections/rehydration/upgrade.ts` (NEW)
**Tests:** `servers/exarchos-mcp/src/projections/rehydration/upgrade.test.ts` (NEW), `serialize.test.ts` (extend if exists)
**Branch:** `task/T3-readside-migration`

### Tests (RED first)

1. **`upgradeHandoffEntryV1toV2_ValidEntry_DropsIdKeepsSequence`** — v:1 entry with both id and sequence → v:2 entry with only `eventRef: {sequence, timestamp}`; no id leaks.
2. **`upgradeHandoffEntryV1toV2_MissingSequence_ThrowsForFailOpen`** — v:1 entry with only id (pre-#1230 advisory-sequence-absent) → throws `HandoffEntryUpgradeError` so caller can drop it (DR-18 path).
3. **`upgradeRehydrationDocumentV1toV2_FullDocument_ReturnsV2Envelope`** — full v:1 doc → v:2 doc; v field is 2; all volatile sections preserved; latestHandoff/recentHandoffs upgraded entry-by-entry.
4. **`upgradeRehydrationDocumentV1toV2_SkipsBadEntries_DegradedBlocker`** — v:1 doc with one bad recentHandoffs entry → v:2 doc with that entry dropped from recentHandoffs; degraded blocker appended.
5. **`loadRehydrationDocument_V2Document_PassesThroughUnchanged`** — input is already v:2 → schema-parse passes through; no upgrade path invoked.
6. **`loadRehydrationDocument_V1Document_ReturnsV2Shape`** — input is v:1 → output has `v: 2`, no `eventRef.id` anywhere.
7. **`loadRehydrationDocument_InvalidEnvelope_ThrowsInvalidEnvelopeError`** — input has neither `v: 1` nor `v: 2` → typed error (not silent fallback).
8. **`upgradeRehydrationDocumentV1toV2_AllEntriesBad_ReturnsEmptyHandoffs`** — v:1 doc with all 3 recentHandoffs entries missing usable sequence → v:2 doc has empty recentHandoffs, undefined latestHandoff, blockers appended (one per dropped entry, or one summarizing — implementation choice but exercised); no exception escapes to caller. Covers the "every entry fails" corner that test 4 alone misses.

### Implementation (GREEN)

- New file `upgrade.ts`:
  - `class HandoffEntryUpgradeError extends Error`.
  - `upgradeHandoffEntryV1toV2(entry)` — drops id, requires sequence, throws on missing.
  - `upgradeRehydrationDocumentV1toV2(doc)` — folds entries via the per-entry upgrade; collects failures into degraded blockers; sets `v: 2`. MUST handle the all-entries-bad case without exception (test 8).
- Extend (or create) `serialize.ts loadRehydrationDocument(raw)`:
  - Probe `v` via narrow z.union schema.
  - v:2 → main schema.parse (pass-through).
  - v:1 → V1 schema.parse, then upgrade.
  - Bad envelope → throw `InvalidEnvelopeError`.

### Fixture provenance (DIM-4)

Capture at least one **real v:1 rehydration document** from a developer machine or CI cache and commit it to `servers/exarchos-mcp/src/projections/rehydration/__fixtures__/v1-real-snapshot.json` (with PII scrub if any operator-authored content is present). Use it as the input for `loadRehydrationDocument_V1Document_ReturnsV2Shape` alongside synthetic fixtures. Synthetic-only fixtures pass while real upgrades fail if the writer's actual output (field ordering, optional-field defaults, JSON formatting) diverges from what the test author imagined. If no real v:1 doc is reachable (e.g., the team has not yet snapshotted any v:1 workflows in non-volatile storage), document this in the test file's header comment and accept the fidelity risk explicitly.

### REFACTOR

If degraded-blocker construction duplicates an existing pattern (search `degradedBlocker` / `buildDegradedResponse` per spike doc DR-18 reference), reuse rather than reinvent.

**Dependencies:** T1.
**Parallelizable:** Yes (Wave 2 with T2, T4).

---

## Task 4: Dispatch core wiring (`handleCheckpoint`)

**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/workflow/tools.ts`
**Tests:** `servers/exarchos-mcp/src/workflow/checkpoint.test.ts`
**Branch:** `task/T4-dispatch-wiring`

### Tests (RED first)

1. **`handleCheckpoint_HandoffPayload_AppendsEventWithData`** — dispatch with `{handoff: {context, nextSteps, suggestions}}` → event store has one `workflow.checkpoint` event whose `data.handoff` matches input.
2. **`handleCheckpoint_HandoffPayload_RehydrationProjectsLatestHandoff`** — after dispatch, `handleRehydrate({featureId})` returns doc with `latestHandoff.context` matching input.
3. **`handleCheckpoint_RefinementSamePhase_LandsSecondEvent_1228Regression`** — two consecutive checkpoints, same phase, same `_version`, different handoff → BOTH events present in stream (idempotency-key payload-digest path); rehydrate's `recentHandoffs` has both entries; `latestHandoff` is the second.
4. **`handleCheckpoint_NoHandoff_BackwardCompatible`** — dispatch without handoff → event lands; no `data.handoff` field; rehydrate latestHandoff stays undefined.
5. **`handleCheckpoint_OversizedContext_ReturnsValidationError`** — context >2048 bytes → structured `VALIDATION_ERROR`; no event landed; counter not reset.

### Implementation (GREEN)

- Extend `CheckpointInput` Zod schema in `tools.ts` with `handoff: HandoffEntryData.optional()`.
- Pass `handoff` through to `WorkflowCheckpointData` constructed for `eventStore.append`.
- Verify idempotency-key payload-digest form is in place (#1241 already shipped — confirm no regression). If missing, restore: `idempotencyKey: \`${featureId}:checkpoint:${phase}:${_version}:${handoffDigest}\`` where `handoffDigest = sha256(JSON.stringify(handoff ?? {})).slice(0, 16)`.

### REFACTOR

If `handoffDigest` computation lives outside `handleCheckpoint`, extract to `event-store/idempotency.ts` helper.

**Dependencies:** T1.
**Parallelizable:** Yes (Wave 2 with T2, T3).

---

## Task 5: CLI flags (`--context`, `--next-steps`, `--suggestions`) + parity

**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/cli-commands/workflow-checkpoint.ts` (or wherever `commander` registers checkpoint — confirm at task start)
**Tests:** `servers/exarchos-mcp/src/parity.test.ts` (extend), CLI-specific tests if they exist
**Branch:** `task/T5-cli-flags`

### Tests (RED first)

1. **`CheckpointCli_ContextFlag_BindsToHandoffContext`** — CLI invocation with `--context "value"` → `CheckpointInput.handoff.context === "value"`.
2. **`CheckpointCli_NextStepsFlag_AcceptsMultiple`** — CLI invocation with two `--next-steps` flags → `handoff.nextSteps` is `['first', 'second']`.
3. **`CheckpointCli_SuggestionsFlag_AcceptsMultiple`** — CLI invocation with two `--suggestions` flags → `handoff.suggestions` is `['first', 'second']`.
4. **`CheckpointCli_NoHandoffFlags_OmitsHandoff`** — CLI invocation without any handoff flag → `CheckpointInput.handoff === undefined`.
5. **`CheckpointParity_McpCli_IdenticalEnvelope`** — same input via MCP and CLI → byte-equal output envelope after stripping timestamps.

### Implementation (GREEN)

- Locate the commander registration for `exarchos workflow checkpoint`. Add three flags:
  - `--context <string>` (single)
  - `--next-steps <string...>` (variadic)
  - `--suggestions <string...>` (variadic)
- Map flags to `CheckpointInput.handoff`. Omit `handoff` entirely if all three are absent (don't construct `{context: undefined, nextSteps: undefined, suggestions: undefined}` — let the optional field stay undefined).
- `@<path>` substitution is OUT OF SCOPE for this PR (#1245, v2.12.0). `--context` accepts inline strings only.

### REFACTOR

If CLI flag-to-input mapping duplicates a pattern from another subcommand, factor into `cli-commands/handoff-flags.ts`.

**Dependencies:** T1, T4.
**Parallelizable:** No (Wave 3, single-task).

---

## Task 6: Playbook `autoEmittedEvents` sibling field (#1227)

**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/workflow/playbooks.ts`
**Tests:** `servers/exarchos-mcp/src/workflow/playbooks.test.ts` (locate; create if missing)
**Branch:** `task/T6-auto-emitted-events`

### Tests (RED first)

1. **`PhaseRegistration_DelegatePhase_ExposesAutoEmittedEvents`** — feature.delegate phase output has `autoEmittedEvents` array containing entries for `task.completed` and `task.failed`.
2. **`AutoEmittedEvents_TaskCompleted_HasEmittedByMetadata`** — task.completed entry has `source: 'auto'`, `emittedBy: 'exarchos_orchestrate task_complete'`, `fields` includes `taskId, evidence, verified, files, implements`.
3. **`AutoEmittedEvents_TaskFailed_HasEmittedByMetadata`** — symmetric; `emittedBy: 'exarchos_orchestrate task_fail'`; `fields` includes `taskId, error, diagnostics`.
4. **`PhaseEvents_NoOverlapWithAutoEmitted_DelegatePhase`** — for the delegate phase, the intersection of `events` array types and `autoEmittedEvents` array types is empty.
5. **`AutoEmittedEvents_SoTConsistency_ThrowsOnMissingMetadata`** — adding an `auto`-source event to the registry without a `DELEGATE_PHASE_AUTO_EVENT_METADATA` entry causes module load to throw (mirrors existing model-event SoT check).
6. **`PhaseEvents_OverhaulDelegatePhase_ExposesAutoEmittedEvents`** — the `overhaul-delegate` phase variant also exposes its auto-emitted set (symmetric handling, since `delegatePhaseEvents` accepts both phases).

### Implementation (GREEN)

- Add `AutoEmittedEventInstruction` interface (extends `EventInstruction` with `source: 'auto'` + `emittedBy: string`).
- Extend `PhaseRegistration` interface with optional `autoEmittedEvents?: readonly AutoEmittedEventInstruction[]`.
- Add `DELEGATE_PHASE_AUTO_EVENT_METADATA` const map (task.completed, task.failed entries).
- Add `delegateAutoEmittedEvents(phase)` function — mirrors `delegatePhaseEvents` filtered to `source === 'auto'`.
- Wire `autoEmittedEvents: delegateAutoEmittedEvents('delegate')` on the feature.delegate registration; same for any other delegate-equivalent phase (overhaul-delegate per the existing function signature).

### REFACTOR

The two derivation functions (`delegatePhaseEvents` for model, `delegateAutoEmittedEvents` for auto) share filter+map structure. Factor into a generic `derivePhaseEvents(phase, sourceFilter, metadataMap, errorMessage)` if duplication is meaningful — only do this if the metadata maps share an interface; otherwise duplication is clearer.

**Dependencies:** None (independent of bundle's other tasks).
**Parallelizable:** Yes (Wave 1 with T1).

---

## Task 7: Integration sweep + design-doc status update

**Phase:** Verification only — no new tests
**Files:** Full suite + `docs/designs/2026-05-06-checkpoint-handoff-enrichment.md`
**Branch:** `task/T7-integration-sweep`

### Steps

1. Run full test suite: `npm run test:run` (root) + `cd servers/exarchos-mcp && npm run test:run`.
2. Run typecheck: `npm run typecheck`.
3. Fix any cross-test fallout (e.g., test fixtures that hardcoded v:1 envelope shape).
4. Run skills guard: `npm run skills:guard` (verify no skill content broke).
5. Update `docs/designs/2026-05-06-checkpoint-handoff-enrichment.md` status header from "Spike — design + POC. Not production wiring." to "Implemented in feature/v29-bug-cluster (PR <pending>)." Defer the PR number until synthesize.
6. Verify `feature/v29-bug-cluster` branch is rebased on `main` if more than 24h has elapsed since the last rebase (per project's PR ops conventions).

**Dependencies:** T1, T2, T3, T4, T5, T6 (all).
**Parallelizable:** No (final integration).

---

## Test fixture inventory (cross-cutting)

These fixtures need to exist for the test suite. T1 introduces, T2/T3 consume:

- **Valid v:2 rehydration document** — minimal envelope with one handoff entry, used as positive case in schema + reducer tests.
- **Valid v:1 rehydration document with both id and sequence** — for upgrade happy path.
- **Valid v:1 rehydration document with id only (no sequence)** — for fail-open test.
- **Mixed-version invalid document** (`v: 1` envelope but entries containing `eventRef: {sequence}` only) — for strict-boundary rejection test.

Co-locate under `servers/exarchos-mcp/src/projections/rehydration/__fixtures__/` if not already present; otherwise inline in each test file under a small `factories/` const block.

---

## Branch strategy

- All task branches stem from `feature/v29-bug-cluster` (current).
- Each task branch merges back to `feature/v29-bug-cluster` after green tests.
- Final PR opens from `feature/v29-bug-cluster` against `main`.

---

## Out-of-scope (relocated by discovery 2026-05-07)

- **#1242** auto-summarized handoff fallback → v2.11.0
- **#1243** `?include=handoff` rehydrate gate → closed (deferred until measurement)
- **#1244** markdown-aware handoff lint → v2.10.0 (separate ticket within milestone)
- **#1245** `@<path>` arg substitution on `--context` → v2.12.0
- **#1165** VcsProvider thread-reply → v2.11.0

---

## Cross-cutting verification at PR time

The PR description must include the standard #1109 verification checklist (already enumerated in the design doc §"Verification checklist") and confirm:

- [ ] Event-sourcing replay test passes
- [ ] CLI/MCP parity test passes
- [ ] v:1 → v:2 migration test passes
- [ ] No on-disk write of v:1 envelopes after this PR
- [ ] `autoEmittedEvents` exposed on delegate + overhaul-delegate phases
- [ ] No overlap between `events` and `autoEmittedEvents`
- [ ] Spike doc status updated
