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
npx vitest run src/install.test.ts                                           # root installer
cd plugins/exarchos/servers/exarchos-mcp && npx vitest run src/__tests__/workflow/state-machine.test.ts
```

## Validation Scripts

The `scripts/` directory contains deterministic validation scripts that replace prose checklists in skills. All scripts follow a consistent pattern: `set -euo pipefail`, exit codes (0=pass, 1=fail, 2=usage), and markdown output. Each has a co-located `.test.sh` integration test.

| Category | Scripts |
|----------|---------|
| **Synthesis** | `pre-synthesis-check.sh`, `reconstruct-stack.sh`, `check-coderabbit.sh`, `coderabbit-review-gate.sh` |
| **Delegation** | `setup-worktree.sh`, `post-delegation-check.sh`, `extract-fix-tasks.sh`, `needs-schema-sync.sh` |
| **Git Worktrees** | `verify-worktree.sh`, `verify-worktree-baseline.sh` |
| **Quality Review** | `review-verdict.sh`, `static-analysis-gate.sh`, `security-scan.sh` |
| **Planning** | `spec-coverage-check.sh`, `verify-plan-coverage.sh`, `generate-traceability.sh`, `check-tdd-compliance.sh`, `check-coverage-thresholds.sh` |
| **Refactor** | `assess-refactor-scope.sh`, `check-polish-scope.sh`, `validate-refactor.sh`, `verify-doc-links.sh` |
| **Debug** | `investigation-timer.sh`, `select-debug-track.sh`, `debug-review-gate.sh` |
| **Misc** | `verify-ideate-artifacts.sh`, `reconcile-state.sh`, `validate-dotnet-standards.sh` |

**Integration tests** verify that each SKILL.md properly references its validation scripts:
```bash
# Run all skill integration tests
for f in scripts/validate-*-skill.test.sh scripts/validate-misc-skills.test.sh; do
  bash "$f"
done
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
  Skills use YAML frontmatter (`name`, `description`, `metadata`) following
  Anthropic's skill format. The `description` field includes trigger phrases
  for when the skill should activate. Larger skills use `references/`
  subdirectories for progressive disclosure of detailed content.
- **Rules** (`rules/*.md`) — Behavioral constraints applied globally. Some use `paths` frontmatter to scope to specific file patterns.

### MCP Servers

One self-contained TypeScript MCP server with its own `package.json`, `tsconfig.json`, and test suite:

- **exarchos** (`plugins/exarchos/servers/exarchos-mcp/`) — Unified server combining workflow HSM (state machine transitions), append-only event store (JSONL), CQRS materialized views, and task coordination. Persists to `~/.claude/workflow-state/` (configurable via `WORKFLOW_STATE_DIR` env var). Exposes 5 composite MCP tools with `action` discriminators, registered from a central tool registry. Note: inter-agent messaging is handled by Claude Code's native Agent Teams, not by Exarchos.

Uses `@modelcontextprotocol/sdk` + `zod`, communicates over stdio, and is registered in `~/.claude.json` by the installer.

**Composite tools** (each routes to underlying handler functions via `action` field):

| Tool | Actions | Purpose |
|------|---------|---------|
| `exarchos_workflow` | `init`, `get`, `set`, `cancel` | Workflow CRUD |
| `exarchos_event` | `append`, `query` | Event sourcing |
| `exarchos_orchestrate` | `task_claim`, `task_complete`, `task_fail` | Task coordination |
| `exarchos_view` | `pipeline`, `tasks`, `workflow_status`, `stack_status`, `stack_place` | CQRS read views |
| `exarchos_sync` | `now` | Outbox drain (no-op sender until remote wired) |

**Key modules:**

- `workflow/state-machine.ts` — Types/interfaces, transition algorithm, HSM registry
- `workflow/guards.ts` — Guard definitions (26 guards) for all HSM transitions
- `workflow/hsm-definitions.ts` — HSM definitions for feature/debug/refactor workflows
- `workflow/tools.ts` — Handler functions for init, get, set. Uses CAS versioning (`_version` field) with retry loop to prevent lost updates on concurrent writes. Emits transition events to external JSONL store after successful state write (state-first, event-after). Responses strip internal fields (`_events`, `_history`) and include compact `_meta` summaries. Fast-path for simple queries (phase, featureId) skips full Zod validation.
- `workflow/composite.ts` — Composite router dispatching `action` to init/get/set/cancel handlers
- `workflow/next-action.ts` — Auto-continue logic and phase-to-action mapping (used by CLI hooks)
- `workflow/cancel.ts` — Saga compensation and workflow cancellation with checkpoint persistence for resumable compensation on partial failure
- `registry.ts` — Single source of truth for all tool metadata (names, schemas, phase/role mappings). Consumed by `index.ts` for registration and by CLI hooks for guardrails
- `cli.ts` — Hook CLI entry point (`pre-compact`, `session-start`, `guard`, `task-gate`, `teammate-gate`, `subagent-context`)
- `event-store/` — Zod event schemas (22 types including workflow.transition, workflow.fix-cycle), JSONL store with `.seq` files for O(1) sequence initialization, append/query tools. Supports idempotency keys (persisted in JSONL, cache rebuilt on restart) and pre-parse sequence filtering for fast queries
- `views/` — CQRS materializer (cached singleton per server lifecycle, LRU-bounded), 5 view types (pipeline, tasks, workflow status, task detail, stack) plus telemetry projection. Pipeline view uses lazy pagination (materializes only the requested subset)
- `tasks/` — Task claim/complete/fail tools with CQRS materializer for claim-status checks and optimistic concurrency (expectedSequence) for atomic claims
- `stack/` — Stack status/place tools with offset/limit pagination
- `telemetry/` — Performance telemetry: projections, hints, middleware, percentile calculations, benchmarks
- `sync/` — Remote sync state management (outbox drain, stub sender)
- `orchestrate/` — Composite router for task coordination actions
- `format.ts` — Canonical `ToolResult` interface (all modules import from here) and shared formatting helpers

### Three Workflow Types

**Feature:** `/ideate` → `/plan` → plan-review → `/delegate` → `/review` → `/synthesize`
**Debug:** `/debug` → triage → investigate → fix → validate (hotfix or thorough tracks)
**Refactor:** `/refactor` → explore → brief → implement → validate (polish or overhaul tracks)

Human checkpoints only at plan-review approval and merge confirmation. Everything else auto-continues via the SessionStart hook (which determines next action on resume).

### Orchestrator Pattern

The main Claude Code session coordinates but does not write implementation code (exception: polish-track refactors). All code changes go through agent teammates dispatched to git worktrees. This preserves context window for coordination.

## Key Conventions

- **ESM throughout** — All packages use `"type": "module"` with NodeNext resolution
- **Strict TypeScript** — `strict: true`, no `any`, use `unknown` with type guards
- **Co-located tests** — `foo.test.ts` alongside `foo.ts`, not in separate `tests/` dir
- **Vitest** — Import explicitly: `import { describe, it, expect, vi } from 'vitest'` (no globals)
- **No runtime dependencies** for the root installer — only devDependencies
- **Node >= 20** required across all packages
- **Skill frontmatter** — Every `SKILL.md` has YAML frontmatter with `name`
  (kebab-case, matches folder), `description` (<=1,024 chars, WHAT + WHEN +
  triggers), and `metadata` (author, version, mcp-server, category, phase-affinity)

## Docs Directory

- `docs/designs/` — Feature design documents
- `docs/plans/` — TDD implementation plans
- `docs/adrs/` — Architecture Decision Records
- `docs/rca/` — Root Cause Analysis documents
- `docs/schemas/` — JSON schemas for state files
- `docs/audits/` — Testing and quality audit findings
- `docs/bugs/` — Bug reports and investigation notes
- `docs/prompts/` — Prompt optimization templates
