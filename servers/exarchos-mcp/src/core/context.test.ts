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
});
