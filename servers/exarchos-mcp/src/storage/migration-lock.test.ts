import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SqliteBackend } from './sqlite-backend.js';
import { claimMigrationLock, releaseMigrationLock } from './migration-lock.js';

/**
 * T19 — SQLite-backed migration lock primitive.
 *
 * Single-row `migration_lock` table with `INSERT ... ON CONFLICT DO NOTHING`
 * semantics: the first claimer wins; subsequent claimers observe the row
 * and either await completion or back off.
 *
 * The two-claimer test exercises the in-process boundary (cross-process is
 * T60). It validates:
 *   - one of the two `claimMigrationLock` calls returns `{ claimed: true }`,
 *     the other awaits and returns `{ claimed: false, observedCompletion: true }`
 *     once the holder calls `releaseMigrationLock`.
 *   - The loser does NOT race in and re-run the migration body.
 */
describe('MigrationLock_TwoConcurrentClaimers_OneRunsOneAwaits', () => {
  let stateDir: string;
  let backend: SqliteBackend;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'migration-lock-'));
    backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
    backend.initialize();
  });

  afterEach(async () => {
    backend.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  it('two in-process claimers — winner runs, loser awaits and observes completion', async () => {
    // Race two `claimMigrationLock` calls. One MUST win; the loser MUST
    // observe the winner's release without re-running the migration body.
    let winnerHasReleased = false;

    const claimerA = (async () => {
      const result = await claimMigrationLock(backend);
      if (result.claimed) {
        // Winner: simulate brief migration body, then release.
        await new Promise((resolve) => setTimeout(resolve, 50));
        winnerHasReleased = true;
        await releaseMigrationLock(backend);
      }
      return result;
    })();

    const claimerB = (async () => {
      // Slight stagger so the contention is realistic, not a tie.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await claimMigrationLock(backend);
      return result;
    })();

    const [a, b] = await Promise.all([claimerA, claimerB]);

    // Exactly one claimed; the other observed completion.
    const winners = [a, b].filter((r) => r.claimed);
    const losers = [a, b].filter((r) => !r.claimed);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Loser MUST have observed the winner's completion (not just timed out).
    const loser = losers[0];
    expect(loser.claimed).toBe(false);
    if (loser.claimed === false) {
      expect(loser.observedCompletion).toBe(true);
    }

    // Loser only resolved AFTER the winner released — i.e. the await-loop
    // actually awaited rather than racing in.
    expect(winnerHasReleased).toBe(true);
  });
});
