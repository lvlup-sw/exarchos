---
outline: deep
---

# Review Process

Review happens automatically after delegation completes. You do not run it manually. The delegate phase transitions to review, and the system handles both stages.

## Two Stages

Review runs in two sequential stages. Stage 1 checks that the code matches what was designed. Stage 2 checks that the code itself is well-written. Both must pass before the workflow continues to synthesis. Each stage runs in a reviewer subagent working from an integrated diff (all task branches vs. main).

## Stage 1: Spec Compliance

**Question:** Does the implementation match the design?

Three checks run:

**Provenance chain** (blocking). Are design requirements (tagged DR-1, DR-2, etc.) traceable to implementation and tests? Every requirement should map to code that implements it and a test that verifies it.

**TDD compliance** (blocking). Was the test-before-code protocol followed? Checks commit history for the red-green-refactor pattern.

**Security scan** (informational). Scans the diff for hardcoded secrets, SQL injection vectors, unsafe deserialization. Findings are recorded but do not block.

If spec compliance fails, fixer agents are dispatched automatically with specific findings.

## Stage 2: Code Quality

**Question:** Is the code well-written?

Stage 2 only runs after Stage 1 passes. Four checks run:

**Static analysis** (blocking). Lint violations and typecheck errors. Must pass before anything else matters.

**Context economy** (informational). Long functions, deep nesting, circular dependencies. Patterns that consume disproportionate context tokens in future LLM interactions.

**Operational resilience** (informational). Empty catch blocks, swallowed errors, `console.log` in production code.

**Workflow determinism** (informational). `.only` or `.skip` left in tests, non-deterministic time/random usage, debug artifacts committed.

## Convergence Gates

The checks above map to five quality dimensions tracked across the entire pipeline:

| Dimension | Label | What It Measures | Blocking? |
|-----------|-------|------------------|-----------|
| D1 | Design Completeness | Requirements coverage, TDD protocol | Yes |
| D2 | Static Analysis | Lint, typecheck, structural rules | Yes |
| D3 | Context Economy | Code complexity for LLM context | No |
| D4 | Operational Resilience | Error handling, production readiness | No |
| D5 | Workflow Determinism | Test reliability, reproducibility | No |

Gates are deterministic bash scripts, not LLM judgment. Same code, same result. Each gate emits a `gate.executed` event to the event store, building an audit trail.

You can query convergence status at any time:

```
exarchos_orchestrate({ action: "check_convergence", featureId: "my-feature" })
```

This returns per-dimension status: how many gates ran, whether each dimension converged, and which dimensions lack coverage.

## Verdicts

After both stages complete, a verdict is computed from the gate results and finding counts:

**APPROVED** — All blocking gates pass. Informational findings are acceptable or minor. The workflow continues to synthesis, where a pull request is created.

**NEEDS_FIXES** — Blocking gate failures or too many informational findings. Findings are dispatched to fixer agents via `/delegate --fixes`. After fixes, review runs again. The cycle repeats up to three times before escalating to you.

**BLOCKED** — The implementation fundamentally diverges from the spec. Rare. The workflow returns to ideate for redesign.

## The Flow

```
delegate completes
  → Stage 1: spec compliance
    → pass? → Stage 2: code quality
      → pass? → APPROVED → synthesize (create PR)
      → fail? → NEEDS_FIXES → /delegate --fixes → review again
    → fail? → NEEDS_FIXES → /delegate --fixes → review again
```

All transitions are automatic. You do not need to do anything unless the verdict is BLOCKED, which requires a design discussion with you.

## Finding Severity

Findings from both stages are classified into three levels:

| Severity | Action | Examples |
|----------|--------|---------|
| HIGH | Must fix before merge | Security vulnerabilities, data loss risks, API contract breaks |
| MEDIUM | Should fix, may defer | SOLID violations, cyclomatic complexity above 15 |
| LOW | Tracked, not blocking | Naming, style, minor refactors |

HIGH findings in blocking dimensions trigger NEEDS_FIXES. LOW findings in informational dimensions are recorded in the audit trail but do not block the workflow.
