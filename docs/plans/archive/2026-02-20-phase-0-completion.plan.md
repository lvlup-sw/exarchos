# Implementation Plan: Phase 0 Completion

**Design:** `docs/designs/2026-02-20-phase-0-completion.md`
**Feature ID:** `phase-0-completion`

---

## Parallelization Strategy

Four independent worktrees can run concurrently:

| Worktree | Tasks | Focus |
|----------|-------|-------|
| **A** | 1–4 | State migration hardening + error taxonomy |
| **B** | 5–7 | Event schema migration + snapshot invalidation |
| **C** | 8–9 | Structured logging (pino) |
| **D** | 10 | Bug fix #639 |

```
Worktree A: [Task 1] → [Task 2] → [Task 3] → [Task 4]
Worktree B:                [Task 5] → [Task 6] → [Task 7]
Worktree C:                       [Task 8] → [Task 9]
Worktree D:                              [Task 10]
```

---

## Tasks

### Task 1: Add EVENT_MIGRATION_FAILED error code
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/errors.test.ts`:
   - `GetErrorCategory_EventMigrationFailed_ReturnsStateLifecycle` — `getErrorCategory('EVENT_MIGRATION_FAILED')` returns `'state-lifecycle'`
   - `GetRecoveryStrategy_EventMigrationFailed_ReturnsGuidance` — `getRecoveryStrategy('EVENT_MIGRATION_FAILED')` returns non-empty string mentioning "schemaVersion"
   - `IsRetryable_EventMigrationFailed_ReturnsFalse` — `isRetryable('EVENT_MIGRATION_FAILED')` returns `false`
   - Expected failure: no `EVENT_MIGRATION_FAILED` key in categoryMap/recoveryMap

2. [GREEN] Implement minimum code:
   - Add `EVENT_MIGRATION_FAILED: 'EVENT_MIGRATION_FAILED'` to `ErrorCode` in `servers/exarchos-mcp/src/workflow/schemas.ts`
   - Add `EVENT_MIGRATION_FAILED: 'state-lifecycle'` to `categoryMap` in `servers/exarchos-mcp/src/errors.ts`
   - Add `EVENT_MIGRATION_FAILED: 'Check event schemaVersion and ensure event migration path exists. Backup events available in .bak files.'` to `recoveryMap` in `servers/exarchos-mcp/src/errors.ts`

3. [REFACTOR] None expected.

**Dependencies:** None
**Parallelizable:** Yes (Worktree A start)

---

### Task 2: Implement backupStateFile() function
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/workflow/migration.test.ts` (new co-located file):
   - `BackupStateFile_ExistingFile_CreatesBackCopy` — Given a state file at path X, calling `backupStateFile(X)` creates `X.bak` with identical content
   - `BackupStateFile_ReturnsBackupPath` — Returns `X.bak` string path
   - `BackupStateFile_MissingFile_ThrowsError` — Throws when source file doesn't exist
   - Expected failure: `backupStateFile` not yet exported from `migration.ts`

2. [GREEN] Add to `servers/exarchos-mcp/src/workflow/migration.ts`:
   ```typescript
   export async function backupStateFile(stateFile: string): Promise<string> {
     const backupPath = `${stateFile}.bak`;
     await fs.copyFile(stateFile, backupPath);
     return backupPath;
   }
   ```
   - Add `import * as fs from 'node:fs/promises';` at top

3. [REFACTOR] None expected.

**Dependencies:** None
**Parallelizable:** Yes (sequential after Task 1 in Worktree A)

---

### Task 3: Add migration metadata tracking
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/workflow/migration.test.ts`:
   - `MigrateState_V1_0ToV1_1_AddsMigrationHistory` — After migrating v1.0 state, `_migrationHistory` array contains one record with `{ from: '1.0', to: '1.1', timestamp: <ISO string> }`
   - `MigrateState_AlreadyCurrent_NoMigrationHistory` — v1.1 state has no `_migrationHistory` added (identity return)
   - Expected failure: `_migrationHistory` not present in migrated state

2. [GREEN] Modify `migrateState()` in `servers/exarchos-mcp/src/workflow/migration.ts`:
   - Track applied migrations in a `MigrationRecord[]` array during the while loop
   - After loop completes, set `current._migrationHistory` to the collected records
   - Each record: `{ from, to, timestamp: new Date().toISOString() }`

3. [REFACTOR] Extract `MigrationRecord` interface as exported type.

**Dependencies:** Task 2 (same file)
**Parallelizable:** No (sequential in Worktree A)

---

### Task 4: Integrate backup into readStateFile()
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/__tests__/workflow/migration.test.ts` (extend existing):
   - `ReadStateFile_V1_0State_CreatesBackupBeforeMigration` — Write a v1.0 JSON state file to temp dir, call `readStateFile()`, verify `.bak` file exists with v1.0 content
   - `ReadStateFile_V1_1State_NoBackupCreated` — Write a v1.1 JSON state file, call `readStateFile()`, verify NO `.bak` file exists
   - Expected failure: no backup created during readStateFile

2. [GREEN] Modify `readStateFile()` in `servers/exarchos-mcp/src/workflow/state-store.ts`:
   - After `JSON.parse(raw)` (line 140), check if `parsed.version !== CURRENT_VERSION`
   - If version differs, call `await backupStateFile(stateFile)` before `migrateState(parsed)`
   - Import `backupStateFile` and `CURRENT_VERSION` from `./migration.js`

3. [REFACTOR] None expected.

**Dependencies:** Task 2, Task 3
**Parallelizable:** No (sequential in Worktree A)

---

### Task 5: Implement event migration registry
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/event-store/event-migration.test.ts` (new file):
   - `MigrateEvent_CurrentVersion_ReturnsIdentity` — Event with `schemaVersion: '1.0'` returns same object reference
   - `MigrateEvent_MissingSchemaVersion_DefaultsTo1_0` — Event without `schemaVersion` field treated as `'1.0'`, returns identity
   - `MigrateEvent_UnknownFutureVersion_ReturnsAsIs` — Event with `schemaVersion: '99.0'` returns as-is (forward compat)
   - `MigrateEvent_ChainMigration_AppliesSequentially` — (preparatory test with mock migration) Verify chain `1.0 → 1.1` applies transform correctly
   - `EVENT_SCHEMA_VERSION_Exported_Is1_0` — Verify constant exported as `'1.0'`
   - Expected failure: module does not exist

2. [GREEN] Create `servers/exarchos-mcp/src/event-store/event-migration.ts`:
   - Export `EVENT_SCHEMA_VERSION = '1.0'`
   - Export `EventMigration` interface with `from`, `to`, `eventTypes`, `migrate`
   - Export empty `eventMigrations` array
   - Export `migrateEvent()` function implementing version chain walk with forward-compat fallback

3. [REFACTOR] None expected.

**Dependencies:** None
**Parallelizable:** Yes (Worktree B start)

---

### Task 6: Integrate event migration into EventStore.query()
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/event-store/store.test.ts` (extend existing):
   - `Query_EventsAtCurrentVersion_ReturnedUnmodified` — Append events at schema version 1.0, query, verify `schemaVersion` field present as `'1.0'`
   - `Query_EventsWithMissingSchemaVersion_DefaultsApplied` — Append event without explicit `schemaVersion`, query, verify event returned with migration applied (identity for 1.0)
   - Expected failure: events returned without migration transform applied (test verifies migration function is called)

2. [GREEN] Modify `query()` in `servers/exarchos-mcp/src/event-store/store.ts`:
   - Import `migrateEvent` from `./event-migration.js`
   - After `const event = JSON.parse(line) as WorkflowEvent;` (line 433), apply: `const migrated = migrateEvent(event as unknown as Record<string, unknown>) as unknown as WorkflowEvent;`
   - Use `migrated` for subsequent filter checks and push to `events` array

3. [REFACTOR] Consider type-safe wrapper to avoid double cast.

**Dependencies:** Task 5
**Parallelizable:** No (sequential in Worktree B)

---

### Task 7: Snapshot version invalidation
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/__tests__/views/snapshot-store.test.ts` (extend existing):
   - `Load_SnapshotWithCurrentSchemaVersion_ReturnsData` — Save snapshot (which now includes `schemaVersion`), load it, verify data returned
   - `Load_SnapshotWithStaleSchemaVersion_ReturnsUndefined` — Manually write snapshot JSON with `schemaVersion: '0.9'`, load it, verify `undefined` returned
   - `Load_SnapshotMissingSchemaVersion_ReturnsUndefined` — Write snapshot JSON without `schemaVersion` field, load, verify `undefined` (treats legacy snapshots as stale)
   - `Save_IncludesSchemaVersion` — Save snapshot, read raw JSON from disk, verify `schemaVersion` field present matching `EVENT_SCHEMA_VERSION`
   - Expected failure: no `schemaVersion` in saved snapshots, load doesn't check version

2. [GREEN] Modify `servers/exarchos-mcp/src/views/snapshot-store.ts`:
   - Import `EVENT_SCHEMA_VERSION` from `../event-store/event-migration.js`
   - Add `schemaVersion: string` to `SnapshotData<T>` interface
   - In `save()`, include `schemaVersion: EVENT_SCHEMA_VERSION` in the saved data object
   - In `load()`, after basic validation, check `data.schemaVersion !== EVENT_SCHEMA_VERSION` → return `undefined`

3. [REFACTOR] None expected.

**Dependencies:** Task 5 (uses `EVENT_SCHEMA_VERSION`)
**Parallelizable:** No (sequential in Worktree B)

---

### Task 8: Create logger factory with pino
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/logger.test.ts` (new file):
   - `Logger_DefaultLevel_IsWarn` — Import logger, verify `logger.level` is `'warn'`
   - `Logger_EnvOverride_RespectsLevel` — Set `EXARCHOS_LOG_LEVEL=debug` in env, re-import, verify level is `'debug'`
   - `StoreLogger_HasSubsystem_EventStore` — Import `storeLogger`, verify it has `{ subsystem: 'event-store' }` bindings
   - `WorkflowLogger_HasSubsystem_Workflow` — Import `workflowLogger`, verify `{ subsystem: 'workflow' }` bindings
   - `ViewLogger_HasSubsystem_Views` — Import `viewLogger`, verify `{ subsystem: 'views' }` bindings
   - `SyncLogger_HasSubsystem_Sync` — Import `syncLogger`, verify `{ subsystem: 'sync' }` bindings
   - Expected failure: module does not exist

2. [GREEN] Install pino and create logger:
   - Run `cd servers/exarchos-mcp && npm install pino && npm install -D @types/pino` (if needed)
   - Create `servers/exarchos-mcp/src/logger.ts` with:
     - Root logger writing to stderr (fd 2) via `pino.destination(2)`
     - `EXARCHOS_LOG_LEVEL` env var support, default `'warn'`
     - Child loggers: `storeLogger`, `workflowLogger`, `viewLogger`, `syncLogger`, `telemetryLogger`

3. [REFACTOR] None expected.

**Dependencies:** None
**Parallelizable:** Yes (Worktree C start)

---

### Task 9: Replace console calls with structured logger
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test in `servers/exarchos-mcp/src/logger.test.ts` (extend):
   - `NoConsoleInProduction_GrepVerification` — This is a meta-test: verify that `console.error` / `console.warn` / `console.log` do not appear in production source files (exclude test files and logger.ts itself). Use a simple string search of the source.
   - Expected failure: 5 console calls still exist

2. [GREEN] Replace console calls across 4 files:
   - `servers/exarchos-mcp/src/index.ts:120` — `console.error('Fatal error:', err)` → `logger.fatal({ err }, 'MCP server fatal error')`; add `import { logger } from './logger.js'`
   - `servers/exarchos-mcp/src/sync/config.ts:33-36` — `console.warn(...)` → `syncLogger.warn({ configPath, errors: result.error.issues }, 'Invalid sync config')`; add `import { syncLogger } from '../logger.js'`
   - `servers/exarchos-mcp/src/sync/config.ts:40` — `console.warn(...)` → `syncLogger.warn({ configPath, err }, 'Config load failed')`
   - `servers/exarchos-mcp/src/event-store/store.ts:277` — `console.error(...)` → `storeLogger.error({ err: err instanceof Error ? err.message : String(err), streamId }, 'Outbox entry failed')`; add `import { storeLogger } from '../logger.js'`
   - `servers/exarchos-mcp/src/views/materializer.ts:131` — `console.error(...)` → `viewLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Snapshot save failed')`; add `import { viewLogger } from '../logger.js'`

3. [REFACTOR] Verify no `console.` calls remain in non-test production source.

**Dependencies:** Task 8
**Parallelizable:** No (sequential in Worktree C)

---

### Task 10: Fix verify-plan-coverage.sh (#639)
**Phase:** RED → GREEN → REFACTOR

1. [RED] Verify the bug exists:
   - Run `bash scripts/verify-plan-coverage.sh` with a valid design+plan pair and confirm the unbound variable error
   - Check `scripts/verify-plan-coverage.test.sh` for existing test coverage of this scenario

2. [GREEN] Fix `scripts/verify-plan-coverage.sh`:
   - Line 142: Change `if [[ ${#PLAN_TASKS[@]} -eq 0 ]]` to `if [[ -z "${PLAN_TASKS+x}" ]] || [[ ${#PLAN_TASKS[@]} -eq 0 ]]`
   - This handles both "array not set" and "array set but empty" under `nounset`

3. [REFACTOR] Check for similar patterns in other validation scripts (`DESIGN_SECTIONS` array, `GAPS` array) and apply same guard if needed.

**Dependencies:** None
**Parallelizable:** Yes (Worktree D, independent)

---

## Summary

| Worktree | Tasks | Est. Complexity |
|----------|-------|-----------------|
| A: State Migration | 1, 2, 3, 4 | Medium — extends existing migration.ts + state-store.ts |
| B: Event Migration | 5, 6, 7 | Medium — new module + store.ts integration + snapshot |
| C: Logging | 8, 9 | Low — install pino, replace 5 calls |
| D: Bug Fix | 10 | Low — single line fix + validation |

**Total: 10 tasks across 4 parallel worktrees**

**New files:** 3 (`event-migration.ts`, `event-migration.test.ts`, `logger.ts`, `logger.test.ts`)
**Modified files:** 8 (`migration.ts`, `state-store.ts`, `store.ts`, `snapshot-store.ts`, `materializer.ts`, `errors.ts`, `schemas.ts`, `index.ts`, `config.ts`, `package.json`, `verify-plan-coverage.sh`)
