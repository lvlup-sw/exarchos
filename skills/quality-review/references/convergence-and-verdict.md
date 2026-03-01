# Convergence Check & Verdict Determination

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
