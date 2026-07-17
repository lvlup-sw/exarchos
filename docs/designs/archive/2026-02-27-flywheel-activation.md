# Flywheel Activation: Gold Standard Seed + Infrastructure Wiring

**Feature ID:** `flywheel-activation`
**Date:** 2026-02-27
**Status:** Design

---

## Problem

The verification flywheel (shipped in PR #914) is fully wired but dormant. The calibration pipeline has no gold standard data to calibrate against, so:

- Signal confidence is stuck at `'low'` — refinement signals are suppressed
- Quality hints return `'advisory'` only — not actionable for skills
- `selfCorrectionRate` and `avgRemediationAttempts` are zero — no `remediation.*` events are emitted
- The full loop (gate failures -> regression detection -> refinement signals -> skill improvement) never turns

Additionally, `verify-plan-coverage.sh` has a bug (#913) where hierarchical design sections with `####` subsections are not matched correctly — the script falls back to `###` stream headers instead of preferring the more specific subsections.

## Technical Design

Bootstrap the flywheel with a minimal viable gold standard dataset, wire the missing remediation events, fix the plan coverage bug, and provide a verification script to confirm the pipeline works end-to-end.

### Stream 1: Gold Standard Seed Dataset

Create `evals/calibration/gold-standard.jsonl` with 21 human-graded cases across all 5 skills with `llm-rubric` assertions:

- **5 cases for `delegation`** — grading against the `task-decomposition-quality` rubric
- **4 cases for `brainstorming`** — grading against the `ideation-quality` rubric
- **4 cases for `debug`** — grading against the `root-cause-analysis-quality` rubric
- **4 cases for `implementation-planning`** — grading against the `plan-decomposition-quality` rubric
- **4 cases for `refactor`** — grading against the `refactor-quality` rubric

Each case follows the `HumanGradedCase` schema:

```jsonl
{"caseId":"delegation-task-decomp-01","skill":"delegation","rubricName":"task-decomposition-quality","humanVerdict":true,"humanScore":0.9,"humanRationale":"..."}
```

**Case design principles:**
- Balanced split: ~5 pass + ~5 fail per skill
- Include edge cases (partial coverage, missing components, good structure but wrong approach)
- `caseId` naming: `{skill}-{rubric-short}-{nn}` (deterministic hash distributes across train/validation/test)
- Reference existing eval case inputs from `evals/{skill}/datasets/*.jsonl` where possible

**Split distribution** (automatic via `hash(caseId) % 5`):
- Bucket 0 → `train` (20%, ~4 cases) — reserved hold-out
- Buckets 1-2 → `validation` (40%, ~8 cases) — rubric tuning
- Buckets 3-4 → `test` (40%, ~8 cases) — final measurement

**Target calibration metrics:** TPR >= 0.85, TNR >= 0.80

### Stream 2: Shepherd Remediation Events

Wire `remediation.attempted` and `remediation.succeeded` event emissions into the shepherd skill. These events are already defined in `event-store/schemas.ts` and handled by `CodeQualityView` — they're just never emitted.

**Emission points in `skills/shepherd/references/fix-strategies.md`:**

1. **Before applying a fix** — emit `remediation.attempted`:
   ```
   exarchos_event({ action: "append", streamId: "<featureId>",
     event: { type: "remediation.attempted",
       data: { taskId: "<pr-number>", skill: "shepherd",
               gateName: "<failing-check>", attemptNumber: N,
               strategy: "<fix-type>" }}})
   ```

2. **After fix resolves the gate** — emit `remediation.succeeded`:
   ```
   exarchos_event({ action: "append", streamId: "<featureId>",
     event: { type: "remediation.succeeded",
       data: { taskId: "<pr-number>", skill: "shepherd",
               gateName: "<check-name>", totalAttempts: N,
               finalStrategy: "<fix-type>" }}})
   ```

**Changes:**
- `skills/shepherd/references/fix-strategies.md` — add event emission instructions to the fix workflow
- `skills/shepherd/SKILL.md` — reference the remediation event protocol in Step 3 (Fix)

### Stream 3: Plan Coverage Bug Fix (#913)

Fix `scripts/verify-plan-coverage.sh` to recognize explicitly deferred design sections. When a plan's traceability table marks a design section as "Deferred" (case-insensitive), the script should treat it as covered — not a gap.

**Current behavior:** The script only matches design sections against task titles and plan body content. Sections marked "Deferred" in the traceability table with documented rationale still report as gaps.

**Expected behavior:** Parse the traceability table in the plan file for rows containing "Deferred" (case-insensitive). Extract the design section name from the first column. Treat these sections as covered with status "Deferred" (not "Covered" or "GAP").

**Example traceability entry that should be recognized:**
```
| 1.4 Rubric Refinement Protocol | Deferred | Operational process, not code. See Deferred Items. |
```

**Test cases needed:**
- `DeferredSection_InTraceability_ExitsZero` — section marked Deferred in traceability table, exit 0
- `DeferredSection_ShownAsDeferredInMatrix` — coverage matrix shows "Deferred" status, not "Covered"
- `MixedDeferredAndCovered_ExitsZero` — some sections deferred, some covered by tasks, exit 0
- `DeferredAndGap_ExitsOne` — deferred sections are fine, but other sections still have gaps

### Stream 4: Flywheel Verification Script

Create `scripts/verify-flywheel-activation.sh` that checks all activation conditions:

1. Gold standard file exists and has >= 20 cases
2. Calibration can run on validation split without errors
3. Signal confidence upgrades from `'low'` to `'medium'` or `'high'` for calibrated skills
4. Quality hints return `'actionable'` (not just `'advisory'`) for calibrated skills
5. Remediation event schemas validate correctly

Exit codes: 0 = all conditions met, 1 = conditions not met (reports which), 2 = prerequisite error.

## Task Breakdown

| # | Task | Stream | Dependencies | Delegatable? |
|---|------|--------|-------------|-------------|
| 1 | Create gold standard JSONL with 20 human-graded cases | 1 | None | No (human grading) |
| 2 | Add remediation event emission instructions to shepherd fix-strategies.md | 2 | None | Yes |
| 3 | Update shepherd SKILL.md to reference remediation event protocol | 2 | T2 | Yes |
| 4 | Fix verify-plan-coverage.sh hierarchical section matching | 3 | None | Yes |
| 5 | Create verify-flywheel-activation.sh verification script | 4 | T1 | Yes |
| 6 | Run calibration on validation split and document results | 1 | T1 | Partially (run is automated, rubric tuning is human) |

**Parallel groups:**
- Group A (no deps): T1, T2, T4 — can all start immediately
- Group B (depends on T2): T3
- Group C (depends on T1): T5, T6

## Success Criteria

1. `evals/calibration/gold-standard.jsonl` exists with >= 20 valid `HumanGradedCase` entries
2. `eval-calibrate` CLI runs successfully on the validation split for delegation and brainstorming
3. Shepherd skill instructions include remediation event emissions at correct points
4. `verify-plan-coverage.sh` passes tests 9-11 (hierarchical design matching)
5. `verify-flywheel-activation.sh` exits 0 after calibration completes

## Growth Plan

After this initial seed:
- **Immediate follow-up:** Add 20 cases each for `debug`, `implementation-planning`, `refactor` (3 separate PRs or 1 batch)
- **Ongoing cadence:** After every 5-10 completed workflows, review captured traces (Step 3 of flywheel guide) and promote 2-3 good ones
- **Target:** 100 total cases across 5 skills within 2-3 weeks

## Files Changed

| File | Change |
|------|--------|
| `evals/calibration/gold-standard.jsonl` | **New** — 20 human-graded calibration cases |
| `skills/shepherd/references/fix-strategies.md` | **Edit** — add remediation event emission protocol |
| `skills/shepherd/SKILL.md` | **Edit** — reference remediation events in Step 3 |
| `scripts/verify-plan-coverage.sh` | **Edit** — fix hierarchical section matching |
| `scripts/verify-flywheel-activation.sh` | **New** — end-to-end flywheel verification |

## Related

- [Flywheel Activation Guide](../guides/flywheel-activation.md) — operational activation steps
- [Autonomous Code Verification Design](2026-02-15-autonomous-code-verification.md) — original flywheel design
- [PR #914](https://github.com/lvlup-sw/exarchos/pull/914) — flywheel infrastructure implementation
- [Issue #913](https://github.com/lvlup-sw/exarchos/issues/913) — verify-plan-coverage.sh deferred sections bug
