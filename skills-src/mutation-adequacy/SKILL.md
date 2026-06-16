---
name: mutation-adequacy
description: "Verification-ladder R5 review dimension: the mutation-adequacy adequacy backstop. Runs the diff-scoped mutation gate, reads the carrier, and turns surviving / NoCoverage mutants into concrete 'write a test that kills <file>:<line>' follow-ups. Triggers: 'mutation adequacy', 'check mutation score', or /review on a HIGH-tier feature. Advisory by default — never blocks merge unless an explicit config override raises severity. Do NOT run full-tree mutation here (scope:'full' is deferred to R10/v2.12)."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: review
---

# Mutation Adequacy Skill

## Overview

The `mutation-adequacy` review dimension is the **adequacy backstop** for the relaxed verification
mix (verification ladder slice 3, R5). When the planner ships the cheaper testing strategy — strict
types + inline invariants + one PBT + one acceptance test instead of granular per-behavior red-green
— mutation adequacy is the machine guard against the vacuous tests (and vacuous PBT properties) that
omission could otherwise admit. It scores whether the test suite actually **kills injected mutants**:
the strongest signal that tests fail for the right reason.

This dimension gates the **HIGH risk tier only**, at the **`/review` boundary only** — it is the
review-phase counterpart to the delegation-time `check_test_adequacy` (R3) gate. The coupling to the
high tier is policy data in `review-contract.ts` (the dimension name = this skill's folder name); you
never decide tier membership in this skill.

**Verdict is advisory by default.** A sub-threshold mutation score surfaces survivor follow-ups and
warns, but never blocks the merge — unless an explicit `review.gates['mutation-adequacy']` config
override raises its severity (the slice-2 severity mechanism). A 100% score is neither expected nor
required (equivalent mutants exist).

## Triggers

Activate this skill when:
- `{{COMMAND_PREFIX}}review` reaches the quality stage on a **HIGH-tier** feature
- The review contract lists `mutation-adequacy` in the required reviews for this workflow
- You need to assess whether the (possibly relaxed) test mix actually kills mutants

Do **not** activate for medium/low-tier work, or outside the `/review` boundary — those paths do not
require this dimension.

## Execution

### Step 1: Run the diff-scoped mutation gate

Invoke the action against the review/PR base ref. It runs the resolved mutation command
**diff-scoped** (Stryker `--since`, cargo-mutants `--in-diff`, mutmut path restriction — resolved from
the toolchains SoT, never composed by hand), so the run completes in `< minutes`, not the full-tree
time budget.

```typescript
{{MCP_PREFIX}}exarchos_orchestrate({
  action: "mutation-adequacy",
  featureId: "<featureId>",
  base: "<review/PR base ref>",      // e.g. "main" — reuse the same base the review diff uses
  worktreePath: "<optional worktree>", // 'auto' resolves the calling delegation's worktree
  operationId: "<optional idempotency key>"
  // scope defaults to "diff"; do NOT pass scope:"full" here (see Anti-Patterns)
})
```

The action emits `mutation.executing_started` / `mutation.executed` (liveness, INV-10) and a foldable
`gate.executed` carrying `mutationScore` (INV-1) automatically. Do **not** hand-emit these events.

### Step 2: Read the carrier

The action returns the fixed carrier (`data`). The shape is stable regardless of pass/fail/degrade:

| Field | Meaning |
|---|---|
| `passed` | `mutationScore >= threshold` (advisory — see Step 4) |
| `mutationScore` | `killed / (total − noCoverage)` — the Stryker convention; `noCoverage` is excluded from the denominator |
| `killed` | mutants a test caught (good) |
| `survived` | mutants that escaped — **tests ran but did not catch them** |
| `noCoverage` | mutants in code **no test exercises at all** |
| `total` | total mutants generated within the diff scope |
| `threshold` | the effective advisory threshold (override > config > soft default) |
| `report` | the parsed Stryker `mutation-testing-report-schema` |
| `next_actions` | "write a test that kills `<file>:<line>`" follow-ups (Step 3) |

Degrade signals to recognize (each returns `passed: true` so the gate never blocks closed-with-error):
- `skipped: true` + `reason` — no mutation runner resolved. Report the remediation; do not treat as a failure.
- `warning` + a `warnings[]` entry — the runner produced no parseable report. Note it; do not throw.
- `deferred: true` + `scope: 'full'` — you (incorrectly) requested full scope; re-run with the default diff scope.

See `references/reading-the-carrier.md` for the full carrier and report shape.

### Step 3: Turn survivors into kill-this-mutant follow-ups (INV-12)

The action already maps each surviving and `NoCoverage` mutant to a `next_actions` entry of the form
**"write a test that kills `<file>:<line>`"**. Surface these as concrete, actionable review findings —
each one names a specific assertion the suite is missing:

- A **survived** mutant means a test exercises that line but asserts nothing strong enough to detect
  the mutation. The follow-up: add an assertion that distinguishes the mutated behavior.
- A **NoCoverage** mutant means no test touches that line at all. The follow-up: add a test that
  exercises it, then assert on the observable behavior.

Record these as `issues` with `category: "test-quality"` so they ride the same review-report contract
as the other dimensions. Do not invent generic "improve coverage" advice — quote the file:line the
action surfaced.

### Step 4: Apply the advisory verdict

The dimension's severity is **advisory** (warning) by default. A sub-threshold `mutationScore`:
- surfaces the survivor follow-ups (Step 3),
- warns in the review report,
- **does not block** the `review → synthesize` transition.

An explicit `review.gates['mutation-adequacy']` config override can raise it to blocking — honor the
resolved severity, do not hardcode it. See `references/advisory-threshold.md` for why the default is a
soft threshold and how to calibrate it from the score trend.

## Required Output Format

Record the dimension result on the review state. The review key MUST be the kebab-case dimension name
(it equals this skill's folder name):

```typescript
{{MCP_PREFIX}}exarchos_workflow({ action: "update", featureId: "<id>", updates: {
  reviews: { "mutation-adequacy": {
    status: "pass",            // advisory: "pass" even when score is sub-threshold, unless an override blocks
    summary: "mutationScore 0.62 (threshold 0.40); 3 survivors surfaced as kill-test follow-ups",
    issues: [
      { severity: "MEDIUM", category: "test-quality", file: "src/foo.ts", line: 42,
        description: "surviving mutant — no assertion distinguishes the mutated branch",
        required_fix: "write a test that kills src/foo.ts:42" }
    ]
  } }
}})
```

A passing-value `status` (`pass | passed | approved | fixes-applied`, case-insensitive) is required
for the `all-reviews-passed` guard — a flat string is silently ignored and blocks the transition.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Run `scope: "full"` inline | Full-tree mutation is the long-running op deferred to R10/v2.12 — it returns a deferred advisory, never an inline run |
| Compose `--since` / `--in-diff` by hand | Let the action resolve the diff scope from the toolchains SoT |
| Block the merge on a sub-threshold score | Advisory by default — surface follow-ups, honor the resolved severity |
| Treat a Skipped/Warning carrier as a hard failure | Both return `passed: true` — report the reason, never throw |
| Run this dimension for medium/low tier | It gates the HIGH tier at the `/review` boundary only |
| Emit `gate.executed` manually | The action auto-emits liveness + the foldable gate event |
| Give generic "add more tests" advice | Quote the `<file>:<line>` the action surfaced in `next_actions` |

## References

- `references/reading-the-carrier.md` — reading the carrier and the Stryker `mutation-testing-report-schema`.
- `references/advisory-threshold.md` — why the threshold is a soft default, and how to calibrate it.
