# Why Exarchos

## The workflow you already have

You probably have a `plan.md`. Maybe a spec file per feature. You iterate with Claude Code, point it at the plan, tell it to build the thing, commit artifacts alongside the code.

This works. It works well enough that most developers using Claude Code end up inventing some version of it on their own.

Then context compaction wipes your session halfway through a multi-file refactor. Or the agent drifts from the spec and you don't notice until you're reviewing a PR that implemented the wrong interface. Or you close your laptop on Friday and spend Monday morning re-explaining everything the agent already knew.

## What the manual approach is missing

Plan files are the right instinct. But markdown can't do three things you actually need:

**Persist state across context loss.** When context compaction fires or your session ends, your plan file is still on disk but the agent has no memory of what it already finished. You end up re-reading the plan, re-checking which tasks are done, re-establishing the current state. Every time.

**Verify that the agent followed through.** You wrote a spec. The agent says it implemented the spec. Did it? You won't know until you manually review the diff against the design doc. There's no automated check between "agent says it's done" and "you merge the PR."

**Coordinate parallel work.** If you want multiple agents working on different parts of a feature, you need to manage branches, worktrees, task assignment, and merge conflicts yourself. Plan files don't track who's doing what.

## What Exarchos adds

Exarchos is an MCP server that replaces your plan-file workflow with durable, structured workflows. It runs as a Claude Code plugin.

The core idea: every workflow action produces an immutable event stored in an append-only log. Current state is derived from events, not stored in a mutable file. A state machine enforces phase transitions so the agent can't skip from design to merge. Convergence gates run automated verification at phase boundaries.

In practice, this means:

- **Checkpoint and rehydrate.** Before context compaction, Exarchos snapshots the workflow state. When you come back, `/rehydrate` restores it in about 2-3k tokens. No re-explaining.
- **Phase gates with teeth.** The agent can't move from planning to implementation without a plan. Can't move from implementation to review without passing convergence gates. The state machine rejects invalid transitions.
- **Typed agent teams.** Three agent roles (implementer, fixer, reviewer) run in isolated git worktrees. Each has scoped tools and specific responsibilities. The reviewer can't write files. The implementer must follow TDD.
- **Convergence gates.** Five quality dimensions are checked automatically: specification fidelity, architectural compliance, context economy, operational resilience, and workflow determinism. These are verification scripts, not vibes.
- **Full audit trail.** Every transition, gate result, and agent action goes into the event log. When something breaks, you can trace exactly what happened.

## Two human checkpoints

You approve the design. You approve the merge. Everything between those two decisions auto-continues: planning, task decomposition, implementation, quality gates, review.

You stay in control of the decisions that matter. The structured workflow handles the execution in between.
