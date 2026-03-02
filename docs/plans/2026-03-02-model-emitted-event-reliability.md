# Implementation Plan: Model-Emitted Event Reliability

## Source Design
Brief: Refactor workflow `refactor-model-emitted-events`, brief phase.
Related issue: #952 (unimplemented event emitters tracking)

## Scope
**Target:** Full — emission source registry, boundary validation, emission hints, drive-by fix
**Excluded:** View-layer Zod migration (dropped per D4 — Zod on hot paths is anti-pattern). Eval event emitter wiring (tracked in #952).

## Summary
- Total tasks: 9
- Parallel groups: 3
- Estimated test count: ~25
- Files touched: ~8 production, ~8 test

## Spec Traceability

| Goal | Tasks | Verification |
|------|-------|-------------|
| G1: Emission source registry | T1, T2 | Registry covers all 65 event types |
| G2: Boundary data validation | T3, T4 | Malformed model-emitted event data rejected at append |
| G3: Event emission hints | T5, T6, T7, T8 | `_eventHints` injected when expected events missing |
| G4: Drive-by @planned fix | T9 | Annotation removed, tests pass |

## Task Breakdown

### Task 1: Add EventEmissionSource type and EVENT_EMISSION_REGISTRY

**Implements:** G1
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `EventEmissionRegistry_AllEventTypes_HaveClassification`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: `EVENT_EMISSION_REGISTRY` not exported / missing types
   - Test: every entry in `EventTypes` array has a corresponding key in `EVENT_EMISSION_REGISTRY`

2. [RED] Write test: `EventEmissionRegistry_ModelEvents_IncludesTeamAndReview`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: registry does not exist
   - Test: spot-check known model-emitted types (`team.spawned`, `review.routed`, etc.) have `source: 'model'`

3. [RED] Write test: `EventEmissionRegistry_AutoEvents_IncludesWorkflowAndTask`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: registry does not exist
   - Test: spot-check known auto-emitted types (`workflow.transition`, `task.completed`, etc.) have `source: 'auto'`

4. [GREEN] Add `EventEmissionSource` type and `EVENT_EMISSION_REGISTRY` constant
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Type: `type EventEmissionSource = 'auto' | 'model' | 'hook' | 'planned'`
   - Constant: `Record<EventType, EventEmissionSource>` mapping all 65 types
   - Export both

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: Add EVENT_DATA_SCHEMAS map for type-specific validation

**Implements:** G2
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["completeness: every EventType maps to a schema or null", "schema compliance: EVENT_DATA_SCHEMAS[type].parse(validData) succeeds for all typed events"] }`

**TDD Steps:**
1. [RED] Write test: `EventDataSchemas_AllEventTypes_HaveEntry`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: `EVENT_DATA_SCHEMAS` not exported
   - Test: every entry in `EventTypes` has a key in `EVENT_DATA_SCHEMAS` (value may be `null`)

2. [RED] Write test: `EventDataSchemas_ModelEvents_HaveNonNullSchemas`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: map does not exist
   - Test: every event type where `EVENT_EMISSION_REGISTRY[type] === 'model'` has a non-null Zod schema

3. [RED] Write test: `EventDataSchemas_ValidData_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: map does not exist
   - Test: for each non-null entry, parse known-valid data and verify success

4. [GREEN] Add `EVENT_DATA_SCHEMAS` constant
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Type: `Partial<Record<EventType, z.ZodSchema>>` (missing key = no data validation)
   - Map each event type with an existing data schema to its Zod schema
   - Model-emitted events MUST have entries; auto-emitted events MAY have entries

**Dependencies:** Task 1 (needs `EVENT_EMISSION_REGISTRY` to know which events are model-emitted)
**Parallelizable:** No (depends on T1)

---

### Task 3: Wire type-specific data validation into buildValidatedEvent

**Implements:** G2
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `BuildValidatedEvent_ModelEventWithValidData_Succeeds`
   - File: `servers/exarchos-mcp/src/event-store/event-factory.test.ts`
   - Expected failure: no data validation happens (currently passes any data)
   - Test: call `buildValidatedEvent` with `type: 'team.spawned'` and valid `TeamSpawnedData`, verify success

2. [RED] Write test: `BuildValidatedEvent_ModelEventWithInvalidData_Throws`
   - File: `servers/exarchos-mcp/src/event-store/event-factory.test.ts`
   - Expected failure: currently accepts any data
   - Test: call `buildValidatedEvent` with `type: 'team.spawned'` and `{ foo: 'bar' }`, expect Zod error

3. [RED] Write test: `BuildValidatedEvent_AutoEventWithAnyData_Succeeds`
   - File: `servers/exarchos-mcp/src/event-store/event-factory.test.ts`
   - Expected failure: none expected (test should pass immediately — this verifies no regression)
   - Test: call with `type: 'workflow.transition'` and arbitrary data, verify it still succeeds

4. [RED] Write test: `BuildValidatedEvent_ModelEventWithNoData_Succeeds`
   - File: `servers/exarchos-mcp/src/event-store/event-factory.test.ts`
   - Expected failure: depends on whether data is required by schema
   - Test: call with `type: 'team.spawned'` and `data: undefined`, verify behavior

5. [GREEN] Add conditional data validation in `buildValidatedEvent`
   - File: `servers/exarchos-mcp/src/event-store/event-factory.ts`
   - After `WorkflowEventBase.parse()`, look up `EVENT_DATA_SCHEMAS[event.type]`
   - If schema exists and `event.data` is defined, call `schema.parse(event.data)`
   - If schema exists and `event.data` is undefined, skip (data is optional on base schema)
   - Throw with descriptive error message including event type and Zod issues

**Dependencies:** Task 2 (needs `EVENT_DATA_SCHEMAS`)
**Parallelizable:** No (depends on T2)

---

### Task 4: Wire data validation into handleEventAppend error path

**Implements:** G2
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `HandleEventAppend_ModelEventInvalidData_ReturnsValidationError`
   - File: `servers/exarchos-mcp/src/event-store/tools.test.ts`
   - Expected failure: currently succeeds with any data
   - Test: call `handleEventAppend` with `type: 'team.task.completed'` and invalid data, expect `{ success: false, error: { code: 'VALIDATION_ERROR' } }`

2. [RED] Write test: `HandleEventAppend_ModelEventValidData_Succeeds`
   - File: `servers/exarchos-mcp/src/event-store/tools.test.ts`
   - Expected failure: none expected (regression guard)
   - Test: call with valid `TeamTaskCompletedData`, verify success

3. [GREEN] Add `VALIDATION_ERROR` catch in `handleEventAppend`
   - File: `servers/exarchos-mcp/src/event-store/tools.ts`
   - Catch Zod errors from `buildValidatedEvent` and return `{ success: false, error: { code: 'VALIDATION_ERROR', message: ... } }`
   - Include event type and field-level errors in message for model actionability

**Dependencies:** Task 3 (needs validation wired into factory)
**Parallelizable:** No (depends on T3)

---

### Task 5: Create phase-to-expected-events registry

**Implements:** G3
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["completeness: every workflow phase has an entry", "monotonicity: later phases expect superset of earlier phase events"] }`

**TDD Steps:**
1. [RED] Write test: `PhaseExpectedEvents_DelegatePhase_ExpectsTeamEvents`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Expected failure: module does not exist
   - Test: `PHASE_EXPECTED_EVENTS['delegate']` includes `team.spawned`, `team.teammate.dispatched`

2. [RED] Write test: `PhaseExpectedEvents_ReviewPhase_ExpectsReviewEvents`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Expected failure: module does not exist
   - Test: `PHASE_EXPECTED_EVENTS['review']` includes `review.routed`

3. [RED] Write test: `PhaseExpectedEvents_SynthesizePhase_ExpectsStackAndShepherd`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Expected failure: module does not exist
   - Test: `PHASE_EXPECTED_EVENTS['synthesize']` includes `stack.submitted`, `shepherd.iteration`

4. [GREEN] Create phase-expected-events registry
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.ts`
   - Export `PHASE_EXPECTED_EVENTS: Record<string, EventType[]>` mapping workflow phases to expected model-emitted events
   - Only include model-emitted events (filter via `EVENT_EMISSION_REGISTRY`)

**Dependencies:** Task 1 (needs `EVENT_EMISSION_REGISTRY` to filter model-emitted events)
**Parallelizable:** Yes (parallel with T2-T4 after T1 completes)

---

### Task 6: Implement check_event_emissions orchestrate handler

**Implements:** G3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `CheckEventEmissions_MissingFeatureId_ReturnsError`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Expected failure: handler does not exist
   - Test: call with empty args, expect `INVALID_INPUT`

2. [RED] Write test: `CheckEventEmissions_AllExpectedEventsPresent_ReturnsNoHints`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Expected failure: handler does not exist
   - Test: mock event stream with all expected events for `delegate` phase, expect `{ hints: [], complete: true }`

3. [RED] Write test: `CheckEventEmissions_MissingTeamSpawned_ReturnsHint`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Expected failure: handler does not exist
   - Test: mock event stream missing `team.spawned` during `delegate` phase, expect hint with event type and description

4. [RED] Write test: `CheckEventEmissions_UnknownPhase_ReturnsEmptyHints`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Expected failure: handler does not exist
   - Test: call with phase not in registry, expect `{ hints: [] }`

5. [GREEN] Implement `handleCheckEventEmissions`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.ts`
   - Query workflow state for current phase via materializer
   - Query event stream for existing events
   - Compare against `PHASE_EXPECTED_EVENTS[phase]`
   - Return structured hints for missing events: `{ eventType, description, dataSchemaFields }`
   - Emit `gate.executed` event with `gateName: 'event-emissions'`, `layer: 'observability'`

**Dependencies:** Task 5 (needs phase registry)
**Parallelizable:** No (depends on T5)

---

### Task 7: Register check_event_emissions in orchestrate composite

**Implements:** G3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `HandleOrchestrate_CheckEventEmissions_RoutesToHandler`
   - File: `servers/exarchos-mcp/src/orchestrate/composite.test.ts` (or integration test)
   - Expected failure: action not registered
   - Test: call `handleOrchestrate({ action: 'check_event_emissions', featureId: 'test' }, stateDir)`, expect not `UNKNOWN_ACTION`

2. [GREEN] Register handler in composite + registry
   - File: `servers/exarchos-mcp/src/orchestrate/composite.ts`
     - Import `handleCheckEventEmissions`
     - Add to `ACTION_HANDLERS` map: `check_event_emissions: adapt(handleCheckEventEmissions)`
   - File: `servers/exarchos-mcp/src/registry.ts`
     - Add schema entry in `orchestrateActions` array

**Dependencies:** Task 6 (needs handler implementation)
**Parallelizable:** No (depends on T6)

---

### Task 8: Inject _eventHints into middleware tool responses

**Implements:** G3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `InjectEventHints_WithHints_AddsToResponse`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Expected failure: `injectEventHints` does not exist
   - Test: call `injectEventHints` with mock result and hints array, verify `_eventHints` field in parsed JSON

2. [RED] Write test: `InjectEventHints_EmptyHints_ReturnsUnchanged`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Expected failure: function does not exist
   - Test: call with empty hints, verify response unchanged

3. [RED] Write test: `InjectEventHints_NonJsonResponse_ReturnsUnchanged`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Expected failure: function does not exist
   - Test: call with non-JSON text content, verify no crash and response unchanged

4. [GREEN] Add `injectEventHints` function and wire into `withTelemetry`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.ts`
   - Add `injectEventHints(result: McpToolResult, hints: EventHint[]): McpToolResult` (same pattern as `injectAutoCorrection`)
   - In `withTelemetry`, after handler execution: if `featureId` is available, call `check_event_emissions` handler and inject hints
   - Fire-and-forget — hint generation failure never blocks the tool response
   - Keep `_eventHints` payload compact: `{ missing: [{ type, description }], phase, checked }` — under 2KB per D3

5. [REFACTOR] Extract hint injection into a shared helper if pattern duplicates `injectAutoCorrection`

**Dependencies:** Task 7 (needs handler registered to call it)
**Parallelizable:** No (depends on T7)

---

### Task 9: Remove stale @planned annotation from team.disbanded

**Implements:** G4
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `TeamDisbandedData_NoPlannedAnnotation_SchemaStillValid`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: none expected — this is a documentation-only change
   - Test: verify `TeamDisbandedData` schema parses valid data (regression guard)

2. [GREEN] Remove `/** @planned — not yet emitted in production */` comment
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Line 350: delete the JSDoc comment above `TeamDisbandedData`

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization Strategy

```
Group A (foundation):     T1 ──→ T2 ──→ T3 ──→ T4
                            │
Group B (hints):            └──→ T5 ──→ T6 ──→ T7 ──→ T8
                                 ↑
                                 │ (parallel with T2-T4 after T1)

Group C (drive-by):       T9 (independent, any time)
```

**Parallel worktrees:**
- **Worktree 1:** T1 → T2 → T3 → T4 (schema + validation chain)
- **Worktree 2:** T5 → T6 → T7 → T8 (hint infrastructure chain) — starts after T1 merges
- **Worktree 3:** T9 (drive-by, independent)

**Critical path:** T1 → T5 → T6 → T7 → T8 (hint chain depends on registry from T1)

**Realistic parallelism:** T9 runs alongside everything. T2-T4 and T5-T8 can run in parallel once T1 completes, BUT T5 imports `EVENT_EMISSION_REGISTRY` from T1. Both chains share `schemas.ts` so they must be on separate branches and merged sequentially.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Eval event emitter wiring | Tracked in #952 — separate concern from reliability infrastructure |
| View-layer Zod migration | Dropped per D4 (Zod on hot paths) — validation at append boundary instead |
| `task.assigned` / `task.progressed` production emitters | Tracked in #952 — need design decision on purpose |
| Shepherd lifecycle emitters (`started`, `approval_requested`, `completed`) | Tracked in #952 — separate from this refactor's scope |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] `EVENT_EMISSION_REGISTRY` covers all 65 event types
- [ ] Model-emitted events validated at append boundary
- [ ] `_eventHints` injected in tool responses for missing events
- [ ] Hint payloads < 2KB
- [ ] `team.disbanded` @planned annotation removed
- [ ] Ready for review
