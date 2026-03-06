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
});
