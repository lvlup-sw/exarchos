# Getting Started

Exarchos adds durable, structured workflows to Claude Code. You describe what you want to build, approve two decisions, and the system handles the rest: planning, task dispatch, code review, and PR creation. If your session compacts or you close your laptop, you rehydrate and pick up where you left off.

## What you can do

Build features with a structured workflow. You start with `/ideate` to explore approaches, approve a design, approve a plan, and Exarchos delegates implementation to agent teams working in parallel git worktrees. Two-stage review checks spec compliance and code quality. A PR lands on your desk ready to merge.

Debug issues with `/debug`. Triage the symptom, investigate the root cause, implement a validated fix. Choose the hotfix track for production fires or the thorough track for full root cause analysis.

Refactor code with `/refactor`. Assess scope first, then either polish in place (small changes, five files or fewer) or run a full overhaul with delegated tasks and review.

Coordinate agent teams. Implementer, fixer, and reviewer agents each run in isolated worktrees with scoped tools. They follow TDD: write a failing test, make it pass, clean up.

Checkpoint mid-task and resume later. `/checkpoint` saves your workflow state. `/rehydrate` restores it in about 2-3k tokens. No re-explaining your project after context compaction or a weekend away.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and working
- Node.js >= 20

## Where to go next

New to Exarchos? Start here:

1. [Installation](/guide/installation) - Install the plugin and verify it works
2. [First Workflow](/guide/first-workflow) - Walk through a complete feature build

Know the basics? Jump to a specific workflow:

- [Feature Workflow](/guide/feature-workflow) - Design, plan, implement, review, ship
- [Debug Workflow](/guide/debug-workflow) - Triage, investigate, fix, validate
- [Refactor Workflow](/guide/refactor-workflow) - Assess scope, brief, improve

Want to understand capabilities?

- [Checkpoint & Resume](/guide/checkpoint-resume) - Durable state across sessions
- [Agent Teams](/guide/agent-teams) - Parallel execution in worktrees
- [Review Process](/guide/review-process) - Two-stage convergence gates
