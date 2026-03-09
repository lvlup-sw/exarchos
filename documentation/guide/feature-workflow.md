---
outline: deep
---

# Feature Workflow

The feature workflow handles building new functionality from initial idea through merged pull request. You describe what you want, approve two decisions (the design and the plan), and Exarchos handles the rest.

## Phase chain

```
ideate → plan → plan-review → delegate → review → synthesize → completed
```

Two human checkpoints exist in this chain: plan approval and merge confirmation. Everything else auto-continues.

## Ideation phase

Start a feature workflow:

```
/exarchos:ideate add rate limiting to the API endpoints
```

Exarchos asks clarifying questions, one at a time. What problem are you solving? What constraints exist? What patterns does the codebase already use? Expect 3-5 questions before it moves on.

After gathering context, Exarchos presents 2-3 approaches. Each approach includes a description, trade-offs, and a recommendation. You pick one.

Exarchos then writes a design document and saves it to `docs/designs/YYYY-MM-DD-<feature>.md`. The document captures the problem statement, chosen approach, content outline, and numbered design requirements (DR-1, DR-2, etc.). These DR-N identifiers become provenance anchors that trace through the entire pipeline.

After saving the design, the workflow auto-continues to planning. No approval needed here.

## Planning phase

The planning skill reads the design document and decomposes it into TDD-based implementation tasks. Each task specifies:

- What test to write first (the failing test)
- What code to implement (minimum to make it pass)
- What to refactor afterward (cleanup without changing behavior)

Tasks are grouped into parallel-safe batches. Independent tasks that don't touch the same files can run simultaneously in separate git worktrees.

A plan-review step then verifies two things:
1. Design coverage: every section of the design maps to at least one task
2. Provenance chain: every DR-N requirement traces to a task via an `Implements:` field

If gaps exist, the plan loops back for revision automatically (up to 3 times).

Human checkpoint: you approve the plan before delegation begins. This is your chance to adjust scope, reorder tasks, or flag concerns.

## Delegation phase

After plan approval, delegation begins automatically.

Exarchos creates isolated git worktrees and spawns implementer agents, one per task or parallel group. Each agent receives a self-contained prompt with the full task description, file paths, test expectations, and acceptance criteria. No agent depends on shared context or another agent's output (unless explicitly sequenced).

Each implementer follows strict TDD:
- Write a failing test (RED)
- Write minimum code to pass (GREEN)
- Clean up without changing behavior (REFACTOR)

Events track each task through `claimed`, `progressed`, and `completed` (or `failed`). Failed tasks are reassigned to fixer agents with the full failure context. The fixer applies an adversarial verification posture and does not trust the previous agent's self-assessment.

Delegation auto-continues to review when all tasks complete.

## Review phase

Review runs in two stages, both automated:

Stage 1, spec compliance. A reviewer agent checks that the implementation matches the design. It runs:
- Provenance chain verification (are DR-N requirements traceable to implemented code?)
- TDD compliance checks (did test commits precede implementation commits?)
- Security scan

Stage 2, code quality. A second reviewer checks the code itself:
- Static analysis (lint + typecheck)
- Operational resilience (error handling patterns)
- Context economy (complexity and duplication)
- Workflow determinism (test reliability)

Both stages examine a combined diff of all task branches against `main`, not individual worktree changes. This catches cross-task issues like interface mismatches or duplicate code across task boundaries.

The review produces a verdict:

| Verdict | What happens |
|---------|-------------|
| APPROVED | Auto-continues to synthesis |
| NEEDS_FIXES | Dispatches fixer agents via `/delegate --fixes` with specific findings |
| BLOCKED | Returns to the design phase for rework |

The fix-review cycle repeats until the verdict is APPROVED (up to 3 iterations before escalating to you).

## Synthesis phase

After review approval, synthesis runs pre-flight checks: tests pass, typecheck is clean, stack integrity is good. Then it creates a pull request with a structured description (summary, changes, test plan).

```
/exarchos:shepherd
```

The shepherd skill monitors CI status, review comments, and merge queue position. If CI fails or a reviewer requests changes, shepherd either fixes the issue directly or routes it to a fixer agent. This loop continues until the PR is merge-ready.

Human checkpoint: Exarchos presents the PR URLs and asks you to confirm the merge. You can respond with:
- yes, merge the PRs
- feedback, route PR comments to fixer agents
- no, pause the workflow (resume later with `/rehydrate`)

## Cleanup

After you merge the PR:

```
/exarchos:cleanup
```

This verifies the merge on GitHub, removes worktrees and local branches, and transitions the workflow to `completed`. The full audit trail remains in the event store.

## Session recovery

If your session compacts mid-workflow or you close your laptop:

```
/exarchos:rehydrate
```

Rehydration reads the workflow state and event history, reconstructing enough context to continue from wherever you left off. It costs about 2-3k tokens regardless of how far into the workflow you are.

## What you control

Two decisions. That is it:

1. Approve the plan (after plan-review). You see every task, every test expectation, every file that will change.
2. Confirm the merge (after synthesis). You see the PR with passing CI and a structured description.

Everything between those two points runs autonomously. If something goes wrong, the system either fixes it (fixer agents) or escalates to you (BLOCKED verdict, shepherd escalation).
