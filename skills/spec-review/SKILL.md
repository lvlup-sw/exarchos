# Spec Review Skill

## Overview

Stage 1 of two-stage review: Verify implementation matches specification and follows TDD.

## Triggers

Activate this skill when:
- User runs `/review` command (first stage)
- Task implementation is complete
- Need to verify spec compliance before quality review
- Subagent reports task completion

## Execution Context

This skill runs in a SUBAGENT spawned by the orchestrator, not inline.

The orchestrator provides:
- State file path (preferred) OR design/plan paths
- Diff output from `~/.claude/scripts/review-diff.sh` (context-efficient)
- Task ID being reviewed

The subagent:
- Reads state file to get artifact paths
- Uses diff output instead of reading full files
- Runs verification commands
- Generates report
- Returns verdict to orchestrator

### Context-Efficient Input

Instead of per-worktree diffs, receive a combined diff:

```bash
# Generate diff for review (feature branch vs main)
git diff main...HEAD > /tmp/combined-diff.patch

# Alternative: use review-diff script
~/.claude/scripts/review-diff.sh HEAD main
```

This provides the complete picture of all changes across all tasks and reduces context consumption by 80-90%.

## Review Scope

### Review Scope: Combined Changes

After delegation completes, spec review examines:
- The **complete combined diff** (main...feature-branch)
- All changes across all tasks in one view
- The full picture of combined functionality

This enables catching:
- Cross-task interface mismatches
- Bugs not visible in isolation
- Combined behavior vs specification

**Spec Review focuses on:**
- Functional completeness
- TDD compliance
- Specification alignment
- Test coverage

**Does NOT cover (that's Quality Review):**
- Code style
- SOLID principles
- Performance optimization
- Error handling elegance

## Review Checklist

### 1. Functional Completeness

| Check | Verify |
|-------|--------|
| All requirements implemented | Compare to spec/plan |
| No missing features | Cross-reference task list |
| Correct behavior | Run manual verification |
| Edge cases handled | Check spec edge cases |

### 2. TDD Compliance

| Check | Verify |
|-------|--------|
| Tests exist for all features | Grep for test files |
| Tests written first | Check git history order |
| Tests are meaningful | Not just "expect true" |
| Test naming convention | `Method_Scenario_Outcome` |

**Verification Commands:**
```bash
# Check test file exists
ls src/**/*.test.ts

# Run tests
npm run test:run

# Check coverage
npm run test:coverage
```

### 3. Specification Alignment

Compare implementation to:
- Original design document
- Implementation plan tasks
- Acceptance criteria

**Questions to answer:**
- Does it do what was specified?
- Does it do MORE than specified? (over-engineering)
- Does it do LESS than specified? (incomplete)

### 4. Test Coverage

| Metric | Threshold |
|--------|-----------|
| Line coverage | >80% for new code |
| Branch coverage | >70% for new code |
| Function coverage | 100% for public APIs |

## Review Process

### Step 1: Gather Artifacts

```markdown
## Review Artifacts

- Design: `docs/designs/YYYY-MM-DD-feature.md`
- Plan: `docs/plans/YYYY-MM-DD-feature.md`
- Implementation: `src/feature/`
- Tests: `src/feature/*.test.ts`
```

### Step 2: Run Verification

```bash
# Run all tests
npm run test:run

# Check coverage
npm run test:coverage

# Run type check
npm run typecheck
```

### Step 3: Compare to Spec

Read design/plan and verify each requirement:

```markdown
## Spec Compliance

| Requirement | Implemented | Test Exists | Notes |
|-------------|-------------|-------------|-------|
| User can login | YES | YES | |
| Email validation | YES | YES | |
| Rate limiting | NO | NO | MISSING |
```

### Step 4: Generate Report

```markdown
## Spec Review Report

### Summary
- Status: [PASS | FAIL | NEEDS_FIXES]
- Tested: [timestamp]
- Reviewer: Claude Code

### Compliance Matrix
[Table from Step 3]

### Issues Found
1. [Issue description]
   - File: `path/to/file.ts`
   - Expected: [spec requirement]
   - Actual: [current behavior]
   - Fix: [required change]

### Missing Items
- [ ] [Feature not implemented]

### Verdict
[PASS] Ready for quality review
[FAIL] Return to implementer with fix list
```

## Fix Loop

If review FAILS:

1. Create fix task with specific issues
2. Dispatch to implementer (same or new)
3. Re-review after fixes
4. Repeat until PASS

```typescript
// Return to implementer
Task({
  model: "opus",
  description: "Fix spec review issues",
  prompt: `
# Fix Required: Spec Review Failed

## Issues to Fix
1. Missing rate limiting implementation
   - Add rate limiter middleware
   - Test: RateLimiter_ExceedsLimit_Returns429

2. Email validation incomplete
   - Add MX record check
   - Test: ValidateEmail_InvalidDomain_ReturnsError

## Success Criteria
- All tests pass
- Coverage >80%
- All issues resolved
`
})
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip to quality review | Complete spec review first |
| Accept incomplete work | Return for fixes |
| Review code style here | Save for quality review |
| Approve without tests | Require test coverage |
| Let scope creep pass | Flag over-engineering |

## State Management

Update workflow state with review results using `mcp__exarchos__exarchos_workflow_set`.

### On Review Complete

```text
# Update task review status - for pass
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "tasks[id=<task-id>].reviewStatus.specReview": "pass" }

# Or if failed:
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "tasks[id=<task-id>].reviewStatus.specReview": "fail" }

# Add review details
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: {
    "reviews.<task-id>.specReview": {"status": "pass", "issues": []}
  }
```

## Completion Criteria

- [ ] All spec requirements verified
- [ ] TDD compliance confirmed
- [ ] Tests pass
- [ ] Coverage meets thresholds
- [ ] No missing functionality
- [ ] State file updated with review results

## Transition

All transitions happen **immediately** without user confirmation:

### If PASS:
1. Update state with review results
2. Output: "Spec review passed. Auto-continuing to quality review..."
3. Orchestrator dispatches quality-review subagent immediately

### If FAIL:
1. Update state with failed issues
2. Output: "Spec review found [N] issues. Auto-continuing to fixes..."
3. Auto-invoke delegate with fix tasks:
   ```typescript
   Skill({ skill: "delegate", args: "--fixes <plan-path>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.
