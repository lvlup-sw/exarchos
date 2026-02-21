# Design: SDLC Eval Framework Phase 2 — Promptfoo Integration, Events, and CI Gate

## Problem Statement

The eval framework Phase 1 (merged today: #621–#625) provides a working harness with 4 code-based graders, a CLI reporter, and 35 eval cases across 2 skills. But the framework is isolated — it runs locally, reports to the terminal, and produces no persistent data. Three gaps prevent it from being useful end-to-end:

1. **No LLM grading** — Code-based graders (exact-match, schema, tool-call, trace-pattern) can only verify deterministic properties. Subjective quality assessment — "does this design doc adequately cover the requirements?", "is this task decomposition comprehensive?" — requires LLM-as-judge graders. The design doc specifies Promptfoo's assertion library for this.

2. **No event emission or materialized views** — Eval results don't enter the event stream, so there's no trend tracking, no regression detection over time, and no way for the orchestrator to query historical eval data via MCP tools. The CodeQualityView (implemented) tracks gate results but has no eval counterpart.

3. **No CI integration** — There's no GitHub Actions workflow to run evals on PRs that modify the content layer. Prompt regressions can ship without detection.

### Relationship to Existing Work

| Component | Status | This Design |
|---|---|---|
| Eval harness + 4 code graders (#621–#625) | Complete | Extends with Promptfoo LLM graders |
| CodeQualityView (#345) | Complete | Parallel pattern for EvalResultsView |
| MCP hardening (#408) | Complete | Event store ready for new event types |
| Verification infrastructure (#339) | Complete | testingStrategy, PBT, benchmarks all done |
| Verification flywheel (#346) | Blocked on this | Unblocked by eval events + EvalResultsView |

---

## Chosen Approach

**Incrementally extend the existing eval harness with Promptfoo LLM graders, eval event emission, an EvalResultsView CQRS projection, and a CI regression gate.** This is the minimal e2e slice that makes the eval framework operationally useful and unblocks the verification flywheel.

Promptfoo is used as a devDependency for its battle-tested assertion evaluation engine (`matchesLlmRubric`, `matchesSimilarity`, `matchesFactuality`). It is not shipped to consumers — it's only loaded during eval runs.

---

## Technical Design

### 1. Promptfoo LLM Graders

Install `promptfoo` as a devDependency in the MCP server package. Create two new grader implementations that wrap Promptfoo's assertion functions and conform to the existing `IGrader` interface.

**Location:** `servers/exarchos-mcp/src/evals/graders/`

#### 1a. LLM Rubric Grader (`llm-rubric.ts`)

Wraps Promptfoo's `matchesLlmRubric` for open-ended quality assessment against a rubric.

```typescript
import { assertions } from 'promptfoo';
const { matchesLlmRubric } = assertions;

export class LlmRubricGrader implements IGrader {
  readonly name = 'llm-rubric';
  readonly type = 'llm-rubric';

  async grade(
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    expected: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<GradeResult> {
    const rubric = config?.rubric as string;
    const model = config?.model as string | undefined;

    // Extract the text to grade from the output
    const outputText = extractOutputText(output, config?.outputPath as string | undefined);

    const result = await matchesLlmRubric(outputText, rubric, {
      provider: model ? `anthropic:messages:${model}` : undefined,
    });

    return {
      passed: result.pass,
      score: result.score ?? (result.pass ? 1.0 : 0.0),
      reason: result.reason ?? (result.pass ? 'Passed rubric' : 'Failed rubric'),
      details: { model, rubric },
    };
  }
}
```

**Suite config usage:**

```json
{
  "type": "llm-rubric",
  "name": "design-coverage",
  "threshold": 0.8,
  "config": {
    "rubric": "Evaluate whether the task decomposition covers all sections of the design document. Score 1 if all design sections have corresponding tasks. Score 0 if major sections are missing.",
    "model": "claude-sonnet-4-5-20250929",
    "outputPath": "tasks"
  }
}
```

#### 1b. Similarity Grader (`llm-similarity.ts`)

Wraps Promptfoo's `matchesSimilarity` for semantic similarity comparison.

```typescript
import { assertions } from 'promptfoo';
const { matchesSimilarity } = assertions;

export class LlmSimilarityGrader implements IGrader {
  readonly name = 'llm-similarity';
  readonly type = 'llm-similarity';

  async grade(
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    expected: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<GradeResult> {
    const outputText = extractOutputText(output, config?.outputPath as string | undefined);
    const expectedText = config?.expected as string ?? JSON.stringify(expected);
    const threshold = config?.threshold as number ?? 0.8;

    const result = await matchesSimilarity(outputText, expectedText, threshold);

    return {
      passed: result.pass,
      score: result.score ?? (result.pass ? 1.0 : 0.0),
      reason: result.reason ?? 'Similarity check',
    };
  }
}
```

#### 1c. Registration

Both graders register in the existing `GraderRegistry` via `createDefaultRegistry()`:

```typescript
registry.register('llm-rubric', new LlmRubricGrader());
registry.register('llm-similarity', new LlmSimilarityGrader());
```

The `AssertionConfigSchema` type enum extends to include the new types:

```typescript
export const AssertionConfigSchema = z.object({
  type: z.enum([
    'exact-match', 'schema', 'tool-call', 'trace-pattern',
    'llm-rubric', 'llm-similarity',
  ]),
  // ... rest unchanged
});
```

#### 1d. Anthropic API Key

Promptfoo uses the `ANTHROPIC_API_KEY` environment variable for Claude models. This is already present in the CI environment (used by Claude Code) and in local development. No additional configuration needed.

### 2. Eval Event Schema

Add 3 event types to the event store for eval lifecycle tracking.

**Location:** `servers/exarchos-mcp/src/event-store/schemas.ts`

#### New Event Types

```typescript
// Add to EventTypes array:
'eval.run.started',
'eval.case.completed',
'eval.run.completed',
```

#### New Data Schemas

```typescript
export const EvalRunStartedData = z.object({
  runId: z.string().uuid(),
  suiteId: z.string(),
  layer: z.enum(['regression', 'capability', 'reliability']).optional(),
  trigger: z.enum(['ci', 'local', 'scheduled']),
  caseCount: z.number().int().nonnegative(),
});

export const EvalCaseCompletedData = z.object({
  runId: z.string().uuid(),
  caseId: z.string(),
  suiteId: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  assertions: z.array(z.object({
    name: z.string(),
    type: z.string(),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    reason: z.string(),
  })),
  duration: z.number().int().nonnegative(),
});

export const EvalRunCompletedData = z.object({
  runId: z.string().uuid(),
  suiteId: z.string(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  avgScore: z.number().min(0).max(1),
  duration: z.number().int().nonnegative(),
  regressions: z.array(z.string()),
});
```

#### Harness Integration

The existing `runSuite()` function in `harness.ts` gains an optional `EventStore` parameter. When provided, it emits events during execution:

```typescript
export async function runSuite(
  suite: EvalSuiteConfig,
  _evalsDir: string,
  suiteDir: string,
  graderRegistry: GraderRegistry,
  options?: {
    eventStore?: EventStore;
    streamId?: string;
    trigger?: 'ci' | 'local' | 'scheduled';
  },
): Promise<RunSummary> {
  const runId = crypto.randomUUID();

  // Emit eval.run.started
  if (options?.eventStore && options?.streamId) {
    await options.eventStore.append(options.streamId, {
      type: 'eval.run.started',
      data: { runId, suiteId: suite.metadata.skill, trigger: options.trigger ?? 'local', caseCount: /* total cases */ },
    });
  }

  // ... existing grading loop, with eval.case.completed emitted per case ...

  // Emit eval.run.completed
  if (options?.eventStore && options?.streamId) {
    await options.eventStore.append(options.streamId, {
      type: 'eval.run.completed',
      data: { runId, suiteId: suite.metadata.skill, total, passed, failed, avgScore, duration, regressions: [] },
    });
  }

  return summary;
}
```

The harness remains fully functional without an event store — the parameter is optional, maintaining backward compatibility with the existing `eval-run` CLI command which can opt into event emission.

### 3. EvalResultsView CQRS Projection

A materialized view projecting eval events into queryable per-skill scores, trends, and regression tracking. Follows the exact pattern of `CodeQualityView`.

**Location:** `servers/exarchos-mcp/src/views/eval-results-view.ts`

#### View State

```typescript
export const EVAL_RESULTS_VIEW = 'eval-results';

export interface SkillEvalMetrics {
  readonly skill: string;
  readonly latestScore: number;
  readonly trend: 'improving' | 'stable' | 'degrading';
  readonly lastRunId: string;
  readonly lastRunTimestamp: string;
  readonly totalRuns: number;
  readonly regressionCount: number;
  readonly capabilityPassRate: number;
}

export interface EvalRunRecord {
  readonly runId: string;
  readonly suiteId: string;
  readonly trigger: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly avgScore: number;
  readonly duration: number;
  readonly timestamp: string;
}

export interface EvalRegression {
  readonly caseId: string;
  readonly suiteId: string;
  readonly firstFailedRunId: string;
  readonly consecutiveFailures: number;
}

export interface EvalResultsViewState {
  readonly skills: Record<string, SkillEvalMetrics>;
  readonly runs: ReadonlyArray<EvalRunRecord>;
  readonly regressions: ReadonlyArray<EvalRegression>;
}
```

#### Projection

```typescript
export const evalResultsProjection: ViewProjection<EvalResultsViewState> = {
  init: () => ({ skills: {}, runs: [], regressions: [] }),

  apply: (view, event) => {
    switch (event.type) {
      case 'eval.run.completed':
        return handleEvalRunCompleted(view, event);
      case 'eval.case.completed':
        return handleEvalCaseCompleted(view, event);
      default:
        return view;
    }
  },
};
```

**`handleEvalRunCompleted`:** Updates `skills[suiteId]` with latest score, recalculates trend from last 3+ runs, appends to `runs` array.

**`handleEvalCaseCompleted`:** Tracks per-case pass/fail history for regression detection. When a case that previously passed starts failing, increments `regressions` entry.

#### Registration

Register in `createMaterializer()` alongside the existing views:

```typescript
materializer.register(EVAL_RESULTS_VIEW, evalResultsProjection);
```

### 4. `eval_results` View Action

Add routing in the `exarchos_view` composite tool to query eval results.

**Location:** `servers/exarchos-mcp/src/views/composite.ts`

```typescript
case 'eval_results':
  return handleViewEvalResults(
    rest as {
      workflowId?: string;
      skill?: string;
      limit?: number;
    },
    stateDir,
  );
```

The handler follows the same pattern as `handleViewCodeQuality`: reads events from the store, materializes the EvalResultsView, and returns filtered results.

Add `'eval_results'` to the `validTargets` array in the default case.

### 5. CI Eval Gate

#### 5a. CI Reporter (`ci-reporter.ts`)

**Location:** `servers/exarchos-mcp/src/evals/reporters/ci-reporter.ts`

Outputs GitHub Actions annotations for eval results:

```typescript
export function formatCIReport(summaries: RunSummary[]): string {
  const lines: string[] = [];

  for (const summary of summaries) {
    for (const result of summary.results) {
      if (!result.passed) {
        // GitHub Actions error annotation format
        lines.push(`::error title=Eval Regression: ${result.caseId}::${formatFailedAssertions(result)}`);
      }
    }

    // Summary annotation
    lines.push(`::notice title=Eval: ${summary.suiteId}::${summary.passed}/${summary.total} passed (${(summary.avgScore * 100).toFixed(1)}%)`);
  }

  return lines.join('\n');
}
```

**Exit code logic:**
- Exit 0: All regression eval cases pass
- Exit 1: Any regression eval case fails (blocks merge)
- Capability eval failures are reported as annotations but don't affect exit code

#### 5b. CLI Integration

Extend the existing `eval-run` CLI command with `--ci` flag:

```typescript
// In cli-commands/eval-run.ts
if (args.includes('--ci')) {
  const ciOutput = formatCIReport(summaries);
  process.stdout.write(ciOutput);

  const hasRegressions = summaries.some(s =>
    s.results.some(r => !r.passed && isRegressionCase(r))
  );
  process.exit(hasRegressions ? 1 : 0);
}
```

#### 5c. GitHub Actions Workflow

**Location:** `.github/workflows/eval-gate.yml`

```yaml
name: Eval Gate
on:
  pull_request:
    paths:
      - 'skills/**'
      - 'commands/**'
      - 'rules/**'
      - 'servers/exarchos-mcp/src/**'
      - 'evals/**'

jobs:
  eval-regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
        working-directory: servers/exarchos-mcp
      - run: npm run build
        working-directory: servers/exarchos-mcp
      - name: Run Regression Evals
        run: node dist/cli.js eval-run --ci
        working-directory: servers/exarchos-mcp
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          EVALS_DIR: ../../../evals
```

Regression failures block merge. Capability eval results are advisory (annotations only).

---

## Integration Points

### With Existing Eval Framework (Phase 1)

| Component | Integration |
|---|---|
| `IGrader` interface | LLM graders implement same interface |
| `GraderRegistry` | New graders registered alongside existing 4 |
| `AssertionConfigSchema` | Extended with `llm-rubric`, `llm-similarity` types |
| `harness.ts` | Gains optional event emission |
| `eval-run` CLI | Gains `--ci` flag |
| Suite configs | Can now use LLM assertion types |

### With Event Store & Views

| Component | Integration |
|---|---|
| `EventTypes` | Gains 3 eval event types |
| `schemas.ts` | Gains 3 eval data schemas |
| `ViewMaterializer` | Registers `evalResultsProjection` |
| `composite.ts` | Routes `eval_results` action |
| `tools.ts` | New `handleViewEvalResults` handler |

### With Verification Flywheel (#346)

| Component | Integration |
|---|---|
| `EvalResultsView` | Cross-referenceable with `CodeQualityView` for prompt-quality correlation |
| `eval.run.completed` events | Consumable by flywheel for trend analysis |
| LLM graders | Enable capability evals for subjective quality |

---

## Testing Strategy

### Unit Tests

- **LLM Rubric Grader** — Mock Promptfoo's `matchesLlmRubric` to test grader adapter logic (pass/fail mapping, score extraction, config handling). Do not call actual LLM in unit tests.
- **LLM Similarity Grader** — Mock `matchesSimilarity` for adapter logic tests.
- **Eval event schemas** — Zod validation for all 3 new event types (valid, invalid, edge cases).
- **EvalResultsView projection** — Event sequences → expected view state. Test init, single run, multiple runs, trend calculation, regression detection.
- **CI reporter** — Known summaries → expected GitHub Actions annotation format. Test pass/fail formatting, exit code logic.

### Integration Tests

- **Harness with event emission** — Run a suite with a mock EventStore, verify correct events emitted in order.
- **View materialization** — Emit eval events to a real EventStore, materialize EvalResultsView, verify state.
- **CI reporter end-to-end** — Run `eval-run --ci` against test fixtures, verify stdout format and exit code.

### Smoke Tests (Manual)

- **Promptfoo integration** — Run a real `llm-rubric` assertion against Claude Sonnet with a known rubric to verify the adapter works end-to-end.
- **CI workflow** — Push a test branch with a modified skill to verify the eval-gate workflow triggers and reports correctly.

---

## Implementation Phases

This design is a single phase with 3 parallel streams:

```
Stream 1 (Graders):     Promptfoo install → LLM graders → Registry update → Type schema update
Stream 2 (Events+View): Eval event schemas → Harness emission → EvalResultsView → View action
Stream 3 (CI):          CI reporter → eval-run --ci flag → eval-gate.yml workflow
```

Stream 1 and Stream 2 are independent. Stream 3 depends on the `--ci` flag integration but can start the reporter in parallel.

### Task Breakdown (14 tasks)

**Stream 1: Promptfoo LLM Graders**
1. Install `promptfoo` as devDependency, verify import works
2. Implement shared `extractOutputText` helper for path-based field extraction
3. Implement `LlmRubricGrader` with Promptfoo `matchesLlmRubric` wrapper
4. Implement `LlmSimilarityGrader` with Promptfoo `matchesSimilarity` wrapper
5. Register LLM graders in `GraderRegistry`, extend `AssertionConfigSchema` type enum

**Stream 2: Eval Events + EvalResultsView**
6. Add 3 eval event types to `EventTypes` and data schemas in `schemas.ts`
7. Extend `harness.ts` `runSuite()` with optional event emission
8. Implement `EvalResultsView` projection (`eval-results-view.ts`)
9. Register projection in `createMaterializer()`, implement `handleViewEvalResults` handler
10. Add `eval_results` action routing in `composite.ts`

**Stream 3: CI Gate**
11. Implement CI reporter (`ci-reporter.ts`) with GitHub Actions annotation format
12. Add `--ci` flag to `eval-run` CLI command with exit code logic
13. Create `.github/workflows/eval-gate.yml`

**Cross-cutting**
14. Create/expand capability eval suite using `llm-rubric` assertions for at least 1 skill

---

## Open Questions

1. **Promptfoo provider string format** — Promptfoo uses provider strings like `anthropic:messages:claude-sonnet-4-5-20250929`. Verify the exact format for the models we use. If the format has changed in recent Promptfoo versions, the grader adapter needs to handle it.

2. **Eval event stream placement** — Should eval events go into the workflow stream (alongside `workflow.transition`, `gate.executed`, etc.) or a dedicated `evals` stream? **Recommendation:** Dedicated `evals` stream per suite, keeping workflow streams focused on workflow lifecycle. The EvalResultsView materializes from eval streams specifically.

3. **Regression detection baseline** — The EvalResultsView needs to know when a previously-passing case starts failing. How is "previously passing" defined? **Recommendation:** A case is considered regressed if it passed in the most recent completed run for that suite and fails in the current run. The `regressions` field in `EvalRunCompletedData` carries this.

4. **LLM grader cost in CI** — LLM rubric graders consume API tokens. Each assertion calls the judge model. For a suite with 10 cases × 1 LLM assertion each, at ~1K tokens/grading with Claude Sonnet, that's ~$0.20 per CI run. **Recommendation:** Acceptable. Cache results for identical inputs to avoid redundant calls during local development iteration.
