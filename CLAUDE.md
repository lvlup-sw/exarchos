# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Exarchos is local agent governance for Claude Code. It provides event-sourced SDLC workflows with agent team coordination, installing commands, skills, rules, and MCP plugins to `~/.claude/` via symlinks. Workflows survive context compaction through persistent state and auto-resume on session start.

## Build & Test Commands

```bash
# Root installer
npm run build          # tsc + bun → dist/install.js, dist/exarchos-mcp.js, dist/exarchos-cli.js
npm run test:run       # vitest single run
npm run test           # vitest watch mode
npm run typecheck      # tsc --noEmit

# Exarchos MCP server (unified: workflow state + events + teams)
cd plugins/exarchos/servers/exarchos-mcp
npm run build          # tsc
npm run test:run       # vitest single run
npm run test:coverage  # vitest with coverage
npm run dev            # tsx watch mode

# Run a single test file (any package)
npx vitest run src/install.test.ts
npx vitest run src/state-machine.test.ts
```

## Architecture

### Installation Model

The installer (`src/install.ts`) creates symlinks from this repo into `~/.claude/`:
- `commands/` → slash commands (`/ideate`, `/plan`, `/delegate`, etc.)
- `skills/` → reusable workflow logic referenced by commands
- `rules/` → coding standards and behavior constraints
- `settings.json` → permissions, plugin config, and hooks with resolved CLI paths

It also builds and registers MCP servers in `~/.claude.json`. Hooks from `hooks.json` are resolved with mode-dependent CLI paths and merged into `settings.json` (not copied as a separate file).

### Content Layers (no runtime code)

Most of this repo is structured Markdown, not executable code:

- **Commands** (`commands/*.md`) — Entry points with YAML frontmatter. Each command references a skill via `@skills/<name>/SKILL.md` path and contains workflow position diagrams.
- **Skills** (`skills/*/SKILL.md`) — Reusable workflow modules with templates in `references/` subdirectories. Skills define multi-step processes (brainstorming, delegation, review, etc.).
- **Rules** (`rules/*.md`) — Behavioral constraints applied globally. Some use `paths` frontmatter to scope to specific file patterns.

### MCP Servers

One self-contained TypeScript MCP server with its own `package.json`, `tsconfig.json`, and test suite:

- **exarchos** (`plugins/exarchos/servers/exarchos-mcp/`) — Unified server combining workflow HSM (state machine transitions), append-only event store (JSONL), CQRS materialized views, and agent team coordination (spawn/message/shutdown). Persists to `~/.claude/workflow-state/` (configurable via `WORKFLOW_STATE_DIR` env var). Exposes 26 MCP tools via a per-module registration pattern.

Uses `@modelcontextprotocol/sdk` + `zod`, communicates over stdio, and is registered in `~/.claude.json` by the installer.

**Key modules** (each exports a `registerXTools(server, stateDir, eventStore)` function — workflow modules use a `configureXEventStore(eventStore)` + 2-arg registration pattern instead):

- `workflow/state-machine.ts` — Types/interfaces, transition algorithm, HSM registry
- `workflow/guards.ts` — Guard definitions (26 guards) for all HSM transitions
- `workflow/hsm-definitions.ts` — HSM definitions for feature/debug/refactor workflows
- `workflow/tools.ts` — CRUD operations (init, list, get, set, checkpoint). Uses CAS versioning (`_version` field) with retry loop to prevent lost updates on concurrent writes. Emits transition events to external JSONL store after successful state write (state-first, event-after). Responses strip internal fields (`_events`, `_history`) and include compact `_meta` summaries. Fast-path for simple queries (phase, featureId) skips full Zod validation.
- `workflow/next-action.ts` — Auto-continue logic and phase-to-action mapping
- `workflow/cancel.ts` — Saga compensation and workflow cancellation with checkpoint persistence for resumable compensation on partial failure
- `workflow/query.ts` — Summary, reconcile, and transitions handlers
- `event-store/` — Zod event schemas (24 types including workflow.transition, workflow.fix-cycle), JSONL store with `.seq` files for O(1) sequence initialization, append/query tools. Supports idempotency keys (persisted in JSONL, cache rebuilt on restart) and pre-parse sequence filtering for fast queries
- `views/` — CQRS materializer (cached singleton per server lifecycle, LRU-bounded), 6 view types (pipeline, tasks, workflow status, team status, task detail, stack). Pipeline view uses lazy pagination (materializes only the requested subset)
- `team/` — Coordinator lifecycle, roles, composition, spawn/message/broadcast/shutdown tools
- `tasks/` — Task claim/complete/fail tools with optimistic concurrency (expectedSequence) for atomic claims
- `stack/` — Stack status/place tools with offset/limit pagination
- `format.ts` — Canonical `ToolResult` interface (all modules import from here) and shared formatting helpers

### Three Workflow Types

**Feature:** `/ideate` → `/plan` → plan-review → `/delegate` → `/review` → `/synthesize`
**Debug:** `/debug` → triage → investigate → fix → validate (hotfix or thorough tracks)
**Refactor:** `/refactor` → explore → brief → implement → validate (polish or overhaul tracks)

Human checkpoints only at plan-review approval and merge confirmation. Everything else auto-continues via `workflow_next_action` MCP tool.

### Orchestrator Pattern

The main Claude Code session coordinates but does not write implementation code (exception: polish-track refactors). All code changes go through agent teammates dispatched to git worktrees. This preserves context window for coordination.

## Key Conventions

- **ESM throughout** — All packages use `"type": "module"` with NodeNext resolution
- **Strict TypeScript** — `strict: true`, no `any`, use `unknown` with type guards
- **Co-located tests** — `foo.test.ts` alongside `foo.ts`, not in separate `tests/` dir
- **Vitest** — Import explicitly: `import { describe, it, expect, vi } from 'vitest'` (no globals)
- **No runtime dependencies** for the root installer — only devDependencies
- **Node >= 20** required across all packages

## Docs Directory

- `docs/designs/` — Feature design documents
- `docs/plans/` — TDD implementation plans
- `docs/adrs/` — Architecture Decision Records
- `docs/rca/` — Root Cause Analysis documents
- `docs/workflow-state/` — Legacy workflow state location (gitignored, no longer default)
- `docs/schemas/` — JSON schemas for state files
