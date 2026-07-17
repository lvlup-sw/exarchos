# Implementation Plan — v2.10.0-preview.4 Feature-Freeze Bundle

**Design:** [docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.md](../designs/2026-05-15-v2-10-0-preview-4-feature-freeze.md)
**Feature ID:** `v2-10-0-preview-4-feature-freeze`
**Issues:** #1238, #1244, #1260, #1261, #1262, #1272, #1273, #1274, #1290, #1291, #1298 (11 issues, 13 PRs across 4 waves)
**Branch root:** `feature/preview4-feature-freeze`

## Iron law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

Every task names a failing test and the minimal code that turns it green. The largest issue (#1273 Tasks dispatch-core) is split into three internal PRs per the design's risk-mitigation §; each sub-PR carries its own RED→GREEN cycle.

## Stack topology

Wave A (output contract) and Wave D (authoring substrate) touch disjoint surfaces and run in **parallel stacks**. Wave B (correlation) lands after both, threading through every event emit site. Wave C (Tasks) lands last, consuming Wave B's `EventSourcedTaskStore`.

```
main
 ├── feature/preview4-wave-a-root ── A1 (#1238) ─ A2 (#1262) ─ A3 (#1290) ─ A4 (#1274)
 ├── feature/preview4-wave-d-root ── D1 (#1260) ─ D2 (#1298) ─ D3 (#1244)
 │
 │  [merge waves A + D bottom-up; integration commit on main]
 │
 └── feature/preview4-wave-b-root ── B1 (#1291) ─ B2 (#1261) ─ B3 (#1272)
        └── feature/preview4-wave-c-root ── C1 (core) ─ C2 (MCP) ─ C3 (CLI)
```

**Total: 13 PRs.** Within a wave: bottom-up stack, each PR targets the previous PR's branch. Between waves: A + D parallel; B after A∪D; C after B.

## Test-name convention

`Method_Scenario_Outcome` (vitest `it(...)` and outcome-tier `tests/outcome/*.test.ts`).

## Parallelization summary

- **Parallel-safe within preview.4 dispatch:** Wave A and Wave D (8 PRs across two stacks; disjoint surfaces).
- **Serial after A + D merge:** Wave B (3 PRs in stack).
- **Serial after B merge:** Wave C (3 PRs in stack).
- **Within-PR tasks:** mostly sequential because each follows RED→GREEN; some tasks within a PR are independent (e.g., schema definition + handler wiring).

---

## Wave A — Output Contract Completion

### PR A1 — #1238 next_actions Zod discriminated unions

**Branch:** `feature/preview4-wave-a-pr1-zod-unions`
**Base:** `main`
**Risk:** low (refactor; behavior unchanged except fail-closed on malformed payload)
**LOC budget:** ~120 impl + ~80 test

#### Task T01: ResultDataSchema discriminated union

1. **[RED]** Tests:
   - `NextActionsFromResult_WorkflowHandlerPayload_ParsesShapeOne`
   - `NextActionsFromResult_RehydrationDocument_ParsesShapeTwo`
   - `NextActionsFromResult_MalformedPayload_FailsClosed`
   - File: `servers/exarchos-mcp/src/next-actions-from-result.test.ts`
   - Expected failure: `ShapeOneSchema`, `ShapeTwoSchema`, `ResultDataSchema` exports do not exist.

2. **[GREEN]**
   - Define `ShapeOneSchema = z.object({ phase, workflowType, featureId?, mergeOrchestrator? }).passthrough()`.
   - Reuse `WorkflowStateSchema` from `projections/rehydration/schema.ts` for `ShapeTwoSchema = z.object({ workflowState: WorkflowStateSchema }).passthrough()`.
   - Define `ResultDataSchema = z.union([ShapeOneSchema, ShapeTwoSchema])`.
   - File: `servers/exarchos-mcp/src/next-actions-from-result.ts`.

3. **[REFACTOR]** Co-locate `MergeOrchestratorSchema` if not already exported.

**Dependencies:** None.
**Acceptance:** Three schemas exported; tests pass.

#### Task T02: Replace Record casts with safeParse

1. **[RED]** Test: `NextActionsFromResult_NonSuccessResult_ReturnsEmptyArray` — preserves the existing no-actions case for non-success / null-data inputs.
2. **[GREEN]** Replace `next-actions-from-result.ts:48-91` body with `ResultDataSchema.safeParse(result.data)`; on `success: false` AND data is non-null + object, fail-closed (log warning, return `[]`); preserve `return []` for the no-data legitimate cases.
3. **[REFACTOR]** Remove all `Record<string, unknown>` casts and inline `typeof` guards from the parser body.

**Dependencies:** T01.
**Acceptance:** No `Record<string, unknown>` casts remain in the file; existing consumers' behavior unchanged.

---

### PR A2 — #1262 output-token quality hint

**Branch:** `feature/preview4-wave-a-pr2-output-token-hint` (base: `feature/preview4-wave-a-pr1-zod-unions`)
**Risk:** low (additive hint; threshold-driven; degrades gracefully if telemetry data missing)
**LOC budget:** ~180 impl + ~120 test

#### Task T03: Quality-hint type definition

1. **[RED]** Test: `QualityHint_OutputTokensHighType_RegisteredInCatalog` — file: `servers/exarchos-mcp/src/telemetry/quality-hints.test.ts`. Expected failure: catalog does not export `output_tokens_high` type.
2. **[GREEN]** Add `output_tokens_high` to quality-hint catalog with `{ verb: 'checkpoint', reasonTemplate }`.
3. **[REFACTOR]** Cross-reference INV-5b output-contract reference if catalog file documents hint types.

**Dependencies:** None.
**Acceptance:** Hint type discoverable via `view.describe({actions:['telemetry']}).quality_hints`.

#### Task T04: Threshold-crossing detection in telemetry projection

1. **[RED]** Tests:
   - `TelemetryProjection_ThresholdCrossed_EmitsHint`
   - `TelemetryProjection_BelowThreshold_NoHint`
   - File: `servers/exarchos-mcp/src/telemetry/telemetry-projection.test.ts`
   - Expected failure: projection has no per-turn output-token tracking.

2. **[GREEN]** Extend `telemetry-projection.ts` to track per-turn output-token sum and surface `output_tokens_high` hint via the envelope's `next_actions` when crossing threshold. Threshold reads through `CapabilityResolver.getQualityHintThreshold('output_tokens')`; default 80% of cap.

3. **[REFACTOR]** Cap default lives in one place; capability resolver caches the read.

**Dependencies:** T03.
**Acceptance:** Crossing emits hint; below-threshold does not.

#### Task T05: Configurable threshold + CLI/MCP parity

1. **[RED]** Tests:
   - `ConfigResolver_OutputTokenThreshold_ReadsExarchosYml`
   - `Envelope_OutputTokensHighHint_CLIAndMCPIdentical`
   - File: `servers/exarchos-mcp/src/cli/envelope-parity.test.ts`

2. **[GREEN]** Wire `.exarchos.yml` `qualityHints.outputTokenThreshold` through `CapabilityResolver`. Ensure CLI and MCP serializers emit identical hint payload (#1109 MCP parity).

3. **[REFACTOR]** None.

**Dependencies:** T04.
**Acceptance:** Threshold configurable; CLI + MCP envelopes byte-identical for the hint.

---

### PR A3 — #1290 Roots-based workspace discovery

**Branch:** `feature/preview4-wave-a-pr3-roots-discovery` (base: `feature/preview4-wave-a-pr2-output-token-hint`)
**Risk:** medium (extends `CapabilityResolver`; new MCP method call; cache invalidation)
**LOC budget:** ~320 impl + ~240 test

#### Task T06: Capability snapshot at handshake

1. **[RED]** Test: `CapabilityResolver_HandshakeRootsTrue_Snapshots` — file: `servers/exarchos-mcp/src/capability/capability-resolver.test.ts`. Expected failure: resolver has no `clientRootsDeclared` field.
2. **[GREEN]** Extend `CapabilityResolver` to snapshot `client.capabilities.roots?.listChanged` at handshake; expose via `isRootsDeclared(): boolean`.
3. **[REFACTOR]** Move all client-capability reads to the resolver (DIM-6 single-coupling-point).

**Dependencies:** None.
**Acceptance:** Resolver returns `true` when handshake declares roots; `false` otherwise.

#### Task T07: Roots-based inference path

1. **[RED]** Tests:
   - `WorkspaceDiscovery_OneRootsMatch_ResolvesAndEmitsEvent`
   - `WorkspaceDiscovery_ZeroRootsMatch_FallsBackToCwdWalk`
   - `WorkspaceDiscovery_MultipleRootsMatch_ReturnsInvalidInputWithValidTargets`
   - File: `servers/exarchos-mcp/src/workspace/discovery.test.ts`
   - Expected failure: discovery has no roots-aware branch.

2. **[GREEN]**
   - Implement `roots/list` call wrapper with per-handshake cache, invalidated on `roots/list_changed` notification.
   - Scan each root for workspace signature (`.exarchos.yml`, `docs/workflow-state/*.state.json`).
   - One match → resolve + emit `workspace.resolved { source: 'roots', path, featureId }`.
   - Zero matches → fall back to cwd-walk + emit `workspace.resolved { source: 'cwd' }` if found.
   - Multiple matches → return `INVALID_INPUT` with `validTargets: [{ featureId, path }, ...]`.
   - Files: `servers/exarchos-mcp/src/workspace/discovery.ts`, `servers/exarchos-mcp/src/mcp/notifications.ts` (invalidation handler).

3. **[REFACTOR]** Workspace-signature detector is a pure function tested independently.

**Dependencies:** T06.
**Acceptance:** All three test cases pass; both event types observable in `exarchos_view convergence`.

#### Task T08: Dispatch-boundary integration

1. **[RED]** Test: `Dispatch_MissingFeatureIdWithRootsCapability_ResolvesAutomatically` — outcome-tier test at `tests/outcome/roots-discovery-dispatch.test.ts`.
2. **[GREEN]** Wire `discovery.resolveWorkspace()` into the dispatch path when `featureId` is omitted on actions that require it; call only when `CapabilityResolver.isRootsDeclared()` returns true.
3. **[REFACTOR]** Document the resolution priority (explicit > roots > cwd) in one place.

**Dependencies:** T07.
**Acceptance:** Outcome-tier scenario passes end-to-end.

---

### PR A4 — #1274 Elicitation form mode for INVALID_INPUT

**Branch:** `feature/preview4-wave-a-pr4-elicitation` (base: `feature/preview4-wave-a-pr3-roots-discovery`)
**Risk:** medium (new MCP method `elicitation/create`; schema derivation; capability gating)
**LOC budget:** ~280 impl + ~220 test

#### Task T09: Capability snapshot + sub-schema derivation

1. **[RED]** Tests:
   - `CapabilityResolver_ElicitationDeclared_Snapshots`
   - `ElicitationSchema_DerivedViaPick_MatchesInputSchema`
   - File: `servers/exarchos-mcp/src/capability/elicitation.test.ts`
   - Expected failure: no `deriveElicitationSchema()` helper exists.

2. **[GREEN]**
   - Extend `CapabilityResolver.snapshot()` to record `client.capabilities.elicitation`.
   - Implement `deriveElicitationSchema(inputSchema, field): JSONSchema` via Zod `.pick({ [field]: true })` + `zod-to-json-schema`.
   - Files: `servers/exarchos-mcp/src/capability/capability-resolver.ts`, `servers/exarchos-mcp/src/capability/elicitation.ts`.

3. **[REFACTOR]** None.

**Dependencies:** T06 (capability resolver foundation).
**Acceptance:** Helper returns sub-schema identical to picked field; resolver records elicitation flag.

#### Task T10: Dispatch missing-param elicitation path

1. **[RED]** Tests:
   - `Dispatch_MissingRequiredParamWithElicitation_SendsElicitationCreate`
   - `Dispatch_MissingRequiredParamNoCapability_ReturnsInvalidInputFallback`
   - `Elicitation_RequestedAndFulfilled_EmitEventsWithOperationId`
   - File: `servers/exarchos-mcp/src/dispatch/elicitation-dispatch.test.ts`

2. **[GREEN]**
   - On missing required param + elicitation capability: derive sub-schema, send `elicitation/create`, await response, retry dispatch with elicited value.
   - On missing required param + no elicitation: fall back to existing `INVALID_INPUT` return.
   - Emit `elicitation.requested { operationId, field, schema }` and `elicitation.fulfilled { operationId, field, value }` events.
   - Files: `servers/exarchos-mcp/src/dispatch/index.ts`, `servers/exarchos-mcp/src/event-store/schemas.ts`.

3. **[REFACTOR]** Centralize the "is field required" check at one site.

**Dependencies:** T09.
**Acceptance:** All four scenarios + event emissions covered.

---

## Wave D — Authoring Substrate

### PR D1 — #1260 machine-readable invariants

**Branch:** `feature/preview4-wave-d-pr1-invariants` (base: `main`)
**Risk:** low (additive doc + lint; no behavior change for existing skills)
**LOC budget:** ~80 impl (lint) + ~400 doc (invariants file) + ~100 test

#### Task T11: Invariants doc with structured frontmatter

1. **[RED]** Test: `Invariants_StructuredFrontmatter_ParsesAllRequiredFields` — file: `servers/exarchos-mcp/src/architecture/invariants-loader.test.ts`. Expected failure: loader does not exist.
2. **[GREEN]**
   - Author `docs/architecture/invariants.md` with YAML frontmatter:
     ```yaml
     ---
     invariants:
       - id: INV-1
         dimension: event-sourcing
         applies-to: [server, projections]
         summary: "..."
       - id: INV-5b
         dimension: output-contract
         applies-to: [mcp-actions]
         summary: "..."
       # ... INV-2..6, DIM-1..8, basileus boundary
     ---
     ```
   - Implement `invariants-loader.ts` parsing the frontmatter into a typed structure.
3. **[REFACTOR]** Cross-reference dimension catalog from `axiom:backend-quality`.

**Dependencies:** None.
**Acceptance:** Loader returns typed entries for INV-1..6, DIM-1..8, basileus-boundary.

#### Task T12: Vocabulary lint on invariant references

1. **[RED]** Tests:
   - `VocabularyLint_UnknownInvariantReference_Fails`
   - `VocabularyLint_KnownInvariantReference_Passes`
   - File: `servers/exarchos-mcp/src/architecture/vocabulary-lint.test.ts`

2. **[GREEN]**
   - Scan markdown files under `docs/`, `skills-src/`, `commands/` for `INV-N`, `DIM-N` references.
   - Cross-check against loaded invariants; fail on unknown id.
   - Wire as `npm run lint:invariants`; gate in CI.

3. **[REFACTOR]** Share scanner with the existing skills:guard infrastructure.

**Dependencies:** T11.
**Acceptance:** Adding an `INV-99` reference to any scanned file fails CI; existing references pass.

#### Task T13: `/ideate` first-turn constraint-acknowledgement

1. **[RED]** Test: `Ideate_FirstTurn_IncludesInvariantConstraintSection` — file: `servers/exarchos-mcp/src/commands/ideate-loader.test.ts`. Asserts the skill prompt template surfaces relevant invariants on first turn.
2. **[GREEN]**
   - Update `commands/ideate.md` and `skills-src/brainstorming/SKILL.md` to load `docs/architecture/invariants.md` on first turn and surface the relevant entries.
   - Run `npm run build:skills`; commit regenerated `skills/`.
3. **[REFACTOR]** None.

**Dependencies:** T11, T12.
**Acceptance:** A new `/ideate` session against a known-friction pattern requires no manual redirect (verified by running one end-to-end against a CLI design proposal).

---

### PR D2 — #1298 designs/plans machine-readable sidecar

**Branch:** `feature/preview4-wave-d-pr2-sidecar` (base: `feature/preview4-wave-d-pr1-invariants`)
**Risk:** medium (gate consumption logic; co-existence window)
**LOC budget:** ~360 impl + ~280 test

#### Task T14: Sidecar schema (design.v1, plan.v1)

1. **[RED]** Tests:
   - `SidecarSchema_DesignV1_AcceptsConformantDoc`
   - `SidecarSchema_PlanV1_AcceptsConformantDoc`
   - `SidecarSchema_MismatchedSchemaVersion_Rejected`
   - File: `servers/exarchos-mcp/src/orchestrate/sidecar-schemas.test.ts`

2. **[GREEN]**
   - Define Zod schemas: `DesignSidecarV1` (`schema`, `sections`, `drs`, `acceptance`) and `PlanSidecarV1` (`tasks`, `coverage`, `provenance`).
   - File: `servers/exarchos-mcp/src/orchestrate/sidecar-schemas.ts`.

3. **[REFACTOR]** Mirror the existing event-store schema location convention.

**Dependencies:** None.
**Acceptance:** Schemas exported and validated against this design + plan as round-trip fixtures.

#### Task T15: Gates consume sidecar with regex fallback

1. **[RED]** Tests:
   - `CheckDesignCompleteness_SidecarPresent_UsesStructuredInput`
   - `CheckDesignCompleteness_NoSidecar_FallsBackToRegexWithDeprecationLog`
   - `CheckPlanCoverage_SidecarPresent_VerifiesDrCoverageStructurally`
   - File: `servers/exarchos-mcp/src/orchestrate/gates/sidecar-consumption.test.ts`

2. **[GREEN]**
   - In each of the four gates (`check_design_completeness`, `check_plan_coverage`, `check_provenance_chain`, `check_task_decomposition`), look for `<doc>.sidecar.yml` next to the markdown; parse via the relevant schema; use structured input.
   - When sidecar absent, fall back to existing regex; log `console.warn` with `[DEPRECATION] sidecar missing for <path>; regex fallback scheduled for removal in v2.11. Tracking: #<n>`.
   - File: `servers/exarchos-mcp/src/orchestrate/gates/check-*.ts`.

3. **[REFACTOR]** Share sidecar-lookup helper across the four gates.

**Dependencies:** T14.
**Acceptance:** Each gate accepts sidecar-form input; regex fallback works + logs deprecation.

#### Task T16: Backfill sidecars for preview.4 design + plan

1. **[GREEN]** Hand-author:
   - `docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml`
   - `docs/plans/2026-05-15-v2-10-0-preview-4-feature-freeze.sidecar.yml`
   - Conformant to `DesignSidecarV1` / `PlanSidecarV1`.
2. **[GREEN]** File tracking issue: "chore(gates): remove regex-scrape fallback from check_* gates (v2.11)" with reference to #1298 and the deprecation log message.
3. **[REFACTOR]** None.

**Dependencies:** T15.
**Acceptance:** This design + plan have sidecars; running gates against them uses the sidecar branch; deprecation tracking issue exists.

---

### PR D3 — #1244 markdown-aware handoff lint

**Branch:** `feature/preview4-wave-d-pr3-handoff-lint` (base: `feature/preview4-wave-d-pr2-sidecar`)
**Risk:** low (soft-fail by default; reuses existing prose-lint infrastructure)
**LOC budget:** ~140 impl + ~120 test

#### Task T17: Wire prose lint into handleCheckpoint

1. **[RED]** Tests:
   - `HandleCheckpoint_AiPaddedContext_EmitsWarningHint`
   - `HandleCheckpoint_CleanHandoff_NoWarning`
   - `HandleCheckpoint_HardFailConfig_BlocksWrite`
   - File: `servers/exarchos-mcp/src/workflow/checkpoint-handler.test.ts`

2. **[GREEN]**
   - At `handleCheckpoint` input validation, run `proseLint(input.handoff.context)`, `proseLint(input.handoff.nextSteps)`, `proseLint(input.handoff.suggestions)`.
   - Soft-fail default: collect findings, surface via `_eventHints: [{ kind: 'handoff_lint_warning', findings }]`, do not block.
   - Hard-fail (`.exarchos.yml: handoffLint.hardFail: true`): return `INVALID_INPUT` with structured `data: { findings }`.
   - File: `servers/exarchos-mcp/src/workflow/checkpoint-handler.ts`.

3. **[REFACTOR]** Centralize lint invocation in one helper.

**Dependencies:** None (reuses existing `projections/rehydration/prose-lint.ts`).
**Acceptance:** Three scenarios pass; lint findings shape registered against `checkpoint` outputSchema's `_eventHints` slot.

---

## Wave B — Correlation + Event Topology

### PR B1 — #1291 dispatch-boundary three-field correlation

**Branch:** `feature/preview4-wave-b-pr1-correlation` (base: `main` after Waves A + D merge)
**Risk:** high (broad blast — every event emission point + every action's outputSchema `_meta` branch)
**LOC budget:** ~520 impl + ~360 test

#### Task T18: DispatchContext primitive with three IDs

1. **[RED]** Tests:
   - `DispatchContext_NewDispatch_MintsFreshOperationId`
   - `DispatchContext_IncomingCorrelationId_Inherits`
   - `DispatchContext_NoIncomingCorrelation_SelfBindsToOperationId`
   - `DispatchContext_AutoDispatchedFromNextActions_CausationIdResolvesToUpstreamEvent`
   - File: `servers/exarchos-mcp/src/dispatch/dispatch-context.test.ts`

2. **[GREEN]**
   - Define `DispatchContext = { operationId: UUID; correlationId: UUID; causationId?: UUID }`.
   - Implement `mintDispatchContext(incoming?: { correlationId?, causationId? })` factory.
   - File: `servers/exarchos-mcp/src/dispatch/dispatch-context.ts`.

3. **[REFACTOR]** Document the three semantic roles inline.

**Dependencies:** None.
**Acceptance:** All four scenarios pass.

#### Task T19: Thread context through every event emit site

1. **[RED]** Test: `EventStore_EventsEmittedDuringDispatch_ShareIdenticalOperationId` — outcome-tier at `tests/outcome/correlation-threading.test.ts`. Drives a multi-event dispatch (e.g., `delegate` → `task.assigned` + `dispatch.preflight` + `state.patched`); asserts all events share `_meta.operationId`.
2. **[GREEN]**
   - Pass `DispatchContext` through the dispatch composer; every `eventStore.append(...)` site receives the context as a required argument.
   - Update `EventBase` schema (or equivalent) to include three-field `_meta` block.
   - Files: `servers/exarchos-mcp/src/dispatch/composer.ts`, `servers/exarchos-mcp/src/event-store/append.ts`, schemas.
3. **[REFACTOR]** None.

**Dependencies:** T18.
**Acceptance:** Outcome test passes; static-analysis grep finds no `eventStore.append` call lacking context.

#### Task T20: Register three-field _meta in action outputSchemas

1. **[RED]** Test: `ActionEnvelope_OutputSchemaMeta_IncludesThreeCorrelationFields` — file: `servers/exarchos-mcp/src/mcp/output-schema-meta.test.ts`. Iterates every registered action; asserts `outputSchema._meta` accepts `operationId`, `correlationId`, `causationId`.
2. **[GREEN]**
   - Add three-field `_meta` extension to the shared `OutputSchemaMetaBase` Zod schema.
   - Verify all 4 composite tools' action outputSchemas inherit the base.
   - File: `servers/exarchos-mcp/src/mcp/output-schema-base.ts`.
3. **[REFACTOR]** None.

**Dependencies:** T19.
**Acceptance:** No action's outputSchema rejects the three-field `_meta` payload.

#### Task T21: Full-suite regression sweep (blast-radius gate)

1. **[GREEN]** Run `npm run test:run` for the full repository AND `servers/exarchos-mcp && npm run test:run`. Address any regression introduced by correlation threading (per project memory [blast-radius gate](feedback_tdd_gate_blast_radius), TDD per-task scope is too narrow for changes of this width — explicit full-suite check is required).
2. **[REFACTOR]** Any test that asserted on the absence of `correlationId / causationId` fields needs to be widened to accept the new shape.

**Dependencies:** T20.
**Acceptance:** Full suite clean.

---

### PR B2 — #1261 dispatch.preflight + stash.detected events

**Branch:** `feature/preview4-wave-b-pr2-preflight-events` (base: `feature/preview4-wave-b-pr1-correlation`)
**Risk:** medium (touches dispatch-guard; reuses existing emitGateEvent pattern)
**LOC budget:** ~200 impl + ~160 test

#### Task T22: New event schemas

1. **[RED]** Tests:
   - `EventSchema_DispatchPreflight_ValidatesGuardOutcome`
   - `EventSchema_StashDetected_RequiresWorktreePath`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`

2. **[GREEN]** Add `dispatch.preflight { guards: { ancestry, worktree, protectedBranch, mainWorktree }, passed, durationMs }` and `stash.detected { worktreePath, stashRef }` to the event schema catalog. Both inherit three-field `_meta` from PR B1.
3. **[REFACTOR]** Co-locate with the `gate.*` event family.

**Dependencies:** PR B1 (DispatchContext).
**Acceptance:** Schemas exported; round-trip serialization tested.

#### Task T23: Emit from dispatch-guard

1. **[RED]** Tests:
   - `DispatchGuard_AncestryFail_EmitsPreflightWithPassedFalse`
   - `DispatchGuard_AllGuardsPass_EmitsPreflightWithPassedTrue`
   - `DispatchGuard_StashObservedInWorktree_EmitsStashDetected`
   - File: `servers/exarchos-mcp/src/dispatch/dispatch-guard.test.ts`

2. **[GREEN]**
   - Thread `eventStore` + `DispatchContext` into `dispatch-guard.ts` via composer.
   - Invoke `emitGateEvent({ kind: 'dispatch.preflight', ... })` after each guard outcome.
   - Add stash-detection probe; emit `stash.detected` on observation.
   - Files: `servers/exarchos-mcp/src/dispatch/dispatch-guard.ts`, `servers/exarchos-mcp/src/dispatch/composer.ts`.

3. **[REFACTOR]** Pattern-match the existing #1119 autonomous-merge gate event emission.

**Dependencies:** T22.
**Acceptance:** All three scenarios pass; `exarchos_view convergence` shows preflight-gate convergence per workflow.

---

### PR B3 — #1272 EventSourcedTaskStore

**Branch:** `feature/preview4-wave-b-pr3-task-store` (base: `feature/preview4-wave-b-pr2-preflight-events`)
**Risk:** medium (new projection + new event family; replaces InMemoryTaskStore)
**LOC budget:** ~380 impl + ~280 test

#### Task T24: Task.* event schemas

1. **[RED]** Tests:
   - `EventSchema_TaskCreated_ValidatesShape`
   - `EventSchema_TaskPolled_ValidatesShape`
   - `EventSchema_TaskResult_ValidatesShape`
   - `EventSchema_TaskCancelled_ValidatesShape`
   - File: `servers/exarchos-mcp/src/event-store/task-events.test.ts`

2. **[GREEN]** Define event schemas; each carries `_meta` from B1.
3. **[REFACTOR]** None.

**Dependencies:** PR B1.
**Acceptance:** Schemas exported and validated.

#### Task T25: EventSourcedTaskStore class

1. **[RED]** Tests:
   - `EventSourcedTaskStore_CreateTask_EmitsTaskCreatedAndReturnsId`
   - `EventSourcedTaskStore_GetTask_ReadsProjectionAtSequence`
   - `EventSourcedTaskStore_GetTaskResult_WaitsOnTaskResultEvent`
   - `EventSourcedTaskStore_CancelTask_EmitsTaskCancelled`
   - `EventSourcedTaskStore_LifecycleReconstructable_FromEventStreamAlone` (replay test)
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`

2. **[GREEN]**
   - Implement `EventSourcedTaskStore implements TaskStore` (SDK interface).
   - Each method translates to an event emission + projection read.
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`.

3. **[REFACTOR]** None.

**Dependencies:** T24.
**Acceptance:** Replay test reconstructs full lifecycle from events alone.

#### Task T26: TTL-bounded projection

1. **[RED]** Test: `TaskStoreProjection_TtlExpired_RemovesFromProjection` — file: same as T25.
2. **[GREEN]** Project task state with per-task `expiresAt`; reaper expires entries past TTL on next read.
3. **[REFACTOR]** None.

**Dependencies:** T25.
**Acceptance:** Expired tasks not visible in projection reads.

#### Task T27: Remove InMemoryTaskStore from production wiring

1. **[RED]** Test: `Production_NoInMemoryTaskStore_Instances` — static-analysis grep test; asserts production code paths do not instantiate the SDK's `InMemoryTaskStore`.
2. **[GREEN]** Replace any `new InMemoryTaskStore()` in production composers with the event-sourced variant.
3. **[REFACTOR]** Keep `InMemoryTaskStore` only in test fixtures where event-sourcing overhead is undesirable.

**Dependencies:** T25, T26.
**Acceptance:** Grep test passes.

---

## Wave C — Tasks Dispatch-Core (#1273)

### PR C1 — Dispatch-core Tasks-augmented path

**Branch:** `feature/preview4-wave-c-pr1-dispatch-core` (base: `feature/preview4-wave-b-pr3-task-store`)
**Risk:** medium (touches dispatch core; preserves one-shot path as fallback)
**LOC budget:** ~340 impl + ~260 test

#### Task T28: Dispatch core branches one-shot vs Tasks-augmented

1. **[RED]** Tests:
   - `DispatchCore_NoTaskOption_ReturnsEnvelope` (one-shot path preserved)
   - `DispatchCore_TaskOptionPresent_ReturnsCreateTaskResult`
   - `DispatchCore_TaskAugmented_EmitsTaskCreated`
   - File: `servers/exarchos-mcp/src/dispatch/dispatch-core.test.ts`

2. **[GREEN]**
   - In `dispatch()`, detect `options.task: { ttl }` flag.
   - Tasks-augmented branch: synthesize `CreateTaskResult` via `EventSourcedTaskStore.createTask(...)`; emit `task.created`; return `CreateTaskResult` envelope.
   - One-shot branch: unchanged.
   - File: `servers/exarchos-mcp/src/dispatch/dispatch-core.ts`.

3. **[REFACTOR]** Extract per-branch synthesis into helpers.

**Dependencies:** PR B3.
**Acceptance:** Both branches' tests pass; no regression in existing one-shot consumers.

#### Task T29: Task lifecycle event emission from dispatch core

1. **[RED]** Test: `DispatchCore_TaskLifecycle_EmitsCreatedPolledResult` — outcome-tier at `tests/outcome/tasks-dispatch-lifecycle.test.ts`.
2. **[GREEN]** Wire `task.polled` emission on each `TaskStore.getTask` call; `task.result` on completion. Threaded with `DispatchContext` from PR B1.
3. **[REFACTOR]** None.

**Dependencies:** T28.
**Acceptance:** Full lifecycle reconstructable from event stream + outcome-tier scenario passes.

---

### PR C2 — MCP adapter tasks/* methods

**Branch:** `feature/preview4-wave-c-pr2-mcp-tasks` (base: `feature/preview4-wave-c-pr1-dispatch-core`)
**Risk:** medium (new MCP methods; capability gating; protocol conformance)
**LOC budget:** ~280 impl + ~240 test

#### Task T30: tools/call with task augmentation

1. **[RED]** Tests:
   - `McpToolsCall_WithTaskTtl_ReturnsCreateTaskResult`
   - `McpToolsCall_NoTaskTtl_ReturnsEnvelopeOneShot`
   - File: `servers/exarchos-mcp/src/mcp/tools-call-handler.test.ts`

2. **[GREEN]** Accept `task: { ttl }` in `tools/call` params; route to dispatch-core's Tasks-augmented branch.
3. **[REFACTOR]** None.

**Dependencies:** PR C1.
**Acceptance:** Both shapes covered.

#### Task T31: tasks/get, tasks/result, tasks/cancel methods

1. **[RED]** Tests:
   - `McpTasksGet_ValidTaskId_ReturnsCurrentTaskState`
   - `McpTasksResult_TaskComplete_ReturnsFinalOutcome`
   - `McpTasksCancel_EmitsTaskCancelled`
   - `McpTasksCancel_AlreadyCompleted_ReturnsValidationError`
   - File: `servers/exarchos-mcp/src/mcp/tasks-methods.test.ts`

2. **[GREEN]** Implement the three MCP methods against `EventSourcedTaskStore`. Routes through the same dispatch-core helpers as CLI `--follow` (INV-2 facade equivalence).
3. **[REFACTOR]** Shared helper for taskId validation.

**Dependencies:** T30.
**Acceptance:** All four scenarios covered; SDK conformance verified.

#### Task T32: taskSupport capability gating

1. **[RED]** Tests:
   - `CapabilityResolver_TaskSupportOptional_Declared`
   - `Dispatch_NoTaskSupportClient_FallsBackToOneShotIgnoringTaskOption`
   - File: `servers/exarchos-mcp/src/capability/task-support.test.ts`

2. **[GREEN]** Add `taskSupport: 'optional'` to server capability declaration; check client snapshot before honoring `task: { ttl }` augmentation.
3. **[REFACTOR]** None.

**Dependencies:** T31.
**Acceptance:** Non-Task clients always get one-shot envelope regardless of `task` param.

---

### PR C3 — CLI --follow integration

**Branch:** `feature/preview4-wave-c-pr3-cli-follow` (base: `feature/preview4-wave-c-pr2-mcp-tasks`)
**Risk:** medium (in-process polling loop + SIGINT handling)
**LOC budget:** ~220 impl + ~180 test

#### Task T33: --follow polling loop

1. **[RED]** Tests:
   - `CliFollow_WorkflowSubcommand_RendersTransitionsToStdout`
   - `CliFollow_ShepherdSubcommand_RendersTransitionsToStdout`
   - File: `servers/exarchos-mcp/src/cli/follow-loop.test.ts`

2. **[GREEN]** In-process polling loop calls `EventSourcedTaskStore.getTask` at 250ms cadence (configurable via `.exarchos.yml`); each transition rendered to stdout via shared formatter.
3. **[REFACTOR]** Polling-cadence resolver matches output-token threshold pattern from PR A2.

**Dependencies:** PR C2.
**Acceptance:** Both subcommands stream to stdout.

#### Task T34: SIGINT cancels via task.cancelled

1. **[RED]** Test: `CliFollow_SIGINT_CancelsTaskAndExits` — file: `servers/exarchos-mcp/src/cli/follow-loop.test.ts`.
2. **[GREEN]** Install SIGINT handler that calls `cancelTask(currentTaskId)` then exits cleanly. `task.cancelled` emitted via the same dispatch-core path as MCP `tasks/cancel` (INV-2 parity).
3. **[REFACTOR]** None.

**Dependencies:** T33.
**Acceptance:** SIGINT during `--follow` emits `task.cancelled` event with `operationId`; process exits with appropriate code.

---

## Cross-cutting — Version bump + release notes

### Task T35: Bump version to 2.10.0-preview.4

1. **[GREEN]** Run only after all 13 PRs merge. Update `package.json` version, `servers/exarchos-mcp/package.json` version, run `npm install` to refresh lock.
2. **[GREEN]** Update `CHANGELOG.md` with preview.4 section listing the 11 issues by wave.
3. **[REFACTOR]** None.

**Dependencies:** All 13 PRs merged.
**Acceptance:** Version bumped; CHANGELOG entry present; build clean.

### Task T36: Outcome-tier full sweep on main

1. **[GREEN]** After T35, run `npm run test:run` (full) + `cd servers/exarchos-mcp && npm run test:run` + outcome-tier suite (`vitest run tests/outcome/`).
2. **[GREEN]** Address any cross-wave regression discovered (broad-blast-radius gate per project memory).
3. **[REFACTOR]** None.

**Dependencies:** T35.
**Acceptance:** Full suites clean; no `tool.action_errored` regression in `view telemetry`.

---

## Quality gate checklist (per PR)

Each of the 13 PRs runs the same gate set before merge:

- [ ] `npm run typecheck` clean (repo root + `servers/exarchos-mcp`).
- [ ] `npm run test:run` clean (repo root).
- [ ] `cd servers/exarchos-mcp && npm run test:run` clean.
- [ ] `npm run skills:guard` clean.
- [ ] Outcome-tier scoped to the touched surface clean.
- [ ] No regression in `view telemetry.errors` or `view telemetry.actionErrors`.
- [ ] PR template has required sections (`## Summary`, `## Changes`, `## Test Plan`).
- [ ] Co-authored-by trailer present on every commit.

## Provenance — design-DR → task map

| Design section / DR | Tasks |
|---|---|
| Wave A · #1238 Zod unions | T01, T02 |
| Wave A · #1262 quality hint | T03, T04, T05 |
| Wave A · #1290 Roots discovery | T06, T07, T08 |
| Wave A · #1274 Elicitation | T09, T10 |
| Wave D · #1260 invariants | T11, T12, T13 |
| Wave D · #1298 sidecar | T14, T15, T16 |
| Wave D · #1244 handoff lint | T17 |
| Wave B · #1291 correlation | T18, T19, T20, T21 |
| Wave B · #1261 preflight events | T22, T23 |
| Wave B · #1272 EventSourcedTaskStore | T24, T25, T26, T27 |
| Wave C · #1273 dispatch-core | T28, T29 |
| Wave C · #1273 MCP adapter | T30, T31, T32 |
| Wave C · #1273 CLI --follow | T33, T34 |
| Cross-cutting · version + sweep | T35, T36 |

**Total: 36 tasks across 13 PRs.** Every design behavior maps to at least one task; every task names a failing test first.

## Risk-driven sequencing notes

- **Wave A + Wave D parallel:** dispatch both wave-root branches simultaneously to subagent teams; each wave is internally serial.
- **Wave B follows A∪D:** the three-field correlation merges into main only after Waves A + D are in main, so its broad-blast-radius rebase surface is minimized.
- **Wave C follows B:** C consumes B's `EventSourcedTaskStore` directly; cannot parallelize.
- **Worktree hygiene** (project memory [stash collision](feedback_subagent_stash_hazard), [worktree isolation](feedback_subagent_worktree_isolation_gap)): each subagent worktree branches from the wave's integration branch with explicit `git checkout -B`; `npm install` runs inside `servers/exarchos-mcp/` before scoped tests.
- **Commit artifacts first** (project memory [commit before dispatch](feedback_orchestrator_commit_before_dispatch)): this design + plan + sidecars must be committed to main (or the appropriate wave integration branch) BEFORE any subagent dispatch.
- **Per-task TDD insufficient for B1** (project memory [blast-radius gate](feedback_tdd_gate_blast_radius)): T21 explicitly runs full-suite regression after correlation threading — this is the gate the per-task scope misses.
