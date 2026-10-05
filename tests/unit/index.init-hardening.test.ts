/**
 * Guard tests for `initializeBackend`. SQLite is the only event-store backend.
 * When neither `better-sqlite3` nor `bun:sqlite` loads, the function must throw.
 * It must throw for a v2.10 state directory, which holds `*.events.jsonl` files and no SQLite database.
 * It must never import those JSONL events into the SQLite database.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

describe('initializeBackend (Phase 4 hardening)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-hardening-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../src/storage/sqlite-backend.js');
    vi.resetModules();
    rmrf(tempDir);
  });

  /**
   * The injected loader throws, which simulates an import of `sqlite-backend.js` with no SQLite driver.
   * A module-wide `vi.mock` of that module is not usable, because `events/atomic-appender.ts` imports it statically.
   * The message must also tell the operator how to get a driver.
   */
  it('initializeBackend_DriversUnavailable_ThrowsNamingBothDrivers', async () => {
    const { initializeBackend } = await import('../../src/index.js');

    const failingLoader = () => {
      throw new Error('Cannot find module better-sqlite3 / bun:sqlite');
    };

    let captured: unknown;
    try {
      await initializeBackend(tempDir, failingLoader);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/better-sqlite3/);
    expect(msg).toMatch(/bun:sqlite/);
    expect(msg).toMatch(/install|run under bun|use bun/i);
  });

  /**
   * The state directory holds one `*.events.jsonl` file.
   * If `initializeBackend` throws, the test passes. If it returns a backend, the stream must hold no event from that file.
   */
  it('initializeBackend_StateDirHasJsonl_DoesNotSilentlyImport', async () => {
    const jsonlPath = join(tempDir, 'legacy-stream.events.jsonl');
    const fakeEvent = JSON.stringify({
      streamId: 'legacy-stream',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2026-05-09T00:00:00.000Z',
      schemaVersion: '1.0',
      data: { from: 'jsonl' },
    });
    writeFileSync(jsonlPath, fakeEvent + '\n', 'utf-8');

    const { initializeBackend } = await import('../../src/index.js');

    let backend: Awaited<ReturnType<typeof initializeBackend>> | undefined;
    let initThrew = false;
    try {
      backend = await initializeBackend(tempDir);
    } catch {
      initThrew = true;
    }

    if (initThrew) {
      return;
    }

    expect(backend).toBeDefined();
    const events = backend!.queryEvents('legacy-stream');
    expect(events).toHaveLength(0);
    backend!.close();
  });

  /**
   * A `*.events.jsonl` file with no SQLite database marks a v2.10 state directory.
   * The error must name v2.10 and one way out: wipe the state, or stay on v2.10.
   */
  it('initializeBackend_LegacyJsonlStateDir_ThrowsOperatorActionable', async () => {
    const jsonlPath = join(tempDir, 'feat-001.events.jsonl');
    writeFileSync(jsonlPath, '{}\n', 'utf-8');

    const { initializeBackend } = await import('../../src/index.js');

    await expect(initializeBackend(tempDir)).rejects.toThrowError(/v2\.10/);

    let captured: unknown;
    try {
      await initializeBackend(tempDir);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const msg = (captured as Error).message;
    expect(msg).toMatch(/v2\.10/);
    expect(msg).toMatch(/wipe|delete|stay/i);
  });
});
