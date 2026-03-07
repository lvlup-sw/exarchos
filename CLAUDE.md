# CLAUDE.md

Exarchos is local agent governance for Claude Code — event-sourced SDLC workflows with agent team coordination. Distributes as a Claude Code plugin via the lvlup-sw marketplace.

## Build & Test

```bash
npm run build          # tsc + bun → dist/ (includes MCP server + CLI bundles)
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit

# MCP server tests (build is handled by root `npm run build`)
cd servers/exarchos-mcp && npm run test:run
```

## Architecture

- **Installer** (`src/install.ts`) — Symlinks commands/skills/rules to `~/.claude/`, registers MCP servers in `~/.claude.json`
- **Content layers** — Commands (`commands/*.md`), Skills (`skills/*/SKILL.md` with `references/`), Rules (`rules/*.md` — safety only; domain rules in `skills/*/references/`). Structured Markdown, not executable code.
- **MCP server** (`servers/exarchos-mcp/`) — 5 composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, `exarchos_sync`). Uses `@modelcontextprotocol/sdk` + `zod` over stdio.
- **Script resolution** — Scripts resolve from `EXARCHOS_PLUGIN_ROOT/scripts/` (plugin install) with fallback to `~/.claude/scripts/` (companion installer). Skills invoke scripts via `exarchos_orchestrate({ action: "run_script" })`, not direct bash paths.
- **Validation scripts** (`scripts/`) — Deterministic bash replacing prose checklists. Pattern: `set -euo pipefail`, exit codes 0/1/2, co-located `.test.sh`.

## Safety

- **NEVER:** `rm -rf /`, `rm -rf ~`, `rm -rf .` in home/root, `rm` with unset variables (`$UNSET_VAR/*`)
- **ALWAYS:** Use specific paths, `ls` before deleting, avoid `-f` unless needed, verify `-r` targets. When uncertain, preview with `echo rm ...` or ask.

## Key Conventions

- **ESM** — `"type": "module"`, NodeNext resolution
- **Strict TypeScript** — `strict: true`, no `any`, `unknown` with type guards
- **Co-located tests** — `foo.test.ts` alongside `foo.ts`
- **Vitest** — `import { describe, it, expect, vi } from 'vitest'`
- **No runtime deps** for root installer; **Node >= 20**
- **Skill frontmatter** — `name` (kebab-case), `description` (<=1,024 chars), `metadata`
- **Skill metadata** — Skills invoking Exarchos MCP tools MUST include `metadata.mcp-server: exarchos` in frontmatter. Utility/standards skills without MCP dependency are exempt.
