---
name: spec-review
description: "Implementation-to-spec compliance verification (code review stage 1). Use during the review phase after delegation completes to compare implemented code against design specification. Checks functional completeness, TDD compliance, and test coverage. Do NOT use for code quality review (use quality-review) or debugging."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: review
---

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

Instead of per-worktree diffs, receive an integrated diff from the
integration branch (e.g., `feature/integration-branch`) against main:

```bash
# Generate integrated diff for review
git diff main...integration > /tmp/combined-diff.patch

# Alternative: use review-diff script against integration branch
~/.claude/scripts/review-diff.sh integration main
```

This provides the complete picture of all changes across all tasks and reduces context consumption by 80-90%.

## Review Scope

### Review Scope: Combined Changes

After delegation completes, spec review examines:
- The **complete integrated diff** (main...feature/integration branch)
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

For the full checklist with verification commands, tables, and report template, see `references/review-checklist.md`.

**Verification:**
```bash
npm run test:run
npm run test:coverage
npm run typecheck
scripts/check-tdd-compliance.sh --repo-root <repo-root> --base-branch main
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

Update workflow state with review results using `mcp__exarchos__exarchos_workflow` with `action: "set"`.

### On Review Complete

```text
# Update task review status - for pass
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "tasks[id=<task-id>].reviewStatus.specReview": "pass" }

# Or if failed:
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "tasks[id=<task-id>].reviewStatus.specReview": "fail" }

# Add review details
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: {
    "reviews.<task-id>.specReview": {"status": "pass", "issues": []}
  }
```

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
