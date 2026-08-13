/**
 * Phase 4 (Init Hardening) — guard rail tests for `initializeBackend`.
 *
 * After Phase 4 of the v2.11 substrate-cut, `initializeBackend` must:
 *   T4.1 — hard-fail when neither `better-sqlite3` (Node) nor `bun:sqlite`
 *          (Bun) loads. Pre-Phase 4 it logged a warning and returned
 *          `undefined` so callers degraded into a "JSONL-only mode" that
 *          no longer exists post-Phase 2/3.
 *   T4.2 — never silently invoke a JSONL→SQLite migration importer. The
 *          `runJsonlToSqliteMigration` / `run-migration-if-needed` /
 *          `jsonl-importer` / `migration-lock` modules are deleted; a
 *          state directory pre-populated with `*.events.jsonl` files must
 *          NOT cause those events to be auto-imported into the SQLite db.
 *   T4.3 — surface a clear, operator-actionable error when invoked
 *          against a legacy v2.10 state directory (one containing
 *          `*.events.jsonl` files and no `events.db`/`exarchos.db`).
 *
 * Per the Iron Law: each assertion below MUST fail against the
 * pre-Phase-4 implementation that silently returns `undefined`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('initializeBackend (Phase 4 hardening)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'init-hardening-'));
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../src/storage/sqlite-backend.js');
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── T4.1 — hard-fail on missing SQLite drivers ────────────────────────────

  it('initializeBackend_DriversUnavailable_ThrowsNamingBothDrivers', async () => {
    // Inject a SqliteBackend loader that simulates the production
    // failure mode: `bun:sqlite` (Bun) and the better-sqlite3 vitest
    // shim both unresolvable, which causes the dynamic
    // `import('./storage/sqlite-backend.js')` to throw. Pre-Phase-4
    // this branch logged a warning and returned undefined so callers
    // fell through to a "JSONL-only mode" the substrate no longer
    // supports.
    //
    // We use the loader seam rather than `vi.mock('./storage/sqlite-backend.js')`
    // because `events/atomic-appender.ts` static-imports the same
    // module — mocking it module-wide cascades and breaks the static
    // graph before `initializeBackend()` is even reachable.
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
    // Must include some operator-actionable resolution path text.
    expect(msg).toMatch(/install|run under bun|use bun/i);
  });

  // ─── T4.2 — no silent JSONL→SQLite migration ───────────────────────────────

  it('initializeBackend_StateDirHasJsonl_DoesNotSilentlyImport', async () => {
    // Seed the state dir with a legacy *.events.jsonl file. The pre-Phase-4
    // importer would have ingested this on startup. Phase 4 must NOT do
    // that — it should either throw (legacy detection in T4.3) or simply
    // ignore the file and produce a fresh empty SQLite DB. Either way the
    // SQLite backend must NOT contain rows from the JSONL file.
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
      // Acceptable outcome (T4.3 path): legacy-state-dir detection trips.
      // No backend was returned, no JSONL→SQLite import happened.
      return;
    }

    // If init succeeded, the JSONL file MUST NOT have been imported.
    expect(backend).toBeDefined();
    const events = backend!.queryEvents('legacy-stream');
    expect(events).toHaveLength(0);
    backend!.close();
  });

  // ─── T4.3 — legacy-state-dir hard error ────────────────────────────────────

  it('initializeBackend_LegacyJsonlStateDir_ThrowsOperatorActionable', async () => {
    // Seed a *.events.jsonl file but NO events.db / exarchos.db — the
    // canonical signal of a v2.10 install. v2.11 removed the JSONL
    // importer; the only safe behavior is to refuse to start with a
    // message telling the operator they have two paths (downgrade or
    // wipe).
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
    // Must reference the legacy version and one of the two operator
    // resolution paths (wipe state, or stay on v2.10).
    expect(msg).toMatch(/v2\.10/);
    expect(msg).toMatch(/wipe|delete|stay/i);
  });
});
