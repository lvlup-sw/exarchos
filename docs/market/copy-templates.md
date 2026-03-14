# Exarchos copy templates

Last updated: 2026-03-14

## Short-form variants

**One-liner:**
> Exarchos: a local-first SDLC workflow harness — structured, durable state for coding agents.

**Two-liner:**
> Your agents forget. Exarchos doesn't. A local-first workflow harness that gives coding agents structured, durable state outside the context window.

**Paragraph:**
> You already manage context by hand — plan files per feature, CLAUDE.md updated between sessions, summaries before /clear. Exarchos replaces the manual process with an event-sourced MCP server. Phase transitions enforced by a state machine. Deterministic convergence gates as TypeScript checks. /clear whenever you want, /rehydrate when you're back.

## Twitter/X templates

**1. Problem hook:**
> You keep a plan.md per feature. You update CLAUDE.md between sessions. You write summaries before /clear. You enforce your own phases.
>
> That's a workflow harness, done by hand.
>
> Exarchos does it for you: durable state, enforced phases, deterministic quality gates.

**2. Technical hook:**
> Exarchos is an event-sourced MCP server. State lives outside the context window. A state machine enforces phase transitions. Convergence gates run as TypeScript checks against your diff.
>
> /clear whenever you want. /rehydrate when you're back.

**3. Pain point:**
> The agent skipped your review phase because the context got long enough that it stopped reading your instructions.
>
> Exarchos makes that impossible. State machine won't let it through.

**4. Agent teams:**
> Three typed agents: implementer (writes code via TDD), fixer (resumes failures with context), reviewer (read-only, can't edit files).
>
> Each in its own worktree. Scoped tools, not honor-system prompts.

**5. Comparison:**
> Plan files: stateless, unenforced, no verification.
> Exarchos: event-sourced, phase-gated, deterministic convergence gates.
>
> Same instinct. Different mechanism.

## HN Show post draft

**Title:** Show HN: Exarchos — a local-first SDLC workflow harness for coding agents

**Body:**

If you use Claude Code (or any MCP-compatible agent) for real work, you've probably built your own version of this: plan files per feature, CLAUDE.md updated between sessions, summaries written before /clear so the next session can pick up.

Exarchos formalizes that workflow. It's an event-sourced MCP server that gives your agent structured, durable state outside the context window:

- Phase transitions enforced by a state machine (design, plan, implement, review, ship)
- Deterministic convergence gates run as TypeScript checks against your diff and git history
- Three typed agent roles (implementer, fixer, reviewer) in isolated worktrees
- Checkpoint/rehydrate across sessions in ~2-3k tokens
- Append-only event log for audit

Ships as a Claude Code plugin and a standalone MCP server. The MCP server works with any client.

Install: `/plugin marketplace add lvlup-sw/.github && /plugin install exarchos@lvlup-sw`

Standalone: `npx @lvlup-sw/exarchos mcp`

Source: https://github.com/lvlup-sw/exarchos

## Controlled vocabulary

**Use:**
- local-first SDLC workflow harness
- structured, durable state
- deterministic convergence gates
- TypeScript checks (not "scripts", not "verification scripts")
- phase gates / state machine
- typed agent teams (implementer, fixer, reviewer)
- event-sourced
- checkpoint / rehydrate
- append-only event log

**Avoid:**
- governance (too enterprise for first contact)
- missing layer / missing piece (significance inflation)
- seamless, groundbreaking, vibrant, nestled (promotional)
- game-changer, revolutionary, paradigm shift
- memory (confused with RAG/vector stores)
- persistence (too generic)
- supercharge, unlock, empower
- delve, leverage, utilize
