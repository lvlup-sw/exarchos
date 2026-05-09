import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SqliteBackend } from './sqlite-backend.js';

/**
 * T60 — Cross-process migration-lock convergence.
 *
 * Spawns two child processes, each invoking `runJsonlToSqliteMigration`
 * against the same shared SQLite database file. Asserts:
 *   - Exactly one process actually runs the import (the winner).
 *   - The other process observes `migration.completed` and returns
 *     without re-running.
 *
 * The test relies on SQLite's file-locking + WAL semantics for the
 * cross-process serialization — same `migration_lock` row, same
 * `INSERT ... CONFLICT` collision point. The in-process fixture (T19)
 * proved the lock works against a single connection; this fixture proves
 * it survives the cross-process boundary.
 *
 * Test runtime: each process forks a fresh tsx subprocess, opens the
 * shared DB, races for the lock, and writes its outcome to a JSON file.
 * The parent test reads both outcome files and asserts the winner/loser
 * pattern.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('MigrationLock_CliAndMcpStartConcurrently_OneRunsOneAwaits', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'migration-lock-xprocess-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('two child processes race for the lock; exactly one runs the import', async () => {
    // ─── Fixture: single legacy JSONL file the winner will import ─────────
    const streamId = 'stream-xprocess-target';
    const jsonlPath = path.join(stateDir, `${streamId}.events.jsonl`);
    await writeFile(
      jsonlPath,
      JSON.stringify({
        streamId,
        sequence: 1,
        type: 'workflow.started',
        timestamp: '2026-01-01T00:00:00.000Z',
        eventId: 'xp-1',
        data: {},
        idempotencyKey: 'k-xp-1',
      }) + '\n',
      'utf-8',
    );

    // Pre-create the SQLite DB and apply schema so both child processes
    // observe a ready DB on connect (and so the migration_lock table is
    // present at race start).
    const dbPath = path.join(stateDir, 'exarchos.db');
    const seedBackend = new SqliteBackend(dbPath);
    seedBackend.initialize();
    seedBackend.close();

    const helperPath = path.join(__dirname, '__tests__', 'migration-lock-xproc-helper.ts');
    const PKG_ROOT = path.resolve(__dirname, '..', '..');
    const TSX_BIN = path.join(PKG_ROOT, 'node_modules', '.bin', 'tsx');

    // ─── Spawn two child processes back-to-back ──────────────────────────
    const childOutputs: string[] = [];
    const childPromises = [0, 1].map((idx) => {
      const outPath = path.join(stateDir, `outcome-${idx}.json`);
      childOutputs.push(outPath);
      return new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const proc = spawn(
          TSX_BIN,
          [helperPath, '--state-dir', stateDir, '--out', outPath],
          {
            cwd: PKG_ROOT,
            env: process.env,
          },
        );
        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });
        proc.on('exit', (code) => resolve({ code, stderr }));
      });
    });

    const results = await Promise.all(childPromises);

    // Both children must exit cleanly (winner ran the import; loser
    // observed completion).
    for (const r of results) {
      if (r.code !== 0) {
        throw new Error(`child exited non-zero (code=${r.code}): stderr=${r.stderr}`);
      }
    }

    const { readFile } = await import('node:fs/promises');
    const outcomes = await Promise.all(
      childOutputs.map(async (p) => JSON.parse(await readFile(p, 'utf-8'))),
    );

    // Exactly one winner.
    const winners = outcomes.filter((o) => o.role === 'winner');
    const losers = outcomes.filter((o) => o.role === 'loser');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Winner imported the file; loser saw filesImported=0 (already done).
    expect(winners[0].filesImported).toBe(1);
    expect(losers[0].filesImported).toBe(0);

    // Final DB state: the file is gone from stateDir, the archive copy
    // exists, and exactly one `migration.completed` event sits on the
    // `__migration__` stream.
    const verifyBackend = new SqliteBackend(dbPath);
    verifyBackend.initialize();
    try {
      const migrationEvents = verifyBackend.queryEvents('__migration__');
      const completed = migrationEvents.filter((e) => e.type === 'migration.completed');
      expect(completed).toHaveLength(1);
      const importedEvents = verifyBackend.queryEvents(streamId);
      expect(importedEvents).toHaveLength(1);
    } finally {
      verifyBackend.close();
    }
  }, 60_000);
});
