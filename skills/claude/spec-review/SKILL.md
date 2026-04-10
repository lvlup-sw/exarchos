---
name: spec-review
description: "Stage 1 spec compliance review. Triggers: /review stage 1. Verifies implementation matches design specification — functional completeness, TDD compliance, and test coverage. Do NOT use for code quality checks — use quality-review instead. Do NOT use for debugging."
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

For a complete worked example, see `references/worked-example.md`.

> **MANDATORY:** Before accepting any rationalization for approving without full verification, consult `references/rationalization-refutation.md`. Every common excuse is catalogued with a counter-argument and the correct action.

## Triggers

Activate this skill when:
- User runs `/exarchos:review` command (first stage)
- Task implementation is complete
- Need to verify spec compliance before quality review
- Subagent reports task completion

## Execution Context

This skill runs in a SUBAGENT spawned by the orchestrator, not inline.

The orchestrator provides:
- State file path (preferred) OR design/plan paths
- Diff output from `exarchos_orchestrate({ action: "review_diff" })` (context-efficient)
- Task ID being reviewed

The subagent:
- Reads state file to get artifact paths
- Uses diff output instead of reading full files
- Runs verification commands
- Generates report
- Returns verdict to orchestrator

### Data Handoff Protocol

The **orchestrator** is responsible for generating the diff before dispatching the spec-review subagent. The subagent does NOT generate its own diff.

**Orchestrator responsibilities:**
1. Generate diff: `exarchos_orchestrate({ action: "review_diff", worktreePath: "<worktree-path>", baseBranch: "main" })`
2. Pass diff content in the subagent dispatch prompt
3. Include state file path for artifact resolution

**Subagent responsibilities:**
1. Receive diff content from dispatch prompt (do NOT re-generate)
2. Read state file for design/plan artifact paths
3. Run verification commands against the working tree
4. Return structured JSON verdict

### Context-Efficient Input

Instead of per-worktree diffs, receive an integrated diff from the
integration branch (e.g., `feature/integration-branch`) against main:

```bash
# Generate integrated diff for review
git diff main...integration > /tmp/combined-diff.patch

# Alternative: use review-diff script against integration branch via orchestrate
# exarchos_orchestrate({ action: "review_diff", worktreePath: "<worktree-path>", baseBranch: "main" })
```

This provides the complete picture of all changes across all tasks and reduces context consumption by 80-90%.

### Pre-Review Schema Discovery

Before evaluating, query the review strategy runbook to determine the appropriate evaluation approach:

- **Evaluation strategy:** `exarchos_orchestrate({ action: "runbook", id: "review-strategy" })` to determine the review approach based on diff scope, prior fix cycles, and review stage.

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
```

```typescript
exarchos_orchestrate({
  action: "check_tdd_compliance",
  featureId: "<featureId>",
  taskId: "<taskId>",
  branch: "<branch>"
})
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

## Required Output Format

The subagent MUST return results as structured JSON. The orchestrator parses this JSON to populate state. Any other format is an error.

```json
{
  "verdict": "pass | fail | blocked",
  "summary": "1-2 sentence summary",
  "issues": [
    {
      "severity": "HIGH | MEDIUM | LOW",
      "category": "spec | tdd | coverage",
      "file": "path/to/file",
      "line": 123,
      "description": "Issue description",
      "required_fix": "What must change"
    }
  ],
  "test_results": {
    "passed": 0,
    "failed": 0,
    "coverage_percent": 0
  }
}
```

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip to quality review | Complete spec review first |
| Accept incomplete work | Return for fixes |
| Review code style here | Save for quality review |
| Approve without tests | Require test coverage |
| Let scope creep pass | Flag over-engineering |

## Cross-Task Integration Issues

If an issue spans multiple tasks:
1. Classify as "cross-task integration"
2. Create fix task specifying ALL affected tasks
3. Dispatch fix to implementer with context from all affected tasks
4. Mark original tasks as blocked until cross-task fix completes

## State Management

### On Review Complete

**Pass:**
```
action: "set", featureId: "<id>", updates: {
  "reviews": { "spec-review": { "status": "pass", "summary": "...", "issues": [] } }
}
```

**Fail:**
```
action: "set", featureId: "<id>", updates: {
  "reviews": { "spec-review": { "status": "fail", "summary": "...", "issues": [{ "severity": "...", "file": "...", "description": "..." }] } }
}
```

> **Important:** The review value MUST be an object with a `status` field (e.g., `{ "status": "pass" }`), not a flat string (e.g., `"pass"`). The `all-reviews-passed` guard silently ignores non-object entries. Accepted statuses: `pass`, `passed`, `approved`, `fixes-applied`.

### Phase Transitions and Guards

For the full transition table, consult `@skills/workflow-state/references/phase-transitions.md`.

**Quick reference:**
- `review` → `synthesize` requires guard `all-reviews-passed` — all `reviews.{name}.status` must be passing
- `review` → `delegate` requires guard `any-review-failed` — triggers fix cycle when any review fails

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. Use
`exarchos_orchestrate({ action: "describe", actions: ["check_tdd_compliance", "check_static_analysis"] })`
for orchestrate action schemas.

## Transition

All transitions happen **immediately** without user confirmation:

### Pre-Chain Validation (MANDATORY)

Before invoking quality-review:
1. Verify `reviews["spec-review"].status === "pass"` in workflow state (all tasks passed)
2. If not: "Spec review did not pass, cannot proceed to quality review"

> **Guard shape:** The `all-reviews-passed` guard requires `reviews["spec-review"]` to be an object with a `status` field set to a passing value (`pass`, `passed`, `approved`, `fixes-applied`). Flat strings like `reviews: { "spec-review": "pass" }` are silently ignored and will block the `review → synthesize` transition.

### If PASS:
1. Record results — the reviews value MUST be an object with a `status` field, not a flat string:
   ```
   exarchos_workflow({ action: "set", featureId: "<id>", updates: {
     reviews: { "spec-review": { status: "pass", summary: "...", issues: [] } }
   }})
   ```
2. Output: "Spec review passed. Auto-continuing to quality review..."
3. Orchestrator dispatches quality-review subagent immediately

> **Gate events:** Do NOT manually emit `gate.executed` events via `exarchos_event`. Gate events are automatically emitted by the `check_review_verdict` orchestrate handler. Manual emission causes duplicates.

### If FAIL:
1. Record results with failing status and issue details:
   ```
   exarchos_workflow({ action: "set", featureId: "<id>", updates: {
     reviews: { "spec-review": { status: "fail", summary: "...", issues: [{ severity: "HIGH", file: "...", description: "..." }] } }
   }})
   ```
2. Output: "Spec review found [N] issues. Auto-continuing to fixes..."
3. Auto-invoke delegate with fix tasks:
   ```typescript
   Skill({ skill: "exarchos:delegate", args: "--fixes <plan-path>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.

## Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|------------|
| Test file not found | Task didn't create expected test | Check plan for test file paths, verify worktree contents |
| Coverage below threshold | Implementation incomplete or tests superficial | Add missing test cases, verify assertions are meaningful |
| TDD compliance check fails | Implementation committed before tests | Check git log order — test commits must precede or accompany implementation |
| Diff too large for context | Many tasks with large changes | Generate per-worktree diffs with `exarchos_orchestrate({ action: "review_diff", worktreePath: "<task-worktree>" })` to review incrementally |

## Performance Notes

- Use the integrated diff (`exarchos_orchestrate({ action: "review_diff" })`) instead of reading full files — reduces context by 80-90%
- Review per-task when the combined diff exceeds 2,000 lines
- Run TDD compliance check (`exarchos_orchestrate({ action: "check_tdd_compliance" })`) in parallel with spec tracing
