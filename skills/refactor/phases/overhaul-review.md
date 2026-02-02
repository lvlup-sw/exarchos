# Overhaul Track: Review Emphasis

## Purpose

Define enhanced review criteria for refactoring to ensure behavior preservation and quality improvement.

## Context

When the `/review` skill processes a refactor workflow, it applies additional scrutiny beyond standard code review. This document defines those additional criteria.

## Detecting Refactor Context

The review skill checks workflow type:

```bash
type=$(~/.claude/scripts/workflow-state.sh get <state-file> '.type')
if [ "$type" = "refactor" ]; then
  # Apply refactor-specific review criteria
fi
```

## Refactor Review Criteria

### 1. Behavior Preservation (CRITICAL)

The primary goal of refactoring is changing structure WITHOUT changing behavior.

#### Public Interface Check

For each public interface (exported function, class method, API endpoint):

| Check | How to Verify |
|-------|---------------|
| Signature unchanged | Compare before/after type definitions |
| Return value equivalent | Test with same inputs |
| Side effects identical | Verify state changes match |
| Error cases same | Test error conditions |

```markdown
## Interface Preservation Report

| Interface | Signature | Returns | Side Effects | Errors |
|-----------|-----------|---------|--------------|--------|
| `UserService.create()` | ✓ Same | ✓ Same | ✓ Same | ✓ Same |
| `AuthMiddleware.verify()` | ✓ Same | ✓ Same | ✓ Same | ⚠️ New error type |
```

If behavior intentionally changed, it should be documented in the brief.

#### Test Coverage Comparison

```bash
# Compare test counts before and after
before_tests=$(git show main:package.json | jq '.scripts.test')
# Run tests and compare coverage
```

| Metric | Before | After | Status |
|--------|--------|-------|--------|
| Test count | 150 | 155 | ✓ Increased |
| Line coverage | 80% | 82% | ✓ Improved |
| Branch coverage | 75% | 78% | ✓ Improved |

### 2. Regression Risk Assessment

Evaluate risk of regressions in each changed area:

#### Risk Matrix

| Risk Factor | Low | Medium | High |
|-------------|-----|--------|------|
| Code age | New (<6mo) | Established (6mo-2yr) | Legacy (>2yr) |
| Test coverage | >80% | 50-80% | <50% |
| Dependencies | Internal only | Some external | Many external |
| Complexity change | Reduced | Same | Increased |

#### Risk Report

```markdown
## Regression Risk Assessment

| Area | Age | Coverage | Deps | Complexity | Overall Risk |
|------|-----|----------|------|------------|--------------|
| UserValidator | New | 90% | Internal | Reduced | LOW |
| AuthService | 2yr | 70% | External | Same | MEDIUM |
```

For MEDIUM or HIGH risk areas, require:
- Additional test coverage
- Manual testing verification
- Careful review of edge cases

### 3. Performance Verification

Refactors should not degrade performance.

#### Performance Checklist

- [ ] No new N+1 query patterns
- [ ] No unnecessary object allocations
- [ ] No blocking operations added
- [ ] Algorithmic complexity same or better
- [ ] Memory usage not increased

#### Spot Check Areas

| Pattern | Red Flag |
|---------|----------|
| Loops | New nested loops, large iterations |
| Database | New queries, removed indexes |
| Memory | Large object creation in loops |
| I/O | New file/network operations |

### 4. Code Quality Improvement

Refactors should IMPROVE quality. Verify:

#### Improvement Metrics

| Metric | Should Be |
|--------|-----------|
| Cyclomatic complexity | Same or lower |
| Function length | Same or shorter |
| Duplication | Reduced |
| Coupling | Same or lower |
| Cohesion | Same or higher |

```markdown
## Quality Metrics

| Area | Before | After | Change |
|------|--------|-------|--------|
| Avg function length | 45 lines | 25 lines | ✓ Improved |
| Max complexity | 15 | 8 | ✓ Improved |
| Duplicate blocks | 12 | 4 | ✓ Improved |
```

### 5. Goal Achievement Verification

Cross-reference review findings with brief goals:

```markdown
## Goal Verification

| Goal (from brief) | Achieved | Evidence |
|-------------------|----------|----------|
| Extract validation to separate class | ✓ | UserValidator created |
| Reduce UserService to <200 lines | ✓ | Now 150 lines |
| Add unit tests for validation | ✓ | 15 new tests |
```

Any goal NOT achieved should be flagged for resolution.

## Review Outcome

### Pass Criteria

All must be true:
- [ ] Behavior preserved (or changes documented)
- [ ] No HIGH regression risk areas unaddressed
- [ ] No performance degradation
- [ ] Quality metrics improved or maintained
- [ ] All brief goals achieved

### Fail Reasons

| Reason | Required Action |
|--------|-----------------|
| Behavior change | Document intentional change or fix |
| High regression risk | Add tests or manual verification |
| Performance regression | Optimize or justify |
| Quality degradation | Fix or provide justification |
| Goal not achieved | Complete or update brief |

## Review Report Template

```markdown
# Refactor Review Report

**Workflow:** <feature-id>
**Reviewer:** <agent/human>
**Date:** <ISO8601>

## Summary
<Overall assessment: PASS / FAIL>

## Behavior Preservation
<Findings>

## Regression Risk
<Risk assessment>

## Performance
<Performance notes>

## Quality Metrics
<Before/after comparison>

## Goal Achievement
<Goal verification>

## Required Actions
<If any>

## Recommendation
<Approve / Request Changes / Reject>
```

## State Update

### Review Pass
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.reviews.<id> = {
    "status": "passed",
    "behaviorPreserved": true,
    "regressionRisk": "low",
    "goalsAchieved": true,
    "completedAt": "<ISO8601>"
  } | .phase = "update-docs"'
```

### Review Fail
```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.reviews.<id> = {
    "status": "failed",
    "findings": ["<finding1>", "<finding2>"],
    "requiredActions": ["<action1>"]
  }'
```
