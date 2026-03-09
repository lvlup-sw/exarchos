---
outline: deep
---

# Design Rationale

These are the key engineering decisions behind Exarchos and the reasoning that led to them. Each section presents the alternatives considered and is honest about the trade-offs.

## Why MCP Over Markdown Files

The original version of Exarchos used markdown files for everything: workflow instructions, state tracking, behavioral constraints. These files were loaded into the agent's context at session start.

This had a fundamental problem: markdown files are stateless. When context compacts (which happens when the context window fills up), loaded files can be evicted. The agent loses its workflow state, its progress, its knowledge of what phase it's in. It has to start over, or worse, it continues without knowing it lost state.

An MCP server solves this by persisting state externally. The server process runs alongside Claude Code, communicates over stdio, and stores everything on disk. Context compaction doesn't affect it. The agent can lose its entire context, start a new session, and the MCP server still knows the current phase, pending tasks, and review results.

MCP also enables input validation. When an agent calls `exarchos_workflow({ action: "set", featureId: "my-feature", phase: "review" })`, the server validates the input with Zod schemas, checks the phase transition against the state machine, evaluates guards, and returns structured errors if anything is wrong. Markdown files can suggest what the agent should do; the MCP server can enforce it.

**Trade-off:** MCP adds operational overhead. The server needs to start up, establish stdio communication, and initialize its state. This adds latency to the first tool call. For simple tasks that don't need structured workflows, a few markdown files in the context are lighter. The MCP approach pays off when workflows are complex enough that losing state mid-session would cost more than the server overhead.

## Why Event Sourcing Over a Database

Agent workflows have a specific access pattern: events happen in order, most writes are appends, and the most common query is "give me the current state." This is a good fit for event sourcing with JSONL files.

JSONL is simple. Each event is a line of JSON appended to a file. No schema migrations, no connection pooling, no query language. You can debug a workflow by opening the file in a text editor. You can back it up by copying a file. You can move it to another machine by copying a directory.

Events are the audit trail. With a traditional database, you'd need a separate record-keeping system to answer "what happened during this workflow?" With event sourcing, the events *are* the history. Every transition, guard failure, task assignment, and review result is recorded with timestamps and context.

Exarchos does use SQLite as an optional acceleration layer. The SQLite backend caches queries and sequence lookups for better performance on large event streams. But JSONL is always the source of truth. If the SQLite database corrupts, the server deletes it and rebuilds from JSONL on the next startup. No data loss.

**Trade-off:** Query flexibility is limited. You can't write arbitrary SQL against a JSONL file. The solution is CQRS (Command Query Responsibility Segregation) materialized views -- the `exarchos_view` tool provides pre-built projections like pipeline status, task details, and convergence metrics. This adds code complexity, but it cleanly separates the write path (append events) from the read path (query views).

## Why Typed Agents Over a Single General-Purpose Agent

A general-purpose agent can implement, review, and fix code in one session. For simple tasks, this works fine. For complex features, it breaks down in predictable ways.

The core issue is separation of concerns. When the same agent implements code and then reviews it, the review is biased. The agent "knows" what it intended, so it evaluates the code against its intentions rather than against the design requirements. It's reviewing its own work, and it's lenient.

Typed agents fix this through three mechanisms:

- **Scoped tools.** The reviewer cannot modify files. This isn't a prompt instruction that the agent might ignore under pressure -- `Write` and `Edit` are in its `disallowedTools` list. The tool call is rejected at the framework level.
- **Focused prompts.** Each agent type has a short, specific prompt. The implementer follows TDD. The reviewer checks design compliance. The fixer reproduces failures before fixing them. Short, focused prompts are more reliable than long, multi-purpose ones.
- **Independent context.** The reviewer starts fresh, without the implementer's context about what it "tried to do." It evaluates the code as written, not as intended.

**Trade-off:** More moving parts. Typed agents require orchestration: spawning subagents, passing context, collecting results, merging worktrees. The orchestrator needs to understand the runbook protocol and coordinate between agents. This is more complex than "ask one agent to do everything." The complexity is justified when the task is big enough that quality matters more than simplicity.

## Why Convergence Gates Over Manual Review

Manual code review catches obvious bugs but misses systematic patterns. A reviewer might notice a missing null check but not realize that 6 out of 10 new functions swallow errors silently. Under time pressure, manual review gets even less thorough.

Convergence gates are deterministic bash scripts that check specific dimensions of code quality:

- **D1:** Security patterns and requirement traceability
- **D2:** Static analysis (lint, typecheck)
- **D3:** Context economy (code complexity affecting LLM context consumption)
- **D4:** Operational resilience (empty catches, swallowed errors, console.log in production code)
- **D5:** Workflow determinism (test reliability, `.only`/`.skip` markers, non-deterministic patterns)

Gates run fast -- they're bash scripts analyzing git diffs, not LLM inference. Same code, same result, every time. They emit `gate.executed` events, so you can track quality trends across workflows.

**Trade-off:** Gates check patterns, not intent. They can catch a swallowed error but can't judge whether a design decision is sound. They complement human review rather than replacing it. Exarchos keeps human review in the loop through typed reviewer agents and the two human checkpoints.

## Why Two Human Checkpoints

Most operations in an Exarchos workflow run without human intervention. The agent handles ideation, planning, implementation, review, and PR creation automatically. But two moments require your explicit approval:

**Plan review** (plan-review phase). You confirm the approach before any code is written. The agent presents its implementation plan -- task breakdown, design decisions, testing strategy. You can approve, request revisions (up to 3 rounds), or redirect the approach entirely.

**Merge approval** (synthesize phase). You confirm the result before it enters your codebase. The agent has created PRs, run convergence gates, and prepared a synthesis report. You decide whether to merge.

Everything between these two checkpoints auto-continues. The agent plans, delegates to implementers, runs reviews, fixes failures, and retries -- all without stopping to ask for permission. This balances two competing needs: you want control over what goes into your codebase, but you don't want to be interrupted every few minutes to approve routine operations.

**Trade-off:** Two checkpoints means the agent can spend significant time on an approach that you ultimately reject at plan review. A more interactive model with frequent checkpoints would catch misalignment earlier but would also interrupt the agent's flow and require more of your attention. The current design optimizes for your time at the cost of occasionally wasted agent time.
