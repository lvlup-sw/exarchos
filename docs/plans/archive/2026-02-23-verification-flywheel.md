# Implementation Plan: Verification Flywheel + LLM Grader Activation

## Source Design
Link: `docs/designs/2026-02-15-autonomous-code-verification.md`

## Context

The autonomous code verification design has 4 phases with 25 items. After thorough audit, **Phases 1-3 are ~95% complete** — all infrastructure is built (graders, views, event schemas, validation scripts, benchmark gates, PBT patterns). What remains is:

1. **LLM graders activated for only 1 of 7 suites** — delegation suite has llm-rubric; 4 new suites (brainstorming, debug, refactor, planning) have only deterministic graders
2. **No gate events flow from real workflows** — `gate.executed` events are defined/consumed by views but nothing emits them during workflow execution
3. **regression-detector.ts exists but is not wired in** — `detectRegressions()` and `emitRegressionEvents()` are implemented and tested but never called
4. **No cross-correlation between eval quality and code quality** — EvalResultsView and CodeQualityView are independent
5. **No quality-aware eval cases** — eval cases only test workflow completion, not code quality outcomes

This plan closes these gaps to complete Phase 4 (Flywheel Integration).

## Scope
**Target:** Phase 4 Flywheel Integration + Phase 3 gap closure (regression emission wiring)
**Excluded:**
- Property-based testing infrastructure (Phase 1 — already complete)
- Benchmark infrastructure (Phase 2 — already complete)
- CodeQualityView CQRS projection (Phase 3 — already complete)
- Auto-remediation guidance for benchmark failures (Phase 4 item 25 — deferred, needs real quality data flowing first)

## Summary
- Total tasks: 20
- Parallel groups: 4
- Estimated test count: 12
- Design coverage: 5 of 5 remaining gaps covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| Layer 1: PBT Infrastructure | testingStrategy, fast-check, spawn prompts, validation scripts | — | Already complete |
| Layer 1: Benchmark Infrastructure | baselines.json, check-benchmark-regression.sh, CI gate, PerformanceSLA | — | Already complete |
| Layer 2: CodeQualityView | CQRS projection, gate.executed/benchmark.completed handlers | — | Already complete |
| Layer 2: BenchmarkCompleted Event | Event type in taxonomy | — | Already complete |
| Layer 2: Flywheel Data Flow | CI gates → GateExecuted events → CodeQualityView | B1, B2, B3 | Covered |
| Layer 2: Flywheel Integration Points | Capability evals, regression evals, EvalResultsView correlation | D1–D5, E1–E3 | Covered |
| Layer 2: Quality-Aware Eval Cases | Extended dataset format with quality expectations | E1–E3 | Covered |
| Layer 2: Attribution Analysis | Per-skill quality correlation, regression surfacing | D1–D5, C1–C3 | Covered |
| Integration: LLM grading for skill quality | llm-rubric assertions per skill suite | A1–A8 | Covered |
| Integration: quality.regression emission | CodeQualityView → quality.regression events | C1–C3 | Covered |
| Testing Strategy: LLM grader wiring | LLM graders produce meaningful scores | A1–A8 | Covered |
| Testing Strategy: Flywheel loop | Quality data flows through views to eval framework | D1–D5 | Covered |

## Task Breakdown

### Group A: LLM Rubric Activation (Content, 8 tasks)

Each suite needs: (1) a `capability-llm.jsonl` dataset, (2) an `llm-rubric` assertion in `suite.json`, (3) a dataset reference.

---

### Task A1: Create brainstorming capability-llm.jsonl dataset
**Phase:** Content creation + verification

1. Create `evals/brainstorming/datasets/capability-llm.jsonl`
   - 3–5 traces with `input.approaches` or `input.designContent` for LLM evaluation
   - Cases: comprehensive multi-approach ideation (should pass), single-approach no-alternatives (should fail), partial exploration (partial credit)
   - Tags: `["capability-llm"]`, layer: `capability`
2. Verify: `cd servers/exarchos-mcp && npm run test:run -- --testPathPattern harness` (harness validates JSONL on load)

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task A2: Add llm-rubric assertion to brainstorming suite
**Phase:** Content modification + verification

1. Edit `evals/brainstorming/suite.json`:
   - Add to `assertions[]`: `{ "type": "llm-rubric", "name": "ideation-quality", "threshold": 0.7, "config": { "rubric": "Evaluate whether the ideation trace explores multiple approaches with trade-off analysis before selecting one. Score 1 if 2+ approaches are explored with pros/cons and a selection rationale. Score 0 if only one approach is considered or no trade-off analysis is present.", "outputPath": "approaches" } }`
   - Add to `datasets`: `"capability-llm": { "path": "./datasets/capability-llm.jsonl", "description": "LLM-graded ideation quality scenarios" }`
2. Verify: `cd servers/exarchos-mcp && npm run test:run -- --testPathPattern harness`

**Dependencies:** A1
**Parallelizable:** Yes (with other A* tasks on different suites)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task A3: Create debug capability-llm.jsonl dataset
**Phase:** Content creation

1. Create `evals/debug/datasets/capability-llm.jsonl`
   - 3–5 traces: systematic root cause analysis (pass), guess-and-fix (fail), partial investigation (partial)
   - Cases should contain investigation evidence, severity assessment, root cause identification
2. Verify: harness loads without errors

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task A4: Add llm-rubric assertion to debug suite
**Phase:** Content modification

1. Edit `evals/debug/suite.json`:
   - Add `llm-rubric` assertion: `{ "type": "llm-rubric", "name": "root-cause-analysis-quality", "threshold": 0.7, "config": { "rubric": "Evaluate whether the debug trace demonstrates systematic root cause analysis. Score 1 if the trace shows severity triage, evidence gathering, root cause identification, and targeted fix. Score 0 if the fix is applied without investigation or root cause is guessed without evidence.", "outputPath": "investigation" } }`
   - Add `capability-llm` dataset reference

**Dependencies:** A3
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task A5: Create refactor capability-llm.jsonl dataset
**Phase:** Content creation

1. Create `evals/refactor/datasets/capability-llm.jsonl`
   - 3–5 traces: scope-appropriate track selection (pass), overengineered refactor (fail), correct scope with behavioral preservation (pass)
2. Verify: harness loads without errors

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task A6: Add llm-rubric assertion to refactor suite
**Phase:** Content modification

1. Edit `evals/refactor/suite.json`:
   - Add `llm-rubric` assertion: `{ "type": "llm-rubric", "name": "refactor-quality", "threshold": 0.7, "config": { "rubric": "Evaluate whether the refactor trace demonstrates scope-appropriate track selection and behavioral preservation. Score 1 if scope assessment matches track choice (polish for small changes, overhaul for structural) and the refactor preserves existing behavior. Score 0 if track is mismatched to scope or behavioral changes are introduced without justification.", "outputPath": "brief" } }`
   - Add `capability-llm` dataset reference

**Dependencies:** A5
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task A7: Create implementation-planning capability-llm.jsonl dataset
**Phase:** Content creation

1. Create `evals/implementation-planning/datasets/capability-llm.jsonl`
   - 3–5 traces: comprehensive decomposition with correct dependencies (pass), missing components (fail), good decomposition but wrong parallel groups (partial)
2. Verify: harness loads without errors

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task A8: Add llm-rubric assertion to implementation-planning suite
**Phase:** Content modification

1. Edit `evals/implementation-planning/suite.json`:
   - Add `llm-rubric` assertion: `{ "type": "llm-rubric", "name": "plan-decomposition-quality", "threshold": 0.7, "config": { "rubric": "Evaluate whether the planning trace produces a comprehensive task decomposition with appropriate dependency ordering and testing strategy. Score 1 if tasks cover data model, core implementation, tests, and integration with correct parallel groups and dependencies. Score 0 if major components are missing or dependencies are incorrect.", "outputPath": "tasks" } }`
   - Add `capability-llm` dataset reference

**Dependencies:** A7
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Group B: Gate Event Emission from Skills (Content, 3 tasks)

The orchestrating agent observes CI results via `gh pr checks` and emits `gate.executed` events locally via `exarchos_event`. These are Markdown content changes to skill files.

---

### Task B1: Add gate event emission to shepherd skill
**Phase:** Content modification

1. Edit `skills/shepherd/SKILL.md`:
   - In the CI check observation step, add instruction block:
     ```
     After checking each CI gate result, emit a gate.executed event:
     exarchos_event({ action: "append", streamId: "<featureId>",
       event: { type: "gate.executed", data: {
         gateName: "<check-name>", layer: "CI", passed: <bool>,
         duration: <ms>, details: { skill: "<skill>", commit: "<sha>" }
       }}
     })
     ```
   - Add to the Event Emission Contract table

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task B2: Add gate event emission to synthesis skill
**Phase:** Content modification

1. Edit `skills/synthesis/SKILL.md`:
   - After build/test verification steps, add `gate.executed` emission instructions
   - After review status check, add `gate.executed` emission for review gate

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task B3: Add gate event emission to delegation skill
**Phase:** Content modification

1. Edit `skills/delegation/SKILL.md`:
   - After task collection/verification, emit `gate.executed` for post-delegation check results
   - Add to Event Emission Contract table

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Group C: Quality Regression Emission Wiring (TDD, 3 tasks)

`regression-detector.ts` exists at `servers/exarchos-mcp/src/quality/regression-detector.ts` with `detectRegressions()` and `emitRegressionEvents()` fully implemented and tested — but nothing calls them. Wire into `handleViewCodeQuality`.

---

### Task C1: Wire regression detector into handleViewCodeQuality
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `HandleViewCodeQuality_WithRegressions_EmitsQualityRegressionEvents`
   - File: `servers/exarchos-mcp/src/views/tools.test.ts`
   - Arrange: Set up event store with 3+ consecutive `gate.executed` failures for same gate+skill
   - Act: Call `handleViewCodeQuality({ workflowId: 'test' }, stateDir)`
   - Assert: Event store contains `quality.regression` event with correct skill/gate/count
   - Expected failure: no regression emission logic in handleViewCodeQuality

2. **[GREEN]** Implement minimum code
   - File: `servers/exarchos-mcp/src/views/tools.ts` (in `handleViewCodeQuality`, after line 398)
   - Import `detectRegressions`, `emitRegressionEvents` from `../quality/regression-detector.js`
   - After materialization: `const regressions = detectRegressions(view); if (regressions.length > 0) { emitRegressionEvents(regressions, streamId, store).catch(() => {}); }`

3. **[REFACTOR]** Clean up if needed

**Dependencies:** None
**Parallelizable:** No (sequential TDD chain C1→C2→C3)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task C2: Add deduplication to prevent duplicate regression emissions
**Phase:** RED → GREEN

1. **[RED]** Write test: `HandleViewCodeQuality_CalledTwice_DoesNotEmitDuplicateRegressions`
   - File: `servers/exarchos-mcp/src/views/tools.test.ts`
   - Arrange: 3+ consecutive failures for same gate+skill
   - Act: Call `handleViewCodeQuality` twice
   - Assert: Only 1 `quality.regression` event emitted (not 2)
   - Expected failure: no dedup logic

2. **[GREEN]** Add dedup via query before emit
   - Before emitting, query event store for existing `quality.regression` events matching this gate+skill
   - Skip emission if already emitted for same failure sequence (match on `firstFailureCommit`)

**Dependencies:** C1
**Parallelizable:** No
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task C3: Add quality-check CLI command
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `HandleQualityCheck_WithRegressions_OutputsReport`
   - File: `servers/exarchos-mcp/src/cli-commands/quality-check.test.ts`
   - Test: CLI handler materializes CodeQualityView, detects regressions, returns summary
   - Expected failure: file doesn't exist

2. **[GREEN]** Implement CLI handler
   - File: `servers/exarchos-mcp/src/cli-commands/quality-check.ts`
   - Pattern: follows `eval-run.ts` structure (reads stdin, materializes, reports)
   - Wire into `servers/exarchos-mcp/src/cli.ts` router

3. **[REFACTOR]** Extract shared patterns with eval-run

**Dependencies:** C1, C2
**Parallelizable:** No
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Group D: Cross-Correlation View (TDD, 5 tasks)

Pure function joining `CodeQualityViewState` and `EvalResultsViewState` by skill name, exposed as `quality_correlation` action.

---

### Task D1: Define QualityCorrelation interfaces and initial implementation
**Phase:** RED → GREEN

1. **[RED]** Write test: `CorrelateQualityAndEvals_MatchingSkills_ReturnsJoinedMetrics`
   - File: `servers/exarchos-mcp/src/quality/quality-correlation.test.ts`
   - Arrange: CodeQualityViewState with `delegation` skill metrics (passRate: 0.9), EvalResultsViewState with `delegation` eval metrics (latestScore: 0.85)
   - Act: `correlateQualityAndEvals(codeQualityState, evalResultsState)`
   - Assert: result contains `{ skills: { delegation: { gatePassRate: 0.9, evalScore: 0.85 } } }`
   - Expected failure: module doesn't exist

2. **[GREEN]** Implement `correlateQualityAndEvals`
   - File: `servers/exarchos-mcp/src/quality/quality-correlation.ts`
   - Export interface `QualityCorrelation { skills: Record<string, SkillCorrelation> }`
   - Export interface `SkillCorrelation { skill, gatePassRate, evalScore, evalTrend, qualityTrend, regressionCount }`
   - Pure function: iterate skill names from both views, join metrics

**Dependencies:** None
**Parallelizable:** No (sequential TDD chain D1→D5)
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["correlation contains only skills present in both views", "correlation is symmetric in skill ordering"] }`

---

### Task D2: Handle edge cases in correlation
**Phase:** RED → GREEN

1. **[RED]** Write tests:
   - `CorrelateQualityAndEvals_NoOverlappingSkills_ReturnsEmptySkills`
   - `CorrelateQualityAndEvals_EmptyViews_ReturnsEmptySkills`
   - `CorrelateQualityAndEvals_OneViewEmpty_ReturnsEmptySkills`

2. **[GREEN]** Guard clauses in `correlateQualityAndEvals`

**Dependencies:** D1
**Parallelizable:** No
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task D3: Add property tests for correlation
**Phase:** RED → GREEN

1. **[RED]** Write property tests:
   - `Correlation_SkillsSubsetOfBothViews` — result skills are always a subset of intersection
   - `Correlation_Idempotent` — calling twice produces same result
   - File: `servers/exarchos-mcp/src/quality/quality-correlation.test.ts`

2. **[GREEN]** Ensure implementation passes property tests

**Dependencies:** D2
**Parallelizable:** No
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false }`

---

### Task D4: Wire quality_correlation action into composite router
**Phase:** RED → GREEN

1. **[RED]** Write test: `HandleView_QualityCorrelationAction_ReturnsCorrelatedData`
   - File: `servers/exarchos-mcp/src/views/tools.test.ts`
   - Test: `handleViewQualityCorrelation` materializes both views and returns joined data

2. **[GREEN]** Implement handler + wire router
   - File: `servers/exarchos-mcp/src/views/tools.ts` — add `handleViewQualityCorrelation`
   - File: `servers/exarchos-mcp/src/views/composite.ts` — add `case 'quality_correlation':` + update `validTargets` array

**Dependencies:** D3
**Parallelizable:** No
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task D5: Integration test for quality_correlation via composite
**Phase:** RED → GREEN

1. **[RED]** Write test: `HandleView_QualityCorrelation_EndToEnd`
   - File: `servers/exarchos-mcp/src/views/composite.test.ts`
   - Arrange: Event store with eval events + gate events for same skill
   - Act: `handleView({ action: 'quality_correlation' }, stateDir)`
   - Assert: Response contains correlated skill data

2. **[GREEN]** Fix any integration issues

**Dependencies:** D4
**Parallelizable:** No
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Group E: Quality-Aware Eval Cases (Content, 2 tasks)

---

### Task E1: Create quality-aware dataset for delegation suite
**Phase:** Content creation

1. Create `evals/delegation/datasets/capability-quality.jsonl`
   - 3–5 cases with quality expectations in `expected`:
     - `"expected": { "gates_passed": ["typecheck", "build", "unit-tests"], "property_test_count_min": 3 }`
     - `"expected": { "benchmark_regressions": 0, "gates_passed": ["lint", "typecheck"] }`
   - `input` contains realistic delegation traces with quality outcome data
   - Tags: `["capability", "quality"]`, layer: `capability`

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task E2: Wire quality dataset into delegation suite and activate llm-similarity
**Phase:** Content modification

1. Edit `evals/delegation/suite.json`:
   - Add to `datasets`: `"capability-quality": { "path": "./datasets/capability-quality.jsonl", "description": "Quality-focused delegation scenarios testing code quality outcomes" }`
   - Add `llm-similarity` assertion: `{ "type": "llm-similarity", "name": "delegation-output-similarity", "threshold": 0.7, "config": { "outputPath": "tasks", "expectedPath": "tasks" } }` — activates the currently-unused grader
2. Verify: `cd servers/exarchos-mcp && npm run test:run -- --testPathPattern harness`

**Dependencies:** E1
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

## Parallelization Strategy

```
Group A (content)     Group B (content)     Group C (TDD)           Group D (TDD)
A1,A3,A5,A7 ──┐      B1,B2,B3 ──┐         C1 → C2 → C3           D1 → D2 → D3 → D4 → D5
A2,A4,A6,A8 ──┘      (all parallel)       (sequential)            (sequential)

Group E (content)
E1 → E2
```

| Parallel Batch | Tasks | Worktrees |
|---|---|---|
| **Batch 1** | A1+A2, A3+A4, A5+A6, A7+A8 (pair per suite) | 4 worktrees |
| **Batch 2** | B1+B2+B3 (all skill content) | 1 worktree |
| **Batch 3** | C1→C2→C3 (regression wiring) | 1 worktree |
| **Batch 4** | D1→D2→D3→D4→D5 (correlation) | 1 worktree |
| **Batch 5** | E1→E2 (quality eval cases) | 1 worktree |

Batches 1–5 are ALL independent and can run simultaneously in 8 worktrees (4 for suite pairs + 1 each for B, C, D, E).

## Key Files

| File | Changes |
|---|---|
| `evals/{brainstorming,debug,refactor,implementation-planning}/suite.json` | Add llm-rubric assertion + capability-llm dataset reference |
| `evals/{brainstorming,debug,refactor,implementation-planning}/datasets/capability-llm.jsonl` | New LLM-gradable datasets |
| `evals/delegation/suite.json` | Add llm-similarity assertion + capability-quality dataset |
| `evals/delegation/datasets/capability-quality.jsonl` | New quality-aware dataset |
| `skills/shepherd/SKILL.md` | Gate event emission instructions |
| `skills/synthesis/SKILL.md` | Gate event emission instructions |
| `skills/delegation/SKILL.md` | Gate event emission instructions |
| `servers/exarchos-mcp/src/views/tools.ts` | Wire regression detector + add quality_correlation handler |
| `servers/exarchos-mcp/src/views/composite.ts` | Add quality_correlation action routing |
| `servers/exarchos-mcp/src/quality/quality-correlation.ts` | New: pure correlation function |
| `servers/exarchos-mcp/src/quality/quality-correlation.test.ts` | New: correlation tests + property tests |
| `servers/exarchos-mcp/src/cli-commands/quality-check.ts` | New: CLI command for quality check |
| `servers/exarchos-mcp/src/cli.ts` | Add quality-check command routing |

## Existing Code to Reuse

| Module | Path | Reuse |
|---|---|---|
| `regression-detector.ts` | `servers/exarchos-mcp/src/quality/regression-detector.ts` | Already implemented: `detectRegressions()`, `emitRegressionEvents()` — just wire in |
| `llm-helper.ts` | `servers/exarchos-mcp/src/evals/graders/llm-helper.ts` | API key skip logic — already handles missing ANTHROPIC_API_KEY |
| `eval-run.ts` | `servers/exarchos-mcp/src/cli-commands/eval-run.ts` | Pattern for quality-check CLI command |
| `delegation/capability-llm.jsonl` | `evals/delegation/datasets/capability-llm.jsonl` | Template for new LLM datasets |

## Deferred Items

| Item | Rationale |
|---|---|
| Auto-remediation guidance for benchmark failures (Design Phase 4, item 25) | Needs real quality data flowing through the system first; premature without observed patterns |
| Prompt version tracking in attribution | No versioning system for skill content yet; track as future enhancement |
| Model comparison fairness controls | Needs stratification by task complexity; requires sufficient sample size (20+ workflows per skill) |

## Verification

### End-to-End Test Plan
1. `cd servers/exarchos-mcp && npm run test:run` — all unit + property tests pass
2. `cd servers/exarchos-mcp && echo '{}' | node dist/cli.js eval-run` — all suites discovered, deterministic graders pass, LLM graders skip gracefully without API key
3. `cd servers/exarchos-mcp && echo '{"layer":"capability"}' | node dist/cli.js eval-run` — capability layer runs (advisory)
4. `cd servers/exarchos-mcp && echo '{}' | node dist/cli.js quality-check` — quality check CLI runs, reports no regressions (clean state)
5. Verify `quality_correlation` action: call `exarchos_view({ action: "quality_correlation" })` — returns empty correlation (no data yet)

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] LLM graders activated in 4 new suites
- [ ] llm-similarity activated in delegation suite
- [ ] Gate emission instructions in 3 skills
- [ ] Regression detector wired into handleViewCodeQuality
- [ ] quality_correlation action available via exarchos_view
- [ ] quality-check CLI command functional
- [ ] Ready for review
