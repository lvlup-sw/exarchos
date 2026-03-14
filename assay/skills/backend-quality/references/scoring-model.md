# Scoring Model

How findings are aggregated into a verdict. The plugin produces standalone verdicts (no workflow concepts). Workflow tools map plugin verdicts to their own status values.

## Plugin Verdict

```
if HIGH_count > 0:
    verdict = NEEDS_ATTENTION
elif MEDIUM_count > 5:
    verdict = NEEDS_ATTENTION
else:
    verdict = CLEAN
```

| Verdict | Meaning |
|---------|---------|
| **CLEAN** | No significant issues found. Code meets quality standards. |
| **NEEDS_ATTENTION** | Issues found that should be addressed. Review findings and prioritize fixes. |

## Per-Dimension Metrics

For each dimension, compute:

- **Pass rate:** `checks_passed / total_checks` (deterministic checks only)
- **Finding count:** total findings (deterministic + qualitative)
- **Severity distribution:** count of HIGH / MEDIUM / LOW findings

## Aggregate Metrics

- **Overall pass rate:** average of per-dimension pass rates (dimensions without deterministic checks are excluded)
- **Finding density:** `total_findings / files_analyzed` (lower is better)
- **Coverage:** `dimensions_assessed / 7` (should be 1.0 for a full audit)

## Health Thresholds

| Metric | Healthy | Concerning | Unhealthy |
|--------|---------|-----------|-----------|
| Overall pass rate | >90% | 70-90% | <70% |
| Finding density | <0.5 | 0.5-1.0 | >1.0 |
| HIGH count | 0 | 1-2 | >2 |
| Dimension coverage | 7/7 | 5-6/7 | <5/7 |

## Report Structure

```markdown
# Backend Quality Report

**Scope:** [scope assessed]
**Verdict:** [CLEAN | NEEDS_ATTENTION]
**Date:** [assessment date]

## Summary

| Dimension | Findings | HIGH | MED | LOW | Pass Rate |
|-----------|----------|------|-----|-----|-----------|
| Topology | N | N | N | N | N% |
| ... | | | | | |

**Aggregate:** N findings across N files (density: N.N)

## HIGH-Priority Findings
[Grouped findings with evidence and suggestions]

## MEDIUM-Priority Findings
[Grouped findings]

## LOW-Priority Findings
[Grouped findings]

## Dimensional Coverage
[Which dimensions were assessed, which were skipped and why]

## Recommendations
[Prioritized action items]
```

## Consumer Mapping

Workflow tools that consume assay verdicts should define their own mapping. Example:

| Plugin Verdict | Consumer Verdict | Condition |
|---------------|-----------------|-----------|
| CLEAN | APPROVED | No additional consumer-specific findings |
| NEEDS_ATTENTION | NEEDS_FIXES | Consumer wants fixes before merge |
| NEEDS_ATTENTION | BLOCKED | Consumer's domain-specific HIGH findings present |
