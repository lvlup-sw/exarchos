# Design: Autonomous Code Verification — Unified Testing and Evaluation Framework

## Problem Statement

The distributed SDLC pipeline (see [distributed-sdlc-pipeline.md](../adrs/distributed-sdlc-pipeline.md)) enables autonomous code generation from high-level goals. Agents decompose features into tasks, write code via TDD, and submit PRs through Graphite stacks. Layered CI gates (see [section 11](../adrs/distributed-sdlc-pipeline.md#11-layered-quality-gates)) provide post-hoc verification — secret scanning, build verification, unit tests, mutation testing, architecture tests, and agent-based reviews.

This architecture has a verification gap: **there is no systematic way to ensure that autonomously generated code is functionally correct beyond the agent's own tests, performs within acceptable bounds, or that the verification results feed back into improving future generation quality.**

Three specific gaps exist:

1. **Example-only testing** — Agents write example-based unit tests during TDD. These verify specific cases but miss entire classes of bugs: off-by-one errors in boundary conditions, state machine violations, invariant breaches under concurrent access, and property violations across input domains. Property-based testing (generators + invariants) catches these systematically.

2. **No performance regression detection** — The CI pipeline validates correctness (tests pass, build succeeds) but not performance. An agent-generated PR can introduce a 10x latency regression in a hot path with no gate to catch it. Runtime performance benchmarks exist in other libraries but aren't integrated into the autonomous pipeline.

3. **No verification feedback loop** — CI gate results are consumed by the auto-remediation pipeline (fix the immediate failure) but not by the eval framework (improve future generation). When an agent consistently produces code that fails mutation testing, that signal is lost after the PR is fixed. No mechanism correlates prompt quality with generated code quality across workflows.

### Relationship to Existing Designs

| Design | Relationship |
|---|---|
| [Distributed SDLC Pipeline](../adrs/distributed-sdlc-pipeline.md) | Defines the autonomous pipeline this design verifies |
| [SDLC Eval Framework](2026-02-13-sdlc-eval-framework.md) | Measures prompt/skill quality; this design extends it to measure generated code quality |
| [SDLC Benchmarks](2026-02-12-sdlc-benchmarks.md) | Telemetry-as-events for MCP tool performance; this design applies similar patterns to generated code performance |

---

## Chosen Approach

**Concrete verification infrastructure (property-based testing + benchmark gates) feeding a closed-loop verification flywheel.**

Start with two high-impact, immediately actionable capabilities — property-based testing as a first-class agent practice, and performance benchmark regression detection in CI. Then connect these to the SDLC eval framework to create a closed-loop system where generated code quality data feeds back into agent improvement.

### Why This Combination

The verification flywheel needs data to generate signal. Property-based tests and benchmark gates are the highest-value data sources:

- **Property-based tests** catch bugs that example tests cannot, producing richer pass/fail signal about code correctness across input domains
- **Benchmark gates** produce quantitative performance data that can be trended, baselined, and correlated with code changes
- Both generate structured data (test results, benchmark metrics) that naturally flows through the existing event stream into CQRS views

Without the concrete infrastructure (layer 1), the flywheel has nothing to measure. Without the flywheel (layer 2), the concrete infrastructure only catches problems — it doesn't prevent them from recurring.

---

## Technical Design

### Layer 1: Property-Based Testing Infrastructure

Property-based testing (PBT) uses generators to produce random inputs and invariant assertions to verify that properties hold across the input space. Unlike example tests that check specific cases, PBT systematically explores edge cases, boundary conditions, and unexpected input combinations.

#### When to Require Property-Based Tests

Not all code benefits equally from PBT. The plan schema gains a `testingStrategy` field per task:

```typescript
interface PlanTask {
  // ... existing fields
  testingStrategy: {
    /** Standard example-based TDD (always required) */
    exampleTests: true;
    /** Property-based tests required when applicable */
    propertyTests: boolean;
    /** Performance benchmarks required when applicable */
    benchmarks: boolean;
    /** Properties to verify (guidance for the agent) */
    properties?: string[];
    /** Performance SLAs (guidance for the agent) */
    performanceSLAs?: PerformanceSLA[];
  };
}
```

The `/plan` skill determines `propertyTests: true` when the task involves:

| Category | Example | Properties to Test |
|---|---|---|
| **Data transformations** | Parse/serialize, encode/decode | Roundtrip: `decode(encode(x)) === x` |
| **Mathematical operations** | Scoring, budgets, percentages | Invariants: `score >= 0 && score <= 1.0` |
| **State machines** | Workflow HSM, circuit breaker | Transition validity: no invalid state reachable |
| **Collections/ordering** | Sort, filter, pagination | Idempotence: `sort(sort(x)) === sort(x)` |
| **Concurrency** | Optimistic locking, CAS | Linearizability: concurrent ops produce valid state |
| **Serialization** | Event schemas, API contracts | Schema compliance: output matches declared schema |

Tasks that are purely wiring (DI registration, configuration), UI layout, or simple CRUD without business logic use `propertyTests: false`.

#### Property Test Patterns

Agents receive guidance on standard property patterns via spawn prompt enrichment:

```markdown
## Property-Based Testing Patterns

When `propertyTests: true`, write property tests alongside example tests.

### Roundtrip Properties
For any encode/decode, serialize/deserialize, or transform/inverse-transform pair:
```typescript
it.prop([fc.anything()], (input) => {
  expect(decode(encode(input))).toEqual(input);
});
```

### Invariant Properties
For operations with mathematical or business invariants:
```typescript
it.prop([fc.integer(), fc.integer()], (a, b) => {
  const result = calculateScore(a, b);
  expect(result).toBeGreaterThanOrEqual(0);
  expect(result).toBeLessThanOrEqual(1);
});
```

### Idempotence Properties
For operations that should produce the same result when applied twice:
```typescript
it.prop([fc.array(fc.integer())], (arr) => {
  expect(sort(sort(arr))).toEqual(sort(arr));
});
```

### Commutativity / Associativity
For operations where order shouldn't matter:
```typescript
it.prop([events1, events2], (a, b) => {
  expect(materialize([...a, ...b])).toEqual(materialize([...b, ...a]));
});
```
```

#### Validation Script: `check-property-tests.sh`

A new validation script (following the existing pattern) verifies that tasks marked `propertyTests: true` in the plan actually have property-based tests in the implementation:

```bash
#!/usr/bin/env bash
set -euo pipefail
# check-property-tests.sh <worktree-path> <plan-file>
# Verifies that tasks requiring property-based tests have them.
# Exit 0 = pass, 1 = fail, 2 = usage

# Parse plan for tasks with propertyTests: true
# Scan worktree for property test patterns (it.prop, fc.*, test.prop)
# Cross-reference: every required task has at least one property test
```

#### Framework Selection

For the TypeScript ecosystem (Exarchos, frontend):
- **fast-check** — The standard PBT library for TypeScript/JavaScript. Vitest-compatible via `@fast-check/vitest`. Provides `fc.anything()`, `fc.record()`, `fc.array()`, etc. for generator composition.

For the .NET ecosystem (Basileus backend):
- **FsCheck** — Property-based testing for .NET, integrates with TUnit. Provides `Arb.generate<T>()` and `Prop.forAll()`.

Both are mature, well-documented, and actively maintained.

---

### Layer 1: Benchmark Regression Infrastructure

#### Benchmark Types

Three categories of benchmarks apply to autonomously generated code:

| Category | What It Measures | When Required | Example |
|---|---|---|---|
| **Latency** | Response time (P50, P95, P99) | API endpoints, hot paths, event processing | "GET /api/users P99 < 50ms" |
| **Throughput** | Operations per second | Batch processing, event ingestion, view materialization | "Materialize 1000 events in < 500ms" |
| **Resource** | Memory, CPU, allocation rate | Data structures, caching, streaming | "Peak memory < 100MB for 10K workflows" |

#### Benchmark Specification in Plans

The `performanceSLAs` field in the plan task schema:

```typescript
interface PerformanceSLA {
  /** What operation is being measured */
  operation: string;
  /** Metric type */
  metric: 'p50' | 'p95' | 'p99' | 'throughput' | 'memory' | 'allocations';
  /** Target value */
  target: number;
  /** Unit of measurement */
  unit: 'ms' | 'ops/sec' | 'MB' | 'bytes' | 'count';
  /** How many warmup iterations before measurement */
  warmupIterations?: number;
  /** How many measurement iterations */
  measurementIterations?: number;
}
```

Example in a plan:

```yaml
tasks:
  - id: T1
    title: "Event store query optimization"
    testingStrategy:
      exampleTests: true
      propertyTests: true
      benchmarks: true
      properties:
        - "Query results are ordered by sequence number"
        - "Pre-parse filtering produces same results as post-parse filtering"
      performanceSLAs:
        - operation: "query 1000 events with type filter"
          metric: p99
          target: 100
          unit: ms
        - operation: "query 10000 events with time range"
          metric: throughput
          target: 500
          unit: ops/sec
```

#### Benchmark Execution

**TypeScript (Vitest Bench):**

Vitest includes built-in benchmarking via `bench()`:

```typescript
import { bench, describe } from 'vitest';

describe('EventStore.query', () => {
  bench('1000 events with type filter', async () => {
    await store.query({ filter: { type: 'task.completed' }, limit: 100 });
  }, {
    warmupIterations: 10,
    iterations: 100,
  });
});
```

**.NET (BenchmarkDotNet):**

The standard .NET benchmarking framework, already used in the ecosystem:

```csharp
[MemoryDiagnoser]
public class EventQueryBenchmarks
{
    [Benchmark]
    public async Task Query1000EventsWithTypeFilter()
    {
        await _store.QueryAsync(new EventQuery { Type = "task.completed", Limit = 100 });
    }
}
```

#### Benchmark Baselines and Regression Detection

Baselines are stored per-project in a `benchmarks/baselines.json` file:

```json
{
  "event-store-query-1000-type-filter": {
    "p50_ms": 12.3,
    "p95_ms": 28.7,
    "p99_ms": 45.2,
    "measured_at": "2026-02-10T14:30:00Z",
    "commit": "abc123",
    "iterations": 100
  }
}
```

A new CI gate — `BenchmarkRegressionGate` — compares PR benchmark results against baselines:

```typescript
interface BenchmarkGateResult {
  operation: string;
  baseline: number;
  measured: number;
  regressionPercent: number;
  threshold: number;    // configurable, default 10%
  passed: boolean;
}
```

**Regression detection logic:**

```
IF measured > baseline * (1 + threshold):
  FAIL — "P99 latency regressed from 45ms to 62ms (+38%, threshold 10%)"
ELIF measured < baseline * (1 - improvement_threshold):
  INFO — "P99 latency improved from 45ms to 31ms (-31%), consider updating baseline"
ELSE:
  PASS — "P99 latency within bounds (45ms baseline, 47ms measured, +4%)"
```

#### Validation Script: `check-benchmark-regression.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
# check-benchmark-regression.sh <benchmark-results> <baselines-file> [threshold]
# Compares benchmark results against baselines.
# Exit 0 = pass (no regressions), 1 = fail (regressions detected), 2 = usage
```

#### CI Integration

The benchmark gate integrates into the per-PR CI pipeline:

```yaml
# In per-pr-gates.yml
benchmark:
  runs-on: ubuntu-latest
  needs: governance
  if: contains(github.event.pull_request.labels.*.name, 'has-benchmarks')
  steps:
    - name: Run Benchmarks
      run: npm run bench -- --reporter json --outputFile benchmark-results.json

    - name: Check Regression
      run: bash scripts/check-benchmark-regression.sh benchmark-results.json benchmarks/baselines.json
```

Benchmarks run conditionally — only when the PR is labeled `has-benchmarks` (applied automatically by the `/delegate` skill when the plan includes benchmark tasks) or when benchmark test files are modified.

---

### Layer 2: Gate Result Materialization

Gate results from both CI and agent-side execution already emit `GateExecuted` events to the Marten stream (defined in the distributed SDLC pipeline ADR). This layer materializes those events into queryable views that track code quality across workflows.

#### CodeQualityView

A new CQRS projection that aggregates gate results per agent, per skill, per model, per repository:

```typescript
interface CodeQualityView {
  /** Per-skill quality aggregates */
  skills: Record<string, SkillQualityMetrics>;

  /** Per-model quality aggregates */
  models: Record<string, ModelQualityMetrics>;

  /** Per-gate pass rates */
  gates: Record<string, GateMetrics>;

  /** Active regressions: gates that recently started failing */
  regressions: QualityRegression[];

  /** Benchmark trends */
  benchmarks: BenchmarkTrend[];
}

interface SkillQualityMetrics {
  skill: string;
  /** How often does code from this skill pass all gates on first try? */
  firstPassRate: number;
  /** Average remediation attempts when gates fail */
  avgRemediationAttempts: number;
  /** Which gates fail most often for this skill? */
  topFailingGates: Array<{ gate: string; failureRate: number }>;
  /** Mutation testing score trend */
  mutationScoreTrend: TrendPoint[];
  /** Property test coverage (when applicable) */
  propertyTestCoverage: number;
  /** Sample size */
  workflowCount: number;
}

interface ModelQualityMetrics {
  model: string;
  /** Same metrics as skill, sliced by which model generated the code */
  firstPassRate: number;
  avgRemediationAttempts: number;
  topFailingGates: Array<{ gate: string; failureRate: number }>;
  workflowCount: number;
}

interface GateMetrics {
  gate: string;
  layer: number;
  /** Pass rate across all workflows */
  passRate: number;
  /** Average duration */
  avgDuration: number;
  /** How often does auto-remediation fix this gate's failures? */
  remediationSuccessRate: number;
  /** Trend: is this gate's pass rate improving or degrading? */
  trend: 'improving' | 'stable' | 'degrading';
}

interface BenchmarkTrend {
  operation: string;
  /** Historical measurements */
  dataPoints: Array<{
    value: number;
    commit: string;
    timestamp: string;
    workflowId: string;
  }>;
  /** Current baseline */
  baseline: number;
  /** Direction of trend */
  trend: 'improving' | 'stable' | 'degrading';
}

interface QualityRegression {
  gate: string;
  /** When did this gate start failing consistently? */
  firstFailedAt: string;
  /** How many consecutive workflows have failed this gate? */
  consecutiveFailures: number;
  /** What changed? (commit range, skill version, model change) */
  possibleCauses: string[];
}
```

This view is materialized from existing event types:
- `GateExecuted` → pass/fail per gate per workflow
- `GateSelfCorrected` → remediation tracking
- `RemediationAttempted` / `RemediationExhausted` → remediation success rates
- `TaskCompleted` → correlate with agent model, skill, and task type
- New: `BenchmarkCompleted` event type for benchmark results

#### BenchmarkCompleted Event

A new event type in the taxonomy:

```typescript
type BenchmarkCompleted = WorkflowEvent & {
  type: "BenchmarkCompleted";
  taskId: string;
  results: Array<{
    operation: string;
    metric: string;
    value: number;
    unit: string;
    baseline?: number;
    regressionPercent?: number;
    passed: boolean;
  }>;
};
```

---

### Layer 2: Closed-Loop Verification Flywheel

The flywheel connects generated code quality data back to the eval framework, creating a self-improving system.

#### Data Flow

```
Agent generates code
    │
    ▼
CI gates execute ──── GateExecuted events ────┐
Benchmarks run ─────── BenchmarkCompleted ─────┤
Property tests run ── TestResult events ───────┤
                                               │
                                               ▼
                                    CodeQualityView materializes
                                               │
                                               ▼
                              ┌────────────────────────────────┐
                              │   Eval Framework Integration   │
                              │                                │
                              │  Capability Eval:              │
                              │    "Does /delegate produce     │
                              │     code that passes           │
                              │     mutation testing?"         │
                              │                                │
                              │  Regression Eval:              │
                              │    "Did the prompt change in   │
                              │     v2.1 cause benchmark       │
                              │     regressions?"              │
                              │                                │
                              │  Reliability Eval:             │
                              │    "How often does auto-       │
                              │     remediation succeed for    │
                              │     property test failures?"   │
                              └────────────────────────────────┘
                                               │
                                               ▼
                              ┌────────────────────────────────┐
                              │   Prompt Refinement Signal     │
                              │                                │
                              │  "Delegation spawn prompts     │
                              │   produce 23% mutation test    │
                              │   failure rate. Add invariant  │
                              │   assertion guidance to spawn  │
                              │   template."                   │
                              │                                │
                              │  "Opus model produces 15%      │
                              │   higher property test         │
                              │   coverage than Sonnet."       │
                              └────────────────────────────────┘
```

#### Flywheel Integration Points

| Eval Framework Component | Code Quality Integration |
|---|---|
| **Capability evals** | Add assertions that grade generated code quality, not just workflow completion: "did the PR pass mutation testing?", "does the code meet benchmark SLAs?" |
| **Regression evals** | Detect when prompt changes cause code quality degradation: "skill v2.1 spawn prompts produce code with 15% lower mutation scores than v2.0" |
| **Reliability evals** | Measure auto-remediation effectiveness: "property test failures are successfully auto-remediated 78% of the time vs. 45% for architecture test failures" |
| **EvalResultsView** | Extend to include code quality correlation: per-skill eval scores alongside per-skill code quality metrics |

#### Quality-Aware Eval Cases

The eval dataset format extends to include code quality expectations:

```jsonl
{"id": "del-qual-001", "type": "trace", "description": "Delegation produces code that passes all L1-L3 gates", "input": {"design_path": "...", "design_content": "..."}, "expected": {"gates_passed": ["secret-scan", "build", "unit-tests", "mutation", "architecture"], "mutation_score_min": 0.7, "benchmark_regressions": 0, "property_test_count_min": 3}, "tags": ["capability", "quality"]}
```

#### Attribution Analysis

The key challenge in the flywheel is attribution — when code quality degrades, what caused it? The `CodeQualityView` enables multi-dimensional analysis:

| Dimension | Question | Data Source |
|---|---|---|
| **Skill** | "Which skill produces the lowest mutation scores?" | `SkillQualityMetrics.mutationScoreTrend` |
| **Model** | "Does Opus produce more benchmark-compliant code than Sonnet?" | `ModelQualityMetrics.firstPassRate` |
| **Task type** | "Do data transformation tasks fail property tests more often?" | Cross-reference `PlanTask.testingStrategy` with `GateExecuted` events |
| **Complexity** | "Do tasks with > 5 files fail gates more often?" | Cross-reference task file count with gate results |
| **Prompt version** | "Did the v2.1 spawn prompt change improve or degrade quality?" | Compare quality metrics before/after prompt change timestamp |

When a regression is detected (consecutive gate failures for a skill or model), the flywheel emits a `QualityRegression` to the event stream, which the `EvalResultsView` surfaces alongside eval regressions. The developer can then:
1. Inspect the `CodeQualityView` for the affected skill/model
2. Review recent prompt changes
3. Run targeted capability evals against the changed prompts
4. Decide whether to revert, refine, or accept the change

---

## Integration Points

### With the Distributed SDLC Pipeline

| Component | Integration |
|---|---|
| `/plan` skill | Gains `testingStrategy` field per task: `propertyTests`, `benchmarks`, `performanceSLAs`, `properties` |
| `/delegate` spawn prompts | Enriched with property-based testing patterns when `propertyTests: true` |
| `/review` skill | Gains benchmark review checklist item |
| Layered CI gates | Gains `BenchmarkRegressionGate` in per-PR pipeline |
| Event taxonomy | Gains `BenchmarkCompleted` event type |
| CQRS views | Gains `CodeQualityView` projection |
| Auto-remediation | Extended to handle benchmark regression failures (suggest optimization, not just correctness fixes) |

### With the SDLC Eval Framework

| Component | Integration |
|---|---|
| Eval harness | Extended to grade generated code quality (not just workflow completion) |
| Eval datasets | Gain `expected.gates_passed`, `expected.mutation_score_min`, `expected.benchmark_regressions` fields |
| `EvalResultsView` | Cross-references eval scores with code quality metrics for trend correlation |
| Capability evals | Include code quality assertions: mutation scores, property test coverage, benchmark compliance |
| Regression evals | Detect prompt changes that degrade generated code quality |

### With the Telemetry Benchmark Infrastructure

| Component | Integration |
|---|---|
| `baselines.json` | Extended from MCP tool benchmarks to include generated code benchmarks |
| Telemetry events | `BenchmarkCompleted` follows same event-sourcing pattern as `tool.completed` |
| Benchmark harness | Shared infrastructure between MCP server benchmarks and generated code benchmarks |

---

## Testing Strategy

### Unit Tests

- **Property test detection** — `check-property-tests.sh` correctly identifies tasks with/without property tests
- **Benchmark regression detection** — `check-benchmark-regression.sh` correctly detects regressions above threshold
- **CodeQualityView materialization** — View correctly projects from `GateExecuted` + `BenchmarkCompleted` event sequences
- **Plan task schema** — `testingStrategy` field validates correctly for all configurations
- **Attribution analysis** — Quality metrics correctly correlate across skill, model, and task dimensions

### Integration Tests

- **End-to-end property test flow** — Plan with `propertyTests: true` → agent spawn prompt includes PBT guidance → generated tests include `it.prop` calls → CI validates
- **End-to-end benchmark flow** — Plan with `benchmarks: true` → benchmark tests generated → results compared against baselines → `BenchmarkCompleted` event emitted → CodeQualityView updated
- **Flywheel loop** — Prompt change → code quality regression detected → eval framework flags regression → prompt refinement signal generated

### Smoke Tests

- **fast-check integration** — Verify `@fast-check/vitest` works with the project's Vitest configuration
- **Vitest bench** — Verify `bench()` produces JSON output consumable by regression detection
- **Cross-model comparison** — Same task generated by Opus and Sonnet, quality metrics compared

---

## Implementation Phases

### Phase 1: Property-Based Testing (No Dependencies)

1. Add `@fast-check/vitest` to Exarchos MCP server dev dependencies
2. Extend plan task schema with `testingStrategy` field
3. Add property-based testing patterns to spawn prompt templates
4. Create `check-property-tests.sh` validation script with `.test.sh`
5. Write example property tests for existing Exarchos modules (state machine, event store, views) as reference implementations
6. Update `/plan` skill to determine `propertyTests` requirement per task
7. Update TDD rules to include property-based testing guidance

### Phase 2: Benchmark Infrastructure (No Dependencies)

8. Create `benchmarks/baselines.json` schema and initial baselines
9. Create `check-benchmark-regression.sh` validation script with `.test.sh`
10. Add benchmark specifications to plan task schema (`performanceSLAs`)
11. Add `BenchmarkCompleted` event type to event taxonomy
12. Add benchmark gate to per-PR CI pipeline (conditional on label)
13. Update `/plan` skill to determine benchmark requirements per task
14. Update `/delegate` to apply `has-benchmarks` label when plan includes benchmarks

### Phase 3: Gate Result Materialization (After Phases 1-2)

15. Implement `CodeQualityView` CQRS projection
16. Add `code_quality` action to `exarchos_view` composite tool
17. Materialize from `GateExecuted`, `BenchmarkCompleted`, `TestResult` events
18. Implement attribution analysis (per-skill, per-model, per-task-type)
19. Implement regression detection (consecutive gate failures)
20. Add `QualityRegression` event type

### Phase 4: Flywheel Integration (After Phase 3 + Eval Framework Phase 2)

21. Extend eval dataset format with code quality expectations
22. Add code quality assertions to capability eval suites
23. Add prompt-quality correlation to `EvalResultsView`
24. Implement regression evals that detect prompt changes causing code quality degradation
25. Create auto-remediation guidance for benchmark failures (optimization hints vs. correctness fixes)

---

## Open Questions

1. **Property test runtime budget** — Property-based tests with large search spaces can be slow. What's the CI budget for PBT execution? **Recommendation:** Default to 100 examples per property (fast-check default), configurable per-test. Cap total PBT time at 2 minutes in per-PR CI.

2. **Benchmark stability** — Benchmarks in CI environments (shared runners, variable load) can be noisy. How do we handle flaky benchmark results? **Recommendation:** Use relative thresholds (% regression from baseline) rather than absolute values. Require 3 consecutive regressions before blocking. Consider dedicated benchmark runners for high-value projects.

3. **Baseline update policy** — Who updates benchmark baselines when intentional performance changes occur? **Recommendation:** Agents can propose baseline updates in the same PR (add `baselines-updated` label for reviewer attention). Baseline updates require explicit reviewer approval.

4. **Cross-ecosystem consistency** — TypeScript uses fast-check + Vitest bench; .NET uses FsCheck + BenchmarkDotNet. How much should the verification framework abstract over these differences? **Recommendation:** Keep the validation scripts (`check-property-tests.sh`, `check-benchmark-regression.sh`) ecosystem-agnostic — they validate presence and results, not framework-specific syntax. The CodeQualityView consumes standardized events regardless of source framework.

5. **Flywheel sample size** — How many workflows must complete before the flywheel generates statistically meaningful signal? **Recommendation:** Minimum 20 workflows per skill for trend detection (per Anthropic's eval guidance of 20-50 tasks). Flag quality metrics as "insufficient data" below this threshold.

6. **Model comparison fairness** — When comparing code quality across models (Opus vs. Sonnet), tasks are not randomly assigned — complex tasks go to Opus. How do we control for this? **Recommendation:** Compare within task complexity tiers, not across them. Use the plan's `complexity` field as a stratification variable.
