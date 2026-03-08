# Implementation Plan: Open Issues Consolidation

Design: `docs/designs/2026-03-07-open-issues-consolidation.md`
Addresses: #968, #952, #350 (rescoped)

## Parallelization Strategy

Three tracks are fully independent and can be delegated to separate agents:

```
Track 1 (CI)      ──── T1 ──────────────────────────────────────────────────
Track 2 (Events)  ──── T2→T3→T4→T5 ─── T6 ─── T7 ─── T8 ─────────────────
Track 3 (Extend)  ──── T9→T10→T11 ───── T12→T13 ───── T14→T15 ────────────
```

- Track 1: Solo task, no server code
- Track 2: Sequential chain (shepherd events share assess-stack.ts), then independent tasks
- Track 3: Three sub-chains (events → views → tools), each sequential internally

**Cross-track dependency:** Track 2 (T8: remove team.context.injected from schemas.ts) should merge before Track 3 (T9: add registerEventType to schemas.ts) to avoid merge conflicts. In practice, both modify different parts of schemas.ts and can likely merge cleanly.

---

## Track 1: CI Eval Wiring (#968)

### Task 1: Add prompts path filter and conditional RUN_EVALS to ci.yml

**Phase:** GREEN (no test — CI workflow YAML)

1. [GREEN] Add `prompts` filter group to `dorny/paths-filter` in `.github/workflows/ci.yml`:
   ```yaml
   prompts:
     - 'skills/**'
     - 'commands/**'
     - 'rules/**'
     - 'evals/**'
     - 'servers/exarchos-mcp/src/evals/**'
     - 'servers/exarchos-mcp/src/workflow/playbooks.ts'
   ```
2. [GREEN] Add `prompts` to the `changes` job outputs
3. [GREEN] Add conditional `env` to `test-mcp` job:
   ```yaml
   env:
     RUN_EVALS: ${{ needs.changes.outputs.prompts == 'true' && '1' || '' }}
     ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

**Files:** `.github/workflows/ci.yml`
**Dependencies:** None
**Parallelizable:** Yes (independent track)

---

## Track 2: Event Emitter Gaps (#952)

### Task 2: Shepherd started — auto-emit from assess-stack

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `HandleAssessStack_FirstInvocation_EmitsShepherdStarted`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Setup: EventStore with no prior `shepherd.started` events
   - Call `handleAssessStack` with valid args
   - Assert: `shepherd.started` event appended with `{ prUrl, featureId }`
   - Expected failure: No emission code exists

2. [RED] Write test: `HandleAssessStack_SubsequentInvocation_DoesNotReEmitShepherdStarted`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Setup: EventStore with existing `shepherd.started` event
   - Call `handleAssessStack`
   - Assert: No duplicate `shepherd.started` emitted (idempotency)
   - Expected failure: No emission code exists

3. [GREEN] Implement shepherd.started emission in `handleAssessStack`:
   - Query for existing `shepherd.started` events
   - If none, emit `shepherd.started` with PR URL and feature ID
   - Use idempotency key: `${featureId}:shepherd.started`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.ts`

**Dependencies:** None
**Parallelizable:** No (T2→T3→T4→T5 are sequential — share assess-stack.ts)

---

### Task 3: Shepherd approval_requested — auto-emit from assess-stack

**Phase:** RED → GREEN

1. [RED] Write test: `HandleAssessStack_AllChecksPassing_EmitsApprovalRequested`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Setup: PR statuses all passing, recommendation = `'request-approval'`
   - Assert: `shepherd.approval_requested` event emitted with `{ prUrl }`
   - Expected failure: No emission code

2. [RED] Write test: `HandleAssessStack_ChecksFailing_DoesNotEmitApprovalRequested`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Setup: Failing checks, recommendation = `'fix-and-resubmit'`
   - Assert: No `shepherd.approval_requested` emitted

3. [GREEN] Implement in `handleAssessStack`:
   - After computing recommendation, if `'request-approval'`, emit `shepherd.approval_requested`
   - Idempotency key: `${featureId}:shepherd.approval_requested:${iterationCount}`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.ts`

**Dependencies:** Task 2
**Parallelizable:** No (sequential with T2)

---

### Task 4: Shepherd completed — auto-emit from assess-stack

**Phase:** RED → GREEN

1. [RED] Write test: `HandleAssessStack_PrMerged_EmitsShepherdCompleted`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Setup: PR status indicates merged
   - Assert: `shepherd.completed` event emitted with `{ prUrl, outcome: 'merged' }`

2. [GREEN] Implement in `handleAssessStack`:
   - Check if any PR is merged in the status results
   - If merged, emit `shepherd.completed` with outcome
   - Idempotency key: `${featureId}:shepherd.completed`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.ts`

**Dependencies:** Task 3
**Parallelizable:** No (sequential with T3)

---

### Task 5: Shepherd status view — add lifecycle event handlers

**Phase:** RED → GREEN

1. [RED] Write test: `ShepherdStatusView_ShepherdStarted_RecordsStartTime`
   - File: `servers/exarchos-mcp/src/views/shepherd-status-view.test.ts`
   - Apply `shepherd.started` event to initial state
   - Assert: State includes `startedAt` timestamp
   - Expected failure: No handler in switch statement

2. [RED] Write test: `ShepherdStatusView_ApprovalRequested_RecordsRequestTime`
   - Assert: State includes `approvalRequestedAt`

3. [RED] Write test: `ShepherdStatusView_Completed_RecordsOutcome`
   - Assert: State includes `completedAt` and `outcome`

4. [GREEN] Add `startedAt`, `approvalRequestedAt`, `completedAt`, `outcome` fields to `ShepherdStatusState`
5. [GREEN] Add three case handlers in `apply()` switch:
   - `'shepherd.started'` → sets `startedAt`
   - `'shepherd.approval_requested'` → sets `approvalRequestedAt`
   - `'shepherd.completed'` → sets `completedAt`, `outcome`
   - File: `servers/exarchos-mcp/src/views/shepherd-status-view.ts`

6. [GREEN] Remove `@planned` annotations from `ShepherdStartedData`, `ShepherdApprovalRequestedData`, `ShepherdCompletedData` in schemas.ts
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`

7. [GREEN] Add shepherd lifecycle events to synthesize playbook events array
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`

**Dependencies:** Task 4 (schemas.ts changes coordinate)
**Parallelizable:** Yes (independent from T4, different files)

---

### Task 6: Add task.progressed to delegate playbook

**Phase:** RED → GREEN

1. [RED] Write test: `CheckEventEmissions_DelegatePhase_IncludesTaskProgressed`
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.test.ts`
   - Assert: `PHASE_EXPECTED_EVENTS.delegate` includes `'task.progressed'`
   - Expected failure: Not in the expected events list

2. [GREEN] Add `task.progressed` to delegate phase playbook events array:
   ```
   { type: 'task.progressed', when: 'After each TDD phase transition (red/green/refactor)' }
   ```
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`

3. [GREEN] Add `'task.progressed'` to `PHASE_EXPECTED_EVENTS.delegate` in check-event-emissions.ts
   - File: `servers/exarchos-mcp/src/orchestrate/check-event-emissions.ts`

**Dependencies:** None
**Parallelizable:** Yes (after T5 completes — shares playbooks.ts)

---

### Task 7: Wire eval.judge.calibrated emission

**Phase:** RED → GREEN

1. [RED] Write test: `LlmRubricGrader_WithEventStore_EmitsJudgeCalibratedEvent`
   - File: `servers/exarchos-mcp/src/evals/graders/llm-rubric.test.ts`
   - Setup: Grader with optional EventStore + featureId in config
   - Grade a case that produces calibration metrics
   - Assert: `eval.judge.calibrated` event appended with TPR/TNR/F1 data
   - Expected failure: No emission code in grader

2. [GREEN] Add optional `eventStore` and `featureId` to grader config interface
3. [GREEN] After computing grade result with calibration data, emit `eval.judge.calibrated` if eventStore is provided
   - File: `servers/exarchos-mcp/src/evals/graders/llm-rubric.ts`

4. [GREEN] Remove `@planned` annotation from `JudgeCalibratedDataSchema` in schemas.ts (if present)
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`

**Dependencies:** None
**Parallelizable:** Yes (independent files)

---

### Task 8: Remove team.context.injected schema

**Phase:** RED → GREEN

1. [RED] Write test: `EventTypes_DoesNotInclude_TeamContextInjected`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Assert: `EventTypes` array does not contain `'team.context.injected'`
   - Expected failure: Still in the array

2. [GREEN] Remove from:
   - `EventTypes` array (line 37)
   - `EVENT_EMISSION_REGISTRY` (line 133)
   - `TeamContextInjectedData` schema definition
   - `EVENT_DATA_SCHEMAS` entry (line 695)
   - `EventDataMap` type entry (line 834)
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`

3. [GREEN] Remove case statement from `workflow-state-projection.ts` (line 269)
   - File: `servers/exarchos-mcp/src/views/workflow-state-projection.ts`

4. [GREEN] Update any test that references `team.context.injected` in event type lists
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` (line 299)

**Dependencies:** None
**Parallelizable:** Yes (independent concern within schemas.ts)

---

## Track 3: Post-GA Extensibility (#350 rescoped)

### Task 9: Implement registerEventType() in schemas.ts

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `RegisterEventType_CustomType_AddsToEventTypes`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Call `registerEventType('deploy.started', { source: 'auto', schema: z.object({...}) })`
   - Assert: Event type appears in valid event types
   - Expected failure: Function doesn't exist

2. [RED] Write test: `RegisterEventType_BuiltInType_Throws`
   - Assert: Registering `'workflow.started'` throws collision error

3. [RED] Write test: `RegisterEventType_DuplicateCustomType_Throws`
   - Register same type twice, second throws

4. [RED] Write test: `UnregisterEventType_CustomType_RemovesIt`
   - For test cleanup

5. [GREEN] Implement `registerEventType(name, { source, schema })`:
   - Validate name is kebab-case with dot separator
   - Check collision with built-in types
   - Add to mutable extension set (parallel to `extendWorkflowTypeEnum`)
   - Register schema in `EVENT_DATA_SCHEMAS`
   - Register source in `EVENT_EMISSION_REGISTRY`
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`

6. [GREEN] Implement `unregisterEventType(name)` for cleanup
7. [GREEN] Implement `getValidEventTypes()` returning built-in + custom

**Dependencies:** Task 8 (schema cleanup first)
**Parallelizable:** No (T9→T10→T11 sequential — share schemas.ts and config)

---

### Task 10: Add events field to ExarchosConfig

**Phase:** RED → GREEN

1. [RED] Write test: `LoadConfig_WithEvents_ParsesEventDefinitions`
   - File: `servers/exarchos-mcp/src/config/loader.test.ts`
   - Config with `events: { 'deploy.started': { source: 'auto', schema: z.object({...}) } }`
   - Assert: Parsed config has events field
   - Expected failure: Validation rejects unknown field

2. [RED] Write test: `LoadConfig_WithInvalidEventSource_Fails`
   - Config with `events: { 'x': { source: 'invalid' } }`
   - Assert: Validation error

3. [GREEN] Add `events` field to `ExarchosConfig` interface in `config/define.ts`
4. [GREEN] Add Zod validation for events in config loader
   - File: `servers/exarchos-mcp/src/config/define.ts`, `servers/exarchos-mcp/src/config/loader.ts`

**Dependencies:** Task 9
**Parallelizable:** No (sequential with T9)

---

### Task 11: Wire event registration in register.ts

**Phase:** RED → GREEN

1. [RED] Write test: `RegisterCustomWorkflows_WithEvents_RegistersEventTypes`
   - File: `servers/exarchos-mcp/src/config/register.test.ts`
   - Config with workflows + events
   - Assert: Custom event types appear in `getValidEventTypes()`

2. [RED] Write test: `RegisterCustomWorkflows_EventRegistrationFails_RollsBack`
   - Assert: Partial registration is rolled back on error

3. [GREEN] Extend `registerCustomWorkflows()` to also register events:
   - After workflow registration loop, iterate `config.events`
   - Call `registerEventType()` for each
   - Track registered events for rollback
   - File: `servers/exarchos-mcp/src/config/register.ts`

**Dependencies:** Task 10
**Parallelizable:** No (sequential with T10)

---

### Task 12: Extract view registry from hardcoded wiring

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ViewRegistry_RegisterCustomView_MaterializesEvents`
   - File: `servers/exarchos-mcp/src/views/registry.test.ts` (new)
   - Register a custom view with `init()` and `apply()` functions
   - Materialize events through it
   - Assert: View state reflects applied events
   - Expected failure: No registry exists

2. [RED] Write test: `ViewRegistry_BuiltInViewName_Throws`
   - Assert: Registering `'pipeline'` (built-in) throws

3. [GREEN] Create `servers/exarchos-mcp/src/views/registry.ts`:
   - Export `registerCustomView(name, projection)` → registers in ViewMaterializer
   - Export `unregisterCustomView(name)` for cleanup
   - Built-in view name protection
   - Accepts `ViewProjection<T>` interface (already exists in materializer.ts)

4. [REFACTOR] Extract built-in view list as a protected set for collision detection

**Dependencies:** None (independent sub-chain)
**Parallelizable:** Yes (T12→T13 is independent from T9→T10→T11)

---

### Task 13: Add views field to ExarchosConfig and wire registration

**Phase:** RED → GREEN

1. [RED] Write test: `LoadConfig_WithViews_ParsesViewDefinitions`
   - File: `servers/exarchos-mcp/src/config/loader.test.ts`
   - Config with `views: { 'deploy-status': { events: ['deploy.started'], handler: './views/deploy.ts' } }`
   - Assert: Parsed config has views field

2. [RED] Write test: `RegisterCustomWorkflows_WithViews_RegistersViews`
   - File: `servers/exarchos-mcp/src/config/register.test.ts`
   - Assert: Custom view is registered and materializable

3. [GREEN] Add `views` field to `ExarchosConfig` in `config/define.ts`
4. [GREEN] Add validation in loader
5. [GREEN] Wire view registration in `register.ts`:
   - Dynamic import of handler module from `handler` path
   - Validate handler exports `init()` and `apply()`
   - Register via `registerCustomView()`
   - File: `servers/exarchos-mcp/src/config/register.ts`

**Dependencies:** Task 12
**Parallelizable:** No (sequential with T12)

---

### Task 14: Extend TOOL_REGISTRY for dynamic registration

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `RegisterCustomTool_AddsToRegistry`
   - File: `servers/exarchos-mcp/src/registry.test.ts`
   - Register a custom tool with name, description, and actions
   - Assert: Tool appears in registry iteration
   - Expected failure: No registration function

2. [RED] Write test: `RegisterCustomTool_BuiltInName_Throws`
   - Assert: Registering `'exarchos_workflow'` throws

3. [RED] Write test: `RegisterCustomTool_GeneratesCliAndMcpSurface`
   - Assert: Custom tool has valid schema for MCP registration

4. [GREEN] Implement `registerCustomTool(tool)`:
   - Validate name doesn't collide with built-in tools
   - Add to mutable extension array alongside static TOOL_REGISTRY
   - Export `getFullRegistry()` returning built-in + custom
   - File: `servers/exarchos-mcp/src/registry.ts`

5. [GREEN] Update CLI builder and MCP adapter to use `getFullRegistry()` instead of `TOOL_REGISTRY`
   - File: `servers/exarchos-mcp/src/adapters/cli.ts`, `servers/exarchos-mcp/src/adapters/mcp.ts`

6. [REFACTOR] Ensure `unregisterCustomTool(name)` exists for test cleanup

**Dependencies:** None (independent sub-chain)
**Parallelizable:** Yes (T14→T15 is independent from T12→T13)

---

### Task 15: Add tools field to ExarchosConfig and wire registration

**Phase:** RED → GREEN

1. [RED] Write test: `LoadConfig_WithTools_ParsesToolDefinitions`
   - File: `servers/exarchos-mcp/src/config/loader.test.ts`
   - Config with `tools: { deploy: { description: '...', actions: [...] } }`
   - Assert: Parsed config has tools field

2. [RED] Write test: `RegisterCustomWorkflows_WithTools_RegistersTools`
   - File: `servers/exarchos-mcp/src/config/register.test.ts`
   - Assert: Custom tool appears in `getFullRegistry()`

3. [GREEN] Add `tools` field to `ExarchosConfig` in `config/define.ts`
4. [GREEN] Add validation in loader
5. [GREEN] Wire tool registration in `register.ts`:
   - Dynamic import of handler modules from action `handler` paths
   - Build `ToolAction` entries from config schema + imported handler
   - Register via `registerCustomTool()`
   - File: `servers/exarchos-mcp/src/config/register.ts`

**Dependencies:** Task 14
**Parallelizable:** No (sequential with T14)

---

## Task Summary

| ID | Track | Title | Deps | Parallel? |
|----|-------|-------|------|-----------|
| T1 | 1 | CI prompts filter + RUN_EVALS | None | Yes |
| T2 | 2 | Shepherd started emission | None | Yes |
| T3 | 2 | Shepherd approval_requested emission | T2 | No |
| T4 | 2 | Shepherd completed emission | T3 | No |
| T5 | 2 | Shepherd view lifecycle handlers + playbook | T4 | No |
| T6 | 2 | task.progressed playbook instruction | T5 | Yes |
| T7 | 2 | eval.judge.calibrated emission | None | Yes |
| T8 | 2 | Remove team.context.injected | None | Yes |
| T9 | 3 | registerEventType() in schemas.ts | T8 | No |
| T10 | 3 | ExarchosConfig events field | T9 | No |
| T11 | 3 | Wire event registration in register.ts | T10 | No |
| T12 | 3 | Extract view registry | None | Yes |
| T13 | 3 | ExarchosConfig views field + wire | T12 | No |
| T14 | 3 | TOOL_REGISTRY dynamic registration | None | Yes |
| T15 | 3 | ExarchosConfig tools field + wire | T14 | No |

## Delegation Strategy

Five parallel agents:

| Agent | Tasks | Branch |
|-------|-------|--------|
| Agent A | T1 | `feat/ci-eval-wiring` |
| Agent B | T2→T3→T4→T5→T6 | `feat/shepherd-lifecycle-events` |
| Agent C | T7, T8 | `feat/event-emitter-cleanup` |
| Agent D | T9→T10→T11 | `feat/extensible-event-registry` |
| Agent E | T12→T13, T14→T15 | `feat/extensible-views-tools` |

**Merge order:** A (independent) → C (schema cleanup) → B (shepherd events) → D (event registry) → E (views + tools)

Stacked PR base chain: `main` ← A ← C ← B ← D ← E
