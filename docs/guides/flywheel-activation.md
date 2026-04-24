# Verification Flywheel — Activation Guide

How to bootstrap and operate the self-reinforcing quality feedback loop shipped in PR #914.

> **Invocation commands stale (v2.9 install-rewrite, task 3.8):** The
> `node dist/cli.js {eval-run,eval-capture,eval-calibrate,eval-compare}`
> commands referenced in this guide were removed alongside the unreachable
> `servers/exarchos-mcp/src/cli.ts` entry point. The underlying flywheel
> libraries under `servers/exarchos-mcp/src/evals/` and `src/quality/`
> remain intact; a new CLI surface has not yet been designed.

## Current State

**What's live now (passive data collection):**
- `gate.executed` events emitted by `/shepherd` during CI monitoring
- `CodeQualityView` materializes per-skill pass rates and auto-detects regressions (3+ consecutive failures)
- `EvalResultsView` tracks eval run scores and trends
- 7 eval suites with 98 hand-crafted cases across brainstorming, debug, delegation, implementation-planning, quality-review, refactor, reliability

**What's wired but dormant (needs bootstrapping):**
- Judge calibration pipeline — no gold standard data yet
- Trace capture — opt-in env var not set
- Refinement signals — suppressed at `confidence: 'low'` (no calibration data)
- Quality hints enrichment — returns `'advisory'` (uncalibrated)
- `selfCorrectionRate`, `topFailureCategories` — zero (no `remediation.*` events emitted)

## Activation Steps

### Step 1: Create Gold Standard Dataset

**Goal:** Build a human-graded baseline for measuring LLM judge accuracy.

**What:** A JSONL file where each line is a `HumanGradedCase`:

```jsonl
{"caseId":"delegation-task-decomp-01","skill":"delegation","rubricName":"task-decomposition-quality","humanVerdict":true,"humanScore":0.9,"humanRationale":"Tasks cover API, data model, tests, and integration. Minor gap: no migration task."}
{"caseId":"delegation-task-decomp-02","skill":"delegation","rubricName":"task-decomposition-quality","humanVerdict":false,"humanScore":0.3,"humanRationale":"Only covers API endpoint. Missing data model, tests, error handling, and integration tasks."}
```

**Schema (all fields required):**

| Field | Type | Description |
|-------|------|-------------|
| `caseId` | string (min 1) | Unique identifier — used for deterministic split assignment |
| `skill` | string (min 1) | Skill name (e.g., `delegation`, `debug`, `quality-review`) |
| `rubricName` | string (min 1) | Must match an assertion name in the skill's `suite.json` |
| `humanVerdict` | boolean | Your judgment: does the output meet the rubric? |
| `humanScore` | number (0–1) | How well it meets the rubric (0 = terrible, 1 = perfect) |
| `humanRationale` | string (min 1) | Why you scored it this way — used for disagreement analysis |
| `graderOutput` | object (optional) | The actual grader output to calibrate against |

**How to build it:**

1. **Pick skills to calibrate first.** Start with skills that have `llm-rubric` or `llm-similarity` assertions in their `suite.json`. Currently:
   - `delegation` — `task-decomposition-quality` (llm-rubric), `delegation-output-similarity` (llm-similarity)
   - `brainstorming` — check its `suite.json`
   - `quality-review` — check its `suite.json`

2. **Run existing eval cases and capture grader outputs.** For each skill:
   ```bash
   # Run evals and save grader outputs
   echo '{"suite":"delegation","dataset":"golden"}' | \
     node dist/cli.js eval-run
   ```
   Review the grader outputs and form your own verdict.

3. **Write 20 cases per skill.** Aim for a balanced mix:
   - ~10 cases where the output genuinely meets the rubric (`humanVerdict: true`)
   - ~10 cases where it doesn't (`humanVerdict: false`)
   - Include edge cases, not just clear-cut examples

4. **Save to** `evals/calibration/gold-standard.jsonl`

**Split assignment is automatic.** Each `caseId` is deterministically assigned via `hash(caseId) % 5`:
- Bucket 0 → `train` (20%) — reserved hold-out, not used for calibration
- Buckets 1–2 → `validation` (40%) — used for rubric tuning
- Buckets 3–4 → `test` (40%) — used for final measurement

You don't control which cases go where — just write enough cases and the hash distributes them.

**Target:** 100 cases total (20 per skill × 5 skills). Start with 2-3 skills if 5 feels too much.

### Step 2: Run Judge Calibration

**Goal:** Measure how well the LLM grader agrees with your human judgments.

```bash
# Calibrate against validation split (use for tuning)
echo '{"goldStandardPath":"evals/calibration/gold-standard.jsonl","split":"validation"}' | \
  node dist/cli.js eval-calibrate

# After rubric adjustments, measure on test split (final measurement)
echo '{"goldStandardPath":"evals/calibration/gold-standard.jsonl","split":"test"}' | \
  node dist/cli.js eval-calibrate

# Filter to a single skill
echo '{"goldStandardPath":"evals/calibration/gold-standard.jsonl","split":"validation","skill":"delegation"}' | \
  node dist/cli.js eval-calibrate
```

**Output:** A `CalibrationReport` with:
- `tpr` (true positive rate / recall) — target ≥ 0.85
- `tnr` (true negative rate / specificity) — target ≥ 0.80
- `accuracy`, `f1` — overall metrics
- `disagreements[]` — cases where judge and human disagree, with both rationales

**What to do with disagreements:**

| Judge says | You say | Action |
|------------|---------|--------|
| Pass | Fail | Judge is too lenient — tighten the rubric text in `suite.json` |
| Fail | Pass | Judge is too strict — relax the rubric or add examples |
| Both agree | — | No action needed |

**Iteration loop:**
1. Run calibration on `validation` split
2. Review disagreements
3. Adjust rubric text in `suite.json` assertions
4. Re-run calibration
5. Repeat until TPR ≥ 0.85 and TNR ≥ 0.80
6. Run final measurement on `test` split (don't tune on test!)

**Emit calibration event.** After a successful calibration run, emit an event so the flywheel tracks it:

```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  streamId: "quality",
  event: {
    type: "eval.judge.calibrated",
    data: {
      skill: "delegation",
      rubricName: "task-decomposition-quality",
      split: "validation",
      tpr: 0.90,
      tnr: 0.85,
      accuracy: 0.87,
      f1: 0.88,
      totalCases: 40,
      goldStandardVersion: "1.0.0",
      rubricVersion: "1.1.0"
    }
  }
})
```

This event triggers `EvalResultsView` to record the calibration, which `correlateWithCalibration()` reads to derive `signalConfidence`. Once calibrated, signals upgrade from `'low'` to `'medium'` or `'high'`.

### Step 3: Enable Trace Capture

**Goal:** Auto-capture real workflow execution traces into eval candidate files.

**Enable capture** by setting the environment variable before running workflows:

```bash
export EXARCHOS_EVAL_CAPTURE=1
```

Or add it to your shell profile to always capture.

**What happens:** During workflow execution, the telemetry middleware writes trace events to:
```
~/.claude/workflow-state/traces/{featureId}-{sessionId}.trace.jsonl
```

**After a workflow completes**, extract eval candidates:

```bash
# Capture traces from a workflow's event stream
echo '{"streamId":"default"}' | node dist/cli.js eval-capture

# Filter to a specific skill
echo '{"streamId":"default","skill":"delegation"}' | node dist/cli.js eval-capture
```

**Auto-triage** classifies captured traces:
- **Regression candidates** — completed workflows, all gates passed, clean execution → safe to add to regression datasets
- **Capability candidates** — completed with retries, self-corrections, or novel tool patterns → needs human review
- **Discarded** — trivially short (< 3 events), incomplete workflows, duplicates (similarity ≥ 0.9)

**Promote good candidates into eval datasets:**

```bash
echo '{
  "subcommand": "promote",
  "promotePath": "/path/to/candidates.jsonl",
  "suiteName": "delegation",
  "datasetName": "regression",
  "ids": ["trace-1-5", "trace-6-12"]
}' | node dist/cli.js eval-capture
```

This appends the selected cases to the dataset JSONL, deduplicates against existing cases, and increments the suite version.

**Growth cadence:** After every 5-10 completed workflows, review captured traces and promote 2-3 good ones. Over time this shifts your eval datasets from synthetic to production-grounded.

### Step 4: Wire Remediation Events into Shepherd

**Goal:** Activate `selfCorrectionRate` and `avgRemediationAttempts` metrics in `CodeQualityView`.

Currently, two event types are handled by the view but never emitted:
- `remediation.attempted` — when a CI fix is attempted
- `remediation.succeeded` — when a fix resolves the failure

**Where to emit:** In the `/shepherd` skill, during the Fix phase (step 3).

**When a CI failure is detected and a fix is attempted:**

```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  streamId: "<featureId>",
  event: {
    type: "remediation.attempted",
    data: {
      skill: "shepherd",
      gate: "<failing-check-name>",
      attemptNumber: 1,
      strategy: "direct-fix"
    }
  }
})
```

**When the next iteration shows the fix resolved it:**

```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  streamId: "<featureId>",
  event: {
    type: "remediation.succeeded",
    data: {
      skill: "shepherd",
      gate: "<check-name>",
      totalAttempts: 1,
      finalStrategy: "direct-fix"
    }
  }
})
```

**Implementation option:** Add these event emissions to the shepherd skill's `references/fix-strategies.md` as standard steps, so the agent emits them naturally during fix iterations. This requires editing the shepherd skill file.

### Step 5: Consume Quality Hints in Skills

**Goal:** Make quality data actionable in the workflow by having skills query and act on hints.

**Query quality hints via MCP:**

```
mcp__plugin_exarchos_exarchos__exarchos_view({
  view: "code_quality",
  workflowId: "<featureId>",
  skill: "delegation"
})
```

**Returns:** `CodeQualityViewState` with per-skill metrics, gate pass rates, regressions, and quality hints.

**Where to consume hints:**

| Skill | How to use hints |
|-------|-----------------|
| `/review` (quality-review) | Check `regressions[]` before approving. If active regressions exist for the skill under review, flag them. |
| `/delegate` | Query `skills[skill].gatePassRate` before dispatching. If a skill's pass rate is degrading, include extra validation instructions in the subagent prompt. |
| `/shepherd` | Already emits `gate.executed` events. Add: query hints at the start of each iteration to surface refinement signals in the status report. |
| `/synthesize` | Check `regressions[]` before creating PRs. Warn if the branch touches files in skills with active regressions. |

**Example integration in a skill prompt:**

```markdown
Before proceeding, check quality signals:
1. Query `exarchos_view` with `view: "code_quality"` and `skill: "<target-skill>"`
2. If `regressions` is non-empty, report active quality regressions to the user
3. If any hint has `confidenceLevel: 'actionable'`, present the `suggestedAction` to the user
4. If `gatePassRate < 0.80`, warn about degrading quality
```

## Verification: Confirming the Flywheel Turns

After completing steps 1-3, verify the full loop by checking these conditions:

```
# 1. Calibration recorded
mcp__plugin_exarchos_exarchos__exarchos_view({
  view: "eval_results"
})
→ calibrations[] should have entries with tpr ≥ 0.85

# 2. Signal confidence upgraded
→ correlateWithCalibration() should return signalConfidence: 'high' or 'medium'
   (not 'low') for calibrated skills

# 3. Hints enriched
→ generateQualityHints() should return hints with confidenceLevel: 'actionable'
   (not 'advisory') for calibrated skills

# 4. Refinement signals fire on regressions
→ If a skill has 3+ consecutive gate failures AND is calibrated,
   evaluateRefinementSignals() should produce a signal with trigger: 'regression'
```

## Confidence Thresholds (Reference)

Signal confidence is derived from calibration + data volume:

| Level | Calibrated? | TPR ≥ 0.85? | TNR ≥ 0.80? | Eval runs ≥ 10? | Gate executions ≥ 20? | Effect |
|-------|-------------|-------------|-------------|-----------------|----------------------|--------|
| `high` | Yes | Yes | Yes | Yes | Yes | Signals emitted, hints say `'actionable'` |
| `medium` | Yes | Yes | Yes | No | No | Signals emitted, hints say `'actionable'` |
| `low` | No | — | — | — | — | **Signals suppressed**, hints say `'advisory'` |

## Priority Order

| Step | Effort | Impact | Recommendation |
|------|--------|--------|----------------|
| 1. Gold standard + calibration | 2-4 hours (human grading) | Unlocks the entire signal pipeline | **Do first** |
| 2. Enable trace capture | 1 minute (env var) | Grows eval datasets from real usage | **Do second** |
| 3. Wire remediation events | 30 min (edit shepherd skill) | Activates selfCorrectionRate metric | Do third |
| 4. Consume hints in skills | 1-2 hours (edit skill prompts) | Makes quality data actionable in workflows | Do fourth |
| 5. Promote captured traces | Ongoing (5 min per batch) | Shifts evals from synthetic to production-grounded | Ongoing cadence |

## File Reference

| File | Purpose |
|------|---------|
| `evals/calibration/gold-standard.jsonl` | Human-graded baseline (you create this) |
| `evals/*/suite.json` | Suite configs with rubric assertions |
| `evals/*/datasets/*.jsonl` | Eval case datasets (98 cases across 7 suites) |
| `servers/exarchos-mcp/src/evals/trace-capture.ts` | Core trace → eval case conversion |
| `servers/exarchos-mcp/src/evals/auto-triage.ts` | Regression vs capability classification |
| `servers/exarchos-mcp/src/quality/calibrated-correlation.ts` | Calibration → signal confidence derivation |
| `servers/exarchos-mcp/src/quality/refinement-signal.ts` | Signal evaluation (3 trigger types) |
| `servers/exarchos-mcp/src/quality/hints.ts` | Quality hint generation + calibration enrichment |
| `servers/exarchos-mcp/src/views/code-quality-view.ts` | Gate pass rates, regressions, self-correction |
| `servers/exarchos-mcp/src/views/eval-results-view.ts` | Eval scores, trends, calibration records |
