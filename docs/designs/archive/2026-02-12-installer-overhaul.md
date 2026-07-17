# Design: Installer Overhaul

## Problem Statement

The current Exarchos installer (`src/install.ts`) uses symlinks to connect repo content (`commands/`, `skills/`, `rules/`, `scripts/`, `settings.json`) into `~/.claude/`. This approach has three critical weaknesses:

1. **Symlink brittleness** — Symlinks encode absolute paths. Moving, renaming, or re-cloning the repo silently breaks all linked content. Claude Code gets cryptic errors when reading through dead symlinks, with no self-healing or detection.

2. **Slow, network-dependent MCP build** — Install runs `npm install && npm run build` on the exarchos MCP server. This takes 10-15 seconds, requires network access, and can fail for various npm reasons. The built artifacts are referenced by absolute path in `~/.claude.json`, creating another brittle path dependency.

3. **Zero user interaction** — No prerequisite detection, no configuration choices, no progress feedback. The installer either works silently or fails cryptically. Team members and future public users get no guidance on what's being installed or why.

### Target Audience

- **Primary:** Team distribution at lvlup-sw — developers adopting Exarchos workflows
- **Secondary:** Public package consumers installing via `bunx github:lvlup-sw/exarchos`

### Success Criteria

- Install completes in < 5 seconds on a warm cache
- No symlinks in the default installation path (copy-based)
- Survives repo moves, renames, and re-clones without breaking
- Interactive wizard with prerequisite detection and configuration
- Idempotent — safe to re-run, updates only changed files
- MCP server runs from `~/.claude/` with zero dependency on repo path
- Developer mode preserves live-editing ergonomics for Exarchos contributors

## Chosen Approach

**Option 3: Bun-native installer with bundled artifacts and interactive wizard.**

Copy-first with dev mode. Bun bundler produces single-file MCP server. Interactive wizard using Bun-native prompt library. Manifest-driven component registry. Content hash tracking for smart updates.

### Why Bun

Anthropic [acquired Bun in December 2025](https://bun.com/blog/bun-joins-anthropic) to power Claude Code infrastructure. Building on Bun aligns Exarchos with the platform's direction:

- **Bun bundler** replaces esbuild — zero additional bundler dependency
- **`bun install`** is 10-25x faster than `npm install` for development
- **`bun test`** can replace Vitest for installer tests (native test runner)
- **`bun build --outfile`** produces single `.js` bundles from TypeScript + dependencies
- **Future:** `bun compile` for standalone executables when binary size improves

### Why Not

- **`bun build --compile`** — Produces ~90MB binaries (embeds Bun runtime). Too large for "reasonably sized artifacts" goal. Revisit when Bun shrinks compiled output.
- **`@clack/prompts`** — Has [documented Bun compatibility issues](https://github.com/oven-sh/bun/issues/7033): multi-prompt flows fail, EPERM stdin errors in recent Bun versions. Use Bun-native prompts instead.
- **Node.js SEA** — Still experimental, and Claude Code will increasingly assume Bun availability.

## Technical Design

### Architecture Overview

```
bunx github:lvlup-sw/exarchos
         │
         ▼
┌─────────────────────┐
│   Install Wizard    │  ← Interactive prompts (bun-promptx)
│   (dist/install.js) │  ← Bundled single file
└────────┬────────────┘
         │
         ├── Read manifest.json (component registry)
         ├── Detect prerequisites (bun, gt, node)
         ├── Present wizard (mode, servers, plugins, rules, model)
         ├── Copy content files to ~/.claude/
         │     ├── commands/*.md
         │     ├── skills/**/*
         │     ├── rules/*.md (selected sets)
         │     ├── scripts/*
         │     └── settings.json (generated from selections)
         ├── Copy MCP server bundle to ~/.claude/mcp-servers/
         │     └── exarchos-mcp.js (~200-400KB single file)
         ├── Write ~/.claude.json (MCP server entries)
         ├── Write ~/.claude/exarchos.config.json (saved selections)
         └── Verify installation
```

### Component Manifest

A `manifest.json` at the repo root describes all installable components. The wizard reads this to present options and the installer uses it to determine what to copy where.

```typescript
interface Manifest {
  version: string;                    // Exarchos version
  components: {
    core: CoreComponent[];            // Always installed
    mcpServers: McpServerComponent[]; // Required + optional servers
    plugins: PluginComponent[];       // Claude official plugins
    ruleSets: RuleSetComponent[];     // Language-specific rules
  };
  defaults: {
    model: string;                    // Default model preference
    mode: 'standard' | 'dev';        // Default install mode
  };
}

interface CoreComponent {
  id: string;                         // e.g., "commands", "skills"
  source: string;                     // Relative path in repo
  target: string;                     // Relative path in ~/.claude/
  type: 'directory' | 'file';
}

interface McpServerComponent {
  id: string;                         // e.g., "exarchos", "graphite"
  name: string;                       // Display name
  description: string;                // One-line description
  required: boolean;                  // Always installed?
  type: 'bundled' | 'external' | 'remote';
  // For bundled: source bundle path
  bundlePath?: string;                // e.g., "dist/exarchos-mcp.js"
  // For external: command + args
  command?: string;                   // e.g., "gt"
  args?: string[];                    // e.g., ["mcp"]
  prerequisite?: string;              // CLI command that must exist
  // For remote: URL
  url?: string;                       // e.g., "https://learn.microsoft.com/api/mcp"
}

interface PluginComponent {
  id: string;                         // e.g., "github@claude-plugins-official"
  name: string;                       // Display name
  description: string;
  required: boolean;
  default: boolean;                   // Pre-selected in wizard
}

interface RuleSetComponent {
  id: string;                         // e.g., "typescript", "csharp"
  name: string;                       // Display name
  description: string;
  files: string[];                    // Rule files to copy
  default: boolean;                   // Pre-selected in wizard
}
```

**Example `manifest.json`:**

```json
{
  "version": "2.0.0",
  "components": {
    "core": [
      { "id": "commands", "source": "commands", "target": "commands", "type": "directory" },
      { "id": "skills", "source": "skills", "target": "skills", "type": "directory" },
      { "id": "scripts", "source": "scripts", "target": "scripts", "type": "directory" }
    ],
    "mcpServers": [
      {
        "id": "exarchos",
        "name": "Exarchos",
        "description": "Workflow orchestration, event sourcing, team coordination",
        "required": true,
        "type": "bundled",
        "bundlePath": "dist/exarchos-mcp.js"
      },
      {
        "id": "graphite",
        "name": "Graphite",
        "description": "Stacked PRs and merge queue",
        "required": true,
        "type": "external",
        "command": "gt",
        "args": ["mcp"],
        "prerequisite": "gt"
      },
      {
        "id": "microsoft-learn",
        "name": "Microsoft Learn",
        "description": "Official Azure/.NET documentation",
        "required": false,
        "type": "remote",
        "url": "https://learn.microsoft.com/api/mcp"
      }
    ],
    "plugins": [
      {
        "id": "github@claude-plugins-official",
        "name": "GitHub",
        "description": "PRs, issues, code search",
        "required": false,
        "default": true
      },
      {
        "id": "serena@claude-plugins-official",
        "name": "Serena",
        "description": "Semantic code analysis",
        "required": false,
        "default": true
      },
      {
        "id": "context7@claude-plugins-official",
        "name": "Context7",
        "description": "Library documentation",
        "required": false,
        "default": true
      }
    ],
    "ruleSets": [
      {
        "id": "typescript",
        "name": "TypeScript",
        "description": "Coding standards and TDD rules for TypeScript",
        "files": ["coding-standards-typescript.md", "tdd-typescript.md"],
        "default": true
      },
      {
        "id": "csharp",
        "name": "C# / .NET",
        "description": "Coding standards and TDD rules for C#",
        "files": ["coding-standards-csharp.md", "tdd-csharp.md"],
        "default": false
      },
      {
        "id": "workflow",
        "name": "Workflow & Orchestration",
        "description": "Orchestrator constraints, PR descriptions, primary workflows",
        "files": [
          "orchestrator-constraints.md",
          "pr-descriptions.md",
          "primary-workflows.md",
          "workflow-auto-resume.md",
          "mcp-tool-guidance.md",
          "skill-path-resolution.md",
          "rm-safety.md"
        ],
        "default": true
      }
    ]
  },
  "defaults": {
    "model": "claude-opus-4-6",
    "mode": "standard"
  }
}
```

### Installation Modes

#### Standard Mode (default)

Files are copied from the repo/package into `~/.claude/`. No symlinks. No dependency on repo path after install.

```
~/.claude/
  commands/           ← copied from repo
  skills/             ← copied from repo
  rules/              ← copied (selected rule sets only)
  scripts/            ← copied from repo
  settings.json       ← generated from wizard selections
  mcp-servers/
    exarchos-mcp.js   ← bundled MCP server (single file)
  exarchos.config.json ← saved wizard selections + content hashes
```

**Content hash tracking:** Each copied file's SHA-256 hash is stored in `exarchos.config.json`. On re-install, only files whose source hash differs from the installed hash are updated. This makes re-install fast and safe.

```typescript
interface ExarchosConfig {
  version: string;                    // Installed Exarchos version
  installedAt: string;                // ISO timestamp
  mode: 'standard' | 'dev';
  repoPath?: string;                  // Only set in dev mode
  selections: {
    mcpServers: string[];             // IDs of selected servers
    plugins: string[];                // IDs of selected plugins
    ruleSets: string[];               // IDs of selected rule sets
    model: string;                    // Selected model
  };
  hashes: Record<string, string>;     // file path -> SHA-256
}
```

#### Dev Mode (`--dev`)

Symlinks for content directories (same as current behavior) plus the unbundled MCP server running from the repo. For Exarchos contributors only.

```
~/.claude/
  commands  → <repo>/commands         ← symlink
  skills    → <repo>/skills           ← symlink
  rules     → <repo>/rules            ← symlink (all rules, not filtered)
  scripts   → <repo>/scripts          ← symlink
  settings.json → <repo>/settings.json ← symlink
  exarchos.config.json                 ← saved config (mode: "dev", repoPath set)
```

`~/.claude.json` MCP entry points to repo's `dist/index.js` (unbundled) instead of the copied bundle.

**Self-healing in dev mode:** On each install/re-install, validate that symlinks are not broken. If the repo has moved, prompt the user to re-run with the correct path or switch to standard mode.

### MCP Server Bundling

The exarchos MCP server is bundled into a single `.js` file using Bun's built-in bundler:

```bash
bun build plugins/exarchos/servers/exarchos-mcp/src/index.ts \
  --outfile dist/exarchos-mcp.js \
  --target bun \
  --minify
```

This bundles `@modelcontextprotocol/sdk`, `zod`, and all internal modules into one file (~200-400KB minified). The bundle is committed to the repo's `dist/` directory so that `bunx` installs include it without a build step.

**`~/.claude.json` MCP configuration:**

```json
{
  "mcpServers": {
    "exarchos": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "~/.claude/mcp-servers/exarchos-mcp.js"],
      "env": {}
    },
    "graphite": {
      "type": "stdio",
      "command": "gt",
      "args": ["mcp"]
    }
  }
}
```

**Runtime detection:** The installer checks for `bun` first, falls back to `node`. The MCP server entry uses whichever runtime is available, preferring `bun`.

### Interactive Wizard

The wizard uses **`bun-promptx`** (Bun-native terminal prompt library) for interactive prompts. This avoids the [documented Bun incompatibilities](https://github.com/oven-sh/bun/issues/7033) with `@clack/prompts`.

**Abstraction layer:** Prompts are accessed through a thin `PromptAdapter` interface so the implementation can be swapped if `bun-promptx` proves inadequate:

```typescript
interface PromptAdapter {
  select<T>(message: string, options: SelectOption<T>[]): Promise<T>;
  multiselect<T>(message: string, options: MultiselectOption<T>[]): Promise<T[]>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  text(message: string, placeholder?: string): Promise<string>;
}
```

**Wizard flow:**

```
Exarchos v2.0.0 — SDLC Workflow Automation for Claude Code
===========================================================

Checking prerequisites...
  bun v1.2.x ✓
  gt v1.x.x  ✓
  node v22.x ✓ (fallback)

? Installation mode
  ● Standard (copy files — recommended)
  ○ Developer (symlinks — Exarchos contributors)

? MCP Servers (required servers cannot be deselected)
  ■ Exarchos    — workflow orchestration        [bundled, required]
  ■ Graphite    — stacked PRs, merge queue      [gt CLI, required]
  □ MS Learn    — Azure/.NET documentation      [remote HTTP]

? Claude Plugins
  ■ GitHub      — PRs, issues, code search
  ■ Serena      — semantic code analysis
  ■ Context7    — library documentation

? Rule Sets
  ■ TypeScript  — coding standards + TDD
  □ C# / .NET   — coding standards + TDD
  ■ Workflow    — orchestrator, PR descriptions, auto-resume

? Default model
  ● Claude Opus 4.6 (most capable)
  ○ Claude Sonnet 4.5 (faster, cheaper)

Installing...
  ✓ Copied commands (12 files)
  ✓ Copied skills (8 modules)
  ✓ Copied rules (9 files)
  ✓ Copied scripts (3 files)
  ✓ Installed exarchos MCP server (342 KB)
  ✓ Configured graphite MCP server
  ✓ Generated settings.json
  ✓ Saved configuration

Installation complete! Run `claude` to start.
```

**Non-interactive mode:** `bunx exarchos --yes` or `bunx exarchos --config path/to/config.json` skips the wizard and uses defaults or a saved configuration. This supports CI/automation and team-wide standardized installs.

**Re-install behavior:** When `exarchos.config.json` already exists, the wizard shows current selections as defaults and highlights what will change. `--yes` re-installs with previous selections.

### Prerequisite Detection

Before presenting the wizard, the installer checks for required and optional tools:

```typescript
interface Prerequisite {
  command: string;          // CLI command to check
  args: string[];           // e.g., ["--version"]
  required: boolean;        // Block install if missing?
  minVersion?: string;      // Minimum version (semver)
  installHint: string;      // How to install if missing
}

const prerequisites: Prerequisite[] = [
  {
    command: 'bun',
    args: ['--version'],
    required: true,
    minVersion: '1.0.0',
    installHint: 'curl -fsSL https://bun.sh/install | bash'
  },
  {
    command: 'gt',
    args: ['--version'],
    required: true,
    installHint: 'brew install withgraphite/tap/graphite'
  },
  {
    command: 'node',
    args: ['--version'],
    required: false,
    minVersion: '20.0.0',
    installHint: 'Optional fallback runtime. Install via nvm or nodejs.org'
  }
];
```

Missing required prerequisites block install with a helpful error:

```
✗ gt not found
  Graphite CLI is required for stacked PR management.
  Install: brew install withgraphite/tap/graphite
  Docs: https://graphite.dev/docs/installing-the-cli
```

Missing optional prerequisites show a warning but proceed.

### Settings Generation

`settings.json` is generated from wizard selections rather than copied from the repo. This allows per-user customization while maintaining a consistent structure.

```typescript
function generateSettings(selections: WizardSelections): Settings {
  return {
    permissions: {
      allow: generatePermissions()  // Same comprehensive list as current
    },
    model: selections.model,
    enabledPlugins: Object.fromEntries(
      selections.plugins.map(id => [id, true])
    )
  };
}
```

The permission set is hardcoded in the installer (not user-configurable) to maintain security consistency. Model and plugin selections come from the wizard.

### Uninstall

`bunx exarchos --uninstall` cleanly removes all installed components:

1. Read `exarchos.config.json` to know what was installed
2. Remove copied content directories and files from `~/.claude/`
3. Remove MCP server bundle from `~/.claude/mcp-servers/`
4. Remove MCP entries from `~/.claude.json`
5. Remove `exarchos.config.json`
6. Preserve any user-created files in `~/.claude/` that weren't installed by Exarchos

### Update Detection

When running in standard mode, the installer can detect staleness:

```typescript
function checkForUpdates(config: ExarchosConfig, manifest: Manifest): UpdateInfo {
  const staleFiles: string[] = [];
  for (const [path, hash] of Object.entries(config.hashes)) {
    const currentHash = computeHash(path);
    if (currentHash !== hash) {
      staleFiles.push(path);
    }
  }
  return {
    installedVersion: config.version,
    availableVersion: manifest.version,
    staleFileCount: staleFiles.length,
    staleFiles
  };
}
```

On re-install, the wizard reports: "3 files have changed since last install. Update? [Y/n]"

### File Structure (New)

```
src/
  install.ts              → Main entry, CLI parsing, orchestrator
  install.test.ts         → Installer unit tests
  wizard/
    prompts.ts            → PromptAdapter + bun-promptx implementation
    prompts.test.ts
    prerequisites.ts      → Environment detection
    prerequisites.test.ts
    display.ts            → Terminal formatting, spinners, colors
    display.test.ts
  manifest/
    types.ts              → Manifest type definitions
    loader.ts             → Read and validate manifest
    loader.test.ts
  operations/
    copy.ts               → File copy with hash tracking
    copy.test.ts
    symlink.ts            → Symlink create/remove/validate (dev mode)
    symlink.test.ts
    config.ts             → ExarchosConfig read/write
    config.test.ts
    mcp.ts                → ~/.claude.json MCP server configuration
    mcp.test.ts
    settings.ts           → settings.json generation
    settings.test.ts
    bundle.ts             → MCP server bundle copy
    bundle.test.ts
manifest.json             → Component registry
```

### Build Pipeline

```json
{
  "scripts": {
    "build": "bun build src/install.ts --outfile dist/install.js --target bun",
    "build:mcp": "bun build plugins/exarchos/servers/exarchos-mcp/src/index.ts --outfile dist/exarchos-mcp.js --target bun --minify",
    "build:all": "bun run build && bun run build:mcp",
    "prepare": "bun run build:all",
    "test": "bun test",
    "test:run": "bun test --run"
  }
}
```

The `prepare` script ensures both bundles are built before `bunx` or npm publish. The dist directory contains:

```
dist/
  install.js          ← Bundled installer (~100KB)
  exarchos-mcp.js     ← Bundled MCP server (~200-400KB)
```

Both are committed to the repo so `bunx github:lvlup-sw/exarchos` works without a build step on the consumer's machine.

## Integration Points

### Claude Code Configuration Files

The installer writes to two configuration files:

| File | Content | Owner |
|------|---------|-------|
| `~/.claude.json` | MCP server entries (exarchos, graphite, optional servers) | Shared — installer merges, never overwrites |
| `~/.claude/settings.json` | Permissions, model, enabled plugins | Exarchos-owned — generated from wizard |
| `~/.claude/exarchos.config.json` | Installation metadata, selections, hashes | Exarchos-owned — installer manages |

**Merge strategy for `~/.claude.json`:** The installer only touches keys it owns (`mcpServers.exarchos`, `mcpServers.graphite`, etc.). Other MCP servers configured by the user are preserved.

### Existing Worktree Support

The `.mcp.json` at the repo root (currently `{ "mcpServers": {} }`) should be updated to reference the bundled MCP server for project-level MCP configuration. This enables worktrees to discover the MCP server without user-level config:

```json
{
  "mcpServers": {
    "exarchos": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "./dist/exarchos-mcp.js"]
    }
  }
}
```

### Migration from v1

The installer detects the current symlink-based installation and migrates:

1. Check if `~/.claude/skills` is a symlink (v1 indicator)
2. If yes, prompt: "Existing symlink installation detected. Migrate to copy-based? [Y/n]"
3. If confirmed:
   - Record the symlink target path (for dev mode if wanted)
   - Remove all Exarchos symlinks
   - Run standard copy-based install
   - Preserve any user customizations in `~/.claude/` that aren't Exarchos-managed

## Testing Strategy

### Unit Tests (bun test)

- **Manifest loading:** Valid manifest parsing, schema validation, missing fields
- **Prerequisite detection:** Command exists/missing, version parsing, min version check
- **File operations:** Copy with hash tracking, symlink create/validate/remove, idempotent re-copy
- **Config management:** ExarchosConfig read/write/merge, ~/.claude.json merge without clobbering
- **Settings generation:** Correct permissions, model, plugin selections
- **Wizard selections:** Default selections from manifest, required items not deselectable
- **Migration detection:** Symlink-based v1 detection, migration flow

### Integration Tests

- **End-to-end install:** Standard mode in temp directory, verify all files copied, hashes recorded
- **End-to-end dev mode:** Symlinks created, MCP points to repo, config records repo path
- **Re-install:** Change selections, verify only changed files updated
- **Uninstall:** Clean removal, user files preserved
- **Migration:** v1 symlinks replaced with copies

### Manual Smoke Test

```bash
# Fresh install
bunx github:lvlup-sw/exarchos

# Verify
claude --version  # Claude Code works
# Start a session — MCP servers should connect

# Re-install (idempotent)
bunx github:lvlup-sw/exarchos --yes

# Uninstall
bunx github:lvlup-sw/exarchos --uninstall
```

## Open Questions

| Question | Options | Recommendation |
|----------|---------|----------------|
| **Prompt library maturity** | `bun-promptx` is newer than `@clack/prompts` | Use `bun-promptx` with `PromptAdapter` abstraction so we can swap if needed. If `bun-promptx` is too immature, fall back to raw `readline`-based prompts. |
| **Bundle in repo or build on demand?** | Commit dist/ or .gitignore it | Commit `dist/` so `bunx` works without build step. CI validates bundle is in sync with source. |
| **`~/.claude/hooks.json`** | Currently symlinked but not in the manifest | Add as a core component. It's user-customizable content that should be copied (not generated). |
| **Bun as hard requirement** | Require `bun` or support `node` fallback for installer itself | Require `bun`. The acquisition signals Bun is the platform direction. For MCP runtime, prefer `bun` with `node` fallback. |
| **Team-wide config standardization** | Each person runs wizard vs. shared config file | Support `--config exarchos.config.json` for team leads to distribute a standard config. |

## Related Documents

| Document | Relationship |
|----------|-------------|
| [Distributed SDLC Pipeline](../adrs/distributed-sdlc-pipeline.md) | Architecture context — MCP server structure and tool surface |
| [Current installer](../../src/install.ts) | Code being replaced |
| [Bun joins Anthropic](https://bun.com/blog/bun-joins-anthropic) | Strategic rationale for Bun adoption |
