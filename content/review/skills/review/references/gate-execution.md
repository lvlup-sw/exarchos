# Gate Execution Details

## Step 1: Static Analysis

Run the static analysis gate via orchestrate:

```typescript
exarchos_orchestrate({
  action: "check_static_analysis",
  featureId: "<id>",
  repoRoot: "<repo-root>"
})
```

The handler runs lint, typecheck, and quality-check (if available), distinguishing errors from warnings. The gate runner records the evidence, then appends one `gate.executed` event. Its details keep `verdict`, `completeness` and `advisorySkips`. The event has no `dimension` field, so the convergence view does not count it under D2.

Read `verdict` and `completeness` in the result, not `passed`. In audit mode, or when the config sets the gate severity to `warning`, `passed` is `true` for a failed gate. `verdict` always gives the true verdict.

**On `verdict: "pass"`:** Each check that gave a verdict passed. Read `completeness` before you go to Step 2.
**On `verdict: "fail"`:** Errors found. Fix them before you continue the review.
**On `verdict: "indeterminate"`:** No toolchain was found, or a check did not run. The result has `skipped: true`, and `reason` names the cause. It can also have `degraded: true`. This is not a pass. Remove the cause, then run the gate again.
**On `completeness: "complete"`:** Each check that applies gave a verdict.
**On `completeness: "degraded"`:** The result also has `degraded: true` and `advisorySkips`. An advisory check, such as the import-boundary scan, gave no verdict, so `verdict` is the verdict of the other checks only. Read each entry of `advisorySkips`: `name` is the check, `cause` is the closed cause, and `detail` tells what occurred. Write each skip in the review report, and do not report that check as passed.

## Step 2: Code Walkthrough

Assess each modified file against the quality checklists:
- Consult `code-quality-checklist.md` for code quality, SOLID, DRY, and structural criteria
- Consult `security-checklist.md` for security review criteria
- Consult `typescript-standards.md` for TypeScript-specific conventions (file organization, naming, patterns)

## Step 2.5: Security Scan (Automated)

Run automated security pattern detection via orchestrate:

```typescript
exarchos_orchestrate({
  action: "check_security_scan",
  featureId: "<id>",
  diffContent: "<unified diff>"
})
```

`diffContent` is optional — omit it to let the gate scan the resolved worktree
diff. The handler automatically emits a `gate.executed` event with dimension D1.

**On `passed: true`:** No security patterns detected.
**On `passed: false`:** Potential security issues found — include in review report.

## Step 2.6: Extended Quality Gates (Optional)

When available, run additional quality gates for D3-D5 dimensions:

```typescript
// D3: Context Economy — code complexity impacting LLM context
exarchos_orchestrate({ action: "check_context_economy", featureId: "<id>", repoRoot: "<repo-root>", baseBranch: "main" })

// D4: Operational Resilience — empty catches (excluding intentional fire-and-forget telemetry), swallowed errors, console.log
exarchos_orchestrate({ action: "check_operational_resilience", featureId: "<id>", repoRoot: "<repo-root>", baseBranch: "main" })

// D5: Workflow Determinism — .only/.skip, non-deterministic time/random, debug artifacts
exarchos_orchestrate({ action: "check_workflow_determinism", featureId: "<id>", repoRoot: "<repo-root>", baseBranch: "main" })
```

Each handler automatically emits `gate.executed` events with the appropriate dimension. Findings from these checks are advisory and feed into the convergence view but do not independently block the review.
