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
 *
 * Cleanup discipline (T69, CodeRabbit #9 Major / DIM-4): the original
 * `if (result.claimed) { release() }` shape on a single claimer leaks the
 * lock whenever the *other* claimer wins the race — and worse, set
 * `winnerHasReleased = true` BEFORE the release, so the assertion could
 * pass while cleanup raced on. Both claimers now run the same
 * `runIfWinner` body which releases the lock from inside whichever
 * claimer holds it (the loser's await loop needs the row to flip to
 * 'completed' to unblock, so the release must happen DURING the race,
 * not after `Promise.all` resolves). The witness flag is set AFTER the
 * release awaits.
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
    //
    // Cleanup discipline (T69): both claimers run the SAME release-on-win
    // body so cleanup is symmetric — the test does not depend on which
    // claimer wins. The original shape released only inside claimerA's
    // `if (claimed)` branch, leaking the lock whenever B won. The witness
    // flag flips AFTER `releaseMigrationLock` awaits, not before.
    const releaseWitness = { released: false };

    const runIfWinner = async (
      result: Awaited<ReturnType<typeof claimMigrationLock>>,
    ): Promise<void> => {
      if (!result.claimed) return;
      // Simulate brief migration body, then release.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await releaseMigrationLock(backend);
      releaseWitness.released = true;
    };

    const claimerA = (async () => {
      const result = await claimMigrationLock(backend);
      await runIfWinner(result);
      return result;
    })();

    const claimerB = (async () => {
      // Slight stagger so the contention is realistic, not a tie.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await claimMigrationLock(backend);
      await runIfWinner(result);
      return result;
    })();

    let a: Awaited<typeof claimerA>;
    let b: Awaited<typeof claimerB>;
    try {
      [a, b] = await Promise.all([claimerA, claimerB]);

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

      // Loser only resolved AFTER the winner released — the witness flag
      // is set strictly after `releaseMigrationLock` awaits, so this
      // assertion does not race with cleanup the way the original
      // (pre-T69) `winnerHasReleased = true; await release()` did.
      expect(releaseWitness.released).toBe(true);

      // Post-race the row MUST be `'completed'`. The afterEach would
      // catch a leak by closing the DB, but asserting here makes the
      // determinism explicit at the test level.
      const state = readMigrationLockState(backend);
      expect(state?.state).toBe('completed');
    } finally {
      // Belt-and-suspenders: if any assertion above throws before the
      // race completes, ensure the lock is freed regardless of holder.
      // Errors from a non-holder release are silently ignored; the
      // primitive's release is idempotent on a 'completed' row.
      await releaseMigrationLock(backend).catch(() => undefined);
    }
  });

  /**
   * T69 (CodeRabbit finding #9, DIM-4) — pin claimerB as the winner by
   * reversing the stagger so claimerA waits 5ms. This is the case the
   * original test could not survive: under
   * `release-only-when-claimerA-claimed` cleanup, claimerA would fall
   * into the await loop with nobody to release the lock, hanging the
   * test against the 60s awaitTimeoutMs default.
   *
   * With the symmetric `runIfWinner` shape both claimers are wired to
   * release on win, so the case completes cleanly and the row ends
   * `'completed'`.
   */
  it('cleanup releases lock deterministically even when claimerB wins the race', async () => {
    const releaseWitness = { released: false };

    const runIfWinner = async (
      result: Awaited<ReturnType<typeof claimMigrationLock>>,
    ): Promise<void> => {
      if (!result.claimed) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await releaseMigrationLock(backend);
      releaseWitness.released = true;
    };

    // Stagger reversed: claimerA waits, claimerB races in first → B wins.
    const claimerA = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await claimMigrationLock(backend);
      await runIfWinner(result);
      return result;
    })();

    const claimerB = (async () => {
      const result = await claimMigrationLock(backend);
      await runIfWinner(result);
      return result;
    })();

    let a: Awaited<typeof claimerA>;
    let b: Awaited<typeof claimerB>;
    try {
      [a, b] = await Promise.all([claimerA, claimerB]);

      // Confirm the timing actually pinned claimerB as the winner.
      expect(b.claimed).toBe(true);
      expect(a.claimed).toBe(false);

      // The witness: cleanup fired (claimerB released its own lock),
      // and the loser observed completion via the await loop.
      expect(releaseWitness.released).toBe(true);
      if (a.claimed === false) {
        expect(a.observedCompletion).toBe(true);
      }

      // Post-race the row MUST be 'completed'. Under the original
      // cleanup pattern it would still be 'claimed' (leak).
      const state = readMigrationLockState(backend);
      expect(state?.state).toBe('completed');
    } finally {
      await releaseMigrationLock(backend).catch(() => undefined);
    }
  });
});
