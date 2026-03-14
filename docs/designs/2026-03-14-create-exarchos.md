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
| `@lvlup-sw/exarchos-dev` | Installs Serena, Context7, Microsoft Learn | To be deprecated |
| axiom | Backend quality plugin | Separate marketplace plugin |
| impeccable | Frontend design quality plugin | Separate marketplace plugin, `npx skills add` |

### What we want

`npx create-exarchos` — interactive installer that:
- Detects environment (Claude Code, Cursor, other MCP client, terminal)
- Installs Exarchos via the appropriate path
- Offers companions as checkboxes
- Handles humanize as part of axiom (DIM-8: Prose Quality)

## Design

### Package: `create-exarchos`

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
  [x] axiom — backend quality checks (7 dimensions + prose quality)
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

### Environment detection and install paths

| Environment | Detection | Exarchos install | Companion install |
|-------------|-----------|-----------------|-------------------|
| Claude Code | `~/.claude/` exists, `claude` on PATH | `claude plugin install exarchos@lvlup-sw` | Plugin marketplace for axiom/impeccable, settings.json for serena/context7 |
| Cursor | `.cursor/` exists in cwd or home | Write `.cursor/mcp.json` with Exarchos server | Write companion MCP configs; skills via `npx skills add` |
| Other MCP client | Manual selection | Write `.mcp.json` with Exarchos server config | Write companion MCP configs where applicable |
| Terminal (CLI) | Manual selection | `npm i -g @lvlup-sw/exarchos` or symlink | Skip — companions are MCP/plugin features |

### Companion registry

Each companion is defined as a record:

```typescript
interface Companion {
  id: string;
  name: string;
  description: string;
  default: boolean;
  install: {
    claudeCode?: { plugin: string; marketplace?: string };
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
    description: 'backend quality checks (7 dimensions + prose quality)',
    default: true,
    install: {
      claudeCode: { plugin: 'axiom@lvlup-sw', marketplace: 'lvlup-sw/.github' },
      cursor: { skills: 'lvlup-sw/axiom' },
    },
  },
  {
    id: 'impeccable',
    name: 'impeccable',
    description: 'frontend design quality (17 skills)',
    default: true,
    install: {
      claudeCode: { plugin: 'impeccable@impeccable', marketplace: 'pbakaus/impeccable' },
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

### Humanize in axiom

Humanize becomes DIM-8: Prose Quality in axiom. The 24 AI-writing patterns from the humanize skill's `references/ai-writing-patterns.md` become the check catalog for this dimension, following axiom's existing pattern:

- `/axiom:humanize` — scan for AI writing patterns in markdown, docs, comments, and user-facing strings
- Checks are deterministic pattern matching (regex against the 24 cataloged tells)
- Findings use axiom's existing severity model (HIGH/MEDIUM/LOW)
- Integrates with Exarchos quality-review the same way DIM-1 through DIM-7 do

This means humanize ships as part of the axiom plugin and gets distributed whenever someone installs axiom. No separate distribution needed.

### Deprecation of @lvlup-sw/exarchos-dev

1. Publish one final version of `@lvlup-sw/exarchos-dev` that prints a deprecation notice and runs `npx create-exarchos` as a passthrough
2. Mark the npm package as deprecated with message: "Use npx create-exarchos instead"
3. Keep the companion/ directory in the Exarchos repo for reference but stop publishing it

### Code reuse from existing companion installer

The existing `companion/src/install.ts` has reusable pieces:

| Function | Reuse? | Notes |
|----------|--------|-------|
| `installPlugins()` | Yes | Enable plugins in settings.json — same logic |
| `installMcpServers()` | Yes | Register MCP servers in .claude.json — same logic |
| `installContentOverlays()` | Partial | Symlink logic is useful, but overlays move to per-companion packages |
| `parseJsonFile()` | Yes | Safe JSON parsing with fallback |

### Package structure

```
create-exarchos/
  src/
    index.ts          # CLI entry point
    detect.ts         # Environment detection
    prompts.ts        # Interactive prompts (using @inquirer/prompts)
    installers/
      claude-code.ts  # Plugin marketplace install
      cursor.ts       # .cursor/mcp.json config
      generic-mcp.ts  # Generic .mcp.json config
      cli.ts          # npm global install
    companions.ts     # Companion registry
    shared.ts         # Reused from companion/src/install.ts
  package.json
  tsconfig.json
```

### Dependencies

- `@inquirer/prompts` — interactive checkbox/select prompts (single dep, no heavy frameworks)
- Node built-ins only for file operations (fs, path, os, child_process)

### Non-interactive mode

Support `--yes` / `-y` flag for CI and scripting:

```bash
npx create-exarchos --yes                          # all defaults
npx create-exarchos --yes --env claude-code        # Claude Code, default companions
npx create-exarchos --yes --env cursor --no-axiom  # Cursor, skip axiom
```

## Requirements

- DR-1: `create-exarchos` npm package with interactive installer
- DR-2: Environment detection (Claude Code, Cursor, generic MCP, CLI)
- DR-3: Companion registry with per-platform install logic
- DR-4: Non-interactive mode with `--yes` flag
- DR-5: Deprecation of `@lvlup-sw/exarchos-dev` with passthrough
- DR-6: Humanize integrated into axiom as DIM-8: Prose Quality
- DR-7: Content overlays from companion installer migrated to create-exarchos
