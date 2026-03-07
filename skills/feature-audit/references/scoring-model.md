# Scoring Model & Verdict Classification

## Severity Tiers

| Tier | Definition | Examples | Disposition |
|------|-----------|----------|-------------|
| **HIGH** | Violates canonical pattern invariant, risks data loss, breaks correctness, or defeats the purpose of the architectural pattern | Mutating events, unguarded HSM transitions, non-idempotent compensation, unbounded caches, read path scanning raw events | Must fix before merge |
| **MEDIUM** | Degrades quality, performance, or maintainability but doesn't break correctness. Accumulation indicates systemic issues. | Missing event metadata, Zod on hot paths, skill over word budget, generative selection, missing snapshot strategy | Should fix; may defer with justification |
| **LOW** | Polish items, minor inefficiencies, or aspirational improvements | Orphaned checkpoints, scarcity signaling, overhead justification | Track for future; do not block |

## Verdict Classification

Convergence is **conjunctive** — all five dimensions must independently pass. A high score in one dimension cannot compensate for failure in another.

```
if HIGH_count > 0:
    verdict = "NEEDS_FIXES"                    # remediation loop
    if any HIGH violates append-only, state derivability, or terminal reachability:
        verdict = "BLOCKED"                    # return to design
elif MEDIUM_count > 5:
    verdict = "NEEDS_FIXES"                    # accumulated degradation
else:
    verdict = "APPROVED"                       # converged
```

## Workflow Effect

- `APPROVED` -> Advance to `/synthesize` (terminal convergence achieved)
- `NEEDS_FIXES` -> Remediation loop (stay in review, fix findings, re-evaluate)
- `BLOCKED` -> Return to design phase (fundamental dimension failure)

## Quantitative Summary

For each dimension, compute:
- **Pass rate** = checks passed / total checks (deterministic only)
- **Finding density** = total findings / files changed
- **Severity distribution** = HIGH / MEDIUM / LOW counts

A healthy feature audit has: pass rate >90%, finding density <0.5, HIGH count = 0.

## Orchestrate Integration

Compute verdict via orchestrate rather than manually:

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
    "D3": { passed: true, findingCount: 0 },
    "D4": { passed: true, findingCount: 0 },
    "D5": { passed: true, findingCount: 0 }
  }
})
```

The handler automatically emits per-dimension and summary `gate.executed` events. No manual event emission needed.
