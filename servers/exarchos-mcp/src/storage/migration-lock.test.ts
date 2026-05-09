import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SqliteBackend } from './sqlite-backend.js';
import {
  claimMigrationLock,
  releaseMigrationLock,
  readMigrationLockState,
} from './migration-lock.js';

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

  /**
   * T69 (CodeRabbit finding #9, DIM-4) — witness for the original test's
   * non-deterministic cleanup. The existing release-the-winner pattern
   * (`if (result.claimed) { ... releaseMigrationLock() }`) only releases
   * when claimerA wins. If claimerB wins the race, NOTHING releases the
   * lock and the row stays `'claimed'` after the test body completes —
   * leaking the lock into the afterEach and (cross-test) into siblings.
   *
   * This test pins claimerB as the winner by giving claimerA the stagger,
   * mirrors the original "release only on claimerA.claimed" pattern, then
   * asserts the post-race lock state is `'completed'`. The assertion FAILS
   * under the original cleanup → demonstrates the leak. The fix
   * (release-whichever-claimer-holds) makes it pass.
   */
  it('release-the-winner cleanup must not leak the lock when claimerB wins', async () => {
    let winnerHasReleased = false;

    // Stagger reversed: claimerA waits, claimerB races in first → B wins.
    const claimerA = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await claimMigrationLock(backend);
      // Original (buggy) pattern: only release when *this* claimer won.
      if (result.claimed) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        winnerHasReleased = true;
        await releaseMigrationLock(backend);
      }
      return result;
    })();

    const claimerB = (async () => {
      const result = await claimMigrationLock(backend);
      // Original (buggy) pattern: claimerB never releases.
      return result;
    })();

    let a: Awaited<typeof claimerA>;
    let b: Awaited<typeof claimerB>;
    try {
      [a, b] = await Promise.all([claimerA, claimerB]);

      // Confirm the timing actually pinned claimerB as the winner.
      expect(b.claimed).toBe(true);
      expect(a.claimed).toBe(false);
      // claimerA is the loser → never released → winnerHasReleased stays false.
      expect(winnerHasReleased).toBe(false);

      // The witness assertion: after the race the row MUST be 'completed'.
      // Under the original cleanup pattern it is still 'claimed' (leak).
      const state = readMigrationLockState(backend);
      expect(state?.state).toBe('completed');
    } finally {
      // Belt-and-suspenders: ensure no leak escapes this test even on
      // assertion failure. The fix in the main test will adopt this same
      // release-whichever-holds shape.
      await releaseMigrationLock(backend).catch(() => undefined);
    }
  });
});
