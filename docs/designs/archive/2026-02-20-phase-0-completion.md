# Design: Phase 0 Completion — State Migration Hardening + Structured Logging

## Problem Statement

Phase 0 (Foundation Hardening, #347) is ~65% complete. Four of six items are done: verification infrastructure (eval framework), structured error taxonomy (#650), configuration schema validation (#651), and multi-tenant event schema fields (#649). Two items remain:

1. **State file versioned migration system** — The existing `migration.ts` handles state file migration (1.0 → 1.1) but has no event schema migration, no backup safety, and no user-facing tooling. Public users will have production event streams — schema changes must be backward-compatible with automated migration paths.

2. **Structured logging** — The MCP server has 5 ad-hoc `console.error`/`console.warn` calls in production code. There's no structured logging, no log levels, no subsystem tagging. The productization assessment rates this as "High for production" severity.

Additionally, bug #639 (`verify-plan-coverage.sh` unbound variable) should be fixed as part of this work.

### Relationship to Existing Work

| Component | Status | This Design |
|---|---|---|
| State migration (`migration.ts`) | Partial — 1.0→1.1 chain only | Generalize + add event migration + backup |
| Error taxonomy (`errors.ts`) | Complete (#650) | Add `EVENT_MIGRATION_FAILED` error code |
| Event store (`store.ts`) | Complete | Add event schema transform on query |
| Zod config validation | Complete (#651) | No changes |
| Multi-tenant fields | Complete (#649) | No changes |
| Phase 1 (CLI & Docs, #348) | Blocked on Phase 0 | Unblocked by this work |

---

## Chosen Approach

**Pragmatic extension of existing patterns.** Generalize the migration chain, add event-level schema transforms, add pino for structured stderr logging. No new architectural patterns — extend what exists.

---

## Technical Design

### 1. State Migration Hardening

#### 1a. Backup-Before-Migrate

Before applying any migration, copy the current state file to `{featureId}.state.json.bak`. This provides a manual rollback path if migration produces unexpected results.

**Location:** `servers/exarchos-mcp/src/workflow/migration.ts`

```typescript
export async function backupStateFile(stateFile: string): Promise<string> {
  const backupPath = `${stateFile}.bak`;
  await fs.copyFile(stateFile, backupPath);
  return backupPath;
}
```

Called from `readStateFile()` in `state-store.ts` before `migrateState()` — only when version differs from `CURRENT_VERSION`.

#### 1b. Migration Metadata

After a successful migration, record what happened in the state's `_migrationHistory` array:

```typescript
interface MigrationRecord {
  from: string;
  to: string;
  timestamp: string;
  backupPath: string;
}
```

This provides an audit trail without requiring event store access (migration runs before events are available).

#### 1c. Error Taxonomy Extension

Add `EVENT_MIGRATION_FAILED` to `errors.ts`:

```typescript
// In categoryMap:
EVENT_MIGRATION_FAILED: 'state-lifecycle',

// In recoveryMap:
EVENT_MIGRATION_FAILED: 'Check event schemaVersion and ensure event migration path exists. Backup events available in .bak files.',

// Not retryable (same as MIGRATION_FAILED)
```

### 2. Event Schema Migration

#### 2a. Event Migration Registry

Events already carry a `schemaVersion` field (default `"1.0"`). Create a parallel migration system for events, applied lazily during `eventStore.query()`.

**Location:** `servers/exarchos-mcp/src/event-store/event-migration.ts`

```typescript
export const EVENT_SCHEMA_VERSION = '1.0';

interface EventMigration {
  readonly from: string;
  readonly to: string;
  readonly eventTypes: readonly string[] | 'all';
  migrate: (event: Record<string, unknown>) => Record<string, unknown>;
}

const eventMigrations: readonly EventMigration[] = [
  // Future migrations go here. Example:
  // {
  //   from: '1.0', to: '1.1',
  //   eventTypes: ['task.completed'],
  //   migrate: (e) => ({
  //     ...e,
  //     schemaVersion: '1.1',
  //     data: { ...e.data, duration: (e.data as any)?.durationMs ?? 0 },
  //   }),
  // },
];

export function migrateEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const version = (raw.schemaVersion as string) ?? '1.0';
  if (version === EVENT_SCHEMA_VERSION) return raw;

  let current = { ...raw };
  let currentVersion = version;

  while (currentVersion !== EVENT_SCHEMA_VERSION) {
    const migration = eventMigrations.find(
      (m) => m.from === currentVersion &&
        (m.eventTypes === 'all' || m.eventTypes.includes(current.type as string))
    );
    if (!migration) {
      // No migration path — return as-is with warning logged
      // (forward compatibility: old code reads new events by ignoring unknown fields)
      return current;
    }
    current = migration.migrate(current);
    currentVersion = migration.to;
  }

  return current;
}
```

#### 2b. Integration with EventStore.query()

In `store.ts`, apply `migrateEvent()` to each event during the readline parse phase of `query()`. This is zero-cost for events at current version (identity return) and transparent to callers.

```typescript
// In query(), after JSON.parse:
const migrated = migrateEvent(parsed);
```

#### 2c. View Snapshot Invalidation

When `EVENT_SCHEMA_VERSION` changes, existing view snapshots may be stale (computed from old event shapes). Add a `schemaVersion` field to snapshot metadata. On load, compare against current version — if mismatched, discard snapshot and replay from scratch.

**Location:** `servers/exarchos-mcp/src/views/snapshot-store.ts`

```typescript
interface SnapshotEnvelope<T> {
  view: T;
  highWaterMark: number;
  savedAt: string;
  schemaVersion: string;  // NEW — tracks event schema version at snapshot time
}
```

On `load()`, if `envelope.schemaVersion !== EVENT_SCHEMA_VERSION`, return `undefined` (triggers full replay).

### 3. Structured Logging (pino)

#### 3a. Dependencies

Add `pino` as a runtime dependency of the MCP server:

```bash
cd servers/exarchos-mcp && npm install pino
```

Pino is ideal: JSON output by default, writes to configurable destination (stderr), near-zero overhead when disabled, child logger pattern for subsystem tagging.

#### 3b. Logger Factory

**Location:** `servers/exarchos-mcp/src/logger.ts`

```typescript
import pino from 'pino';

const level = process.env.EXARCHOS_LOG_LEVEL ?? 'warn';

export const logger = pino({
  level,
  transport: undefined,  // Raw JSON — no pretty printing in production
}, pino.destination(2));  // fd 2 = stderr (safe for MCP stdio transport)

// Child loggers for subsystems
export const storeLogger = logger.child({ subsystem: 'event-store' });
export const workflowLogger = logger.child({ subsystem: 'workflow' });
export const viewLogger = logger.child({ subsystem: 'views' });
export const syncLogger = logger.child({ subsystem: 'sync' });
export const telemetryLogger = logger.child({ subsystem: 'telemetry' });
```

**Key constraint:** MCP protocol uses stdout for JSON-RPC. All logging MUST go to stderr (fd 2). Pino's `pino.destination(2)` guarantees this.

**Log levels:** `fatal`, `error`, `warn`, `info`, `debug`, `trace`. Default `warn` keeps production output minimal. Set `EXARCHOS_LOG_LEVEL=debug` for development.

#### 3c. Replace Console Calls

Replace all 5 production `console.error`/`console.warn` calls:

| File | Current | Replacement |
|---|---|---|
| `index.ts:120` | `console.error('Fatal error:', err)` | `logger.fatal({ err }, 'MCP server fatal error')` |
| `sync/config.ts:33-34` | `console.warn('Invalid config...')` | `syncLogger.warn({ configPath, errors }, 'Invalid sync config')` |
| `sync/config.ts:40` | `console.warn('Failed to load config...')` | `syncLogger.warn({ configPath, err }, 'Config load failed')` |
| `event-store/store.ts:277` | `console.error('Outbox entry failed...')` | `storeLogger.error({ err, streamId }, 'Outbox entry failed')` |
| `views/materializer.ts:131` | `console.error('Failed to save snapshot...')` | `viewLogger.error({ err, viewName }, 'Snapshot save failed')` |

#### 3d. Structured Fields

All log entries include:
- `level` — numeric pino level
- `time` — epoch milliseconds
- `subsystem` — which component (`event-store`, `workflow`, `views`, `sync`, `telemetry`)
- `msg` — human-readable message
- Context-specific fields: `streamId`, `featureId`, `err`, `configPath`, etc.

### 4. Bug Fix: verify-plan-coverage.sh (#639)

The script uses `set -euo pipefail`. Under `nounset`, `${#PLAN_TASKS[@]}` on line 142 fails if the array was declared but never populated (bash version-dependent). The array reference on line 163 already uses the `${PLAN_TASKS[@]+${PLAN_TASKS[@]}}` guard pattern.

**Fix:** Apply the same guard pattern to the length check:

```bash
# Line 142: Before
if [[ ${#PLAN_TASKS[@]} -eq 0 ]]; then

# After
if [[ ${#PLAN_TASKS[@]+${#PLAN_TASKS[@]}} -eq 0 ]]; then
```

Or equivalently, use explicit initialization check:

```bash
if [[ -z "${PLAN_TASKS+x}" ]] || [[ ${#PLAN_TASKS[@]} -eq 0 ]]; then
```

---

## File Inventory

### New Files
| File | Purpose |
|---|---|
| `servers/exarchos-mcp/src/event-store/event-migration.ts` | Event schema migration registry and transform |
| `servers/exarchos-mcp/src/event-store/event-migration.test.ts` | Tests for event migration |
| `servers/exarchos-mcp/src/logger.ts` | Pino logger factory with subsystem children |
| `servers/exarchos-mcp/src/logger.test.ts` | Tests for logger factory |

### Modified Files
| File | Changes |
|---|---|
| `servers/exarchos-mcp/src/workflow/migration.ts` | Add backup-before-migrate, migration metadata |
| `servers/exarchos-mcp/src/workflow/migration.test.ts` | Tests for backup + metadata |
| `servers/exarchos-mcp/src/workflow/state-store.ts` | Call backup before migration |
| `servers/exarchos-mcp/src/event-store/store.ts` | Apply event migration in query(), replace console.error |
| `servers/exarchos-mcp/src/event-store/store.test.ts` | Test event migration integration |
| `servers/exarchos-mcp/src/views/snapshot-store.ts` | Add schemaVersion to snapshots, invalidate on mismatch |
| `servers/exarchos-mcp/src/views/snapshot-store.test.ts` | Test version-aware snapshots |
| `servers/exarchos-mcp/src/views/materializer.ts` | Replace console.error with viewLogger |
| `servers/exarchos-mcp/src/errors.ts` | Add EVENT_MIGRATION_FAILED |
| `servers/exarchos-mcp/src/sync/config.ts` | Replace console.warn with syncLogger |
| `servers/exarchos-mcp/src/index.ts` | Replace console.error with logger.fatal |
| `servers/exarchos-mcp/package.json` | Add pino dependency |
| `scripts/verify-plan-coverage.sh` | Fix unbound PLAN_TASKS variable (#639) |

---

## Testing Strategy

### Unit Tests
- **Migration backup:** Verify `.bak` file created, contains original content, only created when version differs
- **Migration metadata:** Verify `_migrationHistory` array populated after migration
- **Event migration:** Test chain application, no-op for current version, forward-compat (unknown version returns as-is)
- **Snapshot invalidation:** Verify stale snapshot discarded when schemaVersion mismatches
- **Logger factory:** Verify writes to stderr (fd 2), respects `EXARCHOS_LOG_LEVEL`, child loggers include subsystem

### Integration Tests
- **State read with migration:** Round-trip a v1.0 state file through readStateFile(), verify migration + backup + metadata
- **Event query with migration:** Append events at old schema version, query and verify transformed output
- **Snapshot version lifecycle:** Save snapshot, bump EVENT_SCHEMA_VERSION, verify snapshot discarded on next load

### Validation Script
- **verify-plan-coverage.sh:** Test with empty design (no sections), empty plan (no tasks), and valid pair

---

## Exit Criteria

- [ ] All existing tests pass (`npm run test:run`)
- [ ] State migration creates `.bak` backup before transforming
- [ ] Event migration applies lazily during query (zero-cost for current version)
- [ ] View snapshots invalidated on schema version change
- [ ] All `console.error`/`console.warn` replaced with pino structured logging
- [ ] Logger writes to stderr only (stdout clean for MCP JSON-RPC)
- [ ] Bug #639 fixed (verify-plan-coverage.sh handles empty arrays)
- [ ] Phase 0 issue #347 can be closed
- [ ] Phase 1 #348 unblocked

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Pino adds ~150KB to bundle | Low — MCP server already bundles sdk+zod | Acceptable for structured logging value |
| Event migration in query() hot path | Medium — per-event overhead | Identity return for current version; no allocation unless version differs |
| Backup files accumulate | Low — one per workflow per migration | Document cleanup; `.bak` files are small (<5KB) |
| Forward-compat: old code reads new events | Medium — unknown fields silently dropped | Zod `.passthrough()` on event parsing; new fields always optional |
