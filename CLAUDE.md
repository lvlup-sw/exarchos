# CLAUDE.md

Exarchos is local agent governance for Claude Code — event-sourced SDLC workflows with agent team coordination. Installs commands, skills, rules, and MCP plugins to `~/.claude/` via symlinks. Workflows survive context compaction through persistent state and auto-resume.

## Distribution

Exarchos distributes as a **Claude Code plugin** via the lvlup-sw marketplace. Install from the marketplace for the standard experience, or use `claude --plugin-dir .` for development.

- **Core plugin** — Exarchos MCP server + Graphite integration (marketplace)
- **Dev companion** — GitHub, Serena, Context7, Microsoft Learn (`npx @lvlup-sw/exarchos-dev`)

## Build & Test

```bash
npm run build          # tsc + bun → dist/ (includes MCP server + CLI bundles)
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit

# MCP server tests (build is handled by root `npm run build`)
cd plugins/exarchos/servers/exarchos-mcp && npm run test:run
```

## Architecture

- **Installer** (`src/install.ts`) — Symlinks commands/skills/rules to `~/.claude/`, registers MCP servers in `~/.claude.json`
- **Content layers** — Commands (`commands/*.md`), Skills (`skills/*/SKILL.md` with `references/`), Rules (`rules/*.md`). Structured Markdown, not executable code.
- **MCP server** (`plugins/exarchos/servers/exarchos-mcp/`) — 5 composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, `exarchos_sync`). Uses `@modelcontextprotocol/sdk` + `zod` over stdio.
- **Validation scripts** (`scripts/`) — Deterministic bash replacing prose checklists. Pattern: `set -euo pipefail`, exit codes 0/1/2, co-located `.test.sh`.

## Workflows

- **Feature:** `/ideate` → `/plan` → `/delegate` → `/review` → `/synthesize` → `/cleanup`
- **Debug:** `/debug` → triage → investigate → fix → validate
- **Refactor:** `/refactor` → explore → brief → implement → validate

Human checkpoints at plan-review and merge only. Auto-continues via SessionStart hook.

## Key Conventions

- **ESM** — `"type": "module"`, NodeNext resolution
- **Strict TypeScript** — `strict: true`, no `any`, `unknown` with type guards
- **Co-located tests** — `foo.test.ts` alongside `foo.ts`
- **Vitest** — `import { describe, it, expect, vi } from 'vitest'`
- **No runtime deps** for root installer; **Node >= 20**
- **Skill frontmatter** — `name` (kebab-case), `description` (<=1,024 chars), `metadata`
