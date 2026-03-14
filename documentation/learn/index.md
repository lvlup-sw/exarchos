# Why Exarchos

## The workflow you already run

You keep a plan file per feature. CLAUDE.md gets updated between sessions. Before you `/clear`, you write out a summary so the next context window has something to work with. Maybe you enforce your own phases — design first, plan, implement, review. You use subagents to keep exploration out of the main window.

It works. Developers using Claude Code end up inventing some version of this on their own.

It's also manual. Nothing enforces the phases once the window gets long enough that the agent starts ignoring your instructions. Nothing persists the workflow state across a `/clear` except whatever you remembered to write into a file. And nothing verifies that the agent actually followed the spec — you find out when you review the PR.

## What plan files can't do

The instinct is right. The mechanism is limited. Markdown files can't:

- **Persist state across context loss.** Your plan file is on disk, but after `/clear` or compaction the agent has no memory of what it finished, what failed, or where it stopped. You re-read the plan, re-check task status, re-establish state. Every time.
- **Enforce phase transitions.** You wrote "implement after plan approval" in the spec. The agent jumped straight to writing code because the context was long and your instruction got buried. Nothing stopped it.
- **Verify follow-through.** The agent says it implemented the spec. Did it? You won't know until you diff the code against the design doc yourself.
- **Coordinate parallel work.** Multiple agents working different parts of a feature means managing branches, worktrees, and merge conflicts by hand. Plan files don't track who's doing what.

## What Exarchos is

Exarchos is a local-first SDLC workflow harness. It gives your agent structured, durable state that lives outside the context window.

The runtime is an event-sourced MCP server. Every workflow action produces an immutable event in an append-only log. Current state is derived from events, not stored in a mutable file. A state machine enforces phase transitions. Deterministic convergence gates run as TypeScript checks at phase boundaries.

In practice:

- **Checkpoint and rehydrate.** Before you `/clear`, `/checkpoint` snapshots the workflow. `/rehydrate` restores it in ~2-3k tokens. State, task progress, artifact references — all recovered without re-explaining anything.
- **Phase gates with teeth.** The agent can't move from planning to implementation without a plan artifact. Can't move from implementation to review without passing convergence gates. The state machine rejects invalid transitions and tells the agent what's missing.
- **Typed agent teams.** Three roles — implementer, fixer, reviewer — each in isolated git worktrees with scoped tools. The reviewer can't write files. The implementer follows TDD. The fixer resumes failed tasks with full context instead of starting over.
- **Deterministic convergence gates.** TypeScript checks run against your diff and git history: TDD compliance, static analysis, context economy, operational resilience, workflow determinism. Same code, same result. Optional plugin tiers (axiom for backend quality, impeccable for design) layer additional analysis on top.
- **Audit trail.** Every transition, gate result, and agent action goes into the event log. When something breaks, you trace what happened.

## Two human checkpoints

You approve the design. You approve the merge. Everything between those two decisions auto-continues: planning, task decomposition, implementation, convergence gates, review, PR creation.

## How it ships

Exarchos is a Claude Code plugin and a standalone MCP server with a CLI adapter. The MCP server works with any client. The content layer (skills, commands, hooks, agent specs) currently targets Claude Code, with other platforms planned.
