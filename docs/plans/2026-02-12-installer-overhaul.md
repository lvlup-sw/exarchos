# Implementation Plan: Installer Overhaul

## Source Design

Link: `docs/designs/2026-02-12-installer-overhaul.md`

## Scope

**Target:** Full design
**Excluded:** None

## Summary

- Total tasks: 25
- Parallel groups: 5 (A-E)
- Estimated test count: ~85
- Design coverage: All sections covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Architecture Overview | Manifest-driven, copy-first, wizard flow | All | Covered |
| Component Manifest > Types | Manifest, CoreComponent, McpServerComponent, PluginComponent, RuleSetComponent interfaces | A1 | Covered |
| Component Manifest > Example | manifest.json file with all current components | E5 | Covered |
| Component Manifest > Loading | Read, validate, extract defaults | A2 | Covered |
| Installation Modes > Standard | Copy files, hash tracking, no symlinks | B1, B2, B3 | Covered |
| Installation Modes > Dev | Symlinks, repo path, self-healing | B4, B5 | Covered |
| ExarchosConfig | Types, read/write, hash storage, selections | A3 | Covered |
| Content Hash Tracking | SHA-256 per file, skip unchanged on re-install | A4, B3 | Covered |
| MCP Server Bundling | Single .js file, bun build, copy to ~/.claude/mcp-servers/ | C4 | Covered |
| MCP Configuration | ~/.claude.json merge, bundled/external/remote entries | C2 | Covered |
| Runtime Detection | Prefer bun, fallback to node | C1 | Covered |
| Interactive Wizard > PromptAdapter | Interface + bun-promptx implementation | D3 | Covered |
| Interactive Wizard > Flow | Mode, servers, plugins, rules, model, confirm | D4 | Covered |
| Interactive Wizard > Non-interactive | --yes (defaults), --config (file) | D5 | Covered |
| Interactive Wizard > Re-install | Show current selections, update detection | D5, A4 | Covered |
| Prerequisite Detection | Check command exists, version, required vs optional | D1, D2 | Covered |
| Settings Generation | Generate from selections, hardcoded permissions, plugins | C3 | Covered |
| Uninstall | Config-driven removal, preserve user files | E4 | Covered |
| Update Detection | Hash comparison, stale file reporting | A4, B3 | Covered |
| Display Formatting | Terminal colors, spinners, status output | D6 | Covered |
| File Structure | New module organization under src/ | All | Covered |
| Build Pipeline | Bun build scripts, prepare hook | E5 | Covered |
| Migration from v1 | Detect symlinks, prompt, remove, copy | E1 | Covered |
| Integration > ~/.claude.json merge | Preserve user MCP servers | C2 | Covered |
| Integration > Worktree .mcp.json | Project-level MCP config | E5 | Covered |
| Testing Strategy | Unit tests per module, integration tests | All (RED phases) | Covered |
| Open Questions > hooks.json | Add as core component | E5 | Covered |

## Task Breakdown

---

### Group A: Foundation

These tasks establish the type system and core utilities that all other groups depend on.

---

### Task A1: Manifest Type Definitions

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `loadManifest_ValidManifest_ReturnsTypedObject`
   - File: `src/manifest/loader.test.ts`
   - Test that a valid manifest JSON string parses to the correct TypeScript types
   - Test that `CoreComponent`, `McpServerComponent`, `PluginComponent`, `RuleSetComponent` fields are all present
   - Expected failure: Module `../manifest/types` does not exist
   - Run: `bun test src/manifest/loader.test.ts` - MUST FAIL

2. [GREEN] Create type definitions
   - File: `src/manifest/types.ts`
   - Define: `Manifest`, `CoreComponent`, `McpServerComponent`, `PluginComponent`, `RuleSetComponent`
   - Define: `ManifestDefaults` with `model` and `mode` fields
   - Run: `bun test src/manifest/loader.test.ts` - MUST PASS

3. [REFACTOR] Extract shared types
   - Ensure `required`, `default` fields use consistent naming
   - Run: `bun test src/manifest/loader.test.ts` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** No (foundation)

---

### Task A2: Manifest Loader and Validation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `loadManifest_ValidFile_ReturnsManifest`
   - `loadManifest_MissingFile_ThrowsError`
   - `loadManifest_InvalidJson_ThrowsError`
   - `loadManifest_MissingRequiredField_ThrowsError`
   - `getDefaultSelections_Manifest_ReturnsDefaults` (extracts default-selected components)
   - `getRequiredComponents_Manifest_ReturnsRequired` (extracts required components)
   - File: `src/manifest/loader.test.ts`
   - Expected failure: Module `../manifest/loader` does not exist
   - Run: `bun test src/manifest/loader.test.ts` - MUST FAIL

2. [GREEN] Implement manifest loader
   - File: `src/manifest/loader.ts`
   - `loadManifest(path: string): Manifest` — reads JSON, validates shape, returns typed object
   - `getDefaultSelections(manifest: Manifest): WizardSelections` — extracts components with `default: true`
   - `getRequiredComponents(manifest: Manifest): { servers: string[]; plugins: string[] }` — extracts required IDs
   - Run: `bun test src/manifest/loader.test.ts` - MUST PASS

3. [REFACTOR] Add descriptive error messages for validation failures
   - Run: `bun test src/manifest/loader.test.ts` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** A1
**Parallelizable:** No (foundation)

---

### Task A3: ExarchosConfig Types and I/O

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `readConfig_ExistingFile_ReturnsConfig`
   - `readConfig_MissingFile_ReturnsNull`
   - `readConfig_InvalidJson_ThrowsError`
   - `writeConfig_ValidConfig_WritesJson`
   - `writeConfig_ValidConfig_PrettyPrints`
   - File: `src/operations/config.test.ts`
   - Expected failure: Module `../operations/config` does not exist
   - Run: `bun test src/operations/config.test.ts` - MUST FAIL

2. [GREEN] Implement config I/O
   - File: `src/operations/config.ts`
   - Define `ExarchosConfig` interface (version, installedAt, mode, repoPath, selections, hashes)
   - Define `WizardSelections` interface (mcpServers, plugins, ruleSets, model)
   - `readConfig(path: string): ExarchosConfig | null`
   - `writeConfig(path: string, config: ExarchosConfig): void`
   - Run: `bun test src/operations/config.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None (independent types)
**Parallelizable:** No (foundation, but can be developed alongside A1/A2)

---

### Task A4: Content Hash Utilities

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `computeFileHash_ExistingFile_ReturnsSha256`
   - `computeFileHash_SameContent_ReturnsSameHash`
   - `computeFileHash_DifferentContent_ReturnsDifferentHash`
   - `computeFileHash_MissingFile_ThrowsError`
   - `computeDirectoryHashes_Directory_ReturnsAllFileHashes`
   - `computeDirectoryHashes_SkipsHiddenFiles_ReturnsOnlyVisible`
   - File: `src/operations/copy.test.ts` (hash utilities co-located with copy)
   - Expected failure: Module `../operations/copy` does not exist
   - Run: `bun test src/operations/copy.test.ts` - MUST FAIL

2. [GREEN] Implement hash utilities
   - File: `src/operations/copy.ts`
   - `computeFileHash(filePath: string): string` — SHA-256 hex digest
   - `computeDirectoryHashes(dirPath: string): Record<string, string>` — recursive, relative paths as keys
   - Run: `bun test src/operations/copy.test.ts` - MUST PASS

3. [REFACTOR] Use Bun's native `Bun.CryptoHasher` for SHA-256 if available
   - Run: `bun test src/operations/copy.test.ts` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** No (foundation)

---

### Group B: File Operations

Copy and symlink operations for standard and dev modes. Can run in parallel with Groups C and D after Group A.

---

### Task B1: Single File Copy with Hash Tracking

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `copyFile_SourceExists_CopiesAndReturnsHash`
   - `copyFile_SourceMissing_ThrowsError`
   - `copyFile_TargetDirMissing_CreatesParentDirs`
   - `copyFile_TargetExists_OverwritesAndReturnsNewHash`
   - File: `src/operations/copy.test.ts`
   - Expected failure: `copyFile` function does not exist
   - Run: `bun test src/operations/copy.test.ts` - MUST FAIL

2. [GREEN] Implement file copy
   - File: `src/operations/copy.ts`
   - `copyFile(source: string, target: string): CopyResult` — copies file, returns `{ hash: string, bytesWritten: number }`
   - Creates parent directories if missing
   - Run: `bun test src/operations/copy.test.ts` - MUST PASS

3. [REFACTOR] Use `Bun.file()` and `Bun.write()` for optimal I/O
   - Run: `bun test src/operations/copy.test.ts` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** A4
**Parallelizable:** Yes (Group B)

---

### Task B2: Directory Copy (Recursive)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `copyDirectory_FlatDir_CopiesAllFiles`
   - `copyDirectory_NestedDir_CopiesRecursively`
   - `copyDirectory_EmptyDir_CreatesEmptyTarget`
   - `copyDirectory_WithFilter_CopiesOnlyMatchingFiles` (for rule set filtering)
   - `copyDirectory_ReturnsHashMap_AllFileHashes`
   - File: `src/operations/copy.test.ts`
   - Expected failure: `copyDirectory` function does not exist
   - Run: `bun test src/operations/copy.test.ts` - MUST FAIL

2. [GREEN] Implement directory copy
   - File: `src/operations/copy.ts`
   - `copyDirectory(source: string, target: string, filter?: (name: string) => boolean): CopyDirectoryResult`
   - Returns `{ hashes: Record<string, string>, fileCount: number, totalBytes: number }`
   - Run: `bun test src/operations/copy.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** B1
**Parallelizable:** Yes (Group B)

---

### Task B3: Idempotent Re-Copy (Skip Unchanged)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `smartCopy_NewFile_CopiesFile`
   - `smartCopy_UnchangedFile_SkipsFile`
   - `smartCopy_ChangedFile_UpdatesFile`
   - `smartCopy_DeletedSource_ReportsRemoval`
   - `smartCopyDirectory_MixedChanges_ReturnsUpdateSummary`
   - File: `src/operations/copy.test.ts`
   - Expected failure: `smartCopy` function does not exist
   - Run: `bun test src/operations/copy.test.ts` - MUST FAIL

2. [GREEN] Implement smart copy
   - File: `src/operations/copy.ts`
   - `smartCopy(source: string, target: string, existingHash?: string): SmartCopyResult`
   - Returns `{ action: 'created' | 'updated' | 'skipped' | 'removed', hash: string }`
   - `smartCopyDirectory(source: string, target: string, existingHashes: Record<string, string>, filter?): SmartCopyDirectoryResult`
   - Returns `{ created: number, updated: number, skipped: number, removed: number, hashes: Record<string, string> }`
   - Run: `bun test src/operations/copy.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** B1, A4
**Parallelizable:** Yes (Group B)

---

### Task B4: Symlink Operations (Dev Mode)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `createSymlink_NoExistingTarget_CreatesLink`
   - `createSymlink_ExistingCorrectLink_Skips`
   - `createSymlink_ExistingWrongLink_Relinks`
   - `createSymlink_ExistingDirectory_BacksUpAndLinks`
   - `removeSymlink_ExistingLink_Removes`
   - `removeSymlink_NotALink_Skips`
   - `removeSymlink_Missing_Skips`
   - File: `src/operations/symlink.test.ts`
   - Expected failure: Module `../operations/symlink` does not exist
   - Run: `bun test src/operations/symlink.test.ts` - MUST FAIL

2. [GREEN] Implement symlink operations (refactored from current `install.ts`)
   - File: `src/operations/symlink.ts`
   - `createSymlink(source: string, target: string): SymlinkResult`
   - `removeSymlink(target: string): RemoveResult`
   - Types: `SymlinkResult = 'created' | 'skipped' | 'backed_up' | 'relinked'`
   - Run: `bun test src/operations/symlink.test.ts` - MUST PASS

3. [REFACTOR] None expected (logic already proven in current installer)

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task B5: Symlink Health Check (Dev Mode Self-Healing)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `validateSymlinks_AllValid_ReturnsHealthy`
   - `validateSymlinks_BrokenLink_ReturnsBroken`
   - `validateSymlinks_MissingLink_ReturnsMissing`
   - `validateSymlinks_MixedState_ReturnsDetailedReport`
   - File: `src/operations/symlink.test.ts`
   - Expected failure: `validateSymlinks` function does not exist
   - Run: `bun test src/operations/symlink.test.ts` - MUST FAIL

2. [GREEN] Implement validation
   - File: `src/operations/symlink.ts`
   - `validateSymlinks(config: ExarchosConfig): SymlinkHealthReport`
   - Returns `{ healthy: string[], broken: string[], missing: string[] }`
   - Checks each expected symlink target exists and points to correct source
   - Run: `bun test src/operations/symlink.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** B4, A3
**Parallelizable:** Yes (Group B)

---

### Group C: Configuration Generation

MCP config, settings, runtime detection, and bundle management. Can run in parallel with Groups B and D after Group A.

---

### Task C1: Runtime Detection

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `detectRuntime_BunAvailable_ReturnsBun`
   - `detectRuntime_OnlyNode_ReturnsNode`
   - `detectRuntime_Neither_ThrowsError`
   - `getVersion_ValidOutput_ParsesVersion`
   - `getVersion_InvalidOutput_ReturnsNull`
   - `meetsMinVersion_AboveMin_ReturnsTrue`
   - `meetsMinVersion_BelowMin_ReturnsFalse`
   - File: `src/wizard/prerequisites.test.ts`
   - Expected failure: Module `../wizard/prerequisites` does not exist
   - Run: `bun test src/wizard/prerequisites.test.ts` - MUST FAIL

2. [GREEN] Implement runtime detection
   - File: `src/wizard/prerequisites.ts`
   - `detectRuntime(): 'bun' | 'node'` — checks `bun --version` first, falls back to `node --version`
   - `getVersion(command: string, args: string[]): string | null` — runs command, parses version
   - `meetsMinVersion(actual: string, minimum: string): boolean` — semver comparison
   - Run: `bun test src/wizard/prerequisites.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Task C2: MCP Config Read/Merge/Write

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `readMcpConfig_ExistingFile_ReturnsConfig`
   - `readMcpConfig_MissingFile_ReturnsEmpty`
   - `mergeMcpServers_NewInstall_AddsAllServers`
   - `mergeMcpServers_ExistingServers_PreservesUserServers`
   - `mergeMcpServers_StaleExarchosEntry_UpdatesEntry`
   - `generateMcpEntry_BundledServer_ReturnsCorrectConfig`
   - `generateMcpEntry_ExternalServer_ReturnsCorrectConfig`
   - `generateMcpEntry_RemoteServer_ReturnsCorrectConfig`
   - `removeMcpServers_ExistingEntries_RemovesOnlyExarchosManaged`
   - File: `src/operations/mcp.test.ts`
   - Expected failure: Module `../operations/mcp` does not exist
   - Run: `bun test src/operations/mcp.test.ts` - MUST FAIL

2. [GREEN] Implement MCP config management
   - File: `src/operations/mcp.ts`
   - `readMcpConfig(path: string): ClaudeConfig`
   - `mergeMcpServers(config: ClaudeConfig, servers: McpServerComponent[], runtime: string, claudeHome: string): ClaudeConfig`
   - `generateMcpEntry(server: McpServerComponent, runtime: string, claudeHome: string): McpServerEntry`
   - `removeMcpServers(config: ClaudeConfig, serverIds: string[]): ClaudeConfig`
   - `writeMcpConfig(path: string, config: ClaudeConfig): void`
   - Run: `bun test src/operations/mcp.test.ts` - MUST PASS

3. [REFACTOR] Extract shared JSON read/write helper
   - Run: `bun test src/operations/mcp.test.ts` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** A1 (McpServerComponent type)
**Parallelizable:** Yes (Group C)

---

### Task C3: Settings.json Generation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `generateSettings_DefaultSelections_IncludesAllPermissions`
   - `generateSettings_OpusModel_SetsModelField`
   - `generateSettings_SonnetModel_SetsModelField`
   - `generateSettings_SelectedPlugins_SetsEnabledPlugins`
   - `generateSettings_NoPlugins_EmptyEnabledPlugins`
   - `generatePermissions_Always_ReturnsComprehensiveList`
   - File: `src/operations/settings.test.ts`
   - Expected failure: Module `../operations/settings` does not exist
   - Run: `bun test src/operations/settings.test.ts` - MUST FAIL

2. [GREEN] Implement settings generation
   - File: `src/operations/settings.ts`
   - `generateSettings(selections: WizardSelections): Settings`
   - `generatePermissions(): string[]` — returns the full hardcoded permission list (from current `settings.json`)
   - Settings interface: `{ permissions: { allow: string[] }, model: string, enabledPlugins: Record<string, boolean> }`
   - Run: `bun test src/operations/settings.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** A3 (WizardSelections type)
**Parallelizable:** Yes (Group C)

---

### Task C4: MCP Server Bundle Copy

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `installBundle_SourceExists_CopiesToMcpServersDir`
   - `installBundle_MissingMcpDir_CreatesDir`
   - `installBundle_ExistingBundle_Overwrites`
   - `installBundle_MissingSource_ThrowsError`
   - `installBundle_ReturnsFileSize_InBytes`
   - File: `src/operations/bundle.test.ts`
   - Expected failure: Module `../operations/bundle` does not exist
   - Run: `bun test src/operations/bundle.test.ts` - MUST FAIL

2. [GREEN] Implement bundle installation
   - File: `src/operations/bundle.ts`
   - `installBundle(bundlePath: string, claudeHome: string): BundleResult`
   - Returns `{ installedPath: string, sizeBytes: number }`
   - Ensures `~/.claude/mcp-servers/` exists
   - Copies bundle file to target
   - Run: `bun test src/operations/bundle.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Group D: Wizard and UX

Interactive wizard, prerequisite detection, and display. Can run in parallel with Groups B and C after Group A.

---

### Task D1: Prerequisite Detection (Single Command)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `checkPrerequisite_CommandExists_ReturnsFound`
   - `checkPrerequisite_CommandMissing_ReturnsNotFound`
   - `checkPrerequisite_WithVersion_IncludesVersion`
   - `checkPrerequisite_BelowMinVersion_ReturnsVersionTooLow`
   - File: `src/wizard/prerequisites.test.ts`
   - Expected failure: `checkPrerequisite` function does not exist
   - Run: `bun test src/wizard/prerequisites.test.ts` - MUST FAIL

2. [GREEN] Implement single prerequisite check
   - File: `src/wizard/prerequisites.ts`
   - `checkPrerequisite(prereq: Prerequisite): PrerequisiteResult`
   - Returns `{ command: string, found: boolean, version?: string, meetsMinVersion: boolean, installHint: string }`
   - Run: `bun test src/wizard/prerequisites.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** C1 (version parsing utilities)
**Parallelizable:** Yes (Group D)

---

### Task D2: Full Prerequisite Suite

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `checkAllPrerequisites_AllPresent_ReturnsAllFound`
   - `checkAllPrerequisites_RequiredMissing_BlocksInstall`
   - `checkAllPrerequisites_OptionalMissing_WarnsButContinues`
   - `checkAllPrerequisites_ReturnsStructuredReport`
   - File: `src/wizard/prerequisites.test.ts`
   - Expected failure: `checkAllPrerequisites` function does not exist
   - Run: `bun test src/wizard/prerequisites.test.ts` - MUST FAIL

2. [GREEN] Implement full prerequisite suite
   - File: `src/wizard/prerequisites.ts`
   - `checkAllPrerequisites(prereqs: Prerequisite[]): PrerequisiteReport`
   - Returns `{ results: PrerequisiteResult[], canProceed: boolean, blockers: string[] }`
   - Define default prerequisites array: bun (required), gt (required), node (optional)
   - Run: `bun test src/wizard/prerequisites.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** D1
**Parallelizable:** Yes (Group D)

---

### Task D3: PromptAdapter Interface and Implementation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `createPromptAdapter_ReturnsAdapter`
   - `MockPromptAdapter_Select_ReturnsPresetValue`
   - `MockPromptAdapter_Multiselect_ReturnsPresetValues`
   - `MockPromptAdapter_Confirm_ReturnsPresetValue`
   - File: `src/wizard/prompts.test.ts`
   - Expected failure: Module `../wizard/prompts` does not exist
   - Run: `bun test src/wizard/prompts.test.ts` - MUST FAIL

2. [GREEN] Implement PromptAdapter
   - File: `src/wizard/prompts.ts`
   - Define `PromptAdapter` interface: `select`, `multiselect`, `confirm`, `text`
   - Define `SelectOption<T>` and `MultiselectOption<T>` types
   - Implement `BunPromptAdapter` using `bun-promptx` (or raw readline fallback)
   - Implement `MockPromptAdapter` for testing (accepts preset responses)
   - Run: `bun test src/wizard/prompts.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group D)

---

### Task D4: Wizard Flow (Interactive Steps)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests (using MockPromptAdapter):
   - `runWizard_StandardMode_ReturnsStandardSelections`
   - `runWizard_DevMode_ReturnsDevSelections`
   - `runWizard_RequiredServersAlwaysIncluded_CannotDeselect`
   - `runWizard_SelectRuleSets_ReturnsSelectedRuleFileList`
   - `runWizard_SelectModel_ReturnsModelId`
   - `runWizard_ExistingConfig_UsesAsDefaults`
   - File: `src/wizard/wizard.test.ts`
   - Expected failure: Module `../wizard/wizard` does not exist
   - Run: `bun test src/wizard/wizard.test.ts` - MUST FAIL

2. [GREEN] Implement wizard flow
   - File: `src/wizard/wizard.ts`
   - `runWizard(manifest: Manifest, prompts: PromptAdapter, existingConfig?: ExarchosConfig): Promise<WizardResult>`
   - `WizardResult = { mode: 'standard' | 'dev', selections: WizardSelections }`
   - Steps: mode → servers → plugins → rules → model → confirm
   - Required servers/plugins cannot be deselected
   - Existing config populates defaults for re-install
   - Run: `bun test src/wizard/wizard.test.ts` - MUST PASS

3. [REFACTOR] Extract step functions for each wizard page
   - Run: `bun test src/wizard/wizard.test.ts` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** A1 (Manifest types), A3 (WizardSelections), D3 (PromptAdapter)
**Parallelizable:** Yes (Group D)

---

### Task D5: Non-Interactive Mode

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `runNonInteractive_YesFlag_UsesDefaults`
   - `runNonInteractive_YesFlagWithExistingConfig_UsesPreviousSelections`
   - `runNonInteractive_ConfigFile_UsesFileSelections`
   - `runNonInteractive_InvalidConfigFile_ThrowsError`
   - File: `src/wizard/wizard.test.ts`
   - Expected failure: `runNonInteractive` function does not exist
   - Run: `bun test src/wizard/wizard.test.ts` - MUST FAIL

2. [GREEN] Implement non-interactive mode
   - File: `src/wizard/wizard.ts`
   - `runNonInteractive(manifest: Manifest, options: { useDefaults?: boolean, configPath?: string, existingConfig?: ExarchosConfig }): WizardResult`
   - `--yes`: uses manifest defaults or existing config selections
   - `--config <path>`: reads selections from provided file
   - Run: `bun test src/wizard/wizard.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** D4, A2
**Parallelizable:** Yes (Group D)

---

### Task D6: Display Formatting Helpers

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `formatHeader_Title_ReturnsFormattedBanner`
   - `formatPrerequisiteReport_AllFound_ReturnsCheckmarks`
   - `formatPrerequisiteReport_MissingRequired_ReturnsErrors`
   - `formatInstallSummary_Results_ReturnsFormattedSummary`
   - `formatProgressLine_Completed_ReturnsCheckmark`
   - `formatProgressLine_Failed_ReturnsCross`
   - File: `src/wizard/display.test.ts`
   - Expected failure: Module `../wizard/display` does not exist
   - Run: `bun test src/wizard/display.test.ts` - MUST FAIL

2. [GREEN] Implement display helpers
   - File: `src/wizard/display.ts`
   - `formatHeader(title: string, version: string): string`
   - `formatPrerequisiteReport(report: PrerequisiteReport): string`
   - `formatInstallSummary(results: InstallResult[]): string`
   - `formatProgressLine(label: string, status: 'done' | 'skip' | 'fail', detail?: string): string`
   - Run: `bun test src/wizard/display.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** D2 (PrerequisiteReport type)
**Parallelizable:** Yes (Group D)

---

### Group E: Integration

Wires all modules together. Depends on Groups A-D.

---

### Task E1: V1 Migration Detection and Execution

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `detectV1Install_SymlinkedSkills_ReturnsTrue`
   - `detectV1Install_CopiedSkills_ReturnsFalse`
   - `detectV1Install_NoSkills_ReturnsFalse`
   - `migrateV1_RemovesSymlinks_ReturnsRemovedPaths`
   - `migrateV1_PreservesNonExarchosFiles_InClaudeDir`
   - `getV1RepoPath_FromSymlink_ReturnsRepoRoot`
   - File: `src/operations/migration.test.ts`
   - Expected failure: Module `../operations/migration` does not exist
   - Run: `bun test src/operations/migration.test.ts` - MUST FAIL

2. [GREEN] Implement migration
   - File: `src/operations/migration.ts`
   - `detectV1Install(claudeHome: string): V1Detection` — checks if `skills/` is a symlink
   - `getV1RepoPath(claudeHome: string): string | null` — reads symlink target to find repo path
   - `migrateV1(claudeHome: string): MigrationResult` — removes Exarchos symlinks, preserves user files
   - Returns `{ removedSymlinks: string[], preservedFiles: string[], repoPath: string | null }`
   - Run: `bun test src/operations/migration.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** B4 (symlink operations)
**Parallelizable:** No (integration)

---

### Task E2: Updated CLI Argument Parsing

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `parseArgs_NoArgs_ReturnsInstallAction`
   - `parseArgs_Uninstall_ReturnsUninstallAction`
   - `parseArgs_Help_ReturnsHelpAction`
   - `parseArgs_Dev_ReturnsDevMode`
   - `parseArgs_Yes_ReturnsNonInteractive`
   - `parseArgs_Config_ReturnsConfigPath`
   - `parseArgs_MultipleFlags_CombinesCorrectly`
   - File: `src/install.test.ts`
   - Expected failure: New `parseArgs` not yet implemented
   - Run: `bun test src/install.test.ts` - MUST FAIL

2. [GREEN] Implement CLI parsing
   - File: `src/install.ts`
   - Extended `ParsedArgs`: add `mode?: 'standard' | 'dev'`, `nonInteractive?: boolean`, `configPath?: string`
   - Flags: `--dev`, `--yes`, `--config <path>`, `--uninstall`, `--help/-h`
   - Run: `bun test src/install.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None (can be done early in Group E)
**Parallelizable:** No (integration)

---

### Task E3: Install Orchestrator (Standard + Dev)

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `install_StandardMode_CopiesAllCoreComponents`
   - `install_StandardMode_CopiesSelectedRuleSets`
   - `install_StandardMode_InstallsMcpBundle`
   - `install_StandardMode_GeneratesSettings`
   - `install_StandardMode_MergesMcpConfig`
   - `install_StandardMode_WritesExarchosConfig`
   - `install_DevMode_CreatesSymlinks`
   - `install_DevMode_PointsMcpToRepo`
   - `install_DevMode_RecordsRepoPath`
   - `install_ReInstall_SkipsUnchangedFiles`
   - `install_V1Migration_MigratesFirst`
   - File: `src/install.test.ts`
   - Expected failure: New `install` function not yet implemented
   - Run: `bun test src/install.test.ts` - MUST FAIL

2. [GREEN] Implement install orchestrator
   - File: `src/install.ts`
   - Rewrites `install()` function to:
     1. Load manifest
     2. Detect prerequisites
     3. Check for v1 migration
     4. Run wizard (or non-interactive)
     5. Copy core components (standard) or create symlinks (dev)
     6. Copy selected rule files
     7. Install MCP bundle (standard) or point to repo (dev)
     8. Generate and write settings.json
     9. Merge MCP config into ~/.claude.json
     10. Write exarchos.config.json
   - Run: `bun test src/install.test.ts` - MUST PASS

3. [REFACTOR] Extract `installStandard()` and `installDev()` sub-functions
   - Run: `bun test src/install.test.ts` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** All Groups A-D, E1, E2
**Parallelizable:** No (integration)

---

### Task E4: Uninstall Orchestrator

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `uninstall_WithConfig_RemovesCopiedContent`
   - `uninstall_WithConfig_RemovesMcpBundle`
   - `uninstall_WithConfig_CleansMcpConfig`
   - `uninstall_WithConfig_RemovesExarchosConfig`
   - `uninstall_PreservesUserFiles_InClaudeDir`
   - `uninstall_NoConfig_GracefulError`
   - `uninstall_DevMode_RemovesSymlinks`
   - File: `src/install.test.ts`
   - Expected failure: New `uninstall` function not yet implemented
   - Run: `bun test src/install.test.ts` - MUST FAIL

2. [GREEN] Implement uninstall
   - File: `src/install.ts`
   - Rewrites `uninstall()` function to:
     1. Read exarchos.config.json (or fail gracefully)
     2. Remove installed content directories/files
     3. Remove MCP server bundle from ~/.claude/mcp-servers/
     4. Remove Exarchos entries from ~/.claude.json
     5. Remove exarchos.config.json
     6. Report what was removed
   - Run: `bun test src/install.test.ts` - MUST PASS

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** A3 (config), C2 (MCP config), B1 (file ops)
**Parallelizable:** No (integration)

---

### Task E5: Build Pipeline and Manifest File

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `manifest_Exists_IsValidJson`
   - `manifest_ContainsAllCoreComponents` (commands, skills, scripts, hooks.json)
   - `manifest_ContainsRequiredServers` (exarchos, graphite)
   - `manifest_ContainsAllPlugins` (github, serena, context7)
   - `manifest_ContainsAllRuleSets` (typescript, csharp, workflow)
   - `manifest_RuleSetFiles_AllExist` (verify every file path in rule sets actually exists)
   - `manifest_Version_MatchesPackageJson`
   - File: `src/manifest/loader.test.ts` (add validation tests)
   - Expected failure: `manifest.json` does not exist
   - Run: `bun test src/manifest/loader.test.ts` - MUST FAIL

2. [GREEN] Create manifest.json and update build pipeline
   - File: `manifest.json` — full component registry matching design spec, including hooks.json as a core file component
   - File: `package.json` — update scripts to use `bun build`, `bun test`
   - File: `.mcp.json` — update to reference `./dist/exarchos-mcp.js` with `bun` command
   - Run: `bun test src/manifest/loader.test.ts` - MUST PASS

3. [REFACTOR] Verify bun build produces working bundles
   - Run full test suite: `bun test` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** A1, A2
**Parallelizable:** No (integration)

---

## Parallelization Strategy

### Execution Order

```
Group A (Foundation) ──────────────────────────────────────────────
  A1 → A2 → A3 → A4  (sequential, ~15 min)
                      │
                      ├── Group B (File Ops) ─────────────────────
                      │   B1 → B2 → B3 (sequential)
                      │   B4 → B5 (sequential)
                      │   (B1-B3 parallel with B4-B5, ~15 min)
                      │
                      ├── Group C (Config) ───────────────────────
                      │   C1, C2, C3, C4 (all parallel, ~12 min)
                      │
                      └── Group D (Wizard) ───────────────────────
                          C1 → D1 → D2 (sequential)
                          D3 → D4 → D5 (sequential)
                          D6 (parallel with D4-D5)
                          (~18 min)
                                        │
                                        └── Group E (Integration)
                                            E1, E2 (parallel)
                                            E3 (after E1, E2)
                                            E4 (after E3)
                                            E5 (parallel with E3)
                                            (~20 min)
```

### Parallel Groups for Worktrees

| Worktree | Tasks | Branch |
|----------|-------|--------|
| Foundation | A1, A2, A3, A4 | `feat/installer-overhaul/foundation` |
| File Operations | B1, B2, B3, B4, B5 | `feat/installer-overhaul/file-ops` |
| Configuration | C1, C2, C3, C4 | `feat/installer-overhaul/config` |
| Wizard | D1, D2, D3, D4, D5, D6 | `feat/installer-overhaul/wizard` |
| Integration | E1, E2, E3, E4, E5 | `feat/installer-overhaul/integration` |

**Stack order:** Foundation → File Ops → Config → Wizard → Integration

**Note:** Group A (Foundation) must complete before Groups B, C, D begin. Groups B, C, D can run in parallel. Group E depends on all others.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Bun test migration for MCP server | MCP server tests remain on Vitest (separate package). Only root installer tests use `bun test`. |
| `bun build --compile` executable | Binary too large (~90MB). Revisit when Bun reduces compiled output size. |
| Team config distribution workflow | `--config` flag provides the mechanism. Documentation and team onboarding guide deferred to a follow-up. |
| Bun bundler for MCP server | Bundle generation requires validating `bun build` with `@modelcontextprotocol/sdk` + `zod`. May need build-time workarounds. Handled during E5 but may need a follow-up if bundling issues arise. |

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass (`bun test`)
- [ ] All 11 source modules created with co-located tests
- [ ] manifest.json validated against actual repo content
- [ ] Standard mode install works end-to-end in temp directory
- [ ] Dev mode install works end-to-end in temp directory
- [ ] Re-install skips unchanged files
- [ ] Uninstall cleanly removes all Exarchos content
- [ ] V1 migration path works
- [ ] Build pipeline produces working bundles
- [ ] Code coverage meets standards
- [ ] Ready for review
