# Implementation Plan: Distribution Strategy Phase 1b

## Source Design
Link: `docs/designs/2026-02-17-distribution-strategy.md`
Follow-up spec: `docs/plans/2026-02-17-distribution-strategy-followup.md`

## Scope
**Target:** Phase 1b — all five follow-up tasks (B1-B5) from the distribution strategy, plus companion content extraction (ensuring core plugin works standalone while companion restores full tool guidance)
**Excluded:** Phases 2-4 (marketplace submission, installer deprecation, npm publish) — these are external/publishing tasks, not code changes

## Summary
- Total tasks: 23
- Parallel groups: 5 (A, B, C, D, E)
- Estimated test count: 17
- Design coverage: 5 of 5 Phase 1b sections covered + companion content separation

## Pre-Flight Verification

Before starting, confirm:
```bash
npm run build        # must succeed
npm run test:run     # must pass
npm run typecheck    # must pass
```

Current state (verified 2026-02-18):
- All blocking PRs (466-491) merged to main
- PR 467 (expanded hint rules) still open — does not block Phase 1b
- PR 499 (Graphite MQ draft) closed — not needed
- Build: passing, Tests: passing, Validation: 7/8 (known .mcp.json format issue)

## Spec Traceability

| Design Section | Plan Task(s) | Coverage |
|---------------|-------------|----------|
| B1: Server Source Reorganization | A1-A6 | Full |
| B2: Command & Skill Namespacing | B1-B4 | Full |
| B3: Graphite Detection in SessionStart | C1-C4 | Full |
| B4: Rules Consolidation into CLAUDE.md | D1-D3 | Full |
| B5: Build Script Updates for Server Move | Merged into A3-A6 | Full |
| Companion content separation | E1-E6 | Full — ensures core works standalone, companion restores full guidance |

## Task Breakdown

---

### Group A: Server Source Reorganization (B1+B5)

Moves `plugins/exarchos/servers/exarchos-mcp/` to `servers/exarchos-mcp/` and updates all path references. Removes empty `plugins/` tree.

**Files to modify:** `package.json`, `manifest.json`, `CLAUDE.md`, `AGENTS.md`, `src/install.ts`, `src/install.test.ts`, `src/operations/mcp.test.ts`, `src/manifest/loader.test.ts`, `src/wizard/wizard.test.ts`, `.github/workflows/ci.yml`, `.github/workflows/benchmark-gate.yml`

---

#### Task A1: Write server-path validation test

**Phase:** RED

**TDD Steps:**
1. [RED] Write test: `serverSourcePath_afterMove_resolvesCorrectly`
   - File: `src/server-paths.test.ts`
   - Tests that `servers/exarchos-mcp/src/index.ts` exists
   - Tests that `plugins/exarchos/servers/` does NOT exist
   - Tests that build scripts in `package.json` reference `servers/` not `plugins/`
   - Expected failure: `servers/exarchos-mcp/` doesn't exist yet
   - Run: `npm run test:run` - MUST FAIL

**Dependencies:** None
**Parallelizable:** Yes (Group A lead task)

---

#### Task A2: Move server directory and update build scripts

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Move directory:
   - `git mv plugins/exarchos/servers/exarchos-mcp servers/exarchos-mcp`
   - Remove empty `plugins/exarchos/servers/` tree
2. [GREEN] Update `package.json` build scripts:
   - `build:cli`: `plugins/exarchos/servers/exarchos-mcp/src/cli.ts` → `servers/exarchos-mcp/src/cli.ts`
   - `build:mcp`: `plugins/exarchos/servers/exarchos-mcp/src/index.ts` → `servers/exarchos-mcp/src/index.ts`
   - `bench`: `cd plugins/exarchos/servers/exarchos-mcp` → `cd servers/exarchos-mcp`
3. [GREEN] Update `manifest.json`:
   - `devEntryPoint`: `plugins/exarchos/servers/exarchos-mcp/dist/index.js` → `servers/exarchos-mcp/dist/index.js`
4. Run: `npm run test:run` - A1 test MUST PASS

**Dependencies:** A1
**Parallelizable:** No (sequential after A1)

---

#### Task A3: Update installer source paths

**Phase:** GREEN (continued)

**TDD Steps:**
1. [GREEN] Update `src/install.ts`:
   - Line ~96: `plugins/exarchos/servers/exarchos-mcp/dist/index.js` → `servers/exarchos-mcp/dist/index.js`
   - Line ~467: `plugins/exarchos/servers/exarchos-mcp/dist/cli.js` → `servers/exarchos-mcp/dist/cli.js`
2. [GREEN] Update `src/install.test.ts` (6 references):
   - All `plugins/exarchos/servers/exarchos-mcp/dist/index.js` → `servers/exarchos-mcp/dist/index.js`
   - All `plugins/exarchos/servers/exarchos-mcp/dist/cli.js` → `servers/exarchos-mcp/dist/cli.js`
3. [GREEN] Update `src/operations/mcp.test.ts`:
   - `devEntryPoint: 'plugins/exarchos/servers/exarchos-mcp/dist/index.js'` → `'servers/exarchos-mcp/dist/index.js'`
4. [GREEN] Update `src/manifest/loader.test.ts` and `src/wizard/wizard.test.ts`:
   - Update any `plugins/exarchos` path references
5. Run: `npm run test:run` - ALL tests MUST PASS

**Dependencies:** A2
**Parallelizable:** No (sequential after A2)

---

#### Task A4: Update CI workflows

**Phase:** GREEN (continued)

**TDD Steps:**
1. [GREEN] Update `.github/workflows/ci.yml`:
   - Path filter: `plugins/exarchos/servers/exarchos-mcp/**` → `servers/exarchos-mcp/**`
   - Working directory: `plugins/exarchos/servers/exarchos-mcp` → `servers/exarchos-mcp`
   - Cache path: `plugins/exarchos/servers/exarchos-mcp/package-lock.json` → `servers/exarchos-mcp/package-lock.json`
2. [GREEN] Update `.github/workflows/benchmark-gate.yml`:
   - Working directory: `plugins/exarchos/servers/exarchos-mcp` → `servers/exarchos-mcp`
   - Results path and baselines path: update `plugins/exarchos/` prefix
3. No local test — CI validates on push

**Dependencies:** A2
**Parallelizable:** Yes (can run alongside A3)

---

#### Task A5: Update documentation paths

**Phase:** GREEN (continued)

**TDD Steps:**
1. [GREEN] Update `CLAUDE.md`:
   - Build section: `cd plugins/exarchos/servers/exarchos-mcp` → `cd servers/exarchos-mcp`
   - Architecture section: `plugins/exarchos/servers/exarchos-mcp/` → `servers/exarchos-mcp/`
2. [GREEN] Update `AGENTS.md`:
   - Architecture reference: `plugins/exarchos/` → `servers/` (for MCP server description)
   - Server path: `plugins/exarchos/servers/exarchos-mcp/` → `servers/exarchos-mcp/`

**Dependencies:** A2
**Parallelizable:** Yes (can run alongside A3, A4)

---

#### Task A6: Remove empty directories and handle agents file

**Phase:** REFACTOR

**TDD Steps:**
1. [REFACTOR] Move `plugins/exarchos/agents/self-hosted-reviewer.md` to an appropriate location (e.g., `agents/` at root or `.claude/agents/`)
2. [REFACTOR] Remove empty `plugins/exarchos/` directory tree
3. [REFACTOR] Remove `plugins/` directory entirely (now empty)
4. Run: `npm run build && npm run test:run && npm run typecheck` - ALL MUST PASS

**Verification:**
- [ ] `servers/exarchos-mcp/src/index.ts` exists
- [ ] `plugins/` directory does not exist
- [ ] `npm run build` succeeds
- [ ] `npm run test:run` passes
- [ ] `npm run typecheck` passes

**Dependencies:** A3, A4, A5
**Parallelizable:** No (final step in Group A)

---

### Group B: Command & Skill Namespacing

Updates all `Skill({ skill: "X" })` invocations to `Skill({ skill: "exarchos:X" })` and all slash command references to namespaced form across commands and skills.

**Scope:** 49 Skill() invocations + ~194 slash command references across ~25 files

---

#### Task B1: Write namespacing validation tests

**Phase:** RED

**TDD Steps:**
1. [RED] Write test: `commandFiles_skillInvocations_useNamespacedPrefix`
   - File: `src/namespacing-validation.test.ts`
   - Scans all `commands/*.md` for `Skill({ skill: "` patterns
   - Fails if any match WITHOUT `exarchos:` prefix
   - Expected failure: 10 un-namespaced invocations in commands/
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `skillFiles_skillInvocations_useNamespacedPrefix`
   - File: `src/namespacing-validation.test.ts`
   - Scans all `skills/**/*.md` for `Skill({ skill: "` patterns
   - Fails if any match WITHOUT `exarchos:` prefix
   - Expected failure: 39 un-namespaced invocations in skills/
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `commandAndSkillFiles_slashCommandRefs_useNamespacedPrefix`
   - File: `src/namespacing-validation.test.ts`
   - Scans all `commands/*.md` and `skills/**/*.md` for `/ideate`, `/plan`, `/delegate`, `/review`, `/synthesize`, `/debug`, `/refactor`, `/checkpoint`, `/resume`, `/cleanup` patterns
   - Allows un-namespaced refs ONLY in quoted code examples showing the user-facing command (the `## Auto-Chain` Skill() calls must be namespaced)
   - Expected failure: ~194 un-namespaced references
   - Run: `npm run test:run` - MUST FAIL

**Dependencies:** None
**Parallelizable:** Yes (Group B lead task)

---

#### Task B2: Namespace Skill() invocations in commands/

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Update all `Skill({ skill: "X"` → `Skill({ skill: "exarchos:X"` in:
   - `commands/ideate.md` (1 invocation: `plan`)
   - `commands/plan.md` (2 invocations: `plan`, `delegate`)
   - `commands/delegate.md` (2 invocations: `review`, `synthesize`)
   - `commands/review.md` (3 invocations: `synthesize`, `delegate`, `ideate`)
   - `commands/synthesize.md` (1 invocation: `delegate`)
2. Run: first namespacing test MUST PASS for commands

**Dependencies:** B1
**Parallelizable:** No (sequential after B1)

---

#### Task B3: Namespace Skill() invocations in skills/

**Phase:** GREEN (continued)

**TDD Steps:**
1. [GREEN] Update all `Skill({ skill: "X"` → `Skill({ skill: "exarchos:X"` in all skill files. Key files by change count:
   - `skills/refactor/phases/auto-chain.md` (9 invocations)
   - `skills/refactor/references/overhaul-track.md` (8 invocations)
   - `skills/refactor/SKILL.md` (4 invocations)
   - `skills/quality-review/SKILL.md` (3 invocations)
   - `skills/refactor/phases/overhaul-delegate.md` (3 invocations)
   - `skills/brainstorming/SKILL.md` (1 invocation)
   - `skills/delegation/SKILL.md` (1 invocation)
   - `skills/delegation/references/fix-mode.md` (1 invocation)
   - `skills/implementation-planning/SKILL.md` (1 invocation)
   - `skills/spec-review/SKILL.md` (1 invocation)
   - `skills/synthesis/references/troubleshooting.md` (1 invocation)
   - `skills/synthesis/references/synthesis-steps.md` (1 invocation)
   - `skills/refactor/phases/brief.md` (1 invocation)
   - `skills/refactor/phases/overhaul-review.md` (2 invocations)
   - `skills/refactor/phases/overhaul-plan.md` (2 invocations)
   - `skills/refactor/phases/update-docs.md` (1 invocation)
2. Run: second namespacing test MUST PASS for skills

**Dependencies:** B1
**Parallelizable:** Yes (can run alongside B2)

---

#### Task B4: Namespace slash command references

**Phase:** GREEN (continued)

**TDD Steps:**
1. [GREEN] Update slash command references across commands/ and skills/:
   - `/ideate` → `/exarchos:ideate` (in workflow context references)
   - `/plan` → `/exarchos:plan`
   - `/delegate` → `/exarchos:delegate`
   - `/review` → `/exarchos:review`
   - `/synthesize` → `/exarchos:synthesize`
   - `/debug` → `/exarchos:debug`
   - `/refactor` → `/exarchos:refactor`
   - `/checkpoint` → `/exarchos:checkpoint`
   - `/resume` → `/exarchos:resume`
   - `/cleanup` → `/exarchos:cleanup`
2. **Exclusions:** Keep un-namespaced form in:
   - User-facing trigger descriptions ("User runs `/ideate`") — these describe how users invoke the command
   - The `## Triggers` sections of SKILL.md files
3. Run: third namespacing test MUST PASS

**Verification:**
- [ ] `npm run test:run` — all namespacing validation tests pass
- [ ] Manual spot-check: workflow diagrams show namespaced paths
- [ ] Auto-chain Skill() calls all use `exarchos:` prefix

**Dependencies:** B2, B3
**Parallelizable:** No (final step in Group B, but can overlap with B2/B3)

---

### Group C: Graphite Detection in SessionStart Hook

Adds `detectGraphite()` helper and `graphiteAvailable` field to the session-start CLI command.

**Files to modify:** `servers/exarchos-mcp/src/cli-commands/session-start.ts`, `servers/exarchos-mcp/src/cli-commands/session-start.test.ts`

*Note: If Group A hasn't completed yet, paths will be `plugins/exarchos/servers/exarchos-mcp/src/...` — git rebase handles the rename when stacking.*

---

#### Task C1: Write detectGraphite unit tests

**Phase:** RED

**TDD Steps:**
1. [RED] Write test: `detectGraphite_gtOnPath_returnsTrue`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.test.ts`
   - Create `detectGraphite(execFn)` test with mock exec that resolves
   - Expected failure: `detectGraphite` function doesn't exist
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` - MUST FAIL

2. [RED] Write test: `detectGraphite_gtNotFound_returnsFalse`
   - File: same test file
   - Mock exec that rejects (command not found)
   - Expected failure: `detectGraphite` function doesn't exist
   - Run: MUST FAIL

**Dependencies:** None
**Parallelizable:** Yes (Group C lead task)

---

#### Task C2: Implement detectGraphite helper

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Add `detectGraphite` function:
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - Signature: `async function detectGraphite(exec?: typeof import('node:child_process').execSync): boolean`
   - Implementation: try `exec('which gt')`, return true; catch return false
   - Default param uses `child_process.execSync`
2. [GREEN] Export for testing
3. Run: C1 tests MUST PASS

**Dependencies:** C1
**Parallelizable:** No (sequential after C1)

---

#### Task C3: Write SessionStartResult integration tests

**Phase:** RED

**TDD Steps:**
1. [RED] Write test: `handleSessionStart_graphiteAvailable_includesFieldTrue`
   - File: same test file
   - Mock `detectGraphite` to return true
   - Assert `result.graphiteAvailable === true`
   - Expected failure: `graphiteAvailable` not in result type
   - Run: MUST FAIL

2. [RED] Write test: `handleSessionStart_graphiteMissing_includesFieldFalseWithMessage`
   - File: same test file
   - Mock `detectGraphite` to return false
   - Assert `result.graphiteAvailable === false`
   - Assert result contains informational message about installing Graphite
   - Expected failure: field doesn't exist
   - Run: MUST FAIL

**Dependencies:** C2
**Parallelizable:** No (sequential after C2)

---

#### Task C4: Wire detectGraphite into handleSessionStart

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Add `graphiteAvailable` to `SessionStartResult` interface:
   - `readonly graphiteAvailable?: boolean;`
2. [GREEN] Call `detectGraphite()` early in `handleSessionStart`:
   - Before checkpoint/workflow discovery (it's fast, ~10ms)
   - Include result in all return paths
3. [GREEN] When `graphiteAvailable === false`, append informational message:
   ```text
   Graphite CLI not found. Exarchos requires Graphite for PR management.
   Install: https://graphite.dev/docs/install
   After install, restart Claude Code.
   ```
4. Run: C3 tests MUST PASS

**Verification:**
- [ ] All existing session-start tests still pass (1128 lines of tests)
- [ ] New graphite detection tests pass
- [ ] `npm run test:run` from MCP server root — full green

**Dependencies:** C3
**Parallelizable:** No (sequential after C3)

---

### Group D: Rules Consolidation + Validation Fix

Consolidates essential rules from `rules/` into `CLAUDE.md` for marketplace plugin delivery. Also fixes the `.mcp.json` validation script to handle the `mcpServers` wrapper key.

---

#### Task D1: Fix .mcp.json validation in validate-plugin.sh

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Confirm current state: `bash scripts/validate-plugin.sh --repo-root .` fails on check 4
   - The script checks `.exarchos` but the file has `.mcpServers.exarchos`
   - Run: `bash scripts/validate-plugin.sh --repo-root .` - exits 1 (known)
2. [GREEN] Update `scripts/validate-plugin.sh`:
   - Change jq queries from `.exarchos` / `.graphite` to `.mcpServers.exarchos` / `.mcpServers.graphite`
3. [GREEN] Update `scripts/validate-plugin.test.sh` if it has corresponding expectations
4. Run: `bash scripts/validate-plugin.sh --repo-root .` - MUST exit 0
5. Run: `bash scripts/validate-plugin.test.sh` - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (Group D lead task)

---

#### Task D2: Write CLAUDE.md rules-presence validation test

**Phase:** RED

**TDD Steps:**
1. [RED] Write test: `claudeMd_essentialRuleSections_present`
   - File: `src/claudemd-validation.test.ts`
   - Reads `CLAUDE.md` and checks for required section headers:
     - `## Coding Standards` (or equivalent)
     - `## TDD` (or equivalent)
     - `## Orchestrator Constraints` (or equivalent)
     - `## Workflows` (already present)
     - `## MCP Tool Guidance` (or equivalent)
   - Expected failure: CLAUDE.md has only build/architecture info, no rules sections
   - Run: `npm run test:run` - MUST FAIL

**Dependencies:** None
**Parallelizable:** Yes (can start alongside D1)

---

#### Task D3: Consolidate rules into CLAUDE.md

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Rewrite `CLAUDE.md` to include consolidated rules:
   - Keep existing sections (Distribution, Build & Test, Architecture, Workflows, Key Conventions)
   - Add condensed versions of:
     - **Coding Standards** — SOLID summary, control flow, error handling (from `rules/coding-standards.md`)
     - **TDD Rules** — Red-Green-Refactor workflow, test patterns (from `rules/tdd.md`)
     - **Orchestrator Constraints** — What the orchestrator must/must not do (from `rules/orchestrator-constraints.md`)
     - **Primary Workflows** — Workflow entry points table (from `rules/primary-workflows.md`)
     - **MCP Tool Guidance** — Prefer specialized tools (from `rules/mcp-tool-guidance.md`)
     - **Safety** — rm safety rules (from `rules/rm-safety.md`)
   - Target: under 200 lines total
   - Omit `skill-path-resolution.md` (plugin system handles this) and `telemetry-awareness.md` (session-start hook handles this)
2. [GREEN] Keep `rules/` directory unchanged (dev-mode installer still uses it)
3. Run: D2 validation test MUST PASS

**Verification:**
- [ ] `CLAUDE.md` under 200 lines
- [ ] All essential rule sections present
- [ ] `npm run test:run` — all tests pass
- [ ] `npm run validate` — plugin validation passes (after D1 fix)

**Dependencies:** D1 (for validate to pass), D2 (for test to verify)
**Parallelizable:** No (depends on D1, D2)

---

### Group E: Companion Content Extraction

Extracts companion-plugin-dependent content (GitHub MCP, Serena, Context7, Microsoft Learn references) from core skills/rules into the companion plugin. Core retains functional fallbacks; companion restores full tool-preference guidance via its npm installer.

**Design principle — no degradation:**
- Core-only users: skills work with `gh` CLI, Grep/Read/Glob, web search
- Companion-installed users: companion rule + overlays restore IDENTICAL behavior to today
- Serena guidance is NEVER stripped — it's softened to "when available" in core, hardened back to "always prefer" by companion rule

**Content flow:**

| Content | Core (marketplace) | Companion (npm installer → `~/.claude/`) |
|---------|-------------------|------------------------------------------|
| `rules/mcp-tool-guidance.md` | Exarchos + Graphite only | Current full 6-tool version (verbatim) |
| `mcp-tool-reference.md` | Exarchos + Graphite + errors. Companion tools: abbreviated "when available" stubs | Full GitHub, Serena, Context7, Microsoft Learn sections as overlay |
| Implementer prompt Serena section | Primary: Read/Grep/Glob. Secondary: "When Serena MCP available, prefer these for precision:" + full tool list | Companion rule enforces hard Serena preference |
| GitHub MCP calls in commands/skills | `gh` CLI primary + "or use GitHub MCP if available" | Companion rule enforces hard GitHub MCP preference |
| Anti-patterns table | Exarchos/Graphite rows only | Full table including companion-tool rows |

---

#### Task E1: Write companion content validation tests

**Phase:** RED

**TDD Steps:**
1. [RED] Write test: `coreRules_mcpToolGuidance_onlyReferencesCoreMcpTools`
   - File: `src/companion-content-validation.test.ts`
   - Reads `rules/mcp-tool-guidance.md`
   - Asserts it references `exarchos` and `graphite`
   - Asserts it does NOT contain `mcp__plugin_github`, `mcp__plugin_serena`, `mcp__plugin_context7`, `microsoft-learn`
   - Expected failure: current file has all 6 tools
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `companionRules_mcpToolGuidance_containsAllToolReferences`
   - File: same test file
   - Reads `companion/rules/mcp-tool-guidance.md`
   - Asserts it contains Serena, GitHub MCP, Context7 references
   - Expected failure: file doesn't exist yet
   - Run: MUST FAIL

3. [RED] Write test: `companionMcpReference_containsAllCompanionSections`
   - File: same test file
   - Reads `companion/skills/workflow-state/references/companion-mcp-reference.md`
   - Asserts sections for GitHub, Serena, Context7, Microsoft Learn
   - Expected failure: file doesn't exist yet
   - Run: MUST FAIL

4. [RED] Write test: `implementerPrompt_serenaGuidance_present`
   - File: same test file
   - Reads `skills/delegation/references/implementer-prompt.md`
   - Asserts it STILL contains Serena tool names (`find_symbol`, `get_symbols_overview`, `search_for_pattern`, `find_referencing_symbols`)
   - Asserts it contains primary fallback tools (Grep, Read, Glob)
   - Expected failure: no fallback tools section yet
   - Run: MUST FAIL

**Dependencies:** None
**Parallelizable:** Yes (Group E lead task)

---

#### Task E2: Create companion rules with full MCP tool guidance

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Copy current `rules/mcp-tool-guidance.md` verbatim to `companion/rules/mcp-tool-guidance.md`
   - This preserves the EXACT current behavior for companion-installed users
   - No modifications to the companion version — it IS today's file
2. [GREEN] Strip core `rules/mcp-tool-guidance.md` to Exarchos + Graphite only:
   ```markdown
   # MCP Tool Guidance
   Use specialized MCP tools over generic approaches:
   1. **Workflow state** — Exarchos MCP, never manual JSON
   2. **PR creation** — Graphite MCP (`gt submit ...`), never `gh pr create`
   3. **State management** — `exarchos_workflow` set/get, never edit JSON directly
   See `@skills/workflow-state/references/mcp-tool-reference.md` for detailed mappings.
   ```
3. Run: first two E1 tests MUST PASS (core stripped, companion has full version)

**Dependencies:** E1
**Parallelizable:** No (sequential after E1)

---

#### Task E3: Create companion MCP tool reference overlay

**Phase:** GREEN (continued)

**TDD Steps:**
1. [GREEN] Create `companion/skills/workflow-state/references/companion-mcp-reference.md`:
   - Extract from current `mcp-tool-reference.md`: the GitHub, Serena, Context7, Microsoft Learn sections (lines 59-151)
   - Extract companion-specific anti-pattern rows (lines 166-188)
   - Add header: "# Companion MCP Tool Reference — Install via `npx @lvlup-sw/exarchos-dev`"
2. [GREEN] Update core `skills/workflow-state/references/mcp-tool-reference.md`:
   - Keep Exarchos section (lines 5-57) unchanged
   - Keep Graphite section (lines 120-138) unchanged
   - Keep Workflow Transition Errors section (lines 152-162) unchanged
   - Replace GitHub/Serena/Context7/Microsoft Learn sections with abbreviated stubs:
     ```markdown
     ## GitHub (`mcp__plugin_github_github__*`)
     > Available when exarchos-dev-tools companion is installed.
     > Provides GitHub MCP integration. Fallback: use `gh` CLI.

     ## Serena (`mcp__plugin_serena_serena__*`)
     > Available when exarchos-dev-tools companion is installed.
     > Provides semantic code analysis. Fallback: use Grep/Read/Glob.

     ## Context7 (`mcp__plugin_context7_context7__*`)
     > Available when exarchos-dev-tools companion is installed.
     > Provides library documentation. Fallback: use WebSearch.

     ## Microsoft Learn (`mcp__microsoft-learn__*`)
     > Available when exarchos-dev-tools companion is installed.
     > Provides Microsoft/Azure documentation. Fallback: use WebSearch.
     ```
   - Replace anti-patterns table: keep Exarchos/Graphite rows, add note "See companion reference for additional tool preferences"
3. Run: E1 test 3 MUST PASS

**Dependencies:** E1
**Parallelizable:** Yes (can run alongside E2)

---

#### Task E4: Soften companion tool references in core skills/commands

**Phase:** GREEN (continued)

**TDD Steps:**
1. [GREEN] Update `skills/delegation/references/implementer-prompt.md` — Code Exploration Tools section:
   - **Before (current):**
     ```markdown
     ## Code Exploration Tools
     For navigating and understanding code, prefer Serena MCP tools over grep/glob:
     - `mcp__plugin_serena_serena__find_symbol` — ...
     - `mcp__plugin_serena_serena__get_symbols_overview` — ...
     - `mcp__plugin_serena_serena__search_for_pattern` — ...
     - `mcp__plugin_serena_serena__find_referencing_symbols` — ...
     ```
   - **After:**
     ```markdown
     ## Code Exploration Tools
     For navigating and understanding code:
     - `Grep` — Search for patterns across the codebase
     - `Glob` — Find files by name pattern
     - `Read` — Read file contents (prefer targeted reads over full-file reads)

     When Serena MCP is available, prefer semantic tools for precision:
     - `mcp__plugin_serena_serena__find_symbol` — Locate classes, functions, methods by name
     - `mcp__plugin_serena_serena__get_symbols_overview` — Understand file structure without reading entire files
     - `mcp__plugin_serena_serena__search_for_pattern` — Regex search across the codebase
     - `mcp__plugin_serena_serena__find_referencing_symbols` — Find all callers/users of a symbol
     ```
   - **Key:** Serena tool list is FULLY PRESERVED, just framed as conditional
2. [GREEN] Update files with "Primary method — GitHub MCP / Fallback — gh CLI" pattern:
   - `skills/cleanup/SKILL.md` — Swap: `gh` CLI becomes primary, GitHub MCP becomes "Preferred when available"
   - `skills/cleanup/references/merge-verification.md` — Same swap
   - `skills/delegation/references/pr-fixes-mode.md` — Replace `mcp__plugin_github_github__pull_request_read` with `gh pr view --json` + note "or GitHub MCP if available"
   - `commands/cleanup.md` — Same swap pattern
3. [GREEN] Update remaining inline GitHub MCP references:
   - `commands/synthesize.md` line ~109 — `mcp__plugin_github_github__merge_pull_request` → `gh pr merge` + note
   - `skills/quality-review/SKILL.md` — GitHub MCP for PR diffs → `gh pr diff` + note
   - `skills/synthesis/references/troubleshooting.md` — `pull_request_read` for CI status → `gh pr checks` + note
   - `skills/debug/references/thorough-track.md` — `update_pull_request` → `gh pr edit` + note
   - `skills/refactor/references/overhaul-track.md` — Same as above
4. Run: E1 test 4 MUST PASS (implementer prompt has both fallback and Serena)

**Verification:**
- [ ] Serena tool names still present in implementer prompt (conditional, not stripped)
- [ ] All `mcp__plugin_github_*` hard calls replaced with `gh` CLI primary
- [ ] Each replacement includes "or use GitHub MCP if available" note
- [ ] No functionality removed — only ordering/framing changed

**Dependencies:** E1
**Parallelizable:** Yes (can run alongside E2, E3)

---

#### Task E5: Update companion installer to install content overlays

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `installCompanion_createsRuleSymlinks`
   - File: `companion/install.test.ts` (extend existing)
   - Assert that after install, `~/.claude/rules/mcp-tool-guidance.md` exists as symlink to companion version
   - Expected failure: `installContentOverlays` function doesn't exist
   - Run: MUST FAIL

2. [RED] Write test: `installCompanion_createsSkillOverlaySymlinks`
   - File: same test file
   - Assert that after install, `~/.claude/skills/workflow-state/references/companion-mcp-reference.md` exists
   - Expected failure: function doesn't exist
   - Run: MUST FAIL

3. [GREEN] Add `installContentOverlays(claudeHome)` function to `companion/src/install.ts`:
   - Discovers companion content files from `companion/rules/` and `companion/skills/`
   - Creates symlinks into `~/.claude/rules/` and `~/.claude/skills/` (preserving directory structure)
   - Handles existing files gracefully (skip if already symlinked, warn if different file exists)
   - Returns list of installed overlay paths
4. [GREEN] Wire `installContentOverlays` into `installCompanion()`:
   - Add call after `installPlugins` and `installMcpServers`
   - Include `contentOverlays` in return value
5. [GREEN] Update CLI entry point output to show installed overlays
6. Run: E5 tests MUST PASS

**Dependencies:** E2, E3 (companion content must exist)
**Parallelizable:** No (needs companion content files to exist first)

---

#### Task E6: Write no-degradation integration test

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `companionMcpToolGuidance_coversAllCurrentToolReferences`
   - File: `src/companion-content-validation.test.ts`
   - Reads companion `rules/mcp-tool-guidance.md`
   - Asserts it contains EVERY tool reference from the baseline (current main's `rules/mcp-tool-guidance.md` content, hardcoded as expected strings):
     - "Serena" + `find_symbol` / `get_symbols_overview`
     - "GitHub MCP" / "GitHub operations"
     - "Context7" + "web search"
   - This test PREVENTS future companion edits from accidentally dropping tool guidance
   - Expected failure: N/A (passes immediately since E2 copies verbatim) — write alongside E2

2. [RED] Write test: `implementerPrompt_serenaToolNames_allPresent`
   - File: same test file
   - Reads `skills/delegation/references/implementer-prompt.md`
   - Asserts ALL FOUR Serena tool names are present:
     - `mcp__plugin_serena_serena__find_symbol`
     - `mcp__plugin_serena_serena__get_symbols_overview`
     - `mcp__plugin_serena_serena__search_for_pattern`
     - `mcp__plugin_serena_serena__find_referencing_symbols`
   - This test PREVENTS the Serena guidance from being accidentally removed during future edits
   - Expected failure: N/A (passes since E4 preserves them)

3. [GREEN] Both tests should pass after E2 and E4 complete. If they fail, fix the content.

**Verification:**
- [ ] Companion `mcp-tool-guidance.md` is byte-identical to current `rules/mcp-tool-guidance.md`
- [ ] All four Serena MCP tool names present in implementer prompt
- [ ] `npm run test:run` — all companion content validation tests pass
- [ ] No Serena, GitHub MCP, Context7, or Microsoft Learn guidance was REMOVED — only moved or softened

**Dependencies:** E2, E4 (content must be in place)
**Parallelizable:** No (validation after content tasks)

---

## Parallelization Strategy

```text
                    ┌─── Group A: Server Source Move (A1→A2→A3→A4→A5→A6)
                    │
                    ├─── Group B: Namespacing (B1→B2/B3→B4)
                    │
[main] ─────────────┼─── Group C: Graphite Detection (C1→C2→C3→C4)
                    │
                    ├─── Group D: Rules Consolidation + Validation Fix (D1/D2→D3)
                    │
                    └─── Group E: Companion Content Extraction (E1→E2/E3/E4→E5→E6)
```

**5 parallel worktrees**, one per group. All groups branch from current `main`.

**Graphite stack order** (bottom to top):
1. Group A (server move) — foundation, all other groups rebase cleanly
2. Group E (companion content) — modifies rules/ and skills/ content, should go before D's CLAUDE.md consolidation
3. Group D (rules consolidation + validation fix) — consolidates AFTER companion extraction strips companion refs
4. Group C (graphite detection) — server source change, benefits from A's move during rebase
5. Group B (namespacing) — largest change, clean rebase on top

**Merge order:** A → E → D → C → B (bottom-up via Graphite)

**Important ordering note:** Group D (CLAUDE.md consolidation) depends on Group E completing first. The CLAUDE.md `## MCP Tool Guidance` section should consolidate the CORE-ONLY version of `rules/mcp-tool-guidance.md` (after E2 strips companion tools), not the current full version. In the Graphite stack, E sits below D so this is handled naturally during rebase.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Phase 2: Marketplace submission | External process — requires marketplace access |
| Phase 3: Installer deprecation | Depends on marketplace availability |
| Phase 4: Dev companion npm publish | Depends on marketplace for core plugin |
| PR 467 (expanded hint rules) | Still open, does not block Phase 1b |
| Short command aliases | Open question #1 from design — depends on Claude Code plugin system capabilities |
| `WORKFLOW_STATE_DIR` ~ expansion | Open question #5 — needs runtime verification in plugin context |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `npm run build` succeeds
- [ ] `npm run test:run` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run validate` passes (all 8/8 checks)
- [ ] `npm run validate:companion` passes
- [ ] No `plugins/exarchos/` references remain in source code
- [ ] All Skill() invocations use `exarchos:` prefix
- [ ] CLAUDE.md contains consolidated rules under 200 lines
- [ ] Graphite detection works in session-start hook
- [ ] Core `rules/mcp-tool-guidance.md` references only Exarchos + Graphite
- [ ] Companion `rules/mcp-tool-guidance.md` is identical to pre-extraction version
- [ ] All four Serena tool names present in implementer prompt (conditional framing, not stripped)
- [ ] Companion installer creates rule and skill overlay symlinks
- [ ] No companion-tool guidance REMOVED — only moved to companion or softened in core
- [ ] Ready for review
