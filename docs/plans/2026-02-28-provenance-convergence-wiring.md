# Implementation Plan: Provenance & Convergence Wiring

**Feature:** refactor-provenance-convergence-wiring
**Date:** 2026-02-28
**Source:** Refactor brief (no design doc — brief in workflow state)

## Overview

Three workstreams closing audit gaps from `docs/bugs/audit.md`:
1. **Provenance wiring** — Connect subagent task results to ProvenanceView through event payloads
2. **Per-phase convergence** — Add phase metadata to gate events for graduated depth filtering
3. **Telemetry-gate integration** — Feed runtime token data into D3 convergence dimension

## Approach: Phase in Details (Not Signature)

Gate handlers already pass a `details` object to `emitGateEvent()`. Adding `phase` as a field in `details` avoids changing the `emitGateEvent` function signature and minimizes blast radius. The convergence view already reads `details.dimension` — it will additionally read `details.phase`.

Phase values per handler (derived from ADR §3.3):

| Handler | Phase Value | Rationale |
|---------|-------------|-----------|
| `design-completeness` | `ideate` | ideate → plan boundary |
| `plan-coverage` | `plan` | plan → plan-review boundary |
| `provenance-chain` | `plan` | plan → plan-review boundary |
| `prepare-delegation` (plan-coverage) | `delegate` | delegation prep |
| `tdd-compliance` | `delegate` | per-task D1 |
| `static-analysis` | `delegate` | per-task D2 |
| `security-scan` | `review` | review boundary |
| `context-economy` | `review` | review D3 |
| `operational-resilience` | `review` | review D4 |
| `workflow-determinism` | `review` | review D5 |
| `review-verdict` | `review` | review → synthesize boundary |
| `prepare-synthesis` (test-suite, typecheck) | `synthesize` | synthesize boundary |
| `post-merge` | `synthesize` | synthesize → cleanup boundary |
| `check-convergence` | `meta` | meta-gate (aggregation) |

---

## Tasks

### Task T-01: Convergence view stores phase from gate events
**Implements:** Brief goal 3
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleGateExecuted_WithPhaseInDetails_StoresPhaseOnGateResult`
   - File: `servers/exarchos-mcp/src/views/convergence-view.test.ts`
   - Assert: gate result record includes `phase` field extracted from `event.data.details.phase`
   - Expected failure: `phase` property does not exist on gate result type

2. **[RED]** Write test: `handleGateExecuted_WithoutPhase_StoresUndefinedPhase`
   - File: `servers/exarchos-mcp/src/views/convergence-view.test.ts`
   - Assert: backward-compatible — events without phase field still work, phase is undefined
   - Expected failure: `phase` property does not exist on gate result type

3. **[GREEN]** Add `phase?: string` to gate result type in `ConvergenceViewState`, extract in `handleGateExecuted`
   - File: `servers/exarchos-mcp/src/views/convergence-view.ts`
   - Lines ~27, ~76-88

4. **[REFACTOR]** None expected

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-02: handleTaskComplete forwards provenance fields
**Implements:** Brief goal 1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleTaskComplete_WithProvenanceInResult_IncludesFieldsInEvent`
   - File: `servers/exarchos-mcp/src/tasks/tools.test.ts`
   - Assert: `task.completed` event data contains `implements`, `tests`, `files` from `args.result`
   - Expected failure: event data missing provenance fields

2. **[RED]** Write test: `handleTaskComplete_WithoutProvenance_OmitsFields`
   - File: `servers/exarchos-mcp/src/tasks/tools.test.ts`
   - Assert: backward-compatible — result without provenance fields doesn't add undefined keys
   - Expected failure: test should pass immediately (green) since current code already omits

3. **[GREEN]** Extract `implements`, `tests`, `files` from `args.result` into event data
   - File: `servers/exarchos-mcp/src/tasks/tools.ts`
   - Lines ~195-210: add after existing result field extraction

4. **[REFACTOR]** None expected

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-03: Add phase to D1 gate handler details
**Implements:** Brief goal 2
**Phase:** RED → GREEN → REFACTOR

Handlers: `design-completeness`, `plan-coverage`, `tdd-compliance`, `provenance-chain`

1. **[RED]** Write tests (one per handler): `handler_EmitsGateEvent_IncludesPhaseInDetails`
   - Files: `design-completeness.test.ts`, `plan-coverage.test.ts`, `tdd-compliance.test.ts`, `provenance-chain.test.ts`
   - Assert: `emitGateEvent` called with details containing `phase` field matching expected value
   - Expected failure: details object lacks `phase` field

2. **[GREEN]** Add `phase: '<value>'` to each handler's `emitGateEvent` details object
   - `design-completeness.ts:131` → `phase: 'ideate'`
   - `plan-coverage.ts:118` → `phase: 'plan'`
   - `tdd-compliance.ts:115` → `phase: 'delegate'`
   - `provenance-chain.ts:117` → `phase: 'plan'`

3. **[REFACTOR]** None expected

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-04: Add phase to D2-D5, review, synthesis, and meta gate handler details
**Implements:** Brief goal 2
**Phase:** RED → GREEN → REFACTOR

Handlers: `static-analysis`, `security-scan`, `context-economy`, `operational-resilience`, `workflow-determinism`, `review-verdict`, `post-merge`, `prepare-synthesis`, `prepare-delegation`, `check-convergence`

1. **[RED]** Write tests: `handler_EmitsGateEvent_IncludesPhaseInDetails` for each handler
   - Files: respective `.test.ts` files
   - Assert: `emitGateEvent` called with details containing `phase` field
   - Expected failure: details object lacks `phase` field

2. **[GREEN]** Add `phase: '<value>'` to each handler's `emitGateEvent` details object
   - `static-analysis.ts:121` → `phase: 'delegate'`
   - `security-scan.ts:99` → `phase: 'review'`
   - `context-economy.ts:100` → `phase: 'review'`
   - `operational-resilience.ts:100` → `phase: 'review'`
   - `workflow-determinism.ts:100` → `phase: 'review'`
   - `review-verdict.ts:102,113` → `phase: 'review'`
   - `post-merge.ts:118` → `phase: 'synthesize'`
   - `prepare-synthesis.ts:226,236` → `phase: 'synthesize'`
   - `prepare-delegation.ts:178` → `phase: 'delegate'`
   - `check-convergence.ts:65` → `phase: 'meta'`

3. **[REFACTOR]** None expected

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-05: Add phase filter to check_convergence handler
**Implements:** Brief goal 4
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleCheckConvergence_WithPhaseFilter_ReturnsOnlyMatchingGateResults`
   - File: `servers/exarchos-mcp/src/orchestrate/check-convergence.test.ts`
   - Setup: convergence view with gate results from multiple phases
   - Assert: when `phase: 'review'` passed, only review-phase gate results considered for convergence
   - Expected failure: phase parameter not accepted or ignored

2. **[RED]** Write test: `handleCheckConvergence_WithoutPhaseFilter_ReturnsAllResults`
   - File: `servers/exarchos-mcp/src/orchestrate/check-convergence.test.ts`
   - Assert: backward-compatible — no phase parameter returns all results (existing behavior)

3. **[GREEN]** Add `phase?: string` to `CheckConvergenceArgs`, filter gate results in materialized view before computing convergence
   - File: `servers/exarchos-mcp/src/orchestrate/check-convergence.ts`
   - Lines ~20-23 (args type), ~44-51 (filtering logic)

4. **[REFACTOR]** Extract phase filtering into a helper function if logic is complex

**Dependencies:** T-01 (convergence view must store phase first)
**Parallelizable:** No (sequential after T-01)

---

### Task T-06: check_context_economy queries telemetry projection
**Implements:** Brief goal 5
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleContextEconomy_WithTelemetryData_IncludesRuntimeMetricsInResult`
   - File: `servers/exarchos-mcp/src/orchestrate/context-economy.test.ts`
   - Setup: telemetry event store with tool.completed events showing high token usage
   - Assert: gate result includes `runtimeMetrics` field with session token totals and p95 data
   - Expected failure: result has no `runtimeMetrics` field

2. **[RED]** Write test: `handleContextEconomy_WithoutTelemetryData_ReturnsScriptOnlyResult`
   - File: `servers/exarchos-mcp/src/orchestrate/context-economy.test.ts`
   - Assert: backward-compatible — empty telemetry stream still returns script-based result
   - Expected failure: should pass immediately if implementation handles empty gracefully

3. **[GREEN]** Import telemetry projection, materialize from telemetry stream, include `runtimeMetrics` in result
   - File: `servers/exarchos-mcp/src/orchestrate/context-economy.ts`
   - Add: read telemetry events, compute session totals, append to gate event details

4. **[REFACTOR]** Extract telemetry materialization to a shared helper if reused

**Dependencies:** T-04 (context-economy handler has phase in details first)
**Parallelizable:** No (sequential after T-04)

---

### Task T-07: Telemetry middleware emits gate.executed for D3 on threshold breach
**Implements:** Brief goal 6
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `withTelemetry_TokenThresholdExceeded_EmitsGateExecutedForD3`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Setup: tool response exceeding token threshold (e.g., >4KB response)
   - Assert: `gate.executed` event emitted with `gateName: 'token-budget'`, `dimension: 'D3'`, `passed: false`
   - Expected failure: no gate.executed event emitted

2. **[RED]** Write test: `withTelemetry_TokenBelowThreshold_NoGateEvent`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Setup: tool response within budget
   - Assert: no `gate.executed` event emitted (only tool.completed)

3. **[GREEN]** After computing `tokenEstimate`, check against threshold. If exceeded, emit `gate.executed` to workflow stream (not telemetry stream)
   - File: `servers/exarchos-mcp/src/telemetry/middleware.ts`
   - Lines ~122-133: add threshold check after token estimate calculation
   - Threshold: configurable constant (e.g., `TOKEN_GATE_THRESHOLD = 2048`)
   - Stream: requires `featureId` from args to emit to correct workflow stream (fire-and-forget, skip if no featureId)

4. **[REFACTOR]** Extract threshold constant to `constants.ts`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-08: Structured provenance example in implementer prompt
**Implements:** Brief goal 7
**Phase:** Direct edit (skill prose — no TDD)

1. Add structured JSON example to `skills/delegation/references/implementer-prompt.md`
   - Show exact shape: `{ implements: ["DR-1"], tests: [{ name: "...", file: "..." }], files: ["..."] }`
   - Explain that these fields are passed as `result` parameter in task completion
   - Add example `exarchos_orchestrate({ action: "task_complete", taskId, streamId, result: { implements, tests, files } })` call

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-09: Delegation skill provenance wiring and per-task gate instructions
**Implements:** Brief goal 8
**Phase:** Direct edit (skill prose — no TDD)

1. Update `skills/delegation/SKILL.md` task completion flow:
   - After subagent reports completion, orchestrator extracts provenance fields from report
   - Orchestrator passes provenance fields in `result` parameter of `exarchos_orchestrate({ action: "task_complete" })`
   - Document the explicit provenance extraction step between subagent report and task_complete call
   - Strengthen per-task gate invocation: "MUST invoke check_tdd_compliance before marking complete"

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-10: Implementation-planning provenance check — advisory to blocking
**Implements:** Brief goal 9
**Phase:** Direct edit (skill prose — no TDD)

1. Update `skills/implementation-planning/SKILL.md` lines 142-155:
   - Change from "Advisory: gaps or orphan references found" to blocking behavior
   - On `passed: false`: "Block: add `**Implements:** DR-N` to tasks for each uncovered requirement before proceeding"
   - Keep `error` (exit 2, no DR-N identifiers) as skip — designs without DR-N identifiers are exempt

**Dependencies:** None
**Parallelizable:** Yes

---

## Dependency Graph

```
T-01 (convergence view phase) ──→ T-05 (check_convergence filter)
T-02 (provenance extraction) ──── independent
T-03 (D1 handlers phase) ──────── independent
T-04 (D2-D5+ handlers phase) ──→ T-06 (context-economy telemetry)
T-07 (middleware gate emission) ── independent
T-08 (implementer prompt) ──────── independent
T-09 (delegation skill) ────────── independent
T-10 (planning skill blocking) ── independent
```

## Parallel Groups

| Group | Tasks | Constraint |
|-------|-------|------------|
| A (foundation) | T-01, T-02, T-03, T-04, T-07 | All independent, run in parallel |
| B (sequential) | T-05 (after T-01), T-06 (after T-04) | Wait for foundation |
| C (skill updates) | T-08, T-09, T-10 | Independent, parallel with all code tasks |

## Success Criteria

- [ ] `npm run test:run` passes (all existing + new tests green)
- [ ] `npm run typecheck` passes
- [ ] Convergence view stores and filters by phase
- [ ] All gate handlers include phase in details
- [ ] handleTaskComplete forwards provenance fields
- [ ] check_context_economy includes runtime telemetry data
- [ ] Telemetry middleware emits D3 gate events on threshold breach
- [ ] Skill documentation updated (delegation, implementation-planning, implementer prompt)
