# Implementation Plan: Hooks Installer & CLI Bundling Refactor

## Source Brief
State file: `~/.claude/workflow-state/refactor-hooks-installer-bundling.state.json`

## Scope
**Target:** Full refactor brief — all 5 goals
**Excluded:** None

## Summary
- Total tasks: 6
- Parallel groups: 2
- Estimated test count: 12 new tests
- Brief coverage: 5/5 goals covered

## Spec Traceability

### Traceability Matrix

| Brief Goal | Key Requirements | Task ID(s) | Status |
|------------|-----------------|------------|--------|
| Bundle CLI with bun | Add build:cli script, produce dist/exarchos-cli.js | A1 | Covered |
| Extend manifest for CLI bundle | Add cliBundlePath to McpServerComponent, update manifest.json | A2 | Covered |
| Merge hooks into settings.json | Add hooks to Settings interface, generateSettings accepts hooks | B1 | Covered |
| Resolve hook paths per mode | Installer reads hooks.json, templates paths for standard/dev | B2 | Covered |
| Install CLI bundle in standard mode | installStandard copies CLI bundle alongside MCP bundle | B2 | Covered |
| Update hooks.json path template | Replace ${CLAUDE_PLUGIN_ROOT} with templatable placeholder | A1 | Covered |
| Doc updates | CLAUDE.md build commands and architecture | C1 | Covered |

## Task Breakdown

### Task A1: Add bun build script for CLI and update hooks.json paths

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `buildCli_ScriptExists_InPackageJson`
   - File: `src/install.test.ts` (hooks.json section, ~line 1071)
   - Add test: verify `hooks.json` hook commands reference `exarchos-cli.js` (not `cli.js`)
   - Add test: verify `package.json` has `build:cli` script
   - Expected failure: hooks.json still references old path, no build:cli script

2. [GREEN] Implement:
   - File: `package.json`
     - Add `"build:cli": "bun build plugins/exarchos/servers/exarchos-mcp/src/cli.ts --outfile dist/exarchos-cli.js --target node"`
     - Update `"build"` to: `"tsc && bun run build:mcp && bun run build:cli"`
   - File: `hooks.json`
     - Replace all 6 instances of `node "${CLAUDE_PLUGIN_ROOT}/servers/exarchos-mcp/dist/cli.js"` with `node "{{CLI_PATH}}"` as a placeholder the installer will resolve
   - Run: `npm run build` to verify both bundles produce artifacts
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Verify `dist/exarchos-cli.js` exists and is self-contained (no external requires)

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task A2: Extend manifest schema with cliBundlePath

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `manifest_ExarchosMcpServer_HasCliBundlePath`
   - File: `src/manifest/loader.test.ts`
   - Test: Load manifest and verify exarchos server has `cliBundlePath: "dist/exarchos-cli.js"`
   - Expected failure: No `cliBundlePath` field in manifest or types

2. [GREEN] Implement:
   - File: `src/manifest/types.ts`
     - Add to `McpServerComponent`: `readonly cliBundlePath?: string;`
   - File: `manifest.json`
     - Add `"cliBundlePath": "dist/exarchos-cli.js"` to the exarchos MCP server entry
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] None needed — single field addition

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task B1: Add hooks support to generateSettings

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - File: `src/operations/settings.test.ts`
   - Test 1: `generateSettings_WithHooks_IncludesHooksInOutput`
     - Pass hooks object to generateSettings, verify output includes `hooks` key
     - Expected failure: generateSettings doesn't accept or return hooks
   - Test 2: `generateSettings_WithoutHooks_OmitsHooksKey`
     - Call generateSettings without hooks, verify no `hooks` key in output
     - Expected failure: Same — function signature doesn't support hooks
   - Test 3: `generateSettings_HooksStructure_PreservesEventEntries`
     - Pass full hooks structure with PreCompact/SessionStart events, verify they survive round-trip
     - Expected failure: Same

2. [GREEN] Implement:
   - File: `src/operations/settings.ts`
     - Extend `Settings` interface: add `readonly hooks?: Record<string, unknown[]>;`
     - Add optional `hooks` parameter to `generateSettings(selections, hooks?)`
     - When hooks is provided and non-empty, include in returned object
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] None needed

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task B2: Installer hook path resolution and CLI bundle installation

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - File: `src/install.test.ts`
   - Test 1: `installStandard_WithCliBundlePath_InstallsCliBundleToMcpServers`
     - Verify that when manifest has `cliBundlePath`, the CLI bundle is copied to `mcp-servers/`
     - Expected failure: installStandard doesn't handle cliBundlePath
   - Test 2: `installStandard_SettingsJson_ContainsHooksWithAbsolutePaths`
     - Verify written settings.json includes `hooks` key with paths resolving to `~/.claude/mcp-servers/exarchos-cli.js`
     - Expected failure: settings.json has no hooks
   - Test 3: `installDev_SettingsJson_ContainsHooksWithRepoPaths`
     - Verify dev mode settings.json includes `hooks` key with paths resolving to repo `dist/cli.js`
     - Expected failure: Same
   - Test 4: `resolveHooks_StandardMode_ReplacesPlaceholderWithBundlePath`
     - Unit test for the hook path resolution function
     - Expected failure: Function doesn't exist

2. [GREEN] Implement:
   - File: `src/install.ts`
     - Add `resolveHooks(hooksTemplate, cliPath)` function that:
       - Reads hooks.json from repo
       - Replaces `{{CLI_PATH}}` placeholder with the resolved CLI path
       - Returns parsed hooks object ready for settings.json
     - In `installStandard`:
       - After MCP bundle install (step 3), install CLI bundle if `server.cliBundlePath` exists
       - Resolve hooks with path `~/.claude/mcp-servers/exarchos-cli.js`
       - Pass resolved hooks to `generateSettings(selections, resolvedHooks)`
     - In `installDev`:
       - Resolve hooks with path `<repoRoot>/plugins/exarchos/servers/exarchos-mcp/dist/cli.js`
       - Pass resolved hooks to `generateSettings(selections, resolvedHooks)`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Extract hook resolution into `src/operations/hooks.ts` if install.ts gets too large

**Dependencies:** A1 (hooks.json with placeholder), A2 (cliBundlePath in manifest), B1 (generateSettings with hooks)
**Parallelizable:** No — depends on A1, A2, B1

---

### Task B3: Remove hooks.json from core components in manifest

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test:
   - File: `src/manifest/loader.test.ts`
   - Test: `manifest_CoreComponents_DoesNotIncludeHooks`
     - Verify hooks is NOT in core components (it's now handled by installer directly)
     - Expected failure: hooks still declared as core component

2. [GREEN] Implement:
   - File: `manifest.json`
     - Remove `{ "id": "hooks", "source": "hooks.json", "target": "hooks.json", "type": "file" }` from core
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] None needed

**Dependencies:** B2 (installer handles hooks directly now)
**Parallelizable:** No — depends on B2

---

### Task C1: Update documentation

**Phase:** GREEN (no tests for docs)

1. Update `CLAUDE.md`:
   - Build commands: document that `npm run build` now produces both `dist/exarchos-mcp.js` and `dist/exarchos-cli.js`
   - Architecture section: note that hooks are merged into `settings.json` by the installer with mode-dependent paths
   - Note CLI bundle as a build artifact

2. Commit via Graphite

**Dependencies:** B3 (all code changes complete)
**Parallelizable:** No — final task

---

## Parallelization Strategy

### Group A (Foundation — parallel)
- **Task A1**: Build scripts + hooks.json placeholder
- **Task A2**: Manifest schema extension

### Group B (Integration — sequential, after Group A)
- **Task B1**: Settings hooks support (can start in parallel with Group A)
- **Task B2**: Installer integration (depends on A1 + A2 + B1)
- **Task B3**: Remove hooks from core (depends on B2)

### Group C (Docs — sequential, after Group B)
- **Task C1**: Documentation updates

```
Group A (parallel):          Group B (sequential):
  A1 ──────────────┐
                    ├──→ B2 → B3 → C1
  A2 ──────────────┘       ↑
                           │
  B1 ──────────────────────┘
```

**Worktree allocation:**
- Worktree 1: Tasks A1 + A2 (foundation)
- Worktree 2: Task B1 (settings — independent)
- Worktree 3: Tasks B2 + B3 (integration — after A1, A2, B1 merge)
- Docs (C1): Main branch after all merges

## Deferred Items

| Item | Rationale |
|------|-----------|
| Migrating to Claude plugin model | Out of scope per brief; current MCP server model works |
| Changing MCP server bundle target from bun to node | MCP server runs via bun, only CLI needs node target |
| Adding new hooks beyond existing 6 | Out of scope per brief |

## Completion Checklist
- [ ] `npm run build` produces both `dist/exarchos-mcp.js` and `dist/exarchos-cli.js`
- [ ] Standard mode writes hooks to `~/.claude/settings.json` with CLI bundle paths
- [ ] Dev mode writes hooks to `~/.claude/settings.json` with repo paths
- [ ] All existing tests pass + new coverage
- [ ] hooks.json no longer in core components (handled by installer)
- [ ] CLAUDE.md updated
