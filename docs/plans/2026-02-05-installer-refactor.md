# Implementation Plan: Installer Refactor

## Source Brief
Link: `docs/workflow-state/refactor-installer.state.json`

## Scope
**Target:** Full refactor - replace bash installer with Node.js/TypeScript
**Excluded:** Windows support, Plugin marketplace integration, GUI installer

## Summary
- Total tasks: 12
- Parallel groups: 2
- Estimated test count: 18
- Brief coverage: 6/6 goals covered

## Spec Traceability

### Traceability Matrix

| Brief Goal | Key Requirements | Task ID(s) | Status |
|------------|-----------------|------------|--------|
| Replace bash with Node.js/TypeScript | - package.json with bin<br>- TypeScript installer | 001, 002, 003 | Covered |
| npx github:lvlup-sw/lvlup-claude | - bin entry<br>- postinstall hook<br>- shebang | 001, 012 | Covered |
| --uninstall flag | - Remove symlinks<br>- Remove MCP config | 009, 010 | Covered |
| Install both MCP servers | - Build jules<br>- Build workflow-state<br>- Configure ~/.claude.json | 007, 008 | Covered |
| Backup existing files | - Detect existing<br>- Move to .backup | 005, 006 | Covered |
| Cross-platform (macOS, Linux) | - Node.js fs module<br>- path.join for paths | 003, 004, 005, 006 | Covered |

## Task Breakdown

### Task 001: Create root package.json with bin entry

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `packageJson_binEntry_pointsToDistInstall`
   - File: `src/install.test.ts`
   - Expected failure: package.json doesn't exist or has no bin entry
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create package.json with bin configuration
   - File: `package.json`
   - Changes: Add name, version, bin pointing to dist/install.js
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** No (foundation)

---

### Task 002: Create TypeScript project configuration

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `tsconfig_exists_withCorrectSettings`
   - File: `src/install.test.ts`
   - Expected failure: tsconfig.json doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create tsconfig.json for ES modules
   - File: `tsconfig.json`
   - Changes: ES2022 target, NodeNext module, strict mode
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 001
**Parallelizable:** No (foundation)

---

### Task 003: Implement CLI argument parsing

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `parseArgs_noArgs_returnsInstallAction`
   - File: `src/install.test.ts`
   - Expected failure: parseArgs function doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `parseArgs_uninstallFlag_returnsUninstallAction`
   - File: `src/install.test.ts`
   - Expected failure: --uninstall not recognized
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `parseArgs_helpFlag_returnsHelpAction`
   - File: `src/install.test.ts`
   - Expected failure: --help not recognized
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement parseArgs function
   - File: `src/install.ts`
   - Changes: Parse --uninstall, --help flags
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 002
**Parallelizable:** No (core function)

---

### Task 004: Implement path resolution utilities

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `getClaudeHome_returnsHomeDotClaude`
   - File: `src/install.test.ts`
   - Expected failure: getClaudeHome doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `getRepoRoot_returnsParentOfScriptsDir`
   - File: `src/install.test.ts`
   - Expected failure: getRepoRoot doesn't exist
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement path utilities
   - File: `src/install.ts`
   - Changes: getClaudeHome(), getRepoRoot() using os.homedir() and __dirname
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 002
**Parallelizable:** Yes (with 003)

---

### Task 005: Implement symlink creation with backup

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `createSymlink_targetNotExists_createsLink`
   - File: `src/install.test.ts`
   - Expected failure: createSymlink doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `createSymlink_targetIsSymlink_skips`
   - File: `src/install.test.ts`
   - Expected failure: doesn't detect existing symlink
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `createSymlink_targetIsDir_backupsAndCreates`
   - File: `src/install.test.ts`
   - Expected failure: doesn't backup existing directory
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement createSymlink with backup logic
   - File: `src/install.ts`
   - Changes: Check lstat, rename to .backup, create symlink
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 004
**Parallelizable:** No (core function)

---

### Task 006: Implement symlink removal for uninstall

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `removeSymlink_isSymlink_removes`
   - File: `src/install.test.ts`
   - Expected failure: removeSymlink doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `removeSymlink_notSymlink_skips`
   - File: `src/install.test.ts`
   - Expected failure: doesn't preserve non-symlinks
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement removeSymlink
   - File: `src/install.ts`
   - Changes: Check if symlink, unlink if true
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 004
**Parallelizable:** Yes (with 005)

---

### Task 007: Implement MCP server build function

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `buildMcpServer_validPath_runsNpmInstallAndBuild`
   - File: `src/install.test.ts`
   - Expected failure: buildMcpServer doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `buildMcpServer_invalidPath_throwsError`
   - File: `src/install.test.ts`
   - Expected failure: doesn't validate path
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement buildMcpServer using child_process.execSync
   - File: `src/install.ts`
   - Changes: Run npm install && npm run build in server directory
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 004
**Parallelizable:** Yes (with 005, 006)

---

### Task 008: Implement claude.json MCP configuration

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `configureMcpServer_noExistingConfig_createsNew`
   - File: `src/install.test.ts`
   - Expected failure: configureMcpServer doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `configureMcpServer_existingConfig_merges`
   - File: `src/install.test.ts`
   - Expected failure: doesn't merge with existing
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `configureMcpServer_addsJulesAndWorkflowState`
   - File: `src/install.test.ts`
   - Expected failure: doesn't add both servers
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement configureMcpServer with JSON manipulation
   - File: `src/install.ts`
   - Changes: Read/write ~/.claude.json, add mcpServers entries
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 004, 007
**Parallelizable:** No (depends on 007)

---

### Task 009: Implement MCP configuration removal for uninstall

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `removeMcpConfig_existingConfig_removesServers`
   - File: `src/install.test.ts`
   - Expected failure: removeMcpConfig doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `removeMcpConfig_noConfig_noOp`
   - File: `src/install.test.ts`
   - Expected failure: throws on missing file
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement removeMcpConfig
   - File: `src/install.ts`
   - Changes: Remove jules and workflow-state from mcpServers
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 008
**Parallelizable:** No (builds on 008)

---

### Task 010: Implement main install function

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `install_createsAllSymlinks`
   - File: `src/install.test.ts`
   - Expected failure: install function doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `install_buildsMcpServers`
   - File: `src/install.test.ts`
   - Expected failure: doesn't call buildMcpServer
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `install_configuresMcpServers`
   - File: `src/install.test.ts`
   - Expected failure: doesn't call configureMcpServer
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement install orchestrator function
   - File: `src/install.ts`
   - Changes: Call createSymlink for each dir, buildMcpServer, configureMcpServer
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 005, 007, 008
**Parallelizable:** No (integration)

---

### Task 011: Implement main uninstall function

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `uninstall_removesAllSymlinks`
   - File: `src/install.test.ts`
   - Expected failure: uninstall function doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `uninstall_removesMcpConfig`
   - File: `src/install.test.ts`
   - Expected failure: doesn't call removeMcpConfig
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement uninstall orchestrator function
   - File: `src/install.ts`
   - Changes: Call removeSymlink for each dir, removeMcpConfig
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 006, 009
**Parallelizable:** No (integration)

---

### Task 012: Implement CLI entry point with main()

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `main_noArgs_callsInstall`
   - File: `src/install.test.ts`
   - Expected failure: main doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `main_uninstallArg_callsUninstall`
   - File: `src/install.test.ts`
   - Expected failure: doesn't route to uninstall
   - Run: `npm run test:run` - MUST FAIL

3. [RED] Write test: `main_helpArg_printsUsage`
   - File: `src/install.test.ts`
   - Expected failure: doesn't handle --help
   - Run: `npm run test:run` - MUST FAIL

4. [GREEN] Implement main() with CLI routing
   - File: `src/install.ts`
   - Changes: Parse args, call install/uninstall/printHelp, add shebang
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 003, 010, 011
**Parallelizable:** No (final integration)

---

## Parallelization Strategy

### Sequential Chain A (Foundation → Symlinks)
```text
001 → 002 → 004 → 005 → 010
                ↘ 006 → 011
```

### Sequential Chain B (Foundation → MCP)
```text
001 → 002 → 004 → 007 → 008 → 009
```

### Sequential Chain C (CLI)
```text
001 → 002 → 003 → 012
```

### Parallel Groups

After Task 002 completes, these can run in parallel:
- **Worktree 1:** Tasks 003 (CLI parsing)
- **Worktree 2:** Tasks 004, 005, 006 (path utils + symlinks)
- **Worktree 3:** Tasks 007 (MCP build)

After those complete:
- **Worktree 1:** Task 008, 009 (MCP config)
- **Worktree 2:** Task 010, 011 (orchestrators)

Final:
- **Main:** Task 012 (integration)

## Deferred Items

| Item | Rationale |
|------|-----------|
| Windows support | Out of scope per brief |
| Plugin marketplace | Out of scope per brief |
| Interactive prompts | Not in requirements, backup is automatic |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All 18 tests pass
- [ ] Code coverage meets standards
- [ ] npx github:lvlup-sw/lvlup-claude works
- [ ] npx github:lvlup-sw/lvlup-claude --uninstall works
- [ ] README.md updated
- [ ] Ready for review
