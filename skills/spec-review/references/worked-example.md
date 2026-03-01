---
name: spec-review-worked-example
description: "Complete trace of the spec review skill in action, showing happy path and false-positive correction."
---

# Worked Example: Spec Review — Workflow Transition Validation

## Context

Feature: HSM phase transition guards for the Exarchos MCP server. The orchestrator dispatches a spec-review subagent after all tasks complete. The subagent receives the integrated diff and the state file path.

## Inputs Received

- **Diff:** `git diff main...feature/hsm-guards` (420 lines)
- **State file:** Contains design path, plan path, and 4 completed tasks
- **Task ID:** Combined review (all tasks)

## Step 1: Read Spec Artifacts

Subagent reads design (`docs/designs/2026-02-15-hsm-guards.md`) and plan (`docs/plans/2026-02-16-hsm-guards.md`) from state. Design specifies 5 guard conditions; plan decomposes into 4 tasks with 12 TDD test cases.

## Step 2: Run Verification Commands

```
npm run test:run          — 47 passed, 0 failed
npm run test:coverage     — 89% line, 82% branch
npm run typecheck          — clean
scripts/check-tdd-compliance.sh — exit 0
```

All automated checks pass.

## Step 3: Trace Spec to Implementation

Subagent maps each design requirement to diff hunks:

| Requirement | Found in Diff | Test Exists |
|-------------|--------------|-------------|
| Guard: `planReviewComplete` | Yes — `guards.ts:34` | Yes |
| Guard: `allTasksComplete` | Yes — `guards.ts:52` | Yes |
| Guard: `allReviewsPassed` | Yes — `guards.ts:68` | Yes |
| Guard: `docsUpdated` | Yes — `guards.ts:81` | Yes |
| Error message on guard failure | **NOT FOUND** | No |

## Gap Found

Design specifies: "Guards must return descriptive error messages on failure." The implementation returns `false` without messages. This is a real spec gap.

## False-Positive Correction

Subagent initially flags "Missing rate-limit guard" as a spec gap. On re-reading the design, rate limiting is listed under "Future Work," not current scope. Subagent removes this from findings.

**Agent reasoning:** "Rate limiting appears in the design's Future Work section (not Technical Design). Flagging it would be scope creep. Removing from issues list."

## Verdict

```json
{
  "verdict": "fail",
  "summary": "4 of 5 spec requirements met. Missing guard failure error messages.",
  "issues": [{
    "severity": "HIGH",
    "category": "spec",
    "file": "src/guards.ts",
    "description": "Guards return boolean without error messages",
    "required_fix": "Return { allowed: boolean, reason: string } per design spec"
  }],
  "test_results": { "passed": 47, "failed": 0, "coverage_percent": 89 }
}
```

State updated with `reviews.spec.status = "fail"`. Orchestrator dispatches fix task automatically.
