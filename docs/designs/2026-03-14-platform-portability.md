# Platform Portability and Plugin-Enhanced Quality Review

**Issues:** #1026, #1032
**Date:** 2026-03-14
**Status:** Design

## Summary

Two complementary changes make Exarchos portable across MCP clients and composable with companion plugins:

- **Track 1 (Binary):** Decouple Claude Code-specific paths and protocol code from the core binary. The MCP server becomes usable by Cursor, Copilot CLI, Windsurf, or any MCP-capable client without encountering hardcoded `~/.claude/` assumptions.

- **Track 2 (Content):** Wire optional companion plugins (axiom, impeccable) into quality-review with graceful degradation. Remove the deprecated feature-audit skill. Update VitePress documentation to reflect both changes.

Shipped as two parallel PRs with no ordering dependency.

---

## Track 1: Binary Portability

### Phase 1: Path Abstraction

**Problem:** 11 locations across 6 files construct `~/.claude/workflow-state`, `~/.claude/teams`, or `~/.claude/tasks` inline. Non-Claude-Code users must discover undocumented env vars to avoid writing into Claude Code's directory tree.

**Solution:** Create `servers/exarchos-mcp/src/utils/paths.ts` (extending the existing `expandTilde` utility) with three centralized resolvers:

```typescript
// Resolution cascade (first match wins):
// 1. Explicit env var (always wins)
// 2. CLAUDE_PLUGIN_ROOT detected → ~/.claude/<subdir> (Claude Code plugin mode)
// 3. XDG_STATE_HOME/exarchos/<subdir> (if XDG set)
// 4. ~/.exarchos/<subdir> (universal default)

export function resolveStateDir(): string;   // subdir: workflow-state | state
export function resolveTeamsDir(): string;    // subdir: teams
export function resolveTasksDir(): string;    // subdir: tasks

// Platform detection helper
export function isClaudeCodePlugin(): boolean;
```

Env var mapping:

| Resolver | Env Override | Claude Code Path | Universal Default |
|----------|-------------|-----------------|-------------------|
| `resolveStateDir()` | `WORKFLOW_STATE_DIR` | `~/.claude/workflow-state` | `~/.exarchos/state` |
| `resolveTeamsDir()` | `EXARCHOS_TEAMS_DIR` | `~/.claude/teams` | `~/.exarchos/teams` |
| `resolveTasksDir()` | `EXARCHOS_TASKS_DIR` | `~/.claude/tasks` | `~/.exarchos/tasks` |

The `isClaudeCodePlugin()` helper checks `CLAUDE_PLUGIN_ROOT` or `EXARCHOS_PLUGIN_ROOT` env vars. No migration path — clean break. Existing Claude Code plugin users see no change because `CLAUDE_PLUGIN_ROOT` is always set by `plugin.json`.

**Files to change:**

| File | Line(s) | Current | Replacement |
|------|---------|---------|-------------|
| `index.ts` | 174 | `path.join(homedir(), '.claude', 'workflow-state')` | `resolveStateDir()` |
| `index.ts` | 237 | `path.join(os.homedir(), '.claude', 'teams')` | `resolveTeamsDir()` |
| `workflow/state-store.ts` | 892 | `path.join(homedir(), '.claude', 'workflow-state')` | `resolveStateDir()` |
| `workflow/query.ts` | 286 | `path.resolve(home, '.claude', 'tasks')` | `resolveTasksDir()` |
| `cli-commands/gates.ts` | 196 | `path.join(home, '.claude', 'workflow-state')` | `resolveStateDir()` |
| `cli-commands/subagent-context.ts` | 493 | `path.join(resolveHomeDir(), '.claude', 'workflow-state')` | `resolveStateDir()` |
| `cli-commands/subagent-context.ts` | 630 | `path.join(homeDir, '.claude', 'teams')` | `resolveTeamsDir()` |
| `cli-commands/subagent-context.ts` | 647 | `path.join(homeDir, '.claude', 'tasks', featureId)` | `resolveTasksDir()` + featureId |
| `cli.ts` | 66 | `path.join(os.homedir(), '.claude', 'teams')` | `resolveTeamsDir()` |
| `orchestrate/verify-delegation-saga.ts` | 59 | `join(homedir(), '.claude', 'workflow-state')` | `resolveStateDir()` |
| `cli-commands/eval-run.ts` | 69 | `path.join(os.homedir(), '.claude', 'workflow-state')` | `resolveStateDir()` |

**Tests:**

- `utils/paths.test.ts`: Test each resolver with all cascade levels (env var set, CLAUDE_PLUGIN_ROOT set, XDG set, bare default)
- Update existing tests that assert `~/.claude/` paths to use the resolver or mock the env

### Phase 2: Boundary Documentation and Schema Cleanup

**Schema description changes (C6, C7):**

| File | Line | Current | Replacement |
|------|------|---------|-------------|
| `event-store/schemas.ts` | 670 | `'Claude Code session identifier'` | `'Session identifier'` |
| `workflow/schemas.ts` | 153 | `/** Claude Code agent ID for resume capability */` | `/** Agent ID for resume capability */` |
| `registry.ts` | 520 | `'...Claude Code handles isolation natively via isolation: "worktree"...'` | `'...the host platform handles isolation natively...'` |

**Adapter layer documentation:**

Add a section to `architecture/index.md` (VitePress) documenting three adapter layers:

1. **MCP adapter** (`adapters/mcp.ts`) — stdio MCP server, works with any MCP client
2. **CLI adapter** (`adapters/cli.ts`) — direct command-line invocation
3. **Hook adapter** (`cli-commands/`) — Claude Code lifecycle integration (SessionStart, PreCompact, TaskCompleted, etc.)

### Phase 3: Hook Routing Extraction

**Problem:** `index.ts` lines 207-271 contain inlined `HOOK_COMMANDS` fast-path routing that mixes Claude Code protocol concerns into the binary's entry point.

**Solution:** Extract into `servers/exarchos-mcp/src/adapters/hooks.ts`:

```typescript
// adapters/hooks.ts

export const HOOK_COMMANDS = new Set([
  'pre-compact', 'session-start', 'guard', 'task-gate', 'teammate-gate',
  'subagent-context', 'session-end',
]);

/**
 * Handle Claude Code lifecycle hook commands.
 * Returns true if the command was handled, false if it should fall through to CLI/MCP.
 */
export async function handleHookCommand(
  command: string,
  stdinData: string,
  resolveStateDirFn: () => string,
): Promise<boolean>;
```

The `index.ts` entry point becomes a three-way dispatcher:

```typescript
// 1. Hook command? → adapters/hooks.ts (Claude Code lifecycle)
// 2. CLI subcommand? → adapters/cli.ts (direct invocation)
// 3. Neither? → adapters/mcp.ts (MCP server mode)
```

No behavior change. Same routing, clearer boundary.

**Tests:**

- `adapters/hooks.test.ts`: Test command routing for each hook, including unknown command passthrough
- Update `index.test.ts` (if exists) to verify the three-way dispatch

### Phase 4: new-project Generalization

**Problem:** `orchestrate/new-project.ts` unconditionally scaffolds `.claude/settings.json` and adds `.claude/settings.local.json` to `.gitignore`.

**Solution:** Add an optional `platform` parameter to the `new_project` action schema:

```typescript
platform?: 'claude-code' | 'generic' | 'auto'  // default: 'auto'
```

Behavior:

| Platform | Scaffolded Config | .gitignore Entry |
|----------|------------------|-----------------|
| `claude-code` | `.claude/settings.json` | `.claude/settings.local.json` |
| `generic` | `.exarchos.yml` (minimal template) | none |
| `auto` | Detect via `isClaudeCodePlugin()` and scaffold accordingly |

The action schema description in `registry.ts` should be updated from "Initialize a new project with Claude Code configuration files" to "Initialize a new project with workflow configuration files".

**Tests:**

- Test all three `platform` values produce the expected files
- Test `auto` detection with and without `CLAUDE_PLUGIN_ROOT`

---

## Track 2: Plugin-Enhanced Quality Review

### Plugin Detection: Hybrid Auto-Detect + Config Override

**Primary mechanism (zero-config):** The quality-review skill runs as a Claude Code subagent. All installed plugin skills appear in the subagent's available skills list. The skill instructions tell the agent to check its available skills for `axiom:audit` and `impeccable:critique` before invoking them.

Detection instruction pattern in SKILL.md:

```markdown
## Optional plugin integration

Check your available skills list for the following companion plugins.
If a plugin is available, invoke it and merge its findings with the
exarchos-native checks. If unavailable, skip it and note in the
review output that richer checks are available by installing the plugin.

- **axiom:audit** — General backend quality (7 dimensions: topology,
  observability, contracts, test fidelity, hygiene, architecture, resilience)
- **impeccable:critique** — Frontend design quality (UI consistency,
  accessibility, design system compliance, responsive design)
```

**Secondary mechanism (config override):** Users can suppress plugin invocation via `.exarchos.yml`:

```yaml
plugins:
  axiom:
    enabled: true       # default: true (invoked if installed)
  impeccable:
    enabled: false      # suppress even when installed
```

This uses the per-project config system from #1027. The quality-review skill checks project config before invoking optional plugins.

**Schema addition:** Add `plugins` section to the project config schema in `servers/exarchos-mcp/src/config/`:

```typescript
plugins: z.object({
  axiom: z.object({
    enabled: z.boolean().default(true),
  }).optional(),
  impeccable: z.object({
    enabled: z.boolean().default(true),
  }).optional(),
}).optional(),
```

### Quality-Review Skill Rewrite

Update `skills/quality-review/SKILL.md` to implement the three-tiered review:

**Tier 1 — MCP-only (always runs):**

These checks run via `exarchos_orchestrate` actions regardless of platform or installed plugins:

- `check_static_analysis` (D2, blocking)
- `check_security_scan` (D1, informational during quality review)
- `check_context_economy` (D3, informational)
- `check_operational_resilience` (D4, informational)
- `check_workflow_determinism` (D5, informational)

**Tier 2 — Plugin-enhanced (conditional):**

If `axiom:audit` is available and enabled in project config:
1. Invoke `axiom:audit` with the diff content and changed file list
2. axiom returns findings in its Standard Finding Format (severity, dimension, file, line, message)
3. Map axiom dimensions to exarchos findings:
   - DIM-1 through DIM-7 are axiom-owned, recorded as informational findings
   - axiom HIGH findings escalate to exarchos HIGH
4. Merge into the unified findings list

If `impeccable:critique` is available and enabled:
1. Invoke `impeccable:critique` with the diff content
2. impeccable returns design quality findings
3. Map to informational findings under a new "Design Quality" category
4. Merge into the unified findings list

**Tier 3 — Verdict computation (always runs):**

After all tiers complete, invoke `check_review_verdict` with the merged findings:

```typescript
exarchos_orchestrate({
  action: "check_review_verdict",
  featureId: "...",
  findings: mergedFindings,  // exarchos + axiom + impeccable
})
```

The verdict logic is unchanged: HIGH findings in blocking dimensions trigger NEEDS_FIXES.

**Output format for skipped plugins:**

When a plugin is unavailable, include a note in the review output:

```
## Plugin Coverage

- axiom: not installed (install with `claude plugin install axiom@lvlup-sw` for 7 additional quality dimensions)
- impeccable: not installed (install with `claude plugin marketplace add pbakaus/impeccable && claude plugin install impeccable@impeccable` for design quality checks)
```

### Axiom Integration Reference Update

Update `skills/quality-review/references/axiom-integration.md` to reflect the final integration:

- Remove Phase 1/Phase 2 historical notes (done)
- Document the detection + invocation + merge protocol
- Document the `.exarchos.yml` override mechanism
- Document the dimension ownership split (axiom DIM-1..7, exarchos D1..D5, impeccable design quality)

### Feature-Audit Removal

Remove the deprecated feature-audit skill:

1. Delete `skills/feature-audit/` directory (source)
2. Delete `.claude/skills/feature-audit/` directory (installed symlink target)
3. Remove feature-audit from `plugin.json` skills registration (if listed)
4. Remove `/feature-audit` from `documentation/reference/skills.md`
5. Remove the `/feature-audit` Skill definition if it exists in commands or skill registry
6. Git-clean any references to `feature-audit` across the codebase

---

## Documentation Updates (VitePress)

All documentation changes go in Track 2's PR. After generating each doc page, run `/humanize` to revise the content before committing.

### New Pages

#### `documentation/architecture/platform-portability.md`

New architecture page documenting the portability model:

- **Three adapter layers:** MCP (any client), CLI (direct), Hooks (Claude Code). Diagram showing which layer each client type uses.
- **Path resolution cascade:** env var → plugin detection → XDG → universal default. Table of directories and their resolvers.
- **Platform detection:** How `isClaudeCodePlugin()` works, when each code path activates.
- **Content layer vs binary:** Skills/commands/agents are Claude Code-specific presentation; the MCP server and event store are platform-agnostic.
- **Building adapters for other clients:** What a Cursor or Copilot CLI integration would need (just an MCP client — the server already works).

#### `documentation/guide/companion-plugins.md`

New guide page documenting the companion plugin ecosystem:

- **What companion plugins are:** Standalone Claude Code plugins that enhance Exarchos workflows when installed alongside it.
- **Available plugins:** axiom (backend quality), impeccable (frontend design quality). Installation instructions for each.
- **How detection works:** Zero-config — Exarchos detects installed plugins automatically and invokes their skills during review. Override via `.exarchos.yml` if needed.
- **Dimension ownership table:** Which quality dimensions each plugin covers, which are exarchos-native.
- **Three-tiered review model:** MCP-only → Claude Code → Claude Code + plugins. What you get at each tier.

### Updated Pages

#### `documentation/architecture/index.md`

Add a "Transport layers" section after "System components" documenting the three adapter layers. Add a sentence noting that while Exarchos ships as a Claude Code plugin, the MCP server is platform-agnostic.

#### `documentation/guide/review-process.md`

Add a "Companion plugin integration" section after "Finding severity":

- Explain that axiom and impeccable add dimensions when installed
- Show the three-tiered model
- Link to the companion plugins guide
- Note that plugin findings merge with native findings before verdict computation

#### `documentation/reference/configuration.md`

- Add `plugins` section to `.exarchos.yml` schema reference
- Update the `WORKFLOW_STATE_DIR` env var description to mention the resolution cascade
- Add `EXARCHOS_TEAMS_DIR` and `EXARCHOS_TASKS_DIR` to the env vars table
- Update the plugin manifest example to note the `WORKFLOW_STATE_DIR` default changes based on platform detection

#### `documentation/reference/skills.md`

- Remove feature-audit skill entry
- Add note under quality-review about optional plugin enhancement

#### `documentation/reference/convergence-gates.md`

- Add a section on plugin-contributed dimensions (axiom DIM-1..7, impeccable design quality)
- Note these are informational and do not add new blocking gates

### VitePress Config Update

Add new pages to the sidebar in `documentation/.vitepress/config.ts`:

```typescript
// Architecture sidebar — add:
{ text: 'Platform Portability', link: '/architecture/platform-portability' },

// Guide sidebar — add under "Key Capabilities":
{ text: 'Companion Plugins', link: '/guide/companion-plugins' },
```

### Documentation Quality Gate

After generating each documentation page:
1. Write the initial content
2. Run `/humanize` to revise the content — remove AI writing patterns, make it sound natural
3. Review the humanized output for technical accuracy
4. Commit the final version

---

## Design Requirements

| ID | Requirement | Track |
|----|------------|-------|
| DR-1 | Centralized path resolution with env → plugin → XDG → default cascade | Track 1 |
| DR-2 | All 11 hardcoded `~/.claude/` paths replaced with resolver calls | Track 1 |
| DR-3 | Schema descriptions use platform-neutral language | Track 1 |
| DR-4 | Hook routing extracted to `adapters/hooks.ts` | Track 1 |
| DR-5 | `new-project` accepts `platform` parameter with auto-detection | Track 1 |
| DR-6 | Quality-review detects and invokes axiom:audit when available | Track 2 |
| DR-7 | Quality-review detects and invokes impeccable:critique when available | Track 2 |
| DR-8 | Plugin findings merge with native findings before verdict | Track 2 |
| DR-9 | Graceful degradation when plugins unavailable, with install hints | Track 2 |
| DR-10 | `.exarchos.yml` plugins section allows disabling installed plugins | Track 2 |
| DR-11 | Feature-audit skill removed from source and installation targets | Track 2 |
| DR-12 | VitePress: new platform-portability architecture page | Track 2 |
| DR-13 | VitePress: new companion-plugins guide page | Track 2 |
| DR-14 | VitePress: review-process, configuration, skills, convergence-gates pages updated | Track 2 |
| DR-15 | All generated documentation passes /humanize review before commit | Track 2 |
| DR-16 | Existing Claude Code plugin users see zero behavior change | Track 1 |

## Non-Goals

- Building adapters for Cursor, Copilot CLI, or Windsurf — we remove barriers, not build integrations
- Removing Claude Code support — the content layer stays first-class
- Rewriting the installer (`src/install.ts`) — correctly scoped as Claude Code-only
- Making axiom or impeccable required dependencies
- Adding new blocking gates from plugin dimensions

## Risks

| Risk | Mitigation |
|------|-----------|
| Path resolution breaks existing installs | DR-16: `CLAUDE_PLUGIN_ROOT` detection preserves `~/.claude/` paths for plugin users |
| Plugin detection fails silently | Skill instructions include explicit "check available skills" step with fallback messaging |
| Feature-audit removal breaks references | Grep for `feature-audit` across entire codebase before removal |
| VitePress sidebar breaks | Build and preview docs before merging |
