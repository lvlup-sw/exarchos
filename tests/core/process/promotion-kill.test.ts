// ─── T-39 / DR-29: the T3 crash arm — a REAL process killed mid-promotion ────
//
// `atomic-promotion.ts` claims that a promotion is atomic at the
// `rename(staging → target)` step, and that the one window it cannot make
// disappear — between `rename(target → backup)` and that commit rename — is
// closed by the on-disk journal plus `recoverInterruptedPromotion`. Every
// existing test of that claim injects a fault THROUGH THE IO SEAM inside the
// vitest process: the injected `throw` unwinds into `commitPromotion`'s catch,
// which runs `recoverFromJournal` INLINE. Those tests therefore prove the
// error handler works. They cannot prove anything about the state the design
// actually exists for — a process that stops existing between the two renames,
// running no catch block, no `finally`, no flush.
//
// This file supplies that missing experiment, and nothing about it is
// simulated:
//
//   - The promotion runs in a REAL child OS process (`bun`, driving the real
//     `promoteTreeSync` against a real filesystem in a hermetic temp dir).
//   - The child parks at the exact instant BETWEEN the two renames and
//     publishes a sentinel carrying its OWN pid; the parent kills THAT pid.
//     Readiness is signalled, never slept on, so the kill lands in the window
//     deterministically rather than by racing a timer.
//   - The fault is `process.kill(pid, 'SIGKILL')` — `TerminateProcess` on
//     win32 — delivered through `deliverCrash`, the harness guard that REFUSES
//     an in-process substitute (see the second case).
//
// What is then asserted is the real invariant, not an invented one. After the
// kill the destination is genuinely absent and the old tree survives only in
// the scaffolding; a restart must converge to EITHER the complete old tree or
// the complete new one:
//
//   - restart via `recoverInterruptedPromotion` (pure repair) → fully OLD;
//   - restart via the ordinary `promoteTreeSync` retry (what re-running an
//     install does) → fully NEW.
//
// Never a mix — which is why the two trees are chosen to be mixable: they
// disagree on shared files AND each carries a file the other lacks, so any
// half-applied swap is detectable as a tree equal to neither.
//
// The third case pins the boundary of that convergence claim (DR-17 / T-24): a
// crash whose journal did not survive leaves the backup as the ONLY copy of the
// old tree, and there the engine REFUSES rather than converging — because both
// ways of continuing destroy it. A refusal that preserves the old bytes is a
// sound outcome; silently promoting over them would not be.
//
// ── The two authorities this file compares (DR-30) ──────────────────────────
//
// AUTHORITY A — THE BYTES ON DISK. What the child process actually left
//   behind when the real SIGKILL landed between the two renames, and what is
//   there after a restart. The PARENT reads it — `readTree` and `scaffolding`
//   walk the directory with `readdirSync` in a process that executed none of
//   the promotion code and holds no handle from the child. Nothing is
//   inferred from the child's exit status; the filesystem is re-read.
//
// AUTHORITY B — THE HAND-AUTHORED TREES. `OLD_TREE` and `NEW_TREE` are
//   literals written out below. They state what a COMPLETE tree is. The
//   engine never computes them; it is only ever measured against them.
//
// They can disagree, and the disagreement has a name: `torn`. If the commit
// were not one atomic `rename` — a per-file copy loop, say — the post-kill
// target would hold some files from the old tree and some from the new, equal
// to NEITHER literal, and `convergence()` would return `'torn'` where every
// assertion here demands `'old'` or `'new'`. That is exactly why the two trees
// are chosen to be mixable: they disagree on their shared files AND each
// carries a file the other lacks, so a blend is detectable instead of being
// absorbed into whichever side was read last.
//
// @oracle-sources: the on-disk bytes left by the SIGKILLed child process and re-read in the parent with readdirSync, the hand-authored OLD_TREE and NEW_TREE literals in this file
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { needsWindowsShell } from '../../../src/utils/process.js';
import {
  awaitProcessDeath,
  CrashInjectionRejectedError,
  deliverCrash,
} from './_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(__dirname, 'promotion-kill.driver.mjs');
const RESULT_PREFIX = 'EXARCHOS_PROMOTION_RESULT ';

/**
 * Two trees that CANNOT be confused with a blend of themselves: they disagree
 * on both shared files and each contributes a file the other does not have. A
 * torn promotion — some files swapped, some not — is therefore equal to
 * neither, which is what makes "converged to old or new" a real assertion
 * rather than a tautology.
 */
type Tree = Record<string, string>;

const OLD_TREE: Tree = {
  'index.md': 'OLD index',
  'nested/deep/note.md': 'OLD note',
  'only-in-old.md': 'OLD leftover',
};

const NEW_TREE: Tree = {
  'index.md': 'NEW index',
  'nested/deep/note.md': 'NEW note',
  'only-in-new.md': 'NEW arrival',
};

interface DriverResult {
  readonly pid: number;
  readonly ok: boolean;
  readonly recovered?: boolean;
  readonly report?: { readonly recoveredPriorAttempt?: boolean; readonly promoted?: boolean };
  readonly error?: { readonly name?: string; readonly code?: string; readonly message?: string };
}

interface DriverOutcome {
  /** Parsed RESULT line — ABSENT when the child was killed before it finished. */
  readonly result: DriverResult | undefined;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface DriverRun {
  readonly child: ChildProcess;
  readonly done: Promise<DriverOutcome>;
  /** Set once the process has exited — lets a sentinel wait fail fast. */
  exited: boolean;
}

const tempDirs: string[] = [];
const liveRuns: DriverRun[] = [];
/** Real pids parked by a driver, killed in teardown if an arm bailed early. */
const parkedPids: number[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-promotion-kill-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Teardown, not fault injection: a raw kill is correct here, and the harness
  // guard deliberately has no place in it.
  while (parkedPids.length > 0) {
    const pid = parkedPids.pop()!;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already dead — the common case */
    }
  }
  while (liveRuns.length > 0) {
    const run = liveRuns.pop()!;
    try {
      run.child.kill();
    } catch {
      /* already gone */
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function spawnDriver(args: readonly string[]): DriverRun {
  // `bun` is a `.cmd` shim on Windows and cannot be spawned without a shell;
  // the repo already owns that rule rather than re-deriving it here. Under a
  // shell, whitespace-bearing paths must be quoted or the shell re-tokenizes
  // them — the same treatment `runCommandSync` applies.
  const useShell = needsWindowsShell('bun');
  const argv = [DRIVER, ...args];
  const child = spawn('bun', useShell ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(useShell ? { shell: true } : {}),
  });

  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const run: DriverRun = {
    child,
    exited: false,
    done: new Promise<DriverOutcome>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => {
        run.exited = true;
        const line = stdout.split('\n').find((l) => l.startsWith(RESULT_PREFIX));
        resolve({
          result: line ? (JSON.parse(line.slice(RESULT_PREFIX.length)) as DriverResult) : undefined,
          code,
          signal,
          stdout,
          stderr,
        });
      });
    }),
  };
  liveRuns.push(run);
  return run;
}

function requireResult(outcome: DriverOutcome, what: string): DriverResult {
  if (outcome.result === undefined) {
    throw new Error(
      `${what}: driver produced no result line (exit ${String(outcome.code)}, signal ` +
        `${String(outcome.signal)})\nstdout:\n${outcome.stdout.slice(0, 2000)}\n` +
        `stderr:\n${outcome.stderr.slice(0, 4000)}`,
    );
  }
  return outcome.result;
}

async function runDriverToCompletion(args: readonly string[], what: string): Promise<DriverResult> {
  const outcome = await spawnDriver(args).done;
  return requireResult(outcome, what);
}

interface Sentinel {
  readonly pid: number;
  readonly phase: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * Wait for the child to publish its readiness sentinel. Fails fast (with the
 * child's own output) if the child exits without ever publishing one — which is
 * exactly what a promotion that never renames into its target would do, so this
 * timeout is a real signal about the production code, not harness noise.
 */
async function waitForSentinel(
  run: DriverRun,
  sentinelPath: string,
  what: string,
  timeoutMs = 60_000,
): Promise<Sentinel> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(sentinelPath)) {
      return JSON.parse(fs.readFileSync(sentinelPath, 'utf8')) as Sentinel;
    }
    if (run.exited) {
      const outcome = await run.done;
      throw new Error(
        `${what}: the child exited without ever parking between the two renames — the promotion ` +
          `never renamed anything into its target, so the commit was not an atomic swap.\n` +
          `exit ${String(outcome.code)} / ${String(outcome.signal)}\n` +
          `stdout:\n${outcome.stdout.slice(0, 2000)}\nstderr:\n${outcome.stderr.slice(0, 4000)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`${what}: no readiness sentinel at ${sentinelPath} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Read a directory into a `{ posix-relative path -> content }` map. */
function readTree(dir: string): Tree | undefined {
  // A non-directory (the promotion's journal FILE sits beside the trees) is
  // simply "not a tree" — reported as absent rather than throwing, so the
  // scaffolding scans below can walk every sibling uniformly.
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return undefined;
  const out: Tree = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

function sameTree(a: Tree | undefined, b: Tree): boolean {
  if (a === undefined) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k]);
}

/**
 * The convergence verdict, stated in the vocabulary of the invariant: the store
 * is `old`, `new`, `absent` (no tree at all) or `torn` (a tree equal to
 * neither — some files swapped and some not, the state the whole design exists
 * to make unreachable).
 */
function convergence(target: string): 'old' | 'new' | 'absent' | 'torn' {
  const tree = readTree(target);
  if (tree === undefined) return 'absent';
  if (sameTree(tree, OLD_TREE)) return 'old';
  if (sameTree(tree, NEW_TREE)) return 'new';
  return 'torn';
}

function describeTarget(target: string): string {
  return JSON.stringify(readTree(target) ?? null, null, 2);
}

/** Every entry beside the target in its parent: the promotion's scaffolding. */
function scaffolding(parent: string, target: string): string[] {
  return fs
    .readdirSync(parent)
    .filter((name) => path.join(parent, name) !== target)
    .sort();
}

/** The scaffolding entries whose contents are a complete copy of `tree`. */
function survivingCopiesOf(parent: string, target: string, tree: Tree): string[] {
  return scaffolding(parent, target).filter((name) =>
    sameTree(readTree(path.join(parent, name)), tree),
  );
}

function writeEntriesFile(dir: string, name: string, tree: Tree): string {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    JSON.stringify(Object.entries(tree).map(([p, content]) => ({ path: p, content }))),
    'utf8',
  );
  return file;
}

interface CrashedPromotion {
  /** The target's parent — holds the promotion's scaffolding and NOTHING else. */
  readonly store: string;
  readonly target: string;
  readonly newEntries: string;
  readonly killedPid: number;
}

/**
 * Seed the OLD tree with the real engine, start promoting the NEW tree in a
 * second real process, and SIGKILL that process at the instant it sits between
 * the two renames. Returns with the store frozen in the crash window.
 */
async function crashBetweenRenames(): Promise<CrashedPromotion> {
  const root = await makeTempDir();
  // The target's parent is kept free of harness files so that "what is left
  // beside the target" is exactly the promotion's own scaffolding — the
  // assertions below read that directory directly.
  const store = path.join(root, 'store');
  const harness = path.join(root, 'harness');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(harness, { recursive: true });
  const target = path.join(store, 'skills');
  const oldEntries = writeEntriesFile(harness, 'old.entries.json', OLD_TREE);
  const newEntries = writeEntriesFile(harness, 'new.entries.json', NEW_TREE);

  // ─── Arrange: a real, complete OLD tree, promoted by production code ───────
  const seeded = await runDriverToCompletion(
    ['--mode', 'promote', '--target', target, '--entries', oldEntries],
    'seeding the OLD tree',
  );
  expect(seeded.ok, `seed failed: ${JSON.stringify(seeded.error)}`).toBe(true);
  expect(readTree(target)).toEqual(OLD_TREE);

  // ─── Act: crash a real process between the two renames ────────────────────
  const sentinelPath = path.join(harness, 'between-renames.sentinel');
  const run = spawnDriver([
    '--mode',
    'promote-hang',
    '--target',
    target,
    '--entries',
    newEntries,
    '--sentinel',
    sentinelPath,
  ]);

  const ready = await waitForSentinel(run, sentinelPath, 'crashing the promotion');
  parkedPids.push(ready.pid);
  expect(ready.phase).toBe('between-renames');
  expect(ready.pid, 'the parked promotion must be a different OS process').not.toBe(process.pid);

  // The kill goes through the harness guard: a real SIGKILL to a real, live
  // child pid — `TerminateProcess` on win32, so no handler, no `finally`, no
  // flush runs inside the promotion.
  const killedPid = deliverCrash({ kind: 'sigkill', pid: ready.pid });
  await awaitProcessDeath(killedPid);
  parkedPids.pop();

  // The killed process cannot have completed anything: no result line.
  const outcome = await run.done;
  expect(
    outcome.result,
    `the "crashed" child still reported a result — it was not killed mid-promotion: ` +
      `${JSON.stringify(outcome.result)}`,
  ).toBeUndefined();

  // ─── The crash really did land INSIDE the window ──────────────────────────
  // Target renamed aside, staged tree not yet committed: this is the only
  // interval in which the destination does not exist at all.
  expect(
    fs.existsSync(target),
    `the target still exists after the kill, so the process was not parked between the two ` +
      `renames: ${describeTarget(target)}`,
  ).toBe(false);
  // …and the old bytes are not lost — they survive, complete, in the backup.
  expect(
    survivingCopiesOf(store, target, OLD_TREE),
    `no intact copy of the OLD tree survived the crash; scaffolding=${scaffolding(store, target).join()}`,
  ).not.toHaveLength(0);

  return { store, target, newEntries, killedPid };
}

describe('T3 crash arm: SIGKILL between the renames of an atomic promotion (DR-29)', () => {
  it(
    'AtomicPromotion_SigkillBetweenRenames_ConvergesToOldOrNew',
    async () => {
      // ─── Arm 1: restart runs pure repair → converges to the OLD tree ──────
      {
        const { store, target } = await crashBetweenRenames();

        const repaired = await runDriverToCompletion(
          ['--mode', 'recover', '--target', target],
          'restart repair after the crash',
        );
        expect(repaired.ok, `repair failed: ${JSON.stringify(repaired.error)}`).toBe(true);
        expect(repaired.recovered, 'the crash left no journal for the restart to consume').toBe(
          true,
        );

        const verdict = convergence(target);
        expect(
          verdict,
          `after a SIGKILL between the renames the store must be exactly the OLD tree or exactly ` +
            `the NEW one, never a blend of them. Got '${verdict}':\n${describeTarget(target)}`,
        ).toBe('old');
        expect(readTree(target)).toEqual(OLD_TREE);
        expect(
          scaffolding(store, target),
          'repair must not leave promotion scaffolding behind',
        ).toEqual([]);
      }

      // ─── Arm 2: restart re-runs the promotion → converges to the NEW tree ──
      {
        const { store, target, newEntries } = await crashBetweenRenames();

        const retried = await runDriverToCompletion(
          ['--mode', 'promote', '--target', target, '--entries', newEntries],
          'promotion retry after the crash',
        );
        expect(retried.ok, `retry failed: ${JSON.stringify(retried.error)}`).toBe(true);
        expect(
          retried.report?.recoveredPriorAttempt,
          'the retry did not recover the interrupted attempt first',
        ).toBe(true);

        const verdict = convergence(target);
        expect(
          verdict,
          `after a SIGKILL between the renames the store must be exactly the OLD tree or exactly ` +
            `the NEW one, never a blend of them. Got '${verdict}':\n${describeTarget(target)}`,
        ).toBe('new');
        expect(readTree(target)).toEqual(NEW_TREE);
        expect(
          scaffolding(store, target),
          'a converged retry must not leave promotion scaffolding behind',
        ).toEqual([]);
      }
    },
    240_000,
  );

  it(
    'AtomicPromotion_SigkillWithLostJournal_RefusesRatherThanDestroyingTheOldTree',
    async () => {
      // The boundary of the convergence claim (DR-17 / T-24). Recovery is
      // journal-driven; a crash whose journal never reached stable storage
      // leaves the backup as the ONLY surviving copy of the old tree. Both ways
      // of "converging" from there destroy it — so the engine must refuse, and
      // the old bytes must still be there afterwards.
      const { store, target, newEntries } = await crashBetweenRenames();

      const journals = scaffolding(store, target).filter((n) => n.endsWith('.json'));
      expect(journals, 'the crash should have left a promotion journal').toHaveLength(1);
      fs.rmSync(path.join(store, journals[0]!));

      const refused = await runDriverToCompletion(
        ['--mode', 'promote', '--target', target, '--entries', newEntries],
        'retry with a lost journal',
      );
      expect(
        refused.ok,
        'the retry proceeded over an orphan backup instead of refusing — the only surviving copy ' +
          'of the old tree was at stake',
      ).toBe(false);
      expect(refused.error?.name).toBe('PromotionError');
      expect(refused.error?.code).toBe('ORPHAN_BACKUP');

      // The refusal is only sound because the old tree is still there to be
      // recovered by hand.
      const survivors = survivingCopiesOf(store, target, OLD_TREE);
      expect(
        survivors,
        `the refusal did not preserve the OLD tree; scaffolding=${scaffolding(store, target).join()}`,
      ).toHaveLength(1);

      // …and an operator who acts on the refusal converges the store to OLD.
      fs.renameSync(path.join(store, survivors[0]!), target);
      expect(convergence(target)).toBe('old');
    },
    240_000,
  );

  it(
    'ProcessTier_InProcessThrowInjection_IsRejectedByHarness',
    async () => {
      // ─── The rejection ────────────────────────────────────────────────────
      // An in-process `throw` is the cheap substitute that makes a T3 arm
      // vacuous while keeping it green: it runs the catch block, so it proves
      // the error handler and nothing about a process that stops existing. The
      // harness refuses it BY NAME, loudly, and never runs the injected fault.
      let injected = 0;
      const inject = (): never => {
        injected++;
        throw new Error('in-process fault that must never be executed');
      };

      expect(() => deliverCrash({ kind: 'in-process-throw', inject })).toThrow(
        CrashInjectionRejectedError,
      );
      expect(() => deliverCrash({ kind: 'in-process-throw', inject })).toThrow(
        /in-process fault runs the catch block/,
      );
      expect(
        injected,
        'the harness executed the in-process fault instead of refusing it',
      ).toBe(0);

      try {
        deliverCrash({ kind: 'in-process-throw', inject });
        expect.unreachable('deliverCrash accepted an in-process throw injection');
      } catch (err) {
        expect(err).toBeInstanceOf(CrashInjectionRejectedError);
        expect((err as CrashInjectionRejectedError).code).toBe('IN_PROCESS_INJECTION');
      }
      expect(() => deliverCrash({ kind: 'in-process-abort', inject: () => undefined })).toThrow(
        CrashInjectionRejectedError,
      );

      // Relabelling the same in-process fault as a `sigkill` does not get it
      // past the guard either: a kill aimed at the test runner is in-process by
      // definition, and a fabricated pid would be a silent no-op.
      try {
        deliverCrash({ kind: 'sigkill', pid: process.pid });
        expect.unreachable('deliverCrash accepted a kill aimed at the test process itself');
      } catch (err) {
        expect((err as CrashInjectionRejectedError).code).toBe('SELF_TARGETED');
      }
      for (const bogus of [undefined, 0, -1, 1.5]) {
        try {
          deliverCrash({ kind: 'sigkill', pid: bogus });
          expect.unreachable(`deliverCrash accepted the non-process pid ${String(bogus)}`);
        } catch (err) {
          expect((err as CrashInjectionRejectedError).code).toBe('NOT_A_LIVE_PROCESS');
        }
      }

      // ─── The positive control ─────────────────────────────────────────────
      // A guard that rejected everything would be just as useless as one that
      // accepted everything: the arm below proves the ONLY thing it admits is a
      // real, live child process — and that the admitted kill actually kills.
      const root = await makeTempDir();
      const sentinelPath = path.join(root, 'idle.sentinel');
      const run = spawnDriver(['--mode', 'idle', '--sentinel', sentinelPath]);
      const ready = await waitForSentinel(run, sentinelPath, 'the positive control child');
      parkedPids.push(ready.pid);

      expect(ready.pid).not.toBe(process.pid);
      const killedPid = deliverCrash({ kind: 'sigkill', pid: ready.pid });
      expect(killedPid).toBe(ready.pid);
      await awaitProcessDeath(killedPid);
      parkedPids.pop();

      const outcome = await run.done;
      expect(
        outcome.result,
        `a SIGKILLed child reported a result, so it was not really killed: ${JSON.stringify(
          outcome.result,
        )}`,
      ).toBeUndefined();

      // The same pid is now dead, so re-killing it is refused rather than
      // silently succeeding — the property that stops a fabricated or
      // already-exited pid from standing in for a real crash.
      try {
        deliverCrash({ kind: 'sigkill', pid: killedPid });
        expect.unreachable('deliverCrash accepted a kill on an already-dead process');
      } catch (err) {
        expect((err as CrashInjectionRejectedError).code).toBe('NOT_A_LIVE_PROCESS');
      }
    },
    120_000,
  );
});
