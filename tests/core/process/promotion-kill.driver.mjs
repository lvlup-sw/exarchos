/**
 * Child process of `promotion-kill.test.ts`. The parent starts one process for each arm.
 *
 * The driver imports the production promotion engine as TypeScript source and runs it on a real
 * filesystem. Thus it must run under `bun`, and a change to the engine shows with no build step.
 *
 * Modes: `promote` stages `--entries` and promotes them into `--target`. `recover` runs only
 * `recoverInterruptedPromotion`. `idle` parks immediately.
 *
 * `promote-hang` wraps only `rename` of the default IO, and parks on the rename whose destination
 * is the target. At that moment the old tree is in the backup and the staged tree is not yet in
 * place. The parent kills the process there. An in-process `throw` cannot replace the kill,
 * because it runs the recovery in the `catch` block.
 *
 * The driver prints one JSON line behind `RESULT_PREFIX`. The `--sentinel` file tells the parent
 * that the process is parked, and it holds the pid of this process. The parent must kill that
 * pid: on Windows `child.pid` is the `cmd.exe` wrapper of the `bun` shim.
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
 * Publishes the readiness sentinel with a temp file and a rename. The parent kills the pid in
 * the file as soon as the file exists, so it must never read a partial JSON body.
 */
function publishSentinel(sentinelPath, payload) {
  const tmp = `${sentinelPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, sentinelPath);
}

/**
 * Parks the process for at most `--block-ms`, with the disk in the state that the caller reached.
 * `Bun.sleepSync` blocks the thread, so the synchronous promotion cannot continue during the park.
 * If the parent does not kill the process in that time, the function reports `NEVER_KILLED` and
 * exits with code 97. Thus a promotion cannot complete after the park and pass as a crash.
 */
function parkUntilKilled(phase) {
  const budgetMs = Number(arg('block-ms', '120000'));
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
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
