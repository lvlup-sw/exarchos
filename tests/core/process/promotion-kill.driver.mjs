/**
 * T-39 / DR-29 promotion-crash driver — the CHILD half of
 * `promotion-kill.test.ts`.
 *
 * Spawned as a REAL OS process, one per arm. It drives the REAL production
 * promotion engine (`src/install/atomic-promotion.ts`, imported as TypeScript
 * source) against a REAL filesystem, and — in `promote-hang` mode — parks the
 * process at the exact instant BETWEEN the two renames of the atomic swap so
 * the parent can SIGKILL it there.
 *
 * Why a child process at all, and why it may not be replaced with an
 * in-process fault:
 *
 *   An in-process `throw` injected into the promotion always runs the `catch`
 *   block — `commitPromotion`'s inline `recoverFromJournal`, the `finally`
 *   cleanups, every unwind path. It therefore proves the happy-path error
 *   handler works and proves NOTHING about a process that simply STOPS
 *   EXISTING mid-swap, which is the failure the journal + recovery design is
 *   for. `process.kill(pid, 'SIGKILL')` (TerminateProcess on Windows) runs no
 *   handler, no `finally`, no flush: the disk is left exactly as the kernel
 *   last saw it. That is the only fault that exercises the invariant.
 *
 * Run under `bun`, not `node`: the production module is TypeScript with
 * `.js`-suffixed specifiers, and importing the SOURCE (rather than driving the
 * compiled binary) is what keeps this fixture kill-probe-able — breaking the
 * atomic swap or the journal recovery in `atomic-promotion.ts` is observable on
 * the very next test run with no build step in between.
 *
 * Protocol (stdout, one JSON line behind a prefix so logger chatter cannot be
 * mistaken for it):
 *
 *   EXARCHOS_PROMOTION_RESULT {"pid":…,"ok":…,…}
 *
 * The `--sentinel` file is the READINESS channel: it is written with a
 * temp-file + rename, so the parent never observes a half-written sentinel,
 * and it carries THIS process's own pid. The parent must kill that pid rather
 * than `child.pid` — on Windows `bun` is a `.cmd` shim spawned through
 * `cmd.exe`, so `child.pid` is the shell wrapper, and killing the wrapper
 * would leave the real promotion process alive and unparked.
 *
 * Modes:
 *   --mode promote        stage + promote `--entries` into `--target`
 *   --mode promote-hang   … but park between the two renames and wait to die
 *   --mode recover        run `recoverInterruptedPromotion(--target)` only
 *   --mode idle           park immediately (positive control for the kill path)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  defaultPromotionIo,
  promoteTreeSync,
  recoverInterruptedPromotion,
} from '../../../src/install/atomic-promotion.ts';

const RESULT_PREFIX = 'EXARCHOS_PROMOTION_RESULT ';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required driver argument --${name}`);
  }
  return process.argv[idx + 1];
}

function emit(payload) {
  process.stdout.write(RESULT_PREFIX + JSON.stringify({ pid: process.pid, ...payload }) + '\n');
}

/**
 * Publish the readiness sentinel atomically. The parent polls for this file and
 * kills as soon as it appears; a plain `writeFileSync` would let it read a
 * truncated JSON body and mis-parse the pid it is about to kill.
 */
function publishSentinel(sentinelPath, payload) {
  const tmp = `${sentinelPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, sentinelPath);
}

/**
 * Park forever (bounded), holding the on-disk state frozen at whatever point
 * the caller reached. Returns only if the parent never killed us — which is a
 * FAILURE, reported loudly rather than silently proceeding, because a run that
 * completed the promotion after "crashing" would make the parent's convergence
 * assertion vacuous.
 */
function parkUntilKilled(phase) {
  const budgetMs = Number(arg('block-ms', '120000'));
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    // `Bun.sleepSync` blocks the thread without burning a core, and — unlike an
    // `await` — cannot be interleaved with the promotion's own synchronous
    // call stack, so the disk really is frozen at `phase`.
    Bun.sleepSync(20);
  }
  emit({ ok: false, error: 'NEVER_KILLED', phase, budgetMs });
  process.exit(97);
}

function describeError(err) {
  return {
    name: err?.name ?? 'Error',
    code: err?.code ?? undefined,
    message: String(err?.message ?? err).slice(0, 600),
  };
}

const mode = arg('mode');
const sentinelPath = arg('sentinel', '');

if (mode === 'idle') {
  publishSentinel(sentinelPath, { pid: process.pid, phase: 'idle' });
  parkUntilKilled('idle');
} else if (mode === 'recover') {
  const target = arg('target');
  try {
    const recovered = recoverInterruptedPromotion(target);
    emit({ ok: true, recovered });
  } catch (err) {
    emit({ ok: false, error: describeError(err) });
  }
} else {
  const target = arg('target');
  const entries = JSON.parse(fs.readFileSync(arg('entries'), 'utf8'));

  // The REAL default IO does every filesystem touch. `promote-hang` wraps only
  // ONE method, and only to PARK — it never throws, never fakes a filesystem,
  // and never changes what the promotion does. The park fires on the rename
  // whose destination IS the target, i.e. the COMMIT rename: at that instant
  // the old tree has already been renamed aside to the backup and the staged
  // new tree has not yet been renamed into place. That is the window.
  const base = defaultPromotionIo();
  const io =
    mode === 'promote-hang'
      ? {
          ...base,
          rename: (from, to) => {
            if (path.resolve(to) === path.resolve(target)) {
              publishSentinel(sentinelPath, {
                pid: process.pid,
                phase: 'between-renames',
                from,
                to,
              });
              parkUntilKilled('between-renames');
            }
            base.rename(from, to);
          },
        }
      : base;

  try {
    const report = promoteTreeSync({ target, entries }, io);
    emit({ ok: true, report });
  } catch (err) {
    emit({ ok: false, error: describeError(err) });
  }
}
