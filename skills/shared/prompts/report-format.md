# Standard Report Format

## Task Completion Report

When reporting task completion, use this format:

```markdown
## Task Complete: [Task ID]

### Files Modified
- `path/to/file.ts` - [Brief change description]
- `path/to/test.ts` - [Tests added]

### Tests
- **Added:** [Count] new tests
- **Status:** PASS / FAIL
- **Coverage:** [X]% (if available)

### TDD Verification
- [x] Test failed first (RED confirmed)
- [x] Test passes after implementation (GREEN confirmed)
- [x] No extra code beyond requirements

### Issues (if any)
- [Issue description and resolution]

### Status
**COMPLETE** / **BLOCKED** (reason)
```

## Review Report

When reporting review results:

```markdown
## Review: [Type] - [Task ID]

### Verdict
**PASS** / **FAIL** / **NEEDS_FIXES**

### Findings

#### HIGH Priority
1. [Issue] - File: `path:line` - Fix: [Required action]

#### MEDIUM Priority
1. [Issue] - File: `path:line` - Suggestion: [Recommended action]

#### LOW Priority
1. [Observation] - File: `path:line`

### Summary
[1-2 sentence summary of review results]
```
