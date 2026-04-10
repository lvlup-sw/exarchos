---
name: quality-review
description: "Stage 2 code quality review. Triggers: 'quality review', 'check code quality', or /review stage 2. Requires spec-review to have passed first. Checks SOLID, DRY, security, and test quality. Do NOT use for spec compliance — use spec-review instead."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: review
---

# Quality Review Skill

## Overview

Stage 2 of two-stage review: Assess code quality, maintainability, and engineering best practices.

**Prerequisite:** Spec review must PASS before quality review.

> **MANDATORY:** Before accepting any rationalization for rubber-stamping code quality, consult `references/rationalization-refutation.md`. Every common excuse is catalogued with a counter-argument and the correct action.

## Triggers

Activate this skill when:
- Spec review has passed
- `{{COMMAND_PREFIX}}review` command (after spec review)
- Ready to assess code quality
- Before synthesis/merge

## Execution Context

This skill runs in a SUBAGENT spawned by the orchestrator, not inline.

The orchestrator provides the state file path, diff output from `exarchos_orchestrate({ action: "review_diff" })`, task ID, and spec review results (must be PASS).

The subagent reads the state file for artifact paths, uses the diff output instead of full files, runs static analysis, performs a code walkthrough, generates a report, and returns the verdict.

### Data Handoff Protocol

The **orchestrator** is responsible for generating the diff before dispatching the quality-review subagent. The subagent does NOT generate its own diff.

**Orchestrator responsibilities:**
1. Generate diff: `git diff main...HEAD` or `git diff main...integration-branch`
2. Pass diff content in the subagent dispatch prompt
3. Include state file path for artifact resolution
4. Include spec review results (must be PASS)

**Subagent responsibilities:**
1. Receive diff content from dispatch prompt (do NOT re-generate)
2. Read state file for design/plan artifact paths
3. Run static analysis and security scripts against the working tree
4. Return structured JSON verdict

### Context-Efficient Input

Instead of reading full files, receive the integrated diff:

```bash
# Generate integrated diff for review (branch stack vs main)
git diff main...HEAD > /tmp/stack-diff.patch

# Alternative: git diff for integration branch
git diff main...integration-branch > /tmp/integration-diff.patch

# Alternative: use gh CLI to get PR diff
# gh pr diff <number>
# Or use GitHub MCP pull_request_read with method "get_diff" if available
```

This reduces context consumption by 80-90% while providing the complete picture.

### Pre-Review Schema Discovery

Before evaluating, query the review strategy runbook to determine the appropriate evaluation approach:

- **Evaluation strategy:** `exarchos_orchestrate({ action: "runbook", id: "review-strategy" })` to determine single-pass vs two-pass evaluation strategy based on diff size and task count.

### Review Scope: Combined Changes

After delegation completes, quality review examines:
- The **complete stack diff** (all task branches vs main), or the **feature/integration-branch** diff when using integration branches
- All changes across all tasks in one view
- The full picture of combined code quality

This enables catching:
- Cross-task SOLID violations
- Duplicate code across task boundaries
- Inconsistent patterns between tasks

## Review Scope

**Quality Review focuses on:**
- Code quality and readability
- SOLID principles
- Error handling
- Test quality
- Performance considerations
- Security basics

**Does NOT re-check:**
- Functional completeness (spec review)
- TDD compliance (spec review)

## Review Process

### Check Quality Signals

Before reviewing, query quality signals for the skill(s) under review:
```
{{MCP_PREFIX}}exarchos_view({ action: "code_quality", workflowId: "<featureId>" })
```
- If `regressions` is non-empty, report active quality regressions to the user before proceeding
- If any hint has `confidenceLevel: 'actionable'`, present the `suggestedAction` to the user
- If `gatePassRate < 0.80` for the target skill, warn about degrading quality

### Step 0: Verify Spec Review Passed (MANDATORY)

Before proceeding, confirm spec review passed for all tasks:

```text
action: "get", featureId: "<id>", query: "reviews"
```

If ANY task has `specReview.status !== "pass"`, STOP and return:
```json
{ "verdict": "blocked", "summary": "Spec review not passed — run spec-review first" }
```

### Step 0.5: Verify Review Triage (Conditional — run when delegation phase preceded this review)

If this review follows a delegation phase, verify triage routing:

```typescript
exarchos_orchestrate({
  action: "verify_review_triage",
  stateFile: "<state-file>"
})
```

`passed: true`: triage routing correct — continue to Step 1. `passed: false`: triage issues found — investigate and resolve before proceeding.

### Step 1: Static Analysis + Security + Extended Gates

> **Runbook:** Run quality evaluation gates via runbook:
> `exarchos_orchestrate({ action: "runbook", id: "quality-evaluation" })`
> If runbook unavailable, use `describe` to retrieve gate schemas: `exarchos_orchestrate({ action: "describe", actions: ["check_static_analysis", "check_security_scan", "check_convergence", "check_review_verdict"] })`

Run automated gates via orchestrate actions. See `references/gate-execution.md` for orchestrate action signatures and response handling.

1. `check_static_analysis` — lint, typecheck, quality-check (D2). **Must pass** before continuing.
2. `check_security_scan` — security pattern detection (D1). Include findings in report.
3. Optional D3-D5 gates: `check_context_economy`, `check_operational_resilience`, `check_workflow_determinism` — advisory, feed convergence view.

### Step 2: Test Desiderata Evaluation

Evaluate agent-generated tests against Kent Beck's Test Desiderata. Four properties are critical for agentic code:

| Property | What to check | Flag when |
|---|---|---|
| **Behavioral** | Tests assert on observable behavior, not implementation details | Mock call count assertions, internal state inspection, testing private methods |
| **Structure-insensitive** | Tests survive refactoring without behavioral change | Tests coupled to internal helper method signatures, tests that break when internals are renamed |
| **Deterministic** | Tests produce the same result every run | Uncontrolled `Date.now()`, `Math.random()`, `setTimeout` race conditions, network-dependent tests |
| **Specific** | Test failures pinpoint the cause | `toBeTruthy()` / `toBeDefined()` without additional specific assertions, catch-all tests with vague descriptions |

**Test layer mismatch detection:** Flag unit tests with >3 mocked dependencies as potential layer mismatches — unit tests with many mocks often indicate the test is asserting integration concerns rather than unit logic. Advisory finding: suggest re-classifying as integration test with real collaborators.

Include Test Desiderata findings in the quality review report under a "Test Quality" section. **Output format:** Report Test Desiderata violations as entries in the `issues` array with `category: "test-quality"`.

### Step 3: Generate Report

Use the template from `references/review-report-template.md` to structure the review output.

## Priority Levels

| Priority | Action | Examples |
|----------|--------|----------|
| **HIGH** | Must fix before merge | Security issues, data loss risks |
| **MEDIUM** | Should fix, may defer | SOLID violations, complexity |
| **LOW** | Nice to have | Style preferences, minor refactors |

### Priority Classification Rules

- **HIGH:** security vulnerabilities, data loss risk, API contract breaks, uncaught exception paths
- **MEDIUM:** SOLID violations (LSP, ISP), cyclomatic complexity >15, test coverage <70%
- **LOW:** naming, code style, comment clarity, non-impactful performance

If classification is ambiguous, default to MEDIUM and flag for human decision.

## Fix Loop for HIGH-Priority

If HIGH-priority issues found:

1. Create fix task listing each HIGH finding with file, issue, and required fix
2. Dispatch to implementer subagent
3. Re-review quality after fixes
4. Only mark APPROVED when all HIGH items resolved and tests pass

**Fix loop iteration limit: max 3.** If HIGH-priority issues persist after 3 fix-review cycles, pause and escalate to the user with a summary of unresolved issues. The user can override: `{{COMMAND_PREFIX}}review --max-fix-iterations 5`

### Post-Fix Spec Compliance Check (MANDATORY after fix cycle)

After the quality-review fix loop completes and quality passes, re-verify that the quality fixes did not break spec compliance. Run inline (not a full dispatch):

1. Run spec verification commands:
   ```bash
   npm run test:run
   npm run typecheck
   ```
   ```typescript
   exarchos_orchestrate({
     action: "check_tdd_compliance",
     featureId: "<featureId>",
     taskId: "<taskId>",
     branch: "<branch>"
   })
   ```
2. If all pass: proceed to APPROVED transition
3. If any fail: return to NEEDS_FIXES with spec regression noted in issues array

## Required Output Format

The subagent MUST return results as structured JSON. The orchestrator parses this JSON to populate state. Any other format is an error.

```json
{
  "verdict": "pass | fail | blocked",
  "summary": "1-2 sentence summary",
  "issues": [
    {
      "severity": "HIGH | MEDIUM | LOW",
      "category": "security | solid | dry | perf | naming | test-quality | other",
      "file": "path/to/file",
      "line": 123,
      "description": "Issue description",
      "required_fix": "What must change"
    }
  ],
  "test_results": {
    "passed": 0,
    "failed": 0,
    "coverage_percent": 0
  }
}
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Block on LOW priority | Accept and track for later |
| Review before spec passes | Complete spec review first |
| Be overly pedantic | Focus on impactful issues |
| Skip security checks | Always verify basics |
| Accept poor test quality | Tests are code too |
| Apply generic standards to language issues | Reference language-specific rules |

## Cross-Task Integration Issues

If an issue spans multiple tasks:
1. Classify as "cross-task integration"
2. Create fix task specifying ALL affected tasks
3. Dispatch fix to implementer with context from all affected tasks
4. Mark original tasks as blocked until cross-task fix completes

## State Management

> **Key format:** The review key MUST be kebab-case `reviews["quality-review"]`, not camelCase `reviews.qualityReview`. The guard matches on the exact key string.

**On review complete:**
```text
action: "set", featureId: "<id>", updates: {
  "reviews": { "quality-review": { "status": "pass", "summary": "...", "issues": [...] } }
}
```

**On all reviews pass — advance to synthesis:**
```text
action: "set", featureId: "<id>", phase: "synthesize"
```

### Phase Transitions and Guards

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

**Quick reference:**
- `review` → `synthesize` requires guard `all-reviews-passed` — all `reviews.{name}.status` must be passing
- `review` → `delegate` requires guard `any-review-failed` — triggers fix cycle when any review fails

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. Use
`exarchos_orchestrate({ action: "describe", actions: ["check_static_analysis", "check_security_scan", "check_review_verdict"] })`
for orchestrate action schemas.

## Completion Criteria

- [ ] Static analysis passes
- [ ] All HIGH-priority issues fixed
- [ ] No security vulnerabilities
- [ ] Test quality acceptable
- [ ] Code is maintainable
- [ ] State file updated with review results

### Decision Runbooks

For review verdict routing, query the decision runbook:
`exarchos_orchestrate({ action: "runbook", id: "review-escalation" })`

This runbook provides structured criteria for routing between APPROVED and NEEDS_FIXES verdicts based on finding severity and fix cycle count. APPROVED transitions to synthesize; NEEDS_FIXES transitions back to delegate for a fix cycle. (BLOCKED routing is only relevant in plan-review, not here.)

## MCP-Served Quality Check Catalog (Tier 2)

After Tier 1 MCP gates complete, execute the quality check catalog. This provides deterministic quality checks (grep patterns, structural analysis) that run on **any MCP platform** — no companion plugins required.

### Step 2.5: Execute Check Catalog

```typescript
exarchos_orchestrate({ action: "prepare_review", featureId: "<id>" })
```

The response contains:
- `catalog` — structured check dimensions with grep patterns, structural thresholds, and heuristic instructions
- `findingFormat` — the TypeScript interface for submitting findings
- `pluginStatus` — which companion plugins are configured in `.exarchos.yml`

Execute each check in the catalog against the codebase:
- **grep checks:** Run the `pattern` against files matching `fileGlob`
- **structural checks:** Evaluate against the `threshold` (e.g., nesting depth, function length)
- **heuristic checks:** Use judgment guided by the `description`

Collect all matches as findings in the format specified by `findingFormat`, then pass them as `pluginFindings` to `check_review_verdict`.

### Companion Plugin Enhancement (Tier 3 — Platform-Dependent)

On platforms with skill support (Claude Code, Cursor), the orchestrator may additionally invoke `axiom:audit` and `impeccable:critique` for deeper qualitative analysis. These findings are also passed as `pluginFindings`. See `references/axiom-integration.md` for the full three-tiered architecture.

## Convergence & Verdict

Query convergence status and compute verdict via orchestrate. See `references/convergence-and-verdict.md` for full orchestrate calls, response fields, and verdict routing logic.

Summary: `check_convergence` returns per-dimension D1-D5 status. `check_review_verdict` takes finding counts and optional `pluginFindings` array (from catalog execution and companion plugins), emits gate events, and returns APPROVED or NEEDS_FIXES.

## Auto-Transition

All transitions are automatic — no user confirmation. See `references/auto-transition.md` for per-verdict transition details, Skill invocations, and integration notes.

### Recording Results

Before transitioning, record the review verdict. The reviews value MUST be an object with a `status` field, not a flat string:

**APPROVED:**
```
exarchos_workflow({ action: "set", featureId: "<id>", updates: {
  reviews: { "quality-review": { status: "pass", summary: "...", issues: [] } }
}, phase: "synthesize" })
```
Then invoke `{{COMMAND_PREFIX}}synthesize`.

**NEEDS_FIXES:**
```
exarchos_workflow({ action: "set", featureId: "<id>", updates: {
  reviews: { "quality-review": { status: "fail", summary: "...", issues: [{ severity: "HIGH", file: "...", description: "..." }] } }
}})
```
Then invoke `{{COMMAND_PREFIX}}delegate --fixes`.

> **Gate events:** Do NOT manually emit `gate.executed` events via `exarchos_event`. Gate events are automatically emitted by the `check_review_verdict` orchestrate handler. Manual emission causes duplicates.

> **Guard shape:** The `all-reviews-passed` guard requires `reviews.{name}.status` to be a passing value (`pass`, `passed`, `approved`, `fixes-applied`). Flat strings like `reviews: { "quality-review": "pass" }` are silently ignored and will block the `review → synthesize` transition.
