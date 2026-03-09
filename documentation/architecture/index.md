---
outline: deep
---

# Architecture Overview

![Exarchos Architecture](/architecture.svg)

Exarchos is a Claude Code plugin that adds structured workflows to AI-assisted software development. It runs as an MCP server over stdio, persists state to the local filesystem, and coordinates agent teams through git worktree isolation.

## System Components

The system has three layers connected by simple protocols:

**Claude Code** acts as the orchestrator. It loads Exarchos commands and skills from `~/.claude/`, issues MCP tool calls to drive workflows forward, and spawns subagents for parallel work. Claude Code doesn't know about workflow internals. It follows the runbook protocol: request the current phase's instructions, execute the steps, check the transition guard, move on.

**The MCP server** (`servers/exarchos-mcp/`) handles all workflow logic. It exposes four visible composite tools over stdio:

- `exarchos_workflow` -- lifecycle management (init, get, set, cancel, cleanup, reconcile)
- `exarchos_event` -- append-only event streams (append, query, batch)
- `exarchos_orchestrate` -- task coordination, convergence gates, runbooks, agent specs, script execution
- `exarchos_view` -- CQRS materialized views (pipeline, tasks, telemetry, convergence status)

A fifth tool (`exarchos_sync`) exists for future remote synchronization but is hidden from agents.

**The event store** persists everything to JSONL files (one per workflow) with JSON state files derived from events. JSONL is always the source of truth. An optional SQLite backend accelerates queries but self-heals from JSONL if the database corrupts.

Lifecycle hooks intercept Claude Code events (session start, pre-compact, task completion, teammate idle) and trigger MCP operations. Hooks run as lightweight CLI subcommands with tight timeouts (5-30 seconds), skipping heavy initialization to stay fast.

Agent specs define three typed subagents (implementer, fixer, reviewer), each spawned into isolated git worktrees with scoped tool access. The implementer and fixer can read and write files; the reviewer is read-only.

Validation scripts are deterministic bash programs that replace prose checklists. They follow a strict pattern: `set -euo pipefail`, exit codes 0 (pass), 1 (fail), or 2 (error), with co-located `.test.sh` files for self-testing.

## Design Principles

**Agent-first.** Every tool accepts structured JSON input, validates it with Zod schemas, and returns structured JSON output with clear error messages. When a guard blocks a transition, the error includes the expected state shape and a suggested fix -- the exact tool call to resolve it. This is designed for LLM consumption, not human CLI usage.

**Event-sourced.** Every workflow action produces an immutable event appended to a JSONL stream. State is derived from events, never mutated directly. If state and events diverge, `reconcile` rebuilds state from the event log. This matters because agent sessions end abruptly -- context compaction, crashes, laptop lids closing. Mutable state can corrupt silently. Events don't.

**Token-efficient.** LLM context windows are finite, and Exarchos is infrastructure -- every token it consumes is a token unavailable for actual coding. Lazy schema registration keeps MCP startup under 500 tokens. Field projection on state queries cuts response size by roughly 90%. Artifact references store file paths instead of inlining content. Every design choice accounts for context window cost.
