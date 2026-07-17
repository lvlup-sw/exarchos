# Design: I/O Hardening — Defensive Validation & Crash Safety

**Feature ID:** `io-hardening`
**Date:** 2026-02-20
**Status:** Draft
**Scope:** MCP server state store reliability + build correctness

---

## Problem Statement

The Exarchos MCP workflow state store has evolved significantly since the Feb 6 testing gaps audit (gaps 1-5 fixed, CAS versioning added, write-time validation added). However, several reliability gaps remain:

1. **Silent data loss** — `listStateFiles()` silently drops corrupt state files, making users unaware their workflow is broken when running `/resume`
2. **Unbounded array creation** — `applyDotPath()` creates sparse arrays of arbitrary length (`tasks[999].name` allocates 1000 slots)
3. **Crash-unsafe file creation** — `initStateFile()` uses `writeFile` with `'wx'` flag, which can leave partially-written files on process crash
4. **CAS masking corruption** — `writeStateFile()` CAS check defaults to version 1 on corrupt files, silently overwriting corruption instead of surfacing it
5. **Orphaned temp files** — `.tmp.PID` files from crashed `writeStateFile()` calls accumulate silently
6. **Version drift** — `plugin.json` and `marketplace.json` versions drift from `package.json`, causing test failures

---

## Design

### Section 1: listStateFiles Corrupt File Reporting (Gap 6)

**Current behavior:** Corrupt files are silently skipped (`catch { continue }`).

**New behavior:** Return both valid and corrupt entries so callers can warn users.

```typescript
// New return type
interface ListStateFilesResult {
  valid: Array<{ featureId: string; stateFile: string; state: WorkflowState }>;
  corrupt: Array<{ featureId: string; stateFile: string; error: string }>;
}
```

**Changes:**
- `listStateFiles()` returns `ListStateFilesResult` instead of the array directly
- Catch block captures the error message and adds to `corrupt` array
- Callers in `workflow/tools.ts` (handleGet with `action: "list"`) surface corrupt files in the tool result as a `warnings` field
- Existing test `listStateFiles_CorruptFile_SkipsAndReturnValid` updated to verify corrupt file metadata

**Backward compatibility:** Callers currently access `results[i]` — they must now use `results.valid[i]`. All callers are internal to the MCP server.

### Section 2: applyDotPath Sparse Array Bounds (Gap 8)

**Current behavior:** `applyDotPath({}, 'tasks[999].name', 'x')` creates a 1000-element sparse array.

**New behavior:** Reject array indices that exceed the current array length by more than a configurable gap (default: 1, allowing append-at-end).

```typescript
const MAX_ARRAY_GAP = 1; // Allow arr[arr.length] (append) but not arr[arr.length + 2+]

// In the array index branch:
if (typeof segment === 'number' && Array.isArray(current)) {
  if (segment > current.length + MAX_ARRAY_GAP) {
    throw new StateStoreError(
      ErrorCode.INVALID_INPUT,
      `Array index ${segment} exceeds length ${current.length} + max gap ${MAX_ARRAY_GAP} in path ${dotPath}`,
    );
  }
}
```

**Same check for the final segment** when setting a value at an array index.

**Rationale:** Workflow state tasks are always appended sequentially (`tasks[0]`, `tasks[1]`, ...). An index like `tasks[50]` on a 3-element array is always a bug. Allowing gap of 1 supports `tasks[tasks.length]` (append).

### Section 3: initStateFile Crash Safety

**Current behavior:** Uses `fs.writeFile(path, data, { flag: 'wx' })`. If the process crashes mid-write, the file exists with partial content. On next read, `readStateFile()` detects corruption, but the file needs manual deletion before `initStateFile()` can succeed again (EEXIST).

**New behavior:** Use temp-file + atomic link for crash safety:

```typescript
const tmpPath = `${stateFile}.init.${process.pid}`;
// 1. Write to temp file (no exclusive flag needed — PID-unique name)
await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
// 2. Atomic link to target (fails with EEXIST if target already exists)
try {
  await fs.link(tmpPath, stateFile);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
    throw new StateStoreError(ErrorCode.STATE_ALREADY_EXISTS, ...);
  }
  throw err;
} finally {
  // 3. Always clean up temp file (link created a second reference)
  await fs.unlink(tmpPath).catch(() => {});
}
```

**Why `link` instead of `rename`:** `rename` would succeed even if the target exists (overwriting it). `link` fails with EEXIST, preserving the exclusive-create semantics of the current `'wx'` approach. On crash before `link()`, only the temp file remains — no corrupt state file, and `initStateFile` can retry cleanly.

**Platform note:** `fs.link()` is POSIX. On Windows (not a target platform for Exarchos), fall back to `'wx'` flag.

### Section 4: CAS Corrupt File Handling

**Current behavior:** In `writeStateFile()`, if the CAS version read fails (corrupt JSON), it catches the error and defaults `currentVersion = 1`:

```typescript
// state-store.ts:208-210
} catch {
  // If file doesn't exist or is unreadable, default to version 1
}
```

This means a corrupt state file silently passes CAS (expected=1, actual=defaulted-1) and gets overwritten.

**New behavior:** Distinguish ENOENT (file doesn't exist — default to 1 is correct) from parse/corruption errors (should throw):

```typescript
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    // File doesn't exist — version 1 is correct for first write
    currentVersion = 1;
  } else {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Cannot perform CAS check — state file is corrupt: ${stateFile}`,
    );
  }
}
```

**Rationale:** If the file exists but has invalid JSON, overwriting it silently masks corruption. The user should be informed so they can investigate (or run `reconcileFromEvents()` to rebuild from the event log).

### Section 5: Orphaned Temp File Cleanup

**Problem:** If `writeStateFile()` crashes after writing the temp file but before `rename()`, orphaned `.tmp.PID` files accumulate in the state directory.

**Solution:** Add cleanup in `listStateFiles()` since it already scans the directory:

```typescript
// In listStateFiles(), after filtering for .state.json:
const tmpFiles = entries.filter((f) => f.match(/\.state\.json\.tmp\.\d+$/) || f.match(/\.state\.json\.init\.\d+$/));
for (const tmpFile of tmpFiles) {
  // Extract PID from filename
  const pid = parseInt(tmpFile.split('.').pop()!, 10);
  if (!isNaN(pid) && !isPidAlive(pid)) {
    // PID is dead — safe to clean up orphaned temp file
    await fs.unlink(path.join(stateDir, tmpFile)).catch(() => {});
  }
}
```

**Helper:** Reuse `isPidAlive()` from event store's PID lock implementation (`event-store/store.ts`). Extract to a shared `utils/process.ts` module.

**Cleanup timing:** Only during `listStateFiles()` (called on `/resume` and workflow listing). Low frequency, minimal overhead.

### Section 6: Version Manifest Auto-Sync

**Problem:** `plugin.json` (version 2.0.3) and `marketplace.json` (version 2.0.3) are out of sync with `package.json` (version 2.0.4). This causes 3 test failures.

**Solution:** Add a `scripts/sync-versions.sh` script that reads the version from `package.json` and updates all manifest files:

```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")

# Update plugin.json
jq --arg v "$VERSION" '.version = $v' .claude-plugin/plugin.json > .claude-plugin/plugin.json.tmp
mv .claude-plugin/plugin.json.tmp .claude-plugin/plugin.json

# Update marketplace.json (two locations)
jq --arg v "$VERSION" '
  .plugins[0].version = $v |
  .plugins[0].source.version = $v
' .claude-plugin/marketplace.json > .claude-plugin/marketplace.json.tmp
mv .claude-plugin/marketplace.json.tmp .claude-plugin/marketplace.json
```

**Integration:** Add to `package.json` as `"version:sync"` script, and call it from the `prebuild` or `prepack` hook to ensure versions are synced before every build/publish.

**Validation:** Add a test in `plugin-validation.test.ts` that reads `package.json` version and asserts all manifests match (likely already exists — the 3 failing tests do exactly this).

### Section 7: Bug #639 Verification & Audit Doc Update

**Bug #639:** `verify-plan-coverage.sh:142` — The unbound variable issue appears already fixed. Line 128 initializes `PLAN_TASKS=()`, and line 142 uses `${PLAN_TASKS+x}` guard. Line 163 uses the double-expansion guard `${PLAN_TASKS[@]+${PLAN_TASKS[@]}}`. Verify by running the script with an empty plan file under `set -euo pipefail` and close the bug.

**Audit doc update:** Update `docs/audits/2026-02-06-testing-gaps.md`:
- Mark Gap 7 as FIXED (write-time Zod validation added in `writeStateFile()`)
- Mark Gap 9 as FIXED (`handleNextAction()` now uses `readStateFile()` with Zod validation; guard evaluation wrapped in try/catch)
- Add note about CAS versioning implementation date
- Update "Open" items in Tier 2/3 tables

---

## Test Plan

### Section 1 Tests (listStateFiles)
- `ListStateFiles_CorruptFile_ReportsInCorruptArray` — verify corrupt file metadata returned
- `ListStateFiles_MixedFiles_SeparatesValidAndCorrupt` — valid and corrupt in same directory
- `ListStateFiles_AllCorrupt_ReturnsEmptyValidNonEmptyCorrupt`
- `HandleGet_ListAction_IncludesCorruptWarnings` — tool handler surfaces warnings

### Section 2 Tests (applyDotPath)
- `ApplyDotPath_SparseArrayIndex_ThrowsInvalidInput` — index far beyond length
- `ApplyDotPath_AppendIndex_Succeeds` — index === length (append)
- `ApplyDotPath_NextIndex_Succeeds` — index === length + 1 (gap of 1)
- `ApplyDotPath_IntermediateSparseArray_ThrowsInvalidInput` — sparse in middle of path

### Section 3 Tests (initStateFile crash safety)
- `InitStateFile_CrashBeforeLink_NoCorruptFile` — simulate crash after temp write
- `InitStateFile_ExistingFile_ThrowsAlreadyExists` — preserve exclusive-create semantics
- `InitStateFile_ConcurrentInit_OneSucceedsOneFailsEEXIST` — race condition handling
- `InitStateFile_CleanupTempOnSuccess` — temp file removed after successful link

### Section 4 Tests (CAS corrupt file)
- `WriteStateFile_CorruptExistingFile_ThrowsStateCorrupt` — CAS check on corrupt JSON
- `WriteStateFile_MissingFile_DefaultsToVersion1` — ENOENT still works correctly
- `WriteStateFile_ValidFile_CASSucceeds` — no regression on happy path

### Section 5 Tests (orphaned temp cleanup)
- `ListStateFiles_OrphanedTmpFromDeadPid_CleansUp` — dead PID temp file removed
- `ListStateFiles_TmpFromLivePid_Preserved` — live PID temp file not deleted
- `ListStateFiles_NoTmpFiles_NoError` — no temp files is fine

### Section 6 Tests (version sync)
- `SyncVersions_UpdatesPluginJson` — script updates version correctly
- `SyncVersions_UpdatesMarketplaceJson` — both locations updated
- `SyncVersions_Idempotent` — running twice produces same result
- Existing `plugin-validation.test.ts` tests pass after sync

### Section 7 Tests (bug #639)
- `VerifyPlanCoverage_EmptyPlanFile_ExitsCleanly` — no unbound variable error

---

## File Impact

| File | Change |
|------|--------|
| `servers/exarchos-mcp/src/workflow/state-store.ts` | Sections 1-5: listStateFiles return type, applyDotPath bounds, initStateFile atomic link, CAS error handling, temp cleanup |
| `servers/exarchos-mcp/src/workflow/tools.ts` | Section 1: Update handleGet list action for new return type |
| `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts` | Sections 1-5: New and updated tests |
| `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts` | Section 1: Update list action test |
| `servers/exarchos-mcp/src/utils/process.ts` | Section 5: Extract `isPidAlive()` from event store |
| `servers/exarchos-mcp/src/event-store/store.ts` | Section 5: Import isPidAlive from shared utils |
| `scripts/sync-versions.sh` | Section 6: New version sync script |
| `scripts/sync-versions.test.sh` | Section 6: Co-located test for sync script |
| `package.json` | Section 6: Add `version:sync` script |
| `.claude-plugin/plugin.json` | Section 6: Version bump to 2.0.4 |
| `.claude-plugin/marketplace.json` | Section 6: Version bump to 2.0.4 |
| `docs/audits/2026-02-06-testing-gaps.md` | Section 7: Mark gaps 7, 9 as fixed |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `fs.link()` not available on all platforms | Exarchos targets Linux/macOS only. Add platform check with `'wx'` fallback for safety. |
| Changing `listStateFiles` return type breaks callers | All callers are internal. Search and update all usages. |
| MAX_ARRAY_GAP=1 too restrictive for future use cases | Make it a constant that can be easily adjusted. Document the rationale. |
| `isPidAlive` extraction from event store creates import dependency | Pure utility function with no state — safe to extract. |

---

## Out of Scope

- **File-level locking** (Gap 4) — Deferred until remote agent protocol is designed
- **Structured logging** (Phase 0) — Independent workstream
- **State migration system** (Phase 0) — Independent workstream
- **reconcileFromEvents double-read optimization** — Lower priority, no correctness issue in single-process
