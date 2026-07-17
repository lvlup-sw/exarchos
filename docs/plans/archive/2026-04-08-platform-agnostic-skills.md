# Implementation Plan: Platform-Agnostic Skills Distribution

**Design:** `docs/designs/2026-04-08-platform-agnostic-skills.md`
**Feature ID:** `platform-agnostic-skills`
**Date:** 2026-04-08
**Workflow:** feature

---

## Source Design

`docs/designs/2026-04-08-platform-agnostic-skills.md` — migrate Exarchos's thin instruction layer from Claude-Code-only to cross-runtime (Claude Code, Copilot CLI, Codex, OpenCode, Cursor) using a single-source `skills-src/` tree, a build-step renderer, committed per-runtime variants at `skills/<runtime>/`, and an `exarchos install-skills` CLI wrapper over `npx skills add`.

## Scope

**Target:** Full design.
**Excluded:** None.

All 10 Design Requirements (DR-1 through DR-10) and all 6 Open Questions are addressed. OQ-1 (Codex delegation syntax) is resolved via an explicit recon task (Task 011). OQ-2 (fate of `commands/`) is resolved in line with design recommendation — retain as Claude-only shim.

## Summary

- **Total tasks:** 26
- **Parallel groups:** 5
- **Estimated test count:** ~60 (renderer, loader, detector, CLI, guard)
- **Design coverage:** 10 of 10 DRs traced; all Technical Design subsections mapped

---

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task IDs | Status |
|---|---|---|---|
| DR-1 Single-source authoring | `skills-src/` as canonical; generated `skills/<runtime>/` deterministic; CI guard on direct edits | 001, 016, 017, 018, 022 | Covered |
| DR-2 Build step with substitution | `npm run build:skills` target; pure TS renderer; integrated into `npm run build`; idempotent | 002, 003, 004, 007, 008 | Covered |
| DR-3 Placeholder vocabulary | `MCP_PREFIX`, `CHAIN`, `SPAWN_AGENT_CALL`, `COMMAND_PREFIX`, `TASK_TOOL`; vocabulary doc; lint on unknown tokens | 003, 005, 006, 024 | Covered |
| DR-4 Runtime capability matrix | 6 YAMLs validated by Zod; declarative capability fields; single source of truth | 001, 002, 009, 010, 011, 012, 013, 014 | Covered |
| DR-5 Native delegation per runtime | No new MCP handler; `SPAWN_AGENT_CALL` renders native syntax per runtime; delegation skill stripped of branching | 009, 010, 011, 012, 013, 017 | Covered |
| DR-6 Cursor delegation fallback | Cursor runtime map encodes sequential execution; skill body warns once | 014, 017 | Covered |
| DR-7 `exarchos install-skills` CLI | Subcommand parses `--agent`; routes `npx skills add`; prints command; exits on child failure | 019, 020, 021, 023 | Covered |
| DR-8 Migration completeness | All 16 skills × 6 variants = 96 SKILL.md files; legacy tree removed; snapshot coverage | 015, 016, 017, 018, 022, 025 | Covered |
| DR-9 Skill install paths per runtime | `skillsInstallPath` capability field; CLI honors; documented | 009, 010, 011, 012, 013, 014, 019, 024 | Covered |
| DR-10 Error handling + edge cases | Unknown/missing placeholder errors; schema violations; stale output; network failure; ambiguous detection; unknown runtime; Cursor warning | 004, 005, 021, 022, 023 | Covered |
| Technical Design > Monorepo layout | `skills-src/`, `skills/<runtime>/`, `runtimes/*.yaml`, `src/build-skills.ts`, `src/install-skills.ts`, `src/runtimes/*.ts` | 001, 007, 019 | Covered |
| Technical Design > Build pipeline | Source + YAML → render → variant + references copied | 007, 008, 026 | Covered |
| Technical Design > Renderer | Regex substitution; multi-line placeholders; arg parsing; unresolved assertion | 003, 004, 005 | Covered |
| Technical Design > Runtime YAML format | Capability + placeholders schema; Zod-validated | 001, 002 | Covered |
| Technical Design > Install CLI | Detection + `npx skills add` wrapper | 019, 020, 021 | Covered |
| Integration Points > existing installer | Unchanged; `install-skills` is orthogonal | 019 (documented no-op with legacy) | Covered |
| Integration Points > MCP server | **No changes** — validated by absence of new handlers | 009, 010, 011, 012, 013, 014 (check no new files in `servers/exarchos-mcp/src/orchestrate/`) | Covered |
| Integration Points > `commands/` | Retained as Claude-only shim (OQ-2 resolution) | 017, 022 | Covered |
| Integration Points > `npm run build` | `build:skills` wired into root `build` script | 007, 022 | Covered |
| Testing Strategy > Unit tests | Renderer, loader, detector test files | 002, 003, 004, 005, 006, 008, 020, 021 | Covered |
| Testing Strategy > `skills:guard` CI | Build in clean checkout + diff-check | 023 | Covered |
| Testing Strategy > Snapshot tests | Per-runtime variant snapshots; renderer change review | 025 | Covered |
| Testing Strategy > Smoke tests per runtime | One e2e execution per Tier-1 runtime | 026 | Covered |
| Testing Strategy > Delegation semantics identity | Property test: same state across runtimes | 017 (included as part of delegation migration verification) | Covered |
| OQ-1 Codex delegation syntax | Recon task fetches `codex-rs/core/templates/collab/experimental_prompt.md` | 011 | Resolved |
| OQ-2 Fate of `commands/` | Retain as Claude-only shim | 017, 022 | Resolved (retain) |
| OQ-3 OpenCode install path canonicalization | Default to global `~/.config/opencode/skills/`; `--project` flag deferred | 012, 019 | Resolved (default to global) |
| OQ-4 Cursor delegation fallback (seq vs shell-out) | Sequential-in-session per design recommendation | 014, 017 | Resolved (sequential) |
| OQ-5 `skills-src/` vs `src/skills/` naming | Top-level `skills-src/` | 001, 015 | Resolved (top-level) |
| OQ-6 Escape hatch for structural divergence | `SKILL.<runtime>.md` override detection in loader | 007 | Covered (reserved, unused by default) |

---

## Parallelization Map

```
Group A (Foundation — sequential chain):
  001 ──► 002 ──► 003 ──► 004 ──► 005 ──► 006 ──► 007 ──► 008

Group B (Runtime YAMLs — parallel after 002):
  002 ──┬─► 009 (generic)
        ├─► 010 (claude)
        ├─► 011 (codex — includes recon spike)
        ├─► 012 (opencode)
        ├─► 013 (copilot)
        └─► 014 (cursor)

Group C (Skill migration — after 007 + all of Group B):
  015 (brainstorming — canary; single skill as proof of migration pattern)
    └─► 016 (batch migrate 13 simple skills)
         └─► 017 (delegation — structural refactor)
              └─► 018 (rebuild + commit generated tree + delete legacy sources)

Group D (CLI install-skills — parallel with Group C after 002):
  002 ──► 019 ──► 020 ──► 021 ──► 022

Group E (CI + integration — after 018 + 022):
  018 + 022 ──► 023 ──► 024 ──► 025 ──► 026
```

**Parallel-safe groups for worktree dispatch:**
- **Wave 1:** 001
- **Wave 2:** 002
- **Wave 3:** 003, 009, 010 (after 002 + 001)
- **Wave 4:** 004, 005, 006, 011, 012, 013, 014, 019 (broad parallelism)
- **Wave 5:** 007, 008, 020, 021
- **Wave 6:** 015, 022 (after 007 + 014)
- **Wave 7:** 016
- **Wave 8:** 017
- **Wave 9:** 018
- **Wave 10:** 023
- **Wave 11:** 024, 025
- **Wave 12:** 026

---

## Task Breakdown

### Task 001: Runtime YAML schema + Zod types

**Description:** Define the Zod schema and TypeScript types that describe a runtime map: capability flags, placeholder dictionary, install paths, and detection hints. Foundation type system used by loader, renderer, CLI, and all runtime YAML files.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-4
**Track:** Foundation
**Dependencies:** None
**Parallelizable:** Yes

**TDD Steps:**

1. **[RED]** Write schema tests:
   - File: `src/runtimes/types.test.ts`
   - Tests:
     - `RuntimeMapSchema_ValidYaml_Parses`
     - `RuntimeMapSchema_MissingName_ThrowsWithPath`
     - `RuntimeMapSchema_MissingCapability_ThrowsWithFieldName`
     - `RuntimeMapSchema_UnknownTopLevelField_Rejected`
     - `RuntimeMapSchema_EmptyPlaceholdersMap_Accepted`
     - `RuntimeMapSchema_CapabilityBooleans_TypedCorrectly`
   - Expected failure: `src/runtimes/types.ts` does not exist.

2. **[GREEN]** Define Zod schema:
   - File: `src/runtimes/types.ts`
   - Export `RuntimeMapSchema` (Zod) with: `name: string`, `capabilities: { hasSubagents, hasSlashCommands, hasHooks, hasSkillChaining, mcpPrefix }`, `skillsInstallPath: string`, `detection: { binaries: string[], envVars: string[] }`, `placeholders: Record<string, string>`.
   - Export `RuntimeMap` type (`z.infer<typeof RuntimeMapSchema>`).
   - `.strict()` top-level to reject unknown fields.

3. **[REFACTOR]** Consolidate capability typing behind a `CapabilityMatrix` alias.

**Verification:**
- Witnessed test fail (no file)
- Test passes after schema exists
- No runtime dep beyond `zod` (already in package.json)

---

### Task 002: Runtime YAML loader

**Description:** Implement the loader that reads `runtimes/<name>.yaml` files from disk, parses YAML via js-yaml, validates against the Zod schema from Task 001, and returns typed runtime maps or throws descriptive errors on failure.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-4, DR-10 (schema violation path)
**Track:** Foundation
**Dependencies:** 001
**Parallelizable:** No (blocks Group B and Group D)

**TDD Steps:**

1. **[RED]** Write loader tests:
   - File: `src/runtimes/load.test.ts`
   - Tests:
     - `LoadRuntime_ValidYamlFile_ReturnsParsedMap`
     - `LoadRuntime_MissingFile_ThrowsNotFoundError`
     - `LoadRuntime_InvalidYaml_ThrowsWithFilename`
     - `LoadRuntime_FailsZodValidation_IncludesFilenameAndFieldPath`
     - `LoadAllRuntimes_SixFilesPresent_ReturnsArrayOfSix`
     - `LoadAllRuntimes_MissingOneRequiredRuntime_Throws`
     - `LoadAllRuntimes_ExtraYamlFile_IncludedButWarnedOnlyIfUnknown`
   - Fixtures: `src/runtimes/__fixtures__/valid.yaml`, `invalid.yaml`, `malformed.yaml`
   - Expected failure: `src/runtimes/load.ts` does not exist.

2. **[GREEN]** Implement loader:
   - File: `src/runtimes/load.ts`
   - `loadRuntime(path: string): RuntimeMap` — reads file, parses YAML via `js-yaml`, validates via `RuntimeMapSchema`, throws descriptive error on failure
   - `loadAllRuntimes(runtimesDir = 'runtimes'): RuntimeMap[]` — reads directory, loads each `.yaml`, enforces presence of all six Tier-1 + generic names
   - Add `js-yaml` to dependencies if not present (check first)

3. **[REFACTOR]** Extract fixture helpers into test utils.

**Verification:**
- All 7 tests pass
- Error messages include filename and field path
- Missing required runtime triggers a single actionable error

---

### Task 003: Renderer core — placeholder substitution

**Description:** Implement the core text-substitution primitive that replaces `{{TOKEN}}` placeholders in skill bodies with values from a runtime placeholder map. Handles multi-line values, preserves indentation, and is deterministic byte-for-byte across runs.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-2, DR-3
**Track:** Foundation
**Dependencies:** 001
**Parallelizable:** No (shares `src/build-skills.ts` with Tasks 004-006)

**TDD Steps:**

1. **[RED]** Write renderer tests:
   - File: `src/build-skills.test.ts`
   - Tests:
     - `Render_SimpleToken_SubstitutesValue`
     - `Render_MultipleTokens_SubstitutesAll`
     - `Render_RepeatedToken_SubstitutesAllOccurrences`
     - `Render_MultiLineValue_PreservesIndentation`
     - `Render_NoTokens_ReturnsInputUnchanged`
     - `Render_TokenWithSurroundingText_OnlyReplacesToken`
     - `Render_Idempotent_SecondRunProducesIdenticalOutput`
   - Expected failure: `src/build-skills.ts` (or `render` export) does not exist.

2. **[GREEN]** Implement renderer:
   - File: `src/build-skills.ts`
   - Export `render(body: string, placeholders: Record<string, string>): string`
   - Regex: `/\{\{(\w+)(?:\s+([^}]*))?\}\}/g`
   - For plain token: substitute raw value
   - For token with args (e.g. `{{CHAIN next="plan"}}`): store args, substitute with template literal from placeholder value (implemented in Task 005)

3. **[REFACTOR]** Split token-matching regex into a named constant; add JSDoc.

**Verification:**
- All 7 tests pass
- Multi-line substitution preserves exactly the source indentation of the opening token
- Idempotence asserted byte-for-byte

---

### Task 004: Renderer error handling — unknown/unresolved placeholders

**Description:** Add the assertion pass and error-reporting layer to the renderer. Unknown placeholders and post-render residual braces throw with source filename, line number, runtime name, and remediation guidance.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-2, DR-10 (unresolved placeholder path)
**Track:** Foundation
**Dependencies:** 003
**Parallelizable:** No (shares `src/build-skills.ts` with Task 003)

**TDD Steps:**

1. **[RED]** Write error-path tests:
   - File: `src/build-skills.test.ts` (append)
   - Tests:
     - `Render_UnknownPlaceholder_ThrowsWithTokenNameAndLineNumber`
     - `Render_UnknownPlaceholder_ErrorListsKnownTokens`
     - `Render_UnresolvedPostRender_ThrowsViaAssert`
     - `AssertNoUnresolvedPlaceholders_CleanInput_DoesNotThrow`
     - `AssertNoUnresolvedPlaceholders_ResidualBraces_ThrowsWithLocation`
   - Expected failure: error-path code does not exist.

2. **[GREEN]** Implement error handling:
   - Add `assertNoUnresolvedPlaceholders(rendered: string, sourcePath: string, runtimeName: string): void` to `src/build-skills.ts`
   - Throw `Error` with format: `unknown placeholder {{TOKEN}} in <sourcePath>:<line>. Known placeholders: [list]. Add it to runtimes/<runtime>.yaml or remove it from source.`
   - Compute line number from match index.

3. **[REFACTOR]** Consolidate error construction into a `placeholderError()` helper.

**Verification:**
- Error messages name the skill, placeholder, and runtime
- Line numbers are accurate (1-indexed)
- Known-placeholder list is deterministically ordered

---

### Task 005: Placeholder argument parsing (`{{CHAIN next="..." args="..."}}`)

**Description:** Extend the renderer to parse named arguments inside placeholder tokens (e.g., `{{CHAIN next="plan" args="$PLAN_PATH"}}`) and substitute them into the placeholder's template value. Enables runtime-specific chain expansion.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-3
**Track:** Foundation
**Dependencies:** 003, 004
**Parallelizable:** No (shares `src/build-skills.ts` with Tasks 003-004)

**TDD Steps:**

1. **[RED]** Write arg-parsing tests:
   - File: `src/build-skills.test.ts` (append)
   - Tests:
     - `ParseTokenArgs_NoArgs_ReturnsEmptyMap`
     - `ParseTokenArgs_SingleArg_ReturnsOneEntry`
     - `ParseTokenArgs_MultipleArgs_ReturnsAll`
     - `ParseTokenArgs_ArgWithSpaces_QuotedCorrectly`
     - `ParseTokenArgs_MalformedArg_ThrowsWithContext`
     - `Render_ChainTokenWithArgs_SubstitutesPlaceholderVariables`
     - `Render_ChainTokenWithArgs_ClaudeVariant_ExpandsToSkillCall`
     - `Render_ChainTokenWithArgs_GenericVariant_ExpandsToProseInstruction`
   - Expected failure: arg parser does not exist.

2. **[GREEN]** Implement arg parsing:
   - Export `parseTokenArgs(argString: string): Record<string, string>` — parses `next="plan" args="$PLAN_PATH"`
   - Extend `render()` to substitute `{{next}}` / `{{args}}` inside the placeholder value using arg map
   - Malformed arg throws with context (e.g., missing quote, unknown form)

3. **[REFACTOR]** Ensure arg-value interpolation uses the same regex engine as top-level substitution (DRY).

**Verification:**
- Args with quoted spaces parse correctly
- Inner substitution uses a nested pass so template expands recursively
- Works with multi-line placeholder values

---

### Task 006: Reference directory copy

**Description:** Implement recursive copy of the `references/` subdirectory from each source skill to each generated variant. Preserves file structure, handles binary files, and is idempotent across runs.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-1 (references subdirectory preservation)
**Track:** Foundation
**Dependencies:** 003
**Parallelizable:** No (shares `src/build-skills.ts` with Tasks 003-005)

**TDD Steps:**

1. **[RED]** Write copy tests:
   - File: `src/build-skills.test.ts` (append) with a temp-dir helper
   - Tests:
     - `CopyReferences_SourceHasReferences_CopiedToTarget`
     - `CopyReferences_NoReferences_NoOp`
     - `CopyReferences_NestedFiles_PreservesStructure`
     - `CopyReferences_Idempotent_SecondRunIsNoop`
     - `CopyReferences_BinaryFile_CopiedUnchanged`
   - Expected failure: copy helper does not exist.

2. **[GREEN]** Implement copy:
   - Export `copyReferences(srcDir: string, destDir: string): void` in `src/build-skills.ts`
   - Recursively copy `references/` subdirectory if present; no-op otherwise
   - Preserve mtime for idempotence

3. **[REFACTOR]** Share directory-copy primitive with existing `src/operations/copy.ts` (use `smartCopyDirectory` if compatible).

**Verification:**
- References copied byte-exactly
- Idempotent across runs
- Binary files not corrupted

---

### Task 007: `buildAllSkills` orchestrator + escape-hatch detection

**Description:** Top-level build orchestrator that walks the source tree, renders each skill for each runtime, copies references, detects the `SKILL.<runtime>.md` escape-hatch override, and cleans stale output files. Returns a build report.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-1, DR-2, OQ-6 (escape hatch)
**Track:** Foundation
**Dependencies:** 002, 003, 004, 005, 006
**Parallelizable:** No (gate for Group C)

**TDD Steps:**

1. **[RED]** Write orchestrator tests:
   - File: `src/build-skills.test.ts` (append)
   - Tests with fixture tree at `src/__fixtures__/skills-src-mini/`:
     - `BuildAllSkills_OneSkillOneRuntime_GeneratesCorrectPath`
     - `BuildAllSkills_SixRuntimes_GeneratesSixVariants`
     - `BuildAllSkills_ReferencesSubdirectory_CopiedToEachVariant`
     - `BuildAllSkills_RuntimeSpecificOverrideFile_PrefersOverride`
     - `BuildAllSkills_CleansStaleOutput_RemovesOrphanedVariants`
     - `BuildAllSkills_EmptySourceDir_Throws`
     - `BuildAllSkills_RuntimeWithNoPlaceholders_CopiesUnchanged`
   - Expected failure: orchestrator does not exist.

2. **[GREEN]** Implement orchestrator:
   - Export `buildAllSkills(opts: { srcDir, outDir, runtimesDir }): BuildReport` in `src/build-skills.ts`
   - Loads all runtimes, walks sources, renders each skill × each runtime, writes to `outDir/<runtime>/<skill>/SKILL.md`
   - Detects escape-hatch overrides: `skills-src/<skill>/SKILL.<runtime>.md` takes precedence over `skills-src/<skill>/SKILL.md` for that runtime only
   - Returns report: `{ variantsWritten, referencesCopied, overridesUsed, warnings }`
   - Cleans stale files: any file under `outDir/<runtime>/` not produced by this run is removed

3. **[REFACTOR]** Extract file-walking into `src/runtimes/sources.ts` helper if test expresses coupling.

**Verification:**
- Running twice on the fixture produces identical output
- Override file detection works
- Stale cleanup doesn't touch files outside `outDir/<runtime>/`

---

### Task 008: CLI entry point for `npm run build:skills`

**Description:** Wire the build orchestrator into a runnable node entry point and add the `build:skills` npm script. Ensure `npm run build` invokes it so the generated tree is always in sync with the compiled MCP server bundle.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-2 (npm script integration)
**Track:** Foundation
**Dependencies:** 007
**Parallelizable:** No

**TDD Steps:**

1. **[RED]** Write CLI tests:
   - File: `src/build-skills-cli.test.ts`
   - Tests:
     - `BuildSkillsCli_NoArgs_UsesDefaultPaths`
     - `BuildSkillsCli_OnError_ExitsNonZeroWithMessage`
     - `BuildSkillsCli_Success_PrintsSummary`
     - `BuildSkillsCli_ReportContainsVariantCount`
   - Mock filesystem via temp directories.

2. **[GREEN]** Implement CLI:
   - File: `src/build-skills.ts` (add `main()` entry at bottom, gated on `import.meta.url === process.argv[1]`)
   - Calls `buildAllSkills` with `skills-src/`, `skills/`, `runtimes/` defaults
   - Prints `[build:skills] wrote 96 variants across 6 runtimes` on success
   - Add `"build:skills": "node dist/build-skills.js"` to `package.json` scripts
   - Update root `"build"` script to run `build:skills` after TS compile

3. **[REFACTOR]** Match output format with existing `build:mcp` style for consistency.

**Verification:**
- `npm run build:skills` produces deterministic output
- `npm run build` invokes `build:skills` end-to-end
- Error exit code propagates

---

### Task 009: `runtimes/generic.yaml` (LCD fallback)

**Description:** Author the lowest-common-denominator runtime map used by non-Tier-1 agents and as a baseline for Cursor's sequential delegation. No subagents, no slash commands, no hooks, minimal MCP prefix, prose-style fallbacks.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-4, DR-5 (generic branch)
**Track:** Runtime Configs
**Dependencies:** 002
**Parallelizable:** Yes (Group B)

**TDD Steps:**

1. **[RED]** Write a runtime-presence test:
   - File: `src/runtimes/presence-generic.test.ts`
   - Test: `LoadAllRuntimes_GenericYamlPresent_HasCanonicalCapabilities`
   - Asserts: `hasSubagents: false`, `hasSlashCommands: false`, `hasHooks: false`, `hasSkillChaining: false`, `mcpPrefix: "mcp__exarchos__"`, `skillsInstallPath` defined
   - Expected failure: `runtimes/generic.yaml` does not exist.

2. **[GREEN]** Create `runtimes/generic.yaml`:
   - `name: generic`
   - All capability flags false
   - `placeholders.MCP_PREFIX: "mcp__exarchos__"`
   - `placeholders.COMMAND_PREFIX: ""`
   - `placeholders.CHAIN: "[Invoke the exarchos:{{next}} skill with args: {{args}}]"`
   - `placeholders.SPAWN_AGENT_CALL` = prose directive: "Execute each task sequentially in the current session, one at a time, against the prepared worktrees."
   - `placeholders.TASK_TOOL: "[sequential execution]"`
   - `skillsInstallPath: "~/.agents/skills"`
   - `detection.binaries: []` (manual-only)

3. **[REFACTOR]** Copy inline comments explaining intent of LCD choices.

**Verification:**
- Load test passes
- Placeholder values are all defined

---

### Task 010: `runtimes/claude.yaml`

**Description:** Author the Claude Code runtime map. Full-fidelity: plugin MCP prefix, slash-command dispatch, `Task()` subagent spawn, `Skill({})` auto-chain. Substitutions must produce output byte-identical to the pre-migration delegation skill body.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-4, DR-5 (claude branch)
**Track:** Runtime Configs
**Dependencies:** 002
**Parallelizable:** Yes (Group B)

**TDD Steps:**

1. **[RED]** Write presence test:
   - File: `src/runtimes/presence-claude.test.ts`
   - Tests:
     - `LoadAllRuntimes_ClaudeYamlPresent_HasClaudeCapabilities`
     - `ClaudeYaml_McpPrefix_MatchesPluginNaming`
     - `ClaudeYaml_SpawnAgentCall_UsesTaskTool`
     - `ClaudeYaml_ChainToken_UsesSkillInvocation`
   - Assertions: `hasSubagents: true`, `mcpPrefix: "mcp__plugin_exarchos_exarchos__"`, `SPAWN_AGENT_CALL` contains `Task({`, `CHAIN` contains `Skill({`.
   - Expected failure: `runtimes/claude.yaml` does not exist.

2. **[GREEN]** Create `runtimes/claude.yaml`:
   - Populate capability matrix with all-true flags
   - `placeholders.MCP_PREFIX: "mcp__plugin_exarchos_exarchos__"`
   - `placeholders.COMMAND_PREFIX: "/exarchos:"`
   - `placeholders.TASK_TOOL: "Task"`
   - `placeholders.CHAIN: 'Skill({ skill: "exarchos:{{next}}", args: "{{args}}" })'`
   - `placeholders.SPAWN_AGENT_CALL`: multi-line YAML block scalar with the Claude Code `Task({ subagent_type: "exarchos-implementer", run_in_background: true, ... })` form
   - `skillsInstallPath: "~/.claude/skills"`
   - `detection.binaries: ["claude"]`
   - `detection.envVars: ["CLAUDECODE", "CLAUDE_CODE_*"]`

3. **[REFACTOR]** Align `SPAWN_AGENT_CALL` wording with current `skills/delegation/SKILL.md` so migration produces byte-identical output for delegation.

**Verification:**
- All presence tests pass
- Byte-identical output comparison with current delegation claude section (manual diff during implementation)

---

### Task 011: `runtimes/codex.yaml` + Codex recon spike (OQ-1 resolution)

**Description:** Author the Codex CLI runtime map. Includes a recon spike to fetch Codex's `experimental_prompt.md` and capture the exact multi-agent spawn invocation form. Resolves OQ-1 and produces Codex-native delegation syntax.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-4, DR-5 (codex branch), OQ-1
**Track:** Runtime Configs
**Dependencies:** 002
**Parallelizable:** Yes (Group B)

**TDD Steps:**

1. **[RED]** Write presence + capability test:
   - File: `src/runtimes/presence-codex.test.ts`
   - Tests:
     - `LoadAllRuntimes_CodexYamlPresent_HasSubagents`
     - `CodexYaml_SpawnAgentCall_UsesMultiAgentPrimitive`
     - `CodexYaml_SkillsInstallPath_AgentsStandard`
   - Assertions: `hasSubagents: true`, `skillsInstallPath: "$HOME/.agents/skills"`, `SPAWN_AGENT_CALL` references the multi-agent spawn primitive.
   - Expected failure: `runtimes/codex.yaml` does not exist.

2. **[GREEN]** Recon + create:
   - **Recon step:** `WebFetch https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/templates/collab/experimental_prompt.md` — extract the exact spawn-other-agents invocation form (tool call vs. natural-language directive).
   - Record findings at top of `runtimes/codex.yaml` as comments.
   - Populate YAML:
     - `name: codex`
     - Capabilities: `hasSubagents: true`, `hasSlashCommands: true` (if custom commands), `hasHooks: false`, `hasSkillChaining: false`, `mcpPrefix: "mcp__exarchos__"` (TBD, adjust if Codex uses different prefix convention)
     - `skillsInstallPath: "$HOME/.agents/skills"` (per Codex docs)
     - `placeholders.SPAWN_AGENT_CALL`: use exact form from recon; if Codex uses prose delegation, store the canonical instruction block
     - `detection.binaries: ["codex"]`

3. **[REFACTOR]** Inline Codex-specific commentary as YAML comments. Runtime notes aggregation happens in Task 022.

**Verification:**
- Recon findings documented in YAML comments
- Tests pass
- Delegation form is verified against Codex upstream source, not guessed

---

### Task 012: `runtimes/opencode.yaml`

**Description:** Author the OpenCode runtime map. OpenCode's `Task({subagent_type, prompt})` surface is 1:1 with Claude Code's, so the substitution values are nearly identical except for the MCP prefix and install path. Resolves OQ-3.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-4, DR-5 (opencode branch), OQ-3
**Track:** Runtime Configs
**Dependencies:** 002
**Parallelizable:** Yes (Group B)

**TDD Steps:**

1. **[RED]** Write presence test:
   - File: `src/runtimes/presence-opencode.test.ts`
   - Tests:
     - `LoadAllRuntimes_OpencodeYamlPresent_HasSubagents`
     - `OpencodeYaml_SpawnAgentCall_MatchesClaudeTaskSyntax`
     - `OpencodeYaml_SkillsInstallPath_GlobalConfig`
   - Assertions: `hasSubagents: true`, `skillsInstallPath: "~/.config/opencode/skills"` (per design OQ-3 default), `SPAWN_AGENT_CALL` uses `Task({ subagent_type: ..., prompt: ... })`.
   - Expected failure: `runtimes/opencode.yaml` does not exist.

2. **[GREEN]** Create `runtimes/opencode.yaml`:
   - Capabilities: `hasSubagents: true`, `hasSlashCommands: true`, `hasHooks: false`, `hasSkillChaining: false`
   - `placeholders.SPAWN_AGENT_CALL` = OpenCode `Task({ subagent_type: "exarchos-implementer", prompt: "..." })` (literally identical to Claude per recon)
   - `placeholders.MCP_PREFIX: "mcp__exarchos__"`
   - `skillsInstallPath: "~/.config/opencode/skills"`
   - `detection.binaries: ["opencode"]`

3. **[REFACTOR]** If OpenCode's `Task` body is 1:1 with Claude's, annotate in comments and reference the Claude YAML.

**Verification:**
- All tests pass
- Output for delegation skill on OpenCode matches Claude delegation *except* for the MCP prefix

---

### Task 013: `runtimes/copilot.yaml`

**Description:** Author the GitHub Copilot CLI runtime map. Delegation uses Copilot's native `/delegate` slash command. Custom-agent frontmatter conventions from Copilot's docs are noted in YAML comments.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-4, DR-5 (copilot branch)
**Track:** Runtime Configs
**Dependencies:** 002
**Parallelizable:** Yes (Group B)

**TDD Steps:**

1. **[RED]** Write presence test:
   - File: `src/runtimes/presence-copilot.test.ts`
   - Tests:
     - `LoadAllRuntimes_CopilotYamlPresent_HasSubagents`
     - `CopilotYaml_SpawnAgentCall_UsesDelegateSlashCommand`
     - `CopilotYaml_SkillsInstallPath_CopilotConfig`
   - Assertions: `hasSubagents: true`, `SPAWN_AGENT_CALL` contains `/delegate`, `skillsInstallPath` set.
   - Expected failure: `runtimes/copilot.yaml` does not exist.

2. **[GREEN]** Create `runtimes/copilot.yaml`:
   - Capabilities: `hasSubagents: true` (via `/delegate`), `hasSlashCommands: true`, `hasHooks: false`, `hasSkillChaining: false`
   - `placeholders.SPAWN_AGENT_CALL: '/delegate "{{task.description}}: {{task.prompt}}"'` (single-line placeholder)
   - `placeholders.COMMAND_PREFIX: "/"`
   - `skillsInstallPath: "~/.copilot/skills"` (TBD — confirm during recon; fallback to `~/.agents/skills`)
   - `detection.binaries: ["copilot"]`

3. **[REFACTOR]** Cross-check Copilot custom-agent frontmatter conventions from context7 and note in comments.

**Verification:**
- Presence tests pass
- `/delegate` syntax renders correctly when substituted into the delegation skill

---

### Task 014: `runtimes/cursor.yaml` + fallback policy (OQ-4 resolution)

**Description:** Author the Cursor CLI runtime map. Cursor has no in-session subagent primitive, so `SPAWN_AGENT_CALL` renders a sequential-execution directive plus a one-time warning. Implements DR-6 and resolves OQ-4.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-4, DR-5 (cursor branch), DR-6, OQ-4
**Track:** Runtime Configs
**Dependencies:** 002
**Parallelizable:** Yes (Group B)

**TDD Steps:**

1. **[RED]** Write presence + fallback test:
   - File: `src/runtimes/presence-cursor.test.ts`
   - Tests:
     - `LoadAllRuntimes_CursorYamlPresent_HasNoSubagents`
     - `CursorYaml_SpawnAgentCall_UsesSequentialFallback`
     - `CursorYaml_SpawnAgentCall_ContainsWarningNote`
   - Assertions: `hasSubagents: false`, `SPAWN_AGENT_CALL` contains "sequentially" and "Cursor" warning text.
   - Expected failure: `runtimes/cursor.yaml` does not exist.

2. **[GREEN]** Create `runtimes/cursor.yaml`:
   - Capabilities: `hasSubagents: false`, `hasSlashCommands: false`, `hasHooks: false`, `hasSkillChaining: false`
   - `placeholders.SPAWN_AGENT_CALL` = sequential directive block: "Cursor CLI has no in-session subagent primitive. Execute each task sequentially in the current session, visiting each worktree in turn. A single warning should be emitted once per delegation batch."
   - `placeholders.CHAIN` = prose instruction
   - `skillsInstallPath: "~/.cursor/skills"` (confirm via recon; fall back to project-level if global not supported)
   - `detection.binaries: ["cursor-agent", "cursor"]`

3. **[REFACTOR]** Inline the Cursor fallback policy as YAML comments. Consolidated runtime-notes documentation happens in Task 022.

**Verification:**
- Tests pass
- Delegation skill rendered for Cursor contains the sequential fallback and warning note

---

### Task 015: Canary migration — `brainstorming` skill

**Description:** Migrate a single skill (brainstorming) as the canary. Proves the end-to-end pipeline — source edit, placeholder insertion, build, byte-identical claude output — and catches renderer bugs before batch migration propagates them.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-1, DR-8 (single-skill proof)
**Track:** Migration
**Dependencies:** 007, all Group B
**Parallelizable:** No (blocks Task 016)

**TDD Steps:**

1. **[RED]** Write migration-output test:
   - File: `test/migration/brainstorming-migration.test.ts`
   - Tests (running the build step then asserting output):
     - `Migration_Brainstorming_ClaudeVariantByteIdenticalToCurrent`
     - `Migration_Brainstorming_GenericVariant_NoClaudeSpecificSyntax`
     - `Migration_Brainstorming_AllSixVariantsHaveIdenticalDescriptionFrontmatter`
   - Expected failure: `skills-src/brainstorming/` does not exist.

2. **[GREEN]** Migrate:
   - Move `skills/brainstorming/SKILL.md` → `skills-src/brainstorming/SKILL.md`
   - Move `skills/brainstorming/references/` → `skills-src/brainstorming/references/`
   - Insert placeholders: replace `mcp__plugin_exarchos_exarchos__` with `{{MCP_PREFIX}}`, replace `Skill({...})` chain with `{{CHAIN next="..." args="..."}}`, replace `/exarchos:` command references with `{{COMMAND_PREFIX}}`
   - Run `npm run build:skills`
   - Verify Claude variant is byte-identical to the pre-migration file (baseline captured at test setup)

3. **[REFACTOR]** Extract a shared "claude baseline" fixture used by later migration tasks.

**Verification:**
- Tests pass
- `skills/claude/brainstorming/SKILL.md` byte-identical to the pre-migration `skills/brainstorming/SKILL.md`
- All six variants emit valid frontmatter

**Rationalization Refutation:** Some skills could be migrated in parallel, but the canary establishes the migration pattern and catches renderer bugs before they propagate across 15 more skills.

---

### Task 016: Batch-migrate 13 simple skills

**Description:** Move 13 mostly-runtime-neutral skills from legacy `skills/<name>/` into `skills-src/<name>/` and insert the three placeholder classes (`{{MCP_PREFIX}}`, `{{CHAIN}}`, `{{COMMAND_PREFIX}}`). Baseline asserts byte-identical claude output per skill.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-1, DR-8
**Track:** Migration
**Dependencies:** 015
**Parallelizable:** No (single coherent migration)

**TDD Steps:**

1. **[RED]** Write batch-migration test:
   - File: `test/migration/batch-migration.test.ts`
   - Tests:
     - `BatchMigration_AllThirteenSkills_ClaudeVariantByteIdenticalToBaseline`
     - `BatchMigration_AllThirteenSkills_GenericVariantNoClaudePrefixes`
     - `BatchMigration_NoUnresolvedPlaceholders_InAnyVariant`
   - Baseline: captured pre-migration contents of each skill's current `SKILL.md`.
   - Expected failure: source directories do not yet exist at `skills-src/`.

2. **[GREEN]** Migrate 13 skills:
   - `cleanup`, `debug`, `dogfood`, `git-worktrees`, `implementation-planning`, `quality-review`, `refactor`, `rehydrate`, `shepherd`, `spec-review`, `synthesis`, `tdd`, `workflow-state`
   - For each: move `skills/<name>/` → `skills-src/<name>/`, insert placeholders for the three substitution classes (`{{MCP_PREFIX}}`, `{{CHAIN}}`, `{{COMMAND_PREFIX}}`)
   - Also migrate shared `skills/shared/` → `skills-src/_shared/`
   - Run `npm run build:skills`

3. **[REFACTOR]** If any skill has unexpected Claude-specific references (beyond the known three), document in `docs/references/runtime-notes.md` and add new placeholders to vocabulary if warranted.

**Verification:**
- Byte-identical claude baselines across all 13 skills
- Zero unresolved placeholders post-render
- `test/migration/batch-migration.test.ts` passes

---

### Task 017: Delegation skill refactor + commands shim

**Description:** Collapse the dual-tracked "Claude Code native" and "Cross-platform" sections in `skills-src/delegation/SKILL.md` into a single body that invokes `{{SPAWN_AGENT_CALL}}`. Retains `commands/` unchanged as the Claude-Code-only shim per OQ-2.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-1, DR-5, DR-6, DR-8, OQ-2
**Track:** Migration
**Dependencies:** 016
**Parallelizable:** No

**TDD Steps:**

1. **[RED]** Write delegation-refactor tests:
   - File: `test/migration/delegation-migration.test.ts`
   - Tests:
     - `DelegationSource_ContainsNoTaskTool_OnlyPlaceholder`
     - `DelegationSource_ContainsNoClaudeNativeSection_CollapsedIntoPlaceholder`
     - `DelegationSource_ContainsNoCrossPlatformSection_Unified`
     - `DelegationClaudeVariant_EquivalentBehaviorToPreMigration`
     - `DelegationCursorVariant_ContainsSequentialDirective`
     - `DelegationCursorVariant_ContainsWarningText`
     - `DelegationOpenCodeVariant_UsesTaskTool`
     - `DelegationCodexVariant_UsesNativePrimitive`
     - `DelegationCopilotVariant_UsesDelegateSlashCommand`
     - `DelegationGenericVariant_SequentialFallback`
   - Expected failure: source still contains dual-tracked "Claude Code native" + "Cross-platform" sections.

2. **[GREEN]** Refactor:
   - `skills-src/delegation/SKILL.md`: strip "Claude Code Dispatch (native agents)" and "Cross-platform Dispatch" forked sections; replace with a single `## Step 2: Dispatch` block that invokes `{{SPAWN_AGENT_CALL}}`
   - Update transition to use `{{CHAIN next="review" args="<plan-path>"}}`
   - Migrate `skills/delegation/` → `skills-src/delegation/`
   - Retain `commands/*.md` files unchanged as a Claude-Code-only shim (OQ-2 resolution: do not delete, do not move into skills-src)
   - Verify all 10 delegation-variant tests pass

3. **[REFACTOR]** Capture "delegation semantics identity" property invariants: given a task list, Claude/OpenCode (parallel) and Cursor/generic (sequential) produce equivalent final workflow state. File: `test/migration/delegation-semantics-property.test.ts` (skipped in CI if requires running agents; run locally for validation).

**Verification:**
- Source contains zero `Task({`, `/delegate`, `subagent_type` strings — only `{{SPAWN_AGENT_CALL}}`
- `npm run build:skills` emits valid variants for all six runtimes
- `servers/exarchos-mcp/src/orchestrate/` has no new files (grep)

---

### Task 018: Commit generated tree + remove legacy sources

**Description:** Final migration cutover. Run the build, commit all six `skills/<runtime>/` trees, delete legacy top-level `skills/*/SKILL.md` sources, update manifest if needed. Asserts the 96-file structural invariant.

**Phase:** GREEN (no RED — cleanup task)
**Test Layer:** integration
**Implements:** DR-1 (legacy removal), DR-8 (96-file invariant)
**Track:** Migration
**Dependencies:** 017
**Parallelizable:** No

**TDD Steps:**

1. **[RED]** Write structural invariant test:
   - File: `test/migration/structural-invariant.test.ts`
   - Tests:
     - `PostMigration_SkillsTree_Contains96SkillMdFiles`
     - `PostMigration_SkillsSrcTree_ContainsNoCommittedGeneratedFiles`
     - `PostMigration_LegacyTopLevelSkillsGone_NotPresent`
   - Expected failure: legacy top-level skill directories still present.

2. **[GREEN]** Cleanup:
   - Run `npm run build:skills` (final build)
   - Commit `skills/claude/`, `skills/copilot/`, `skills/codex/`, `skills/opencode/`, `skills/cursor/`, `skills/generic/` (all 16 × 6 files)
   - Delete any remaining legacy sources under `skills/*/SKILL.md` that weren't already moved
   - Update `.gitignore` to ensure `skills/` is NOT ignored (explicitly committed)
   - Update `manifest.json` if it references old `skills/` paths (likely no-op after refactor)

3. **[REFACTOR]** None — this is a cleanup task.

**Verification:**
- `find skills -name SKILL.md -type f | wc -l` equals 96
- No files remain at top-level `skills/<name>/SKILL.md` (only under `skills/<runtime>/<name>/SKILL.md`)
- `git status` clean after `npm run build:skills`

**Note:** This task is not TDD-shaped in the classic sense (no new logic) but has an acceptance test (the structural invariant). The test covers the "did we finish migrating" question.

---

### Task 019: `exarchos install-skills` subcommand scaffold

**Description:** Create the `exarchos install-skills` CLI subcommand that routes skill installation via `npx skills add`. Handles `--agent` flag, tilde expansion, command printing, and child process spawning with injectable dependencies for testability.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-7 (scaffold), DR-9
**Track:** CLI
**Dependencies:** 002
**Parallelizable:** Yes (Group D)

**TDD Steps:**

1. **[RED]** Write CLI tests:
   - File: `src/install-skills.test.ts`
   - Tests:
     - `InstallSkills_WithAgentFlag_LoadsMatchingRuntime`
     - `InstallSkills_WithAgentFlag_ConstructsCorrectNpxCommand`
     - `InstallSkills_WithAgentFlag_PrintsCommandBeforeExecuting`
     - `InstallSkills_WithAgentFlag_ExpandsTildeInInstallPath`
     - `InstallSkills_UnknownAgent_ThrowsWithSupportedList`
   - Mock `npx skills add` via injected spawn function; no real child process in unit tests.
   - Expected failure: `src/install-skills.ts` does not exist.

2. **[GREEN]** Implement subcommand:
   - File: `src/install-skills.ts`
   - Export `installSkills(opts: { agent?: string, runtimes?: RuntimeMap[], spawn?: SpawnFn }): Promise<void>`
   - Resolves target runtime via `--agent` or detection (Task 020 fills detection)
   - Constructs `npx skills add github:lvlup-sw/exarchos skills/<runtime> --target <expandedPath>`
   - Spawns child process (default `child_process.spawn` or injected); prints command before execution

3. **[REFACTOR]** Share runtime resolution with future `uninstall-skills` subcommand if needed.

**Verification:**
- Unit tests pass with mocked spawn
- Command is printed to stdout before execution
- Tilde expansion matches existing `src/utils/paths.ts` behavior

---

### Task 020: Runtime auto-detection

**Description:** Detect which supported agent CLI is installed on the user's machine by scanning PATH and environment variables using each runtime's declared detection hints. Handles multi-candidate ambiguity and zero-match fallback.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-7 (detection)
**Track:** CLI
**Dependencies:** 019
**Parallelizable:** No (sequential CLI chain)

**TDD Steps:**

1. **[RED]** Write detection tests:
   - File: `src/runtimes/detect.test.ts`
   - Tests:
     - `DetectRuntime_ClaudeInPath_ReturnsClaude`
     - `DetectRuntime_CodexInPath_ReturnsCodex`
     - `DetectRuntime_MultipleCandidates_ThrowsAmbiguousError`
     - `DetectRuntime_NoCandidates_ReturnsGeneric`
     - `DetectRuntime_EnvVarSet_OverridesPathDetection`
     - `DetectRuntime_RespectsInjectedPathLookup_Deterministic`
   - Uses injected `which`/env helpers for determinism.
   - Expected failure: `src/runtimes/detect.ts` does not exist.

2. **[GREEN]** Implement detection:
   - File: `src/runtimes/detect.ts`
   - Export `detectRuntime(runtimes: RuntimeMap[], deps?: { which, env }): RuntimeMap | null`
   - For each runtime's `detection.binaries`, call `which`
   - Collect all matches; if >1 and not disambiguated, throw `AmbiguousRuntimeError` with candidate list
   - If 0 matches, return `null` (caller installs `generic`)
   - Wire into `installSkills()` from Task 019

3. **[REFACTOR]** Add a `DetectionResult` type carrying rationale for debug output.

**Verification:**
- All tests pass
- Ambiguous-case error names all candidates
- Null on no-match (not throw)

---

### Task 021: CLI error handling + user messages

**Description:** Round out the install-skills CLI with error paths: network failure passthrough, ambiguous runtime detection in interactive vs. non-interactive mode, unknown runtime flag, generic fallback messaging, stderr verbatim propagation.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-7, DR-10 (CLI error paths)
**Track:** CLI
**Dependencies:** 019, 020
**Parallelizable:** No (shares `src/install-skills.test.ts` with Task 019)

**TDD Steps:**

1. **[RED]** Write error-path tests:
   - File: `src/install-skills.test.ts` (append)
   - Tests:
     - `InstallSkills_NpxFailure_ExitsWithChildCode`
     - `InstallSkills_NpxFailure_PrintsExactCommandForRetry`
     - `InstallSkills_AmbiguousDetection_InteractivePrompt`
     - `InstallSkills_AmbiguousDetection_NonInteractiveExitsNonZero`
     - `InstallSkills_UnknownRuntimeFlag_PrintsSupportedList`
     - `InstallSkills_NetworkError_PropagatesStderrVerbatim`
     - `InstallSkills_NoDetectedAgent_InstallsGenericWithMessage`
   - Expected failure: error paths not yet implemented.

2. **[GREEN]** Implement error handling:
   - Capture child stderr; surface verbatim on exit
   - Respect `--yes` / `NON_INTERACTIVE=1` for ambiguous detection → exit non-zero with remediation
   - Interactive mode uses `prompts` library (already in deps) to disambiguate
   - Unknown runtime → `Unknown runtime: "X". Supported: claude, copilot, codex, opencode, cursor, generic.`
   - Generic fallback → `No supported agent CLI detected. Installing generic skills to <path>. See docs for supported runtimes.`

3. **[REFACTOR]** Extract error messages into `src/install-skills-messages.ts` constants for centralized copy review.

**Verification:**
- All error tests pass
- Interactive vs. non-interactive paths distinguished
- Exit codes propagate correctly

---

### Task 022: Wire `install-skills` into CLI + consolidated documentation

**Description:** Register the install-skills subcommand in the main CLI router, update `--help`, create `docs/references/placeholder-vocabulary.md` and `docs/references/runtime-notes.md` (consolidating observations from Tasks 011/014), update README install section.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-7, DR-9 (docs), DR-3 (vocabulary doc)
**Track:** CLI
**Dependencies:** 021
**Parallelizable:** No (after CLI tasks)

**TDD Steps:**

1. **[RED]** Write wiring tests:
   - File: `src/install-skills-cli.test.ts`
   - Tests:
     - `ExarchosCli_InstallSkillsCommand_Registered`
     - `ExarchosCli_InstallSkillsHelp_ListsSupportedAgents`
     - `ExarchosCli_InstallSkillsFlag_ParsedCorrectly`
   - Expected failure: command not registered in main CLI entry.

2. **[GREEN]** Wire and document:
   - Add `install-skills` subcommand to the main CLI router (likely `src/install.ts` or a new `src/cli.ts`; follow existing pattern)
   - Update `printHelp()` with `install-skills` section listing all runtimes
   - Create `docs/references/placeholder-vocabulary.md` with canonical placeholder list and intended usage
   - Create `docs/references/runtime-notes.md` capturing per-runtime quirks discovered during Tasks 009-014
   - Update README install section with runtime-specific examples

3. **[REFACTOR]** Ensure README reflects the three-step install: CLI install → optional MCP register → `exarchos install-skills`.

**Verification:**
- `exarchos install-skills --help` prints all 6 runtimes
- Docs link from README
- Vocabulary doc matches actual placeholder map

---

### Task 023: CI `skills:guard` check

**Description:** Add the CI guard that runs the build in a clean checkout and fails if `git diff --exit-code skills/` is non-empty. Prevents drift from direct edits to generated files. Wired into the GitHub Actions CI pipeline.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-1 (guard), DR-10 (stale-output path)
**Track:** Integration
**Dependencies:** 018, 022
**Parallelizable:** No

**TDD Steps:**

1. **[RED]** Write guard tests:
   - File: `src/skills-guard.test.ts`
   - Tests:
     - `SkillsGuard_CleanBuild_Passes`
     - `SkillsGuard_UncommittedDiff_Fails`
     - `SkillsGuard_FailureMessage_IncludesRemediation`
     - `SkillsGuard_DirectSkillEdit_Detected`
   - Uses temp git worktree for isolation.
   - Expected failure: `src/skills-guard.ts` does not exist.

2. **[GREEN]** Implement guard:
   - File: `src/skills-guard.ts`
   - Runs `buildAllSkills()` in-process
   - Checks `git diff --exit-code skills/` (via `execSync`)
   - Non-zero diff → prints remediation and exits non-zero
   - Add `"skills:guard": "node dist/skills-guard.js"` to `package.json`
   - Add `skills:guard` step to `.github/workflows/*.yml` CI pipeline (likely `ci.yml`)

3. **[REFACTOR]** Reuse common exit/messaging helpers.

**Verification:**
- Clean tree passes
- Dirty tree fails with clear error
- CI pipeline step wired

---

### Task 024: Placeholder vocabulary enforcement + lint

**Description:** Enforce the canonical placeholder vocabulary by walking all source skills and flagging unknown tokens. Runs as a pre-flight step inside `buildAllSkills()` so unknown placeholders fail fast with an aggregated error report.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-3 (lint path)
**Track:** Integration
**Dependencies:** 008
**Parallelizable:** No (shares `src/build-skills.ts` regex with Task 003)

**TDD Steps:**

1. **[RED]** Write vocabulary lint tests:
   - File: `src/placeholder-lint.test.ts`
   - Tests:
     - `PlaceholderLint_KnownToken_Passes`
     - `PlaceholderLint_UnknownToken_FailsWithVocabularyList`
     - `PlaceholderLint_RunsOnAllSources_AggregatesErrors`
   - Expected failure: lint does not exist.

2. **[GREEN]** Implement lint:
   - File: `src/placeholder-lint.ts`
   - Canonical vocabulary list: `MCP_PREFIX`, `COMMAND_PREFIX`, `TASK_TOOL`, `CHAIN`, `SPAWN_AGENT_CALL` (expandable)
   - Walks `skills-src/`, extracts all `{{TOKEN}}` matches, flags unknowns
   - Called as a pre-flight step from `buildAllSkills()`

3. **[REFACTOR]** Share the regex with `src/build-skills.ts` render step.

**Verification:**
- Known tokens pass
- Unknown tokens fail with actionable messages
- Integrated into build pipeline

---

### Task 025: Per-runtime snapshot tests

**Description:** Capture snapshot baselines for all 96 generated SKILL.md files so renderer changes that affect output become visible as PR diffs. Vitest `toMatchSnapshot` enforces drift detection in CI.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** Testing Strategy > Snapshot tests
**Track:** Integration
**Dependencies:** 018
**Parallelizable:** Yes

**TDD Steps:**

1. **[RED]** Write snapshot setup tests:
   - File: `test/migration/snapshots.test.ts`
   - Tests:
     - `Snapshots_AllSkillsAllRuntimes_MatchBaseline`
     - `Snapshots_RegenerationPath_Deterministic`
   - Uses vitest's `toMatchSnapshot` against generated `skills/<runtime>/<skill>/SKILL.md` files.
   - Expected failure: snapshots not yet captured.

2. **[GREEN]** Create snapshots:
   - Run `npm run test:run -- -u` once to seed 96 snapshots
   - Commit snapshot directory
   - CI runs the test without `-u`; any drift causes test failure

3. **[REFACTOR]** Group snapshot assertions by runtime for readability.

**Verification:**
- Snapshots seeded
- CI enforces drift detection
- Renderer changes that affect output are flagged in PR diffs

---

### Task 026: Smoke tests per Tier-1 runtime

**Description:** Add end-to-end smoke tests that execute a dummy feature workflow against each Tier-1 runtime's rendered skill variant. Verifies the substitution produces well-formed skill bodies with expected native syntax. Non-Claude runtimes gated behind `SMOKE=1` env var.

**Phase:** RED → GREEN (REFACTOR optional)
**Test Layer:** acceptance
**Implements:** Testing Strategy > Smoke tests
**Track:** Integration
**Dependencies:** 023, 025
**Parallelizable:** Yes (each runtime independent)

**TDD Steps:**

1. **[RED]** Write smoke test scaffolds:
   - File: `test/smoke/runtime-smoke.test.ts`
   - Tests (one per runtime):
     - `Smoke_Claude_FullWorkflow_CompletesWithGreenGates`
     - `Smoke_OpenCode_FullWorkflow_CompletesWithGreenGates`
     - `Smoke_Codex_FullWorkflow_CompletesWithGreenGates`
     - `Smoke_Copilot_FullWorkflow_CompletesWithGreenGates`
     - `Smoke_Cursor_FullWorkflow_SequentialCompletesWithGreenGates`
   - Each test: runs a dummy feature through ideate → plan → delegate → review → synthesize → cleanup using the rendered variant for that runtime
   - CI gates these tests behind a `SMOKE=1` env var because they require real agent CLIs installed
   - Expected failure: skill variants not yet produced.

2. **[GREEN]** Implement smoke harness:
   - Each test sets up a dummy feature workflow
   - Reads `skills/<runtime>/` and verifies each skill parses + frontmatter valid
   - For runtimes with installed CLIs: executes a minimal delegation loop to confirm the `SPAWN_AGENT_CALL` substitution actually works
   - Cursor test explicitly asserts sequential behavior + single warning emission

3. **[REFACTOR]** Share dummy-feature setup helpers across runtime tests.

**Verification:**
- Tests pass on Claude (baseline runtime with the CLI guaranteed installed in CI)
- Other runtimes gated behind `SMOKE=1` / matrix job conditional
- Cursor sequential path asserts the warning

**Note:** Smoke tests for non-Claude runtimes may require mocked agent CLIs in CI. The point is not to *exercise* every runtime's subagent system — it's to verify the *rendered skill body* is well-formed and contains the expected native syntax. The semantic behavior of each runtime is not this feature's responsibility; the invariant is "the substitution produced what we told it to produce."

---

## Deferred Items

All design Open Questions are addressed in the plan:

- **OQ-1 (Codex delegation syntax):** Resolved by Task 011 recon spike.
- **OQ-2 (Fate of `commands/`):** Resolved by Task 017 — retained as Claude-only shim.
- **OQ-3 (OpenCode install path):** Resolved by Task 012 — default to `~/.config/opencode/skills/` (global); project-scoped flag deferred to a follow-up feature.
- **OQ-4 (Cursor fallback mechanism):** Resolved by Task 014 — sequential-in-session. Parallel `cursor-agent -p` shell-out deferred until user demand arises.
- **OQ-5 (`skills-src/` vs. `src/skills/`):** Resolved by Task 001/015 — top-level `skills-src/`.
- **OQ-6 (Escape hatch for structural divergence):** Task 007 implements override detection (`SKILL.<runtime>.md`), but no skill uses it at migration time. Revisit if any future skill needs it.

**Nothing is deferred out of scope.** The feature delivers full fidelity on all 16 skills × 5 Tier-1 runtimes, with a generic LCD fallback for everything else.

---

## Completion Checklist

- [ ] All tests written before implementation (Iron Law)
- [ ] All 26 tasks completed
- [ ] `npm run build:skills` produces exactly 96 SKILL.md files
- [ ] `git diff --exit-code skills/` is clean after rebuild
- [ ] `exarchos install-skills --agent <runtime>` prints and executes correct command for each Tier-1 runtime
- [ ] No new files under `servers/exarchos-mcp/src/orchestrate/` (DR-5 invariant)
- [ ] `skills-src/delegation/SKILL.md` contains zero Claude-native delegation syntax — only `{{SPAWN_AGENT_CALL}}`
- [ ] Placeholder vocabulary documented at `docs/references/placeholder-vocabulary.md`
- [ ] Runtime notes documented at `docs/references/runtime-notes.md`
- [ ] README install section updated
- [ ] `skills:guard` CI check runs in the pipeline
- [ ] Snapshot tests committed and passing
- [ ] Smoke test for Claude runtime passes in CI; other runtimes gated behind `SMOKE=1`
- [ ] `check_plan_coverage` returns `passed: true`
- [ ] `check_provenance_chain` returns `passed: true` (every DR-1..DR-10 traced)
- [ ] `check_task_decomposition` advisory findings reviewed
- [ ] Code coverage ≥ 80% lines / 70% branches / 100% functions for new code
