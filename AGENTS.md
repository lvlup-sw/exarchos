# AGENTS.md

## Project Overview

Exarchos is local agent governance for Claude Code. It provides event-sourced SDLC workflows with agent-team coordination. Distribution is a Claude Code plugin (via the lvlup-sw marketplace) or a standalone single-file binary downloaded by the `tools/release/get-exarchos.{sh,ps1}` bootstrap; the plugin manifest registers commands, skills, rules and the MCP server. Workflows survive context compaction through persistent state and auto-resume on session start.

## Tech Stack

- **Languages:** TypeScript (strict mode, ESM), Bash, Markdown (structured with YAML frontmatter)
- **Runtime:** Node.js >= 20, Bun (bundler)
- **Testing:** Vitest `*.test.ts` and bash `*.test.sh`, all under `tests/` in one tier per kind — never beside their subject. Tiers: `acceptance`, `architecture`, `benchmarks`, `core`, `e2e`, `evals`, `helpers`, `integration`, `migration`, `outcome`, `process`, `scripts`, `smoke`, `support`, `unit`
- **MCP Framework:** `@modelcontextprotocol/sdk` + `zod`
- **Build:** `tsc` for type checking, `bun build` for bundling the MCP server and CLI
- **Tools:** Claude Code CLI, GitHub CLI (`gh`) for PRs

## Code Organization

Six directories carry the repository's structure. Each holds a `README.md`
stating what belongs in it and — more usefully — what does not.

| Directory | Purpose |
|-----------|---------|
| `src/` | The shipped product. Arranged as the published layer architecture: storage, event store, projections, workflow, contract + dispatch, verbs, lifecycle, adapters, runtime. |
| `content/` | Authored skills, commands and rules, grouped by domain (`design/`, `delivery/`, `review/`, `synthesis/`, `continuity/`, `governance/`, `remediation/`, `harness/`, `_shared/`). The source of truth. |
| `rendered/` | Generated per-runtime projections of `content/`. Never hand-edited; `npm run render:guard` re-renders and diffs. |
| `tests/` | The single test tree, one tier per kind. |
| `tools/` | Repo automation that never ships: `audit/` (gates and censuses), `release/` (build and publish), `conformance/` (contract censuses), plus lint rules and migrations. |
| `docs/` | Specs, guides, architecture notes, ADRs, RCAs. Start at `docs/ARCHITECTURE.md`. |

Two directories remain at the top level without being structure: `binding/`
(harness binding descriptors) and `hooks/` (required at the plugin root by the
plugin contract). `manifest.json` is the package manifest the installer reads.

## MCP Server Architecture

The server lives in `src/` alongside the CLI — they are two front-ends over one
dispatch core, not separate programs. Five composite tools:

- **exarchos_workflow** — workflow lifecycle (init/get/update/transition/cancel/checkpoint/rehydrate)
- **exarchos_event** — the event store (append/query/batch_append)
- **exarchos_orchestrate** — task coordination, quality gates, VCS operations
- **exarchos_view** — CQRS materialized views (pipeline, tasks, status, telemetry, lifecycle)
- **exarchos_sync** — remote sync (hidden; planned)

Actions are DECLARED in one place, `src/registry/`. Every other description of
the action surface — the MCP registration, the CLI verb tree, `describe`, the
compiled contract — is a projection of those declarations. Adding an action
there and nowhere else is correct and sufficient.

## Security Considerations

- No secrets stored in the repository
- Configuration templates use environment variables
- The MCP server communicates over stdio only (no network listeners)
- Workflow state persists to a local SQLite event store (local filesystem only)
- The hook CLI validates tool calls against phase/role guardrails

## Known Tech Debt

- `docs/` holds a large body of design and plan documents, many superseded — the
  relocation of that prose out of this repository is planned but not done.
- The dead-code allowlist sits at its budget: findings must be resolved rather
  than absorbed.

## Scan Preferences

- **Focus areas:** security vulnerabilities, code quality, outdated patterns, dead code
- **Ignore patterns:** `node_modules/`, `.git/`, `dist/`, `coverage/`, `rendered/` (generated), `.worktrees/`, `.serena/`, `.terraform/`, `*.tfstate*`, `*.local.json`
- **Severity threshold:** report Medium and above
- **Special files:** `*.md` under `content/` is structured content, not prose documentation — treat frontmatter as configuration
