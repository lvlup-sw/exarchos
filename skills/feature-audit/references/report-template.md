# Feature Audit Report Template

Use this template for the human-readable report output alongside the structured JSON verdict.

```markdown
## Feature Audit Report

**Feature:** [name]
**Branch:** [branch]
**Auditor:** [agent/human]
**Date:** [ISO 8601]

### Verdict: [APPROVED | NEEDS_FIXES | BLOCKED]

### Quantitative Summary
| Dimension | Checks | Passed | Findings (H/M/L) |
|-----------|--------|--------|-------------------|
| D1: Spec Fidelity | X | Y | H/M/L |
| D2: Pattern Compliance | X | Y | H/M/L |
| D3: Context Economy | X | Y | H/M/L |
| D4: Operational Resilience | X | Y | H/M/L |
| D5: Workflow Determinism | X | Y | H/M/L |
| **Total** | **X** | **Y** | **H/M/L** |

### HIGH-Priority Findings
1. **[Title]**
   - Dimension: [D1-D5]
   - Criterion: [specific invariant or eval]
   - Evidence: [file:line, command output, or observation]
   - Required fix: [specific action]

### MEDIUM-Priority Findings
[Same format]

### LOW-Priority Findings
[Same format]

### Traceability Matrix (D1: Spec Fidelity)
| Requirement | Implementation | Test | Status |
|-------------|---------------|------|--------|
| [from design doc] | [file:line] | [test file:line] | PASS/FAIL |

### Recommendations
[Strategic observations that don't map to specific findings but improve the feature]
```
