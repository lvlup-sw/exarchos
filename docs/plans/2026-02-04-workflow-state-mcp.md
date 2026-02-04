# Implementation Plan: Workflow State MCP Server

## Source Design

Link: `docs/designs/2026-02-04-workflow-state-mcp.md`

## Scope

**Target:** Full design implementation
**Excluded:** None

## Summary

- Total tasks: 18
- Parallel groups: 4
- Estimated test count: ~87
- Design coverage: 15/15 sections covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|------------------|------------|--------|
| Package Structure | Plugin scaffolding, package.json, tsconfig, vitest config | 001 | Covered |
| MCP Tools > Zod schemas | Input/output validation for all 10 tools | 002 | Covered |
| Technical Design > Types | TypeScript types derived from Zod schemas | 002 | Covered |
| Technical Design > State Machine | HSM definition, states, transitions, guards, effects | 003, 004 | Covered |
| Technical Design > Transition Algorithm | 10-step transition with idempotency, guards, circuit breaker | 004 | Covered |
| Technical Design > Event Log | Append-only log, sequence ordering, cap, event types | 005 | Covered |
| Technical Design > Circuit Breaker | Fix-cycle counting, circuit open/blocked, recovery | 006 | Covered |
| Technical Design > Saga Compensation | Per-phase cleanup, reverse order, dry-run, idempotent | 007 | Covered |
| Technical Design > Checkpointing | Three-tier: auto, advisory, explicit; staleness; _meta | 008 | Covered |
| Technical Design > State File I/O | Atomic writes, schema validation on read | 009 | Covered |
| Technical Design > Migration | Version detection, sequential migration chain, write-back | 010 | Covered |
| Technical Design > Dot-Path Updates | Structured updates replacing jq, array access, reserved field rejection | 009 | Covered |
| MCP Tools (10 tools) | init, list, get, set, summary, reconcile, next-action, transitions, cancel, checkpoint | 011, 012, 013, 014 | Covered |
| MCP Server Entry | Server setup, tool registration, transport | 015 | Covered |
| Idempotency Design | Phase transition no-op, cancel no-op, field update last-write-wins | 016 | Covered |
| Testing Strategy > Integration | Full lifecycle, fix cycle, compensation, checkpoint advisory | 017 | Covered |
| Configuration > Plugin | plugin.json, mcp-servers.json, .claude-plugin | 018 | Covered |
| Error Handling | Structured error codes, ToolError | 002 | Covered |
| Testing Strategy > Compatibility | Bash↔MCP state file round-trip interop | 017 | Covered |
| Open Questions | npm scope, git dependency, field-update logging, per-compound override | — | Deferred: design defaults accepted for v1.0 |

## Task Breakdown

### Task 001: Scaffold plugin package structure

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `PackageJson_HasRequiredFields_NameVersionMain`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/scaffolding.test.ts`
   - Expected failure: No package.json or project structure exists
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - Files:
     - `plugins/workflow-state/servers/workflow-state-mcp/package.json`
     - `plugins/workflow-state/servers/workflow-state-mcp/tsconfig.json`
     - `plugins/workflow-state/servers/workflow-state-mcp/vitest.config.ts`
     - `plugins/workflow-state/servers/workflow-state-mcp/src/index.ts` (placeholder)
   - Changes: Create package scaffolding following jules-mcp conventions. ESM module, strict TS, vitest with v8 coverage.
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Verify alignment with jules-mcp patterns
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 002: Define Zod schemas and TypeScript types

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `WorkflowStateSchema_ValidFeatureState_Parses`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/schemas.test.ts`
   - Expected failure: No schemas module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `WorkflowStateSchema_InvalidPhase_RejectsWithError`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/schemas.test.ts`
   - Expected failure: No validation
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ToolInputSchemas_AllTenTools_ValidateCorrectly`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/schemas.test.ts`
   - Expected failure: No tool input schemas
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `EventSchema_ValidEvent_ParsesWithSequenceAndVersion`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/schemas.test.ts`
   - Expected failure: No event schema
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `ReservedFieldPath_UnderscorePrefix_Rejected`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/schemas.test.ts`
   - Expected failure: No reserved field validation
   - Run: `npm run test:run` - MUST FAIL

6. [GREEN] Implement minimum code
   - Files:
     - `plugins/workflow-state/servers/workflow-state-mcp/src/schemas.ts`
     - `plugins/workflow-state/servers/workflow-state-mcp/src/types.ts`
   - Changes: Define Zod schemas for all state variants (feature, debug, refactor), tool inputs/outputs, events, checkpoint meta. Derive TypeScript types with `z.infer<>`. Define error code enum.
   - Run: `npm run test:run` - MUST PASS

7. [REFACTOR] Clean up
   - Apply: ISP — small focused schemas composed as needed
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 001
**Parallelizable:** No (depends on 001)

---

### Task 003: Define HSM state and transition definitions

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `FeatureHSM_AllStatesExist_CorrectTypes`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No state machine module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `FeatureHSM_ValidTransitions_MatchDesignDiagram`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No transitions defined
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `DebugHSM_AllStatesAndTransitions_MatchDesign`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No debug HSM
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `RefactorHSM_AllStatesAndTransitions_MatchDesign`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No refactor HSM
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `CompoundStates_HaveEntryExitEffects_AndMaxFixCycles`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No compound state effects
   - Run: `npm run test:run` - MUST FAIL

6. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/state-machine.ts`
   - Changes: Define `State`, `Transition`, `Guard`, `HSMDefinition` interfaces. Create feature, debug, and refactor HSM definitions with all states, transitions, guards, effects, and compound state configuration.
   - Run: `npm run test:run` - MUST PASS

7. [REFACTOR] Clean up
   - Apply: DRY — extract shared guard/effect patterns across workflow types
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 002
**Parallelizable:** No (depends on 002)

---

### Task 004: Implement HSM transition algorithm

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ExecuteTransition_ValidTransition_ReturnsSuccess`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No executeTransition function
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ExecuteTransition_IdempotentSamePhase_ReturnsNoOp`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No idempotency check
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ExecuteTransition_InvalidTarget_ReturnsInvalidTransition`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No invalid transition handling
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `ExecuteTransition_GuardFails_ReturnsGuardFailed`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No guard evaluation
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `ExecuteTransition_CompoundEntry_FiresOnEntryEffects`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No compound state entry handling
   - Run: `npm run test:run` - MUST FAIL

6. [RED] Write test: `ExecuteTransition_CompoundExit_FiresOnExitEffects`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No compound state exit handling
   - Run: `npm run test:run` - MUST FAIL

7. [RED] Write test: `ExecuteTransition_HistoryUpdate_RecordsLastSubState`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No history pseudo-state
   - Run: `npm run test:run` - MUST FAIL

8. [RED] Write test: `ExecuteTransition_CancelFromAnyNonFinal_Succeeds`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-machine.test.ts`
   - Expected failure: No universal cancel transition
   - Run: `npm run test:run` - MUST FAIL

9. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/state-machine.ts`
   - Changes: Implement the 10-step transition algorithm: idempotency check → lookup → guard evaluation → circuit breaker check → exit actions → state update → entry actions → history update → event append → return
   - Run: `npm run test:run` - MUST PASS

10. [REFACTOR] Clean up
    - Apply: SRP — separate transition orchestration from effect execution
    - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 003
**Parallelizable:** No (depends on 003)

---

### Task 005: Implement event log

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `AppendEvent_NewEvent_IncrementsSequence`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/events.test.ts`
   - Expected failure: No events module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `AppendEvent_CapExceeded_DiscardsFIFO`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/events.test.ts`
   - Expected failure: No cap enforcement
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `AppendEvent_AllEventTypes_CorrectSchema`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/events.test.ts`
   - Expected failure: No event type handling
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `AppendEvent_VersionField_PresentOnAllEvents`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/events.test.ts`
   - Expected failure: No version field
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `GetFixCycleCount_FromEventLog_CorrectCount`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/events.test.ts`
   - Expected failure: No fix cycle query
   - Run: `npm run test:run` - MUST FAIL

6. [RED] Write test: `GetRecentEvents_LastN_ReturnsCorrectSlice`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/events.test.ts`
   - Expected failure: No recent events query
   - Run: `npm run test:run` - MUST FAIL

7. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/events.ts`
   - Changes: Implement appendEvent (with sequence increment, cap enforcement), getFixCycleCount, getRecentEvents, getPhaseDuration helper functions
   - Run: `npm run test:run` - MUST PASS

8. [REFACTOR] Clean up
   - Apply: DRY — extract event filtering into reusable query helpers
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 002
**Parallelizable:** Yes (Group B — parallel with 003)

---

### Task 006: Implement circuit breaker

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `CheckCircuitBreaker_UnderLimit_ReturnsClosed`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/circuit-breaker.test.ts`
   - Expected failure: No circuit breaker module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `CheckCircuitBreaker_AtLimit_ReturnsOpen`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/circuit-breaker.test.ts`
   - Expected failure: No limit check
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `CheckCircuitBreaker_DerivedFromEventLog_CorrectCount`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/circuit-breaker.test.ts`
   - Expected failure: No event log integration
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `CheckCircuitBreaker_CompoundReEntry_ResetsCount`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/circuit-breaker.test.ts`
   - Expected failure: No reset on re-entry
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `CheckCircuitBreaker_EnvOverride_UsesMaxFixCycles`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/circuit-breaker.test.ts`
   - Expected failure: No env override
   - Run: `npm run test:run` - MUST FAIL

6. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/circuit-breaker.ts`
   - Changes: Implement checkCircuitBreaker (derives count from event log, checks against maxFixCycles), getCircuitBreakerState, support MAX_FIX_CYCLES env var
   - Run: `npm run test:run` - MUST PASS

7. [REFACTOR] Clean up
   - Apply: SRP — circuit breaker only checks, does not modify state
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 005
**Parallelizable:** No (depends on 005)

---

### Task 007: Implement saga compensation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ExecuteCompensation_AllPhases_RunsReverseOrder`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/compensation.test.ts`
   - Expected failure: No compensation module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ExecuteCompensation_AlreadyCleaned_SkipsWithNoOp`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/compensation.test.ts`
   - Expected failure: No idempotent skip
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ExecuteCompensation_PartialFailure_ContinuesOtherActions`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/compensation.test.ts`
   - Expected failure: No error tolerance
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `ExecuteCompensation_DryRun_ListsActionsNoExecution`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/compensation.test.ts`
   - Expected failure: No dry-run support
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `ExecuteCompensation_LogsEvents_ForEachAction`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/compensation.test.ts`
   - Expected failure: No event logging
   - Run: `npm run test:run` - MUST FAIL

6. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/compensation.ts`
   - Changes: Define compensation registry (per-phase actions: close-pr, delete-integration-branch, cleanup-worktrees, delete-feature-branches). Implement executeCompensation with reverse-order execution, dry-run support, event logging, and idempotent skip for missing resources. Shell out to git/gh commands.
   - Run: `npm run test:run` - MUST PASS

7. [REFACTOR] Clean up
   - Apply: OCP — compensation actions extensible without modifying executor
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 005
**Parallelizable:** Yes (Group C — parallel with 006)

---

### Task 008: Implement checkpoint tracking

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `IncrementOperations_AfterMutatingCall_CountIncreases`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/checkpoint.test.ts`
   - Expected failure: No checkpoint module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `CheckpointAdvisory_AtThreshold_ReturnsTrueInMeta`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/checkpoint.test.ts`
   - Expected failure: No advisory logic
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ResetCounter_OnPhaseTransition_CountResetsToZero`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/checkpoint.test.ts`
   - Expected failure: No reset on transition
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `ResetCounter_OnExplicitCheckpoint_CountResetsToZero`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/checkpoint.test.ts`
   - Expected failure: No explicit checkpoint
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `StalenessDetection_AfterThreshold_ReportsStale`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/checkpoint.test.ts`
   - Expected failure: No staleness detection
   - Run: `npm run test:run` - MUST FAIL

6. [RED] Write test: `BuildCheckpointMeta_AllFields_PopulatedCorrectly`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/checkpoint.test.ts`
   - Expected failure: No meta builder
   - Run: `npm run test:run` - MUST FAIL

7. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/checkpoint.ts`
   - Changes: Implement operation counting, advisory threshold check (default: 20), counter reset on phase transitions and explicit checkpoints, staleness detection (default: 120 min), buildCheckpointMeta for _meta response block. Support CHECKPOINT_OPERATION_THRESHOLD, STALE_AFTER_MINUTES env vars.
   - Run: `npm run test:run` - MUST PASS

8. [REFACTOR] Clean up
   - Apply: SRP — checkpoint only tracks and advises, does not trigger actions
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 002
**Parallelizable:** Yes (Group B — parallel with 003, 005)

---

### Task 009: Implement state store (file I/O + dot-path updates)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `InitStateFile_FeatureWorkflow_CreatesV1_1Schema`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No state store module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ReadStateFile_ValidJSON_ParsesAndValidates`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No read function
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `WriteStateFile_AtomicRename_TempThenRename`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No atomic write
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `ReadStateFile_CorruptJSON_ReturnsStateCorruptError`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No corruption handling
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `ApplyDotPath_NestedPath_UpdatesCorrectField`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No dot-path utility
   - Run: `npm run test:run` - MUST FAIL

6. [RED] Write test: `ApplyDotPath_ArrayAccess_UpdatesArrayElement`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No array access
   - Run: `npm run test:run` - MUST FAIL

7. [RED] Write test: `ApplyDotPath_ReservedField_ReturnsReservedFieldError`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No reserved field check
   - Run: `npm run test:run` - MUST FAIL

8. [RED] Write test: `ListStateFiles_MultipleWorkflows_ReturnsActiveOnly`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/state-store.test.ts`
   - Expected failure: No list function
   - Run: `npm run test:run` - MUST FAIL

9. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/state-store.ts`
   - Changes: Implement initStateFile (per workflow type), readStateFile (with validation), writeStateFile (atomic write-to-temp-then-rename), applyDotPath (with array access and reserved field rejection), listStateFiles, resolveStateDir (auto-detect from git root or WORKFLOW_STATE_DIR env)
   - Run: `npm run test:run` - MUST PASS

10. [REFACTOR] Clean up
    - Apply: DIP — state store depends on schema interfaces, not concrete implementations
    - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 002
**Parallelizable:** Yes (Group B — parallel with 003, 005, 008)

---

### Task 010: Implement state file migration

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `MigrateState_V1_0ToV1_1_AddsInternalFields`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/migration.test.ts`
   - Expected failure: No migration module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `MigrateState_AlreadyCurrent_PassesThrough`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/migration.test.ts`
   - Expected failure: No current version check
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `MigrateState_UnknownVersion_ReturnsMigrationFailed`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/migration.test.ts`
   - Expected failure: No unknown version handling
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `MigrateState_MigrationChain_V1_0ToV1_1ToV1_2`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/migration.test.ts`
   - Expected failure: No sequential chain
   - Run: `npm run test:run` - MUST FAIL

5. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/migration.ts`
   - Changes: Define CURRENT_VERSION, Migration interface, migrations array (v1.0 → v1.1 adding _history, _events, _eventSequence, _checkpoint), migrateState function with sequential chain application
   - Run: `npm run test:run` - MUST PASS

6. [REFACTOR] Clean up
   - Apply: OCP — new migrations appended without modifying existing ones
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 009
**Parallelizable:** No (depends on 009)

---

### Task 011: Implement core tools (init, list, get, set)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ToolInit_NewFeature_CreatesStateFile`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No tools module
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ToolInit_ExistingFeature_ReturnsStateAlreadyExists`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No existence check
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ToolList_ActiveWorkflows_ReturnsWithStaleness`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No list tool
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `ToolGet_DotPathQuery_ReturnsValue`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No get tool
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `ToolGet_InternalField_ReturnsValue`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No internal field read
   - Run: `npm run test:run` - MUST FAIL

6. [RED] Write test: `ToolSet_FieldUpdates_AppliesAndReturns`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No set tool
   - Run: `npm run test:run` - MUST FAIL

7. [RED] Write test: `ToolSet_PhaseTransition_ValidatesViaHSM`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No HSM validation in set
   - Run: `npm run test:run` - MUST FAIL

8. [RED] Write test: `ToolSet_ReservedField_ReturnsReservedFieldError`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No reserved field rejection in set
   - Run: `npm run test:run` - MUST FAIL

9. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/tools.ts`
   - Changes: Implement tool handlers for init, list, get, set. Set handler orchestrates: field updates via dot-path, phase transitions via HSM, checkpoint meta on response. Wire up state-store, state-machine, checkpoint, and events subsystems.
   - Run: `npm run test:run` - MUST PASS

10. [REFACTOR] Clean up
    - Apply: DIP — tools depend on interfaces not concrete subsystems
    - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 004, 006, 008, 009, 010
**Parallelizable:** No (depends on multiple subsystems)

---

### Task 012: Implement query tools (summary, reconcile, next-action, transitions)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ToolSummary_ActiveWorkflow_ReturnsStructuredSummary`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No summary tool
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ToolSummary_IncludesRecentEventsAndCircuitBreaker`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No event/circuit breaker inclusion
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ToolReconcile_MatchingWorktrees_ReturnsAllOk`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No reconcile tool
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `ToolReconcile_MissingWorktree_ReportsMissing`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No missing detection
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `ToolNextAction_AutoContinue_ReturnsCorrectAction`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No next-action tool
   - Run: `npm run test:run` - MUST FAIL

6. [RED] Write test: `ToolNextAction_HumanCheckpoint_ReturnsWait`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No wait detection
   - Run: `npm run test:run` - MUST FAIL

7. [RED] Write test: `ToolNextAction_CircuitOpen_ReturnsBlocked`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No circuit breaker check
   - Run: `npm run test:run` - MUST FAIL

8. [RED] Write test: `ToolTransitions_FeatureWorkflow_ReturnsFullGraph`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No transitions tool
   - Run: `npm run test:run` - MUST FAIL

9. [RED] Write test: `ToolTransitions_FromSpecificPhase_ReturnsFilteredTransitions`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No phase filtering
   - Run: `npm run test:run` - MUST FAIL

10. [GREEN] Implement minimum code
    - File: `plugins/workflow-state/servers/workflow-state-mcp/src/tools.ts`
    - Changes: Add summary (structured data with recent events, circuit breaker, checkpoint), reconcile (shell out to git for worktree/branch checks), next-action (evaluate guards on outbound transitions), transitions (pure HSM introspection)
    - Run: `npm run test:run` - MUST PASS

11. [REFACTOR] Clean up
    - Apply: SRP — each tool handler is a focused function
    - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 011
**Parallelizable:** No (depends on 011)

---

### Task 013: Implement cancel tool with compensation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ToolCancel_ActiveWorkflow_ExecutesCompensationAndTransitions`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No cancel tool
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ToolCancel_AlreadyCancelled_ReturnsAlreadyCancelled`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No already-cancelled check
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ToolCancel_DryRun_ListsActionsNoExecution`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No dry-run
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `ToolCancel_WithReason_IncludedInEvent`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No reason field
   - Run: `npm run test:run` - MUST FAIL

5. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/tools.ts`
   - Changes: Add cancel tool handler: check already-cancelled, dry-run support, execute compensation, transition to cancelled state, log events
   - Run: `npm run test:run` - MUST PASS

6. [REFACTOR] Clean up
   - Apply: Consistent error response structure
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 011, 007
**Parallelizable:** No (depends on tools + compensation)

---

### Task 014: Implement checkpoint tool

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ToolCheckpoint_ExplicitTrigger_ResetsCounterAndLogsEvent`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No checkpoint tool
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ToolCheckpoint_WithSummary_IncludesInCheckpointState`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No summary field
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `ToolCheckpoint_Multiple_EachResetsCounter`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/tools.test.ts`
   - Expected failure: No multiple checkpoint support
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/tools.ts`
   - Changes: Add checkpoint tool handler: reset operation counter, update _checkpoint state, log checkpoint event, return meta with operationsSinceCheckpoint: 0
   - Run: `npm run test:run` - MUST PASS

5. [REFACTOR] Clean up
   - Apply: Consistent with other tool response patterns
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 011
**Parallelizable:** Yes (Group D — parallel with 012, 013)

---

### Task 015: Create MCP server entry point

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `McpServer_Registers10Tools_WithCorrectSchemas`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/index.test.ts`
   - Expected failure: No server setup
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `McpServer_ToolCall_RoutesToCorrectHandler`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/index.test.ts`
   - Expected failure: No tool routing
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/index.ts`
   - Changes: Create McpServer instance, register all 10 tools with descriptions and Zod schemas, connect StdioServerTransport. Auto-detect WORKFLOW_STATE_DIR from git root or env.
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Consistent with jules-mcp index.ts pattern
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 012, 013, 014
**Parallelizable:** No (depends on all tools)

---

### Task 016: Implement idempotency integration tests

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `Idempotency_PhaseTransitionTwice_NoDuplicateEvent`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/idempotency.test.ts`
   - Expected failure: Need to verify no duplicate
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `Idempotency_SameFieldUpdateTwice_IdenticalState`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/idempotency.test.ts`
   - Expected failure: Need to verify identical state
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `Idempotency_CancelTwice_AlreadyCancelledTrue`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/idempotency.test.ts`
   - Expected failure: Need to verify already-cancelled
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `Idempotency_MultipleCheckpoints_CounterResetsEachTime`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/idempotency.test.ts`
   - Expected failure: Need to verify counter reset
   - Run: `npm run test:run` - MUST FAIL

5. [GREEN] Run all tests — implementations already exist from tasks 011-014
   - Run: `npm run test:run` - MUST PASS

6. [REFACTOR] Clean up
   - Apply: Group related idempotency tests clearly
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 015
**Parallelizable:** No (depends on full system)

---

### Task 017: Implement integration tests (full lifecycle)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `FeatureLifecycle_FullSaga_CompletesWithCorrectEvents`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need full lifecycle verification
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `FixCycle_DelegateIntegrateFail_CircuitBreakerTrips`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need fix cycle + circuit breaker verification
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `Compensation_WorkflowWithSideEffects_CleansUpOnCancel`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need end-to-end compensation verification
   - Run: `npm run test:run` - MUST FAIL

4. [RED] Write test: `CheckpointAdvisory_ThresholdOperations_TriggersAdvisory`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need advisory verification through tool calls
   - Run: `npm run test:run` - MUST FAIL

5. [RED] Write test: `Migration_V1_0StateFile_MigratesOnRead`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need end-to-end migration verification
   - Run: `npm run test:run` - MUST FAIL

6. [RED] Write test: `EventLog_FullWorkflow_SequenceMonotonicallyIncreasing`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need event sequence verification
   - Run: `npm run test:run` - MUST FAIL

7. [RED] Write test: `Compatibility_BashCreatedState_MigratesAndReads`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need bash-format state file round-trip verification
   - Run: `npm run test:run` - MUST FAIL

8. [RED] Write test: `Compatibility_McpCreatedState_CoreFieldsReadableByBash`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/integration.test.ts`
   - Expected failure: Need MCP→bash compatibility verification
   - Run: `npm run test:run` - MUST FAIL

9. [GREEN] Run all tests — implementations already exist
   - Run: `npm run test:run` - MUST PASS

8. [REFACTOR] Clean up
   - Apply: Clear separation of integration scenarios
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 015
**Parallelizable:** Yes (Group E — parallel with 016)

---

### Task 018: Create plugin registration files

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `PluginJson_HasRequiredFields_McpServersReference`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/scaffolding.test.ts`
   - Expected failure: No plugin.json
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `McpServersJson_ValidConfiguration_CorrectPaths`
   - File: `plugins/workflow-state/servers/workflow-state-mcp/src/__tests__/scaffolding.test.ts`
   - Expected failure: No mcp-servers.json
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - Files:
     - `plugins/workflow-state/.claude-plugin/plugin.json`
     - `plugins/workflow-state/mcp-servers.json`
   - Changes: Create plugin manifest referencing workflow-state MCP server with WORKFLOW_STATE_DIR env. Follow jules plugin pattern.
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Consistent with jules plugin structure
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 015
**Parallelizable:** Yes (Group E — parallel with 016, 017)

---

## Parallelization Strategy

### Sequential Chains

**Chain A: Foundation**
```
Task 001 (scaffold) → Task 002 (schemas)
```

**Chain B: Core Subsystems (parallel after 002)**
```
Task 002 → Task 003 (HSM defs) → Task 004 (transition algo)
Task 002 → Task 005 (events) → Task 006 (circuit breaker)
Task 002 → Task 005 (events) → Task 007 (compensation)
Task 002 → Task 008 (checkpoint)
Task 002 → Task 009 (state store) → Task 010 (migration)
```

**Chain C: Tool Implementation**
```
Tasks 004, 006, 008, 009, 010 → Task 011 (core tools)
Task 011 → Task 012 (query tools)
Task 011 + 007 → Task 013 (cancel tool)
Task 011 → Task 014 (checkpoint tool)
```

**Chain D: Server + Testing**
```
Tasks 012, 013, 014 → Task 015 (server entry)
Task 015 → Task 016 (idempotency tests)
Task 015 → Task 017 (integration tests)
Task 015 → Task 018 (plugin registration)
```

### Parallel Groups

| Group | Tasks | Can Run With |
|-------|-------|--------------|
| A | 001 | Standalone (first) |
| B | 003, 005, 008, 009 | Each other (after 002) |
| C | 006, 007 | Each other (after 005) |
| D | 012, 013, 014 | Each other (after 011) |
| E | 016, 017, 018 | Each other (after 015) |

### Worktree Assignments

```
.worktrees/001-scaffold        → Task 001
.worktrees/002-schemas         → Task 002
.worktrees/003-004-hsm         → Tasks 003, 004 (state machine def + algo)
.worktrees/005-006-events-cb   → Tasks 005, 006 (events + circuit breaker)
.worktrees/007-compensation    → Task 007
.worktrees/008-checkpoint      → Task 008
.worktrees/009-010-store       → Tasks 009, 010 (state store + migration)
.worktrees/011-core-tools      → Task 011
.worktrees/012-query-tools     → Task 012
.worktrees/013-cancel          → Task 013
.worktrees/014-checkpoint-tool → Task 014
.worktrees/015-server          → Task 015
.worktrees/016-018-finalize    → Tasks 016, 017, 018
```

## Deferred Items

| Item | Rationale |
|------|-----------|
| npm scope decision | Design defaults to `@lvlup-sw/workflow-state-mcp` — acceptable for v1.0 |
| git dependency (isomorphic-git vs shell) | Design recommends shelling out to git — simpler, more reliable |
| Event log field-update tracking | Default off, configurable via env — no task needed |
| Per-compound circuit breaker override | Single MAX_FIX_CYCLES override sufficient for v1.0 |

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Design coverage verified (14/14 sections)
- [ ] Plugin registration tested
- [ ] Ready for review
