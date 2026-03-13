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
- **MCP server** (`servers/exarchos-mcp/`) — 4 visible composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) + 1 hidden sync tool (`exarchos_sync`). Uses `@modelcontextprotocol/sdk` + `zod` over stdio.
- **Orchestrate handlers** (`servers/exarchos-mcp/src/orchestrate/`) — TypeScript handlers for all workflow actions. Each handler accepts typed args, returns structured `ToolResult`. No bash dependency for workflow operations.

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
