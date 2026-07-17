# Implementation Plan: Event Store Cleanup (#368 Remainder)

**Date:** 2026-02-16
**Type:** Refactor (overhaul track)
**Issue:** #368 (remainder after PR #369 removed team coordinator)
**State:** `~/.claude/workflow-state/refactor-event-cleanup-368.state.json`

## Summary

Remove 6 dead event types from the schema and wire up 2 HSM diagnostic events (guard-failed, circuit-open) that have full infrastructure but no emission path. After PR #369 removed 3 team-related types, 13 of the original 16 unused types remain. This plan addresses 6 clear removes + 2 wire-ups, leaving 5 quality-gate/stack types for future design decisions.

**Preserved:** All quality gate events (`gate.executed`), stack events (`stack.restacked`, `stack.enqueued`), and `tool.invoked` (already wired). Compound-entry and compound-exit are already emitted by `executeTransition()`.

## Spec Traceability

| Brief Goal | Tasks |
|---|---|
| Remove 6 dead event types from schema | T1 |
| Remove phase.transitioned view branches and sync reference | T1 |
| Wire up guard-failed and circuit-open emission | T2 |
| Add compound-exit to explicit type mapping | T2 |
| Update skill docs that reference phase.transitioned | T3 |

## Task Dependency Graph

```
T1 (remove dead types) ──┐
                          ├──> T3 (update skill docs)
T2 (wire up diagnostics) ─┘
```

T1 and T2 are independent and parallelizable.
T3 depends on T1 and T2 (must know final state).

## Parallel Groups

| Group | Tasks | Can Run Simultaneously |
|---|---|---|
| **Group A** | T1, T2 | Yes — different files, no overlap |
| **Group B** | T3 | After Group A (docs describe final state) |

---

## Task 1: Remove 6 dead event types and all references

**Phase:** RED → GREEN → REFACTOR

### Types to remove
- `phase.transitioned` (superseded by `workflow.transition`)
- `task.routed` (speculative, no consumers)
- `context.assembled` (speculative, no consumers)
- `test.result` (orphaned, no consumers)
- `gate.self-corrected` (no references anywhere)
- `remediation.started` (no references anywhere)

### RED

Write test: `schema_rejects_removed_event_types`
- File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts`
- Test that `EventTypes` does NOT contain any of the 6 removed types
- Test that `EventTypes` has exactly 22 entries (28 current − 6 removed)
- Expected failure: all 6 currently exist in the array

Write test: `views_do_not_handle_phase_transitioned`
- File: `plugins/exarchos/servers/exarchos-mcp/src/views/pipeline-view.test.ts` (new, co-located)
- Test that `pipelineProjection.apply()` returns state unchanged for event `{ type: 'workflow.transition', data: { to: 'delegate' } }` (existing behavior) and does NOT have a special path for `phase.transitioned`
- Similarly for `workflowStatusProjection`
- Expected failure: tests pass (they test positive behavior), but use this to establish baseline

Write test: `conflict_resolver_uses_workflow_transition`
- File: `plugins/exarchos/servers/exarchos-mcp/src/sync/conflict.test.ts` (new or existing)
- Test that `ConflictResolver.resolve()` detects phase divergence using `workflow.transition` events (not `phase.transitioned`)
- Expected failure: current code only checks `phase.transitioned`

### GREEN

1. **`src/event-store/schemas.ts`**:
   - Remove from `EventTypes` array: `'phase.transitioned'`, `'test.result'`, `'gate.self-corrected'`, `'context.assembled'`, `'task.routed'`, `'remediation.started'`
   - Remove Zod schemas: `PhaseTransitionedData`, `TestResultData`, `GateSelfCorrectedData`, `ContextAssembledData`, `TaskRoutedData`, `RemediationStartedData`
   - Remove TypeScript types: `PhaseTransitioned`, `TestResult`, `GateSelfCorrected`, `ContextAssembled`, `TaskRouted`, `RemediationStarted`

2. **`src/views/pipeline-view.ts`**:
   - Remove `case 'phase.transitioned'` block (lines 68-74)

3. **`src/views/workflow-status-view.ts`**:
   - Remove `case 'phase.transitioned'` block (lines 60-66)

4. **`src/sync/conflict.ts`**:
   - Replace `phase.transitioned` check (lines 52-73) with `workflow.transition` check
   - Extract `to` from `data.to` field (same structure)

5. **`src/__tests__/event-store/schemas.test.ts`**:
   - Remove imports: `PhaseTransitionedData`, `TestResultData`, `GateSelfCorrectedData`, `ContextAssembledData`, `TaskRoutedData`, `RemediationStartedData`
   - Remove test blocks: `PhaseTransitionedData`, `TestResultData`, `GateSelfCorrectedData`, `ContextAssembledData`, `TaskRoutedData`, `RemediationStartedData`
   - Update `EventTypes` count test: 28 → 22
   - Remove `phase.transitioned` from `should include workflow-level types` assertion
   - Remove `test.result` from `should include task-level types` assertion
   - Remove `gate.self-corrected` from `should include quality gate types` assertion
   - Remove entire `should include context types` test (all 3 types removed)

6. **`src/__tests__/views/tools.test.ts`**:
   - Replace `phase.transitioned` event in test fixture (line 38) with `workflow.transition` event: `{ type: 'workflow.transition', data: { from: 'started', to: 'delegating', trigger: 'auto', featureId: 'test' } }`

7. **`src/event-store/store.test.ts`**:
   - Replace `context.assembled` and `task.routed` in timestamp range query test with surviving event types (e.g., `task.assigned` and `task.completed`)

### REFACTOR

- Clean up section comment headers in schemas.ts (e.g., remove `// ─── Context Event Data` section if empty)
- Verify no orphaned imports remain

**Dependencies:** None
**Parallelizable:** Yes (Group A — no file overlap with T2)

---

## Task 2: Wire up guard-failed and circuit-open diagnostic event emission

**Phase:** RED → GREEN → REFACTOR

### Problem
`executeTransition()` returns `events: []` on guard failure (line 251, 265) and circuit-open (line 286). The `handleSet()` function returns early on `!result.success` (line 282-291) before reaching the event emission loop. The type mapping in `events.ts` already maps `'guard-failed'` → `'workflow.guard-failed'`, and the external schema already defines `WorkflowGuardFailedData` and `WorkflowCircuitOpenData`.

### RED

Write test: `executeTransition_returns_guard_failed_event`
- File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/state-machine.test.ts` (existing)
- Set up a feature HSM transition from `delegate` → `review` with a guard that always fails
- Assert that `result.events` contains exactly one event with `type: 'guard-failed'`, `from: 'delegate'`, `to: 'review'`
- Assert `result.success === false` and `result.errorCode === 'GUARD_FAILED'`
- Expected failure: current code returns `events: []` on guard failure

Write test: `executeTransition_returns_circuit_open_event`
- File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/state-machine.test.ts`
- Set up state with fix-cycle events equal to `maxFixCycles` for the parent compound
- Attempt a fix-cycle transition
- Assert `result.events` contains one event with `type: 'circuit-open'`, metadata with `compoundStateId`, `fixCycleCount`, `maxFixCycles`
- Expected failure: current code returns `events: []` on circuit open

Write test: `handleSet_emits_guard_failed_to_event_store`
- File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts` (existing)
- Call `handleSet` with a phase that would trigger a guard failure
- Assert that the event store received a `workflow.guard-failed` event
- Assert that `handleSet` still returns `success: false` with `GUARD_FAILED` error
- Expected failure: current code returns early before emitting

Write test: `handleSet_emits_circuit_open_to_event_store`
- File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts`
- Set up state at circuit breaker limit, attempt fix-cycle transition
- Assert event store received `workflow.circuit-open` event
- Assert `handleSet` still returns `success: false` with `CIRCUIT_OPEN` error
- Expected failure: current code returns early before emitting

### GREEN

1. **`src/workflow/state-machine.ts`** — Modify guard failure paths (lines 246-255 and 260-272):
   - Instead of `events: []`, include a `guard-failed` event:
     ```typescript
     events: [{
       type: 'guard-failed',
       from: currentPhase,
       to: targetPhase,
       trigger: 'execute-transition',
       metadata: { guard: transition.guard.id },
     }],
     ```
   - Both guard failure paths (thrown exception and failed evaluation) get this event

2. **`src/workflow/state-machine.ts`** — Modify circuit breaker path (lines 281-289):
   - Instead of `events: []`, include a `circuit-open` event:
     ```typescript
     events: [{
       type: 'circuit-open',
       from: currentPhase,
       to: targetPhase,
       trigger: 'execute-transition',
       metadata: {
         compoundStateId: parent.id,
         fixCycleCount: fixCount,
         maxFixCycles: parent.maxFixCycles,
       },
     }],
     ```

3. **`src/workflow/tools.ts`** — Modify `handleSet()` (lines 282-292):
   - Before the early return on `!result.success`, emit any diagnostic events from `result.events`:
     ```typescript
     if (!result.success) {
       // Emit diagnostic events (guard-failed, circuit-open) before returning error
       if (moduleEventStore && result.events.length > 0) {
         try {
           for (const evt of result.events) {
             await moduleEventStore.append(input.featureId, {
               type: mapInternalToExternalType(evt.type) as EventType,
               data: {
                 from: evt.from,
                 to: evt.to,
                 trigger: evt.trigger,
                 featureId: input.featureId,
                 ...(evt.metadata ?? {}),
               },
             });
           }
         } catch {
           // Best-effort — diagnostic events are supplementary
         }
       }

       const errorCode = result.errorCode ?? ErrorCode.INVALID_TRANSITION;
       return { ... }; // existing error response
     }
     ```
   - Note: Diagnostic events are emitted BEFORE state write (no state change on failure), so no CAS concerns

4. **`src/workflow/events.ts`** — Add explicit mappings (line 144):
   - Add `'compound-exit': 'workflow.compound-exit'` to typeMap
   - Add `'circuit-open': 'workflow.circuit-open'` to typeMap
   - These currently work via the `workflow.${internalType}` fallback but should be explicit

### REFACTOR

- Extract shared event emission logic in `handleSet()` into a helper function to avoid duplication between the failure path and the success path
- Add JSDoc comment to `executeTransition()` documenting that it returns diagnostic events even on failure

**Dependencies:** None
**Parallelizable:** Yes (Group A — no file overlap with T1)

---

## Task 3: Update skill documentation

**Phase:** RED → GREEN → REFACTOR

### RED

Write test: `no_phase_transitioned_references_in_skills`
- Grep-based verification (no automated test needed)
- Search for `phase.transitioned` in `skills/` directory
- Expected: references exist in 5+ files

### GREEN

1. **`skills/debug/references/troubleshooting.md`** (lines 33-37):
   - Replace `phase.transitioned` with `workflow.transition` in Exarchos Integration steps
   - Note: Phase transitions are auto-emitted by `exarchos_workflow set` — these manual emission instructions are redundant. Add note: "Phase transitions are auto-emitted by `exarchos_workflow` `set` when `phase` is provided. Manual `exarchos_event` `append` is not needed."

2. **`skills/delegation/SKILL.md`** (line 166):
   - Replace `phase.transitioned` → `workflow.transition`
   - Add same auto-emission note

3. **`skills/implementation-planning/SKILL.md`**:
   - Replace any `phase.transitioned` references with `workflow.transition`
   - Add auto-emission note

4. **`skills/synthesis/references/troubleshooting.md`**:
   - Replace `phase.transitioned` references
   - Add auto-emission note

5. **`skills/refactor/SKILL.md`**:
   - Replace `phase.transitioned` → `workflow.transition` in Exarchos Integration section
   - Add auto-emission note

### REFACTOR

- Verify no remaining `phase.transitioned` references anywhere in the repo
- Verify consistency of auto-emission notes across all updated skills

**Dependencies:** T1 (schema must be clean), T2 (emission behavior must be finalized)
**Parallelizable:** No (sequential after Group A)

---

## Verification

After all tasks complete:

```bash
cd plugins/exarchos/servers/exarchos-mcp
npm run build          # TypeScript compiles
npm run test:run       # All tests pass
npm run test:coverage  # Coverage meets thresholds
```

Root level:
```bash
npm run build          # Root installer builds
npm run test:run       # Root tests pass
```

Grep verification:
```bash
# No dead type references remain
grep -r 'phase\.transitioned\|task\.routed\|context\.assembled\|test\.result\|gate\.self-corrected\|remediation\.started' plugins/exarchos/servers/exarchos-mcp/src/ --include='*.ts' | grep -v '\.test\.' | grep -v node_modules
# Should return empty

# No phase.transitioned in skills
grep -r 'phase\.transitioned' skills/
# Should return empty
```

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Removing `phase.transitioned` breaks old event streams | Views already handle `workflow.transition` as primary path; `phase.transitioned` was fallback only. Old JSONL files with `phase.transitioned` events will have those events ignored (no view handler), which is acceptable |
| Guard-failed events spam store on repeated guard failures | Best-effort emission + same guard failures return immediately (no retry loop). Each failure = one event, which is the desired behavior for observability |
| `conflict.ts` update breaks sync | Sync module is stub-only (outbox drain with no real sender). Change is low-risk and makes conflict detection use the same event type as production |
| `store.test.ts` fixture change breaks test semantics | Replace with equivalent surviving types that test the same timestamp-range query logic |
