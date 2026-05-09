import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock the state-store module to spy on configureStateStoreBackend
vi.mock('../workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

// Mock the register module to spy on registerCustomWorkflows
vi.mock('../config/register.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/register.js')>();
  return {
    ...original,
    registerCustomWorkflows: vi.fn(),
  };
});

describe('initializeContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('InitializeContext_CreatesEventStore_ConfiguresModules', async () => {
    // Arrange
    const { initializeContext } = await import('./context.js');

    // Act
    const ctx = await initializeContext(tmpDir);

    // Assert
    expect(ctx.stateDir).toBe(tmpDir);
    expect(ctx.eventStore).toBeDefined();
    expect(ctx.eventStore.dir).toBe(tmpDir);
    expect(typeof ctx.enableTelemetry).toBe('boolean');
  });

  it('InitializeContext_WithBackend_PassesBackendToEventStore', async () => {
    // Arrange
    const { initializeContext } = await import('./context.js');
    const { InMemoryBackend } = await import('../storage/memory-backend.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    // Act
    const ctx = await initializeContext(tmpDir, { backend });

    // Assert
    expect(ctx.stateDir).toBe(tmpDir);
    expect(ctx.eventStore).toBeDefined();
  });

  // ─── T16 (DR-2) — storage handle threaded through DispatchContext ───────
  //
  // The lifecycle/startup path opens the storage handle once (SQLite or
  // in-memory) and the constructed `DispatchContext` carries that
  // handle on `ctx.storage`. Same instance — not a wrapper, not a
  // freshly-constructed view. Consumers downstream of dispatch can
  // then route raw access through the abstraction without reaching
  // for an ambient `bun:sqlite` import (T17).
  it('Lifecycle_Start_ConstructsStorageAndPassesViaContext', async () => {
    const { initializeContext } = await import('./context.js');
    const { InMemoryBackend } = await import('../storage/memory-backend.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    const ctx = await initializeContext(tmpDir, { backend });

    // Single source of truth: the very same instance the caller
    // (lifecycle / `index.ts`) opened is what `DispatchContext.storage`
    // references. If it were re-constructed inside `initializeContext`
    // the WAL/busy_timeout pragmas + connection state would diverge
    // from `EventStore`'s view.
    expect(ctx.storage).toBeDefined();
    expect(ctx.storage).toBe(backend);
  });

  // Without an injected backend, `storage` stays undefined — JSONL-only
  // mode. Pinned so a later refactor that silently fabricates an
  // in-memory backend doesn't mask a missing `initializeBackend()` call
  // upstream in `index.ts`.
  it('Lifecycle_Start_NoBackend_StorageUndefined', async () => {
    const { initializeContext } = await import('./context.js');

    const ctx = await initializeContext(tmpDir);

    expect(ctx.storage).toBeUndefined();
  });

  it('InitializeContext_ConfiguresStateStoreBackend', async () => {
    // Arrange
    const { initializeContext } = await import('./context.js');
    const { configureStateStoreBackend } = await import('../workflow/state-store.js');

    // Act
    await initializeContext(tmpDir);

    // Assert — configureStateStoreBackend should have been called
    expect(configureStateStoreBackend).toHaveBeenCalled();
  });

  it('InitializeContext_NoProjectRoot_ConfigUndefined', async () => {
    // Arrange
    const { initializeContext } = await import('./context.js');

    // Act
    const ctx = await initializeContext(tmpDir);

    // Assert
    expect(ctx.config).toBeUndefined();
  });

  // T051 / DR-14 — every dispatch context carries a capability resolver so
  // composite tools that emit cache-control hints (currently rehydrate
  // only) can decide whether the runtime understands the hint shape. The
  // default reports `anthropic_native_caching`, with an env kill switch
  // for runtimes observed mishandling the field.
  it('InitializeContext_DefaultResolver_ReportsAnthropicNativeCaching', async () => {
    const prior = process.env.EXARCHOS_DISABLE_CACHE_HINTS;
    delete process.env.EXARCHOS_DISABLE_CACHE_HINTS;
    try {
      const { initializeContext } = await import('./context.js');
      const ctx = await initializeContext(tmpDir);
      expect(ctx.capabilityResolver).toBeDefined();
      expect(ctx.capabilityResolver!.has('anthropic_native_caching')).toBe(true);
      // Other capability strings are NOT reported — the resolver is a
      // closed allowlist, not a wildcard.
      expect(ctx.capabilityResolver!.has('made_up_capability')).toBe(false);
    } finally {
      if (prior === undefined) {
        delete process.env.EXARCHOS_DISABLE_CACHE_HINTS;
      } else {
        process.env.EXARCHOS_DISABLE_CACHE_HINTS = prior;
      }
    }
  });

  it('InitializeContext_DisableCacheHintsEnv_ResolverReportsNothing', async () => {
    const prior = process.env.EXARCHOS_DISABLE_CACHE_HINTS;
    process.env.EXARCHOS_DISABLE_CACHE_HINTS = '1';
    try {
      const { initializeContext } = await import('./context.js');
      const ctx = await initializeContext(tmpDir);
      expect(ctx.capabilityResolver).toBeDefined();
      // Empty resolver — `applyCacheHints` becomes a no-op and the
      // `_cacheHints` field is omitted from response envelopes.
      expect(ctx.capabilityResolver!.has('anthropic_native_caching')).toBe(false);
      expect(ctx.capabilityResolver!.list()).toEqual([]);
    } finally {
      if (prior === undefined) {
        delete process.env.EXARCHOS_DISABLE_CACHE_HINTS;
      } else {
        process.env.EXARCHOS_DISABLE_CACHE_HINTS = prior;
      }
    }
  });

  it('InitializeContext_WithProjectRoot_LoadsConfig', async () => {
    // Arrange
    const { initializeContext } = await import('./context.js');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // Create a config file in a separate project root dir
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-proj-'));
    await writeFile(
      join(projectRoot, 'exarchos.config.js'),
      `export default {
        workflows: {
          deploy: {
            phases: ['build', 'ship'],
            initialPhase: 'build',
            transitions: [{ from: 'build', to: 'ship', event: 'done' }],
          },
        },
      };`,
    );

    // Act
    const ctx = await initializeContext(tmpDir, { projectRoot });

    // Assert
    expect(ctx.config).toBeDefined();
    expect(ctx.config?.workflows?.deploy).toBeDefined();
    expect(ctx.config?.workflows?.deploy.phases).toEqual(['build', 'ship']);

    // Cleanup
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('InitializeContext_WithProjectRootNoConfig_ConfigEmpty', async () => {
    // Arrange
    const { initializeContext } = await import('./context.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-empty-'));

    // Act — projectRoot has no config file
    const ctx = await initializeContext(tmpDir, { projectRoot });

    // Assert — loadConfig returns {} which is truthy, but has no workflows
    expect(ctx.config).toEqual({});

    // Cleanup
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('InitializeContext_WithConfigWorkflows_CallsRegisterCustomWorkflows', async () => {
    // Arrange
    const { initializeContext } = await import('./context.js');
    const { registerCustomWorkflows } = await import('../config/register.js');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-reg-'));
    await writeFile(
      join(projectRoot, 'exarchos.config.js'),
      `export default {
        workflows: {
          pipeline: {
            phases: ['start', 'end'],
            initialPhase: 'start',
            transitions: [{ from: 'start', to: 'end', event: 'done' }],
          },
        },
      };`,
    );

    // Act
    await initializeContext(tmpDir, { projectRoot });

    // Assert
    expect(registerCustomWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({
        workflows: expect.objectContaining({
          pipeline: expect.objectContaining({ phases: ['start', 'end'] }),
        }),
      }),
    );

    // Cleanup
    await fs.rm(projectRoot, { recursive: true, force: true });
  });
});

describe('initializeContext — projectConfig (YAML)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-yaml-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('initializeContext_WithProjectRoot_LoadsProjectConfig', async () => {
    const { initializeContext } = await import('./context.js');

    // Create a temp dir with .exarchos.yml
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-yaml-'));
    await fs.writeFile(
      path.join(projectRoot, '.exarchos.yml'),
      `review:\n  dimensions:\n    D3: warning\nvcs:\n  provider: gitlab\n`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.projectConfig).toBeDefined();
      // D3 overridden to warning
      expect(ctx.projectConfig!.review.dimensions.D3.severity).toBe('warning');
      // D1 retains default
      expect(ctx.projectConfig!.review.dimensions.D1.severity).toBe('blocking');
      // VCS overridden
      expect(ctx.projectConfig!.vcs.provider).toBe('gitlab');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('initializeContext_NoYml_ProjectConfigIsDefaults', async () => {
    const { initializeContext } = await import('./context.js');

    // Create empty project root (no .exarchos.yml)
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-noml-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.projectConfig).toBeDefined();
      // All defaults
      expect(ctx.projectConfig!.review.dimensions.D1.severity).toBe('blocking');
      expect(ctx.projectConfig!.vcs.provider).toBe('github');
      expect(ctx.projectConfig!.workflow.maxFixCycles).toBe(3);
      expect(ctx.projectConfig!.tools.commitStyle).toBe('conventional');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('initializeContext_ProjectConfigBeforeExarchosConfig', async () => {
    const { initializeContext } = await import('./context.js');

    // Create a project root with both YAML config and JS config
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-order-'));
    await fs.writeFile(
      path.join(projectRoot, '.exarchos.yml'),
      `tools:\n  commit-style: freeform\n`,
    );
    await fs.writeFile(
      path.join(projectRoot, 'exarchos.config.js'),
      `export default { workflows: { test: { phases: ['a'], initialPhase: 'a', transitions: [] } } };`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      // YAML config loaded
      expect(ctx.projectConfig).toBeDefined();
      expect(ctx.projectConfig!.tools.commitStyle).toBe('freeform');
      // JS config also loaded
      expect(ctx.config).toBeDefined();
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('dispatch_ProjectConfig_PassedToHandlers', async () => {
    const { initializeContext } = await import('./context.js');
    const { COMPOSITE_HANDLERS, dispatch } = await import('./dispatch.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-dispatch-'));
    await fs.writeFile(
      path.join(projectRoot, '.exarchos.yml'),
      `vcs:\n  provider: azure-devops\n`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      // Verify projectConfig is on the context
      expect(ctx.projectConfig).toBeDefined();
      expect(ctx.projectConfig!.vcs.provider).toBe('azure-devops');

      // Verify the context can be passed to dispatch
      let receivedCtx: unknown;
      const spy = async (_args: Record<string, unknown>, c: typeof ctx) => {
        receivedCtx = c;
        return { success: true as const, data: { ok: true } };
      };
      const original = (COMPOSITE_HANDLERS as Record<string, unknown>)['exarchos_workflow'];
      (COMPOSITE_HANDLERS as Record<string, unknown>)['exarchos_workflow'] = spy;

      try {
        // DR-5: dispatch now validates the action name and per-action
        // schema before routing to the composite handler. `describe` is
        // one of the few workflow actions whose schema accepts an empty
        // args payload — perfect for this wiring smoke test, which only
        // cares that `ctx` reaches the (stubbed) handler.
        await dispatch('exarchos_workflow', { action: 'describe' }, ctx);
        const capturedCtx = receivedCtx as typeof ctx;
        expect(capturedCtx.projectConfig).toBeDefined();
        expect(capturedCtx.projectConfig!.vcs.provider).toBe('azure-devops');
      } finally {
        (COMPOSITE_HANDLERS as Record<string, unknown>)['exarchos_workflow'] = original;
      }
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  // ─── Fix 1: VcsProvider wiring (R4) ──────────────────────────────────────

  it('initializeContext_WithProjectRoot_VcsProviderAvailable', async () => {
    const { initializeContext } = await import('./context.js');

    // Create empty project root (defaults to GitHub)
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-vcs-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      // VcsProvider should be created and default to GitHub
      expect(ctx.vcsProvider).toBeDefined();
      expect(ctx.vcsProvider!.name).toBe('github');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('initializeContext_WithGitLabConfig_VcsProviderIsGitLab', async () => {
    const { initializeContext } = await import('./context.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-vcs-gl-'));
    await fs.writeFile(
      path.join(projectRoot, '.exarchos.yml'),
      `vcs:\n  provider: gitlab\n`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.vcsProvider).toBeDefined();
      expect(ctx.vcsProvider!.name).toBe('gitlab');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('initializeContext_NoProjectRoot_VcsProviderUndefined', async () => {
    const { initializeContext } = await import('./context.js');

    const ctx = await initializeContext(tmpDir);

    // Without projectRoot, there's no projectConfig, so no vcsProvider
    expect(ctx.vcsProvider).toBeUndefined();
  });

  // ─── Fix 4: HookRunner wiring (R7) ──────────────────────────────────────

  it('initializeContext_WithProjectRoot_HookRunnerAvailable', async () => {
    const { initializeContext } = await import('./context.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-hook-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      // HookRunner should be created
      expect(ctx.hookRunner).toBeDefined();
      expect(typeof ctx.hookRunner).toBe('function');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('initializeContext_NoProjectRoot_HookRunnerUndefined', async () => {
    const { initializeContext } = await import('./context.js');

    const ctx = await initializeContext(tmpDir);

    expect(ctx.hookRunner).toBeUndefined();
  });
});

// ─── T57 — Migration runs at lifecycle start (DR-8 AC1) ───────────────────────
//
// Closes DR-8 AC1: the design specifies "migration runs at lifecycle start
// when SQLite database has no rows in `schema_version` matching SCHEMA_VERSION
// 3". The runner primitives (T19–T22) and cross-process lock (T60) are in
// place; T57 is the wiring that fires the migration during
// `initializeContext` so it completes BEFORE any tool dispatch can run an
// AtomicAppender.append on the substrate.
//
// File-location decision: this test lives in `context.test.ts` (alongside
// `context.ts`) rather than `lifecycle.test.ts`. Rationale:
//   - The plan refers to a `lifecycle.ts` startup hook that does not exist —
//     `lifecycle.ts` is exclusively retention/compaction policy.
//   - The actual startup hook is `initializeContext()` in `context.ts`.
//   - Co-located test convention: `foo.test.ts` next to `foo.ts`.
//   - Adding a startup-wiring case to `lifecycle.test.ts` (774 lines, all
//     compaction) would be a category violation — startup wiring is not
//     lifecycle policy.
describe('initializeContext — migration runs at startup (T57, DR-8 AC1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-mig-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('Context_InitializeWithLegacyJsonl_TriggersMigrationBeforeFirstAppend', async () => {
    const { initializeContext } = await import('./context.js');
    const { SqliteBackend } = await import('../storage/sqlite-backend.js');
    const { randomUUID } = await import('node:crypto');

    // ─── Fixture: pre-seed two `<streamId>.events.jsonl` files ─────────────
    // The bytes mirror what runJsonlToSqliteMigration's importer expects:
    // one JSON object per line, with `type`, `timestamp`, and per-event
    // `data`. We use stable timestamps so the test does not race the wall
    // clock for ordering assertions.
    const streamAlpha = 'stream-alpha';
    const streamBeta = 'stream-beta';
    const alphaSeedCount = 4;
    const betaSeedCount = 3;

    const alphaLines: string[] = [];
    for (let i = 1; i <= alphaSeedCount; i++) {
      alphaLines.push(
        JSON.stringify({
          streamId: streamAlpha,
          sequence: i,
          type: i === alphaSeedCount ? 'task.completed' : 'task.assigned',
          timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          eventId: randomUUID(),
          data: { i, label: `alpha-${i}` },
        }),
      );
    }
    await fs.writeFile(
      path.join(tmpDir, `${streamAlpha}.events.jsonl`),
      alphaLines.join('\n') + '\n',
      'utf-8',
    );

    const betaLines: string[] = [];
    for (let i = 1; i <= betaSeedCount; i++) {
      betaLines.push(
        JSON.stringify({
          streamId: streamBeta,
          sequence: i,
          type: i === betaSeedCount ? 'task.completed' : 'task.assigned',
          timestamp: new Date(2026, 0, 1, 0, 1, i).toISOString(),
          eventId: randomUUID(),
          data: { i, label: `beta-${i}` },
        }),
      );
    }
    await fs.writeFile(
      path.join(tmpDir, `${streamBeta}.events.jsonl`),
      betaLines.join('\n') + '\n',
      'utf-8',
    );

    // ─── Open a SqliteBackend (the host's responsibility, mirrors
    //     `initializeBackend` in `index.ts`) ────────────────────────────────
    const dbPath = path.join(tmpDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // ─── Act: initializeContext should fire migration as a side effect ──
      const ctx = await initializeContext(tmpDir, { backend });
      expect(ctx.eventStore).toBeDefined();
      expect(ctx.storage).toBe(backend);

      // ─── Assertion 1: schema_version === 3 ─────────────────────────────
      // The SqliteBackend's initialize() ledgers SCHEMA_VERSION=3 directly,
      // so this is essentially a sanity-check that the substrate boundary
      // is intact post-migration. The DR-8 AC1 sentinel is the lock-state +
      // archive-side-effect contract, not the schema_version row itself.
      const lockDb = (
        backend as unknown as {
          _migrationLockDb: {
            prepare: (sql: string) => {
              all: () => Array<{ version: number }>;
              get: () => unknown;
            };
          };
        }
      )._migrationLockDb;
      const versionRows = lockDb
        .prepare('SELECT version FROM schema_version ORDER BY version DESC')
        .all();
      expect(versionRows.length).toBeGreaterThan(0);
      expect(versionRows[0].version).toBe(3);

      // ─── Assertion 2: legacy events imported (queryable on original IDs) ─
      const alphaEvents = backend.queryEvents(streamAlpha);
      expect(alphaEvents).toHaveLength(alphaSeedCount);
      // Per-stream-monotonic sequence preserved.
      for (let i = 1; i < alphaEvents.length; i++) {
        expect(alphaEvents[i].sequence).toBeGreaterThan(alphaEvents[i - 1].sequence);
      }
      expect(alphaEvents[alphaSeedCount - 1].type).toBe('task.completed');
      // Data round-tripped.
      for (let i = 0; i < alphaEvents.length; i++) {
        const d = alphaEvents[i].data as { i: number; label: string };
        expect(d.i).toBe(i + 1);
        expect(d.label).toBe(`alpha-${i + 1}`);
      }

      const betaEvents = backend.queryEvents(streamBeta);
      expect(betaEvents).toHaveLength(betaSeedCount);
      expect(betaEvents[betaSeedCount - 1].type).toBe('task.completed');

      // ─── Assertion 3: source files MOVED to .archive-v210/<basename> ────
      const archiveDir = path.join(tmpDir, '.archive-v210');
      const archiveStat = await fs.stat(archiveDir).catch(() => null);
      expect(archiveStat).not.toBeNull();
      expect(archiveStat?.isDirectory()).toBe(true);
      const archived = (await fs.readdir(archiveDir)).sort();
      expect(archived).toEqual(
        [`${streamAlpha}.events.jsonl`, `${streamBeta}.events.jsonl`].sort(),
      );
      // Originals removed from stateDir.
      const stateEntries = await fs.readdir(tmpDir);
      const remainingJsonl = stateEntries.filter((e) => e.endsWith('.events.jsonl'));
      expect(remainingJsonl).toEqual([]);

      // ─── Assertion 4: migration events emitted on __migration__ stream ──
      const migEvents = backend.queryEvents('__migration__');
      const importedEvents = migEvents.filter(
        (e) => e.type === 'migration.legacy_jsonl_imported',
      );
      const completedEvents = migEvents.filter((e) => e.type === 'migration.completed');
      expect(importedEvents).toHaveLength(2);
      expect(completedEvents).toHaveLength(1);
      // Per-file imported events carry { sourcePath, eventCount, durationMs }.
      for (const e of importedEvents) {
        const d = e.data as { sourcePath: string; eventCount: number; durationMs: number };
        expect(typeof d.sourcePath).toBe('string');
        expect(typeof d.eventCount).toBe('number');
        expect(d.eventCount).toBeGreaterThan(0);
        expect(typeof d.durationMs).toBe('number');
      }
      const completedData = completedEvents[0].data as {
        filesImported: number;
        eventsImported: number;
        totalDurationMs: number;
      };
      expect(completedData.filesImported).toBe(2);
      expect(completedData.eventsImported).toBe(alphaSeedCount + betaSeedCount);

      // ─── Assertion 6 (ordering): runtime append AFTER initializeContext
      //     gets per-stream sequence STRICTLY GREATER than migrated max ────
      // We exercise the canonical write substrate by constructing a fresh
      // SQLite-backed AtomicAppender (the same body the production
      // EventStore uses when `appenderBackend: 'sqlite'`). The new event
      // landing on `stream-alpha` MUST take sequence = max(migrated)+1 if
      // and only if the migration completed before this append fired.
      const { AtomicAppender } = await import('../event-store/atomic-appender.js');
      const runtimeAppender = new AtomicAppender({
        stateDir: tmpDir,
        backend: 'sqlite',
        sqliteBackend: backend,
      });
      const appendResult = await runtimeAppender.appendUnkeyed(streamAlpha, [
        { type: 'task.assigned', data: { runtime: true } },
      ]);
      expect(appendResult.ok).toBe(true);
      if (!appendResult.ok) return;

      const alphaAfter = backend.queryEvents(streamAlpha);
      expect(alphaAfter).toHaveLength(alphaSeedCount + 1);
      const newEvent = alphaAfter[alphaAfter.length - 1];
      const maxMigratedAlphaSeq = Math.max(...alphaEvents.map((e) => e.sequence));
      expect(newEvent.sequence).toBeGreaterThan(maxMigratedAlphaSeq);
      // The `migration.completed` event on __migration__ stream MUST also
      // have been written before this runtime append — assert via timestamp
      // ordering since cross-stream sequences are independent in SQLite.
      const completedTs = new Date(completedEvents[0].timestamp).getTime();
      const newEventTs = new Date(newEvent.timestamp).getTime();
      expect(newEventTs).toBeGreaterThanOrEqual(completedTs);
    } finally {
      backend.close();
    }
  });

  it('Context_InitializeTwiceOnSameStateDir_IsNoOp_NoNewMigrationEvents', async () => {
    const { initializeContext } = await import('./context.js');
    const { SqliteBackend } = await import('../storage/sqlite-backend.js');
    const { randomUUID } = await import('node:crypto');

    // ─── Fixture: one legacy JSONL file ────────────────────────────────────
    const streamId = 'stream-idempotent';
    const lines: string[] = [];
    for (let i = 1; i <= 3; i++) {
      lines.push(
        JSON.stringify({
          streamId,
          sequence: i,
          type: 'task.assigned',
          timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          eventId: randomUUID(),
          data: { i },
        }),
      );
    }
    await fs.writeFile(
      path.join(tmpDir, `${streamId}.events.jsonl`),
      lines.join('\n') + '\n',
      'utf-8',
    );

    // ─── First initializeContext: runs migration ──────────────────────────
    const dbPath = path.join(tmpDir, 'exarchos.db');
    const backend1 = new SqliteBackend(dbPath);
    backend1.initialize();

    try {
      await initializeContext(tmpDir, { backend: backend1 });

      const migEventsAfterFirst = backend1.queryEvents('__migration__');
      const importedAfterFirst = migEventsAfterFirst.filter(
        (e) => e.type === 'migration.legacy_jsonl_imported',
      );
      const completedAfterFirst = migEventsAfterFirst.filter(
        (e) => e.type === 'migration.completed',
      );
      expect(importedAfterFirst).toHaveLength(1);
      expect(completedAfterFirst).toHaveLength(1);
    } finally {
      backend1.close();
    }

    // ─── Second initializeContext: should be a no-op ───────────────────────
    // Open a fresh handle on the same db file. schema_version === 3 is
    // already recorded; no `*.events.jsonl` files remain in stateDir.
    // runMigrationIfNeeded must short-circuit and NOT emit new events.
    const backend2 = new SqliteBackend(dbPath);
    backend2.initialize();

    try {
      const migEventsBeforeSecond = backend2.queryEvents('__migration__');
      await initializeContext(tmpDir, { backend: backend2 });
      const migEventsAfterSecond = backend2.queryEvents('__migration__');

      // Strict idempotency: event count is unchanged across the second
      // initializeContext call. No new migration.completed,
      // no new migration.legacy_jsonl_imported, no churn on the lock.
      expect(migEventsAfterSecond).toHaveLength(migEventsBeforeSecond.length);
      const importedAfterSecond = migEventsAfterSecond.filter(
        (e) => e.type === 'migration.legacy_jsonl_imported',
      );
      const completedAfterSecond = migEventsAfterSecond.filter(
        (e) => e.type === 'migration.completed',
      );
      expect(importedAfterSecond).toHaveLength(1);
      expect(completedAfterSecond).toHaveLength(1);
    } finally {
      backend2.close();
    }
  });

  it('Context_InitializeWithoutBackend_NoMigrationAttempted', async () => {
    // Without a SQLite backend (JSONL-only mode), runMigrationIfNeeded must
    // be a graceful no-op. This pins the JSONL-only fallback path so a
    // future refactor that calls migration unconditionally would fail here.
    const { initializeContext } = await import('./context.js');

    // Pre-seed a JSONL file that COULD be migrated, but the absence of a
    // SqliteBackend means we skip migration entirely.
    await fs.writeFile(
      path.join(tmpDir, 'stream-x.events.jsonl'),
      JSON.stringify({
        streamId: 'stream-x',
        sequence: 1,
        type: 'task.assigned',
        timestamp: new Date(2026, 0, 1).toISOString(),
        eventId: 'evt-1',
      }) + '\n',
      'utf-8',
    );

    const ctx = await initializeContext(tmpDir);
    expect(ctx.storage).toBeUndefined();

    // The JSONL file must still be present — no migration attempted.
    const entries = await fs.readdir(tmpDir);
    expect(entries).toContain('stream-x.events.jsonl');
    // No archive directory created.
    const archiveExists = await fs
      .stat(path.join(tmpDir, '.archive-v210'))
      .then(() => true)
      .catch(() => false);
    expect(archiveExists).toBe(false);
  });
});

// ─── T58 — Topology loader wired at lifecycle start (DR-7) ────────────────────
//
// Closes DR-7 startup-wiring gap: the design specifies the typed loader is
// "called once at lifecycle start" and emits `phase.contract_missing` per
// missing-contract phase "once at startup". T44 implemented the loader and
// T47 implemented the emission inside it; this case asserts the wiring on
// `initializeContext()` actually fires the once-per-startup-per-process
// emission semantics.
//
// File-location decision: same rationale as T57 — `lifecycle.ts` exists but
// is exclusively retention/compaction; the actual startup hook is
// `initializeContext` in `core/context.ts`. Co-locate the test here with
// `context.ts`.
describe('initializeContext — topology loader wired at startup (T58, DR-7)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-topo-'));
    vi.clearAllMocks();
    // Reset the module-level topology cache between tests so each case
    // starts in a "topology not loaded" state. Without this, the second
    // test in the file would observe the cached topology from the first
    // test and the once-per-startup-per-process semantics would be
    // unobservable (it would look as though the second startup never
    // emitted, but actually the FIRST test already populated the cache).
    const { __resetTopologyCacheForTesting } = await import('../topology/loader.js');
    __resetTopologyCacheForTesting();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    const { __resetTopologyCacheForTesting } = await import('../topology/loader.js');
    __resetTopologyCacheForTesting();
  });

  // The PARTIAL_TOPOLOGY fixture mirrors `topology/loader.test.ts:115` —
  // 2 phases declare a `staleness` block (`design`, `implement`), 3 do not
  // (`review`, `merge`, `cleanup`). The loader walks `phases` and emits
  // `phase.contract_missing` once per phase missing the contract.
  const PARTIAL_TOPOLOGY = `
phases:
  design:
    staleness:
      expectedMaxDwellMinutes: 60
      freshnessRequires: all
      signals:
        - name: lastActivity
          thresholdMinutes: 60
  implement:
    staleness:
      expectedMaxDwellMinutes: 120
      freshnessRequires: any
      signals:
        - name: lastActivity
          thresholdMinutes: 120
        - name: branchActivity
          thresholdMinutes: 120
  review: {}
  merge: {}
  cleanup: {}
`;

  it('Context_InitializeWithTopologyMissingContracts_EmitsPhaseContractMissingOncePerMissingPhaseAtStartup', async () => {
    const { initializeContext } = await import('./context.js');
    const { getTopology } = await import('../topology/loader.js');
    const { SqliteBackend } = await import('../storage/sqlite-backend.js');

    // ─── Fixture: project root with a topology.yaml ────────────────────────
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-topo-proj-'));
    await fs.writeFile(path.join(projectRoot, 'topology.yaml'), PARTIAL_TOPOLOGY, 'utf-8');

    // Use a SQLite backend so `_substrate` events round-trip through the
    // canonical durable substrate, the same path the production lifecycle
    // walks. With JSONL-only mode the appender's stream-id validation +
    // sidecar fallback would still work, but a SQLite backend lets us
    // queryEvents('_substrate') deterministically with no sidecar merge.
    const dbPath = path.join(tmpDir, 'exarchos.db');
    const backend = new SqliteBackend(dbPath);
    backend.initialize();

    try {
      // ─── Act 1: first initializeContext fires the loader ────────────────
      const ctx1 = await initializeContext(tmpDir, { projectRoot, backend });
      expect(ctx1.eventStore).toBeDefined();

      // ─── Assertion 1: exactly 3 phase.contract_missing events emitted ──
      const eventsAfterFirst = await ctx1.eventStore.query('_substrate');
      const missingAfterFirst = eventsAfterFirst.filter(
        (e) => e.type === 'phase.contract_missing',
      );
      expect(missingAfterFirst).toHaveLength(3);

      // ─── Assertion 2: phaseName set matches the missing phases ──────────
      const phaseNames = new Set(
        missingAfterFirst.map((e) => (e.data as { phaseName: string }).phaseName),
      );
      expect(phaseNames).toEqual(new Set(['review', 'merge', 'cleanup']));

      // ─── Assertion 3: getTopology() callable post-init ──────────────────
      // Throws-if-not-loaded becomes pass-through after the wiring fires.
      // This is the second observable side effect of the wiring (besides
      // the events): downstream callers (e.g. pruner — T48) can now call
      // `getTopology()` synchronously without any cold-start race.
      expect(() => getTopology()).not.toThrow();
      const loaded = getTopology();
      expect(loaded.phases.design.staleness?.expectedMaxDwellMinutes).toBe(60);
      expect(loaded.phases.review.staleness).toBeUndefined();

      // ─── Act 2: second initializeContext on the same stateDir+projectRoot
      const ctx2 = await initializeContext(tmpDir, { projectRoot, backend });
      expect(ctx2.eventStore).toBeDefined();

      // ─── Assertion 4 (idempotency): event count UNCHANGED ──────────────
      // The loader's module-level cache short-circuits the second call →
      // no fresh `phase.contract_missing` emissions. This is the
      // "once at startup" semantics the design calls out for DR-7.
      const eventsAfterSecond = await ctx2.eventStore.query('_substrate');
      const missingAfterSecond = eventsAfterSecond.filter(
        (e) => e.type === 'phase.contract_missing',
      );
      expect(missingAfterSecond).toHaveLength(3);
    } finally {
      backend.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('Context_InitializeWithoutProjectRoot_DoesNotLoadTopology', async () => {
    // CLI cold-start fast-exit (no projectRoot) bypasses topology loading
    // entirely — `getTopology()` should still throw because
    // `loadTopology()` was never called. This pins the fast-exit shape so
    // a future refactor that unconditionally calls `loadTopology` would
    // fail here (it would also drag the YAML loader into the cold-start
    // import graph, blowing the DR-5 / task 021 p95=250ms budget).
    const { initializeContext } = await import('./context.js');
    const { getTopology } = await import('../topology/loader.js');

    await initializeContext(tmpDir);

    expect(() => getTopology()).toThrow(/load.*before/i);
  });

  it('Context_InitializeWithProjectRootButNoTopologyYaml_DoesNotThrow', async () => {
    // When `topology.yaml` is absent from a projectRoot, the wiring must
    // skip topology loading cleanly — never error. The pruner (T48) falls
    // back to the v2.9 single-signal heuristic when no contract is loaded;
    // the lifecycle hook honors the same "advisory, not required" stance.
    const { initializeContext } = await import('./context.js');
    const { getTopology } = await import('../topology/loader.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-topo-empty-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });
      expect(ctx.eventStore).toBeDefined();
      // No topology was loaded — accessor still throws.
      expect(() => getTopology()).toThrow(/load.*before/i);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
