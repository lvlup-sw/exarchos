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

The handler runs lint, typecheck, and quality-check (if available), distinguishing errors from warnings. It automatically emits a `gate.executed` event with dimension D2.

**On `passed: true`:** All analysis passes — proceed to Step 2.
**On `passed: false`:** Errors found — fix before continuing review.

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
  repoRoot: "<repo-root>",
  baseBranch: "main"
})
```

The handler automatically emits a `gate.executed` event with dimension D1.

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
