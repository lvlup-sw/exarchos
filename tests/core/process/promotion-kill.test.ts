// The crash arm for atomic promotion: a real child process dies between the two renames.
//
// A fault that a test injects through the IO seam unwinds into the `catch` block of
// `commitPromotion`, which runs recovery inline. Such a test cannot show the state after a process
// stops between the renames. Here the `bun` driver runs the real `promoteTreeSync` in a temp
// directory, parks between the renames, and publishes a sentinel with its own pid. The parent
// waits for the sentinel and kills that pid through `deliverCrash`.
//
// After the kill the target is absent and the old tree is in the scaffolding. A restart must give
// the complete old tree or the complete new tree, never a mix. When the journal is lost, the
// engine must refuse, because the backup is the only copy of the old tree.
//
// The parent reads the bytes on disk and compares them with the hand-written `OLD_TREE` and
// `NEW_TREE` literals. A tree that equals neither literal is `torn`.
//
// @oracle-sources: the on-disk bytes left by the SIGKILLed child process and re-read in the parent with readdirSync, the hand-authored OLD_TREE and NEW_TREE literals in this file

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
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(__dirname, 'promotion-kill.driver.mjs');
const RESULT_PREFIX = 'EXARCHOS_PROMOTION_RESULT ';

type Tree = Record<string, string>;

/**
 * `OLD_TREE` and `NEW_TREE` differ on each shared file, and each holds a file that the other lacks.
 * Thus a partial swap equals neither tree, and "converged to old or new" is a real assertion.
 */
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

/**
 * Teardown is not fault injection, so it kills with a raw `process.kill` and not through the
 * harness guard. A kill of a process that is already dead throws, and the hook ignores that error.
 */
afterEach(async () => {
  while (parkedPids.length > 0) {
    const pid = parkedPids.pop()!;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
  while (liveRuns.length > 0) {
    const run = liveRuns.pop()!;
    try {
      run.child.kill();
    } catch {
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rmrfAsync(dir).catch(() => undefined);
  }
});

/**
 * Spawns the driver under `bun`. On Windows `bun` is a `.cmd` shim that needs a shell, and
 * `needsWindowsShell` owns that rule. Under a shell, an argument with whitespace must have quotes,
 * or the shell splits it.
 */
function spawnDriver(args: readonly string[]): DriverRun {
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
 * Waits for the readiness sentinel of the child. If the child exits with no sentinel, the function
 * throws at once with the output of the child. A promotion that never renames into its target
 * exits that way, so the error is a signal about the production code.
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

/**
 * Reads a directory into a map from POSIX relative path to content. A path that is not a directory
 * gives `undefined`, so the scaffolding scans can read the journal file like each other sibling.
 */
function readTree(dir: string): Tree | undefined {
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
 * The convergence verdict for the target: `old`, `new`, `absent` (no tree), or `torn`. A `torn`
 * tree equals neither literal, because some files swapped and some did not. The design must make
 * that state unreachable.
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
 * Seeds the old tree with the real engine, then starts a second process that promotes the new tree.
 * It kills that process with SIGKILL between the two renames, and returns with the store in the
 * crash window.
 *
 * The parent of the target holds no harness file, so each entry beside the target is promotion
 * scaffolding. The kill goes through `deliverCrash` to a live child pid, so no handler and no
 * `finally` runs in the promotion. The function asserts that the child printed no result line and
 * that the target is absent. It also asserts that the scaffolding holds a complete old tree.
 */
async function crashBetweenRenames(): Promise<CrashedPromotion> {
  const root = await makeTempDir();
  const store = path.join(root, 'store');
  const harness = path.join(root, 'harness');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(harness, { recursive: true });
  const target = path.join(store, 'skills');
  const oldEntries = writeEntriesFile(harness, 'old.entries.json', OLD_TREE);
  const newEntries = writeEntriesFile(harness, 'new.entries.json', NEW_TREE);

  const seeded = await runDriverToCompletion(
    ['--mode', 'promote', '--target', target, '--entries', oldEntries],
    'seeding the OLD tree',
  );
  expect(seeded.ok, `seed failed: ${JSON.stringify(seeded.error)}`).toBe(true);
  expect(readTree(target)).toEqual(OLD_TREE);

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

  const killedPid = deliverCrash({ kind: 'sigkill', pid: ready.pid });
  await awaitProcessDeath(killedPid);
  parkedPids.pop();

  const outcome = await run.done;
  expect(
    outcome.result,
    `the "crashed" child still reported a result — it was not killed mid-promotion: ` +
      `${JSON.stringify(outcome.result)}`,
  ).toBeUndefined();

  expect(
    fs.existsSync(target),
    `the target still exists after the kill, so the process was not parked between the two ` +
      `renames: ${describeTarget(target)}`,
  ).toBe(false);
  expect(
    survivingCopiesOf(store, target, OLD_TREE),
    `no intact copy of the OLD tree survived the crash; scaffolding=${scaffolding(store, target).join()}`,
  ).not.toHaveLength(0);

  return { store, target, newEntries, killedPid };
}

describe('T3 crash arm: SIGKILL between the renames of an atomic promotion (DR-29)', () => {
  /**
   * Two arms, each after its own crash. In the first arm the restart runs only the repair and must
   * give the old tree. In the second arm the restart runs the promotion again and must give the
   * new tree.
   */
  it(
    'AtomicPromotion_SigkillBetweenRenames_ConvergesToOldOrNew',
    async () => {
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

  /**
   * The limit of the convergence claim. Recovery reads the journal, so a crash with a lost journal
   * leaves the backup as the only copy of the old tree. A removal of the backup or a new tree over
   * it erases that copy, so the engine must refuse and the old bytes must stay. An operator who
   * then renames the backup to the target gets the old tree.
   */
  it(
    'AtomicPromotion_SigkillWithLostJournal_RefusesRatherThanDestroyingTheOldTree',
    async () => {
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

      const survivors = survivingCopiesOf(store, target, OLD_TREE);
      expect(
        survivors,
        `the refusal did not preserve the OLD tree; scaffolding=${scaffolding(store, target).join()}`,
      ).toHaveLength(1);

      fs.renameSync(path.join(store, survivors[0]!), target);
      expect(convergence(target)).toBe('old');
    },
    240_000,
  );

  /**
   * An in-process `throw` runs the `catch` block, so it tests the error handler and not a dead
   * process. `deliverCrash` must refuse it by name and must not run the injected fault. It must
   * also refuse a `sigkill` at the test runner and at a pid that is not a live process.
   *
   * The positive control shows that the guard admits a live child process and that the kill works.
   * A second kill of the same pid must fail, so a dead pid cannot pass as a real crash.
   */
  it(
    'ProcessTier_InProcessThrowInjection_IsRejectedByHarness',
    async () => {
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
