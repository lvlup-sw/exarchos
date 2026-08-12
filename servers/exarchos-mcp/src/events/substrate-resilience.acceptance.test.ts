import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { SqliteBackend } from '../storage/sqlite-backend.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/**
 * Substrate failure-mode acceptance (T08, DR-12).
 *
 * Closes the design's *Failure-mode coverage* AC by asserting all three
 * substrate-level failure paths have explicit, observable, recoverable
 * handling. Stays RED until T09 (BUSY bounded retry) and T10 (CORRUPT
 * structured error at startup) ship their GREEN implementations.
 *
 *   1. BUSY retry path — first ≥1 attempt sees `SQLITE_BUSY`; the append
 *      transparently retries and succeeds within the bounded budget.
 *   2. BUSY exhaustion path — every attempt sees `SQLITE_BUSY`; the
 *      appender returns a typed `AppendResult` failure with
 *      `reason: 'storage_busy'` and an `Error` cause for diagnostics.
 *   3. CORRUPT startup path — the `.db` file is malformed at the byte
 *      level; `SqliteBackend.initialize()` throws a structured error that
 *      references operator remediation, and the planted file is
 *      preserved (no auto-rebuild silently destroys evidence).
 *
 * The test patches the backend's prepared-statement set to inject the
 * `SQLITE_BUSY` faults — same patching technique as T07's rollback
 * fixture (`atomic-appender-sqlite.test.ts`). Acceptance suites should
 * not require new public test seams; reusing the existing one keeps the
 * API surface narrow.
 */
describe('Substrate_FailureModeCoverage_AllPathsExplicitAndObservable', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'substrate-resilience-acceptance-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Build an `Error` that mimics the shape `bun:sqlite` /
   * `better-sqlite3` raise for SQLITE_BUSY: a `SqliteError`-like instance
   * carrying `code: 'SQLITE_BUSY'`. The retry layer must detect by
   * `error.code` (string comparison) — message-substring detection is a
   * brittle fallback.
   */
  function makeBusyError(): Error {
    const err = new Error('database is locked') as Error & { code?: string };
    err.code = 'SQLITE_BUSY';
    return err;
  }

  it('BUSY retry path — first attempts SQLITE_BUSY, succeeds within retry budget', async () => {
    const appender = new AtomicAppender({ stateDir, backend: 'sqlite' });

    // Warm up the lazy SqliteBackend so we can grab a handle and patch
    // the strict event INSERT to throw BUSY for the first 3 attempts of
    // the next append, then succeed.
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
        // SQLITE_BUSY surfaces from the underlying driver here, the
        // BEGIN IMMEDIATE write-lock acquisition is the typical site.
        // Throwing from the strict-event INSERT is the cleanest probe
        // because it's wrapped by `db.transaction(...).immediate()`,
        // which auto-ROLLBACKs.
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
    // Proves retry actually fired — at least one BUSY plus the success.
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(5);
  });

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
    // Structured failure shape: explicit reason code + Error cause for
    // operator-level diagnostics. Stable contract for callers translating
    // to typed errors (cf. EventStore.append).
    expect(result.reason).toBe('storage_busy');
    expect(result.cause).toBeInstanceOf(Error);
    // The retry budget caps at 5 attempts (T09 GREEN constant).
    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(attempts).toBeLessThanOrEqual(6);
  });

  it('CORRUPT startup path — malformed .db raises structured error referencing operator remediation', async () => {
    const dbPath = path.join(stateDir, 'corrupt.db');
    // Plant a deliberately-malformed file: not a SQLite database header.
    // Exact bytes don't matter — `SQLITE_NOTADB` (or `SQLITE_CORRUPT`
    // depending on the SQLite version) surfaces on the first read of the
    // file's metadata.
    await writeFile(dbPath, Buffer.from('this is definitely not a sqlite database'));

    const backend = new SqliteBackend(dbPath);
    let thrown: unknown;
    try {
      backend.initialize();
    } catch (err) {
      thrown = err;
    } finally {
      // Best-effort close; if `initialize()` failed before opening the
      // handle, `close()` should be a no-op.
      try {
        backend.close();
      } catch {
        // ignore
      }
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error & { code?: string; kind?: string };
    // Structured shape — the dedicated error class signals a non-
    // recoverable corruption to operators / lifecycle wiring.
    expect(err.name).toBe('SqliteCorruptError');
    // Operator remediation reference — message must point operators to
    // the documented recovery procedure rather than implying auto-heal.
    expect(err.message).toMatch(/operator|remediation|inspect|manual/i);

    // No auto-rebuild contract: the planted bytes survive the throw, so
    // the operator can inspect them. An automatic rebuild would silently
    // destroy the evidence the operator needs to diagnose the corruption.
    const surviving = await readFile(dbPath);
    expect(surviving.toString('utf-8')).toContain('this is definitely not a sqlite database');
  });
});
