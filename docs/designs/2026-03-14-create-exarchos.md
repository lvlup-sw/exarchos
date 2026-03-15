# create-exarchos: interactive installer and distribution strategy

**Feature ID:** skill-distribution
**Date:** 2026-03-14
**Status:** Design

## Context

Exarchos 2.5.0 ships three distribution paths:

1. **Claude Code plugin** — `/plugin install exarchos@lvlup-sw` from the marketplace
2. **Standalone MCP server** — `npx @lvlup-sw/exarchos mcp` for any MCP client
3. **Self-contained CLI** — `npm i -g @lvlup-sw/exarchos` or install script

None of these install the companion ecosystem (axiom, impeccable, serena, context7, microsoft-learn). The existing `npx @lvlup-sw/exarchos-dev` installs Serena, Context7, and Microsoft Learn, but it's non-interactive, doesn't handle axiom or impeccable, and doesn't cover the core install itself.

We want a single "paved path" entry point that installs Exarchos and lets the user pick companions interactively.

### Current state

| Package | What it does | Status |
|---------|-------------|--------|
| `@lvlup-sw/exarchos` | Core plugin + MCP server + CLI | Ships as-is |
| `@lvlup-sw/exarchos-dev` | Installs Serena, Context7, Microsoft Learn | Being deprecated |
| axiom | Backend quality plugin (DIM-1 through DIM-7) | Separate marketplace plugin |
| impeccable | Frontend design quality plugin | Separate marketplace plugin, `npx skills add` |

### What we want

`npx create-exarchos` — interactive installer that:
- Detects environment (Claude Code, Cursor, other MCP client, terminal)
- Installs Exarchos via the appropriate path
- Offers companions as checkboxes
- Full platform-agnosticity with first-class Claude Code support via thin content layer

## Design

### Workstream 1: `create-exarchos` npm package

#### Monorepo structure

`create-exarchos` lives at `packages/create-exarchos/` in the exarchos monorepo. The root `package.json` gains npm workspaces:

```json
{
  "workspaces": ["packages/*", "servers/*"]
}
```

This replaces `companion/` entirely — the `companion/` directory and all its contents are deleted.

#### Interactive flow

Published to npm as `create-exarchos`. Invoked via `npx create-exarchos` (npm convention: `npx create-*` resolves to the `create-*` package).

```
npx create-exarchos

  Exarchos — a local-first SDLC workflow harness

? How are you using this?
  > Claude Code
    Cursor
    Other MCP client
    Terminal (CLI only)

? Add companions: (space to toggle, enter to confirm)
  [x] axiom — backend quality checks (8 dimensions incl. prose quality)
  [x] impeccable — frontend design quality (17 skills)
  [x] serena — semantic code analysis
  [x] context7 — library documentation
  [ ] microsoft-learn — Azure and .NET docs

  Installing Exarchos...
  ✓ Plugin installed: exarchos@lvlup-sw
  ✓ Plugin installed: axiom@lvlup-sw
  ✓ Plugin installed: impeccable@impeccable
  ✓ Plugin enabled: serena@claude-plugins-official
  ✓ Plugin enabled: context7@claude-plugins-official

  Run /ideate to start.
```

#### Environment detection and install paths

| Environment | Detection | Exarchos install | Companion install |
|-------------|-----------|-----------------|-------------------|
| Claude Code | `~/.claude/` exists, `claude` on PATH | `claude plugin install exarchos@lvlup-sw` | Plugin marketplace for axiom/impeccable, settings.json for serena/context7, .claude.json for MCP servers |
| Cursor | `.cursor/` exists in cwd or home | Write `.cursor/mcp.json` with Exarchos MCP server | Write companion MCP configs; skills via `npx skills add` |
| Other MCP client | Manual selection | Write `.mcp.json` with Exarchos MCP server config | Write companion MCP configs where applicable |
| Terminal (CLI) | Manual selection | `npm i -g @lvlup-sw/exarchos` or symlink | Skip — companions are MCP/plugin features |

#### Companion registry

Each companion is defined as a record:

```typescript
interface Companion {
  id: string;
  name: string;
  description: string;
  default: boolean;
  install: {
    claudeCode?: { plugin?: string; mcp?: McpServerConfig };
    cursor?: { mcp?: McpServerConfig; skills?: string };
    generic?: { mcp?: McpServerConfig };
  };
}
```

Registry:

```typescript
const COMPANIONS: Companion[] = [
  {
    id: 'axiom',
    name: 'axiom',
    description: 'backend quality checks (8 dimensions incl. prose quality)',
    default: true,
    install: {
      claudeCode: { plugin: 'axiom@lvlup-sw' },
      cursor: { skills: 'lvlup-sw/axiom' },
    },
  },
  {
    id: 'impeccable',
    name: 'impeccable',
    description: 'frontend design quality (17 skills)',
    default: true,
    install: {
      claudeCode: { plugin: 'impeccable@impeccable' },
      cursor: { skills: 'pbakaus/impeccable' },
    },
  },
  {
    id: 'serena',
    name: 'serena',
    description: 'semantic code analysis',
    default: true,
    install: {
      claudeCode: { plugin: 'serena@claude-plugins-official' },
    },
  },
  {
    id: 'context7',
    name: 'context7',
    description: 'library documentation',
    default: true,
    install: {
      claudeCode: { plugin: 'context7@claude-plugins-official' },
    },
  },
  {
    id: 'microsoft-learn',
    name: 'microsoft-learn',
    description: 'Azure and .NET docs',
    default: false,
    install: {
      claudeCode: { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } },
      generic: { mcp: { type: 'http', url: 'https://learn.microsoft.com/api/mcp' } },
    },
  },
];
```

#### Package structure

```
packages/create-exarchos/
  src/
    index.ts          # CLI entry point
    detect.ts         # Environment detection
    prompts.ts        # Interactive prompts (using @inquirer/prompts)
    installers/
      claude-code.ts  # Plugin marketplace install via `claude` CLI
      cursor.ts       # .cursor/mcp.json config
      generic-mcp.ts  # Generic .mcp.json config
      cli.ts          # npm global install
    companions.ts     # Companion registry
    utils.ts          # parseJsonFile, path helpers
  package.json
  tsconfig.json
```

#### Dependencies

- `@inquirer/prompts` — interactive checkbox/select prompts (single dep, no heavy frameworks)
- Node built-ins only for file operations (fs, path, os, child_process)

#### Non-interactive mode

Support `--yes` / `-y` flag for CI and scripting:

```bash
npx create-exarchos --yes                          # all defaults
npx create-exarchos --yes --env claude-code        # Claude Code, default companions
npx create-exarchos --yes --env cursor --no-axiom  # Cursor, skip axiom
```

### Workstream 2: Axiom DIM-8 — Prose Quality

Humanize becomes DIM-8: Prose Quality in axiom. The 24 AI-writing patterns from the humanize skill become the check catalog for this dimension, following axiom's established patterns.

**Implementation in `lvlup-sw/axiom` repo:**

#### New skill: `skills/humanize/`

```
skills/humanize/
  SKILL.md              # Frontmatter + process for prose quality scanning
  references/
    ai-writing-patterns.md   # 24 cataloged AI-writing tells with detection heuristics
    severity-guide.md        # When to assign HIGH/MEDIUM/LOW per pattern
```

Frontmatter follows axiom convention:

```yaml
---
name: humanize
description: "Scan for AI writing patterns in markdown, docs, comments, and user-facing strings. Detects 24 cataloged AI-writing tells across content, language, style, communication, and filler categories."
user-invokable: true
metadata:
  author: lvlup-sw
  version: 0.1.0
  category: assessment
  dimensions:
    - prose-quality
---
```

#### Pattern catalog → deterministic checks

The 24 patterns map to check IDs following axiom's `T-{dim}.{seq}` convention:

| Category | Patterns | Check IDs | Severity |
|----------|----------|-----------|----------|
| Content (6) | Inflated significance, notability emphasis, superficial -ing analyses, promotional language, vague attributions, formulaic sections | PQ-1.1 through PQ-1.6 | MEDIUM |
| Language/Grammar (6) | AI vocabulary words, copula avoidance, negative parallelisms, rule of three, elegant variation, false ranges | PQ-2.1 through PQ-2.6 | HIGH (vocab), MEDIUM (others) |
| Style (6) | Em dash overuse, boldface overuse, inline-header lists, title case headings, emojis in prose, curly quotes | PQ-3.1 through PQ-3.6 | LOW-MEDIUM |
| Communication (3) | Collaborative artifacts, knowledge-cutoff disclaimers, sycophantic tone | PQ-4.1 through PQ-4.3 | HIGH |
| Filler/Hedging (3) | Filler phrases, excessive hedging, generic positive conclusions | PQ-5.1 through PQ-5.3 | MEDIUM |

Checks are regex-based pattern matching against text content. Default file scope: `*.md`, `*.txt`, `*.mdx`, plus comments and user-facing strings in source files.

#### Updates to existing axiom files

1. **`skills/backend-quality/references/dimensions.md`** — Add DIM-8: Prose Quality definition
2. **`skills/backend-quality/references/deterministic-checks.md`** — Add PQ-* check section
3. **`skills/audit/SKILL.md`** — Add humanize to orchestration sequence
4. **`skills/audit/references/composition-guide.md`** — Add execution order entry (after verify, before verdict)
5. **`skills/backend-quality/SKILL.md`** — Update dimension count (7 → 8)
6. **`tests/dimension-coverage.test.ts`** — Update expected dimension count
7. **`.claude-plugin/plugin.json`** — Version bump

#### Integration with Exarchos quality-review

Integrates the same way DIM-1 through DIM-7 do — the existing `skills/quality-review/references/axiom-integration.md` in the exarchos repo already handles plugin detection and finding merge. DIM-8 findings flow through the same Tier 2 conditional execution path.

### Workstream 3: Deprecation and cleanup

#### Delete `companion/` directory

Remove entirely from the exarchos repo:
- `companion/` — all contents (src, dist, rules, skills, .claude-plugin, package.json, etc.)
- `companion-skills/` — if present and unused

No "keep for reference" — git history preserves everything.

#### Final `@lvlup-sw/exarchos-dev` release

1. Publish one final version that prints a deprecation notice and runs `npx create-exarchos` as a passthrough
2. Mark the npm package as deprecated: `npm deprecate @lvlup-sw/exarchos-dev "Use npx create-exarchos instead"`

#### Content overlay migration

The two content overlays from companion need assessment:

| Overlay | Decision |
|---------|----------|
| `rules/mcp-tool-guidance.md` | Evaluate if still needed — if the guidance is already covered by exarchos rules, drop it. If unique, move to exarchos core rules. |
| `skills/workflow-state/references/companion-mcp-reference.md` | Evaluate if still needed — companion MCP servers (serena, context7, microsoft-learn) are now installed by create-exarchos directly. If the reference content is still useful for workflow-state, keep it in exarchos core. |

#### Monorepo enablement

Add npm workspaces to root `package.json`:

```json
{
  "workspaces": ["packages/*", "servers/*"]
}
```

Update `scripts/sync-versions.sh` to include `packages/create-exarchos/package.json`.

## Requirements

- DR-1: `create-exarchos` npm package at `packages/create-exarchos/` with interactive installer
- DR-2: Environment detection (Claude Code, Cursor, generic MCP, CLI) — all first-class
- DR-3: Companion registry with per-platform install logic
- DR-4: Non-interactive mode with `--yes` flag
- DR-5: Final deprecation release of `@lvlup-sw/exarchos-dev` with passthrough
- DR-6: Delete `companion/` and `companion-skills/` directories
- DR-7: npm workspaces for monorepo (`packages/*`, `servers/*`)
- DR-8: Axiom DIM-8: Prose Quality — new `humanize` skill with 24-pattern check catalog
- DR-9: Axiom dimension count updated (7 → 8) across all references
- DR-10: Axiom audit orchestration updated to include humanize
- DR-11: Content overlay migration (assess and migrate or drop)
