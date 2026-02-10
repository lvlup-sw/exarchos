# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Exarchos is local agent governance for Claude Code. It provides event-sourced SDLC workflows with agent team coordination, installing commands, skills, rules, and MCP plugins to `~/.claude/` via symlinks. Workflows survive context compaction through persistent state and auto-resume on session start.

## Build & Test Commands

```bash
# Root installer
npm run build          # tsc → dist/install.js
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
- `settings.json` → permissions and plugin config

It also builds and registers MCP servers in `~/.claude.json`.

### Content Layers (no runtime code)

Most of this repo is structured Markdown, not executable code:

- **Commands** (`commands/*.md`) — Entry points with YAML frontmatter. Each command references a skill via `@skills/<name>/SKILL.md` path and contains workflow position diagrams.
- **Skills** (`skills/*/SKILL.md`) — Reusable workflow modules with templates in `references/` subdirectories. Skills define multi-step processes (brainstorming, delegation, review, etc.).
- **Rules** (`rules/*.md`) — Behavioral constraints applied globally. Some use `paths` frontmatter to scope to specific file patterns.

### MCP Servers

One self-contained TypeScript MCP server with its own `package.json`, `tsconfig.json`, and test suite:

- **exarchos** (`plugins/exarchos/servers/exarchos-mcp/`) — Unified server combining workflow HSM (state machine transitions), append-only event store (JSONL), CQRS materialized views, and agent team coordination (spawn/message/shutdown). Persists to `docs/workflow-state/`. This is the core persistence and coordination mechanism.

Uses `@modelcontextprotocol/sdk` + `zod`, communicates over stdio, and is registered in `~/.claude.json` by the installer.

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
- `docs/workflow-state/` — Workflow state JSON files (gitignored)
- `docs/schemas/` — JSON schemas for state files
