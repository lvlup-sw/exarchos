# Overhaul Track: Review Phase

## Purpose

Quality review with refactor-specific criteria for behavior preservation, regression detection, and goal verification.

## Entry Conditions

- Track is `overhaul`
- Integration phase passed
- All tasks complete
- Ready for review

## Refactor-Specific Review Emphasis

Refactors require additional scrutiny beyond standard quality review because:
- Behavior must be preserved exactly (unless intentionally changed)
- Regressions are easy to introduce and hard to detect
- Brief goals must be explicitly verified

## Behavior Preservation Checks

### 1. Method Signature Analysis

| Check | Verify | Priority |
|-------|--------|----------|
| Parameter types unchanged | Same types or compatible widening | HIGH |
| Return types unchanged | Same type or compatible narrowing | HIGH |
| Parameter order preserved | No accidental reordering | HIGH |
| Optional parameters | Same defaults, same optionality | MEDIUM |
| Overloads preserved | All overloads still present | HIGH |

**Detection:**
```bash
# Compare method signatures before/after
git diff main...HEAD -- "*.ts" | grep -E "^[+-].*function|^[+-].*class|^[+-].*interface"
```

### 2. Return Value Equivalence

| Aspect | Check For |
|--------|-----------|
| Same values | Identical return for same inputs |
| Same types | No implicit type changes |
| Same null behavior | Null/undefined handling unchanged |
| Same error conditions | Same inputs cause same errors |

**Verification approach:**
- Review test assertions for return values
- Check edge case handling
- Verify null/undefined paths unchanged

### 3. Side Effect Preservation

| Side Effect | Verify Unchanged |
|-------------|-----------------|
| State mutations | Same state changes occur |
| Event emissions | Same events fired in same order |
| External calls | Same API/DB calls made |
| Logging | Same log outputs (unless intentional) |
| File operations | Same I/O patterns |

### 4. Error Handling Consistency

| Check | Verify |
|-------|--------|
| Exception types | Same exceptions thrown |
| Exception conditions | Same inputs trigger errors |
| Error messages | Equivalent messaging |
| Catch behavior | Same errors caught/propagated |

## Intentional Changes Documentation

If behavior changes are intentional, they MUST be:
1. Documented in the brief goals
2. Covered by updated tests
3. Explicitly noted in review

**Intentional change checklist:**
- [ ] Change documented in brief
- [ ] Old behavior tests updated
- [ ] New behavior tests added
- [ ] Breaking change noted (if public API)

## Regression Risk Assessment

Evaluate each area touched by refactor:

| Risk Level | Criteria | Action |
|------------|----------|--------|
| **HIGH** | Public API changes, core logic, data handling | Extra scrutiny, explicit test verification |
| **MEDIUM** | Internal interfaces, shared utilities | Verify dependent code paths |
| **LOW** | Private methods, isolated modules | Standard review |

### Area-by-Area Assessment

For each file/component changed:

```markdown
## Regression Risk: <Component>

**Files touched:** `path/to/files`
**Risk level:** [HIGH | MEDIUM | LOW]

**Changed behavior (intentional):**
- [List any intentional changes]

**Regression indicators:**
- [ ] All existing tests pass
- [ ] No test assertions changed unexpectedly
- [ ] Dependent components verified
- [ ] Edge cases still covered
```

## Performance Considerations

Refactors should not degrade performance:

| Check | Verify |
|-------|--------|
| Algorithm complexity | No O(n) to O(n^2) regressions |
| Memory allocation | No excessive new allocations |
| Loop iterations | No added unnecessary iterations |
| Async patterns | No blocking where async expected |
| Database queries | No N+1 introductions |

**Red flags:**
- New loops inside existing loops
- Removed caching/memoization
- Added synchronous I/O
- Removed batching

## Goal Verification

Every goal from the brief must be verified as achieved.

### Goal Verification Matrix

| Brief Goal | Evidence | Status |
|------------|----------|--------|
| <goal 1> | <test/code reference> | [PASS | FAIL] |
| <goal 2> | <test/code reference> | [PASS | FAIL] |
| <goal 3> | <test/code reference> | [PASS | FAIL] |

**Goal verification process:**
1. Re-read brief goals
2. Find implementation of each
3. Verify test coverage for each
4. Document evidence

## Review Checklist

### Pre-Review
- [ ] Integration tests pass
- [ ] All tasks marked complete
- [ ] Brief goals accessible

### Behavior Preservation
- [ ] Method signatures analyzed
- [ ] Return value equivalence checked
- [ ] Side effects reviewed
- [ ] Error handling verified
- [ ] Intentional changes documented

### Regression Assessment
- [ ] Each component risk-assessed
- [ ] All existing tests pass (unchanged)
- [ ] No unexpected test changes
- [ ] Dependent code paths verified

### Performance
- [ ] No obvious complexity regressions
- [ ] No removed optimizations
- [ ] Memory patterns acceptable
- [ ] Async patterns preserved

### Goal Achievement
- [ ] All brief goals mapped to implementation
- [ ] Each goal has test coverage
- [ ] No goals left unaddressed

### Quality Standards
- [ ] Standard quality review criteria (see quality-review/SKILL.md)
- [ ] SOLID principles maintained or improved
- [ ] Code readability maintained or improved

## Report Template

```markdown
## Overhaul Review Report

### Summary
- Status: [APPROVED | NEEDS_FIXES | BLOCKED]
- Track: overhaul
- Brief: <brief-name>
- Reviewed: [timestamp]

### Behavior Preservation
| Area | Status | Notes |
|------|--------|-------|
| Method signatures | [OK | CHANGED] | |
| Return values | [OK | CHANGED] | |
| Side effects | [OK | CHANGED] | |
| Error handling | [OK | CHANGED] | |

### Intentional Changes
[List any intentional behavior changes with justification]

### Regression Risk Assessment
| Component | Risk | Status |
|-----------|------|--------|
| <component> | [HIGH | MED | LOW] | [PASS | CONCERN] |

### Goal Verification
| Brief Goal | Achieved | Evidence |
|------------|----------|----------|
| <goal 1> | [YES | NO] | <reference> |

### Findings

#### HIGH Priority (Must Fix)
1. [Finding title]
   - File: `path/to/file.ts:42`
   - Issue: [Description]
   - Fix: [Required change]

#### MEDIUM Priority (Should Fix)
1. [Finding title]
   - Issue: [Description]
   - Suggestion: [Recommended change]

### Verdict
[APPROVED] Refactor goals achieved, behavior preserved
[NEEDS_FIXES] Issues found, return to delegate
[BLOCKED] Fundamental problem requires brief revision
```

## State Updates

### On Review Complete

```bash
# Record review results
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.reviews.overhaul = {
    "status": "approved",
    "behaviorPreserved": true,
    "goalsVerified": true,
    "regressionRisk": "low",
    "timestamp": "<timestamp>"
  }'
```

### On Approval

```bash
~/.claude/scripts/workflow-state.sh set <state-file> '.phase = "synthesize"'
```

### On Needs Fixes

```bash
~/.claude/scripts/workflow-state.sh set <state-file> \
  '.reviews.overhaul.status = "needs_fixes" | .reviews.overhaul.issues = [<issue-list>]'
```

## Transition

### If APPROVED:
1. Update state: `.phase = "synthesize"`
2. Output: "Overhaul review passed. All goals achieved, behavior preserved. Auto-continuing to synthesis..."
3. Auto-invoke:
   ```typescript
   Skill({ skill: "synthesize", args: "<feature-name>" })
   ```

### If NEEDS_FIXES:
1. Update state with issues
2. Output: "Overhaul review found issues. Auto-continuing to fixes..."
3. Auto-invoke:
   ```typescript
   Skill({ skill: "delegate", args: "--fixes <plan-path>" })
   ```

### If BLOCKED:
1. Update state: `.phase = "blocked"`
2. Output: "Overhaul review blocked: [issue]. Returning to brief..."
3. Prompt for brief revision

## Exit Conditions

- [ ] All behavior preservation checks pass
- [ ] Regression risk assessed and acceptable
- [ ] All brief goals verified achieved
- [ ] Standard quality review criteria met
- [ ] State updated with review results
