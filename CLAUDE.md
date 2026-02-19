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
cd servers/exarchos-mcp && npm run test:run
```

## Architecture

- **Installer** (`src/install.ts`) — Symlinks commands/skills/rules to `~/.claude/`, registers MCP servers in `~/.claude.json`
- **Content layers** — Commands (`commands/*.md`), Skills (`skills/*/SKILL.md` with `references/`), Rules (`rules/*.md`). Structured Markdown, not executable code.
- **MCP server** (`servers/exarchos-mcp/`) — 5 composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`, `exarchos_sync`). Uses `@modelcontextprotocol/sdk` + `zod` over stdio.
- **Validation scripts** (`scripts/`) — Deterministic bash replacing prose checklists. Pattern: `set -euo pipefail`, exit codes 0/1/2, co-located `.test.sh`.

## Workflows

- **Feature:** `/ideate` → `/plan` → `/delegate` → `/review` → `/synthesize` → `/cleanup`
- **Debug:** `/debug` → triage → investigate → fix → validate
- **Refactor:** `/refactor` → explore → brief → implement → validate

Human checkpoints at plan-review and merge only. Auto-continues via SessionStart hook.

## Coding Standards

- **SOLID:** SRP (one component per file), OCP (discriminated unions/strategy pattern), LSP (full interface implementation), ISP (small focused interfaces), DIP (inject dependencies)
- **Control flow:** Guard clauses first, early returns, no arrow code, extract complex conditions into named predicates
- **Error handling:** Result types for recoverable errors, custom error classes for programmer errors, never silent catches, explicit error boundaries at API/UI layers
- **DRY:** Extract duplicated logic, use built-in collection methods (`map`/`filter`/`reduce`, LINQ), leverage standard utility types

## TDD Rules

- **RED:** Write a failing test describing expected behavior — verify it fails for the right reason
- **GREEN:** Write minimum code to pass — no extra features or optimizations
- **REFACTOR:** Clean up while tests stay green — extract helpers, improve naming, apply SOLID
- Test files: `foo.test.ts` co-located alongside `foo.ts`, run: `npm run test:run`
- Test pattern: Arrange/Act/Assert with descriptive names (`Method_Scenario_Outcome`)
- Mocking: `vi.mock()` for modules, `vi.fn()` for functions

## Orchestrator Constraints

- **MUST NOT:** Write implementation code, fix review findings directly, run integration tests inline, work in main project root
- **SHOULD:** Parse/extract plans, dispatch/monitor subagents, manage workflow state, chain phases, handle failures
- **Exception:** During `polish-implement` phase only, the orchestrator may write code directly (stay within brief scope, follow TDD if changing behavior)

## Primary Workflows

| Task | Command |
|------|---------|
| New feature/design | `/ideate` |
| Bug fix | `/debug` |
| Code improvement | `/refactor` |

Supporting: `/plan`, `/delegate`, `/review`, `/synthesize`, `/resume`, `/checkpoint` — phase commands within workflows.

## MCP Tool Guidance

- **Workflow state** — Exarchos MCP (`exarchos_workflow` set/get), never manual JSON editing
- **PR creation** — Graphite MCP (`gt submit --no-interactive --publish --merge-when-ready`), never `gh pr create`

## PR Descriptions

- **Title:** `<type>: <what>` (max 72 chars)
- **Body:** Summary (2-3 sentences) → Changes (bulleted, `**Component** — description`) → Test Plan → Footer (`---` + results, design doc, related PRs). Aim for 120-200 words.

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
