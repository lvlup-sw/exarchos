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
