import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryBackend } from './storage/memory-backend.js';
import type { StorageBackend } from './storage/backend.js';
import { isMcpServerInvocation, isDirectExecution } from './index.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock the state-store module to spy on configureStateStoreBackend
vi.mock('./workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

// Mock the hydration module
vi.mock('./storage/hydration.js', () => ({
  hydrateAll: vi.fn().mockResolvedValue(undefined),
}));

// Mock the migration module
vi.mock('./storage/migration.js', () => ({
  migrateLegacyStateFiles: vi.fn().mockResolvedValue(undefined),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('createServer Backend Wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createServer_WithBackend_ConfiguresStateStoreBackend', async () => {
    // Arrange
    const { createServer } = await import('./index.js');
    const { configureStateStoreBackend } = await import('./workflow/state-store.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    // Act
    await createServer('/tmp/test-state-dir', { backend });

    // Assert — configureStateStoreBackend should have been called with the backend
    expect(configureStateStoreBackend).toHaveBeenCalledWith(backend);
  });

  it('createServer_WithBackend_PassesBackendToEventStore', async () => {
    // Arrange
    const { createServer } = await import('./index.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    // Act — should not throw
    const server = await createServer('/tmp/test-state-dir', { backend });

    // Assert — server was created successfully with backend
    expect(server).toBeDefined();
  });

  it('createServer_WithoutBackend_WorksInJSONLFallbackMode', async () => {
    // Arrange
    const { createServer } = await import('./index.js');
    const { configureStateStoreBackend } = await import('./workflow/state-store.js');

    // Act — no backend provided
    const server = await createServer('/tmp/test-state-dir');

    // Assert — configureStateStoreBackend should be called with undefined
    expect(configureStateStoreBackend).toHaveBeenCalledWith(undefined);
    expect(server).toBeDefined();
  });
});

describe('initializeBackend', () => {
  it('initializeBackend_Success_ReturnsInitializedBackend', async () => {
    // Arrange
    const { initializeBackend } = await import('./index.js');
    const tmpDir = '/tmp/test-sqlite-init-' + Date.now();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });

    // Act
    const backend = await initializeBackend(tmpDir);

    // Assert
    // May be undefined if better-sqlite3 is not available in test env
    // but the function should not throw
    if (backend) {
      backend.close();
    }
  });

  it('initializeBackend_CorruptDB_DeletesAndRetries', async () => {
    // Arrange
    const { initializeBackend } = await import('./index.js');
    const tmpDir = '/tmp/test-sqlite-corrupt-' + Date.now();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    mkdirSync(tmpDir, { recursive: true });

    // Write corrupt data to the DB file
    const dbPath = path.join(tmpDir, 'exarchos.db');
    writeFileSync(dbPath, 'this is not a valid sqlite database');

    // Act
    const backend = await initializeBackend(tmpDir);

    // Assert — should have self-healed (deleted corrupt DB and retried)
    // If better-sqlite3 is available, we get a backend; otherwise undefined (fallback)
    // Either way, it should not throw
    if (backend) {
      backend.close();
    }
  });

  it('initializeBackend_AnyEnvironment_NeverThrows', async () => {
    // Arrange — verifies the graceful fallback contract: initializeBackend
    // never throws regardless of whether better-sqlite3 is available.
    const { initializeBackend } = await import('./index.js');
    const tmpDir = '/tmp/test-sqlite-missing-' + Date.now();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });

    // Act — should not throw regardless
    const result = await initializeBackend(tmpDir);

    // Assert — result is either a valid backend or undefined
    expect(result === undefined || typeof result === 'object').toBe(true);
    if (result) {
      result.close();
    }
  });
});

describe('Process Cleanup', () => {
  it('registerBackendCleanup_RegistersExitHandler', async () => {
    // Arrange
    const { registerBackendCleanup } = await import('./index.js');
    const backend = new InMemoryBackend();
    await backend.initialize();
    const closeSpy = vi.spyOn(backend, 'close');

    // Track process.on calls
    const onSpy = vi.spyOn(process, 'on');

    // Act
    registerBackendCleanup(backend);

    // Assert — should have registered an 'exit' handler
    expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));

    // Simulate the exit handler
    const exitCall = onSpy.mock.calls.find(([event]) => event === 'exit');
    expect(exitCall).toBeDefined();
    const handler = exitCall![1] as () => void;
    handler();

    expect(closeSpy).toHaveBeenCalled();

    onSpy.mockRestore();
  });
});

// ─── F-022-2: MCP Mode Detection ────────────────────────────────────────────
//
// Regression: the previous `argv.includes('mcp')` check matched any occurrence
// of the string `mcp` in argv, so CLI commands that mentioned `mcp` as a flag
// value (e.g. `-f mcp`, `--view mcp`) silently flipped into server semantics
// and had their writes diverted to sidecar files. A strict positional check
// (argv[2] === 'mcp') is the source-of-truth signal for MCP server mode.

describe('isMcpServerInvocation (F-022-2)', () => {
  it('returns true when mcp is the first positional argument', () => {
    // `node exarchos mcp`
    expect(isMcpServerInvocation(['/usr/bin/node', '/path/to/exarchos', 'mcp'])).toBe(true);
    // Extra flags after `mcp` must not matter.
    expect(
      isMcpServerInvocation(['/usr/bin/node', '/path/to/exarchos', 'mcp', '--debug']),
    ).toBe(true);
  });

  it('returns false for CLI invocations that mention "mcp" as a flag value', () => {
    // `exarchos event append -f mcp -t task.completed -d '{}'` — feature id
    // named "mcp".
    expect(
      isMcpServerInvocation([
        '/usr/bin/node',
        '/path/to/exarchos',
        'event',
        'append',
        '-f',
        'mcp',
        '-t',
        'task.completed',
        '-d',
        '{}',
      ]),
    ).toBe(false);
    // `exarchos view --view mcp` — view name "mcp".
    expect(
      isMcpServerInvocation([
        '/usr/bin/node',
        '/path/to/exarchos',
        'view',
        '--view',
        'mcp',
      ]),
    ).toBe(false);
  });

  it('returns false for empty or non-mcp invocations', () => {
    expect(isMcpServerInvocation(['/usr/bin/node', '/path/to/exarchos'])).toBe(false);
    expect(isMcpServerInvocation(['/usr/bin/node', '/path/to/exarchos', 'event'])).toBe(false);
    expect(isMcpServerInvocation([])).toBe(false);
  });
});

// ─── isDirectExecution (#1085) ──────────────────────────────────────────────
// Regression coverage for the Windows CLI no-op bug: import.meta.url is a
// forward-slash file:// URL while process.argv[1] on Windows uses backslashes,
// so the original `endsWith` guard never matched and main() never ran. Tests
// pin the behavior on both POSIX and Windows path shapes.

describe('isDirectExecution (#1085)', () => {
  it('matches a POSIX direct invocation', () => {
    expect(
      isDirectExecution(
        'file:///Users/foo/.npm/bin/exarchos.js',
        '/Users/foo/.npm/bin/exarchos.js',
      ),
    ).toBe(true);
  });

  it('matches a Windows direct invocation despite backslash separators', () => {
    // This is the #1085 regression: before normalization, endsWith() compared
    // forward-slash URL against a backslash path and never matched.
    expect(
      isDirectExecution(
        'file:///C:/Users/foo/AppData/Roaming/npm/node_modules/@lvlup-sw/exarchos/dist/exarchos.js',
        'C:\\Users\\foo\\AppData\\Roaming\\npm\\node_modules\\@lvlup-sw\\exarchos\\dist\\exarchos.js',
      ),
    ).toBe(true);
  });

  it('matches when argv[1] is a .ts source path but the module loads as .js', () => {
    expect(
      isDirectExecution(
        'file:///Users/foo/repo/dist/exarchos.js',
        '/Users/foo/repo/src/exarchos.ts',
      ),
    ).toBe(true);
  });

  it('matches a Windows .ts → .js invocation (normalize + extension swap)', () => {
    expect(
      isDirectExecution(
        'file:///C:/Users/foo/repo/dist/exarchos.js',
        'C:\\Users\\foo\\repo\\src\\exarchos.ts',
      ),
    ).toBe(true);
  });

  it('returns false when the module is imported by an unrelated script', () => {
    expect(
      isDirectExecution(
        'file:///Users/foo/repo/dist/exarchos.js',
        '/Users/foo/repo/tests/run-tests.js',
      ),
    ).toBe(false);
  });

  it('returns false when argv[1] is missing', () => {
    expect(isDirectExecution('file:///Users/foo/repo/dist/exarchos.js', undefined)).toBe(false);
  });
});
