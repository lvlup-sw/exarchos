# Audit Composition Guide

How the `audit` skill orchestrates other assay skills to produce a unified report.

## Skill Discovery

The audit skill invokes a fixed set of specialized skills:

| Order | Skill | Dimensions Covered |
|-------|-------|--------------------|
| 1 | `assay:scan` | All (deterministic) |
| 2 | `assay:critique` | Architecture, Topology |
| 3 | `assay:harden` | Observability, Resilience |
| 4 | `assay:distill` | Hygiene, Topology |
| 5 | `assay:verify` | Test Fidelity, Contracts |

**Execution order matters:** `scan` runs first so specialized skills can reference its deterministic findings when layering qualitative assessment.

## Finding Deduplication

When aggregating findings from multiple skills, apply these rules in order:

### Rule 1: Same Evidence + Same Dimension → Merge

Two findings with identical `evidence` arrays and the same `dimension` are duplicates. Keep the one with the longer `explanation`. If lengths are equal, prefer the deterministic finding.

### Rule 2: Same Evidence + Different Dimensions → Keep Both

A single code location can violate multiple dimensions. For example, a lazy fallback constructor (DIM-1: Topology) may also be a silent error (DIM-2: Observability). Keep both findings — they represent genuinely different concerns.

### Rule 3: Same Pattern + Different Files → Keep Separate

The same anti-pattern in two different files is two separate findings. Each location needs independent attention.

### Rule 4: Deterministic + Qualitative → Merge as Deterministic

When `scan` and a qualitative skill both flag the same issue, merge them. The deterministic finding grounds the qualitative assessment. Set `deterministic: true` on the merged finding.

## Coverage Matrix

After deduplication, compute the coverage matrix:

```
For each dimension (DIM-1 through DIM-7):
  - deterministic_checks: count of scan checks run for this dimension
  - qualitative_assessed: was a specialized skill invoked for this dimension?
  - finding_count: total findings (post-dedup)
  - severity_distribution: { HIGH: N, MEDIUM: N, LOW: N }
```

Flag dimensions with `deterministic_checks == 0 && finding_count == 0` as potentially unassessed.

## Partial Failure Handling

If a skill encounters an error during execution:

1. **Catch the error** — do not abort the entire audit
2. **Record the failure** — note which skill failed and why
3. **Continue with remaining skills** — partial results are better than no results
4. **Report the failure** — include a "Skill Failures" section in the report

```markdown
## Skill Failures

- **assay:critique** — Error: [error message]. Architecture and Topology dimensions may have incomplete coverage.
```

5. **Adjust coverage matrix** — mark the failed skill's dimensions as partially assessed

## Report Assembly

### Verdict Computation

```typescript
const HIGH_count = findings.filter(f => f.severity === 'HIGH').length;
const MEDIUM_count = findings.filter(f => f.severity === 'MEDIUM').length;

const verdict = (HIGH_count > 0 || MEDIUM_count > 5)
  ? 'NEEDS_ATTENTION'
  : 'CLEAN';
```

### Finding Ordering

Within each severity tier, order findings by:
1. Dimension (DIM-1 first, DIM-7 last)
2. Evidence file path (alphabetical)
3. Evidence line number (ascending)

### Recommendations

Generate 3-5 prioritized recommendations based on findings:
1. Address all HIGH findings first
2. Group related MEDIUM findings into themes
3. Suggest targeted skill runs for dimensions with many findings
4. If coverage gaps exist, recommend running specific skills

## Consumer Integration

Workflow tools that consume audit results should:

1. Parse the verdict (CLEAN / NEEDS_ATTENTION)
2. Map to their own status values (see scoring-model.md Consumer Mapping)
3. Optionally extract individual findings for issue creation
4. Use the coverage matrix to identify assessment gaps
