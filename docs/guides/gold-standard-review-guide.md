# Gold Standard Review Guide

How to create, review, and maintain the human-graded gold standard dataset used by the verification flywheel's judge calibration pipeline.

## What Is the Gold Standard?

The gold standard (`evals/calibration/gold-standard.jsonl`) is a set of human-graded cases that measure how accurately our LLM judges score skill outputs. Each case records your verdict on whether a skill output meets its rubric, which the calibration pipeline compares against the LLM judge's verdict to compute agreement metrics (TPR, TNR, accuracy, F1).

Without gold standard data, signal confidence stays at `low`, quality hints return `advisory` only, and refinement signals are suppressed. See [Flywheel Activation Guide](flywheel-activation.md) for the full pipeline context.

## Case Schema

Each line in `gold-standard.jsonl` is a JSON object following `HumanGradedCase`:

```jsonl
{"caseId":"del-td-01","skill":"delegation","rubricName":"task-decomposition-quality","humanVerdict":true,"humanScore":0.9,"humanRationale":"Comprehensive coverage: data model, API, middleware, UI, unit tests, integration tests. Minor gap: no error handling task."}
```

| Field | Type | Description |
|-------|------|-------------|
| `caseId` | string | Unique ID — determines split assignment via `hash(caseId) % 5` |
| `skill` | string | Skill name (`delegation`, `brainstorming`, `debug`, `implementation-planning`, `refactor`) |
| `rubricName` | string | Must match an `llm-rubric` assertion name in the skill's `suite.json` |
| `humanVerdict` | boolean | Your judgment: does the output meet the rubric? |
| `humanScore` | number (0-1) | How well it meets the rubric (0 = terrible, 1 = perfect) |
| `humanRationale` | string | Why you scored it this way — used for disagreement analysis |
| `graderOutput` | object (optional) | The actual LLM grader output to calibrate against |

## The Five Rubrics

Each rubric evaluates a different quality dimension. Read the rubric text before grading.

### 1. Delegation — `task-decomposition-quality`

> Evaluate whether the delegation trace shows a comprehensive task decomposition. Score 1 if the tasks cover all major components of the design (API, data model, tests, integration). Score 0 if major components are missing from the task list. Give partial credit for partial coverage.

**What to look for:** Does the task decomposition cover all the major pieces needed to implement the feature? A good decomposition includes data model, API/core logic, tests (unit + integration), and integration/wiring. A bad one is missing entire categories.

**Score guide:**
- **1.0** — All major components present (data, logic, tests, integration)
- **0.8-0.9** — All major components, minor gap (e.g., no migration task, no monitoring)
- **0.4-0.6** — Some components present, significant gaps
- **0.0-0.2** — Only 1-2 tasks, most components missing

### 2. Brainstorming — `ideation-quality`

> Evaluate whether the ideation trace explores multiple approaches with trade-off analysis before selecting one. Score 1 if 2+ approaches are explored with pros/cons and a selection rationale. Score 0.5 if 2+ approaches are explored with pros/cons but no selection rationale is provided. Score 0 if only one approach is considered or no trade-off analysis is present.

**What to look for:** Did the brainstorming explore the solution space? The rubric has three tiers: full marks for multiple approaches + trade-offs + rationale, half marks for approaches + trade-offs without rationale, zero for single-approach or no analysis.

**Score guide:**
- **1.0** — 2+ approaches, pros/cons, clear selection rationale
- **0.5** — 2+ approaches, pros/cons, but no rationale for the final choice
- **0.0** — Single approach or no trade-off analysis

### 3. Debug — `root-cause-analysis-quality`

> Evaluate whether the debug trace demonstrates systematic root cause analysis. Score 1 if the trace shows severity triage, evidence gathering, root cause identification, and targeted fix. Score 0 if the fix is applied without investigation or root cause is guessed without evidence.

**What to look for:** Does the investigation follow a systematic methodology? The rubric expects: (1) severity assessment, (2) evidence gathering (logs, stack traces, profiling), (3) hypothesis formation and testing, (4) proven root cause before applying fix.

**Score guide:**
- **1.0** — Full investigation: severity triage, multiple evidence types, hypotheses tested, root cause proven
- **0.3-0.5** — Partial investigation: some evidence gathered, but root cause assumed not proven
- **0.0** — No investigation: jumped to fix without evidence or root cause identification

### 4. Implementation Planning — `plan-decomposition-quality`

> Evaluate whether the planning trace produces a comprehensive task decomposition with appropriate dependency ordering and testing strategy. Score 1 if tasks cover data model, core implementation, tests, and integration with correct parallel groups and dependencies. Score 0 if major components are missing or dependencies are incorrect.

**What to look for:** Two dimensions — coverage (are all components present?) AND correctness (are dependencies and parallel groups right?). A plan can have great coverage but fail on dependency ordering.

**Score guide:**
- **1.0** — Comprehensive tasks, correct dependencies, valid parallel groups
- **0.5-0.7** — Good coverage but incorrect dependencies or parallelism errors
- **0.0-0.2** — Missing major components or completely wrong dependency ordering

### 5. Refactor — `refactor-quality`

> Evaluate whether the refactor trace demonstrates scope-appropriate track selection and behavioral preservation. Score 1 if scope assessment matches track choice (polish for small changes, overhaul for structural) and the refactor preserves existing behavior. Score 0 if track is mismatched to scope or behavioral changes are introduced without justification.

**What to look for:** Two independent criteria — (1) is the track appropriate for the scope? (polish for <=5 files/single concern, overhaul for structural/cross-module) AND (2) does the refactor preserve existing behavior? Both must pass for a top score.

**Score guide:**
- **1.0** — Track matches scope AND behavior preserved
- **0.2-0.3** — Track matches but behavior changed, OR behavior preserved but track mismatched
- **0.0** — Both criteria fail

## How to Review Each Case

For each case in `gold-standard.jsonl`:

1. **Read the rubric** — Know what you're grading against (see above)
2. **Read the input** — Find the corresponding eval case in `evals/{skill}/datasets/*.jsonl` (the `caseId` prefix indicates the skill)
3. **Form your verdict** — Apply the rubric independently. Don't peek at the pre-populated score first
4. **Score it** — Use the scale above. The score should be consistent with the verdict (`true` generally means >= 0.5, `false` means < 0.5)
5. **Write rationale** — Explain your reasoning. Reference specific elements present or absent. This rationale is used for disagreement analysis when the LLM judge disagrees

### Verdict-Score Consistency

| humanVerdict | humanScore | Meaning |
|-------------|------------|---------|
| `true` | 0.5-1.0 | Meets the rubric (0.5 = barely, 1.0 = exemplary) |
| `false` | 0.0-0.49 | Does not meet the rubric (0.0 = total failure, 0.4 = close but no) |

Edge cases at the verdict boundary (scores 0.4-0.6) are particularly valuable — they stress-test the judge's ability to distinguish pass from fail.

## Statistical Considerations

### Balance

Aim for roughly equal pass/fail per skill. Heavily skewed datasets (all pass or all fail) don't test the judge's discrimination ability. Target: 40-60% pass rate per skill.

### Edge Cases

The most valuable cases are the ones near the boundary:
- **High-scoring failures** (score 0.3-0.4): Almost passes but has a critical gap
- **Low-scoring passes** (score 0.5-0.6): Barely meets the rubric
- **Partial credit**: Cases that test the rubric's intermediate scoring tiers

Include at least 1-2 edge cases per skill alongside clear pass/fail examples.

### Split Distribution

Splits are deterministic via `hash(caseId) % 5`:
- Bucket 0 → `train` (20%) — reserved hold-out
- Buckets 1-2 → `validation` (40%) — used for rubric tuning
- Buckets 3-4 → `test` (40%) — final measurement (don't tune on this!)

You can't control which cases go where. Write enough cases and the hash distributes them. Run the `eval-calibrate` CLI to see the actual split assignment.

### Sample Size

The calibration targets (TPR >= 0.85, TNR >= 0.80) need enough cases per split to be statistically meaningful:
- **Minimum:** 20 total cases (current seed dataset)
- **Good:** 50 total cases (10 per skill)
- **Target:** 100 total cases (20 per skill)

With 20 cases, a single disagreement can swing TPR/TNR by ~12 percentage points. With 100 cases, each disagreement affects ~2.5 points. More data = more stable metrics.

## Practical Workflow

### Option A: Quick Review (Pre-populated Cases)

The current `gold-standard.jsonl` has 21 pre-populated cases based on eval case descriptions. To review:

1. Open `evals/calibration/gold-standard.jsonl`
2. For each case, read the `humanRationale` and check if you agree with the `humanVerdict` and `humanScore`
3. If you disagree, update the verdict, score, and rationale
4. Pay special attention to edge cases (scores between 0.3-0.6)

### Option B: Independent Grading (Most Rigorous)

For maximum statistical validity:

1. Create a copy of the file with `humanVerdict`, `humanScore`, and `humanRationale` blanked out
2. For each case, read only the `caseId`, `skill`, and `rubricName`
3. Look up the eval case input in `evals/{skill}/datasets/*.jsonl`
4. Grade independently against the rubric
5. Compare your grades with the pre-populated ones
6. Use disagreements as learning opportunities to refine your calibration

### Option C: Growing the Dataset

After the initial review, grow the dataset by:

1. Running real workflows with `EXARCHOS_EVAL_CAPTURE=1`
2. Reviewing captured traces (`eval-capture` CLI)
3. Grading promising traces against the rubric
4. Appending new cases to `gold-standard.jsonl`
5. Re-running calibration to check metric stability

## Editing the File

Each line is independent JSON. Edit with any text editor or use `jq`:

```bash
# View all cases for a skill
cat evals/calibration/gold-standard.jsonl | jq -r 'select(.skill == "delegation")'

# Count cases by skill and verdict
cat evals/calibration/gold-standard.jsonl | jq -r '[.skill, (.humanVerdict | tostring)] | join(",")' | sort | uniq -c

# Validate all lines are valid JSON with required fields
while IFS= read -r line; do
  echo "$line" | jq -e '.caseId and .skill and .rubricName and (.humanVerdict | type == "boolean") and (.humanScore | type == "number") and .humanRationale' > /dev/null || echo "INVALID: $line"
done < evals/calibration/gold-standard.jsonl
```

After editing, run the verification script:

```bash
bash scripts/verify-flywheel-activation.sh --gold-standard evals/calibration/gold-standard.jsonl
```

## After Review: Next Steps

1. **Run calibration on validation split:**
   ```bash
   echo '{"goldStandardPath":"evals/calibration/gold-standard.jsonl","split":"validation"}' | node dist/cli.js eval-calibrate
   ```

2. **Review disagreements** — Where you and the judge disagree, adjust rubric text in `suite.json`

3. **Re-run until targets met** — TPR >= 0.85, TNR >= 0.80 on validation split

4. **Final measurement on test split** — Don't tune on test data

5. **Emit calibration event** — See [Flywheel Activation Guide](flywheel-activation.md#step-2-run-judge-calibration)

## Related

- [Flywheel Activation Guide](flywheel-activation.md) — Full pipeline activation steps
- [Flywheel Activation Design](../designs/2026-02-27-flywheel-activation.md) — Design document
- `servers/exarchos-mcp/src/evals/calibration-types.ts` — `HumanGradedCase` and `CalibrationReport` schemas
- `servers/exarchos-mcp/src/evals/calibration-split.ts` — Deterministic split assignment
