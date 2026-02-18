# Implementation Plan: Distribution Strategy — Dual-Plugin Monorepo

## Source Design
Link: `docs/designs/2026-02-17-distribution-strategy.md`

## Scope
**Target:** Phase 1a (Plugin Structure — conflict-free tasks) of the design's migration path — restructure the repo as a valid Claude Code plugin and create the dev companion. Defers tasks that conflict with 20 open PRs.
**Excluded:**
- Server source move (`plugins/exarchos/servers/` → `servers/`) — conflicts with 14 open PRs; deferred to Phase 1b (see follow-up doc)
- Command/skill namespacing — conflicts with PRs 485, 487, 489, 491 modifying same files; deferred to Phase 1b
- Graphite detection in SessionStart — conflicts with PR 468 modifying same file; deferred to Phase 1b
- Rules consolidation — conflicts with PRs 469, 487 modifying rules; deferred to Phase 1b
- Phase 2 (Marketplace Submission) — requires external process, no code changes
- Phase 3 (Installer Deprecation) — deferred until marketplace is live and validated
- Phase 4 (Dev Companion npm publish) — deferred until companion is validated locally

## Summary
- Total tasks: 7 (Phase 1a) + 5 deferred (Phase 1b, post-PR-merge)
- Parallel groups: 2 (3 parallel tasks in group 1, integration + finalization in group 2)
- Estimated test count: 10
- Design coverage: 7 of 11 Technical Design sections covered; 4 deferred with rationale

## Spec Traceability

### Scope Declaration

**Target:** Phase 1a — conflict-free plugin structure tasks
**Excluded:** Phase 1b tasks deferred due to open PR conflicts (documented in `docs/plans/2026-02-17-distribution-strategy-followup.md`)

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Technical Design > Project Structure (Target) | `.claude-plugin/` at root, `companion/` | 1, 5 | Partial — server move deferred to 1b |
| Technical Design > Core Plugin Manifest | `plugin.json`, `marketplace.json` | 1 | Covered |
| Technical Design > MCP Server Configuration | `.mcp.json` with exarchos + graphite | 1 | Covered |
| Technical Design > Graphite Integration Strategy | SessionStart detection, graceful degradation | — | Deferred: PR 468 conflict (Phase 1b) |
| Technical Design > Hooks Configuration | `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` | 2 | Covered |
| Technical Design > Rules Integration | CLAUDE.md consolidation, skill-embedded rules | — | Deferred: PRs 469, 487 conflict (Phase 1b) |
| Technical Design > Settings and Permissions | Minimal permission set for marketplace | 2 | Covered |
| Technical Design > Dev Companion Plugin | `companion/` structure, manifests, installer | 5, 6 | Covered |
| Technical Design > Build Pipeline | Validation scripts, `files` array update | 3, 4 | Partial — build path changes deferred to 1b |
| Technical Design > Installer Transformation | — | — | Deferred: Phase 3 |
| Technical Design > Migration Path | Phase 1a structure changes | All 1a tasks | Covered |
| Integration Points > Command Namespacing | `/exarchos:*` prefix updates | — | Deferred: PRs 485, 487, 489, 491 conflict (Phase 1b) |
| Integration Points > Claude Code Plugin System | Native plugin registration | 1, 2 | Covered |
| Integration Points > Graphite | MCP registration in `.mcp.json` | 1 | Partial — detection deferred to 1b |
| Integration Points > Existing Installations | — | — | Deferred: Phase 3 |
| Testing Strategy | Plugin validation, E2E | 3, 7 | Partial — hook tests deferred to 1b |
| Open Questions | 6 items | — | Deferred: resolve during implementation or Phase 2 |

## Task Breakdown

---

### Task 1: Create Core Plugin Manifests & MCP Config

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `pluginManifest_requiredFields_containsAllFields`
   - File: `src/plugin-validation.test.ts`
   - Expected failure: Test reads `.claude-plugin/plugin.json` and validates required fields (name, description, version, author, commands, skills, hooks, mcpServers) — file doesn't exist yet
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `mcpConfig_servers_includesExarchosAndGraphite`
   - File: `src/plugin-validation.test.ts`
   - Expected failure: Test reads `.mcp.json` and verifies both `exarchos` and `graphite` server entries — graphite not present yet
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Create plugin manifests and MCP config
   - File: `.claude-plugin/plugin.json` — Core plugin manifest with name, description, version, author, commands, skills, hooks, mcpServers paths
   - File: `.claude-plugin/marketplace.json` — lvlup-sw marketplace definition
   - File: `.mcp.json` — Update existing file to include graphite MCP server (`gt mcp`) alongside exarchos
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Remove obsolete plugin manifest
   - Remove: `plugins/exarchos/.claude-plugin/plugin.json` and `plugins/exarchos/mcp-servers.json`
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] `.claude-plugin/plugin.json` matches design spec
- [ ] `.mcp.json` includes both exarchos and graphite
- [ ] Old `plugins/exarchos/.claude-plugin/` removed

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: Migrate Hooks to Plugin Format & Rationalize Settings

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `hooksConfig_allHooks_usePluginRootPaths`
   - File: `src/plugin-validation.test.ts`
   - Expected failure: Test reads `hooks/hooks.json` and verifies all command paths use `${CLAUDE_PLUGIN_ROOT}` — directory doesn't exist yet
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `hooksConfig_matcherPatterns_preserved`
   - File: `src/plugin-validation.test.ts`
   - Expected failure: Test verifies matcher patterns (PreCompact=auto, SessionStart=startup|resume, PreToolUse=mcp__exarchos__.*, etc.) are correct
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Create hooks directory and hooks.json, rationalize settings
   - File: `hooks/hooks.json` — All 6 hooks (PreCompact, SessionStart, PreToolUse, TaskCompleted, TeammateIdle, SubagentStart) with `${CLAUDE_PLUGIN_ROOT}/dist/exarchos-cli.js` paths
   - File: `settings.json` — Rationalize to minimal permission set: core tools (Read, Write, Edit, Glob, Grep, Task, WebSearch, WebFetch, mcp__*) + essential bash commands (gt, gh, git, npm, npx, bun, node). Remove 100+ language-specific bash permissions not needed by all users.
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Verify hooks.json matches design spec exactly
   - Confirm no `{{CLI_PATH}}` references remain
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] All 6 hooks present with correct matchers and timeouts
- [ ] All paths use `${CLAUDE_PLUGIN_ROOT}`
- [ ] No `{{CLI_PATH}}` references remain
- [ ] Settings contains minimal, sensible permission set

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3: Update Package.json & Build Config for Plugin Distribution

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `packageJson_filesArray_includesPluginDirectories`
   - File: `src/plugin-validation.test.ts`
   - Expected failure: Test reads `package.json` and checks `files` array includes `.claude-plugin/`, `hooks/`, `companion/` — not present yet
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Update package.json
   - File: `package.json`:
     - Add `validate` and `validate:companion` scripts
     - Update `files` array to include `.claude-plugin/`, `hooks/`, `companion/`
     - Update `keywords` for marketplace discovery (`"claude-code-plugin"`, `"agent-governance"`, etc.)
     - Keep existing `bin` entry and build scripts unchanged (server source not moved yet)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Verify build still works
   - Run: `npm run build` — must succeed unchanged
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] `npm run build` succeeds (unchanged build paths)
- [ ] `files` array includes new plugin directories
- [ ] `validate` and `validate:companion` scripts added

**Dependencies:** None
**Parallelizable:** Yes (with Tasks 1, 2)

---

### Task 4: Add Plugin Validation Scripts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `validatePlugin_corePlugin_passesValidation`
   - File: `scripts/validate-plugin.test.sh`
   - Expected failure: Validation script doesn't exist yet
   - Run: `bash scripts/validate-plugin.test.sh` - MUST FAIL

2. [GREEN] Create validation scripts
   - File: `scripts/validate-plugin.sh` — Runs structural validation on core plugin:
     - Checks `.claude-plugin/plugin.json` exists and has required fields
     - Checks referenced paths (commands/, skills/, hooks/hooks.json, .mcp.json) exist
     - Checks `.mcp.json` is valid JSON with expected server entries
     - Checks `hooks/hooks.json` has all expected hook types
     - Exit codes: 0 (pass), 1 (fail), 2 (usage error)
   - File: `scripts/validate-companion.sh` — Validates companion plugin structure
   - Run: `bash scripts/validate-plugin.test.sh` - MUST PASS

3. [REFACTOR] Wire into npm scripts
   - Verify: `npm run validate` and `npm run validate:companion` work
   - Run: `bash scripts/validate-plugin.test.sh` - MUST STAY GREEN

**Verification:**
- [ ] `npm run validate` passes on valid plugin structure
- [ ] `npm run validate:companion` passes on companion structure
- [ ] Validation catches missing/malformed files
- [ ] Co-located `.test.sh` files pass

**Dependencies:** Tasks 1, 2, 5 (plugin structures must exist)
**Parallelizable:** No (sequential after Group 1)

---

### Task 5: Create Dev Companion Plugin Structure

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `companionPlugin_manifest_valid`
   - File: `companion/companion-plugin.test.ts`
   - Expected failure: `companion/.claude-plugin/plugin.json` doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create companion directory structure
   - File: `companion/.claude-plugin/plugin.json` — Companion plugin manifest (name: `exarchos-dev-tools`, description, version, author, mcpServers reference)
   - File: `companion/.mcp.json` — Microsoft Learn MCP server config (`https://learn.microsoft.com/api/mcp`)
   - File: `companion/settings.json` — Claude plugin enablement (`github@claude-plugins-official`, `serena@claude-plugins-official`, `context7@claude-plugins-official`)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Verify companion manifests match design spec
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] `companion/.claude-plugin/plugin.json` has correct name, description, version
- [ ] `companion/.mcp.json` registers Microsoft Learn MCP
- [ ] `companion/settings.json` enables github, serena, context7 plugins

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 6: Write Dev Companion Installer (TDD)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `companionInstall_enablesPlugins_inUserSettings`
   - File: `companion/install.test.ts`
   - Expected failure: `companion/install.ts` doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `companionInstall_registersMcpServer_inClaudeJson`
   - File: `companion/install.test.ts`
   - Expected failure: No MCP registration logic
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `companionInstall_existingSettings_mergesWithoutOverwrite`
   - File: `companion/install.test.ts`
   - Expected failure: No merge logic
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement companion installer
   - File: `companion/install.ts` — Entry point for `npx @lvlup-sw/exarchos-dev`
     - Reads existing `~/.claude/settings.json` (creates if missing)
     - Merges `enabledPlugins` without overwriting existing settings
     - Reads existing `~/.claude.json` (creates if missing)
     - Registers Microsoft Learn MCP server
     - Prints confirmation with installed components
   - File: `companion/package.json` — npm package (`@lvlup-sw/exarchos-dev`) with `bin` entry pointing to compiled installer
   - Run: `npm run test:run` - MUST PASS

5. [REFACTOR] Extract shared utilities from root installer
   - Reuse `readMcpConfig`/`writeMcpConfig` patterns from `src/operations/mcp.ts` if applicable
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Tests use temp directories (no real `~/.claude/` modifications)
- [ ] Merge logic preserves existing settings
- [ ] MCP registration is idempotent
- [ ] `npx` entry point works: `companion/package.json` has correct `bin` field

**Dependencies:** Task 5 (companion structure exists)
**Parallelizable:** No (sequential after Task 5)

---

### Task 7: Documentation Updates

**Phase:** GREEN (documentation-only, no test-first requirement)

**Steps:**
1. Update `CLAUDE.md` to note plugin distribution model
2. Update `README.md`:
   - Add marketplace installation instructions (primary path)
   - Document `claude --plugin-dir .` for development
   - Document companion installer (`npx @lvlup-sw/exarchos-dev`)
3. Create or update `CONTRIBUTING.md`:
   - Document dev setup using `claude --plugin-dir .`
   - Document build pipeline
   - Document how to test plugin locally
4. Update `manifest.json` to mark as internal-only (plugin.json is now the public manifest)

**Verification:**
- [ ] README has marketplace install instructions
- [ ] CLAUDE.md notes plugin model
- [ ] Dev setup is documented

**Dependencies:** Tasks 1-6 (all structural changes complete)
**Parallelizable:** No (finalization task)

---

## Parallelization Strategy

### Group 1: Parallel Foundation (3 worktrees)

```
Worktree A: Tasks 1 + 2 + 3 — Plugin manifests, hooks, settings, package.json
Worktree B: Tasks 5 + 6     — Dev companion plugin + installer
```

Both worktrees can run in parallel. No cross-dependencies. Worktree A touches root config files; Worktree B only touches `companion/`.

### Group 2: Sequential Integration (after Group 1)

```
Task 4  — Validation scripts (depends on plugin structures from Group 1)
Task 7  — Documentation (depends on everything)
```

### Delegation Summary

| Worktree | Tasks | Files Touched | TDD Tests |
|----------|-------|--------------|-----------|
| A | 1, 2, 3 | `.claude-plugin/*`, `.mcp.json`, `hooks/hooks.json`, `settings.json`, `package.json` | 5 |
| B | 5, 6 | `companion/**` | 4 |
| Sequential | 4 | `scripts/validate-plugin.sh`, `scripts/validate-companion.sh` | 1 |
| Sequential | 7 | `README.md`, `CONTRIBUTING.md`, `CLAUDE.md` | 0 |

## Deferred Items — Phase 1b (Post-PR-Merge)

These tasks are documented in detail in `docs/plans/2026-02-17-distribution-strategy-followup.md`.

| Item | Blocked By | Rationale |
|------|-----------|-----------|
| **Server source move** (`plugins/exarchos/servers/` → `servers/`) | 14 PRs touching server code (all 4 stacks) | Moving the directory would cause merge conflicts on every open PR |
| **Command namespacing** (43 Skill() invocations) | PRs 485, 487, 489, 491 (modify same skill/command files) | Mechanical change, easy to re-apply after PRs merge |
| **Skill namespacing** (~33 invocations + ~30 slash refs) | PRs 485, 487, 489, 491 | Same as command namespacing |
| **Graphite detection in SessionStart** | PR 468 (modifies session-start.ts + test) | Small, focused change — easy to apply after PR merges |
| **Rules consolidation** (CLAUDE.md + skill references) | PRs 469, 487 (modify rules + coding-standards.md) | Content reorganization, apply after rules stabilize |
| Marketplace Submission (Phase 2) | Phase 1a + 1b complete | External process |
| Installer Deprecation (Phase 3) | Marketplace live | Keep backward compatibility |
| Dev Companion npm Publish (Phase 4) | Companion validated locally | Publish after validation |
| Open Questions 1-6 | Integration testing | Resolve during implementation |

## Completion Checklist (Phase 1a)
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `npm run build` succeeds (unchanged)
- [ ] `npm run validate` succeeds
- [ ] `npm run validate:companion` succeeds
- [ ] `.claude-plugin/plugin.json` matches design spec
- [ ] `.mcp.json` includes exarchos + graphite
- [ ] `hooks/hooks.json` uses `${CLAUDE_PLUGIN_ROOT}` paths
- [ ] Dev companion installs correctly
- [ ] Documentation is accurate
- [ ] Ready for review
