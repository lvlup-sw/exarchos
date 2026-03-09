# Your First Workflow

This walkthrough builds a small feature from start to finish using the Exarchos feature workflow. You will go from idea to merged PR. The example is simple on purpose so you can focus on the workflow mechanics.

## Before You Start

- Have a project open in Claude Code (any codebase works)
- Exarchos installed and verified (see [Installation](/guide/installation))

## Step 1: Start with /ideate

Tell Exarchos what you want to build:

```
/exarchos:ideate Add a string utility module with camelCase and snake_case converters
```

Exarchos initializes a workflow and enters the **ideate** phase. Here is what happens next:

1. Claude asks clarifying questions: what problem are you solving, what constraints exist, what patterns the codebase already uses.
2. You get 2-3 distinct approaches with trade-offs for each.
3. You pick an approach.
4. A design document is saved to `docs/designs/` in your project.

**You approve the design.** This is the first of two human checkpoints in the entire workflow. Everything between this point and the merge decision auto-continues without asking you.

## Step 2: Planning

After you approve the design, Exarchos auto-continues to `/plan`. No need to run anything manually.

- The design is decomposed into TDD-based implementation tasks
- Each task has red/green/refactor phases, test file paths, and expected test names
- Tasks are organized into parallel groups where dependencies allow
- A plan-review checks that every design requirement has a corresponding task

If plan-review finds gaps, it loops back and revises the plan automatically. When coverage is complete, you see the plan.

**You approve the plan.** This is the second and final human checkpoint. From here, the workflow runs autonomously until a PR is ready.

## Step 3: Delegation

After plan approval, `/delegate` dispatches tasks to agent teams:

- Each task gets an implementer agent running in its own git worktree
- Agents follow strict TDD: write a failing test first, make it pass, then clean up
- Independent tasks run in parallel
- Progress events track each task through completion

You can watch the progress or walk away. The agents work independently in isolated branches. Your main working tree stays untouched.

## Step 4: Review

When all tasks complete, two-stage review runs automatically:

- **Stage 1: Spec compliance.** Does the implementation match the design? Are all requirements covered? This catches drift between what you asked for and what got built.
- **Stage 2: Code quality.** Is it well-written? Are there operational issues, missing error handling, or test gaps?

If review finds problems, fixer agents are dispatched automatically to address them. The review/fix cycle repeats until both stages pass. No manual intervention needed.

## Step 5: Synthesis

Once review passes, `/synthesize` creates a pull request from the feature branch. The PR description references the design document, implementation plan, and review results.

If the PR needs to get through CI checks or human reviewers, `/shepherd` handles the iteration loop: assess the PR status, fix failing checks, address review comments, resubmit. It runs up to five iterations before escalating.

## Step 6: Merge

Review the PR on GitHub. When you are satisfied:

- Approve the merge when Exarchos asks
- Then run cleanup:

```
/exarchos:cleanup
```

This resolves the workflow to completed, removes worktrees, and prunes merged branches.

## What If Context Compacts?

At any point during this workflow, if Claude Code compacts your context and the agent loses track of what it was doing:

```
/exarchos:rehydrate
```

Workflow state, current phase, task progress, and artifact references are restored in about 2-3k tokens. The agent picks up where it left off. No need to re-explain the project or recap decisions you already made.

You can also use `/checkpoint` proactively before stepping away. It saves current progress and gives you the exact rehydrate command to use when you come back.

## The Full Picture

```
/ideate → [YOU APPROVE DESIGN] → /plan → [YOU APPROVE PLAN] → /delegate → /review → /synthesize → [YOU MERGE]
```

Two decisions are yours: approve the design, approve the plan. Everything between auto-continues. The workflow is durable across context compaction, session breaks, and laptop closures.

## Other Workflows

The feature workflow is the most complete, but Exarchos has two other entry points:

**Debugging:** When something is broken, use `/exarchos:debug` instead. It starts with triage and investigation before any fix attempt. Choose `--hotfix` for production fires (15-minute time box) or the default thorough track for full root cause analysis.

```
/exarchos:debug Users report cart total is wrong after removing items
```

**Refactoring:** When code works but needs improvement, use `/exarchos:refactor`. It assesses scope first, then picks the right track: `--polish` for small changes (five files or fewer) or the default overhaul for structural changes with full delegation.

```
/exarchos:refactor Extract validation logic into separate utility functions
```

Both workflows follow the same pattern: structured phases, durable state, automatic transitions, and convergence gates between steps.

## Next Steps

- [Feature Workflow](/guide/feature-workflow) - Full reference for the design-plan-implement-review-ship pipeline
- [Debug Workflow](/guide/debug-workflow) - Triage, investigate, and fix with validated results
- [Refactor Workflow](/guide/refactor-workflow) - Scope assessment and verified improvements
- [Checkpoint & Resume](/guide/checkpoint-resume) - How durable state works under the hood
