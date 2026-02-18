# Design: Distribution Strategy — Dual-Plugin Monorepo

## Problem Statement

Exarchos currently distributes as a monolithic npm package (`@lvlup-sw/exarchos`) with a custom installer that symlinks/copies everything to `~/.claude/`. This bundles the core MCP server, Graphite, three optional Claude plugins (GitHub, Serena, Context7), Microsoft Learn MCP, rules, skills, commands, and hooks into a single install path. The approach has several problems:

1. **Not discoverable** — Users must know the npm package name and run `npx` to install
2. **Monolithic** — Optional dev plugins are entangled with the core product
3. **Custom installer** — Bypasses Claude Code's native plugin system, creating maintenance burden and fragile symlink/copy logic
4. **No marketplace presence** — Missing the primary discovery channel for Claude Code users

The goal is to restructure Exarchos for Claude Code's native plugin marketplace while cleanly separating core functionality (exarchos + graphite) from convenience developer tools.

## Chosen Approach

**Dual-Plugin Monorepo** — Two native Claude Code plugins built from a single repository:

| Plugin | Distribution | Contents |
|--------|-------------|----------|
| **exarchos** (core) | Claude Code marketplace (listed) | Exarchos MCP server, Graphite MCP, hooks, skills, commands, rules, scripts |
| **exarchos-dev-tools** (companion) | npm package + repo-based install (unlisted) | GitHub, Serena, Context7 plugin enablement, Microsoft Learn MCP |

The repo root IS the core plugin. The dev companion lives in a subdirectory and is distributed separately.

## Technical Design

### Project Structure (Target)

```
exarchos/                          # Root = Core plugin
├── .claude-plugin/
│   ├── plugin.json                # Core plugin manifest
│   └── marketplace.json           # lvlup-sw marketplace (core only)
├── .mcp.json                      # MCP servers (exarchos + graphite)
├── commands/                      # Slash commands
├── skills/                        # Agent skills
├── rules/                         # Agent rules
├── scripts/                       # Validation scripts
├── hooks/
│   └── hooks.json                 # Lifecycle hooks
├── servers/                       # MCP server source (moved from plugins/exarchos/)
│   └── exarchos-mcp/
│       ├── src/
│       ├── dist/                  # Built server + CLI bundles
│       └── package.json
├── dist/                          # Root build output (installer, bundles)
│   ├── exarchos-mcp.js            # MCP server bundle
│   └── exarchos-cli.js            # CLI bundle (for hooks)
├── src/                           # Build tooling + legacy installer
│   ├── install.ts                 # Dev-mode installer (retained for dev workflow)
│   └── ...
├── companion/                     # Dev companion plugin
│   ├── .claude-plugin/
│   │   └── plugin.json            # Companion manifest
│   ├── .mcp.json                  # Microsoft Learn MCP
│   ├── settings.json              # Plugin enablement (github, serena, context7)
│   ├── install.ts                 # npx entry point
│   └── package.json               # @lvlup-sw/exarchos-dev
├── CLAUDE.md
├── package.json                   # Root package
├── manifest.json                  # Build manifest (internal use)
└── docs/
```

### Core Plugin Manifest

**`.claude-plugin/plugin.json`:**
```json
{
  "name": "exarchos",
  "description": "Agent governance for Claude Code — event-sourced SDLC workflows with team coordination, quality gates, and progressive stacking via Graphite.",
  "version": "2.0.0",
  "author": { "name": "Levelup Software" },
  "homepage": "https://github.com/lvlup-sw/exarchos",
  "repository": "https://github.com/lvlup-sw/exarchos",
  "license": "MIT",
  "keywords": [
    "workflow", "sdlc", "governance", "graphite",
    "event-sourcing", "tdd", "code-review", "teams"
  ],
  "commands": "./commands/",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
```

**`.claude-plugin/marketplace.json`:**
```json
{
  "name": "lvlup-sw",
  "owner": {
    "name": "Levelup Software",
    "email": "oss@levelupsoftware.com"
  },
  "metadata": {
    "description": "Production-quality agent governance tools for Claude Code",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "exarchos",
      "source": "./",
      "description": "Event-sourced SDLC workflows with agent team coordination",
      "version": "2.0.0",
      "author": { "name": "Levelup Software" },
      "category": "productivity",
      "tags": ["workflow", "sdlc", "governance", "graphite", "tdd"]
    }
  ]
}
```

### MCP Server Configuration

**`.mcp.json`** (core plugin):
```json
{
  "exarchos": {
    "type": "stdio",
    "command": "bun",
    "args": ["run", "${CLAUDE_PLUGIN_ROOT}/dist/exarchos-mcp.js"],
    "env": {
      "WORKFLOW_STATE_DIR": "~/.claude/workflow-state"
    }
  },
  "graphite": {
    "type": "stdio",
    "command": "gt",
    "args": ["mcp"]
  }
}
```

The Graphite MCP server uses the `gt` CLI directly. If `gt` is not on PATH, Claude Code will report the MCP server as unavailable — no custom detection logic needed.

### Graphite Integration Strategy

Progressive resolution — meet users where they are:

1. **Declared in `.mcp.json`** — Graphite MCP registered as part of the core plugin
2. **SessionStart hook detects availability** — If `gt` not found, the hook outputs a user-facing message:
   ```
   Graphite CLI not found. Exarchos requires Graphite for PR management.
   Install: https://graphite.dev/docs/install
   After install, restart Claude Code.
   ```
3. **Graceful degradation** — Core workflows (ideate, plan, delegate, review) work without Graphite. Only `/synthesize` (which creates PRs) requires it. The hook message is informational, not blocking.
4. **Skills reference Graphite** — Delegation and synthesis skills document the Graphite dependency explicitly.

### Hooks Configuration

**`hooks/hooks.json`** — Uses `${CLAUDE_PLUGIN_ROOT}` for path resolution:
```json
{
  "hooks": {
    "PreCompact": [{
      "matcher": "auto",
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/exarchos-cli.js\" pre-compact",
        "timeout": 30,
        "statusMessage": "Saving workflow checkpoint..."
      }]
    }],
    "SessionStart": [{
      "matcher": "startup|resume",
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/exarchos-cli.js\" session-start",
        "timeout": 10,
        "statusMessage": "Checking for active workflows..."
      }]
    }],
    "PreToolUse": [{
      "matcher": "mcp__exarchos__.*",
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/exarchos-cli.js\" guard",
        "timeout": 5
      }]
    }],
    "TaskCompleted": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/exarchos-cli.js\" task-gate",
        "timeout": 120,
        "statusMessage": "Running quality gates..."
      }]
    }],
    "TeammateIdle": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/exarchos-cli.js\" teammate-gate",
        "timeout": 120,
        "statusMessage": "Verifying teammate work..."
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/exarchos-cli.js\" subagent-context",
        "timeout": 5
      }]
    }]
  }
}
```

### Rules Integration

The plugin system doesn't have a native "rules" concept (rules are `~/.claude/rules/` files loaded globally). Options:

1. **CLAUDE.md as the vehicle** — The core plugin's `CLAUDE.md` contains the essential coding standards, TDD rules, and workflow conventions. Claude Code loads `CLAUDE.md` from the plugin root.
2. **Skill-embedded rules** — Move rule content into skill `references/` directories where they're contextually relevant (e.g., TDD rules in the implementation-planning skill).
3. **Post-install setup command** — A `/exarchos:setup` command that copies rule files to `~/.claude/rules/` on first run.

**Recommended:** Option 1 + 2. `CLAUDE.md` covers the universal rules. Skill-specific rules live in their skill directories. No separate rules installation step needed. The `rules/` directory remains in the repo for development reference but isn't installed separately for marketplace users.

### Settings and Permissions

The core plugin includes a recommended permissions configuration. In Claude Code's plugin system, plugins declare their required permissions:

**Plugin-level settings** (baked into the plugin, applied on install):
```json
{
  "permissions": {
    "allow": [
      "Read", "Write", "Edit", "Glob", "Grep",
      "NotebookEdit", "Task", "WebSearch", "WebFetch",
      "mcp__*",
      "Bash(gt:*)", "Bash(gh:*)", "Bash(git:*)",
      "Bash(npm:*)", "Bash(npx:*)", "Bash(bun:*)", "Bash(node:*)"
    ]
  }
}
```

The full permissions list from the current `settings.json` is comprehensive but includes many language-specific tools (dotnet, cargo, python, etc.) that aren't universally needed. The core plugin should include a minimal, sensible set. Users extend via their own `~/.claude/settings.json`.

### Dev Companion Plugin

**`companion/.claude-plugin/plugin.json`:**
```json
{
  "name": "exarchos-dev-tools",
  "description": "Developer convenience plugins for Exarchos — GitHub, Serena, Context7, Microsoft Learn",
  "version": "2.0.0",
  "author": { "name": "Levelup Software" },
  "repository": "https://github.com/lvlup-sw/exarchos",
  "mcpServers": "./.mcp.json"
}
```

**`companion/.mcp.json`:**
```json
{
  "microsoft-learn": {
    "type": "http",
    "url": "https://learn.microsoft.com/api/mcp"
  }
}
```

**`companion/settings.json`** (merged into user settings on install):
```json
{
  "enabledPlugins": {
    "github@claude-plugins-official": true,
    "serena@claude-plugins-official": true,
    "context7@claude-plugins-official": true
  }
}
```

**Installation paths for dev companion:**
```bash
# Option A: Claude Code plugin install from repo subdirectory
claude plugin install --from github:lvlup-sw/exarchos --plugin-root companion

# Option B: npx installer (for quick setup)
npx @lvlup-sw/exarchos-dev

# Option C: Direct bun execution
bunx @lvlup-sw/exarchos-dev
```

The npx path runs a small installer script (`companion/install.ts`) that:
1. Enables the three Claude plugins in user settings
2. Registers Microsoft Learn MCP in `~/.claude.json`
3. Prints confirmation and instructions

### Build Pipeline

**Current:** `npm run build` → `tsc` + bun bundles → `dist/`

**Target:** Same build, plus a packaging step:

```bash
# Development
npm run build          # tsc + bun bundles (same as today)
npm run build:mcp      # bun build → dist/exarchos-mcp.js
npm run build:cli      # bun build → dist/exarchos-cli.js

# Plugin validation
npm run validate       # claude plugin validate . (core)
npm run validate:companion  # claude plugin validate companion/
```

The build output (`dist/exarchos-mcp.js`, `dist/exarchos-cli.js`) is checked into the repo on release tags. This allows the GitHub source in the marketplace to reference a tag and get pre-built bundles.

**Release flow:**
1. `npm run build` — compile and bundle
2. `npm run validate` — validate plugin structure
3. `git tag v2.1.0` — tag the release (includes dist/)
4. Push tag — CI validates, marketplace picks up new version

### Installer Transformation

The current installer (`src/install.ts`) transitions:

| Current Role | New Role |
|-------------|----------|
| Primary install path for all users | Dev-mode only tool |
| Copies files to `~/.claude/` | Sets up local plugin development: `claude --plugin-dir .` |
| Registers MCP servers in `~/.claude.json` | No longer needed (plugin system handles this) |
| Interactive wizard with component selection | Simplified: just starts dev mode |
| `npx @lvlup-sw/exarchos` | `npm run dev:install` (for contributors only) |

The installer remains in the codebase for backward compatibility during the transition period but is documented as deprecated in favor of marketplace installation.

### Migration Path

**Phase 1: Plugin Structure** (this design)
- Restructure repo to be a valid Claude Code plugin
- Move `.claude-plugin/` to root, update manifest
- Create `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` paths
- Update `.mcp.json` with graphite
- Create `companion/` directory

**Phase 2: Marketplace Submission**
- Submit to Claude Code plugin marketplace
- Create lvlup-sw marketplace repository (if custom marketplace)
- Or submit to `claude-plugins-official` (if Anthropic accepts third-party)

**Phase 3: Installer Deprecation**
- Update README: marketplace as primary install
- Mark npm installer as dev-only
- Redirect `npx @lvlup-sw/exarchos` to print marketplace instructions

**Phase 4: Dev Companion**
- Publish `@lvlup-sw/exarchos-dev` to npm
- Create `companion/install.ts` entry point
- Document dev setup in CONTRIBUTING.md

## Integration Points

### Claude Code Plugin System
- **Plugin discovery:** Marketplace listing or `claude plugin install --from github:lvlup-sw/exarchos`
- **MCP registration:** Native via `.mcp.json` — no manual `~/.claude.json` editing
- **Hook registration:** Native via `hooks/hooks.json` — no installer merging
- **Updates:** Claude Code's built-in plugin update mechanism
- **Namespacing:** Commands become `/exarchos:ideate`, `/exarchos:plan`, etc.

### Graphite
- **MCP server:** Declared in `.mcp.json`, uses `gt` CLI
- **Detection:** SessionStart hook checks `gt` availability
- **Fallback:** Informational message, non-blocking for non-PR workflows

### Existing Installations
- Users with current symlink-based installs can either:
  1. Run `npx @lvlup-sw/exarchos --uninstall` to clean up, then install from marketplace
  2. Both systems can coexist (plugin system takes precedence for conflicting names)

### Command Namespacing

Plugin commands are namespaced as `/plugin-name:command-name`. This means:

| Current | After Plugin Install |
|---------|---------------------|
| `/ideate` | `/exarchos:ideate` |
| `/plan` | `/exarchos:plan` |
| `/delegate` | `/exarchos:delegate` |
| `/review` | `/exarchos:review` |
| `/synthesize` | `/exarchos:synthesize` |
| `/debug` | `/exarchos:debug` |
| `/refactor` | `/exarchos:refactor` |
| `/checkpoint` | `/exarchos:checkpoint` |
| `/resume` | `/exarchos:resume` |
| `/cleanup` | `/exarchos:cleanup` |

Skills follow the same pattern: `exarchos:brainstorming`, `exarchos:delegation`, etc.

**Impact:** All skill files that reference other commands (e.g., `Skill({ skill: "plan" })`) need updating to use namespaced names (e.g., `Skill({ skill: "exarchos:plan" })`). This is the largest mechanical change.

## Testing Strategy

### Plugin Validation
- `claude plugin validate .` — Validates plugin structure, manifest, and component paths
- Run as part of CI pipeline

### MCP Server Tests
- Existing vitest suite continues unchanged
- `npm run test:run` validates server logic

### Hook Integration Tests
- Verify `${CLAUDE_PLUGIN_ROOT}` resolves correctly in hook commands
- Test SessionStart hook's Graphite detection
- Test all hook entry points with the CLI bundle

### End-to-End Install Test
- Install plugin from local directory: `claude --plugin-dir .`
- Verify all commands, skills, hooks, and MCP tools are available
- Verify Graphite MCP registers when `gt` is available
- Verify graceful behavior when `gt` is absent

### Dev Companion Test
- `npx @lvlup-sw/exarchos-dev` registers plugins correctly
- Verify Microsoft Learn MCP available after install
- Verify Claude plugins enabled in settings

## Open Questions

1. **Command namespacing UX** — `/exarchos:ideate` is longer than `/ideate`. Can plugins register short aliases? If not, is the namespaced form acceptable for the target audience?

2. **Plugin settings scope** — Where should the core plugin's permissions go? Plugin-level settings vs. requiring users to configure their own? Need to verify the plugin system's settings merge behavior.

3. **Built bundles in git** — Committing `dist/` to the repo for release tags is pragmatic but adds noise. Alternative: GitHub Actions builds and attaches bundles to releases. Need to verify if marketplace supports release artifact sources.

4. **Marketplace submission process** — Is the `claude-plugins-official` repo open to third-party submissions? Or do we need a standalone `lvlup-sw` marketplace? This affects the install command.

5. **`WORKFLOW_STATE_DIR` resolution** — The current MCP config uses `~/.claude/workflow-state`. Need to verify `~` expansion works in the plugin system's environment variable handling, or switch to `${HOME}/.claude/workflow-state`.

6. **Rules delivery mechanism** — The plugin system doesn't natively support `rules/` directories. Need to validate that CLAUDE.md + skill-embedded rules provide equivalent coverage, or find an alternative delivery path.
