# Verification Flywheel Closure

Close the verification flywheel loop: calibrate LLM judges against a human gold standard, automate trace capture into eval datasets, wire stub quality signals, and build the feedback mechanism that turns quality data into actionable prompt refinement.

## Problem Statement

The eval infrastructure is structurally complete — harness, graders, views, CI gates, correlation modules — but the flywheel doesn't turn. Three specific gaps prevent it:

1. **Uncalibrated LLM judges.** The `llm-rubric` and `llm-similarity` graders produce scores, but we have no human baseline measuring their accuracy. Without TPR/TNR data, we can't distinguish true quality regressions from judge noise. Acting on uncalibrated signals risks prompt changes that degrade rather than improve output quality.

2. **Static eval datasets.** 98 hand-crafted cases across 7 suites. The `eval-capture` CLI and `trace-capture.ts` pipeline exist but aren't wired into workflow execution. Real-world traces — the most valuable eval signal — never reach the datasets. The suites test synthetic patterns, not production behavior.

3. **Data-starved quality views.** `CodeQualityView` has three stub fields that are always zero: `selfCorrectionRate`, `topFailureCategories`, `avgRemediationAttempts`. The `quality.hint.generated` system references these stubs. The hints are structurally correct but produce misleading recommendations from empty data.

### Relationship to Existing Work

| Document | Phase | Status | This Design Extends |
|----------|-------|--------|---------------------|
| [SDLC Eval Framework](2026-02-13-sdlc-eval-framework.md) | Phases 1-3 | Complete | Phase 4 (Flywheel) |
| [Eval Framework Phase 2](2026-02-20-eval-framework-phase-2.md) | Single phase | Complete | LLM grader calibration |
| [Autonomous Code Verification](2026-02-15-autonomous-code-verification.md) | Phases 1-3 | Complete | Phase 4 (Flywheel Integration) |
| [Hardening/Validation/Eval Closure](2026-02-22-hardening-validation-eval-closure.md) | Streams 1-3 | Complete | Quality signal wiring |

This design implements Phase 4 from both the Eval Framework and Autonomous Code Verification designs. All predecessor phases are complete.

## Chosen Approach

Three parallel tracks converging at a single integration point:

```
Track 1: Judge Calibration        Track 2: Capture Pipeline      Track 3: Signal Wiring
──────────────────────────        ─────────────────────────      ──────────────────────
Human gold standard dataset       Opt-in PostToolUse hook        Wire selfCorrectionRate
Train/validation/test split       Auto-triage by layer           Wire topFailureCategories
Rubric refinement loop            Dataset growth automation      Wire avgRemediationAttempts
TPR/TNR measurement                                              Enrich gate.executed events
Calibration report                                               New: remediation.* events
         │                                 │                              │
         └─────────────┬───────────────────┘                              │
                       │                                                  │
                  Integration: Close the Loop                             │
                  ──────────────────────────                              │
                  Calibrated correlation analysis                         │
                  Regression eval auto-generation ←───────────────────────┘
                  Attribution: prompt version × quality
                  Prompt refinement signal emission
```

### Why Three Tracks

- **Zero code dependencies between tracks** until integration. Track 1 produces data artifacts (gold standard JSONL + calibration report). Track 2 produces infrastructure (hook + CLI changes). Track 3 produces code changes (view handlers + event schemas). All three are independently testable.
- **Critical path is Track 1** — human grading takes wall-clock time. Starting Tracks 2-3 in parallel means data pipeline and quality signals are ready when calibration completes.
- **Integration is well-bounded** — it consumes outputs from all three tracks but the interface contract is clear: calibrated judges + real datasets + enriched views → feedback loop.

## Technical Design

### Track 1: LLM Judge Calibration

#### 1.1 Gold Standard Dataset

Create a human-graded reference dataset of 20 cases per graded skill (5 skills use LLM graders: brainstorming, debug, delegation, implementation-planning, refactor). Total: 100 human-graded cases.

**Case selection criteria:**
- 10 cases per skill from existing capability eval datasets (known good/bad distribution)
- 10 cases per skill from real workflow traces (captured via Track 2, or manually from recent workflow executions if Track 2 isn't ready yet)
- Balance: ~60% positive (should pass), ~40% negative (should fail) — avoids accuracy inflation from skewed distributions

**Human grading format:**

```typescript
interface HumanGradedCase {
  caseId: string;
  skill: string;
  rubricName: string;          // which llm-rubric assertion this grades
  humanVerdict: boolean;       // human pass/fail judgment
  humanScore: number;          // 0-1 human confidence
  humanRationale: string;      // why this verdict (used for rubric refinement)
  graderOutput?: GradeResult;  // LLM judge output for comparison
}
```

**Storage:** `evals/calibration/gold-standard.jsonl` — one entry per case, versioned alongside eval suites.

#### 1.2 Train/Validation/Test Split

Following the calibration methodology from the [Eval Framework design](2026-02-13-sdlc-eval-framework.md):

| Split | Size | Purpose |
|-------|------|---------|
| **Train** (20%) | 4 cases/skill | Few-shot examples embedded in rubric prompts |
| **Validation** (40%) | 8 cases/skill | Tune rubric language to maximize judge alignment |
| **Test** (40%) | 8 cases/skill | Final TPR/TNR report — never used for tuning |

Split assignment is deterministic: hash `caseId` mod 5. Cases 0 → train, 1-2 → validation, 3-4 → test. This ensures reproducibility and prevents data leakage.

#### 1.3 Calibration Harness

New CLI command: `calibrate` (alongside existing `eval-run`, `eval-capture`, `eval-compare`).

```typescript
// servers/exarchos-mcp/src/cli-commands/eval-calibrate.ts

interface CalibrateInput {
  goldStandardPath: string;     // path to gold-standard.jsonl
  split: 'validation' | 'test'; // which split to evaluate
  skill?: string;                // filter to one skill
}

interface CalibrationReport {
  skill: string;
  rubricName: string;
  split: 'validation' | 'test';
  totalCases: number;
  truePositives: number;        // judge passed, human passed
  trueNegatives: number;        // judge failed, human failed
  falsePositives: number;       // judge passed, human failed
  falseNegatives: number;       // judge failed, human passed
  tpr: number;                  // sensitivity: TP / (TP + FN)
  tnr: number;                  // specificity: TN / (TN + FP)
  accuracy: number;             // (TP + TN) / total
  f1: number;                   // 2 * (precision * recall) / (precision + recall)
  disagreements: Array<{
    caseId: string;
    humanVerdict: boolean;
    judgeVerdict: boolean;
    humanRationale: string;
    judgeReason: string;
  }>;
}
```

**Workflow:**
1. Load gold standard → filter by split
2. For each case, run the corresponding `llm-rubric` grader with the current rubric
3. Compare judge verdict vs. human verdict
4. Compute confusion matrix metrics
5. Output disagreements for rubric refinement

**Acceptance thresholds:**
- TPR >= 0.85 (catches 85%+ of true quality issues)
- TNR >= 0.80 (80%+ specificity — acceptable false positive rate)
- If thresholds not met: refine rubric using validation-split disagreements, re-run

#### 1.4 Rubric Refinement Protocol

When calibration reveals disagreements:

1. Examine the `disagreements` array from the validation split
2. Categorize failure modes:
   - **False positives** (judge too strict): Add clarifying examples of acceptable output to rubric
   - **False negatives** (judge too lenient): Add specific failure patterns the judge should catch
3. Embed train-split examples as few-shot demonstrations in the rubric text
4. Re-run calibration against validation split
5. Repeat until TPR/TNR thresholds met
6. Final measurement on test split (one-shot — no further tuning)

**Rubric storage:** Rubrics live in `suite.json` assertion configs. Refined rubrics replace existing `config.rubric` strings. Version tracked via `suite.json` metadata version field.

#### 1.5 Calibration Event

Emit calibration results to the event store for trend tracking:

```typescript
interface JudgeCalibratedData {
  skill: string;
  rubricName: string;
  split: 'validation' | 'test';
  tpr: number;
  tnr: number;
  accuracy: number;
  f1: number;
  goldStandardVersion: string;  // git SHA of gold-standard.jsonl
  rubricVersion: string;        // suite.json metadata.version
}
```

Event type: `eval.judge.calibrated` (new). Consumed by `EvalResultsView` to track judge reliability over time.

---

### Track 2: Automated Trace Capture Pipeline

#### 2.1 Opt-In Capture Hook

A `PostToolUse` hook on Exarchos MCP tools that records tool call traces when enabled. **Opt-in** via environment variable — not active by default to avoid noise in normal development.

**Activation:**

```bash
# In ~/.claude.json or shell environment
EXARCHOS_EVAL_CAPTURE=1          # enable trace capture
EXARCHOS_EVAL_CAPTURE_DIR=evals/captured  # output directory (default)
```

**Hook behavior:**
- On each `tool.completed` event, append a trace entry to a session-scoped JSONL file
- File path: `${EVAL_CAPTURE_DIR}/${featureId}-${sessionId}.trace.jsonl`
- Captures: tool name, action, input summary (truncated to 2KB), output summary (truncated to 2KB), duration, timestamp, skill context (from workflow state phase)
- Zero performance impact when disabled (env var check is first operation)

**Implementation:** Extend `withTelemetry` middleware in `servers/exarchos-mcp/src/telemetry/middleware.ts` to conditionally write trace entries. This avoids a separate hook registration — telemetry already wraps all tool handlers.

#### 2.2 Auto-Triage

After a workflow completes (on `workflow.cleanup` or `workflow.cancel` event), if capture is enabled, automatically convert the session trace into eval candidates:

```typescript
// servers/exarchos-mcp/src/evals/auto-triage.ts

interface TriageResult {
  regressionCandidates: EvalCase[];  // high-confidence: completed workflows
  capabilityCandidates: EvalCase[];  // needs review: complex or novel patterns
  discarded: number;                  // trivial/duplicate traces
}

function triageTrace(
  traceEvents: WorkflowEvent[],
  existingDatasets: Map<string, EvalCase[]>,
  options: { skill?: string; deduplicationThreshold?: number }
): TriageResult;
```

**Triage rules:**
1. **Regression candidates** — workflow completed successfully, all gates passed, trace covers a known skill. These are high-confidence "known good" traces safe to add to regression suites.
2. **Capability candidates** — workflow completed but with self-corrections, retries, or novel tool patterns not seen in existing datasets. These need human review before adding.
3. **Discarded** — duplicate of existing case (fuzzy match on input structure within `deduplicationThreshold`, default 0.9 similarity), trivially short traces (< 3 events), or incomplete workflows.

**Output:** Triage results written to `evals/captured/triage/` as separate JSONL files per category. Developer reviews and promotes candidates into suite datasets via the existing `eval-capture` CLI.

#### 2.3 Dataset Growth CLI Extension

Extend `eval-capture` with a `--promote` flag:

```bash
# Review captured candidates
cat evals/captured/triage/regression-candidates.jsonl

# Promote selected cases into a suite's regression dataset
echo '{"promote": "evals/captured/triage/regression-candidates.jsonl", "suite": "delegation", "dataset": "regression", "ids": ["trace-42-43", "trace-88-89"]}' | node dist/cli.js eval-capture
```

This appends selected cases to the target dataset JSONL, assigns the correct `layer` tag, and increments the suite's `metadata.version`.

#### 2.4 Dataset Growth Targets

Track dataset growth as a quality metric in `EvalResultsView`:

| Suite | Current Cases | Target (6-month) | Growth Source |
|-------|:---:|:---:|---|
| brainstorming | 7 | 30+ | Captured ideation traces |
| debug | 7 | 30+ | Captured debug workflow traces |
| delegation | 29 | 60+ | Richest trace source (multi-task) |
| implementation-planning | 7 | 30+ | Captured planning traces |
| quality-review | 15 | 40+ | Review finding traces |
| refactor | 9 | 30+ | Captured refactor traces |
| reliability | 24 | 50+ | Stress test + compaction traces |

---

### Track 3: Quality Signal Wiring

#### 3.1 New Event Types for Remediation

Two new event types to capture self-correction behavior:

```typescript
// Emitted when an agent retries after a gate failure
interface RemediationAttemptedData {
  taskId: string;
  skill: string;
  gateName: string;
  attemptNumber: number;       // 1-indexed
  strategy: string;            // what the agent tried differently
}

// Emitted when remediation succeeds (gate passes on retry)
interface RemediationSucceededData {
  taskId: string;
  skill: string;
  gateName: string;
  totalAttempts: number;
  finalStrategy: string;
}
```

Event types: `remediation.attempted`, `remediation.succeeded` (new entries in `EventType` union and `EventDataMap`).

**Emission points:**
- `remediation.attempted` — emitted by the `/shepherd` skill when it detects a CI gate failure and initiates a fix cycle (already tracks iterations in `shepherd.iteration` events; this adds structured remediation data)
- `remediation.succeeded` — emitted when a subsequent shepherd iteration passes the previously-failed gate

#### 3.2 Wire `selfCorrectionRate`

**Definition:** Fraction of gate failures that were subsequently remediated within the same workflow.

**Data source:** `remediation.succeeded` events relative to total `gate.executed` failures.

**Implementation:** Add handler in `code-quality-view.ts`:

```typescript
// In CodeQualityView.apply():
case 'remediation.succeeded': {
  const { skill, totalAttempts } = event.data as RemediationSucceededData;
  const metrics = getOrCreateSkillMetrics(state, skill);
  const totalFailures = metrics.totalExecutions - (metrics.totalExecutions * metrics.gatePassRate);
  const corrections = (metrics.selfCorrectionRate * totalFailures) + 1;
  metrics.selfCorrectionRate = totalFailures > 0 ? corrections / (totalFailures + 1) : 0;
  metrics.avgRemediationAttempts = updateRunningAverage(
    metrics.avgRemediationAttempts, totalAttempts, corrections
  );
  break;
}
```

#### 3.3 Wire `topFailureCategories`

**Definition:** Most common gate failure reasons per skill, ranked by frequency.

**Data source:** Already available — `gate.executed` events include `details.reason` when `passed: false`. The handler in `code-quality-view.ts` updates `GateMetrics.failureReasons` but never propagates to `SkillQualityMetrics.topFailureCategories`.

**Implementation:** After updating `GateMetrics` in the `gate.executed` handler, aggregate failure reasons across all gates for the skill:

```typescript
// In the existing gate.executed handler, after updating GateMetrics:
if (!passed && skill) {
  const skillMetrics = getOrCreateSkillMetrics(state, skill);
  const category = reason || gateName; // fall back to gate name if no reason
  const existing = skillMetrics.topFailureCategories.find(c => c.category === category);
  if (existing) {
    existing.count++;
  } else {
    skillMetrics.topFailureCategories.push({ category, count: 1 });
  }
  // Keep sorted, top 10
  skillMetrics.topFailureCategories.sort((a, b) => b.count - a.count);
  if (skillMetrics.topFailureCategories.length > 10) {
    skillMetrics.topFailureCategories.length = 10;
  }
}
```

#### 3.4 Wire `avgRemediationAttempts`

**Definition:** Average number of remediation attempts before a gate passes, per skill.

**Data source:** `remediation.succeeded` events contain `totalAttempts`.

**Implementation:** Running average updated in the `remediation.succeeded` handler (see 3.2 above — computed alongside `selfCorrectionRate`).

#### 3.5 Enrich `gate.executed` Events

Current `gate.executed` events have inconsistent `details` structure. Standardize to always include:

```typescript
interface GateExecutedDetails {
  skill?: string;       // which skill's output was gated
  model?: string;       // which model produced the output
  commit?: string;      // git SHA of the gated code
  reason?: string;      // failure reason (when passed: false)
  category?: string;    // failure category for topFailureCategories
  taskId?: string;      // which task triggered the gate
  attemptNumber?: number; // remediation attempt (1 = first try)
}
```

This is a backwards-compatible enrichment — existing events without these fields continue to work. The view handlers use optional chaining.

---

### Integration: Closing the Loop

After all three tracks deliver, the integration phase connects them into a self-reinforcing cycle.

#### 4.1 Calibrated Quality Correlation

Extend `quality-correlation.ts` to include judge calibration data:

```typescript
interface CalibratedSkillCorrelation extends SkillCorrelation {
  readonly judgeTPR: number;           // from eval.judge.calibrated
  readonly judgeTNR: number;           // from eval.judge.calibrated
  readonly judgeCalibrated: boolean;   // true if calibration exists
  readonly signalConfidence: 'high' | 'medium' | 'low';  // derived
}
```

**Signal confidence derivation:**
- `high` — judge calibrated (TPR >= 0.85, TNR >= 0.80) AND 10+ eval runs AND 20+ gate executions
- `medium` — judge calibrated but insufficient data volume
- `low` — judge not calibrated or calibration below thresholds

**Impact:** Quality hints and regression signals include confidence levels. Low-confidence signals are flagged as advisory; high-confidence signals are actionable.

#### 4.2 Regression Eval Auto-Generation

When CodeQualityView detects a quality regression (3+ consecutive gate failures for a skill), automatically generate a regression eval case:

```typescript
// servers/exarchos-mcp/src/quality/regression-eval-generator.ts

interface GeneratedRegressionCase {
  source: 'auto-generated';
  trigger: QualityRegression;
  evalCase: EvalCase;
}

function generateRegressionEval(
  regression: QualityRegression,
  recentTraces: WorkflowEvent[],   // from capture pipeline
  gateDetails: GateMetrics         // failure patterns
): GeneratedRegressionCase | null;
```

**Logic:**
1. When `quality.regression` event fires, check if capture pipeline has recent traces for the regressing skill
2. If traces exist: pair the trace with the regression's failure pattern as the `expected` field, create a regression-layer eval case
3. If no traces: emit a `quality.hint.generated` event recommending manual trace capture for the skill
4. Generated cases written to `evals/{skill}/datasets/auto-regression.jsonl` (new dataset per suite, loaded alongside manual datasets)

**Guard:** Only generate if `signalConfidence` is `high` or `medium`. Never auto-generate from uncalibrated judge signals.

#### 4.3 Attribution Analysis

New MCP view action: `quality_attribution` — multi-dimensional quality slicing.

```typescript
interface AttributionQuery {
  dimension: 'skill' | 'model' | 'gate' | 'prompt-version';
  skill?: string;      // filter
  timeRange?: string;  // ISO duration (e.g., 'P7D' for last 7 days)
}

interface AttributionResult {
  dimension: string;
  entries: Array<{
    key: string;                    // skill name, model name, gate name, or prompt version
    gatePassRate: number;
    evalScore: number;
    selfCorrectionRate: number;
    regressionCount: number;
    trend: 'improving' | 'stable' | 'degrading';
    sampleSize: number;            // total observations
  }>;
  correlations: Array<{
    factor1: string;
    factor2: string;
    direction: 'positive' | 'negative' | 'none';
    strength: number;              // 0-1
  }>;
}
```

**Prompt version tracking:** Add `promptVersion` field to `gate.executed` details. Populated from the skill's `suite.json` `metadata.version`. This enables attribution analysis across prompt changes: "Did delegation v2.3 rubric change improve or degrade gate pass rates?"

#### 4.4 Prompt Refinement Signal

The final piece — turning quality data into actionable prompt improvement guidance.

New event type: `quality.refinement.suggested`

```typescript
interface RefinementSuggestedData {
  skill: string;
  signalConfidence: 'high' | 'medium';
  trigger: 'regression' | 'trend-degradation' | 'attribution-outlier';
  evidence: {
    gatePassRate: number;
    evalScore: number;
    topFailureCategories: Array<{ category: string; count: number }>;
    selfCorrectionRate: number;
    recentRegressions: number;
  };
  suggestedAction: string;         // human-readable recommendation
  affectedPromptPaths: string[];   // skill file paths to review
}
```

**Emission triggers:**
1. **Regression detected** (3+ consecutive failures) with `high` signal confidence → suggest investigating the skill's prompt for the failing gate's category
2. **Trend degradation** (eval score trend `degrading` for 3+ runs) → suggest reviewing recent prompt changes via git log
3. **Attribution outlier** (one model significantly worse than others for same skill) → suggest model-specific prompt tuning or model change

**Consumption:** `quality.refinement.suggested` events surface through:
- `quality.hint.generated` hints (existing system, enriched with refinement data)
- `exarchos_view(action: 'quality_correlation')` response (includes pending refinement suggestions)
- Layer 1 notification piggyback (if notification infrastructure is active)

This is deliberately **advisory, not automated**. The developer decides whether to act on the suggestion. The flywheel's value is in surfacing the right signal at the right time — not in autonomously rewriting prompts.

---

## Integration Points

### With Existing Eval Framework
- Track 1 extends the grader system with calibration metadata
- Track 2 extends `eval-capture` CLI with `--promote` and auto-triage
- New `eval-calibrate` CLI command follows existing CLI patterns (`eval-run`, `eval-compare`)

### With CodeQualityView / EvalResultsView
- Track 3 wires stub fields via new event handlers
- Integration adds `eval.judge.calibrated` to EvalResultsView
- Attribution analysis reads both views

### With Workflow State / HSM
- Trace capture hooks into tool completion events (telemetry middleware)
- Auto-triage triggers on workflow completion events
- No HSM changes required

### With CI Pipeline
- Calibration report can run as a CI job (periodic, not per-PR)
- Auto-generated regression cases are picked up by existing `eval-gate.yml`
- No CI workflow changes required for Tracks 1-3

---

## Testing Strategy

### Track 1: Judge Calibration
- **Unit tests:** Calibration harness confusion matrix computation, split assignment determinism
- **Integration test:** End-to-end calibrate command with mock gold standard + mock LLM grader
- **Property test:** Split assignment is deterministic and balanced (fast-check)

### Track 2: Capture Pipeline
- **Unit tests:** Triage rules (regression/capability/discard classification), deduplication logic, promote command
- **Integration test:** Full capture → triage → promote cycle with mock event store
- **Property test:** Triage never loses events (all input events appear in exactly one output category)

### Track 3: Signal Wiring
- **Unit tests:** `selfCorrectionRate` computation from remediation events, `topFailureCategories` aggregation, `avgRemediationAttempts` running average
- **Integration test:** CodeQualityView state after sequence of `gate.executed` + `remediation.*` events
- **Property test:** Quality metrics are monotonically consistent (more successes never decrease pass rate)

### Integration
- **Unit tests:** `CalibratedSkillCorrelation` derivation, regression eval generation, attribution computation
- **Integration test:** Full loop: emit events → materialize views → correlate → generate regression eval → run eval
- **Smoke test:** Manual end-to-end with real workflow traces and calibrated judges

---

## Task Breakdown

### Track 1: Judge Calibration (7 tasks)

| # | Task | Dependencies | Parallelizable |
|---|------|-------------|----------------|
| 1.1 | Create `HumanGradedCase` schema + gold standard JSONL structure | None | Yes |
| 1.2 | Build `eval-calibrate` CLI command with confusion matrix | 1.1 | Yes (after schema) |
| 1.3 | Curate 100 gold standard cases (20/skill × 5 skills) | 1.1 | Yes |
| 1.4 | Run calibration on validation split, refine rubrics | 1.2, 1.3 | No (sequential) |
| 1.5 | Final calibration on test split, produce report | 1.4 | No |
| 1.6 | Add `eval.judge.calibrated` event type + EvalResultsView handler | 1.1 | Yes |
| 1.7 | Emit calibration events from `eval-calibrate` CLI | 1.2, 1.6 | No |

### Track 2: Capture Pipeline (6 tasks)

| # | Task | Dependencies | Parallelizable |
|---|------|-------------|----------------|
| 2.1 | Add `EXARCHOS_EVAL_CAPTURE` env var + trace writer to telemetry middleware | None | Yes |
| 2.2 | Implement `triageTrace()` with regression/capability/discard rules | None | Yes |
| 2.3 | Wire auto-triage on `workflow.cleanup` / `workflow.cancel` events | 2.1, 2.2 | No |
| 2.4 | Add `--promote` flag to `eval-capture` CLI | None | Yes |
| 2.5 | Deduplication logic (fuzzy input matching against existing datasets) | 2.2 | Yes |
| 2.6 | Unit + property tests for triage rules and deduplication | 2.2, 2.5 | No |

### Track 3: Signal Wiring (6 tasks)

| # | Task | Dependencies | Parallelizable |
|---|------|-------------|----------------|
| 3.1 | Add `remediation.attempted` + `remediation.succeeded` event schemas | None | Yes |
| 3.2 | Wire `selfCorrectionRate` + `avgRemediationAttempts` in CodeQualityView | 3.1 | No |
| 3.3 | Wire `topFailureCategories` from `gate.executed` failure reasons | None | Yes |
| 3.4 | Standardize `GateExecutedDetails` structure (backwards-compatible) | None | Yes |
| 3.5 | Add `promptVersion` field to gate events from suite metadata | 3.4 | No |
| 3.6 | Unit + property tests for all three wired metrics | 3.2, 3.3 | No |

### Integration: Close the Loop (6 tasks)

| # | Task | Dependencies | Parallelizable |
|---|------|-------------|----------------|
| 4.1 | Extend `quality-correlation.ts` with `CalibratedSkillCorrelation` | T1.6 | Yes |
| 4.2 | Implement `regression-eval-generator.ts` | T2.2, T3.2 | Yes |
| 4.3 | Implement `quality_attribution` view action | T3.3, T3.5 | Yes |
| 4.4 | Implement `quality.refinement.suggested` event + emission logic | 4.1, 4.2, 4.3 | No |
| 4.5 | Enrich `quality.hint.generated` with calibration confidence + refinement data | 4.1, 4.4 | No |
| 4.6 | Integration tests: full loop end-to-end | 4.4, 4.5 | No |

**Total: 25 tasks. 15 parallelizable across tracks.**

---

## Open Questions with Recommendations

| Question | Options | Recommendation |
|----------|---------|----------------|
| **Gold standard maintenance** — How often should the gold standard be re-graded? | Per-release, quarterly, on rubric change | **On rubric change** — re-calibrate validation split whenever a rubric is modified. Quarterly full re-grade of test split for drift detection. |
| **Capture retention** — How long to keep raw trace files? | 7 days, 30 days, indefinitely | **30 days** — sufficient for triage review cycles. Promoted cases persist in suite datasets indefinitely. |
| **Auto-regression guard** — Should auto-generated regression cases be reviewed before becoming blocking? | Auto-block immediately, require human approval, advisory-first | **Advisory for 2 runs, then blocking** — new auto-generated cases run as capability (advisory) for their first 2 eval runs. If they pass consistently, auto-promote to regression layer. If they fail, flag for human review. |
| **Deduplication threshold** — What similarity score constitutes a duplicate? | 0.8, 0.9, 0.95 | **0.9** — conservative enough to avoid near-duplicates, permissive enough to capture meaningfully different traces. Uses structural comparison on `input` fields, not semantic similarity. |
| **Calibration CI frequency** — Should calibration run in CI? | Per-PR, weekly, manual only | **Weekly scheduled + on-demand** — calibration requires LLM API calls and human-graded data. Too expensive for per-PR. Weekly catches drift; manual for post-rubric-change validation. |
| **Prompt version tracking granularity** — What constitutes a "version"? | Git SHA, suite metadata version, manual tag | **Suite metadata version** — already exists in `suite.json`. Increment on any rubric or assertion change. Lightweight, explicit, no git coupling. |
