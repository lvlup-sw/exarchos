# RCA Template

Use this template when documenting root cause analysis for bugs.

## Template

```markdown
# RCA: [Issue Title]

## Summary

[1-2 sentences: What broke and why]

## Symptom

[How the bug manifested - error messages, behavior, user reports]

### Reproduction Steps

1. [Step 1]
2. [Step 2]
3. [Step N]

### Observed Behavior

[What happened]

### Expected Behavior

[What should have happened]

## Root Cause

[Technical explanation of why this happened]

### Code Location

File: `[path/to/file.ts]`
Line: [N]

### Analysis

[Detailed technical analysis of the bug mechanism]

## Contributing Factors

[What conditions allowed this bug to exist/ship]

- [ ] Missing test coverage
- [ ] Inadequate code review
- [ ] Unclear requirements
- [ ] Race condition / timing issue
- [ ] Edge case not considered
- [ ] External dependency failure
- [ ] Configuration error
- [ ] Other: [describe]

## Fix Approach

[High-level approach to fixing - not full implementation details]

### Changes Required

| File | Change |
|------|--------|
| `path/to/file.ts` | [Brief description] |

### Risks

[Any risks introduced by the fix]

## Prevention

[How to prevent similar issues in future]

### Immediate Actions

- [ ] [Action 1]
- [ ] [Action 2]

### Long-term Improvements

- [ ] [Improvement 1]
- [ ] [Improvement 2]

## Timeline

| Event | Date | Notes |
|-------|------|-------|
| Reported | YYYY-MM-DD | [How it was reported] |
| Investigated | YYYY-MM-DD | [Time spent] |
| Fixed | YYYY-MM-DD | [PR/commit reference] |
| Verified | YYYY-MM-DD | [How verified in production] |

## Related

- Issue: [link or N/A]
- PR: [link or N/A]
- Related RCAs: [links or N/A]
```

## Usage

1. Copy template to `docs/rca/YYYY-MM-DD-<issue-slug>.md`
2. Fill in all sections during investigation
3. Update timeline as work progresses
4. Link to PR when fix is merged

## Naming Convention

`YYYY-MM-DD-<issue-slug>.md`

Examples:
- `2026-01-27-null-user-session.md`
- `2026-01-27-api-timeout-on-large-payload.md`
- `2026-01-27-login-redirect-loop.md`

## Abbreviated Template (Hotfix Follow-up)

For RCAs created after a hotfix, use this abbreviated version:

```markdown
# RCA: [Issue Title]

## Summary

[What broke and the quick fix applied]

## Hotfix Reference

- State file: `docs/workflow-state/debug-<issue>.state.json`
- Commit: [hash]
- Date: YYYY-MM-DD

## Root Cause

[Now that you have time, document the actual root cause]

## Why Hotfix Worked

[Explain why the quick fix resolved the symptom]

## Proper Fix (if needed)

[If the hotfix was not the ideal solution, document what should be done]

## Prevention

[How to prevent similar issues]
```
