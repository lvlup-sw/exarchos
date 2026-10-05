import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Acceptance for the three substrate failure paths. Each path must end in a
 * result that the caller can read.
 *
 * The BUSY tests replace `insertEventStrict.run` on the prepared statements of
 * the backend, as `atomic-appender-sqlite.test.ts` does. That statement runs
 * inside `db.transaction(...).immediate()`, which rolls back on a throw.
 * `makeBusyError` sets `code: 'SQLITE_BUSY'`, the field that the retry layer reads.
 */
describe('Substrate_FailureModeCoverage_AllPathsExplicitAndObservable', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'substrate-resilience-acceptance-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  function makeBusyError(): Error {
    const err = new Error('database is locked') as Error & { code?: string };
    err.code = 'SQLITE_BUSY';
    return err;
  }

  /** The first three inserts throw SQLITE_BUSY, and the next insert succeeds. */
  it('BUSY retry path — first attempts SQLITE_BUSY, succeeds within retry budget', async () => {
    const appender = new AtomicAppender({ stateDir, backend: 'sqlite' });

    const warmup = await appender.append(
      'warmup',
      [{ type: 'task.assigned', data: { warmup: true } }],
      'warmup-key',
    );
    expect(warmup.ok).toBe(true);

    const backend = appender.getSqliteBackend();
    expect(backend).toBeDefined();
    if (!backend) return;

    const stmts = (
      backend as unknown as {
        stmts: { insertEventStrict: { run: (...args: unknown[]) => unknown } };
      }
    ).stmts;
    const originalRun = stmts.insertEventStrict.run.bind(stmts.insertEventStrict);
    let attempts = 0;
    stmts.insertEventStrict.run = (...args: unknown[]) => {
      attempts += 1;
      if (attempts <= 3) {
        throw makeBusyError();
      }
      return originalRun(...args);
    };

    let result: Awaited<ReturnType<typeof appender.append>>;
    try {
      result = await appender.append(
        'busy-retry',
        [{ type: 'task.assigned', data: { idx: 1 } }],
        'busy-retry-key',
      );
    } finally {
      stmts.insertEventStrict.run = originalRun;
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([1]);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(5);
  });

  /**
   * Every insert throws SQLITE_BUSY. The retry budget is 5 attempts. The result
   * carries the reason `storage_busy` and an `Error` cause for diagnosis.
   */
  it('BUSY exhaustion path — six SQLITE_BUSY attempts return reason=storage_busy', async () => {
    const appender = new AtomicAppender({ stateDir, backend: 'sqlite' });

    const warmup = await appender.append(
      'warmup-exhaust',
      [{ type: 'task.assigned', data: { warmup: true } }],
      'warmup-key-exhaust',
    );
    expect(warmup.ok).toBe(true);

    const backend = appender.getSqliteBackend();
    if (!backend) throw new Error('backend not initialized');

    const stmts = (
      backend as unknown as {
        stmts: { insertEventStrict: { run: (...args: unknown[]) => unknown } };
      }
    ).stmts;
    const originalRun = stmts.insertEventStrict.run.bind(stmts.insertEventStrict);
    let attempts = 0;
    stmts.insertEventStrict.run = (..._args: unknown[]) => {
      attempts += 1;
      throw makeBusyError();
    };

    let result: Awaited<ReturnType<typeof appender.append>>;
    try {
      result = await appender.append(
        'busy-exhaust',
        [{ type: 'task.assigned', data: { idx: 1 } }],
        'busy-exhaust-key',
      );
    } finally {
      stmts.insertEventStrict.run = originalRun;
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('storage_busy');
    expect(result.cause).toBeInstanceOf(Error);
    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(attempts).toBeLessThanOrEqual(6);
  });

  /**
   * The planted file has no SQLite header. `initialize()` must throw
   * `SqliteCorruptError` with a message that sends the operator to manual recovery.
   * The planted bytes must stay on disk, because a rebuild destroys the evidence.
   */
  it('CORRUPT startup path — malformed .db raises structured error referencing operator remediation', async () => {
    const dbPath = path.join(stateDir, 'corrupt.db');
    await writeFile(dbPath, Buffer.from('this is definitely not a sqlite database'));

    const backend = new SqliteBackend(dbPath);
    let thrown: unknown;
    try {
      backend.initialize();
    } catch (err) {
      thrown = err;
    } finally {
      try {
        backend.close();
      } catch {
      }
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { code?: string; kind?: string };
    expect(err.name).toBe('SqliteCorruptError');
    expect(err.message).toMatch(/operator|remediation|inspect|manual/i);

    const surviving = await readFile(dbPath);
    expect(surviving.toString('utf-8')).toContain('this is definitely not a sqlite database');
  });
});
