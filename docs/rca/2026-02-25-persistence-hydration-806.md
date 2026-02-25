# RCA: Workflow State Not Persisted — SQLite Hydration Broken (#806)

**Date:** 2026-02-25
**Severity:** P1 — Silent data loss on MCP server restart
**Status:** Investigation complete, fix in progress

## Symptom

Workflow state created at runtime disappears after MCP server restart. Events appended via `exarchos_event` are lost. The `session-provenance-capture` workflow had 18 events and full lifecycle state at runtime but zero artifacts on disk after restart.

## Root Cause Chain

### RC1: State File Write-Through Missing (Critical)

When SQLite backend is configured, `writeStateFile()` delegates entirely to `backend.setState()` and **returns without writing `.state.json`** (state-store.ts:293-331). Similarly, `initStateFile()` writes only to the backend (state-store.ts:130-144).

Meanwhile, `migrateLegacyStateFiles()` renames existing `.state.json` files to `.migrated`, and `cleanupLegacyFiles()` deletes them. This creates a one-way door:

```
Startup:
  .state.json → migrated to SQLite → .state.json deleted

Runtime:
  handleInit/handleSet → backend.setState() → SQLite only
  (no .state.json written)

Next Startup (if SQLite lost/corrupt):
  hydrateAll → events from JSONL ✓
  migrateLegacyStateFiles → no .state.json files to migrate ✗
  → STATE LOST
```

### RC2: JSONL Event Files Not Written for Some Workflows

The `EventStore.append()` calls `writeEvents()` which uses `fs.appendFile()` to write JSONL. However, the event store instance used by `exarchos_event` composite handler shares the same `stateDir`. We confirmed `session-provenance-capture.events.jsonl` does NOT exist on disk, meaning either:

- The write silently failed (permissions, path issue)
- The event store's write-through to JSONL was bypassed
- Events went to an in-memory-only path when the backend handles all storage

The backend dual-write path (store.ts:273-287) catches and **silently logs** backend errors. But the primary JSONL write should always succeed — its absence indicates a deeper issue in the write path.

### RC3: Platform-Specific Native Binary (Major)

`better-sqlite3` requires a C++ compiled `.node` binary. The build script (`scripts/build-mcp.ts`) copies the binary from the dev machine's `node_modules` to `dist/node_modules/better-sqlite3/build/Release/`. This binary is:

- ELF 64-bit x86-64 Linux only
- Incompatible with macOS (Intel or ARM), Windows, or Linux ARM64
- Causes `initializeBackend()` to silently fall back to JSONL-only mode on non-matching platforms

### RC4: Versionless State File Rejection (Minor)

`migrateState()` throws `MIGRATION_FAILED: missing version field` for state files that lack the `version` field. These files were created by older skills/hooks that bypassed the MCP state-store module.

## Impact

1. **Data loss on restart:** Workflows created after SQLite migration have no `.state.json` backup. If SQLite DB is lost, the workflow state is unrecoverable.
2. **Silent degradation:** Non-Linux users run in JSONL-only mode without knowing it. Performance is acceptable but the data path is different.
3. **Orphaned workflows:** State files from older versions fail migration and become invisible.

## Fix Design

### Fix 1: Always Write `.state.json` as Write-Through Backup

Modify `writeStateFile()` and `initStateFile()` to **always write `.state.json` to disk**, even when the backend is configured. SQLite remains the primary read/write path; the file is a crash-recovery backup.

```
writeStateFile(stateFile, state, options):
  1. backend.setState(featureId, state, expectedVersion)  // Primary: SQLite
  2. fs.writeFile(stateFile, JSON.stringify(state))        // Backup: .state.json
  // File write failure is logged but does not fail the operation
```

Stop deleting `.state.json` files after migration — remove the `.migrated` rename from `migrateLegacyStateFiles()` and remove `*.state.json.migrated` from cleanup patterns.

### Fix 2: Verify JSONL Write-Through

Audit the `EventStore.append()` path to ensure `writeEvents()` always executes. Add integration test that verifies `.events.jsonl` exists on disk after `append()`.

### Fix 3: Replace better-sqlite3 with sql.js

Replace `better-sqlite3` (native C++ bindings) with `sql.js` (pure JavaScript/WebAssembly). This eliminates the platform-specific binary entirely while maintaining SQLite semantics.

Trade-off: ~2-3x slower than better-sqlite3 for heavy queries, but exarchos event counts are small (< 1000 per workflow) so the performance difference is negligible.

Alternative: Keep better-sqlite3 but add multi-platform CI builds. Deferred to separate issue if sql.js proves insufficient.

### Fix 4: Handle Versionless State Files

In `migrateState()`, treat missing `version` field as v1.0 instead of throwing. Apply the standard migration path to bring it current.

## Files Involved

| File | Change |
|------|--------|
| `servers/exarchos-mcp/src/workflow/state-store.ts` | Add file write-through after backend.setState |
| `servers/exarchos-mcp/src/storage/migration.ts` | Stop deleting .state.json; handle versionless files |
| `servers/exarchos-mcp/src/workflow/migration.ts` | Treat missing version as v1.0 |
| `servers/exarchos-mcp/package.json` | Replace better-sqlite3 with sql.js |
| `servers/exarchos-mcp/src/storage/sqlite-backend.ts` | Adapt to sql.js API |
| `scripts/build-mcp.ts` | Remove native binary copy; sql.js needs no special handling |
| `servers/exarchos-mcp/src/event-store/store.ts` | Audit JSONL write path |

## Verification

1. After fix: `handleInit` → verify both SQLite row AND `.state.json` exist
2. After fix: `handleSet` → verify `.state.json` updated alongside SQLite
3. After fix: Delete `exarchos.db` → restart → verify state recovered from `.state.json`
4. After fix: Run on macOS → verify SQLite works (sql.js is cross-platform)
5. After fix: Versionless `.state.json` migrates successfully
