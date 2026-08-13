import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  publishTempFile,
  publishTempFileSync,
  atomicWriteFile,
  fsyncDir,
  fsyncDirSync,
  DIRECTORY_SYNC_UNSUPPORTED_CODES,
  PUBLISH_BACKOFF_CAP_MS,
  type DirectorySyncOutcome,
} from './atomic-write.js';
import {
  afterDurable,
  defaultPromotionIo,
  promoteTreeSync,
  recoverInterruptedPromotion,
  PromotionError,
  type PromotionIo,
} from '../install/atomic-promotion.js';
import { digestTree, type DigestEntry } from '../install/install-identity.js';

/**
 * Testing strategy only — for the race itself, see `publishTempFile`.
 *
 * The race cannot be provoked on the Linux lane by doing real concurrent IO, so
 * the platform is stubbed and the rename injected. That is deliberate: the
 * alternative (`skipIf(win32)`) would leave the retry untested on every lane that
 * actually runs — the vacuous-gate defect of #1694, a guard that guards nothing
 * on the only platform that can see the bug. The win32 lane covers the
 * integration end (state-store's concurrent writers); these cover the mechanism.
 */

function eperm(): NodeJS.ErrnoException {
  const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
  err.code = 'EPERM';
  return err;
}

function errWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: synthetic`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function stubPlatform(value: NodeJS.Platform): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('publishTempFile', () => {
  it('PublishTempFile_Posix_RenamesExactlyOnceWithoutRetrying', async () => {
    stubPlatform('linux');
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockResolvedValue(undefined);

    await publishTempFile('/tmp/a.tmp', '/tmp/a', { rename });

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('/tmp/a.tmp', '/tmp/a');
  });

  it('PublishTempFile_PosixEperm_RethrowsWithoutRetrying', async () => {
    // POSIX never raises the race, so an EPERM there is a REAL permission fault
    // and must surface immediately rather than be retried into a ~1s stall.
    stubPlatform('linux');
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(eperm());

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/EPERM/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('PublishTempFile_Win32EpermThenSuccess_RetriesAndResolves', async () => {
    stubPlatform('win32');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(eperm())
      .mockRejectedValueOnce(eperm())
      .mockResolvedValue(undefined);

    await publishTempFile('/tmp/a.tmp', '/tmp/a', { rename });

    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('PublishTempFile_Win32Eacces_IsAlsoTreatedAsTheRace', async () => {
    stubPlatform('win32');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(errWithCode('EACCES'))
      .mockResolvedValue(undefined);

    await publishTempFile('/tmp/a.tmp', '/tmp/a', { rename });

    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('PublishTempFile_Win32NonRaceError_RethrowsWithoutRetrying', async () => {
    // ENOSPC is not the race. Retrying it would turn a hard failure into a stall.
    stubPlatform('win32');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/ENOSPC/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('PublishTempFile_Win32PermanentEperm_RethrowsAfterBoundedAttempts', async () => {
    // A read-only file / hostile ACL reports EPERM too and is indistinguishable
    // here. The loop MUST terminate and rethrow rather than hang forever.
    stubPlatform('win32');
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(eperm());

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/EPERM/);

    // Bounded: the initial attempt plus a finite number of retries, not unbounded.
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    expect(rename.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it('PublishTempFile_ManyWritersAtSameAttempt_SleepDifferentDurations', async () => {
    // THE property that breaks the convoy, stated precisely.
    //
    // It is NOT "delays differ across attempts" — a deterministic `5 * attempt`
    // satisfies that (5, 10, 15, …) while still waking every contending writer
    // on the same tick. That weaker assertion was the first version of this test
    // and a no-jitter mutant survived it, which is exactly the vacuous-gate
    // defect of #1694 in miniature.
    //
    // The real property is cross-WRITER: two writers colliding at the SAME
    // attempt number must sleep DIFFERENT durations, or they collide again.
    stubPlatform('win32');
    const attemptZeroDelays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      attemptZeroDelays.push(ms ?? 0);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    // 24 independent writers, each colliding exactly once → each records only
    // its attempt-0 sleep. A deterministic backoff makes all 24 identical.
    for (let i = 0; i < 24; i++) {
      const rename = vi
        .fn<(from: string, to: string) => Promise<void>>()
        .mockRejectedValueOnce(eperm())
        .mockResolvedValue(undefined);
      await publishTempFile(`/tmp/a.tmp.${i}`, '/tmp/a', { rename });
    }

    expect(attemptZeroDelays.length).toBe(24);
    expect(new Set(attemptZeroDelays).size).toBeGreaterThan(1);
    for (const d of attemptZeroDelays) expect(d).toBeLessThanOrEqual(1 + 64);
  });

  it('PublishTempFile_Win32WorstCaseBackoff_StaysInsideTheDocumentedBudget', async () => {
    // Pin `Math.random` to its maximum so this measures the WORST case rather
    // than a lucky sample. With real jitter the total is random, so a loose
    // ceiling would let an implementation that busts the documented ~1s budget
    // pass most runs and fail rarely — a flake that reads as a bad test.
    stubPlatform('win32');
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(eperm());
    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/EPERM/);

    // Every individual sleep respects the per-attempt cap...
    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) expect(d).toBeLessThanOrEqual(1 + PUBLISH_BACKOFF_CAP_MS);
    // ...and the worst-case TOTAL honours the ~1s the docstring promises.
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });

  it('PublishTempFile_TerminalFailure_RemovesTheStagedTempFile', async () => {
    // A staged temp whose publish failed is garbage. Leaving it orphans a file
    // next to the target on EVERY failure — state-store and atomicWriteFile each
    // hand-rolled this cleanup while the other publishes silently leaked.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publish-cleanup-'));
    const target = path.join(dir, 'x.json');
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, 'staged', 'utf-8');

    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));

    await expect(publishTempFile(tmp, target, { rename, unlink: fsp.unlink })).rejects.toThrow(
      /ENOSPC/,
    );

    await expect(fsp.access(tmp)).rejects.toThrow(); // temp is gone
    expect(await fsp.readdir(dir)).toEqual([]); // nothing orphaned
  });

  it('PublishTempFile_CleanupItselfFails_StillRethrowsTheOriginalError', async () => {
    // Cleanup is best-effort and must never mask why the publish failed.
    stubPlatform('linux');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));
    const unlink = vi
      .fn<(p: string) => Promise<void>>()
      .mockRejectedValue(new Error('unlink exploded'));

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename, unlink })).rejects.toThrow(
      /ENOSPC/,
    );
    expect(unlink).toHaveBeenCalledWith('/tmp/a.tmp');
  });

  it('PublishTempFile_IoWithoutUnlink_PublishesWithoutAttemptingCleanup', async () => {
    // An injected fs that cannot delete (e.g. McpJsonWriterFs) must still work —
    // it simply gets no cleanup, exactly as before this seam existed.
    stubPlatform('linux');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/ENOSPC/);
  });

  it('PublishTempFile_DefaultRename_PublishesRealFileOnThisPlatform', async () => {
    // The default path (no injected rename) must actually move bytes.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publish-default-'));
    const target = path.join(dir, 'x.json');
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, '{"v":1}', 'utf-8');

    await publishTempFile(tmp, target);

    expect(await fsp.readFile(target, 'utf-8')).toBe('{"v":1}');
    await expect(fsp.access(tmp)).rejects.toThrow();
  });

  it('PublishTempFile_ConcurrentPublishersOneTarget_AllResolveAndTargetIsWhole', async () => {
    // The shape that was red on win32: N writers, N distinct temps, ONE target.
    // On POSIX this always passed; it is the regression guard for every routed
    // site, and the reader must never observe a torn payload.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publish-concurrent-'));
    const target = path.join(dir, 'shared.json');
    const writers = Array.from({ length: 12 }, async (_, i) => {
      const tmp = `${target}.tmp.${i}`;
      await fsp.writeFile(tmp, JSON.stringify({ writer: i }), 'utf-8');
      await publishTempFile(tmp, target);
    });

    const results = await Promise.allSettled(writers);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    // Exactly one writer's payload survives, intact and parseable — never a mix.
    const final = JSON.parse(await fsp.readFile(target, 'utf-8')) as { writer: number };
    expect(final.writer).toBeGreaterThanOrEqual(0);
    expect(final.writer).toBeLessThan(12);

    // No temp file is left stranded.
    const leftover = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });
});

describe('publishTempFileSync', () => {
  it('PublishTempFileSync_Posix_PublishesRealFile', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publish-sync-'));
    const target = path.join(dir, 'y.json');
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, 'sync-payload', 'utf-8');

    publishTempFileSync(tmp, target);

    expect(await fsp.readFile(target, 'utf-8')).toBe('sync-payload');
  });

  it('PublishTempFileSync_PosixNonRaceError_Rethrows', () => {
    stubPlatform('linux');
    expect(() => publishTempFileSync('/nonexistent/a.tmp', '/nonexistent/a')).toThrow();
  });
});

describe('atomicWriteFile', () => {
  it('AtomicWriteFile_RoutesThroughSharedPublish_AndWritesContent', async () => {
    // Guards the routing itself: atomicWriteFile must not re-open-code rename.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
    const target = path.join(dir, 'z.json');

    atomicWriteFile(target, '{"ok":true}');

    expect(await fsp.readFile(target, 'utf-8')).toBe('{"ok":true}');
    const leftover = (await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });
});

// ─── DR-16: durable ordering of the journal + tree renames ───────────────────

/**
 * Why the promotion-engine tests live in `atomic-write.test.ts` and not beside
 * `install/atomic-promotion.ts`: DR-16 is ONE property spanning two modules —
 * the primitive here (`fsyncDirSync` + `DurabilityBarrier`) and the sequence
 * built out of it there. Split across two files, each half can stay green while
 * the ORDER between them regresses, and the order is the entire defect.
 *
 * These tests assert the CALL/ORDERING contract through the injectable seams,
 * not the success of a POSIX-only syscall, because the durability step is a
 * documented no-op on win32 (see `DIRECTORY_SYNC_UNSUPPORTED_CODES`) and a test
 * that asserted "fsync succeeded" would be red on this repo's Windows lane while
 * proving nothing extra on Linux.
 */

const OLD_TREE: readonly DigestEntry[] = [
  { path: 'a.md', content: 'OLD alpha\n' },
  { path: 'nested/b.md', content: 'OLD beta\n' },
  { path: 'nested/deep/c.md', content: 'OLD gamma\n' },
];

const NEW_TREE: readonly DigestEntry[] = [
  { path: 'a.md', content: 'NEW alpha (rewritten)\n' },
  { path: 'nested/b.md', content: 'NEW beta (rewritten)\n' },
  { path: 'd.md', content: 'NEW delta (added)\n' },
];

const OLD_DIGEST = digestTree(OLD_TREE);
const NEW_DIGEST = digestTree(NEW_TREE);
const ABSENT = '<absent>';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-dr16-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir === undefined) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

function writeTree(dir: string, entries: readonly DigestEntry[]): void {
  for (const entry of entries) {
    const full = path.join(dir, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.content, 'utf8');
  }
}

function readTree(dir: string): DigestEntry[] {
  const out: DigestEntry[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) walk(path.join(current, dirent.name), rel);
      else if (dirent.isFile()) {
        out.push({ path: rel, content: fs.readFileSync(path.join(current, dirent.name), 'utf8') });
      }
    }
  };
  walk(dir, '');
  return out;
}

/** `sha256:…` of the tree at `dir`, or `<absent>`. Never throws on a missing dir. */
function diskDigest(dir: string): string {
  return fs.existsSync(dir) ? digestTree(readTree(dir)) : ABSENT;
}

const stageDir = (root: string): string => path.join(root, '.skills.exarchos-stage');
const backupDir = (root: string): string => path.join(root, '.skills.exarchos-backup');
const journalPath = (root: string): string => path.join(root, '.skills.exarchos-promote.json');

function expectNoScaffolding(root: string): void {
  expect(fs.existsSync(stageDir(root))).toBe(false);
  expect(fs.existsSync(backupDir(root))).toBe(false);
  expect(fs.existsSync(journalPath(root))).toBe(false);
}

/**
 * The destination is never a MIX. Exactly three states are legal at any
 * observation point: the complete old tree, the complete new tree, or briefly
 * absent (the window between the two renames, which the journal closes).
 */
function expectNotTorn(target: string): void {
  expect([OLD_DIGEST, NEW_DIGEST, ABSENT]).toContain(diskDigest(target));
}

describe('fsyncDirSync / fsyncDir (the DR-16 durability primitive)', () => {
  it('FsyncDirSync_RealDirectory_ReportsSyncedOrAnExplicitPlatformRefusal', () => {
    const dir = makeTempDir();

    const outcome = fsyncDirSync(dir);

    expect(outcome.directory).toBe(dir);
    if (outcome.status === 'synced') {
      expect(outcome.code).toBeUndefined();
    } else {
      // The only other legal answer: an EXPLICIT refusal carrying an errno from
      // the closed set. Never a silent success, never a blanket swallow.
      expect(outcome.status).toBe('unsupported');
      expect(DIRECTORY_SYNC_UNSUPPORTED_CODES).toContain(outcome.code);
    }

    if (process.platform === 'win32') {
      // Windows has no directory fsync: `open(dir)` succeeds and `fsync(fd)`
      // fails EPERM. Pinned so the degradation is a stated contract rather than
      // an accident nobody notices when it changes.
      expect(outcome.status).toBe('unsupported');
      expect(outcome.code).toBe('EPERM');
    }
  });

  it('FsyncDirSync_MissingDirectory_PropagatesEnoentRatherThanSwallowingIt', () => {
    // The degradation set is CLOSED on purpose. A vanished parent is a real
    // fault; laundering it into a cheerful "unsupported" would be the blanket
    // `catch {}` DR-16 exists to remove, merely wearing a typed return.
    const dir = makeTempDir();

    expect(() => fsyncDirSync(path.join(dir, 'no-such-dir'))).toThrow(/ENOENT/);
    expect(DIRECTORY_SYNC_UNSUPPORTED_CODES).not.toContain('ENOENT');
  });

  it('FsyncDir_MissingDirectory_PropagatesEnoentRatherThanSwallowingIt', async () => {
    const dir = makeTempDir();

    await expect(fsyncDir(path.join(dir, 'no-such-dir'))).rejects.toThrow(/ENOENT/);
  });

  it('FsyncDir_RealDirectory_MatchesTheSyncFormsDegradation', async () => {
    const dir = makeTempDir();

    const [sync, async] = [fsyncDirSync(dir), await fsyncDir(dir)];

    expect(async.status).toBe(sync.status);
    expect(async.code).toBe(sync.code);
  });
});

describe('publishTempFile — DR-16 parent-directory durability', () => {
  it('PublishTempFile_AfterRename_FsyncsParentDirectory', async () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'x.json');
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, '{"v":1}', 'utf8');

    const calls: string[] = [];
    const rename = vi.fn(async (from: string, to: string) => {
      calls.push('rename');
      await fsp.rename(from, to);
    });
    const syncDirectory = vi.fn(async (directory: string) => {
      calls.push(`syncDirectory:${directory}`);
      return fsyncDir(directory);
    });

    await publishTempFile(tmp, target, { rename, syncDirectory });

    // The PARENT directory — fsync'ing the file or the target path would prove
    // nothing about the directory entry the rename just created.
    expect(syncDirectory).toHaveBeenCalledTimes(1);
    expect(syncDirectory).toHaveBeenCalledWith(dir);
    // ...and AFTER the rename, not merely somewhere in the same function. An
    // fsync of the parent BEFORE the rename flushes a directory that does not
    // yet contain the new name, which is exactly as durable as doing nothing.
    expect(calls).toEqual(['rename', `syncDirectory:${dir}`]);
  });

  it('PublishTempFile_RenameNeverSucceeded_DoesNotClaimDirectoryDurability', async () => {
    // Makes "after the rename" mean something. A durability step that runs
    // unconditionally would also satisfy the test above; this one dies unless
    // the fsync is genuinely downstream of a SUCCESSFUL rename.
    const syncDirectory = vi.fn(async (directory: string): Promise<DirectorySyncOutcome> =>
      Promise.resolve({ directory, status: 'synced' }),
    );
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));

    await expect(
      publishTempFile('/tmp/a.tmp', '/tmp/a', { rename, syncDirectory }),
    ).rejects.toThrow(/ENOSPC/);

    expect(syncDirectory).not.toHaveBeenCalled();
  });
});

// ─── The promotion sequence (DR-16 ordering) ─────────────────────────────────

/** One observed step of a promotion, in the order the engine performed it. */
type PromotionOp =
  | { readonly op: 'rename'; readonly from: string; readonly to: string }
  | { readonly op: 'syncDirectory'; readonly directory: string; readonly journalOnDisk: boolean };

/**
 * A real `defaultPromotionIo` that records the two ops DR-16 is about. Only the
 * durability steps the ENGINE sequences are recorded (the default IO's internal
 * publish keeps its own seam), so the log is exactly the ordering under test.
 *
 * `journalOnDisk` is captured AT THE MOMENT of each fsync, which is what ties a
 * durability step to the journal rather than to whichever fsync happened to come
 * first — an index-only assertion would be satisfied by any earlier sync.
 */
function recordingPromotionIo(root: string, log: PromotionOp[]): PromotionIo {
  const base = defaultPromotionIo();
  return {
    ...base,
    rename: (from, to) => {
      log.push({ op: 'rename', from, to });
      base.rename(from, to);
    },
    syncDirectory: (directory) => {
      log.push({
        op: 'syncDirectory',
        directory,
        journalOnDisk: fs.existsSync(journalPath(root)),
      });
      return (base.syncDirectory ?? fsyncDirSync)(directory);
    },
  };
}

/**
 * DR-16 as a PREDICATE over the observed log, extracted so the identical check
 * can be run against a deliberately inverted log below. Without that twin, a
 * predicate that returned `true` for everything would look like a passing
 * ordering test.
 */
function journalIsDurableBeforeBackup(log: readonly PromotionOp[]): boolean {
  const backupAt = log.findIndex((e) => e.op === 'rename' && e.to.includes('.exarchos-backup'));
  const journalDurableAt = log.findIndex((e) => e.op === 'syncDirectory' && e.journalOnDisk);
  return backupAt >= 0 && journalDurableAt >= 0 && journalDurableAt < backupAt;
}

/**
 * The negative twin, built by MOVING one entry of the REAL log rather than by
 * hand-writing a synthetic one — so the twin differs from the passing case in
 * the ordering and in nothing else (no different substrate, no different op
 * shapes).
 */
function withJournalDurabilityMovedAfterBackup(log: readonly PromotionOp[]): PromotionOp[] {
  const journalAt = log.findIndex((e) => e.op === 'syncDirectory' && e.journalOnDisk);
  const backupAt = log.findIndex((e) => e.op === 'rename' && e.to.includes('.exarchos-backup'));
  const moved = log[journalAt];
  if (moved === undefined || backupAt < 0) throw new Error('log has no journal sync / backup rename');
  const rest = log.filter((_, index) => index !== journalAt);
  const insertAt = (journalAt < backupAt ? backupAt - 1 : backupAt) + 1;
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
}

describe('atomic promotion — DR-16 constructed ordering', () => {
  it('AtomicPromotion_JournalRename_IsDurablyOrderedBeforeBackup', () => {
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const log: PromotionOp[] = [];

    promoteTreeSync({ target, entries: NEW_TREE }, recordingPromotionIo(root, log));

    const backupAt = log.findIndex((e) => e.op === 'rename' && e.to.includes('.exarchos-backup'));
    const journalDurableAt = log.findIndex((e) => e.op === 'syncDirectory' && e.journalOnDisk);

    expect(backupAt).toBeGreaterThanOrEqual(0); // the backup rename really happened
    expect(journalDurableAt).toBeGreaterThanOrEqual(0); // a durability step really happened
    // THE claim: relative order, not mere presence. The journal is the only
    // record of where the OLD tree went, so its directory entry must reach
    // stable storage before the rename that moves the old tree away.
    expect(journalDurableAt).toBeLessThan(backupAt);
    expect(journalIsDurableBeforeBackup(log)).toBe(true);

    // Nothing was renamed at all before the journal was durable.
    expect(log.slice(0, journalDurableAt).some((e) => e.op === 'rename')).toBe(false);
  });

  it('AtomicPromotion_DurabilityStepMovedAfterBackup_FailsTheSameOrderingCheck', () => {
    // The inversion guard. If a future edit moves the journal's fsync below the
    // backup rename, the test above must go red — this proves the check can
    // distinguish, using the real log with exactly one entry relocated.
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const log: PromotionOp[] = [];

    promoteTreeSync({ target, entries: NEW_TREE }, recordingPromotionIo(root, log));

    const inverted = withJournalDurabilityMovedAfterBackup(log);

    expect(journalIsDurableBeforeBackup(log)).toBe(true);
    expect(journalIsDurableBeforeBackup(inverted)).toBe(false);
    // Same multiset of steps — only their order differs.
    expect(inverted.length).toBe(log.length);
    expect([...inverted].sort(byOpKey)).toEqual([...log].sort(byOpKey));
  });

  it('AtomicPromotion_EachTreeRename_IsImmediatelyFollowedByAParentDirectoryFsync', () => {
    // "after EACH tree rename", per DR-16's acceptance criteria. Immediately
    // after: a fsync deferred past the next rename would make the intervening
    // entry the unordered one.
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const log: PromotionOp[] = [];

    promoteTreeSync({ target, entries: NEW_TREE }, recordingPromotionIo(root, log));

    const renames = log
      .map((entry, index) => ({ entry, index }))
      .filter((seen): seen is { entry: Extract<PromotionOp, { op: 'rename' }>; index: number } =>
        seen.entry.op === 'rename',
      );

    // target → backup, then staging → target.
    expect(renames.map(({ entry }) => path.basename(entry.to))).toEqual([
      '.skills.exarchos-backup',
      'skills',
    ]);
    for (const { entry, index } of renames) {
      const next = log[index + 1];
      expect(next?.op).toBe('syncDirectory');
      expect(next?.op === 'syncDirectory' ? next.directory : undefined).toBe(
        path.dirname(entry.to),
      );
    }
  });

  it('AtomicPromotion_OnThisPlatform_ReportsDirectoryDurabilityRatherThanAssumingIt', () => {
    // The degradation is carried out to the CALLER, so "atomically promoted,
    // durability unproven by the platform" is distinguishable from "durably
    // promoted" instead of being swallowed at the fsync.
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);

    const report = promoteTreeSync({ target, entries: NEW_TREE });

    expect(report.directoryDurability.directory).toBe(root);
    if (process.platform === 'win32') {
      expect(report.directoryDurability.status).toBe('unsupported');
      expect(DIRECTORY_SYNC_UNSUPPORTED_CODES).toContain(report.directoryDurability.code);
    } else {
      expect(report.directoryDurability.status).toBe('synced');
    }
  });
});

/** Stable key for comparing two logs as multisets (order-insensitive). */
function byOpKey(a: PromotionOp, b: PromotionOp): number {
  const key = (entry: PromotionOp): string =>
    entry.op === 'rename'
      ? `rename\u0000${entry.from}\u0000${entry.to}`
      : `sync\u0000${entry.directory}\u0000${String(entry.journalOnDisk)}`;
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

// ─── The T3 convergence arm: a REAL SIGKILL between the two renames ──────────

/**
 * DR-16's second acceptance criterion — "a real-kill (SIGKILL) between the two
 * renames converges to old-complete or new-complete".
 *
 * This is a REAL kill, not a simulation. A child `node` process runs the real
 * `promoteTreeSync` against real directories, blocks the main thread at a chosen
 * instant (`Atomics.wait` with no timeout — no event loop turn remains, so the
 * process CANNOT unblock itself, run a `finally`, or flush anything), and the
 * parent sends `SIGKILL`. On win32 Node maps `SIGKILL` to `TerminateProcess`,
 * which is equally abrupt and uncatchable; the child gets no chance to clean up
 * on either platform. The engine's own rollback path is therefore never reached
 * — the only thing that can converge the destination is the on-disk journal read
 * by a LATER process, which is exactly what is being tested.
 *
 * What is injected is the PAUSE POINT and nothing else: the IO the child hands
 * `promoteTreeSync` is `defaultPromotionIo()` with `rename` wrapped to halt
 * before (or after) the commit rename and then delegate to the real one. Every
 * filesystem operation, including every fsync, is the production one.
 *
 * WHAT THIS ARM DOES NOT PROVE. `SIGKILL` kills a process, not a machine: the
 * page cache survives, so the OS still writes back everything the child had
 * done, fsync'd or not. This arm therefore proves ORDERING + RECOVERY converge
 * across an abrupt death; it does NOT and cannot prove the fsyncs themselves
 * matter — that needs a power cut or block-device fault injection, neither of
 * which is available here (and neither of which exists on Windows). The fsync
 * mechanism is pinned instead by the ordering tests above, which is why both
 * kinds of test are present rather than either alone.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_PACKAGE_DIR = path.resolve(HERE, '../..');
const PROMOTION_MODULE_URL = pathToFileURL(
  path.join(HERE, '../install/atomic-promotion.ts'),
).href;

type KillPoint = 'between-renames' | 'after-commit';

interface KillOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * The child program. Written out at test time (rather than committed) so the
 * crash harness cannot drift away from the module it is crashing, and so no
 * extra file has to be excluded from the vitest glob.
 */
function childSource(): string {
  return [
    `import * as fs from 'node:fs';`,
    `import { promoteTreeSync, defaultPromotionIo } from ${JSON.stringify(PROMOTION_MODULE_URL)};`,
    ``,
    `const [target, entriesFile, killPoint, markerPath] = process.argv.slice(2);`,
    `const entries = JSON.parse(fs.readFileSync(entriesFile, 'utf8'));`,
    `const base = defaultPromotionIo();`,
    ``,
    `function halt(stage) {`,
    `  fs.writeFileSync(markerPath, stage);`,
    `  // Block forever with no pending event-loop work. Nothing in this process`,
    `  // can run again; only the parent's SIGKILL ends it.`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
    `}`,
    ``,
    `const io = {`,
    `  ...base,`,
    `  rename: (from, to) => {`,
    `    const isCommitRename = from.indexOf('.exarchos-stage') >= 0;`,
    `    if (isCommitRename && killPoint === 'between-renames') halt('between-renames');`,
    `    base.rename(from, to);`,
    `    if (isCommitRename && killPoint === 'after-commit') halt('after-commit');`,
    `  },`,
    `};`,
    ``,
    `promoteTreeSync({ target, entries }, io);`,
    `console.log('PROMOTION_RAN_TO_COMPLETION_WITHOUT_BEING_KILLED');`,
  ].join('\n');
}

function tsxLoaderIsAvailable(): string {
  // Fail LOUDLY rather than skipping: a convergence arm that silently does not
  // run is worse than no convergence arm.
  return createRequire(import.meta.url).resolve('tsx');
}

async function promoteInChildAndSigkill(
  root: string,
  target: string,
  entries: readonly DigestEntry[],
  killPoint: KillPoint,
): Promise<KillOutcome> {
  tsxLoaderIsAvailable();
  const harness = path.join(root, 'harness');
  fs.mkdirSync(harness, { recursive: true });
  const childPath = path.join(harness, 'promote-child.ts');
  const entriesFile = path.join(harness, 'entries.json');
  const marker = path.join(harness, `marker-${killPoint}`);
  fs.writeFileSync(childPath, childSource(), 'utf8');
  fs.writeFileSync(entriesFile, JSON.stringify(entries), 'utf8');

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', childPath, target, entriesFile, killPoint, marker],
    { cwd: MCP_PACKAGE_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<KillOutcome>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });

  const deadline = Date.now() + 40_000;
  for (;;) {
    if (fs.existsSync(marker)) break;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `child exited before reaching '${killPoint}'\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(
        `child never reached '${killPoint}' within 40s\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  child.kill('SIGKILL');
  const outcome = await exited;
  // The promotion must have died mid-flight, not finished and then been killed.
  expect(stdout).not.toContain('PROMOTION_RAN_TO_COMPLETION_WITHOUT_BEING_KILLED');
  return outcome;
}

describe('atomic promotion — T3 SIGKILL convergence (DR-16)', () => {
  it('AtomicPromotion_RealSigkillBetweenRenames_ConvergesToOldCompleteNeverTorn', async () => {
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);

    const outcome = await promoteInChildAndSigkill(root, target, NEW_TREE, 'between-renames');

    // Killed, not exited. win32 reports TerminateProcess as a non-zero code with
    // no signal; POSIX reports the signal. Never a clean 0.
    expect(outcome.code).not.toBe(0);
    if (outcome.signal !== null) expect(outcome.signal).toBe('SIGKILL');

    // The instant of the kill: the OLD tree has been moved aside and the NEW one
    // is not yet in place. This is the exact window DR-16's ordering exists for.
    expect(fs.existsSync(target)).toBe(false);
    expectNotTorn(target);
    expect(diskDigest(backupDir(root))).toBe(OLD_DIGEST);
    expect(diskDigest(stageDir(root))).toBe(NEW_DIGEST);
    expect(fs.existsSync(journalPath(root))).toBe(true);

    // A later process converges the destination from the journal alone.
    expect(recoverInterruptedPromotion(target)).toBe(true);
    expect([OLD_DIGEST, NEW_DIGEST]).toContain(diskDigest(target));
    expect(diskDigest(target)).toBe(OLD_DIGEST); // OLD-COMPLETE arm
    expectNoScaffolding(root);
  });

  it('AtomicPromotion_RealSigkillAfterCommitRename_ConvergesToNewCompleteNeverTorn', async () => {
    // The other side of the disjunction, reached by the same harness one rename
    // later. Both arms must be REACHABLE or "old-complete or new-complete" is
    // satisfied by an implementation that only ever rolls back.
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);

    const outcome = await promoteInChildAndSigkill(root, target, NEW_TREE, 'after-commit');

    expect(outcome.code).not.toBe(0);
    if (outcome.signal !== null) expect(outcome.signal).toBe('SIGKILL');

    // Killed after the commit rename but before the best-effort cleanup: NEW is
    // already live, and the scaffolding is still on disk.
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNotTorn(target);
    expect(diskDigest(backupDir(root))).toBe(OLD_DIGEST);
    expect(fs.existsSync(journalPath(root))).toBe(true);

    expect(recoverInterruptedPromotion(target)).toBe(true);
    expect([OLD_DIGEST, NEW_DIGEST]).toContain(diskDigest(target));
    expect(diskDigest(target)).toBe(NEW_DIGEST); // NEW-COMPLETE arm
    expectNoScaffolding(root);
  });
});

// ─── The barrier PRECONDITION itself (DR-16, leg 2) ──────────────────────────

/**
 * `afterDurable` is the only link in the DR-16 chain the compiler cannot check:
 * every step's barrier has the same type, so threading the wrong one compiles
 * cleanly and can fail only at runtime. These tests exist because the guard was
 * initially shipped UNPINNED — neutering it to `return` left all 28 tests green,
 * which is the exact "comment wearing a type" the guard was built to prevent.
 *
 * The two halves of the condition are pinned SEPARATELY. A single test that
 * violates both at once would survive a mutation that dropped either arm of the
 * `||`, which would leave half the guard as decorative as the whole of it was.
 */
describe('afterDurable — the DR-16 durability precondition', () => {
  it('AfterDurable_BarrierCoversTheDirectory_Passes', () => {
    // The positive control: without it, a guard that threw unconditionally would
    // satisfy both negative tests below.
    const root = makeTempDir();

    expect(() =>
      afterDurable(
        { published: path.join(root, '.skills.exarchos-promote.json'), directory: { directory: root, status: 'synced' } },
        root,
      ),
    ).not.toThrow();
  });

  it('AfterDurable_BarrierPublishedInAnotherDirectory_ThrowsNamingTheMismatch', () => {
    // Violates ONLY `path.dirname(published) !== directory`: the fsync went to
    // the right directory, but the rename it claims to cover landed elsewhere.
    const root = makeTempDir();
    const elsewhere = makeTempDir();

    let thrown: unknown;
    try {
      afterDurable(
        { published: path.join(elsewhere, '.skills.exarchos-promote.json'), directory: { directory: root, status: 'synced' } },
        root,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PromotionError);
    expect((thrown as PromotionError).code).toBe('PROMOTE_FAILED');
    // The MISMATCH is what was detected — the message names the foreign
    // directory, not merely "something went wrong".
    expect((thrown as Error).message).toContain(elsewhere);
    expect((thrown as Error).message).toMatch(/durability barrier/);
  });

  it('AfterDurable_FsyncTargetedAnotherDirectory_ThrowsNamingTheMismatch', () => {
    // Violates ONLY `barrier.directory.directory !== directory`: the rename
    // landed in the right place but the fsync went somewhere else. This is the
    // dangerous half — a barrier that reports success while proving nothing
    // about the entry it names.
    const root = makeTempDir();
    const elsewhere = makeTempDir();

    let thrown: unknown;
    try {
      afterDurable(
        { published: path.join(root, '.skills.exarchos-promote.json'), directory: { directory: elsewhere, status: 'synced' } },
        root,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PromotionError);
    expect((thrown as PromotionError).code).toBe('PROMOTE_FAILED');
    expect((thrown as Error).message).toContain(elsewhere);
    expect((thrown as Error).message).toMatch(/durability barrier/);
  });
});

/**
 * A `PromotionIo` whose durability seam LIES about which directory it fsync'd,
 * on the `nth` call only (1-based). Everything else is the real IO.
 *
 * This is how the precondition is reachable end-to-end: `stagePlanFor` puts the
 * journal, backup and target in one parent, so no public entry point can hand a
 * step a barrier `published` elsewhere — but any seam can claim to have synced a
 * directory it did not.
 */
function lyingSyncDirectoryIo(nthCall: number, lie: string, log: string[]): PromotionIo {
  const base = defaultPromotionIo();
  let calls = 0;
  return {
    ...base,
    syncDirectory: (directory) => {
      calls += 1;
      log.push(directory);
      if (calls === nthCall) return { directory: lie, status: 'unsupported', code: 'EPERM' };
      return (base.syncDirectory ?? fsyncDirSync)(directory);
    },
  };
}

describe('atomic promotion — the barrier precondition is wired into the commit path', () => {
  it('AtomicPromotion_JournalBarrierFsyncsTheWrongDirectory_AbortsBeforeTouchingTheOldTree', () => {
    // Pins the FIRST `afterDurable` call site (in `backupExistingTarget`). A
    // journal whose durability cannot be vouched for must stop the promotion
    // before the old tree is moved aside — that rename is the irreversible one.
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const lie = path.join(root, 'not-the-parent');
    const synced: string[] = [];

    let thrown: unknown;
    try {
      promoteTreeSync({ target, entries: NEW_TREE }, lyingSyncDirectoryIo(1, lie, synced));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PromotionError);
    expect((thrown as PromotionError).code).toBe('PROMOTE_FAILED');
    const cause = (thrown as PromotionError).cause;
    expect(cause).toBeInstanceOf(PromotionError);
    expect((cause as Error).message).toContain(lie); // the mismatch, not just a failure
    expect((cause as Error).message).toMatch(/durability barrier/);

    // Aborted at the journal step: the backup rename never ran.
    expect(synced).toEqual([root]);
    expect(diskDigest(target)).toBe(OLD_DIGEST); // OLD-COMPLETE, untouched
    expectNoScaffolding(root);
  });

  it('AtomicPromotion_BackupBarrierFsyncsTheWrongDirectory_AbortsBeforeCommitAndRollsBack', () => {
    // Pins the SECOND `afterDurable` call site (in `promoteStagedTree`). The
    // lie lands on the backup rename's fsync — call 2 — so the promotion gets
    // past the journal, moves the old tree aside, and must then refuse to
    // commit and roll all the way back.
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const lie = path.join(root, 'not-the-parent');
    const synced: string[] = [];

    let thrown: unknown;
    try {
      promoteTreeSync({ target, entries: NEW_TREE }, lyingSyncDirectoryIo(2, lie, synced));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PromotionError);
    const cause = (thrown as PromotionError).cause;
    expect(cause).toBeInstanceOf(PromotionError);
    expect((cause as Error).message).toContain(lie);

    // It got PAST the journal (so this is genuinely the second call site, not
    // the first one firing again) and stopped before the commit rename.
    expect(synced.length).toBeGreaterThanOrEqual(2);
    expect(diskDigest(target)).toBe(OLD_DIGEST); // rolled back to OLD-COMPLETE
    expectNotTorn(target);
    expectNoScaffolding(root);
  });

  it('AtomicPromotion_DirectoryDurability_ReportsTheCommitStepsActualOutcomeNotAConstant', () => {
    // `directoryDurability` must carry the outcome the durability step ACTUALLY
    // produced. The platform test below pins the real value on this host, but it
    // is satisfied on POSIX by a hardcoded `{ status: 'synced' }` — so this test
    // feeds the seam a per-call sentinel no platform can produce, and pins that
    // the reported outcome is the COMMIT rename's (the last one), not the
    // journal's and not a constant.
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const produced: DirectorySyncOutcome[] = [];
    const io: PromotionIo = {
      ...defaultPromotionIo(),
      syncDirectory: (directory) => {
        const outcome: DirectorySyncOutcome = {
          directory, // honest about the directory, so `afterDurable` is satisfied
          status: 'unsupported',
          code: `SENTINEL_${produced.length}`,
        };
        produced.push(outcome);
        return outcome;
      },
    };

    const report = promoteTreeSync({ target, entries: NEW_TREE }, io);

    // journal, backup rename, commit rename.
    expect(produced.length).toBeGreaterThanOrEqual(3);
    expect(report.directoryDurability).toEqual(produced[produced.length - 1]);
    expect(report.directoryDurability.code).toBe(`SENTINEL_${produced.length - 1}`);
    // ...and specifically NOT the journal's outcome, which a naive wiring would
    // report because it is the first barrier the commit sequence produces.
    expect(report.directoryDurability).not.toEqual(produced[0]);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
  });
});
