# Implementation plan: create-exarchos

**Design:** `docs/designs/2026-03-14-create-exarchos.md`
**Type:** TypeScript (new package)
**Tasks:** 8
**Out of scope:** DR-6 (humanize in axiom) — separate repo, separate workflow

All code lives in `create-exarchos/` at repo root. Tests use vitest. Package has one runtime dep (`@inquirer/prompts`) and Node built-ins.

---

## Task group A: Foundation (sequential)

### Task 1: Package scaffold and shared utilities

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests for shared utilities extracted from companion installer:
   - File: `create-exarchos/src/shared.test.ts`
   - `parseJsonFile_ValidJson_ReturnsParsed`
   - `parseJsonFile_InvalidJson_ReturnsEmpty`
   - `parseJsonFile_MissingFile_ReturnsEmpty`
   - `enablePlugins_NewSettings_WritesPluginEntries`
   - `enablePlugins_ExistingSettings_MergesWithoutOverwrite`
   - `registerMcpServer_NewConfig_WritesServerEntry`
   - `registerMcpServer_ExistingServer_SkipsWithoutOverwrite`

2. [GREEN] Implement:
   - File: `create-exarchos/src/shared.ts`
   - Extract `parseJsonFile`, `enablePlugins`, `registerMcpServer` from `companion/src/install.ts`
   - Generalize to accept paths as parameters (no hardcoded home dir)

3. [GREEN] Create package scaffold:
   - `create-exarchos/package.json` (name: `create-exarchos`, bin: `create-exarchos`)
   - `create-exarchos/tsconfig.json`

**Dependencies:** None
**Parallelizable:** No (foundation for all other tasks)

### Task 2: Environment detection

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - File: `create-exarchos/src/detect.test.ts`
   - `detectEnvironment_ClaudeDirAndBinary_ReturnsClaudeCode`
   - `detectEnvironment_ClaudeDirNoBinary_ReturnsClaudeCode` (plugin dir still works)
   - `detectEnvironment_CursorDirExists_ReturnsCursor`
   - `detectEnvironment_NothingDetected_ReturnsNull`
   - `detectEnvironment_BothExist_PrefersClaudeCode`

2. [GREEN] Implement:
   - File: `create-exarchos/src/detect.ts`
   - Check `~/.claude/` existence, `claude` on PATH (via `which`)
   - Check `.cursor/` in cwd and home
   - Return `'claude-code' | 'cursor' | null`

**Dependencies:** None
**Parallelizable:** Yes (parallel with Task 3)

### Task 3: Companion registry

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - File: `create-exarchos/src/companions.test.ts`
   - `COMPANIONS_AllHaveRequiredFields`
   - `COMPANIONS_DefaultsMatchDesign` (axiom, impeccable, serena, context7 default true; microsoft-learn false)
   - `getCompanionsForEnv_ClaudeCode_FiltersToClaudeCodeInstallable`
   - `getCompanionsForEnv_Cursor_FiltersToCursorInstallable`
   - `getCompanionsForEnv_Generic_FiltersToGenericInstallable`

2. [GREEN] Implement:
   - File: `create-exarchos/src/companions.ts`
   - `Companion` interface and `COMPANIONS` array from design doc
   - `getCompanionsForEnv(env: Environment): Companion[]` — filter to companions that have install config for the given environment

**Dependencies:** None
**Parallelizable:** Yes (parallel with Task 2)

---

## Task group B: Installers (parallel, all depend on Task 1)

### Task 4: Claude Code installer

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - File: `create-exarchos/src/installers/claude-code.test.ts`
   - `installExarchos_ClaudeCode_AddsMarketplaceAndPlugin` (mock execSync)
   - `installCompanion_PluginType_CallsPluginInstall`
   - `installCompanion_McpType_RegistersMcpServer`
   - `installCompanion_SettingsType_EnablesInSettings`

2. [GREEN] Implement:
   - File: `create-exarchos/src/installers/claude-code.ts`
   - `installExarchos()`: run `claude plugin marketplace add` + `claude plugin install`
   - `installCompanion(companion)`: branch on install.claudeCode shape — plugin, mcp, or settings.json enablement
   - Uses `shared.ts` for settings/mcp writes

**Dependencies:** Task 1
**Parallelizable:** Yes

### Task 5: Cursor installer

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - File: `create-exarchos/src/installers/cursor.test.ts`
   - `installExarchos_Cursor_WritesMcpJson`
   - `installCompanion_Skills_CallsNpxSkillsAdd` (mock execSync)
   - `installCompanion_Mcp_WritesMcpJsonEntry`
   - `installExarchos_ExistingMcpJson_MergesWithoutOverwrite`

2. [GREEN] Implement:
   - File: `create-exarchos/src/installers/cursor.ts`
   - `installExarchos()`: write/merge `.cursor/mcp.json` with Exarchos server config
   - `installCompanion(companion)`: branch on install.cursor shape — skills via `npx skills add`, mcp via config merge

**Dependencies:** Task 1
**Parallelizable:** Yes (parallel with Task 4)

### Task 6: Generic MCP and CLI installers

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - File: `create-exarchos/src/installers/generic-mcp.test.ts`
   - `installExarchos_Generic_WritesMcpJson`
   - `installCompanion_Generic_WritesMcpEntry`
   - File: `create-exarchos/src/installers/cli.test.ts`
   - `installExarchos_Cli_RunsNpmInstallGlobal` (mock execSync)

2. [GREEN] Implement:
   - File: `create-exarchos/src/installers/generic-mcp.ts`
   - File: `create-exarchos/src/installers/cli.ts`

**Dependencies:** Task 1
**Parallelizable:** Yes (parallel with Tasks 4, 5)

---

## Task group C: CLI orchestration (depends on groups A + B)

### Task 7: Interactive prompts and CLI entry point

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests for the orchestration logic (prompts mocked):
   - File: `create-exarchos/src/index.test.ts`
   - `run_InteractiveClaudeCode_InstallsExarchosAndSelectedCompanions`
   - `run_YesFlag_SkipsPromptsUsesDefaults`
   - `run_YesFlagWithEnv_UsesSpecifiedEnv`
   - `run_YesFlagWithNoAxiom_ExcludesAxiom`
   - `run_DetectedEnv_PreSelectsInPrompt`

2. [GREEN] Implement:
   - File: `create-exarchos/src/prompts.ts` — `promptEnvironment(detected)`, `promptCompanions(available)`
   - File: `create-exarchos/src/index.ts` — CLI entry point: parse args, detect env, prompt, dispatch to installer
   - Wire `--yes`, `--env`, `--no-<companion>` flags
   - Output: header, progress lines with checkmarks, final "Run /ideate to start"

3. [REFACTOR] Extract arg parsing if complex

**Dependencies:** Tasks 2, 3, 4, 5, 6
**Parallelizable:** No

### Task 8: Deprecation shim for exarchos-dev

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test:
   - File: `companion/src/deprecation.test.ts`
   - `deprecationShim_PrintsWarning_CallsCreateExarchos` (mock execSync)

2. [GREEN] Implement:
   - File: `companion/src/install.ts` — replace CLI entry point with deprecation notice + `npx create-exarchos` passthrough
   - Update `companion/package.json` version to 3.0.0 (breaking: behavior change)

**Dependencies:** Task 7
**Parallelizable:** No

---

## Execution order

```
Task 1 (shared) ──→ Task 4 (claude-code installer)  ─┐
                ├──→ Task 5 (cursor installer)        ├──→ Task 7 (CLI + prompts) ──→ Task 8 (deprecation)
                ├──→ Task 6 (generic + cli installer)  ─┘
Task 2 (detect) ──────────────────────────────────────┘
Task 3 (companions) ─────────────────────────────────┘
```

**Parallel groups:**
- Group 1: Tasks 1, 2, 3 (foundation — 1 is sequential, 2+3 parallel)
- Group 2: Tasks 4, 5, 6 (installers — all parallel, depend on Task 1)
- Group 3: Task 7 (orchestration — depends on all above)
- Group 4: Task 8 (deprecation — depends on Task 7)

## Validation

- All tests pass (`npm run test:run` in create-exarchos/)
- TypeScript strict mode, no `any`
- `npx create-exarchos --yes --env claude-code` completes without error in dry-run mode
- Package builds and `npm pack` produces valid tarball
