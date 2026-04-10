# Quality Review Report Template

Use this template to structure the output of Step 3 (Generate Report) in the quality review process.

## Template

```markdown
## Quality Review Report

### Summary
- Status: [APPROVED | NEEDS_FIXES | BLOCKED]
- Reviewed: [timestamp]
- Reviewer: Claude Code

### Findings Summary

| Severity | Category | File:Line | Issue |
|----------|----------|-----------|-------|
| HIGH | [category] | `path/to/file.ts:42` | [Brief description] |
| MEDIUM | [category] | `path/to/file.ts:88` | [Brief description] |
| LOW | [category] | `path/to/file.ts:15` | [Brief description] |

### Findings Detail

#### HIGH-Priority
1. [Finding title]
   - File: `path/to/file.ts:42`
   - Category: [security | correctness | performance | maintainability]
   - Current: [What the code does now]
   - Fix: [Required change]

#### MEDIUM-Priority
1. [Finding title]
   - File: `path/to/file.ts:88`
   - Category: [security | correctness | performance | maintainability]
   - Current: [What the code does now]
   - Suggestion: [Recommended change]

#### LOW-Priority
1. [Finding title]
   - File: `path/to/file.ts:15`
   - Category: [style | documentation | optimization]
   - Note: [Observation]

### Verdict
[APPROVED] Ready for synthesis
[NEEDS_FIXES] Fix HIGH-priority items, then re-review
[BLOCKED] Critical issues require design discussion
```

## Verdict Criteria

| Verdict | Condition |
|---------|-----------|
| **APPROVED** | No HIGH-priority findings; MEDIUM/LOW acceptable |
| **NEEDS_FIXES** | One or more HIGH-priority findings that must be resolved |
| **BLOCKED** | Critical architectural or security issues requiring design discussion |

## Report Guidelines

- List every finding with file path and line number
- HIGH-priority findings must include a concrete fix description
- MEDIUM priority findings should include a suggested approach
- LOW priority findings are observations for future improvement
- The verdict drives the next workflow transition (synthesize, fix loop, or redesign)
