# Implementation Plan — v2.10.0-preview.4 Wave 2 + Wave 3 Polish

**Design:** [docs/designs/2026-05-15-wave2-wave3-polish.md](../designs/2026-05-15-wave2-wave3-polish.md)
**Feature ID:** `v2-10-0-preview-4-wave2-wave3-polish`
**Issues:** #1363, #1360, #1364, #1359 (in stack order)
**Stack shape:** 4-PR bottom-up stack, each PR target the previous PR's branch
**Branch root:** `feature/wave2-wave3-polish-preview4`

## Iron law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

Every task below names a failing test first and the minimal code that turns it green. `#1359` (PR 4) carries the additional contract that the parked outcome test (`tests/outcome/rehydrate-projection-drift.test.ts:40`) has its `it.fails` annotation removed in the **same commit** as the projection fix — that is the atomic RED→GREEN flip.

## Branches & stack topology

```
main
 └── feature/preview4-pr1-merge-pending-runbook        ← PR 1 (#1363)
      └── feature/preview4-pr2-reserved-fields         ← PR 2 (#1360)
           └── feature/preview4-pr3-telemetry-split    ← PR 3 (#1364)
                └── feature/preview4-pr4-projection-drift  ← PR 4 (#1359)
```

Merge bottom-up: PR 1 → auto-retarget PR 2 to main → … → PR 4 to main.

## Test-name convention

Per project convention: `Method_Scenario_Outcome`. Outcome-tier tests already follow `PascalCase_PascalCase_PascalCase`. Unit tests follow vitest `it('Name_Scenario_Outcome', ...)`.

---

## PR 1 — `#1363` merge-pending runbook

**Branch:** `feature/preview4-pr1-merge-pending-runbook`
**Base:** `main`
**Risk:** very low (registry-only, no behavior change for existing phases)
**LOC budget:** ~70 (impl) + ~50 (test)

### Task T1: MERGE_ORCHESTRATION runbook definition

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `Runbook_PhaseMergePending_ReturnsPopulatedSteps`
     - File: `servers/exarchos-mcp/src/runbooks/definitions.test.ts`
     - Expected failure: `definitions.ts` exports no `MERGE_ORCHESTRATION` symbol; runbook registry returns empty for `phase: 'merge-pending'`.
   - `Runbook_MergePending_TemplateVarsExpand`
     - File: `servers/exarchos-mcp/src/runbooks/decision-runbooks.test.ts`
     - Expected failure: no entry for `merge-pending` to drive template-var resolution against.

2. **[GREEN]** Implement:
   - Add `MERGE_ORCHESTRATION` to `servers/exarchos-mcp/src/runbooks/definitions.ts` with the three steps + `templateVars` + `autoEmits` from the design doc.
   - Wire into the registry (mirror the existing four definitions' wiring at the bottom of the file).
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts`

3. **[REFACTOR]** No refactor expected — registry insertion is a copy of the existing pattern.

**Dependencies:** None.
**Parallelizable with:** PR 2, PR 3, PR 4 (PR 1 has no shared surface).
**Acceptance:** `exarchos_orchestrate({action: 'runbook', phase: 'merge-pending'})` returns the three steps with `autoEmits` populated.

---

## PR 2 — `#1360` RESERVED_FIELD discoverability

**Branch:** `feature/preview4-pr2-reserved-fields` (base: `feature/preview4-pr1-merge-pending-runbook`)
**Risk:** low (additive: new `describe` field + new error-data field + skill docs)
**LOC budget:** ~250 (impl) + ~150 (test) + ~80 (skill docs)

### Task T2: Reserved-fields source-of-truth descriptor

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test:
   - `ReservedFieldsDescriptor_TopLevelImmutable_ListsAllFiveKeys`
   - File: `servers/exarchos-mcp/src/workflow/schemas.test.ts` (extend existing)
   - Expected failure: `RESERVED_FIELDS_DESCRIPTOR` export does not exist.

2. **[GREEN]** Implement:
   - Add `RESERVED_FIELDS_DESCRIPTOR` constant to `servers/exarchos-mcp/src/workflow/schemas.ts`:
     ```ts
     export const RESERVED_FIELDS_DESCRIPTOR = {
       rule: '…',
       topLevelImmutable: ['phase', 'workflowType', 'featureId', 'createdAt', 'version'],
       underscorePrefixed: 'any path matching /(^_|\\._)/',
       examples: ['_version', '_checkpoint.summary', '_eventHints'],
       alternateWritePaths: {
         phase: 'exarchos_workflow({action: \'transition\', target: \'<phase>\'})',
         _checkpoint: 'managed by prune_stale_workflows / checkpoint cadence',
         '_version|_esVersion|_perf|_meta|_eventHints': 'server-managed; no write path',
       },
     } as const;
     ```
   - Derive `isReservedField` from `RESERVED_FIELDS_DESCRIPTOR.topLevelImmutable` (single source of truth).
   - Add zod schema `ReservedFieldsDescriptorSchema` for the shape.

3. **[REFACTOR]** Replace the existing `IMMUTABLE_FIELDS` set literal in `isReservedField` with a derivation from the descriptor.

**Dependencies:** None within PR 2.
**Acceptance:** `isReservedField` behavior unchanged; new `RESERVED_FIELDS_DESCRIPTOR` exported.

### Task T3: Structured `RESERVED_FIELD` error data

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test:
   - `StateStoreError_ReservedField_CarriesStructuredData`
   - File: `servers/exarchos-mcp/src/workflow/state-store.test.ts`
   - Asserts the thrown error's `data` field has `{rejectedPath, rule, alternateWritePath}` matching the descriptor; expected failure because today `StateStoreError` has no `data` parameter.

2. **[GREEN]**
   - Extend `StateStoreError` constructor signature (and class field) to accept optional typed `data`.
   - In `state-store.ts:553-557`, the `RESERVED_FIELD` throw populates `data: { rejectedPath: dotPath, rule: descriptor.rule, alternateWritePath: resolveAlternate(dotPath) }`.
   - `resolveAlternate(dotPath)` matches the dotPath against `RESERVED_FIELDS_DESCRIPTOR.alternateWritePaths` and returns the suggested write path, or `null` if no specific guidance applies.
   - Files: `servers/exarchos-mcp/src/workflow/state-store.ts`, `servers/exarchos-mcp/src/workflow/errors.ts` (if `StateStoreError` lives there; otherwise inline).

3. **[REFACTOR]** Ensure all `StateStoreError` throw sites either pass `data` or accept the undefined default.

**Dependencies:** T2.
**Acceptance:** Thrown `RESERVED_FIELD` error carries typed `data` block.

### Task T4: `describe('update')` returns `reservedFields` block

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test:
   - `Describe_ActionUpdate_ReturnsReservedFieldsBlock`
   - File: `servers/exarchos-mcp/src/workflow/describe-config.test.ts` (extend existing)
   - Expected failure: `describe(actions: ['update'])` response has no `reservedFields` key.

2. **[GREEN]**
   - In `describe-config.ts`, the `update` action's describe payload embeds `RESERVED_FIELDS_DESCRIPTOR` under the `reservedFields` key.
   - Update zod output schema for `describe` to include the new field.

3. **[REFACTOR]** None expected.

**Dependencies:** T2.
**Acceptance:** `describe('update').reservedFields` matches descriptor.

### Task T5: `workflow.update` error-branch outputSchema registers structured data

**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `WorkflowUpdate_ErrorBranch_OutputSchemaPermitsTypedData`
   - File: `servers/exarchos-mcp/src/workflow/composite.test.ts` (or the registration test for `exarchos_workflow`)
   - Asserts the registered outputSchema for `workflow.update`'s error branch validates a sample `{success: false, error: {code: 'RESERVED_FIELD', message: '…', data: {rejectedPath: 'phase', rule: '…', alternateWritePath: '…'}}}`.
   - Expected failure: today `error.data` is not declared in the outputSchema, so strict validation rejects the field.

2. **[GREEN]**
   - Extend the registered outputSchema for `exarchos_workflow` `update` action's error branch (or the shared `Envelope<T>` error branch if updates ripple there) to allow typed `data` for `RESERVED_FIELD`.
   - File: `servers/exarchos-mcp/src/workflow/composite.ts` (or wherever the action's outputSchema is registered post Wave 0).

**Dependencies:** T3.
**Acceptance:** Wave 0 carrier validation accepts the structured error envelope without warning.

### Task T6: Skill documentation — Reserved fields section + cross-link

**Phase:** Documentation (no production code; build step runs the skills validator)

1. **[RED]** Write test (build:skills lint):
   - `Skill_WorkflowState_ContainsReservedFieldsSection`
   - File: `servers/exarchos-mcp/src/skills/*.test.ts` (or equivalent — the build:skills regen + git-diff check via `npm run skills:guard` will catch missing section if the source has a marker test)
   - Use grep-based assertion: section header `## Reserved fields` present in `skills-src/workflow-state/SKILL.md`.
   - Expected failure: section does not exist.

2. **[GREEN]**
   - Add "Reserved fields" subsection to `skills-src/workflow-state/SKILL.md` (rule, examples, alternate write paths).
   - Add cross-link from `skills-src/merge-orchestrator/SKILL.md` (because `mergeOrchestrator` is a writeable nested object).
   - Run `npm run build:skills`; commit regenerated `skills/<runtime>/workflow-state/SKILL.md` and `skills/<runtime>/merge-orchestrator/SKILL.md` for all runtimes.
   - Pass `npm run skills:guard`.

3. **[REFACTOR]** Run skill prose through humanize check (axiom:humanize) — flag any AI-writing tells in the new section.

**Dependencies:** T2 (descriptor exists), T4 (describe-side equivalent).
**Acceptance:** Section present in both source and rendered runtimes; `npm run skills:guard` clean.

---

## PR 3 — `#1364` telemetry split (transport vs action-level errors)

**Branch:** `feature/preview4-pr3-telemetry-split` (base: `feature/preview4-pr2-reserved-fields`)
**Risk:** medium (middleware sits on every action path; one bad emit fans out)
**LOC budget:** ~150 (impl) + ~200 (test)

### Task T7: `tool.action_errored` event type registration

**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `EventStoreSchemas_ToolActionErrored_HasRegisteredType`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: the event-type union does not include `'tool.action_errored'`.

2. **[GREEN]**
   - Extend the event-store EventType union in `event-store/schemas.ts:16+` to include `'tool.action_errored'`.
   - Register its `data` shape: `{tool: string, durationMs: number, errorCode: string, responseBytes: number, tokenEstimate: number}`.
   - Update the auto-stream routing table if applicable (`schemas.ts:243+`).

**Dependencies:** None within PR 3.
**Acceptance:** Event type validates with sample data; existing tests unchanged.

### Task T8: Middleware emits `tool.action_errored` on `result.success === false`

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test:
   - `WithTelemetry_StructuredFailure_EmitsActionErrored`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Setup: handler returns `{success: false, error: {code: 'RESERVED_FIELD', message: '…'}}`.
   - Assert: `eventStore` received `tool.action_errored` with `errorCode: 'RESERVED_FIELD'`, alongside `tool.completed`.
   - Expected failure: middleware emits only `tool.completed`.
   - Second test: `WithTelemetry_JsThrow_StillEmitsToolErroredOnly` — guards regression of the catch branch.

2. **[GREEN]**
   - In `middleware.ts:140-145` (success branch), after the `tool.completed` append, inspect `result.success`. If `false`, append `tool.action_errored` with `errorCode: result.error?.code ?? 'UNKNOWN'`.
   - File: `servers/exarchos-mcp/src/telemetry/middleware.ts`

3. **[REFACTOR]** Extract the `result.success === false` check into a typed helper if it adds clarity.

**Dependencies:** T7.
**Acceptance:** Both tests pass; existing middleware tests still pass.

### Task T9: Telemetry projection folds `actionErrors` + `actionErrorBreakdown`

**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `TelemetryProjection_ActionErrored_AggregatesByTool`
   - File: `servers/exarchos-mcp/src/telemetry/telemetry-projection.test.ts`
   - Setup: fold a stream of mixed `tool.completed` / `tool.action_errored` / `tool.errored`.
   - Assert: per-tool aggregation has correct `invocations`, `errors` (transport only), `actionErrors`, `actionErrorBreakdown` (by `errorCode`).
   - Expected failure: projection does not handle `tool.action_errored`.

2. **[GREEN]**
   - Extend `telemetry-projection.ts` fold to handle `'tool.action_errored'`. Increment per-tool `actionErrors` and `actionErrorBreakdown[errorCode]`.
   - File: `servers/exarchos-mcp/src/telemetry/telemetry-projection.ts`

**Dependencies:** T7.
**Acceptance:** Projection state has new aggregations populated correctly.

### Task T10: `view.telemetry` outputSchema registers new fields

**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `ViewTelemetry_OutputSchema_IncludesActionErrorFields`
   - File: `servers/exarchos-mcp/src/views/handlers.test.ts` (or the registration test for `view.telemetry`)
   - Asserts the registered outputSchema for `exarchos_view.telemetry` validates a sample envelope with `actionErrors: 3, actionErrorBreakdown: {MERGE_ROLLED_BACK: 1, PREFLIGHT_FAILED: 2}`.
   - Expected failure: schema rejects the new fields under strict validation.

2. **[GREEN]**
   - Extend the registered outputSchema for `view.telemetry` to include `actionErrors: number` and `actionErrorBreakdown: Record<string, number>` per-tool entry.

**Dependencies:** T8, T9.
**Acceptance:** Wave 0 carrier validation passes.

---

## PR 4 — `#1359` projection drift + atomic RED→GREEN flip

**Branch:** `feature/preview4-pr4-projection-drift` (base: `feature/preview4-pr3-telemetry-split`)
**Risk:** medium-high (projection version bump; widest blast radius)
**LOC budget:** ~300 (impl) + ~250 (test)

### Task T11: Rehydrate reducer surfaces canonical `tasks[].status` vocabulary

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test:
   - `RehydrationReducer_StatePatchedCompleteTask_SurfacesCanonicalCompleteVocabulary`
   - File: `servers/exarchos-mcp/src/projections/rehydration/reducer.test.ts`
   - Fold `state.patched` with `patch.tasks: [{id: T001, status: 'complete'}]`.
   - Assert `taskProgress[0].status === 'complete'` (NOT `'completed'`).
   - Expected failure: reducer normalizes to `'completed'`.

2. **[GREEN]**
   - In `reducer.ts:241-249` (the `extractPlanTasks` status mapping), drop the `'complete' → 'completed'` rename. Pass canonical vocabulary through: `pending`, `in_progress` (assigned-equivalent), `complete`, `failed`.
   - Update `TaskProgressStatus` union and `STATUS_RANK` table accordingly (`'complete'` replaces `'completed'`; ranks unchanged).
   - File: `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`

3. **[REFACTOR]** Audit `reducer.ts`, `schema.ts`, and tests for stray `'completed'` literals; replace with `'complete'` or document the upgrade path.

**Dependencies:** None within PR 4.
**Acceptance:** Folded taskProgress uses canonical vocabulary.

### Task T12: `RehydrationDocumentSchema` v:4 envelope + upgrade path

**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `UpgradeV3ToV4_TaskProgressCompleted_RenamesToComplete`
   - File: `servers/exarchos-mcp/src/projections/rehydration/upgrade.test.ts`
   - Input: a v:3 document with `taskProgress: [{id, status: 'completed'}]`.
   - Output: v:4 document with `taskProgress: [{id, status: 'complete'}]`.
   - Expected failure: no v:3→v:4 upgrader exists.

2. **[GREEN]**
   - Bump `RehydrationDocumentSchema` envelope to `v: literal(4)` in `schema.ts:321`.
   - Freeze the v:3 schema as a read-back-only export (mirror existing v:1/v:2 pattern).
   - Add v:3 → v:4 upgrader in `upgrade.ts` that renames `taskProgress[].status: 'completed' → 'complete'`.
   - Route `loadRehydrationDocument` in `serialize.ts` to call the new upgrader.
   - Files: `servers/exarchos-mcp/src/projections/rehydration/schema.ts`, `upgrade.ts`, `serialize.ts`.

**Dependencies:** T11.
**Acceptance:** Legacy v:3 snapshots load as v:4 docs with canonical vocabulary.

### Task T13: Pipeline view `tasksById` Map + `state.patched` fold

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test:
   - `PipelineProjection_StatePatchedCompleteTask_IncrementsCompletedCount`
   - File: `servers/exarchos-mcp/src/views/pipeline-view.test.ts` (create or extend)
   - Fold `state.patched` with `patch.tasks: [{id: T001, status: 'complete'}, {id: T002, status: 'pending'}]`.
   - Assert: `taskCount === 2, completedCount === 1, failedCount === 0`.
   - Expected failure: pipeline view does not fold `state.patched`.

2. **[GREEN]**
   - Extend `PipelineViewState` with `tasksById: Map<string, string>` (or `Record<string, string>` if materializer prefers).
   - Add `state.patched` case to `pipelineProjection.apply` that calls `extractPlanTasks` (or reuses the rehydrate extractor) and folds with monotonic promotion (same rank table as rehydrate).
   - Derive `taskCount = map.size`, `completedCount = count(status === 'complete')`, `failedCount = count(status === 'failed')`.
   - Keep `task.assigned`/`task.completed`/`task.failed` cases for executor-emitted flows; ensure they update `tasksById` AND counters consistently (single source).
   - File: `servers/exarchos-mcp/src/views/pipeline-view.ts`

3. **[REFACTOR]** Extract the shared monotonic-status-fold helper into a module shared by `pipeline-view.ts` and `rehydration/reducer.ts` so the two projections cannot drift again.

**Dependencies:** T11 (vocabulary alignment).
**Acceptance:** All three counters track `state.patched` mutations.

### Task T14: `projectionAsOf` on rehydrate + view.pipeline outputs

**Phase:** RED → GREEN

1. **[RED]** Write tests:
   - `Rehydrate_FoldedEvents_ExposesProjectionAsOf`
     - File: `servers/exarchos-mcp/src/workflow/rehydrate.test.ts`
     - Asserts response payload has `projectionAsOf: ISO timestamp` matching the last folded event.
   - `ViewPipeline_FoldedEvents_ExposesProjectionAsOf`
     - File: `servers/exarchos-mcp/src/views/handlers.test.ts`
     - Same shape.

2. **[GREEN]**
   - Thread `projectionAsOf` through the projection-meta record (`event.timestamp` of last folded event).
   - Surface in the response shape for `handleRehydrate` and `handleViewPipeline`.
   - Register both outputSchemas with the new field.
   - Files: rehydrate handler, view handler, both outputSchemas (composite registration).

**Dependencies:** T11, T12, T13.
**Acceptance:** Both responses carry `projectionAsOf`; outputSchemas validate.

### Task T15: `_meta.projectionLag` exposure when stale > 5s

**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `Rehydrate_StaleProjection_ExposesMetaProjectionLag`
   - File: `servers/exarchos-mcp/src/workflow/rehydrate.test.ts`
   - Setup: inject a clock that places `projectionAsOf` >5s in the past.
   - Assert `_meta.projectionLag` is a number ≥ 5000.
   - Expected failure: no projectionLag computation today.

2. **[GREEN]**
   - In the response composer, compute `Date.now() - projectionAsOfMs`; if > 5000, set `_meta.projectionLag`.
   - Threshold lives in a named constant `PROJECTION_LAG_THRESHOLD_MS = 5000`.
   - Files: same as T14.

**Dependencies:** T14.
**Acceptance:** Stale projection exposes lag; fresh projection does not include the field (sparse).

### Task T16: `reconcile_state` projection-drift check

**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `ReconcileState_PipelineCountVsCanonicalDisagree_ReportsDrift`
   - File: `servers/exarchos-mcp/src/orchestrate/reconcile-state.test.ts`
   - Setup: state-store has `tasks[].status` with 3 completes; pipeline view (with old projection cached) reports `completedCount: 1`.
   - Assert reconcile reports a drift entry with both counts.
   - Expected failure: today reconcile returns `PASS 5/5`.

2. **[GREEN]**
   - Add `projection-drift` check to `reconcile-state.ts`. The check loads canonical `tasks[].status` from the state-store and compares to `view.pipeline.completedCount` and `view.pipeline.failedCount`.
   - On mismatch, append a structured drift entry with `{check: 'projection-drift', canonical, projected, delta}`.
   - File: `servers/exarchos-mcp/src/orchestrate/reconcile-state.ts`

**Dependencies:** T13.
**Acceptance:** Drift surfaced; non-drift scenarios still PASS.

### Task T17: Atomic flip of parked outcome test

**Phase:** RED-already-exists → GREEN (atomic with T11+T13)

1. **[RED]** Already exists at `tests/outcome/rehydrate-projection-drift.test.ts:40` under `it.fails`.

2. **[GREEN]**
   - Remove the `it.fails` annotation in the same commit that lands T11 + T13 + (transitively) T12.
   - Update the expectation strings if needed to match the canonical vocabulary (the test already asserts `'complete'`).
   - File: `tests/outcome/rehydrate-projection-drift.test.ts`

**Dependencies:** T11, T12, T13 must all land in the same commit as this flip. The implementer's RED→GREEN sequencing inside PR 4 is: write the unit-level RED tests (T11–T13's tests stay RED while the parked outcome test also stays RED) → land all impl + remove `it.fails` in one commit → both unit + outcome tests turn GREEN together.
**Acceptance:** Outcome-tier CI job is GREEN; the test runs against real EventStore + tmpdir.

---

## Cross-cutting outputSchema interaction checklist

Composes the design's "Carrier-Wave / dogfood-wave interaction checklist":

- [ ] **PR 2 / T5** — `workflow.update` error-branch outputSchema accepts typed `RESERVED_FIELD.data: {rejectedPath, rule, alternateWritePath}`.
- [ ] **PR 3 / T10** — `view.telemetry` outputSchema declares `actionErrors: number` + `actionErrorBreakdown: Record<string, number>`.
- [ ] **PR 4 / T14** — `exarchos_workflow.rehydrate` + `exarchos_view.pipeline` outputSchemas declare `projectionAsOf: ISO string`.
- [ ] **PR 4 / T15** — Both above outputSchemas declare optional `_meta.projectionLag: number`.

Each PR must include the schema registration delta or the carrier will reject the new field.

## Parallelization map

| PR | Sequential? | Notes |
|---|---|---|
| PR 1 | Independent | Lowest-risk anchor; lands first |
| PR 2 | Depends on PR 1 only via stack base | Could land in parallel with PR 1 if rebased to main |
| PR 3 | Depends on PR 2 only via stack base | Telemetry middleware unrelated to reserved fields |
| PR 4 | Depends on PR 3 only via stack base | Projection drift unrelated to telemetry; the projection version bump must avoid PR 3 telemetry-projection rev clashes |

Within each PR, tasks share a single sub-agent worktree and run sequentially in the order listed (RED before GREEN, dependencies resolved in numeric order).

## Verification gates per PR

Each PR runs the following before opening for review:

1. `npm run typecheck`
2. `npm run test:run` (full unit + integration suite)
3. PR 1 and PR 4 also: `npm run test -- --project=outcome` (outcome-tier; PR 4 is the parked flip)
4. `npm run skills:guard` (PR 2 regenerates skills)
5. `npm run build` (catches MCP-server bundle drift)

CI also runs the eval-results-view assertions; PR 4's projection schema bump must clear that suite (snapshot tests typically pin shape).

## Risks captured in design (mapped to tasks)

| Risk | Mitigation task |
|---|---|
| Projection version invalidates fingerprints | T12 (frozen v:3 + upgrade path) |
| `'completed' → 'complete'` rename breaks consumers | T11 REFACTOR audit; T12 upgrade path |
| Pipeline-view Map serialization | T13 — verify materializer handles Map state via existing team-performance-view pattern |
| Stack-conflict thrash mid-merge | Rebase between merges; project-memory `stale_worktree_after_external_push` doc |
| Telemetry middleware emits noisy synthetic event | T8 — paired with `tool.completed`; aggregation rules tested in T9 |

## Out of scope for this plan (deferred to design's "Out of scope")

- #1362 Windows preflight phase-1 instrumentation
- #1365 eval-suite elevation
- Full INV-6 audit of remaining skills
- Telemetry dashboard rendering of `actionErrors`

## Definition of done

- All four PRs squash-merged onto `main`.
- All issue acceptance checkboxes from #1359, #1360, #1363, #1364 ticked.
- Epic #1354 Waves 2 + 3 fully ticked; remaining open work: #1362 and #1365 only.
- `tests/outcome/rehydrate-projection-drift.test.ts` GREEN in CI.
- Skills guard clean across all runtimes.
