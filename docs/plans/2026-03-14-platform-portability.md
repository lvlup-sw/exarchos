# Implementation Plan: Platform Portability and Plugin-Enhanced Quality Review

**Design:** `docs/designs/2026-03-14-platform-portability.md`
**Issues:** #1026, #1032
**Date:** 2026-03-14

## Overview

8 tasks across two parallel tracks. Track 1 (tasks 001-004) ships as one PR targeting `main`. Track 2 (tasks 005-008) ships as a second PR targeting `main`. No ordering dependency between tracks.

## Parallelization Map

```
Track 1 (Binary — PR 1, branch: feat/platform-portability)
  task-001 ──→ task-002 ──→ task-003
                              ↑ (shares index.ts)
  task-004 ─────────────────(parallel, different files)

Track 2 (Content — PR 2, branch: feat/plugin-review-integration)
  task-005 ───┐
  task-006 ───┼──→ task-008
  task-007 ───┘     (docs depend on content being final)
```

**Parallel-safe groups:**
- Group A: task-001, task-004, task-005, task-006, task-007 (all parallel)
- Group B: task-002 (after task-001)
- Group C: task-003 (after task-002)
- Group D: task-008 (after task-005, task-006, task-007)

---

## Track 1: Binary Portability

### Task 001: Path Resolution Utilities
**Phase:** RED → GREEN → REFACTOR
**Track:** 1
**Dependencies:** None
**Parallelizable:** Yes

**Design requirements:** DR-1, DR-16

1. **[RED]** Write tests for centralized path resolvers

   File: `servers/exarchos-mcp/src/utils/paths.test.ts`

   ```
   describe('resolveStateDir')
     resolveStateDir_EnvVarSet_ReturnsExpandedEnvValue
     resolveStateDir_EnvVarWithTilde_ExpandsTilde
     resolveStateDir_ClaudePluginRoot_ReturnsClaudePath
     resolveStateDir_XdgStateHome_ReturnsXdgPath
     resolveStateDir_NoEnvVars_ReturnsUniversalDefault
     resolveStateDir_EnvPrecedence_EnvVarBeatsPlugin

   describe('resolveTeamsDir')
     resolveTeamsDir_EnvVarSet_ReturnsEnvValue
     resolveTeamsDir_ClaudePluginRoot_ReturnsClaudePath
     resolveTeamsDir_DefaultFallback_ReturnsExarchosPath

   describe('resolveTasksDir')
     resolveTasksDir_EnvVarSet_ReturnsEnvValue
     resolveTasksDir_ClaudePluginRoot_ReturnsClaudePath
     resolveTasksDir_DefaultFallback_ReturnsExarchosPath

   describe('isClaudeCodePlugin')
     isClaudeCodePlugin_ClaudePluginRootSet_ReturnsTrue
     isClaudeCodePlugin_ExarchosPluginRootSet_ReturnsTrue
     isClaudeCodePlugin_NoPluginRoot_ReturnsFalse
   ```

   Expected failures: All tests fail — functions don't exist yet.

   **Test implementation notes:**
   - Use `vi.stubEnv()` to set/unset env vars per test
   - Restore env in `afterEach` to prevent test pollution
   - Assert exact paths including OS-appropriate separators
   - Test cascade priority: env var > plugin detection > XDG > universal default

2. **[GREEN]** Implement path resolvers

   File: `servers/exarchos-mcp/src/utils/paths.ts`

   Add to existing file (which already has `expandTilde`):

   ```typescript
   export function isClaudeCodePlugin(): boolean {
     return !!(process.env.CLAUDE_PLUGIN_ROOT || process.env.EXARCHOS_PLUGIN_ROOT);
   }

   export function resolveStateDir(): string {
     const envDir = process.env.WORKFLOW_STATE_DIR;
     if (envDir) return expandTilde(envDir);
     if (isClaudeCodePlugin()) return path.join(os.homedir(), '.claude', 'workflow-state');
     const xdg = process.env.XDG_STATE_HOME;
     if (xdg) return path.join(xdg, 'exarchos', 'state');
     return path.join(os.homedir(), '.exarchos', 'state');
   }

   export function resolveTeamsDir(): string {
     const envDir = process.env.EXARCHOS_TEAMS_DIR;
     if (envDir) return expandTilde(envDir);
     if (isClaudeCodePlugin()) return path.join(os.homedir(), '.claude', 'teams');
     const xdg = process.env.XDG_STATE_HOME;
     if (xdg) return path.join(xdg, 'exarchos', 'teams');
     return path.join(os.homedir(), '.exarchos', 'teams');
   }

   export function resolveTasksDir(): string {
     const envDir = process.env.EXARCHOS_TASKS_DIR;
     if (envDir) return expandTilde(envDir);
     if (isClaudeCodePlugin()) return path.join(os.homedir(), '.claude', 'tasks');
     const xdg = process.env.XDG_STATE_HOME;
     if (xdg) return path.join(xdg, 'exarchos', 'tasks');
     return path.join(os.homedir(), '.exarchos', 'tasks');
   }
   ```

3. **[REFACTOR]** Extract shared cascade logic if the three resolvers share enough structure (DRY). Likely a private `resolveDir(envKey, claudeSubdir, exarchosSubdir)` helper.

---

### Task 002: Replace Hardcoded Paths + Schema Cleanup
**Phase:** RED → GREEN → REFACTOR
**Track:** 1
**Dependencies:** task-001
**Parallelizable:** No (depends on task-001)

**Design requirements:** DR-2, DR-3, DR-16

1. **[RED]** Verify existing tests pass with current hardcoded paths, then update any tests that assert `~/.claude/` paths to use the new resolvers.

   Files to check for path assertions:
   - `servers/exarchos-mcp/src/workflow/state-store.test.ts` (if exists)
   - `servers/exarchos-mcp/src/cli-commands/*.test.ts`
   - `servers/exarchos-mcp/src/index.test.ts`

   Any test that constructs `~/.claude/workflow-state`, `~/.claude/teams`, or `~/.claude/tasks` should be updated to use `resolveStateDir()`, `resolveTeamsDir()`, or `resolveTasksDir()` from `utils/paths.ts`.

   Expected failures: Tests that import the old `resolveStateDir` from `workflow/state-store.ts` may need import path updates.

2. **[GREEN]** Replace all 11 hardcoded path constructions:

   | # | File | Change |
   |---|------|--------|
   | 1 | `index.ts:174` | `resolveStateDir()` (import from `utils/paths.js`) |
   | 2 | `index.ts:237` | `resolveTeamsDir()` |
   | 3 | `workflow/state-store.ts:892` | Replace entire `resolveStateDir()` function body to delegate to `utils/paths.resolveStateDir()`, or re-export. Keep the existing export signature for backward compat with internal callers. |
   | 4 | `workflow/query.ts:286` | `resolveTasksDir()` |
   | 5 | `cli-commands/gates.ts:196` | `resolveStateDir()` |
   | 6 | `cli-commands/subagent-context.ts:493` | `resolveStateDir()` |
   | 7 | `cli-commands/subagent-context.ts:630` | `resolveTeamsDir()` |
   | 8 | `cli-commands/subagent-context.ts:647` | `path.join(resolveTasksDir(), featureId)` |
   | 9 | `cli.ts:66` | `resolveTeamsDir()` |
   | 10 | `orchestrate/verify-delegation-saga.ts:59` | `resolveStateDir()` |
   | 11 | `cli-commands/eval-run.ts:69` | `resolveStateDir()` |

   **Critical:** For `workflow/state-store.ts`, the existing `resolveStateDir()` export is imported by `index.ts:222` in the hook fast-path. Options:
   - (a) Make `state-store.ts` re-export from `utils/paths.ts` — preserves import paths
   - (b) Update all importers to use `utils/paths.ts` directly

   Prefer (a) for minimal diff: `state-store.ts` `resolveStateDir` becomes a thin re-export.

   Also apply schema description cleanup (DR-3):

   | File | Line | Old | New |
   |------|------|-----|-----|
   | `event-store/schemas.ts` | 670 | `'Claude Code session identifier'` | `'Session identifier'` |
   | `workflow/schemas.ts` | 153 | `/** Claude Code agent ID ... */` | `/** Agent ID for resume capability */` |
   | `registry.ts` | 520 | `'...Claude Code handles isolation...'` | `'...the host platform handles isolation natively...'` |

3. **[REFACTOR]** Remove unused `homedir()` / `os.homedir()` imports from files that no longer need them after path replacement. Verify no dead imports remain.

---

### Task 003: Hook Routing Extraction
**Phase:** RED → GREEN → REFACTOR
**Track:** 1
**Dependencies:** task-002 (both modify `index.ts`)
**Parallelizable:** No

**Design requirements:** DR-4

1. **[RED]** Write tests for the hook adapter

   File: `servers/exarchos-mcp/src/adapters/hooks.test.ts`

   ```
   describe('isHookCommand')
     isHookCommand_PreCompact_ReturnsTrue
     isHookCommand_SessionStart_ReturnsTrue
     isHookCommand_Guard_ReturnsTrue
     isHookCommand_TaskGate_ReturnsTrue
     isHookCommand_TeammateGate_ReturnsTrue
     isHookCommand_SubagentContext_ReturnsTrue
     isHookCommand_SessionEnd_ReturnsTrue
     isHookCommand_Mcp_ReturnsFalse
     isHookCommand_Workflow_ReturnsFalse
     isHookCommand_Empty_ReturnsFalse

   describe('handleHookCommand')
     handleHookCommand_PreCompact_CallsPreCompactHandler
     handleHookCommand_SessionStart_CallsSessionStartHandler
     handleHookCommand_UnknownCommand_ReturnsFalse
     handleHookCommand_PluginRootInArgv_SetsEnvVar
     handleHookCommand_GateFailure_ReturnsErrorWithCode
   ```

   Expected failures: `adapters/hooks.ts` does not exist.

   **Test implementation notes:**
   - Mock the handler imports (`vi.mock('./cli-commands/...')`)
   - Verify correct handler is called with correct arguments
   - Verify `EXARCHOS_PLUGIN_ROOT` env var is set when `--plugin-root` is in argv

2. **[GREEN]** Create `servers/exarchos-mcp/src/adapters/hooks.ts`

   Extract from `index.ts` lines 27-33 and 207-271:

   ```typescript
   export const HOOK_COMMANDS = new Set([...]);

   export function isHookCommand(command: string | undefined): boolean {
     return !!command && HOOK_COMMANDS.has(command);
   }

   export async function handleHookCommand(
     command: string,
     argv: string[],
     readStdin: () => Promise<string>,
     parseStdin: (raw: string) => string,
     outputJson: (result: unknown) => void,
     resolveStateDirFn: () => string,
   ): Promise<{ handled: true; exitCode?: number } | { handled: false }>;
   ```

   Update `index.ts` `main()` to call:
   ```typescript
   import { isHookCommand, handleHookCommand } from './adapters/hooks.js';

   if (isHookCommand(process.argv[2])) {
     const result = await handleHookCommand(
       process.argv[2], process.argv,
       hookReadStdin, hookParseStdinJson, hookOutputJson,
       resolveStateDirSync,
     );
     if (result.handled) {
       if (result.exitCode) process.exitCode = result.exitCode;
       return;
     }
   }
   ```

3. **[REFACTOR]** Remove the inline `HOOK_COMMANDS` constant and handler map from `index.ts`. Verify `index.ts` is now a clean three-way dispatcher (hooks → CLI → MCP).

---

### Task 004: new-project Generalization
**Phase:** RED → GREEN → REFACTOR
**Track:** 1
**Dependencies:** None (different files from tasks 001-003)
**Parallelizable:** Yes

**Design requirements:** DR-5

1. **[RED]** Write tests for platform-aware scaffolding

   File: `servers/exarchos-mcp/src/orchestrate/new-project.test.ts`

   ```
   describe('handleNewProject with platform parameter')
     handleNewProject_PlatformClaudeCode_CreatesClaudeSettingsJson
     handleNewProject_PlatformClaudeCode_AddsClaudeToGitignore
     handleNewProject_PlatformGeneric_CreatesExarchosYml
     handleNewProject_PlatformGeneric_DoesNotCreateClaudeDir
     handleNewProject_PlatformAuto_WithPluginRoot_ScaffoldsClaudeCode
     handleNewProject_PlatformAuto_WithoutPluginRoot_ScaffoldsGeneric
     handleNewProject_DefaultPlatform_IsAuto
   ```

   Expected failures: `platform` parameter doesn't exist in the schema.

   **Test implementation notes:**
   - Use `tmp` directories for `projectPath`
   - Set/unset `CLAUDE_PLUGIN_ROOT` env var for auto-detection tests
   - Assert file existence and content for each platform mode
   - Verify `.exarchos.yml` template content for generic mode

2. **[GREEN]** Implement platform parameter

   File: `servers/exarchos-mcp/src/orchestrate/new-project.ts`

   - Add `platform` parameter to the handler's arg parsing
   - Branch scaffolding logic based on resolved platform
   - For `generic`: write a minimal `.exarchos.yml` template instead of `.claude/settings.json`
   - For `auto`: use `isClaudeCodePlugin()` from `utils/paths.ts`

   File: `servers/exarchos-mcp/src/registry.ts` (around line 995)

   - Add `platform: z.enum(['claude-code', 'generic', 'auto']).default('auto')` to `new_project` schema
   - Update description: `'Initialize a new project with workflow configuration files'`

3. **[REFACTOR]** Extract the generic scaffold template content to a constant or template file.

---

## Track 2: Content — Plugin-Enhanced Quality Review

### Task 005: Plugin Config Schema
**Phase:** RED → GREEN → REFACTOR
**Track:** 2
**Dependencies:** None
**Parallelizable:** Yes

**Design requirements:** DR-10

1. **[RED]** Write tests for plugins config section

   File: `servers/exarchos-mcp/src/config/yaml-schema.test.ts` (extend existing)

   ```
   describe('plugins section')
     ProjectConfigSchema_Plugins_AcceptsValidConfig
     ProjectConfigSchema_Plugins_DefaultsEnabledTrue
     ProjectConfigSchema_Plugins_AllowsDisabling
     ProjectConfigSchema_Plugins_AcceptsPartialConfig
     ProjectConfigSchema_Plugins_OmittedSectionIsValid
   ```

   Expected failures: `plugins` key not in schema — parse rejects it (`.strict()` mode).

2. **[GREEN]** Add plugins section to schema

   File: `servers/exarchos-mcp/src/config/yaml-schema.ts`

   Add to the top-level schema object:
   ```typescript
   plugins: z.object({
     axiom: z.object({
       enabled: z.boolean().default(true),
     }).strict().optional(),
     impeccable: z.object({
       enabled: z.boolean().default(true),
     }).strict().optional(),
   }).strict().optional(),
   ```

3. **[REFACTOR]** Ensure the `ProjectConfig` type properly infers `plugins.axiom.enabled` as `boolean` (not `boolean | undefined`) when accessed after defaults are applied.

---

### Task 006: Quality-Review Skill Rewrite
**Phase:** Content change (no TDD — Markdown skill, not production code)
**Track:** 2
**Dependencies:** None
**Parallelizable:** Yes

**Design requirements:** DR-6, DR-7, DR-8, DR-9

**Changes:**

1. Update `skills/quality-review/SKILL.md`:
   - Add "Optional plugin integration" section after the existing review steps
   - Add instructions for detecting `axiom:audit` in available skills
   - Add instructions for detecting `impeccable:critique` in available skills
   - Add `.exarchos.yml` config check (`plugins.axiom.enabled`, `plugins.impeccable.enabled`)
   - Add findings merge protocol (axiom Standard Finding Format → exarchos findings list)
   - Add "Plugin Coverage" output section for skipped plugins
   - Update the verdict computation step to include merged plugin findings

2. Update `skills/quality-review/references/axiom-integration.md`:
   - Remove Phase 1/Phase 2 historical notes (done)
   - Document the final detection + invocation + merge protocol
   - Document the `.exarchos.yml` override mechanism
   - Document the dimension ownership split:
     - axiom: DIM-1 through DIM-7 (general backend quality)
     - impeccable: Design quality (UI, accessibility, design system)
     - exarchos: D1 (spec fidelity + TDD), D2-domain (event sourcing/CQRS/HSM/saga), D3 (context economy), D5 (workflow determinism)

3. **Verification:** Read the updated skill and confirm:
   - Three-tiered model is clearly documented
   - Plugin invocation is conditional on availability AND config
   - Finding merge happens before verdict computation
   - Skipped plugin output includes installation instructions

---

### Task 007: Feature-Audit Removal + Reference Cleanup
**Phase:** Content change (no TDD — file deletion + reference cleanup)
**Track:** 2
**Dependencies:** None
**Parallelizable:** Yes

**Design requirements:** DR-11

**Changes:**

1. Delete `skills/feature-audit/` directory (source skill)
2. Delete `.claude/skills/feature-audit/` directory (installed symlink/copy)
3. Grep entire codebase for `feature-audit` references and clean up:
   - `documentation/reference/skills.md` — remove feature-audit entry
   - `plugin.json` or skill registry — remove if listed
   - Any commands or skill definitions referencing `/feature-audit`
   - Design docs — leave historical references (they're archival)
4. Verify build and tests pass after removal

---

### Task 008: VitePress Documentation
**Phase:** Content change (documentation)
**Track:** 2
**Dependencies:** task-005, task-006, task-007 (docs must reflect final state)
**Parallelizable:** No

**Design requirements:** DR-12, DR-13, DR-14, DR-15

**New pages:**

1. **`documentation/architecture/platform-portability.md`**
   - Three adapter layers (MCP, CLI, Hooks) with diagram
   - Path resolution cascade table
   - Platform detection mechanism
   - Content layer vs binary boundary
   - Building integrations for other clients
   - **Post-generation:** Run `/humanize` to revise

2. **`documentation/guide/companion-plugins.md`**
   - What companion plugins are
   - Available plugins: axiom (backend quality), impeccable (frontend design)
   - Installation instructions for each
   - Auto-detection mechanism
   - `.exarchos.yml` override config
   - Dimension ownership table
   - Three-tiered review model
   - **Post-generation:** Run `/humanize` to revise

**Updated pages:**

3. **`documentation/architecture/index.md`**
   - Add "Transport layers" section after "System components"
   - Note MCP server is platform-agnostic
   - **Post-generation:** Run `/humanize` on new section only

4. **`documentation/guide/review-process.md`**
   - Add "Companion plugin integration" section after "Finding severity"
   - Three-tiered model summary
   - Link to companion-plugins guide
   - Plugin finding merge note
   - **Post-generation:** Run `/humanize` on new section only

5. **`documentation/reference/configuration.md`**
   - Add `plugins` section to `.exarchos.yml` schema reference
   - Update `WORKFLOW_STATE_DIR` description to mention resolution cascade
   - Add `EXARCHOS_TEAMS_DIR` and `EXARCHOS_TASKS_DIR` to env vars table
   - Update plugin manifest example re: path defaults
   - **Post-generation:** Run `/humanize` on changed sections

6. **`documentation/reference/skills.md`**
   - Remove feature-audit entry
   - Add plugin enhancement note under quality-review

7. **`documentation/reference/convergence-gates.md`**
   - Add plugin-contributed dimensions section
   - Note these are informational, non-blocking

8. **`documentation/.vitepress/config.ts`**
   - Add `{ text: 'Platform Portability', link: '/architecture/platform-portability' }` to architecture sidebar
   - Add `{ text: 'Companion Plugins', link: '/guide/companion-plugins' }` to guide sidebar under "Key Capabilities"

**Verification:** Build VitePress site (`cd documentation && npx vitepress build`) and verify no broken links or sidebar errors.

---

## Task Summary

| Task | Title | Track | PR | Parallel? | Dependencies |
|------|-------|-------|-----|-----------|-------------|
| 001 | Path resolution utilities | 1 | feat/platform-portability | Yes | None |
| 002 | Replace hardcoded paths + schema cleanup | 1 | feat/platform-portability | No | 001 |
| 003 | Hook routing extraction | 1 | feat/platform-portability | No | 002 |
| 004 | new-project generalization | 1 | feat/platform-portability | Yes | None |
| 005 | Plugin config schema | 2 | feat/plugin-review-integration | Yes | None |
| 006 | Quality-review skill rewrite | 2 | feat/plugin-review-integration | Yes | None |
| 007 | Feature-audit removal | 2 | feat/plugin-review-integration | Yes | None |
| 008 | VitePress documentation | 2 | feat/plugin-review-integration | No | 005, 006, 007 |

**Maximum parallelism:** Tasks 001, 004, 005, 006, 007 can all run simultaneously (5 agents).
