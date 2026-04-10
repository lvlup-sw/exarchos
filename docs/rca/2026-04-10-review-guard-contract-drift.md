# RCA: review-phase guard contract drift (issues #1073, #1074, #1075)

## Summary

The `all-reviews-passed` guard, the review-phase playbook, and the spec-review / quality-review skills each encode a *different* contract for the `reviews.*` state shape. An agent that follows the documented playbook or skill guidance cannot satisfy the guard, because the guard was updated in #1045 to require dimension names that no playbook, skill, or agent is told about. The guard's case-sensitive status comparison and its short-circuit error reporting make the failure look like three separate bugs; they are one root cause with three surfaces.

## Symptom

Three issues filed 2026-04-10 from the same session on workflow `strategos-2-4-0-migration` (basileus repo), all at the `review → synthesize` transition:

- **#1073** — playbook documents `reviews.spec-review.passed AND reviews.quality-review.passed`; guard expects `reviews.spec-compliance` and `reviews.code-quality` (and checks `.status`, not `.passed`).
- **#1075** — guard rejected reviewer agent output even though agent wrote `passed: true` and `verdict: "PASS"`. Reported error: `"Reviews not passed: spec (status: \"PASS\")"`. Guard *did* find the `verdict`; the comparison failed on case.
- **#1074** — guard surfaces one failure at a time (missing-dimensions check first, then not-passed check), forcing discovery-by-retry.

### Reproduction Steps

From `~/.claude/workflow-state/strategos-2-4-0-migration.*` (repro evidence):

1. Agent completed both review stages and emitted `review.completed` events at **05:21:17Z**.
2. Agent wrote state: `reviews.spec = { passed: true, verdict: "PASS", reviewer: "exarchos-reviewer", ... }` and `reviews.quality = { passed: true, verdict: "APPROVED", ... }`.
3. Agent called `exarchos_workflow set phase=synthesize` → **guard rejected at 05:21:20Z** (`workflow.guard-failed`, guard=`all-reviews-passed`).
4. Agent retried 05:21:25Z → rejected again (same contract violation).
5. Agent retried 05:21:35Z → rejected. 
6. Human patched `reviews.spec-compliance.status = "pass"` and `reviews.code-quality.status = "pass"` at 05:21:39Z (`state.patched` event).
7. Retry at 05:21:42Z → **still rejected**: the original `reviews.spec.verdict = "PASS"` (uppercase) now surfaced as the next failing check once the missing-dimensions check passed.
8. Human patched `reviews.spec.status = "pass"` and `reviews.quality.status = "pass"` at 05:21:47Z.
9. Retry at 05:21:50Z → **transition finally succeeded**. 4 rejections, 2 human state patches.

Final workflow state still contains all four review entries (`spec`, `quality`, `spec-compliance`, `code-quality`) as a fossil of the repair session.

### Observed Behavior

- Guard rejects transition even though the reviewer agent has done its job correctly per the skill documentation.
- Guard rejection messages cite only the *first* failing check, masking downstream failures.
- Human must manually reverse-engineer the real contract from guard.ts source and patch state to appease the guard.

### Expected Behavior

- Agent writes reviews using documented field names. Guard accepts them. Transition proceeds.
- If multiple contract violations exist, all are reported in one error so they can be fixed in one pass.
- Guard's status-value comparison is case-insensitive (reviewer-written values and the PASSED_STATUSES set should be normalized).

## Root Cause

**Three conflicting dimension naming conventions exist simultaneously for the feature review phase, with no single source of truth. The guard was updated in #1045 to pick a new convention, and neither the playbook documentation nor the skill prompts were updated to match.**

### The three conventions in the repo today

| Authority | File | Names used | Field |
|---|---|---|---|
| **Engine hardcode** (`_requiredReviews`) | `servers/exarchos-mcp/src/workflow/tools.ts:479` | `spec-compliance`, `code-quality` | `.status` |
| **Phase playbook** (`guardPrerequisites`) | `servers/exarchos-mcp/src/workflow/playbooks.ts:266` | `spec-review`, `quality-review` | `.passed` |
| **Skill prompts** (what agents read) | `skills-src/spec-review/SKILL.md:213`, `skills-src/quality-review/SKILL.md:267-272` | `spec-review`, `quality-review` | `.status` |
| **Agent actual output** (basileus repro) | runtime | `spec`, `quality` | `.verdict` (uppercase), `.passed`, later `.status` |

The agent in the repro matched *none* of these — it invented a fourth convention by copying the uppercase verdict from `check_review_verdict`'s return value (`'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED'`) directly into state.

### Code Location

**1. Engine hardcode (the unilateral change that caused drift):**

`servers/exarchos-mcp/src/workflow/tools.ts:477-484`
```ts
const workflowType = state.workflowType as string;
const defaults: Record<string, readonly string[]> = {
  feature: ['spec-compliance', 'code-quality'],
};
const typeDefaults = defaults[workflowType];
if (typeDefaults?.length) {
  mutableState._requiredReviews = typeDefaults;
}
```

Git blame: commit `5f4f726b` ("fix: resolve 5 open bugs and eliminate test flakiness" — PR #1045). This commit introduced `spec-compliance`/`code-quality` as the required dimension names but did not update `playbooks.ts`, `skills-src/spec-review/SKILL.md`, or `skills-src/quality-review/SKILL.md`.

**2. Wrong playbook docs (#1073):**

`servers/exarchos-mcp/src/workflow/playbooks.ts:265-266`
```ts
guardPrerequisites:
  'reviews.spec-review.passed AND reviews.quality-review.passed',
```
Wrong on *both* the dimension names (`spec-review`/`quality-review` instead of `spec-compliance`/`code-quality`) and the field (`.passed` is a legacy shape; current canonical field is `.status`).

**3. Case-sensitive status comparison (the mechanism behind #1075):**

`servers/exarchos-mcp/src/workflow/guards.ts:73, 85-89, 256`
```ts
export const PASSED_STATUSES = new Set(['pass', 'passed', 'approved', 'fixes-applied']);
...
function extractStatus(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.status === 'string') return entry.status;
  if (typeof entry.verdict === 'string') return entry.verdict;
  return undefined;
}
...
const notPassed = statuses.filter((s) => !PASSED_STATUSES.has(s.status));
```

The guard already handles `verdict` as a `status` synonym (per GitHub #1004), but `PASSED_STATUSES.has(s.status)` is a raw `Set` membership check — case-sensitive. The reviewer agent copies `verdict: "PASS"` / `"APPROVED"` straight out of `check_review_verdict`'s return type (`'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED'`), which is defined uppercase in `servers/exarchos-mcp/src/orchestrate/review-verdict.ts:26`. Lowercase set + uppercase value = silent membership miss.

**4. Short-circuit error reporting (#1074):**

`servers/exarchos-mcp/src/workflow/guards.ts:203-266`

The `allReviewsPassed.evaluate` function has three early-return paths: (a) `reviews` missing, (b) required dimensions missing, (c) any status not in `PASSED_STATUSES`. Each returns on the first failure — there is no accumulation of failures into a single `GuardFailure`. An agent fixing one failure triggers a new error for the next, which looks like a moving target.

### Analysis

The interaction between the four bugs makes the user-visible failure look mysterious:

1. **Agent reads skill docs**, sees `reviews["spec-review"]` / `reviews["quality-review"]` guidance but doesn't follow it precisely — it writes `reviews.spec` / `reviews.quality` (plain, not kebab), copies `verdict: "PASS"` from the orchestrate response.
2. **Guard checks required dimensions** → `spec-compliance`/`code-quality` missing → returns first failure. Agent hasn't been told these names anywhere.
3. **Agent or human adds the missing dimension entries** with `status: "pass"` — that gets past the missing-dimensions check.
4. **Guard then runs `collectReviewStatuses` over the entire `reviews` object** (not just required dimensions) → picks up the pre-existing `reviews.spec.verdict = "PASS"` → set-membership check fails on case → returns second failure with cryptic message `Reviews not passed: spec (status: "PASS")`.
5. **Human sees the error, manually patches `reviews.spec.status = "pass"`** to override. Now `extractStatus` picks the lowercase `status` before `verdict` → passes.

Every layer contributed to the compounding failure.

## Contributing Factors

- [x] **Inadequate code review on PR #1045** — the commit introduced a new required-dimensions hardcode without updating the playbook or skill docs that it invalidated. No lint or test caught the cross-file drift.
- [x] **Missing test coverage** — the existing guards test (`guards.test.ts:490-542`) uses `spec-compliance`/`code-quality` and tests the guard in isolation, so it never catches the mismatch between guard, playbook, and skill docs.
- [x] **Multiple sources of truth** — the contract for what field names/values appear in `reviews.*` is described in three places with no single authority. Any change to the contract requires coordinated updates that are easy to miss.
- [x] **Case-sensitive comparison on a user-supplied string** — `PASSED_STATUSES.has(raw)` does not normalize. This is a classic string-comparison smell.
- [x] **Short-circuit error reporting on a multi-condition guard** — error-surface design assumes one fix per retry; penalizes well-meaning agents.
- [x] **Orchestrate return type leaks into state shape** — `check_review_verdict` returns `verdict: 'APPROVED' | 'NEEDS_FIXES' | 'BLOCKED'` (uppercase, discriminated-union style), and the skill prompts invite the agent to copy it into state. But the guard expects lowercase action-state values. There is no canonical translation layer.

## Fix Approach

Converge on **one** canonical contract across engine, playbook, and skills; make the guard tolerant and transparent.

### Canonical contract decision

**The skill folder name is the single source of truth.** `skills-src/spec-review/` → dimension key `spec-review`; `skills-src/quality-review/` → dimension key `quality-review`. Any other choice forces a translation layer between "the skill I'm running" and "the state key I'm writing", which is exactly the drift that caused this bug.

- **Dimension names:** `spec-review` and `quality-review` (match skill folder names, match playbook doc intent, match design in `docs/designs/2026-04-09-stabilization-sweep.md:78`). **Revert the engine hardcode at `tools.ts:479`**, which introduced `spec-compliance`/`code-quality` unilaterally in PR #1045 without any companion update.
- **Required field:** `status` (the guard's primary field). `verdict` remains a backward-compat synonym (already supported).
- **Canonical values:** `"pass"`, `"approved"`, `"passed"`, `"fixes-applied"` for success; `"fail"`, `"failed"`, `"needs_fixes"` for failure. **Case-insensitive on read** — the guard normalizes before set-membership check.
- **Legacy `passed: boolean` shape:** keep reading it as a fallback (already supported).
- **Uppercase `"PASS"` / `"APPROVED"` / `"NEEDS_FIXES"` from `check_review_verdict`:** these are routing-decision discriminated-union values, idiomatic TypeScript, and should **not** be changed. The guard is the authoritative normalization boundary; any string status the guard receives gets `.toLowerCase()` applied before comparison. Normalization at the read boundary is strictly better than pushing it onto every caller.

### Changes Required

| File | Change | Fixes |
|------|--------|-------|
| `servers/exarchos-mcp/src/workflow/tools.ts:479` | Change `feature: ['spec-compliance', 'code-quality']` → `feature: ['spec-review', 'quality-review']`. Revert PR #1045's unilateral rename. | #1073 (engine side) |
| `servers/exarchos-mcp/src/workflow/guards.ts:85-89` | In `extractStatus`, normalize to lowercase before returning (single point; both `status` and `verdict` paths). | #1075 mechanism |
| `servers/exarchos-mcp/src/workflow/guards.ts:203-266` | Refactor `allReviewsPassed.evaluate` to accumulate all failures (missing dimensions + failing statuses) into a single `GuardFailure.reason` and `expectedShape`. Do not early-return on the first mismatch. | #1074 |
| `servers/exarchos-mcp/src/workflow/playbooks.ts:265-266` | Update `guardPrerequisites` to describe the real contract: `reviews.spec-review.status` AND `reviews.quality-review.status` must be one of `pass`, `approved`, `passed`, `fixes-applied`. | #1073 (playbook side) |
| `servers/exarchos-mcp/src/workflow/guards.test.ts:490+` | Update fixtures from `spec-compliance`/`code-quality` → `spec-review`/`quality-review` to match new engine contract. | contract alignment |
| `servers/exarchos-mcp/src/workflow/guards.test.ts` (new) | Add test: reviewer writes `verdict: "PASS"` (uppercase) → guard accepts. | #1075 regression |
| `servers/exarchos-mcp/src/workflow/guards.test.ts` (new) | Add test: guard reports missing-dimensions AND not-passed failures in the same error when both are present. | #1074 regression |
| `servers/exarchos-mcp/src/workflow/playbooks.test.ts` (new) | Add cross-file consistency test: for each workflow-type hardcode in `tools.ts` (`_requiredReviews`), `playbooks.ts`'s `guardPrerequisites` must mention the same dimension names. | prevention |
| `servers/exarchos-mcp/src/__tests__/workflow/integration.test.ts:210-211` | Update `reviews.spec-compliance` / `reviews.code-quality` fixtures to `reviews.spec-review` / `reviews.quality-review`. | contract alignment |
| `skills-src/spec-review/SKILL.md` | No rename needed (already uses `reviews["spec-review"]`). Audit for any stray `spec-compliance` references. | #1073 verify |
| `skills-src/quality-review/SKILL.md` | No rename needed (already uses `reviews["quality-review"]`). Audit for any stray `code-quality` references. | #1073 verify |
| `npm run build:skills` | Regenerate `skills/<runtime>/**` from source to absorb any audit fixes. `skills:guard` CI will enforce this. | CI |

### Risks

- **Stale review entries from in-flight workflows.** Any workflow that was mid-review before this PR may have `reviews.spec` / `reviews.quality` (or other off-name) entries from the old contract. `allReviewsPassed` still scans *every* entry in `state.reviews` via `collectReviewStatuses`, so a **stale entry with a passing status is inert** (no effect on the guard), but a **stale entry with a failing status (`fail`/`needs_fixes`) will block the transition** even though it is not one of the `_requiredReviews` dimensions. Cleanup for any in-flight workflow hitting this: use `exarchos_workflow set` to patch the stale entry to `status: "pass"` or remove it from state. Fresh workflows started after this PR will use the new names and are not affected.
- **Case-insensitive normalization has a theoretical attack surface** — if a downstream consumer reads status and distinguishes `"pass"` from `"PASS"`. Grep confirms no such consumer exists (the guard is the only place reading `reviews.*.status`). Safe.
- **Skills renderer drift** — after editing `skills-src/*`, must run `npm run build:skills` and commit the regenerated `skills/<runtime>/**`. `skills:guard` CI will fail the PR otherwise.

## Prevention

### Shipped in this PR (#1076)

- [x] **Single source of truth for review contract.** `servers/exarchos-mcp/src/workflow/review-contract.ts` now owns `REQUIRED_REVIEWS_BY_WORKFLOW_TYPE`. Consumed by `tools.ts` (runtime injection) and `playbooks.ts` (doc generation). Skill folder names under `skills-src/` are the authoritative identifiers — `tools.ts` would drift from the contract only if a regression reintroduced hardcoded dimension names.
- [x] **Playbook docs generated from code, not hand-written strings.** `playbooks.ts:267` now calls `getRequiredReviewsPrerequisite('feature')` instead of a hand-written string. Any future rename propagates automatically.
- [x] **Cross-file consistency test.** `playbooks.test.ts` asserts every dimension declared in `REQUIRED_REVIEWS_BY_WORKFLOW_TYPE` appears in the corresponding `review` phase's `guardPrerequisites` string, and that feature-workflow names match skill folder names. `tools.playbook.test.ts` adds behavioral tests that exercise `handleSet` → guard so a regression hardcoding names inside `tools.ts` (bypassing `review-contract.ts`) is caught end-to-end.
- [x] **Guard hardening.** `extractStatus` normalizes case (uppercase verdicts from `check_review_verdict` now pass); `allReviewsPassed.evaluate` aggregates failures into one error with a merged `suggestedFix` covering both missing and present-but-failing reviews; required-review membership check uses `hasOwnProperty` + status-extractability + `UNSAFE_KEYS` filter so empty `{}` and proto-pollution keys are treated as missing.

### Follow-up (deferred)

- [ ] **Guard diagnostic events.** When a guard fails, the `workflow.guard-failed` event should include the rejection reason and `expectedShape`, not just the guard name. The strategos repro shows 4 rejections with no reason field, which made debugging harder than necessary.
- [ ] **PR template checklist nudge.** Add to the PR template: "Any change to review-phase dimension names must update `review-contract.ts` (not `tools.ts` directly)." Structural enforcement via the consistency tests is primary; the nudge is defense-in-depth.
- [ ] **Lowercase values for `check_review_verdict`?** Decided **no** in this PR — the guard-side normalization is the correct boundary and `check_review_verdict`'s uppercase discriminated union is idiomatic TypeScript. Revisit only if a new call site reveals a need.

## Timeline

| Event | Date | Notes |
|-------|------|-------|
| Hardcode introduced (root cause) | ~2026-03 | PR #1045, commit `5f4f726b` adds `['spec-compliance', 'code-quality']` to tools.ts without updating playbook/skills |
| First observed failure | 2026-04-10 05:21:20Z | `strategos-2-4-0-migration` workflow, review→synthesize transition, 4 guard-failed events in 30 seconds |
| Issues filed | 2026-04-10 05:28-05:29Z | #1073, #1074, #1075 |
| Triage (this debug workflow) | 2026-04-10 | Thorough track, bundled all three |
| Investigated | 2026-04-10 | RCA written (this doc) |
| Fixed | 2026-04-10 | PR [#1076](https://github.com/lvlup-sw/exarchos/pull/1076) — initial commit `f50389aa` (engine + playbook + guard + tests + skill doc cleanup); CodeRabbit-addressed follow-up adds behavioral tests, explicit-empty `requiredReviews` override, and extends `suggestedFix` to cover present-but-failing reviews. |
| Verified | 2026-04-10 | Regression tests added in `guards.test.ts` (uppercase verdict accepted, mixed missing+failing aggregation asserts full `suggestedFix`), `tools.playbook.test.ts` (tools-facing contract wiring through `handleSet`, explicit empty override honored), and `playbooks.test.ts` (cross-file consistency between `review-contract.ts`, `tools.ts`, and `playbooks.ts`). All 4822 MCP server tests green. |

## Related

- Issues: [#1073](https://github.com/lvlup-sw/exarchos/issues/1073), [#1074](https://github.com/lvlup-sw/exarchos/issues/1074), [#1075](https://github.com/lvlup-sw/exarchos/issues/1075)
- Originating commit: `5f4f726b` (PR #1045)
- Earlier related hardening: #1004 (added `verdict` as `status` synonym — the case-insensitivity miss here is the sister bug that #1004 should have fixed)
- Design note on intended contract: `docs/designs/2026-04-09-stabilization-sweep.md:78` — stated the engine should accept `reviews.spec-review` / `reviews.quality-review`. This PR restores that intent after PR #1045's unilateral rename broke it.
- Repro state (read-only): `~/.claude/workflow-state/strategos-2-4-0-migration.{state.json,events.jsonl}`
- Workflow ID for this debug: `debug-review-guard-contract`
