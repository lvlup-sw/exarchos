---
name: quality-review
description: "Stage 2 code quality review after spec compliance passes. Use when the user says 'quality review', 'check code quality', or runs /review (stage 2). Requires spec-review to have passed first (stage 2 of /review). Checks SOLID principles, DRY, security, and test quality. Do NOT use for spec compliance — use spec-review instead. Do NOT use for brainstorming."
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
- `/review` command (after spec review)
- Ready to assess code quality
- Before synthesis/merge

## Execution Context

This skill runs in a SUBAGENT spawned by the orchestrator, not inline.

The orchestrator provides the state file path, diff output from `~/.claude/scripts/review-diff.sh`, task ID, and spec review results (must be PASS).

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
mcp__plugin_exarchos_exarchos__exarchos_view({ action: "code_quality", workflowId: "<featureId>" })
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

```bash
scripts/verify-review-triage.sh --state-file <state-file>
```

Exit 0: triage routing correct — continue to Step 1. Exit 1: triage issues found — investigate and resolve before proceeding.

### Step 1: Static Analysis

Run the static analysis gate via orchestrate:

```typescript
exarchos_orchestrate({
  action: "check_static_analysis",
  featureId: "<id>",
  repoRoot: "<repo-root>"
})
```

The handler runs lint, typecheck, and quality-check (if available), distinguishing errors from warnings. It automatically emits a `gate.executed` event with dimension D2.

**On `passed: true`:** All analysis passes — proceed to Step 2.
**On `passed: false`:** Errors found — fix before continuing review.

### Step 2: Code Walkthrough

Assess each modified file against the quality checklists:
- Consult `references/code-quality-checklist.md` for code quality, SOLID, DRY, and structural criteria
- Consult `references/security-checklist.md` for security review criteria
- Consult `references/typescript-standards.md` for TypeScript-specific conventions (file organization, naming, patterns)

### Step 2.5: Security Scan (Automated)

Run automated security pattern detection via orchestrate:

```typescript
exarchos_orchestrate({
  action: "check_security_scan",
  featureId: "<id>",
  repoRoot: "<repo-root>",
  baseBranch: "main"
})
```

The handler automatically emits a `gate.executed` event with dimension D1.

**On `passed: true`:** No security patterns detected.
**On `passed: false`:** Potential security issues found — include in review report.

### Step 2.6: Extended Quality Gates (Optional)

When available, run additional quality gates for D3-D5 dimensions:

```typescript
// D3: Context Economy — code complexity impacting LLM context
exarchos_orchestrate({ action: "check_context_economy", featureId: "<id>", repoRoot: "<repo-root>", baseBranch: "main" })

// D4: Operational Resilience — empty catches, swallowed errors, console.log
exarchos_orchestrate({ action: "check_operational_resilience", featureId: "<id>", repoRoot: "<repo-root>", baseBranch: "main" })

// D5: Workflow Determinism — .only/.skip, non-deterministic time/random, debug artifacts
exarchos_orchestrate({ action: "check_workflow_determinism", featureId: "<id>", repoRoot: "<repo-root>", baseBranch: "main" })
```

Each handler automatically emits `gate.executed` events with the appropriate dimension. Findings from these checks are advisory and feed into the convergence view but do not independently block the review.

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

**Fix loop iteration limit: max 3.** If HIGH-priority issues persist after 3 fix-review cycles, pause and escalate to the user with a summary of unresolved issues. The user can override: `/review --max-fix-iterations 5`

### Post-Fix Spec Compliance Check (MANDATORY after fix cycle)

After the quality-review fix loop completes and quality passes, re-verify that the quality fixes did not break spec compliance. Run inline (not a full dispatch):

1. Run spec verification commands:
   ```bash
   npm run test:run
   npm run typecheck
   scripts/check-tdd-compliance.sh --repo-root <repo-root> --base-branch main
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
      "category": "security | solid | dry | perf | naming | other",
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

**On review complete:**
```text
action: "set", featureId: "<id>", updates: {
  "reviews": { "quality": { "status": "pass", "summary": "...", "issues": [...] } }
}
```

**On all reviews pass — advance to synthesis:**
```text
action: "set", featureId: "<id>", phase: "synthesize"
```

## Completion Criteria

- [ ] Static analysis passes
- [ ] All HIGH-priority issues fixed
- [ ] No security vulnerabilities
- [ ] Test quality acceptable
- [ ] Code is maintainable
- [ ] State file updated with review results

## Check Convergence

Before computing the verdict, query the convergence view for the aggregate D1-D5 status from all gate events emitted during the pipeline:

```typescript
exarchos_orchestrate({
  action: "check_convergence",
  featureId: "<id>"
})
```

The handler returns:
- `passed: true` — all five dimensions (D1-D5) have at least one gate result and all gates passed
- `passed: false` — one or more dimensions have failing gates or no gate coverage yet
- `uncheckedDimensions` — dimensions with no gate events (cold pipeline)
- `dimensions` — per-dimension summary with gate counts and convergence status

Use the convergence result as structured input to the verdict:
- If `uncheckedDimensions` is non-empty, note which dimensions lack gate coverage in the review report
- If a dimension has `converged: false`, include it as a finding in the verdict input
- If `passed: true`, it provides strong evidence for APPROVED (pending qualitative assessment)

## Determine Verdict

Classify review findings into a routing verdict via orchestrate:

```typescript
exarchos_orchestrate({
  action: "check_review_verdict",
  featureId: "<id>",
  high: <N>,
  medium: <N>,
  low: <N>,
  dimensionResults: {
    "D1": { passed: true, findingCount: 0 },
    "D2": { passed: true, findingCount: 0 },
    // ... include results from each gate run above
  }
})
```

The handler automatically emits per-dimension and summary `gate.executed` events. No manual event emission needed.

**On `verdict: "APPROVED"`:** Proceed to synthesis.
**On `verdict: "NEEDS_FIXES"`:** Route to `/exarchos:delegate --fixes`.
**On `verdict: "BLOCKED"`:** Return to design phase.

## Transition

All transitions happen **immediately** without user confirmation:

### If APPROVED:
1. Update state: `action: "set", featureId: "<id>", phase: "synthesize"`
2. Output: "Quality review passed. Auto-continuing to synthesis..."
3. Auto-invoke synthesize:
   ```typescript
   Skill({ skill: "exarchos:synthesize", args: "<feature-name>" })
   ```

### If NEEDS_FIXES:
1. Update state: `action: "set", featureId: "<id>", updates: { "reviews": { "quality": { "status": "fail", "issues": [...] } } }`
2. Output: "Quality review found [N] HIGH-priority issues. Auto-continuing to fixes..."
3. Auto-invoke delegate with fix tasks:
   ```typescript
   Skill({ skill: "exarchos:delegate", args: "--fixes <plan-path>" })
   ```

### If BLOCKED:
1. Update state: `action: "set", featureId: "<id>", phase: "blocked"`
2. Output: "Quality review blocked: [issue]. Returning to design..."
3. Auto-invoke ideate for redesign:
   ```typescript
   Skill({ skill: "exarchos:ideate", args: "--redesign <feature-name>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.

## Exarchos Integration

Gate events are automatically emitted by the orchestrate handlers — do NOT manually emit `gate.executed` events via `exarchos_event`.

1. **Read CI status** via `gh pr checks <number>` (or GitHub MCP `pull_request_read` with method `get_status` if available)
2. **Gate events** — emitted automatically by `check_static_analysis`, `check_security_scan`, `check_context_economy`, `check_operational_resilience`, `check_workflow_determinism`, and `check_review_verdict` handlers
3. **Read unified status** via `exarchos_view` with `action: "tasks"`, `fields: ["taskId", "status", "title"]`, `limit: 20`
4. **Query convergence** via `exarchos_view` with `action: "convergence"`, `workflowId: "<featureId>"` for per-dimension gate results
5. **When all per-PR gates pass**, apply `stack-ready` label to the PR

## Performance Notes

- Complete each step fully before advancing — quality over speed
- Do not skip validation checks even when the change appears trivial
- Read each checklist file completely before scoring. Do not skip security or SOLID checks even for small changes.
