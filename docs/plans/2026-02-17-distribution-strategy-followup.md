# Follow-Up: Distribution Strategy Phase 1b — Post-PR-Merge Tasks

## Context

Phase 1a of the distribution strategy creates the core plugin structure (manifests, hooks, MCP config, companion plugin) using only conflict-free file paths. Phase 1b completes the migration by addressing tasks that conflict with open PRs.

**Prerequisite:** All 20 open PRs (or at minimum the specific blocking PRs listed per task) must be merged to main before starting Phase 1b.

**Source documents:**
- Design: `docs/designs/2026-02-17-distribution-strategy.md`
- Phase 1a plan: `docs/plans/2026-02-17-distribution-strategy.md`

---

## Open PR Stacks (as of 2026-02-17)

These are the PR stacks that block Phase 1b tasks. Track their merge status before starting.

### Stack 1: MCP Server Refactor (10 PRs)
```
main ← PR 488 (guard safety)
main ← PR 476 (query pre-filter) → 477 → 478 → 479 → 485 → 487 → 489 → 490 → 491
```
**Blocks:** Server source move (all), namespacing (485, 487, 489, 491)
**Files touched:** `plugins/exarchos/servers/exarchos-mcp/src/` (workflow, telemetry, views), `skills/` (SKILL.md files), `commands/review.md`, `rules/coding-standards.md`

### Stack 2: EventStore Hardening (3 PRs)
```
main ← PR 473 (PID lock) → 474 (CAS diagnostics) → 499 (Graphite MQ draft)
```
**Blocks:** Server source move
**Files touched:** `plugins/exarchos/servers/exarchos-mcp/src/event-store/`

### Stack 3: CodeQualityView (3 PRs)
```
main ← PR 470 (schema) → 471 (projection handlers) → 472 (registry routing)
```
**Blocks:** Server source move
**Files touched:** `plugins/exarchos/servers/exarchos-mcp/src/views/`, `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`

### Stack 4: Telemetry Hints (3 PRs)
```
main ← PR 467 (hint rules) → 468 (session-start hints) → 469 (telemetry-awareness rule)
```
**Blocks:** Graphite detection (468), rules consolidation (469)
**Files touched:** `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.ts`, `plugins/exarchos/servers/exarchos-mcp/src/telemetry/hints.ts`, `rules/telemetry-awareness.md`

### Standalone: PR 466
```
main ← PR 466 (check-property-tests.sh)
```
**Blocks:** Nothing directly (minor scripts/ overlap)

---

## Phase 1b Tasks

### Task B1: Server Source Reorganization

**Blocked by:** All 4 PR stacks (14 PRs total)
**Merge prerequisite:** All server-touching PRs merged to main

**What to do:**
1. Move `plugins/exarchos/servers/exarchos-mcp/` → `servers/exarchos-mcp/`
2. Update `package.json` build scripts:
   - `build:cli`: `plugins/exarchos/servers/exarchos-mcp/src/cli.ts` → `servers/exarchos-mcp/src/cli.ts`
   - `build:mcp`: `plugins/exarchos/servers/exarchos-mcp/src/index.ts` → `servers/exarchos-mcp/src/index.ts`
   - `bench` script: update `cd` path
3. Update `CLAUDE.md` path references (build & test section)
4. Update `manifest.json` `devEntryPoint` path
5. Remove empty `plugins/exarchos/servers/` directory tree
6. Verify: `npm run build`, `npm run test:run`, `npm run typecheck`

**TDD:** Write `buildPaths_serverSource_resolveCorrectly` test before moving.

**Key context:**
- The MCP server bundle outputs to `dist/exarchos-mcp.js` and `dist/exarchos-cli.js` at root — these paths don't change
- The `.mcp.json` references `${CLAUDE_PLUGIN_ROOT}/dist/exarchos-mcp.js` — also doesn't change
- Only build script INPUT paths and the `cd` path for MCP server tests change
- The `plugins/exarchos/` directory will be empty after move (can be fully removed)
- Check if `plugins/workflow-state/` still has relevant content — if not, remove entire `plugins/` directory

**Estimated scope:** ~10 files modified, 0 new files

---

### Task B2: Command & Skill Namespacing

**Blocked by:** PRs 485, 487, 489, 491 (modify skill SKILL.md files and commands/review.md)
**Merge prerequisite:** At minimum PRs 485, 487, 489, 491 merged

**What to do:**
1. Update all `Skill({ skill: "X"` invocations to `Skill({ skill: "exarchos:X"` across:
   - `commands/*.md` — 10 invocations across 5 files (delegate, synthesize, review, ideate, plan)
   - `skills/**/*.md` — 33 invocations across 15+ files
2. Update slash command references in workflow diagrams (`/plan` → `/exarchos:plan`) across all command and skill files (~60+ occurrences)
3. Create namespacing validation test (`src/namespacing-validation.test.ts`) that scans for un-namespaced patterns

**Key context — files with highest change count:**

| File | Skill() Count | Slash Cmd Refs |
|------|--------------|----------------|
| `skills/refactor/phases/auto-chain.md` | 9 | ~10 |
| `skills/refactor/references/overhaul-track.md` | 8 | ~8 |
| `skills/refactor/SKILL.md` | 4 | ~5 |
| `commands/review.md` | 3 | ~5 |
| `skills/quality-review/SKILL.md` | 3 | ~5 |
| `skills/refactor/phases/overhaul-delegate.md` | 3 | ~3 |

**Important: PRs 485, 487, 489, 491 may ADD new Skill() invocations or modify existing ones.** After these PRs merge, re-audit the cross-reference count before executing. Run:
```bash
grep -rn 'Skill({ skill: "' commands/ skills/ | grep -v 'exarchos:' | wc -l
```

**TDD:** Write `commandFiles_skillInvocations_useNamespacedPrefix` and `skillFiles_skillInvocations_useNamespacedPrefix` tests before updating. These tests scan all .md files and fail if any un-namespaced `Skill({ skill: "` patterns remain.

**Estimated scope:** ~25 files modified, 1 new test file

---

### Task B3: Graphite Detection in SessionStart Hook

**Blocked by:** PR 468 (modifies `session-start.ts` and `session-start.test.ts`)
**Merge prerequisite:** PR 468 merged

**What to do:**
1. Add `graphiteAvailable` boolean field to `SessionStartResult` interface
2. Implement `detectGraphite()` helper using synchronous `which gt` check (~10ms)
3. Include `graphiteAvailable` in all result paths
4. When `gt` not found, include informational message:
   ```
   Graphite CLI not found. Exarchos requires Graphite for PR management.
   Install: https://graphite.dev/docs/install
   After install, restart Claude Code.
   ```
5. Message is informational only — non-blocking for all workflows except `/synthesize`

**Key context:**
- `handleSessionStart` is at `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.ts` (or `servers/exarchos-mcp/` if Task B1 completed first)
- Function signature: `async function handleSessionStart(_stdinData, stateDir, teamsDir?): Promise<SessionStartResult>`
- PR 468 adds `queryTelemetryHints` integration to the same handler — coordinate the insertion point
- The handler has ~880 lines of tests; add Graphite detection tests alongside
- Detection should run early (before checkpoint/workflow discovery) since it's fast
- Make `detectGraphite()` injectable for testing (pass exec function as parameter)

**TDD:** Write `handleSessionStart_graphiteAvailable_returnsTrue` and `handleSessionStart_graphiteMissing_returnsFalseWithMessage` before implementing.

**Estimated scope:** 2 files modified (handler + test)

---

### Task B4: Rules Consolidation into CLAUDE.md

**Blocked by:** PRs 469 (adds `rules/telemetry-awareness.md`), 487 (modifies `rules/coding-standards.md`)
**Merge prerequisite:** PRs 469, 487 merged

**What to do:**
1. Consolidate essential rules from `rules/` into `CLAUDE.md` for plugin-level delivery:
   - Coding standards summary (from `rules/coding-standards.md`)
   - TDD workflow summary (from `rules/tdd.md`)
   - Orchestrator constraints (from `rules/orchestrator-constraints.md`)
   - Primary workflows table (from `rules/primary-workflows.md`)
   - MCP tool guidance (from `rules/mcp-tool-guidance.md`)
   - Telemetry awareness (from `rules/telemetry-awareness.md` — added by PR 469)
2. Move skill-specific rules into skill `references/` directories
3. Keep `rules/` directory for development reference (dev-mode installer still symlinks them)
4. Target: CLAUDE.md under 200 lines for core rules

**Key context:**
- The plugin system loads `CLAUDE.md` from the plugin root — this becomes the primary rules vehicle for marketplace users
- PR 487 modifies `rules/coding-standards.md` — wait for the final version before consolidating
- PR 469 adds a NEW rule file (`rules/telemetry-awareness.md`) — include in consolidation
- Current `CLAUDE.md` is ~50 lines focused on build/test instructions
- Developer-mode users still get the full `rules/` directory via symlinks — CLAUDE.md consolidation is for marketplace users only

**TDD:** Write `claudeMd_essentialRules_present` test that checks for required sections.

**Estimated scope:** 1 file significantly rewritten (CLAUDE.md), ~5 skill reference files created/updated

---

### Task B5: Build Script Updates for Server Move

**Blocked by:** Task B1 (server source move must complete first)

**What to do:**
1. If Task B1 moved server source, verify all build scripts work with new paths
2. Update any remaining references to `plugins/exarchos/` in:
   - `manifest.json` (devEntryPoint, bundlePath)
   - CI/CD config (`.github/workflows/`)
   - Any scripts that reference server paths
3. Verify: `npm run build`, `npm run test:run`, `npm run typecheck`

**Estimated scope:** 2-4 files modified

---

## Execution Order

```
[All blocking PRs merged to main]
         │
         ├── Task B1: Server source move (independent)
         ├── Task B2: Command/skill namespacing (independent)
         ├── Task B3: Graphite detection (independent)
         ├── Task B4: Rules consolidation (independent)
         │
         └── Task B5: Build script finalization (depends on B1)
```

Tasks B1–B4 can run in parallel. Task B5 is sequential after B1.

## Pre-Flight Checklist (Before Starting Phase 1b)

Before executing any Phase 1b task, verify:

- [ ] All blocking PRs merged to main (run `gh pr list --state open --repo lvlup-sw/exarchos` and confirm count is 0 or only non-blocking PRs remain)
- [ ] Local main is up to date (`git pull origin main`)
- [ ] Phase 1a changes are on main (plugin manifests, hooks, companion exist)
- [ ] `npm run build` succeeds on current main
- [ ] `npm run test:run` passes on current main
- [ ] `npm run validate` passes on current main
- [ ] Re-audit cross-reference counts (PRs may have added new Skill() invocations):
  ```bash
  grep -rn 'Skill({ skill: "' commands/ skills/ | grep -v 'exarchos:' | wc -l
  ```
- [ ] Check if any NEW files were added to `plugins/exarchos/servers/exarchos-mcp/src/` by merged PRs (affects Task B1 move scope)
- [ ] Check if `rules/` has new files from merged PRs (affects Task B4 consolidation scope)
