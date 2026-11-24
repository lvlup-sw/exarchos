import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import type { ToolResult } from '../../../../src/format.js';
import type { PruneHandlerDeps } from '../../../../src/verbs/team/prune-stale-workflows.js';

vi.mock('../../../../src/workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

vi.mock('../../../../src/config/register.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/config/register.js')>();
  return {
    ...original,
    registerCustomWorkflows: vi.fn(),
  };
});

vi.mock('../../../../src/vcs/factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/vcs/factory.js')>();
  return {
    ...original,
    createVcsProvider: vi.fn(original.createVcsProvider),
  };
});

describe('initializeContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('InitializeContext_CreatesEventStore_ConfiguresModules', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const ctx = await initializeContext(tmpDir);

    expect(ctx.stateDir).toBe(tmpDir);
    expect(ctx.eventStore).toBeDefined();
    expect(ctx.eventStore.dir).toBe(tmpDir);
    expect(typeof ctx.enableTelemetry).toBe('boolean');
  });

  it('InitializeContext_WithBackend_PassesBackendToEventStore', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { InMemoryBackend } = await import('../../../../src/storage/memory-backend.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    const ctx = await initializeContext(tmpDir, { backend });

    expect(ctx.stateDir).toBe(tmpDir);
    expect(ctx.eventStore).toBeDefined();
  });

  /**
   * `ctx.storage` is the same backend instance that the caller opened. A second
   * instance does not share connection state with the `EventStore`.
   */
  it('Lifecycle_Start_ConstructsStorageAndPassesViaContext', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { InMemoryBackend } = await import('../../../../src/storage/memory-backend.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    const ctx = await initializeContext(tmpDir, { backend });

    expect(ctx.storage).toBeDefined();
    expect(ctx.storage).toBe(backend);
  });

  /**
   * With no injected backend, `storage` stays undefined. A context that builds
   * its own backend hides a caller that did not initialize one.
   */
  it('Lifecycle_Start_NoBackend_StorageUndefined', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const ctx = await initializeContext(tmpDir);

    expect(ctx.storage).toBeUndefined();
  });

  it('InitializeContext_ConfiguresStateStoreBackend', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { configureStateStoreBackend } = await import('../../../../src/workflow/state-store.js');

    await initializeContext(tmpDir);

    expect(configureStateStoreBackend).toHaveBeenCalled();
  });

  it('InitializeContext_NoProjectRoot_ConfigUndefined', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const ctx = await initializeContext(tmpDir);

    expect(ctx.config).toBeUndefined();
  });

  /**
   * Each dispatch context carries a capability resolver. By default it reports
   * `anthropic_native_caching` and the process grants. The resolver is a closed
   * allowlist, so it does not report an unknown capability.
   */
  it('InitializeContext_DefaultResolver_ReportsAnthropicNativeCaching', async () => {
    const prior = process.env.EXARCHOS_DISABLE_CACHE_HINTS;
    delete process.env.EXARCHOS_DISABLE_CACHE_HINTS;
    try {
      const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
      const ctx = await initializeContext(tmpDir);
      expect(ctx.capabilityResolver).toBeDefined();
      expect(ctx.capabilityResolver!.has('anthropic_native_caching')).toBe(true);
      expect(ctx.capabilityResolver!.has('fs:write')).toBe(true);
      expect(ctx.capabilityResolver!.has('shell:exec')).toBe(true);
      expect(ctx.capabilityResolver!.has('made_up_capability')).toBe(false);
    } finally {
      if (prior === undefined) {
        delete process.env.EXARCHOS_DISABLE_CACHE_HINTS;
      } else {
        process.env.EXARCHOS_DISABLE_CACHE_HINTS = prior;
      }
    }
  });

  /**
   * `EXARCHOS_DISABLE_CACHE_HINTS=1` drops the cache-hint token only. The process
   * grants stay, so dispatch still admits an action that declares its needs.
   */
  it('InitializeContext_DisableCacheHintsEnv_DropsCacheHintKeepsProcessGrant', async () => {
    const prior = process.env.EXARCHOS_DISABLE_CACHE_HINTS;
    process.env.EXARCHOS_DISABLE_CACHE_HINTS = '1';
    try {
      const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
      const ctx = await initializeContext(tmpDir);
      expect(ctx.capabilityResolver).toBeDefined();
      expect(ctx.capabilityResolver!.has('anthropic_native_caching')).toBe(false);
      expect(ctx.capabilityResolver!.has('fs:write')).toBe(true);
      expect(ctx.capabilityResolver!.list()).not.toContain('anthropic_native_caching');
      expect(ctx.capabilityResolver!.list().length).toBeGreaterThan(0);
    } finally {
      if (prior === undefined) {
        delete process.env.EXARCHOS_DISABLE_CACHE_HINTS;
      } else {
        process.env.EXARCHOS_DISABLE_CACHE_HINTS = prior;
      }
    }
  });

  /** Startup is data-only. The executable configuration file writes a marker when something evaluates it. */
  it('InitializeContext_WithExecutableConfig_DoesNotEvaluateIt', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-proj-'));
    const marker = path.join(projectRoot, 'evaluated');
    await fs.writeFile(
      path.join(projectRoot, 'exarchos.config.js'),
      `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'evaluated');
      export default {
        workflows: {
          deploy: {
            phases: ['build', 'ship'],
            initialPhase: 'build',
            transitions: [{ from: 'build', to: 'ship', event: 'done' }],
          },
        },
      };`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.config).toEqual({});
      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('InitializeContext_WithProjectRootNoConfig_ConfigEmpty', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-empty-'));

    const ctx = await initializeContext(tmpDir, { projectRoot });

    expect(ctx.config).toEqual({});

    await rmrfAsync(projectRoot);
  });

  it('InitializeContext_WithConfigWorkflows_RegistersNoCustomWorkflow', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { registerCustomWorkflows } = await import('../../../../src/config/register.js');
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

    await initializeContext(tmpDir, { projectRoot });

    expect(registerCustomWorkflows).not.toHaveBeenCalled();

    await rmrfAsync(projectRoot);
  });

  /** The context carries no field of the retired verifier host, with or without a project root. */
  it('InitializeContext_AnyProjectRoot_CarriesNoVerifierConnector', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-host-'));

    try {
      expect(Object.keys(await initializeContext(tmpDir))).not.toContain('verificationHost');
      expect(Object.keys(await initializeContext(tmpDir, { projectRoot }))).not.toContain('verificationHost');
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  /** An executable configuration file or configured event hooks give one warning on the startup logger. */
  it('InitializeContext_ExecutableConfigOrHooks_LogsOneMigrationFinding', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { logger } = await import('../../../../src/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const clean = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-clean-'));
    const both = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-both-'));
    await fs.writeFile(path.join(both, 'exarchos.config.ts'), 'throw new Error("evaluated");\n');
    await fs.writeFile(path.join(both, '.exarchos.yml'), 'hooks:\n  on:\n    workflow.transition:\n      - command: echo hi\n');

    try {
      await initializeContext(tmpDir, { projectRoot: clean });
      expect(warn).not.toHaveBeenCalled();
      await initializeContext(tmpDir, { projectRoot: both });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual([
        expect.objectContaining({ finding: 'executable-configuration-retired', files: ['exarchos.config.ts'], hookEvents: ['workflow.transition'] }),
        expect.stringContaining('.exarchos/workflows/'),
      ]);
    } finally {
      warn.mockRestore();
      await rmrfAsync(clean);
      await rmrfAsync(both);
    }
  });
});

describe('initializeContext — projectConfig (YAML)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-yaml-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /** The YAML file overrides D3 and the VCS provider. D1 keeps its default. */
  it('initializeContext_WithProjectRoot_LoadsProjectConfig', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-yaml-'));
    await fs.writeFile(
      path.join(projectRoot, '.exarchos.yml'),
      `review:\n  dimensions:\n    D3: warning\nvcs:\n  provider: gitlab\n`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.projectConfig).toBeDefined();
      expect(ctx.projectConfig!.review.dimensions.D3.severity).toBe('warning');
      expect(ctx.projectConfig!.review.dimensions.D1.severity).toBe('blocking');
      expect(ctx.projectConfig!.vcs.provider).toBe('gitlab');
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('initializeContext_NoYml_ProjectConfigIsDefaults', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-noml-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.projectConfig).toBeDefined();
      expect(ctx.projectConfig!.review.dimensions.D1.severity).toBe('blocking');
      expect(ctx.projectConfig!.vcs.provider).toBe('github');
      expect(ctx.projectConfig!.workflow.maxFixCycles).toBe(3);
      expect(ctx.projectConfig!.tools.commitStyle).toBe('conventional');
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  /** The project root holds a YAML config and a JS config. The context loads the YAML config and evaluates no JS config. */
  it('initializeContext_ProjectConfigBeforeExarchosConfig', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

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

      expect(ctx.projectConfig).toBeDefined();
      expect(ctx.projectConfig!.tools.commitStyle).toBe('freeform');
      expect(ctx.config).toEqual({});
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  /**
   * A stub replaces the workflow handler and captures the context. Dispatch
   * validates the action name and its schema before it calls the handler, and
   * the `describe` schema accepts an empty payload.
   */
  it('dispatch_ProjectConfig_PassedToHandlers', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { COMPOSITE_HANDLERS, dispatch } = await import('../../../../src/dispatch/core/dispatch.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-dispatch-'));
    await fs.writeFile(
      path.join(projectRoot, '.exarchos.yml'),
      `vcs:\n  provider: azure-devops\n`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.projectConfig).toBeDefined();
      expect(ctx.projectConfig!.vcs.provider).toBe('azure-devops');

      let receivedCtx: unknown;
      const spy = async (_args: Record<string, unknown>, c: typeof ctx) => {
        receivedCtx = c;
        return { success: true as const, data: { ok: true } };
      };
      const original = (COMPOSITE_HANDLERS as Record<string, unknown>)['exarchos_workflow'];
      (COMPOSITE_HANDLERS as Record<string, unknown>)['exarchos_workflow'] = spy;

      try {
        await dispatch('exarchos_workflow', { action: 'describe' }, ctx);
        const capturedCtx = receivedCtx as typeof ctx;
        expect(capturedCtx.projectConfig).toBeDefined();
        expect(capturedCtx.projectConfig!.vcs.provider).toBe('azure-devops');
      } finally {
        (COMPOSITE_HANDLERS as Record<string, unknown>)['exarchos_workflow'] = original;
      }
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('initializeContext_WithProjectRoot_VcsProviderAvailable', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-vcs-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(ctx.vcsProvider).toBeDefined();
      expect(ctx.vcsProvider!.name).toBe('github');
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('initializeContext_WithGitLabConfig_VcsProviderIsGitLab', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

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
      await rmrfAsync(projectRoot);
    }
  });

  it('initializeContext_NoProjectRoot_VcsProviderUndefined', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const ctx = await initializeContext(tmpDir);

    expect(ctx.vcsProvider).toBeUndefined();
  });

  /**
   * With `detectVcs: false` and a project root, startup loads the YAML config and applies its durability.
   * It never calls the VCS factory, and the context holds no `vcsProvider` key.
   */
  it('InitializeContext_DetectVcsFalse_AppliesDurabilityWithoutVcsProvider', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { EventStore } = await import('../../../../src/events/store.js');
    const { createVcsProvider } = await import('../../../../src/vcs/factory.js');
    const durability = vi.spyOn(EventStore.prototype, 'setStorageDurability');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-novcs-'));
    await fs.writeFile(
      path.join(projectRoot, '.exarchos.yml'),
      `storage:\n  synchronous: full\ntools:\n  commit-style: freeform\n`,
    );

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot, detectVcs: false });

      expect(durability).toHaveBeenCalledWith('full');
      expect(ctx.projectConfig?.storage.synchronous).toBe('full');
      expect(ctx.projectConfig?.tools.commitStyle).toBe('freeform');
      expect(ctx.config).toEqual({});
      expect(Object.keys(ctx)).not.toContain('vcsProvider');
      expect(vi.mocked(createVcsProvider)).not.toHaveBeenCalled();
    } finally {
      durability.mockRestore();
      await rmrfAsync(projectRoot);
    }
  });

  /** The same project root without the option still calls the VCS factory once and holds a provider. */
  it('InitializeContext_DetectVcsAbsent_CallsTheVcsFactory', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { createVcsProvider } = await import('../../../../src/vcs/factory.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-withvcs-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });

      expect(vi.mocked(createVcsProvider)).toHaveBeenCalledTimes(1);
      expect(ctx.vcsProvider?.name).toBe('github');
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  /** The context carries no hook runner, with or without a project root. */
  it('initializeContext_WithProjectRoot_HasNoHookRunner', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-hook-'));

    try {
      expect(Object.keys(await initializeContext(tmpDir, { projectRoot }))).not.toContain('hookRunner');
      expect(Object.keys(await initializeContext(tmpDir))).not.toContain('hookRunner');
    } finally {
      await rmrfAsync(projectRoot);
    }
  });
});

/**
 * `initializeContext` is the startup hook that loads `topology.yaml`. Each test
 * resets the module-level topology cache, so no test reads the topology that
 * another test loaded.
 *
 * `PARTIAL_TOPOLOGY` holds two phases with a `staleness` block (`design`,
 * `implement`) and three phases without one (`review`, `merge`, `cleanup`).
 */
describe('initializeContext — topology loader wired at startup (T58, DR-7)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-topo-'));
    vi.clearAllMocks();
    const { __resetTopologyCacheForTesting } = await import('../../../../src/workflow/topology/loader.js');
    __resetTopologyCacheForTesting();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
    const { __resetTopologyCacheForTesting } = await import('../../../../src/workflow/topology/loader.js');
    __resetTopologyCacheForTesting();
  });

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

  /**
   * `loadTopology()` throws when a phase has no `staleness` block.
   * `initializeContext` swallows that throw, so startup continues. The
   * `_substrate` stream gets no `phase.contract_missing` event. `getTopology()`
   * still throws, because no topology is in the cache.
   */
  it('Context_InitializeWithTopologyMissingContracts_DoesNotBlockStartup_SwallowsLoaderThrow_v2_11_DR7', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { getTopology } = await import('../../../../src/workflow/topology/loader.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-topo-proj-'));
    await fs.writeFile(path.join(projectRoot, 'topology.yaml'), PARTIAL_TOPOLOGY, 'utf-8');

    try {
      const ctx1 = await initializeContext(tmpDir, { projectRoot });
      expect(ctx1.eventStore).toBeDefined();

      const events = await ctx1.eventStore.query('_substrate');
      const missing = events.filter((e) => e.type === 'phase.contract_missing');
      expect(missing).toHaveLength(0);

      expect(() => getTopology()).toThrow(/load.*before/i);
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  /**
   * Without a project root, startup returns before it loads a topology, so
   * `getTopology()` throws. A startup that always calls `loadTopology()` fails
   * this test.
   */
  it('Context_InitializeWithoutProjectRoot_DoesNotLoadTopology', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { getTopology } = await import('../../../../src/workflow/topology/loader.js');

    await initializeContext(tmpDir);

    expect(() => getTopology()).toThrow(/load.*before/i);
  });

  /** An absent `topology.yaml` is not an error. Startup skips the load, and `getTopology()` still throws. */
  it('Context_InitializeWithProjectRootButNoTopologyYaml_DoesNotThrow', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { getTopology } = await import('../../../../src/workflow/topology/loader.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-topo-empty-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });
      expect(ctx.eventStore).toBeDefined();
      expect(() => getTopology()).toThrow(/load.*before/i);
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  /** With `detectVcs: false`, startup still loads a valid `topology.yaml` from the project root. */
  it('Context_InitializeWithDetectVcsFalse_LoadsTopology', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { getTopology } = await import('../../../../src/workflow/topology/loader.js');

    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-topo-novcs-'));
    await fs.writeFile(path.join(projectRoot, 'topology.yaml'), IMPLEMENTING_ONLY_TOPOLOGY, 'utf-8');

    try {
      await initializeContext(tmpDir, { projectRoot, detectVcs: false });
      expect(() => getTopology()).not.toThrow();
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('Prune_NoTopologyYaml_ScoresAgainstTheBuiltinTopology', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { handlePruneStaleWorkflows } = await import('../../../../src/verbs/team/prune-stale-workflows.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-prune-none-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });
      const result = await handlePruneStaleWorkflows(
        { dryRun: true, now: PRUNE_NOW },
        tmpDir,
        ctx,
        pruneDepsListing([
          { featureId: 'plan-under-14d', workflowType: 'feature', phase: 'plan', minutesIdle: 20_100 },
          { featureId: 'plan-review-over-14d', workflowType: 'feature', phase: 'plan-review', minutesIdle: 20_200 },
          { featureId: 'triage-over-14d', workflowType: 'debug', phase: 'triage', minutesIdle: 30_000 },
          { featureId: 'gathering-fresh', workflowType: 'discovery', phase: 'gathering', minutesIdle: 60 },
        ]),
      );

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('aborted');
      expect(candidateIds(result)).toEqual(['plan-review-over-14d', 'triage-over-14d']);
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('Prune_NoTopologyYaml_CustomWorkflowTypeInABuiltInPhaseIsNotACandidate', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { handlePruneStaleWorkflows } = await import('../../../../src/verbs/team/prune-stale-workflows.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-prune-none-custom-'));

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });
      const result = await handlePruneStaleWorkflows(
        { dryRun: true, now: PRUNE_NOW },
        tmpDir,
        ctx,
        pruneDepsListing([
          { featureId: 'custom-plan-over-14d', workflowType: 'custom-flow', phase: 'plan', minutesIdle: 30_000 },
          { featureId: 'feature-plan-over-14d', workflowType: 'feature', phase: 'plan', minutesIdle: 30_000 },
        ]),
      );

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('aborted');
      expect(candidateIds(result)).toEqual(['feature-plan-over-14d']);
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('Prune_ValidTopologyYaml_ExplicitTopologyWins', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { handlePruneStaleWorkflows } = await import('../../../../src/verbs/team/prune-stale-workflows.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-prune-valid-'));
    await fs.writeFile(path.join(projectRoot, 'topology.yaml'), IMPLEMENTING_ONLY_TOPOLOGY, 'utf-8');

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });
      const result = await handlePruneStaleWorkflows(
        { dryRun: true, now: PRUNE_NOW },
        tmpDir,
        ctx,
        pruneDepsListing([
          { featureId: 'implementing-over-1h', workflowType: 'oneshot', phase: 'implementing', minutesIdle: 120 },
          { featureId: 'plan-over-14d', workflowType: 'feature', phase: 'plan', minutesIdle: 30_000 },
        ]),
      );

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('aborted');
      expect(candidateIds(result)).toEqual(['implementing-over-1h']);
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('Prune_ValidTopologyYaml_CustomWorkflowTypeIsStillScored', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { handlePruneStaleWorkflows } = await import('../../../../src/verbs/team/prune-stale-workflows.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-prune-valid-custom-'));
    await fs.writeFile(path.join(projectRoot, 'topology.yaml'), IMPLEMENTING_ONLY_TOPOLOGY, 'utf-8');

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });
      const result = await handlePruneStaleWorkflows(
        { dryRun: true, now: PRUNE_NOW },
        tmpDir,
        ctx,
        pruneDepsListing([
          { featureId: 'custom-implementing-over-1h', workflowType: 'custom-flow', phase: 'implementing', minutesIdle: 120 },
          { featureId: 'feature-implementing-fresh', workflowType: 'feature', phase: 'implementing', minutesIdle: 30 },
        ]),
      );

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('aborted');
      expect(candidateIds(result)).toEqual(['custom-implementing-over-1h']);
    } finally {
      await rmrfAsync(projectRoot);
    }
  });

  it('Prune_BrokenTopologyYaml_AbortsTopologyNotLoaded', async () => {
    const { initializeContext } = await import('../../../../src/dispatch/core/context.js');
    const { handlePruneStaleWorkflows } = await import('../../../../src/verbs/team/prune-stale-workflows.js');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-prune-broken-'));
    await fs.writeFile(path.join(projectRoot, 'topology.yaml'), PARTIAL_TOPOLOGY, 'utf-8');

    try {
      const ctx = await initializeContext(tmpDir, { projectRoot });
      const result = await handlePruneStaleWorkflows(
        { dryRun: true, now: PRUNE_NOW },
        tmpDir,
        ctx,
        pruneDepsListing([
          { featureId: 'plan-over-14d', workflowType: 'feature', phase: 'plan', minutesIdle: 30_000 },
        ]),
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ aborted: true, reason: 'topology_not_loaded' });
    } finally {
      await rmrfAsync(projectRoot);
    }
  });
});

const PRUNE_NOW = '2026-04-11T12:00:00.000Z';

const IMPLEMENTING_ONLY_TOPOLOGY = `
phases:
  implementing:
    staleness:
      expectedMaxDwellMinutes: 60
      freshnessRequires: all
      signals:
        - name: lastActivity
          thresholdMinutes: 60
`;

/**
 * Prune deps that list the given workflows, each idle for `minutesIdle`
 * before `PRUNE_NOW`. The secondary signals are absent and the safeguards
 * pass, so `lastActivity` alone decides each verdict.
 */
function pruneDepsListing(
  workflows: ReadonlyArray<{ featureId: string; workflowType: string; phase: string; minutesIdle: number }>,
): PruneHandlerDeps {
  const nowMs = new Date(PRUNE_NOW).getTime();
  return {
    handleList: async () => ({
      success: true,
      data: workflows.map((w) => ({
        featureId: w.featureId,
        workflowType: w.workflowType,
        phase: w.phase,
        stateFile: `/tmp/${w.featureId}.state.json`,
        _checkpoint: { lastActivityTimestamp: new Date(nowMs - w.minutesIdle * 60_000).toISOString() },
      })),
    }),
    handleCancel: vi.fn(),
    readBranchName: async () => undefined,
    safeguards: { hasRecentCommits: async () => false },
    readPhaseTransitionTimestamp: async () => undefined,
    readBranchActivityTimestamp: async () => undefined,
  };
}

/** The feature ids a prune result lists as candidates, in result order. */
function candidateIds(result: ToolResult): string[] {
  const data = result.data as { candidates?: Array<{ featureId: string }> };
  return (data.candidates ?? []).map((c) => c.featureId);
}
