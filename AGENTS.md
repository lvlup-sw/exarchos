# AGENTS.md

## Project Overview

Exarchos is local agent governance for Claude Code. It provides event-sourced SDLC workflows with agent team coordination, installing commands, skills, rules, and MCP plugins to `~/.claude/` via symlinks. Workflows survive context compaction through persistent state and auto-resume on session start.

## Tech Stack

- **Languages:** TypeScript (strict mode, ESM), Bash, Markdown (structured with YAML frontmatter)
- **Runtime:** Node.js >= 20, Bun (bundler)
- **Testing:** Vitest (co-located `*.test.ts`), bash integration tests (co-located `*.test.sh`)
- **MCP Framework:** `@modelcontextprotocol/sdk` + `zod`
- **Build:** `tsc` for type checking, `bun build` for bundling MCP server and CLI
- **Tools:** Claude Code CLI, Graphite CLI (stacked PRs)

## Code Organization

| Directory | Purpose |
|-----------|---------|
| `commands/` | Slash commands (`/ideate`, `/plan`, `/delegate`, `/debug`, `/refactor`, `/review`, `/synthesize`, `/checkpoint`, `/resume`, `/tdd`, `/sync-schemas`) |
| `skills/` | Reusable workflow modules with `SKILL.md` and `references/` subdirectories |
| `rules/` | Global behavioral constraints (coding standards, TDD, orchestrator constraints) |
| `scripts/` | Deterministic validation scripts replacing prose checklists in skills |
| `plugins/exarchos/` | Unified MCP server: workflow HSM, event store, CQRS views, team coordination |
| `src/` | Root installer TypeScript source |
| `docs/` | Designs, plans, ADRs, schemas, audits, bug reports |
| `renovate-config/` | Renovate dependency management presets |
| `hooks.json` | CLI hooks for workflow auto-continue and guardrails |
| `manifest.json` | Package manifest consumed by installer |

## MCP Server Architecture

Single server at `plugins/exarchos/servers/exarchos-mcp/` exposing 5 composite tools:

- **exarchos_workflow** — HSM-based workflow lifecycle (init/get/set/cancel)
- **exarchos_event** — Append-only JSONL event store with 33 event types
- **exarchos_orchestrate** — Agent team spawn/message/shutdown + task claim/complete/fail
- **exarchos_view** — CQRS materialized views (pipeline, tasks, workflow status, team status, stack, telemetry)
- **exarchos_sync** — Remote sync (stub)

## Security Considerations

- No secrets stored in repository
- Configuration templates use environment variables
- MCP server communicates over stdio only (no network listeners)
- Workflow state persists to `~/.claude/workflow-state/` (local filesystem only)
- Hook CLI validates tool calls against phase/role guardrails

## Known Tech Debt

- `docs/follow-ups/` — Empty directory, pending cleanup
- Some design docs reference completed/superseded features (Jules integration, pre-Exarchos architecture)

## Scan Preferences

- **Focus areas:** Security vulnerabilities, code quality, outdated patterns, dead code
- **Ignore patterns:** `node_modules/`, `.git/`, `dist/`, `coverage/`, `.worktrees/`, `.serena/`, `.terraform/`, `*.tfstate*`, `*.local.json`
- **Severity threshold:** Report Medium and above
- **Special files:** `*.md` files are structured content (commands/skills/rules), not just documentation — treat frontmatter as configuration
