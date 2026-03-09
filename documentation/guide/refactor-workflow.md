---
outline: deep
---

# Refactor Workflow

The refactor workflow handles code improvement without changing external behavior. It provides two tracks: polish for targeted cleanup within a few files, and overhaul for structural redesign across modules.

## Phase Chains

**Polish track:**
```
explore → brief → polish-implement → polish-validate → polish-update-docs → completed
```

**Overhaul track:**
```
explore → brief → overhaul-plan → overhaul-plan-review → overhaul-delegate → overhaul-review → overhaul-update-docs → synthesize → completed
```

Polish has no human checkpoints -- it runs start to finish. Overhaul has one: plan approval before delegation begins, plus merge confirmation at the end.

## Starting a Refactor Workflow

```
/exarchos:refactor extract validation logic from UserService into its own module
```

You can force a track or limit to exploration only:

```
# Small cleanup, skip to polish track
/exarchos:refactor --polish rename internal methods in the parser module

# Just assess scope, don't start the refactor yet
/exarchos:refactor --explore how much work would it be to restructure the data layer
```

## Exploration Phase

Every refactor starts with scope assessment. Exarchos analyzes the target code and recommends a track:

| Criterion | Polish | Overhaul |
|-----------|--------|----------|
| Files affected | 5 or fewer | More than 5 |
| Concerns | Single concern | Multiple concerns |
| Cross-module changes | No | Yes |
| Test coverage gaps | No | Yes |
| Documentation updates | Minor | Significant |

If any single criterion indicates overhaul, the recommendation is overhaul. You can override this -- the recommendation is not a gate.

If you used `--explore`, the workflow stops here with a summary. Otherwise, it auto-continues to the brief phase.

## Brief Phase

The brief captures refactor intent in the workflow state (not a separate file). It includes: problem statement, goals, approach, affected areas, out-of-scope items, success criteria, and docs to update.

Be specific. "UserService has grown to 500 lines with auth, validation, and persistence mixed together" is a good problem statement. "Code is messy" is not. Goals must be verifiable: "Extract validation into UserValidator class under 100 lines."

After the brief is captured, the workflow branches by track.

## Polish Track

Polish is the fast path. No worktrees, no delegation, no subagents. The orchestrator implements the changes directly.

**Implement.** Make the targeted improvements following TDD if behavior changes. Commit after each logical change. If scope expands beyond the brief, the workflow switches to overhaul automatically.

**Validate.** Run tests and static analysis. A scope check confirms you stayed within polish limits (5 files or fewer).

**Update docs.** Update affected documentation. This phase is mandatory -- the system verifies even if you think no docs need updating.

Polish completes after doc updates. No synthesis phase, no PR ceremony. Commit and push.

## Overhaul Track

Overhaul uses the full delegation pipeline, similar to the feature workflow. The refactor brief serves as the design document.

**Plan.** Decomposes the brief into TDD-based tasks. Each task leaves code in a working state. Dependency ordering matters more here than in feature work because refactors often involve rename-then-move chains.

**Plan review.** Verifies coverage of every brief goal. Gaps trigger automatic revision.

**Human checkpoint:** You approve the plan before delegation starts.

**Delegate.** Dispatches implementer agents in worktrees, one per task, following Red-Green-Refactor.

**Review.** Two-stage review (spec compliance + code quality) with emphasis on quality. Refactors carry higher regression risk because they modify existing behavior paths.

**Update docs.** Everything referencing the restructured code gets updated. A link verification script checks for broken references.

**Synthesize.** Creates the PR. Shepherd monitors CI. **Human checkpoint:** You confirm the merge.

## When to Use Each Track

| Consideration | Polish | Overhaul |
|---------------|--------|----------|
| Scope | Single file or module | Multiple modules or interfaces |
| Risk | Low -- isolated changes | Higher -- cross-cutting changes |
| Duration | Minutes | Hours |
| Delegation | None (you do it inline) | Implementer + reviewer agents |
| Review depth | Static analysis only | Full convergence gates |
| Human checkpoints | 0 | 2 (plan approval + merge) |

## Switching Tracks

If scope expands beyond polish limits during implementation:

```
/exarchos:refactor --switch-overhaul
```

Exploration results and brief are preserved. The workflow picks up at the overhaul-plan phase. Switching from overhaul to polish is not supported.

## Session Recovery

```
/exarchos:rehydrate
```

The workflow resumes from whatever phase it was in. Exploration assessment, brief, and in-progress task states are all preserved.
