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
  diffContent: "<unified diff>"
})
```

`diffContent` is optional — omit it to let the gate scan the resolved worktree
diff. The handler automatically emits a `gate.executed` event with dimension D1.

**On `passed: true`:** No security patterns detected.
**On `passed: false`:** Potential security issues found — include in review report.

## Step 2.6: Diff Hygiene (D3-D5)

One rule pack over the branch diff covers all three hygiene dimensions:

```typescript
exarchos_orchestrate({
  action: "check_diff_hygiene",
  featureId: "<id>",
  repoRoot: "<repo-root>",
  baseBranch: "main"
})
```

The rules are context economy (D3 — source-file length, diff breadth, generated bulk), operational resilience (D4 — empty catches excluding intentional fire-and-forget telemetry, swallowed errors, console.log, unbounded retry loops) and workflow determinism (D5 — `.only`/`.skip`, non-deterministic time and randomness, debug artifacts in tests). Per-rule verdicts come back on `rules[]`.

Each rule emits its own durable `gate.executed` event under its own gate name and dimension, so per-gate and per-dimension severity keys in `.exarchos.yml` resolve per rule. Findings are advisory — they reach the verdict as per-dimension results but do not independently block the review.

**On `passed: true`:** No hygiene findings in any rule.
**On `passed: false`:** At least one rule found something — include it in the review report.
**On `skipped: true`:** The base branch could not be resolved, so the diff had only one end. Every rule records an inconclusive verdict rather than a silent pass; re-run with an explicit `baseBranch`.
