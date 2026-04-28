# CLAUDE.md

Exarchos is local agent governance for Claude Code — event-sourced SDLC workflows with agent team coordination. Distributes as a Claude Code plugin via the lvlup-sw marketplace.

## Build & Test

```bash
npm run build          # tsc + bun → dist/ (includes MCP server + CLI bundles)
npm run test:run       # vitest single run
npm run typecheck      # tsc --noEmit
npm run build:skills   # render skills-src/ → skills/<runtime>/ per-runtime variants
npm run skills:guard   # CI: fails if generated skills/ is out of sync with skills-src/

# MCP server tests (build is handled by root `npm run build`)
cd servers/exarchos-mcp && npm run test:run
```

## Architecture

- **Installer** — Bootstrap scripts (`scripts/get-exarchos.sh`, `scripts/get-exarchos.ps1`) download the single-file binary from GitHub Releases; plugin packaging registers commands/skills/rules via the `.claude-plugin/` manifest. The npx-based `src/install.ts` was removed in v2.9 (task 3.1).
- **Content layers** — Commands (`commands/*.md`); Skills source-of-truth at `skills-src/<name>/SKILL.md` (with `{{TOKEN}}` placeholders and `references/`) rendered to `skills/<runtime>/<name>/SKILL.md` per runtime (Claude Code, Codex, Copilot, Cursor, OpenCode, generic); Rules (`rules/*.md` — safety only; domain rules in `skills-src/*/references/`). Structured Markdown, not executable code.
- **Skills renderer** (`src/build-skills.ts`) — `npm run build:skills` walks `skills-src/`, substitutes placeholders from `runtimes/<name>.yaml`, copies each skill's `references/` verbatim into every runtime variant, honors `SKILL.<runtime>.md` structural overrides, and prunes stale output. A vocabulary lint runs as a pre-flight; `npm run skills:guard` re-renders and fails CI on any `git diff skills/` drift.
- **MCP server** (`servers/exarchos-mcp/`) — 4 visible composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) + 1 hidden sync tool (`exarchos_sync`). Uses `@modelcontextprotocol/sdk` + `zod` over stdio.
- **Orchestrate handlers** (`servers/exarchos-mcp/src/orchestrate/`) — TypeScript handlers for all workflow actions. Each handler accepts typed args, returns structured `ToolResult`. No bash dependency for workflow operations.
- **Remote MCP** — future deployment axis; see [`docs/designs/future/remote-mcp-deployment.md`](docs/designs/future/remote-mcp-deployment.md) (tracking: [#1081](https://github.com/lvlup-sw/exarchos/issues/1081)). Not implemented today.

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
- **Skills source-of-truth** — Edit `skills-src/<name>/SKILL.md`, then run `npm run build:skills` and commit both the source and the regenerated `skills/` tree. Direct edits to `skills/<runtime>/**` will fail the `skills:guard` CI check.
- **Reference-file frontmatter** — Files under `skills-src/<skill>/references/*.md` MUST NOT have YAML frontmatter. Frontmatter is reserved for skill entry points (`SKILL.md`, `commands/*.md`, `rules/*.md`). Reference files are includes; frontmatter is metadata noise that triggers spurious validator complaints.

## Workflow Dispatch Conventions

- Always dispatch parallel sub-agents from the correct feature/phase branch, never from `main`. Verify base branch topology before launching waves.
- When running merge commands, confirm you are in the main worktree (not a sub-agent worktree) before executing.
- For workflow pruning/archiving, do not rely solely on the prune tool — verify stale counts and fall back to manual shell archival when the tool under-reports.
- Insert explicit checkpoints every ~10 tasks or before any phase transition, not just at session end.

## Design Philosophy

- Exarchos ships as a **standalone CLI** with optional MCP subcommand and plugin packaging — not as a Claude Code plugin with MCP tools only.
- New feature designs must follow **agent-first CLI patterns (Aspire-inspired)**, not config-file-centric or human-first designs.
- Validate all designs against axiom/Aspire/roadmap conventions before presenting.

## Local Repro & Verification

- Before claiming local repro requires new seeding/test accounts, check for existing demo admin credentials and wired databases (e.g., Turso).
- For browser automation, use `playwright-cli` as the default tool — do not attempt the Chrome extension first.
