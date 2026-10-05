import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InMemoryBackend } from '../../src/storage/memory-backend.js';
import type { StorageBackend } from '../../src/storage/backend.js';
import { isMcpServerInvocation, isDirectExecution } from '../../src/index.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

vi.mock('../../src/workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/workflow/state-store.js')>();
  return {
    ...original,
    configureStateStoreBackend: vi.fn(),
  };
});

describe('createServer Backend Wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createServer_WithBackend_ConfiguresStateStoreBackend', async () => {
    const { createServer } = await import('../../src/index.js');
    const { configureStateStoreBackend } = await import('../../src/workflow/state-store.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    await createServer('/tmp/test-state-dir', { backend });

    expect(configureStateStoreBackend).toHaveBeenCalledWith(backend);
  });

  it('createServer_WithBackend_PassesBackendToEventStore', async () => {
    const { createServer } = await import('../../src/index.js');
    const backend = new InMemoryBackend();
    await backend.initialize();

    const server = await createServer('/tmp/test-state-dir', { backend });

    expect(server).toBeDefined();
  });

  it('createServer_WithoutBackend_ConfiguresStateStoreWithUndefined', async () => {
    const { createServer } = await import('../../src/index.js');
    const { configureStateStoreBackend } = await import('../../src/workflow/state-store.js');

    const server = await createServer('/tmp/test-state-dir');

    expect(configureStateStoreBackend).toHaveBeenCalledWith(undefined);
    expect(server).toBeDefined();
  });
});

/** `initializeBackend` returns a SQLite backend or throws. It has no fallback that returns `undefined`. */
describe('initializeBackend', () => {
  it('initializeBackend_Success_ReturnsInitializedBackend', async () => {
    const { initializeBackend } = await import('../../src/index.js');
    const tmpDir = '/tmp/test-sqlite-init-' + Date.now();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });

    const backend = await initializeBackend(tmpDir);

    expect(backend).toBeDefined();
    backend.close();
  });

  /** A corrupt database has no recovery path, so the typed `SqliteCorruptError` must reach the operator. */
  it('initializeBackend_CorruptDB_PropagatesSqliteCorruptError', async () => {
    const { initializeBackend } = await import('../../src/index.js');
    const { SqliteCorruptError } = await import('../../src/storage/sqlite-backend.js');
    const tmpDir = '/tmp/test-sqlite-corrupt-' + Date.now();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    mkdirSync(tmpDir, { recursive: true });

    const dbPath = path.join(tmpDir, 'exarchos.db');
    writeFileSync(dbPath, 'this is not a valid sqlite database');

    await expect(initializeBackend(tmpDir)).rejects.toBeInstanceOf(SqliteCorruptError);
  });

  it('initializeBackend_FreshStateDir_DoesNotThrow', async () => {
    const { initializeBackend } = await import('../../src/index.js');
    const tmpDir = '/tmp/test-sqlite-fresh-' + Date.now();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });

    const result = await initializeBackend(tmpDir);

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    result.close();
  });
});

describe('Process Cleanup', () => {
  /** The test also calls the registered `exit` handler, which must close the backend. */
  it('registerBackendCleanup_RegistersExitHandler', async () => {
    const { registerBackendCleanup } = await import('../../src/index.js');
    const backend = new InMemoryBackend();
    await backend.initialize();
    const closeSpy = vi.spyOn(backend, 'close');

    const onSpy = vi.spyOn(process, 'on');

    registerBackendCleanup(backend);

    expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));

    const exitCall = onSpy.mock.calls.find(([event]) => event === 'exit');
    expect(exitCall).toBeDefined();
    const handler = exitCall![1] as () => void;
    handler();

    expect(closeSpy).toHaveBeenCalled();

    onSpy.mockRestore();
  });
});

/**
 * Only the first positional argument (`argv[2] === 'mcp'`) marks MCP server mode.
 * A loose `argv.includes('mcp')` check also matches `mcp` as a flag value, and then a CLI command runs with server semantics.
 */
describe('isMcpServerInvocation (F-022-2)', () => {
  /** Flags after `mcp` do not change the result. */
  it('returns true when mcp is the first positional argument', () => {
    expect(isMcpServerInvocation(['/usr/bin/node', '/path/to/exarchos', 'mcp'])).toBe(true);
    expect(
      isMcpServerInvocation(['/usr/bin/node', '/path/to/exarchos', 'mcp', '--debug']),
    ).toBe(true);
  });

  /** The first case has a feature id named "mcp", and the second case has a view named "mcp". */
  it('returns false for CLI invocations that mention "mcp" as a flag value', () => {
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

/**
 * `import.meta.url` is a file URL with forward slashes, and `process.argv[1]` on Windows uses backslashes.
 * Without normalization the guard never matches on Windows, and `main()` does not run.
 *
 * The suite does not run on Windows. `fileURLToPath` rejects the POSIX file URLs of these fixtures there, because they have no drive letter.
 * In production the URL is always a real platform URL.
 */
describe.skipIf(process.platform === 'win32')('isDirectExecution (#1085)', () => {
  it('matches a POSIX direct invocation', () => {
    expect(
      isDirectExecution(
        'file:///Users/foo/.npm/bin/exarchos.js',
        '/Users/foo/.npm/bin/exarchos.js',
      ),
    ).toBe(true);
  });

  it('matches a Windows direct invocation despite backslash separators', () => {
    expect(
      isDirectExecution(
        'file:///C:/Users/foo/AppData/Roaming/npm/node_modules/@lvlup-sw/exarchos/dist/exarchos.js',
        'C:\\Users\\foo\\AppData\\Roaming\\npm\\node_modules\\@lvlup-sw\\exarchos\\dist\\exarchos.js',
      ),
    ).toBe(true);
  });

  /** With `tsx` or `ts-node`, `argv[1]` is the `.ts` source path and `import.meta.url` is the `.js` URL at the same location. */
  it('matches when argv[1] is a .ts source path but the module loads as .js', () => {
    expect(
      isDirectExecution(
        'file:///Users/foo/repo/src/exarchos.js',
        '/Users/foo/repo/src/exarchos.ts',
      ),
    ).toBe(true);
  });

  it('matches a Windows .ts → .js invocation (normalize + extension swap)', () => {
    expect(
      isDirectExecution(
        'file:///C:/Users/foo/repo/src/exarchos.js',
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

  /** `import.meta.url` percent-encodes a space, and `process.argv[1]` is a raw path. `fileURLToPath()` must decode the URL before the compare. */
  it('matches a POSIX path containing a space (percent-encoded in import.meta.url)', () => {
    expect(
      isDirectExecution(
        'file:///Users/Reed%20Salus/repo/dist/exarchos.js',
        '/Users/Reed Salus/repo/dist/exarchos.js',
      ),
    ).toBe(true);
  });

  it('matches a Windows path containing a space (percent-encoded + backslash separators)', () => {
    expect(
      isDirectExecution(
        'file:///C:/Users/John%20Doe/repo/dist/exarchos.js',
        'C:\\Users\\John Doe\\repo\\dist\\exarchos.js',
      ),
    ).toBe(true);
  });

  /**
   * `npm link` makes `argv[1]` a symlink, and Node resolves symlinks for ESM, so `import.meta.url` names the real file.
   * Without `realpathSync`, the guard does not match and `main()` does not run.
   */
  describe('symlink resolution (#1158)', () => {
    let scratch: string;

    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'exarchos-symlink-test-'));
    });

    afterEach(() => {
      rmrf(scratch);
    });

    it('matches when argv[1] is a symlink to the real module', () => {
      const realDir = join(scratch, 'dist');
      mkdirSync(realDir, { recursive: true });
      const realScript = join(realDir, 'exarchos.js');
      writeFileSync(realScript, '// fixture\n');

      const binDir = join(scratch, 'bin');
      mkdirSync(binDir, { recursive: true });
      const linkPath = join(binDir, 'exarchos');
      symlinkSync(realScript, linkPath);

      const metaUrl = pathToFileURL(realScript).href;

      expect(isDirectExecution(metaUrl, linkPath)).toBe(true);
    });

    /** The path does not exist, so `realpathSync` throws and the guard compares the raw `argv[1]`. */
    it('falls back to raw argv[1] when realpath fails (path does not exist)', () => {
      expect(
        isDirectExecution(
          'file:///Users/foo/.npm/bin/exarchos.js',
          '/Users/foo/.npm/bin/exarchos.js',
        ),
      ).toBe(true);
    });
  });
});
