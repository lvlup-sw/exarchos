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

    // ─── Fixture: project root with a topology.yaml ────────────────────────
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-topo-proj-'));
    await fs.writeFile(path.join(projectRoot, 'topology.yaml'), PARTIAL_TOPOLOGY, 'utf-8');

    try {
      // ─── Act 1: first initializeContext fires the loader ────────────────
      // We do NOT inject a SqliteBackend here. The wiring under test routes
      // emissions through `eventStore.append`, which uses the JSONL substrate
      // by default. JSONL is the simplest read-path for this assertion: a
      // `_substrate.events.jsonl` file with N lines == N emissions.
      const ctx1 = await initializeContext(tmpDir, { projectRoot });
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

      // ─── Pin the on-disk substrate state BEFORE the second startup ─────
      // The JSONL substrate pinning is what makes the idempotency assertion
      // robust to any internal substrate refactor: 3 lines now, 3 lines
      // after a second `initializeContext`. If the loader's cache stops
      // short-circuiting, this rises to 6 deterministically.
      const jsonlPath = path.join(tmpDir, '_substrate.events.jsonl');
      const jsonlAfterFirst = (await fs.readFile(jsonlPath, 'utf-8'))
        .split('\n')
        .filter((l) => l.trim()).length;
      expect(jsonlAfterFirst).toBe(3);

      // ─── Act 2: invoke loadTopology() a second time directly ──────────
      //
      // Pre-v2.11 this branch invoked `initializeContext` again, which
      // forced ctx2's EventStore into sidecar mode (PID lock held by ctx1)
      // and exercised the loader's module-level cache through the
      // `eventStore.append` path. Sidecar fallback was deleted in v2.11
      // (#1082) — a second `initializeContext` against the same stateDir
      // now hard-throws PidLockError. We call the loader directly with a
      // recording emit adapter to keep the same observable assertion: if
      // the cache stops short-circuiting, `extraEmits` rises above zero.
      const { loadTopology } = await import('../topology/loader.js');
      let extraEmits = 0;
      await loadTopology({
        topologyPath: path.join(projectRoot, 'topology.yaml'),
        emit: async () => {
          extraEmits += 1;
        },
      });
      expect(extraEmits).toBe(0);

      // ─── Assertion 4 (idempotency, on-disk): JSONL line count UNCHANGED
      // The loader's module-level cache short-circuits the second call →
      // no fresh `phase.contract_missing` emissions. This is the
      // "once at startup" semantics the design calls out for DR-7.
      const jsonlAfterSecond = (await fs.readFile(jsonlPath, 'utf-8'))
        .split('\n')
        .filter((l) => l.trim()).length;
      expect(jsonlAfterSecond).toBe(3);

      // ─── Assertion 5 (idempotency, query): no extra events visible ─────
      const eventsAfterSecond = await ctx1.eventStore.query('_substrate');
      const missingAfterSecond = eventsAfterSecond.filter(
        (e) => e.type === 'phase.contract_missing',
      );
      expect(missingAfterSecond).toHaveLength(3);
    } finally {
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
