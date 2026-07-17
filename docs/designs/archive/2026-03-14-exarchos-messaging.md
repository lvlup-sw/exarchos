# Exarchos messaging and positioning

**Feature ID:** exarchos-messaging
**Date:** 2026-03-14
**Status:** Design

## Context

Exarchos 2.5.0 is the first public release. We need messaging that communicates the value proposition to developers and power users immediately, drives installs, and differentiates from the existing landscape of agent workflow tools.

### Audience

Broader developer audience, not limited to Claude Code users. Platform-agnostic positioning with first-class Claude Code support. Later extension to Cursor, Copilot CLI, and other MCP clients.

### What developers actually do today

Research from Hacker News threads (260+ points) and community tools confirms:

- **Plan files per feature.** CLAUDE.md updated multiple times a week. Session summaries written before `/clear` to propagate context to the next window.
- **Phase-based context propagation.** At phase boundaries, developers have Claude update the plan file with context for a fresh session. Separation of planning and execution is a deliberate workflow.
- **Deliberate `/clear` over compaction.** Power users run `/clear` at a chosen context length rather than letting compaction happen. Compaction is lossy and unpredictable; `/clear` with a pre-written summary is controlled.
- **Subagents for context hygiene.** Used defensively to keep exploration out of the main window, not just for parallelism.
- **At least 7 open-source persistence tools** (Grov, Recall, Mem0, A-MEM, ContextForge, Claude Reflect, and others) exist to solve the memory/persistence problem. This is a validated pain point.

The core insight: power users aren't passively losing context. They're actively managing it through manual, unenforceable processes.

### Competitive landscape

| Feature | Exarchos | Obra Superpowers | Claude Task Master | Manual (plan.md) |
|---------|----------|------------------|--------------------|-------------------|
| State persistence across sessions | Event-sourced, survives compaction | Session-based | Task file on disk | None |
| Phase-gated workflows | State machine with guards | No | No | Manual discipline |
| Quality verification | Deterministic convergence gates | No | No | Manual review |
| Agent team coordination | Typed agents in worktrees | Mode switching | No | No |
| Token efficiency | Lazy schemas, field projection | N/A | Full context load | Full context load |
| Audit trail | Append-only event log | No | No | Git history only |

## Positioning

**Category:** Local-first SDLC workflow harness

**Core positioning statement:** Exarchos gives coding agents structured, durable state — phase-gated workflows that survive context clears, with deterministic quality verification.

**Approach:** Problem-first messaging (Approach C) as the outer shell, mechanism explanation (Approach B: "workflow harness") as the structural explanation. Reserve "governance" framing for enterprise docs.

### Tagline

**Your agents forget. Exarchos doesn't.**

### Secondary line

**Your plan.md workflow, with teeth.**

## Copy

### README / landing page opening

> **Your agents forget. Exarchos doesn't.**
>
> You already manage this by hand. A plan file per feature, CLAUDE.md updated between sessions, summaries written out before `/clear` so the next context window has something to work with. Maybe you enforce your own phases — design, plan, implement, review. It works. It's also manual, and nothing holds the agent to it once the window gets long enough that your instructions start getting ignored.
>
> Exarchos is a local-first SDLC workflow harness. It gives your agent structured, durable state that lives outside the context window. Phase transitions are enforced by a state machine. Deterministic convergence gates run as TypeScript checks against your diff and git history, not prompts. You approve the design, you approve the merge — everything between runs on its own.
>
> `/clear` whenever you want. `/rehydrate` when you're back. State persists.
>
> It ships as a Claude Code plugin and a standalone MCP server with a CLI adapter. Install it and run `/ideate`.

### Key messaging principles

1. **Lead with what they already do.** Don't explain context loss as a surprise. Describe the manual work they're doing to prevent it.
2. **"Local-first SDLC workflow harness"** is the category. Use it consistently.
3. **"Structured, durable state"** is the mechanism. Not "memory" (confused with RAG/vector stores). Not "persistence" (too generic).
4. **Deterministic over vibes.** Convergence gates are TypeScript checks, not LLM inference. Same code, same result.
5. **Two human checkpoints.** Design approval and merge approval. Everything between auto-continues. Don't oversell autonomy; sell controlled autonomy.
6. **Platform-agnostic core.** Claude Code plugin + standalone MCP server. The MCP server works with any client.

### Distribution model

Following the Impeccable cross-platform pattern:
- `npx skills add` with auto-detection for environment
- Plugin marketplace for Claude Code
- Standalone MCP server for other clients
- Thin content layer (skills, commands, hooks, agent specs) per platform; runtime is platform-agnostic

## Requirements

- DR-1: README restructured around the approved copy
- DR-2: Marketplace listing updated with positioning
- DR-3: Landing page (docs site index) aligned with messaging
- DR-4: Copy templates for social/campaign use
- DR-5: Cross-platform install instructions reflecting distribution model
