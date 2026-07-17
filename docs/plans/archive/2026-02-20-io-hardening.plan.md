# Implementation Plan: I/O Hardening

**Feature ID:** `io-hardening`
**Design:** `docs/designs/2026-02-20-io-hardening.md`
**Date:** 2026-02-20

---

## Task Overview

| Task | Description | Worktree | Deps |
|------|-------------|----------|------|
| 1 | Extract `isPidAlive` to shared utils | A | None |
| 2 | `listStateFiles` return type + corrupt reporting | A | 1 |
| 3 | Orphaned temp file cleanup in `listStateFiles` | A | 1, 2 |
| 4 | Update `listStateFiles` callers (tools.ts, pre-compact, session-start, guard) | A | 2 |
| 5 | `applyDotPath` sparse array bounds guard | B | None |
| 6 | `writeStateFile` CAS corrupt file handling | B | None |
| 7 | `initStateFile` crash safety (temp+link) | B | None |
| 8 | Version manifest sync script | C | None |
| 9 | Version manifest sync integration + fix current drift | C | 8 |
| 10 | Bug #639 verification + audit doc update | C | None |

**Parallelization:** 3 worktrees (A, B, C) can run concurrently.

---

## Task Details

### Task 1: Extract `isPidAlive` to Shared Utils
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `IsPidAlive_CurrentProcess_ReturnsTrue`
   - File: `servers/exarchos-mcp/src/__tests__/utils/process.test.ts`
   - Additional tests:
     - `IsPidAlive_DeadPid_ReturnsFalse` — use a PID like 999999
     - `IsPidAlive_InvalidPid_ReturnsFalse` — PID 0 or negative
   - Expected failure: Module `../../utils/process.js` does not exist

2. **[GREEN]** Create `servers/exarchos-mcp/src/utils/process.ts`
   - Export `isPidAlive(pid: number): boolean` — copy implementation from `event-store/store.ts:41-48`
   - Uses `process.kill(pid, 0)` with try/catch

3. **[REFACTOR]** Update `event-store/store.ts` to import from `../utils/process.js`
   - Remove local `isPidAlive` function (lines 41-48)
   - Add `import { isPidAlive } from '../utils/process.js';`
   - Run `npm run test:run` in MCP server to verify no regressions

**Dependencies:** None
**Parallelizable:** Yes (Worktree A start)

---

### Task 2: `listStateFiles` Return Type + Corrupt Reporting
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts`:
   - `ListStateFiles_CorruptFile_ReportsInCorruptArray` — create 1 valid + 1 corrupt file, verify `result.corrupt` has 1 entry with `featureId`, `stateFile`, and `error` string
   - `ListStateFiles_MixedFiles_SeparatesValidAndCorrupt` — 2 valid + 1 corrupt, verify `result.valid.length === 2` and `result.corrupt.length === 1`
   - `ListStateFiles_AllCorrupt_ReturnsEmptyValidNonEmptyCorrupt` — 2 corrupt files, verify `result.valid.length === 0` and `result.corrupt.length === 2`
   - Expected failure: `result.valid` / `result.corrupt` are undefined (return type is still array)

2. **[RED]** Update existing tests that assert on `listStateFiles` return value:
   - `listStateFiles_CorruptFile_SkipsAndReturnValid` → update assertions from `results` to `results.valid` and add `results.corrupt` checks
   - `listStateFiles_ENOENT_ReturnsEmptyArray` → update to `results.valid` (corrupt array empty since dir doesn't exist)
   - Other tests using `listStateFiles` in same file: update to `.valid`

3. **[GREEN]** Modify `listStateFiles()` in `servers/exarchos-mcp/src/workflow/state-store.ts`:
   - Export new interface `ListStateFilesResult` with `valid` and `corrupt` arrays
   - Change return type from `Promise<Array<...>>` to `Promise<ListStateFilesResult>`
   - In catch block: capture error message, push to `corrupt` array instead of `continue`
   - Return `{ valid: results, corrupt }` (rename `results` to match)

4. **[REFACTOR]** Clean up — ensure `ListStateFilesResult` interface is exported from types if needed

**Dependencies:** Task 1 (shared utils needed for Task 3)
**Parallelizable:** Sequential within Worktree A

---

### Task 3: Orphaned Temp File Cleanup in `listStateFiles`
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts`:
   - `ListStateFiles_OrphanedTmpFromDeadPid_CleansUp` — create `.state.json.tmp.999999` file (dead PID), call `listStateFiles`, verify file is deleted
   - `ListStateFiles_TmpFromLivePid_Preserved` — create `.state.json.tmp.${process.pid}` file (current PID is alive), verify file is NOT deleted
   - `ListStateFiles_InitTmpFromDeadPid_CleansUp` — create `.state.json.init.999999`, verify cleanup
   - `ListStateFiles_NoTmpFiles_NoError` — no temp files present, verify no errors
   - Expected failure: temp files are not cleaned up (no cleanup logic)

2. **[GREEN]** Add cleanup logic to `listStateFiles()` in `state-store.ts`:
   - After `entries = await fs.readdir(stateDir)`, filter for `.tmp.\d+` and `.init.\d+` patterns
   - Extract PID from filename suffix
   - Import `isPidAlive` from `../utils/process.js`
   - If PID is dead: `await fs.unlink(path).catch(() => {})`
   - Cleanup runs BEFORE state file processing (so orphaned files from previous crashes are cleaned before listing)

3. **[REFACTOR]** Extract temp file pattern constant if reused

**Dependencies:** Task 1 (isPidAlive), Task 2 (listStateFiles return type must be settled first)
**Parallelizable:** Sequential within Worktree A

---

### Task 4: Update `listStateFiles` Callers
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Existing tests for callers will fail at compile time due to return type change. Verify:
   - `servers/exarchos-mcp/src/workflow/tools.ts:188` — `handleList()` uses `entries.map(...)` directly
   - `servers/exarchos-mcp/src/cli-commands/pre-compact.ts:88` — `allWorkflows.filter(...)`
   - `servers/exarchos-mcp/src/cli-commands/session-start.ts:532,562` — iterates entries
   - `servers/exarchos-mcp/src/cli-commands/guard.ts:105` — iterates stateFiles
   - Typecheck failure: `map`/`filter` not available on `ListStateFilesResult` object

2. **[GREEN]** Update each caller to use `.valid`:
   - `tools.ts:188` → `const entries = (await listStateFiles(stateDir)).valid;`
   - `pre-compact.ts:88` → `const allWorkflows = (await listStateFiles(stateDir)).valid;`
   - `session-start.ts:532` → `.valid`
   - `session-start.ts:562` → `.valid`
   - `guard.ts:105` → `.valid`

   Add warnings surfacing in `handleList()`:
   ```typescript
   const { valid: entries, corrupt } = await listStateFiles(stateDir);
   // ... existing map logic ...
   return {
     success: true,
     data,
     ...(corrupt.length > 0 && {
       warnings: corrupt.map(c => `Corrupt state file: ${c.featureId} — ${c.error}`),
     }),
   };
   ```

   Add test in `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts`:
   - `HandleList_CorruptFiles_IncludesWarnings` — mock listStateFiles to return corrupt entries, verify warnings field in result

3. **[REFACTOR]** Verify `npm run typecheck` passes across full project

**Dependencies:** Task 2 (new return type)
**Parallelizable:** Sequential within Worktree A

---

### Task 5: `applyDotPath` Sparse Array Bounds Guard
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts`:
   - `ApplyDotPath_SparseArrayIndex_ThrowsInvalidInput` — `applyDotPath({tasks: []}, 'tasks[50].name', 'x')` throws `INVALID_INPUT`
   - `ApplyDotPath_AppendIndex_Succeeds` — `applyDotPath({tasks: ['a','b']}, 'tasks[2]', 'c')` succeeds (index === length, gap 0)
   - `ApplyDotPath_NextGapIndex_Succeeds` — `applyDotPath({tasks: ['a']}, 'tasks[2]', 'c')` succeeds (index === length+1, gap 1)
   - `ApplyDotPath_IntermediateSparseArray_ThrowsInvalidInput` — `applyDotPath({}, 'items[100].name', 'x')` throws (items doesn't exist, auto-created as empty array, index 100 >> length 0)
   - `ApplyDotPath_FinalSparseIndex_ThrowsInvalidInput` — `applyDotPath({items: [1, 2]}, 'items[50]', 99)` throws (final segment index 50 >> length 2)
   - Expected failure: no bounds check, sparse arrays created silently

2. **[GREEN]** Add bounds checking in `applyDotPath()` in `state-store.ts`:
   - Define `const MAX_ARRAY_GAP = 1;` at module level (exported for testability)
   - In the intermediate loop (line 333-345), after verifying `Array.isArray(current)`:
     ```typescript
     if (segment > (current as unknown[]).length + MAX_ARRAY_GAP) {
       throw new StateStoreError(ErrorCode.INVALID_INPUT, `Array index ${segment} exceeds ...`);
     }
     ```
   - In the final segment (line 359-366), same check before `current[lastSegment] = value`:
     ```typescript
     if (lastSegment > (current as unknown[]).length + MAX_ARRAY_GAP) {
       throw new StateStoreError(ErrorCode.INVALID_INPUT, `Array index ${lastSegment} exceeds ...`);
     }
     ```

3. **[REFACTOR]** Extract bounds check into a helper if the logic is duplicated. Verify existing tests still pass (e.g., `tasks[0].name` on empty object should still work — gap = 0+1 = OK for index 0 on length 0).

**Dependencies:** None
**Parallelizable:** Yes (Worktree B)

---

### Task 6: `writeStateFile` CAS Corrupt File Handling
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts`:
   - `WriteStateFile_CorruptExistingFile_ThrowsStateCorrupt` — Write corrupt JSON to state file, call `writeStateFile` with `expectedVersion: 1`, verify throws `STATE_CORRUPT`
   - `WriteStateFile_MissingFile_CASDefaultsToVersion1` — No file exists, call `writeStateFile` with `expectedVersion: 1`, verify succeeds (ENOENT → version 1)
   - `WriteStateFile_ValidFile_CASSucceeds` — Write valid state (version 3), call with `expectedVersion: 3`, verify succeeds
   - `WriteStateFile_ValidFile_CASConflict_ThrowsVersionConflict` — Write valid state (version 3), call with `expectedVersion: 2`, verify throws `VERSION_CONFLICT`
   - Expected failure: corrupt file test passes (defaults to 1 instead of throwing)

2. **[GREEN]** Modify CAS check in `writeStateFile()` (`state-store.ts:201-215`):
   - Split the catch block into error-type-specific handling:
     - `ENOENT` → `currentVersion = 1` (file doesn't exist, correct default)
     - JSON parse error → separate try/catch around `JSON.parse`, throw `StateStoreError(ErrorCode.STATE_CORRUPT, ...)`
     - Other I/O errors → throw `StateStoreError(ErrorCode.FILE_IO_ERROR, ...)`
   - Structure:
     ```typescript
     try {
       const raw = await fs.readFile(stateFile, 'utf-8');
       try {
         const parsed = JSON.parse(raw) as Record<string, unknown>;
         currentVersion = typeof parsed._version === 'number' ? parsed._version : 1;
       } catch {
         throw new StateStoreError(ErrorCode.STATE_CORRUPT,
           `Cannot perform CAS check — state file has invalid JSON: ${stateFile}`);
       }
     } catch (err) {
       if (err instanceof StateStoreError) throw err; // re-throw STATE_CORRUPT
       if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
         currentVersion = 1;
       } else {
         throw new StateStoreError(ErrorCode.FILE_IO_ERROR,
           `Cannot read state file for CAS check: ${stateFile}`);
       }
     }
     ```

3. **[REFACTOR]** Clean up error messages. Ensure existing CAS tests still pass.

**Dependencies:** None
**Parallelizable:** Yes (Worktree B)

---

### Task 7: `initStateFile` Crash Safety (temp+link)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts`:
   - `InitStateFile_Success_NoTempFileRemains` — After successful init, verify no `.init.PID` file exists in stateDir
   - `InitStateFile_ExistingFile_ThrowsAlreadyExists` — Create state file first, attempt init, verify `STATE_ALREADY_EXISTS` (regression test — this already works but mechanism changes)
   - `InitStateFile_SimulatedCrashBeforeLink_OnlyTempExists` — Mock `fs.link` to throw non-EEXIST error, verify temp file cleanup is attempted and state file does NOT exist
   - `InitStateFile_ConcurrentInit_OneSucceedsOneFailsEEXIST` — Init same featureId twice concurrently, verify one succeeds and one throws `STATE_ALREADY_EXISTS`
   - Expected failure: tests reference `.init.PID` temp file pattern, but current code uses `'wx'` flag (no temp file at all)

2. **[GREEN]** Replace `'wx'` write in `initStateFile()` (`state-store.ts:95-113`):
   ```typescript
   const tmpPath = `${stateFile}.init.${process.pid}`;
   await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
   try {
     await fs.link(tmpPath, stateFile);
   } catch (err) {
     if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
       throw new StateStoreError(ErrorCode.STATE_ALREADY_EXISTS,
         `State file already exists: ${stateFile}`);
     }
     throw new StateStoreError(ErrorCode.FILE_IO_ERROR,
       `Failed to create state file: ${stateFile} — ${(err as Error).message}`);
   } finally {
     await fs.unlink(tmpPath).catch(() => {});
   }
   ```

3. **[REFACTOR]** Update the comment above the write section to explain the temp+link pattern. Verify `reconcileFromEvents` still works (it calls `initStateFile` internally).

**Dependencies:** None
**Parallelizable:** Yes (Worktree B)

---

### Task 8: Version Manifest Sync Script
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `scripts/sync-versions.test.sh`
   - Test 1: `SyncVersions_UpdatesPluginJson` — Set plugin.json to "0.0.0", run sync, verify matches package.json
   - Test 2: `SyncVersions_UpdatesMarketplaceJson` — Set marketplace versions to "0.0.0", run sync, verify both locations updated
   - Test 3: `SyncVersions_Idempotent` — Run sync twice, verify same result
   - Script pattern: `set -euo pipefail`, exit codes 0/1/2, uses temp copies to avoid mutating real files
   - Expected failure: `scripts/sync-versions.sh` does not exist

2. **[GREEN]** Create `scripts/sync-versions.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail

   REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
   VERSION=$(node -p "require('${REPO_ROOT}/package.json').version")

   PLUGIN_JSON="${REPO_ROOT}/.claude-plugin/plugin.json"
   MARKETPLACE_JSON="${REPO_ROOT}/.claude-plugin/marketplace.json"

   # Update plugin.json
   jq --arg v "$VERSION" '.version = $v' "$PLUGIN_JSON" > "${PLUGIN_JSON}.tmp"
   mv "${PLUGIN_JSON}.tmp" "$PLUGIN_JSON"

   # Update marketplace.json (plugin version + source version)
   jq --arg v "$VERSION" '
     .plugins[0].version = $v |
     .plugins[0].source.version = $v
   ' "$MARKETPLACE_JSON" > "${MARKETPLACE_JSON}.tmp"
   mv "${MARKETPLACE_JSON}.tmp" "$MARKETPLACE_JSON"

   echo "Synced version ${VERSION} to plugin.json and marketplace.json"
   ```
   - `chmod +x scripts/sync-versions.sh`

3. **[REFACTOR]** Add `--check` flag for CI: exits 1 if versions are out of sync without modifying files

**Dependencies:** None
**Parallelizable:** Yes (Worktree C)

---

### Task 9: Version Sync Integration + Fix Current Drift
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Run `npm run test:run` at root — verify 3 plugin-validation tests fail (version mismatch 2.0.3 vs 2.0.4)

2. **[GREEN]**
   - Run `bash scripts/sync-versions.sh` to fix current version drift
   - Add `"version:sync": "bash scripts/sync-versions.sh"` to `package.json` scripts
   - Add `"prebuild": "npm run version:sync"` to ensure sync runs before every build
   - Run `npm run test:run` at root — verify all 3 plugin-validation tests pass

3. **[REFACTOR]** Verify `npm run build` still works (prebuild hook fires correctly)

**Dependencies:** Task 8
**Parallelizable:** Sequential within Worktree C

---

### Task 10: Bug #639 Verification + Audit Doc Update
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Verify Bug #639:
   - Create a minimal plan file with NO `### Task` headers
   - Run `bash scripts/verify-plan-coverage.sh <design> <plan>` — verify it exits with code 1 and message "No '### Task' headers found" (NOT an unbound variable error)
   - If it fails with unbound variable: the bug still exists, fix it
   - If it exits cleanly with code 1: the bug is already fixed, document as closed

2. **[GREEN]** Update `docs/audits/2026-02-06-testing-gaps.md`:
   - Gap 6: Update status to reflect the new `listStateFiles` corrupt reporting (reference this PR)
   - Gap 7: Mark as **FIXED** — `writeStateFile()` lines 223-232 added Zod `safeParse` before write
   - Gap 8: Update status to reflect the new `applyDotPath` bounds guard (reference this PR)
   - Gap 9: Mark as **FIXED** — `handleNextAction()` uses `readStateFile()` with Zod validation; guard evaluation wrapped in try/catch
   - Update Tier 2 table: Gap 6 and 7 → DONE
   - Update Tier 3 table: Gap 8 and 10 → DONE, Gap 4 → note "CAS versioning added; file locking deferred"

3. **[REFACTOR]** Review audit doc for overall consistency

**Dependencies:** None
**Parallelizable:** Yes (Worktree C)

---

## Worktree Assignment

### Worktree A: `listStateFiles` Hardening (Tasks 1-4)
**Branch:** `feat/io-hardening-list-state-files`
**Sequential chain:** Task 1 → Task 2 → Task 3 → Task 4

Focus: Extract shared utility, change return type, add corrupt reporting, add temp cleanup, update all callers.

### Worktree B: State Store Defensive Validation (Tasks 5-7)
**Branch:** `feat/io-hardening-state-validation`
**All independent:** Tasks 5, 6, 7 can be done in any order

Focus: applyDotPath bounds, CAS corruption detection, initStateFile crash safety.

### Worktree C: Build Correctness + Docs (Tasks 8-10)
**Branch:** `feat/io-hardening-build-docs`
**Chain:** Task 8 → Task 9 (Task 10 independent)

Focus: Version sync script, fix current drift, verify Bug #639, update audit doc.

---

## Verification Criteria

After all tasks complete:

1. `npm run typecheck` — zero errors across full project
2. `npm run test:run` (MCP server) — all existing + new tests pass
3. `npm run test:run` (root) — plugin-validation tests pass (version sync)
4. No `.state.json.tmp.*` or `.state.json.init.*` files left in test dirs
5. Audit doc accurately reflects current codebase state
