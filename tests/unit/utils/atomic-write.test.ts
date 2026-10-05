/**
 * Tests for the atomic file replace, and for the staged tree promotion that uses it.
 *
 * Real concurrent IO cannot provoke the win32 rename race on a Linux host. So the publish
 * tests stub the platform and inject the rename. A test that runs only on win32 leaves the
 * retry untested on each other lane.
 *
 * The promotion tests live here, not with `install/atomic-promotion.ts`. The durable order is
 * one property across two modules: `fsyncDirSync` and `DurabilityBarrier` here, and the
 * promotion sequence there. In two files, each half can pass while the order between them
 * regresses. These tests assert the order of calls through the injectable seams. They do not
 * assert that a directory fsync succeeds, because win32 refuses it.
 */
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
  atomicReplace,
  atomicWriteFile,
  pendingPublishTargets,
  readPublished,
  fsyncDir,
  fsyncDirSync,
  DIRECTORY_SYNC_UNSUPPORTED_CODES,
  PUBLISH_BACKOFF_CAP_MS,
  type DirectorySyncOutcome,
} from '../../../src/utils/atomic-write.js';
import {
  afterDurable,
  defaultPromotionIo,
  promoteTreeSync,
  recoverInterruptedPromotion,
  PromotionError,
  type PromotionIo,
} from '../../../src/install/atomic-promotion.js';
import { digestTree, type DigestEntry } from '../../../src/install/install-identity.js';
import { rmrf, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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

  /** POSIX never raises the rename race, so an `EPERM` there is a real permission fault with no retry. */
  it('PublishTempFile_PosixEperm_RethrowsWithoutRetrying', async () => {
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

  /** `ENOSPC` is not the race. A retry turns a hard failure into a stall. */
  it('PublishTempFile_Win32NonRaceError_RethrowsWithoutRetrying', async () => {
    stubPlatform('win32');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/ENOSPC/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  /**
   * A read-only file or a hostile ACL also reports `EPERM`, and the publish cannot tell them
   * from the race. So the loop must stop after a bounded count of attempts and rethrow.
   */
  it('PublishTempFile_Win32PermanentEperm_RethrowsAfterBoundedAttempts', async () => {
    stubPlatform('win32');
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(eperm());

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/EPERM/);

    expect(rename.mock.calls.length).toBeGreaterThan(1);
    expect(rename.mock.calls.length).toBeLessThanOrEqual(21);
  });

  /**
   * Two writers that collide at the same attempt number must sleep different durations,
   * or they collide again. Different delays across attempts do not prove that property.
   * A deterministic `5 * attempt` has such delays and still wakes each writer on one tick.
   * Each of the 24 writers collides one time, so each records only its attempt-0 sleep.
   */
  it('PublishTempFile_ManyWritersAtSameAttempt_SleepDifferentDurations', async () => {
    stubPlatform('win32');
    const attemptZeroDelays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      attemptZeroDelays.push(ms ?? 0);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

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

  /**
   * `Math.random` is pinned to its maximum, so the test measures the worst case.
   * With real jitter the total is random, and a publish over the budget fails only on rare runs.
   * Each sleep must respect the per-attempt cap, and the total must not exceed 1000 ms.
   */
  it('PublishTempFile_Win32WorstCaseBackoff_StaysInsideTheDocumentedBudget', async () => {
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

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) expect(d).toBeLessThanOrEqual(1 + PUBLISH_BACKOFF_CAP_MS);
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });

  /** Without the cleanup, each failed publish leaves its staged temp file next to the target. */
  it('PublishTempFile_TerminalFailure_RemovesTheStagedTempFile', async () => {
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

    await expect(fsp.access(tmp)).rejects.toThrow();
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  /** Cleanup is best-effort and must not hide the cause of the failed publish. */
  it('PublishTempFile_CleanupItselfFails_StillRethrowsTheOriginalError', async () => {
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

  /** An injected IO with no `unlink` gets no cleanup, and the original error still propagates. */
  it('PublishTempFile_IoWithoutUnlink_PublishesWithoutAttemptingCleanup', async () => {
    stubPlatform('linux');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', { rename })).rejects.toThrow(/ENOSPC/);
  });

  it('PublishTempFile_DefaultRename_PublishesRealFileOnThisPlatform', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publish-default-'));
    const target = path.join(dir, 'x.json');
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, '{"v":1}', 'utf-8');

    await publishTempFile(tmp, target);

    expect(await fsp.readFile(target, 'utf-8')).toBe('{"v":1}');
    await expect(fsp.access(tmp)).rejects.toThrow();
  });

  /**
   * Twelve writers with distinct temp files publish to one target.
   * Each writer must resolve, the target must hold the whole payload of one writer,
   * and no temp file can stay.
   */
  it('PublishTempFile_ConcurrentPublishersOneTarget_AllResolveAndTargetIsWhole', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'publish-concurrent-'));
    const target = path.join(dir, 'shared.json');
    const writers = Array.from({ length: 12 }, async (_, i) => {
      const tmp = `${target}.tmp.${i}`;
      await fsp.writeFile(tmp, JSON.stringify({ writer: i }), 'utf-8');
      await publishTempFile(tmp, target);
    });

    const results = await Promise.allSettled(writers);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const final = JSON.parse(await fsp.readFile(target, 'utf-8')) as { writer: number };
    expect(final.writer).toBeGreaterThanOrEqual(0);
    expect(final.writer).toBeLessThan(12);

    const leftover = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });
});

/** A rename seam that logs when each call starts and ends, and the most calls running at once. */
function recordingRename(): {
  rename: (from: string, to: string) => Promise<void>;
  log: string[];
  peak: () => number;
} {
  const log: string[] = [];
  let running = 0;
  let peak = 0;
  const rename = async (from: string): Promise<void> => {
    running++;
    peak = Math.max(peak, running);
    log.push(`start ${from}`);
    await new Promise((resolve) => setImmediate(resolve));
    log.push(`end ${from}`);
    running--;
  };
  return { rename, log, peak: () => peak };
}

describe('publishTempFile — writers to one target are serialized (#2028)', () => {
  /** The proof that our own renames to one path cannot overlap, which is what Windows refuses. */
  it('PublishTempFile_ConcurrentPublishersOneTarget_RenamesNeverOverlapAndRunInCallOrder', async () => {
    const seam = recordingRename();

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        publishTempFile(`/q/shared.json.${i}.tmp`, '/q/shared.json', { rename: seam.rename }),
      ),
    );

    expect(seam.peak()).toBe(1);
    expect(seam.log).toEqual(
      Array.from({ length: 8 }, (_, i) => [
        `start /q/shared.json.${i}.tmp`,
        `end /q/shared.json.${i}.tmp`,
      ]).flat(),
    );
  });

  /** The twin: the rig does see overlap, and the queue is per target, not one global lock. */
  it('PublishTempFile_ConcurrentPublishersDistinctTargets_RunConcurrently', async () => {
    const seam = recordingRename();

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        publishTempFile(`/q/own-${i}.json.tmp`, `/q/own-${i}.json`, { rename: seam.rename }),
      ),
    );

    expect(seam.peak()).toBe(8);
  });

  it('PublishTempFile_TwoSpellingsOfOneTarget_ShareOneQueue', async () => {
    const seam = recordingRename();

    await Promise.all([
      publishTempFile('/q/a.tmp', '/q/sub/../alias.json', { rename: seam.rename }),
      publishTempFile('/q/b.tmp', '/q/./alias.json', { rename: seam.rename }),
    ]);

    expect(seam.peak()).toBe(1);
  });

  /** NTFS names ignore case, so on win32 two spellings that differ only in case are one file. */
  it('PublishTempFile_Win32TargetsDifferingOnlyInCase_ShareOneQueue', async () => {
    stubPlatform('win32');
    const seam = recordingRename();

    await Promise.all([
      publishTempFile('/q/a.tmp', '/q/Case.json', { rename: seam.rename }),
      publishTempFile('/q/b.tmp', '/q/case.JSON', { rename: seam.rename }),
    ]);

    expect(seam.peak()).toBe(1);
  });

  it('PublishTempFile_PosixTargetsDifferingOnlyInCase_UseSeparateQueues', async () => {
    stubPlatform('linux');
    const seam = recordingRename();

    await Promise.all([
      publishTempFile('/q/a.tmp', '/q/Case.json', { rename: seam.rename }),
      publishTempFile('/q/b.tmp', '/q/case.JSON', { rename: seam.rename }),
    ]);

    expect(seam.peak()).toBe(2);
  });

  it('PublishTempFile_FailedPublish_DoesNotBlockTheNextWriter', async () => {
    stubPlatform('linux');
    const order: string[] = [];
    const failing = vi.fn<(from: string, to: string) => Promise<void>>(async () => {
      order.push('first');
      throw errWithCode('ENOSPC');
    });
    const passing = vi.fn<(from: string, to: string) => Promise<void>>(async () => {
      order.push('second');
    });

    const results = await Promise.allSettled([
      publishTempFile('/q/f1.tmp', '/q/f.json', { rename: failing }),
      publishTempFile('/q/f2.tmp', '/q/f.json', { rename: passing }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(order).toEqual(['first', 'second']);
  });

  /** The queue map holds only targets in use, so content-addressed writers cannot grow it forever. */
  it('PublishTempFile_AllPublishesSettled_LeavesNoQueueEntryBehind', async () => {
    const before = pendingPublishTargets();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = publishTempFile('/q/held.tmp', '/q/held.json', { rename: () => gate });

    expect(pendingPublishTargets()).toBe(before + 1);
    release();
    await pending;
    expect(pendingPublishTargets()).toBe(before);
  });

  /** A read in the queue waits for the publish before it and holds back the publish after it. */
  it('ReadPublished_InterleavedWithPublishesToOneTarget_NeverOverlapsARename', async () => {
    const seam = recordingRename();
    let reading = 0;
    let overlapped = false;
    const read = async (): Promise<void> => {
      reading++;
      if (seam.log.length % 2 === 1) overlapped = true;
      await new Promise((resolve) => setImmediate(resolve));
      reading--;
    };
    const rename = async (from: string, to: string): Promise<void> => {
      if (reading > 0) overlapped = true;
      await seam.rename(from, to);
    };

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => [
        publishTempFile(`/q/read.json.${i}.tmp`, '/q/read.json', { rename }),
        readPublished('/q/read.json', read),
      ]).flat(),
    );

    expect(seam.log).toHaveLength(12);
    expect(overlapped).toBe(false);
  });
});

describe('atomicReplace', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rmrfAsync(d)));
  });

  async function scratchDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-replace-'));
    dirs.push(dir);
    return dir;
  }

  it('AtomicReplace_StringAndBytes_ReplaceTheTargetAndLeaveNoTempFile', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'r.json');

    await atomicReplace(target, '{"v":1}');
    expect(await fsp.readFile(target, 'utf-8')).toBe('{"v":1}');
    await atomicReplace(target, Buffer.from('{"v":2}'));

    expect(await fsp.readFile(target, 'utf-8')).toBe('{"v":2}');
    expect(await fsp.readdir(dir)).toEqual(['r.json']);
  });

  /** Stage and rename are one queued task, so the last call wins whatever order the writes finish in. */
  it('AtomicReplace_ConcurrentWritersOneTarget_EndWithTheLastCallsWholeBytes', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'shared.json');
    const bulky = (i: number): string =>
      JSON.stringify({ writer: i, padding: Array.from({ length: 4000 }, () => `w${i}-chunk`) });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => atomicReplace(target, bulky(i))),
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const final = JSON.parse(await fsp.readFile(target, 'utf-8')) as { writer: number; padding: string[] };
    expect(final.writer).toBe(11);
    expect(new Set(final.padding).size).toBe(1);
    expect(await fsp.readdir(dir)).toEqual(['shared.json']);
  });

  /** Stage and rename hold the target's queue together, so a later publish sees the finished replace. */
  it('AtomicReplace_ALaterPublishToTheSameTarget_WaitsForTheWholeReplace', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'ordered.json');
    const laterTemp = path.join(dir, 'later.tmp');
    await fsp.writeFile(target, 'initial', 'utf-8');
    await fsp.writeFile(laterTemp, 'later', 'utf-8');
    let observed = '';

    const replace = atomicReplace(target, 'replaced');
    const later = publishTempFile(laterTemp, target, {
      rename: async (from, to) => {
        observed = await fsp.readFile(target, 'utf-8');
        await fsp.rename(from, to);
      },
    });
    await Promise.all([replace, later]);

    expect(observed).toBe('replaced');
    expect(await fsp.readFile(target, 'utf-8')).toBe('later');
  });

  it('AtomicReplace_RenameFails_RemovesTheTempFileAndKeepsTheTarget', async () => {
    stubPlatform('linux');
    const dir = await scratchDir();
    const target = path.join(dir, 'occupied');
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, 'inside.txt'), 'kept', 'utf-8');

    await expect(atomicReplace(target, 'payload')).rejects.toThrow();

    expect(await fsp.readdir(dir)).toEqual(['occupied']);
    expect(await fsp.readFile(path.join(target, 'inside.txt'), 'utf-8')).toBe('kept');
  });

  it('AtomicReplace_StagingFails_RejectsWithoutCreatingAnything', async () => {
    const dir = await scratchDir();

    await expect(atomicReplace(path.join(dir, 'missing', 'x.json'), 'payload')).rejects.toThrow(
      /ENOENT/,
    );

    expect(await fsp.readdir(dir)).toEqual([]);
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

  it('PublishTempFileSync_InjectedRename_ReplacesTheDefaultRename', () => {
    stubPlatform('linux');
    const calls: Array<[string, string]> = [];

    const barrier = publishTempFileSync('/q/s.tmp', '/q/s.json', {
      rename: (from, to) => {
        calls.push([from, to]);
      },
      syncDirectory: (directory): DirectorySyncOutcome => ({ directory, status: 'synced' }),
    });

    expect(calls).toEqual([['/q/s.tmp', '/q/s.json']]);
    expect(barrier.published).toBe('/q/s.json');
  });
});

describe('atomicWriteFile', () => {
  it('AtomicWriteFile_RoutesThroughSharedPublish_AndWritesContent', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
    const target = path.join(dir, 'z.json');

    atomicWriteFile(target, '{"ok":true}');

    expect(await fsp.readFile(target, 'utf-8')).toBe('{"ok":true}');
    const leftover = (await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });
});

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

/** Removes each temp root. A removal that fails does not fail the test. */
afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir === undefined) continue;
    try {
      rmrf(dir);
    } catch {
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
  /**
   * The outcome is `synced`, or `unsupported` with an errno from the closed set.
   * win32 cannot fsync a directory: `open(dir)` succeeds and `fsync(fd)` fails with `EPERM`.
   * The test pins that outcome, so a change to it is visible.
   */
  it('FsyncDirSync_RealDirectory_ReportsSyncedOrAnExplicitPlatformRefusal', () => {
    const dir = makeTempDir();

    const outcome = fsyncDirSync(dir);

    expect(outcome.directory).toBe(dir);
    if (outcome.status === 'synced') {
      expect(outcome.code).toBeUndefined();
    } else {
      expect(outcome.status).toBe('unsupported');
      expect(DIRECTORY_SYNC_UNSUPPORTED_CODES).toContain(outcome.code);
    }

    if (process.platform === 'win32') {
      expect(outcome.status).toBe('unsupported');
      expect(outcome.code).toBe('EPERM');
    }
  });

  /**
   * The unsupported set is closed. A missing parent is a real fault, and an `unsupported`
   * outcome for it hides that fault.
   */
  it('FsyncDirSync_MissingDirectory_PropagatesEnoentRatherThanSwallowingIt', () => {
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
  /**
   * The fsync must target the parent directory, because the rename made its entry there.
   * The fsync must come after the rename. A parent fsync before the rename flushes a
   * directory that does not hold the new name yet.
   */
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

    expect(syncDirectory).toHaveBeenCalledTimes(1);
    expect(syncDirectory).toHaveBeenCalledWith(dir);
    expect(calls).toEqual(['rename', `syncDirectory:${dir}`]);
  });

  /**
   * A durability step that runs unconditionally also passes the test above.
   * This test fails unless the fsync runs only after a successful rename.
   */
  it('PublishTempFile_RenameNeverSucceeded_DoesNotClaimDirectoryDurability', async () => {
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

/** One observed step of a promotion, in the order the engine performed it. */
type PromotionOp =
  | { readonly op: 'rename'; readonly from: string; readonly to: string }
  | { readonly op: 'syncDirectory'; readonly directory: string; readonly journalOnDisk: boolean };

/**
 * A real `defaultPromotionIo` that records each rename and each directory fsync that the
 * engine sequences. The internal publish of the default IO keeps its own seam, so the log
 * holds only the order under test.
 *
 * `journalOnDisk` is read at the moment of each fsync, and that ties a durability step to
 * the journal. An index-only assertion passes for any earlier fsync.
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
 * The ordering rule as a predicate over the log: the journal is durable before the backup rename.
 * It is a function, so a test can also run it against an inverted log.
 * Without that twin, a predicate that always returns `true` looks like a passing test.
 */
function journalIsDurableBeforeBackup(log: readonly PromotionOp[]): boolean {
  const backupAt = log.findIndex((e) => e.op === 'rename' && e.to.includes('.exarchos-backup'));
  const journalDurableAt = log.findIndex((e) => e.op === 'syncDirectory' && e.journalOnDisk);
  return backupAt >= 0 && journalDurableAt >= 0 && journalDurableAt < backupAt;
}

/**
 * The negative twin. It moves one entry of the real log, so the twin differs from the
 * passing case only in the order.
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
  /**
   * The claim is the relative order, not presence. The journal is the only record of where
   * the old tree went. So its directory entry must be durable before the rename that moves
   * the old tree away, and no rename can come before that fsync.
   */
  it('AtomicPromotion_JournalRename_IsDurablyOrderedBeforeBackup', () => {
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const log: PromotionOp[] = [];

    promoteTreeSync({ target, entries: NEW_TREE }, recordingPromotionIo(root, log));

    const backupAt = log.findIndex((e) => e.op === 'rename' && e.to.includes('.exarchos-backup'));
    const journalDurableAt = log.findIndex((e) => e.op === 'syncDirectory' && e.journalOnDisk);

    expect(backupAt).toBeGreaterThanOrEqual(0);
    expect(journalDurableAt).toBeGreaterThanOrEqual(0);
    expect(journalDurableAt).toBeLessThan(backupAt);
    expect(journalIsDurableBeforeBackup(log)).toBe(true);

    expect(log.slice(0, journalDurableAt).some((e) => e.op === 'rename')).toBe(false);
  });

  /**
   * The inversion guard: the predicate must fail on the real log with one entry moved.
   * Both logs hold the same steps, in a different order.
   */
  it('AtomicPromotion_DurabilityStepMovedAfterBackup_FailsTheSameOrderingCheck', () => {
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const log: PromotionOp[] = [];

    promoteTreeSync({ target, entries: NEW_TREE }, recordingPromotionIo(root, log));

    const inverted = withJournalDurabilityMovedAfterBackup(log);

    expect(journalIsDurableBeforeBackup(log)).toBe(true);
    expect(journalIsDurableBeforeBackup(inverted)).toBe(false);
    expect(inverted.length).toBe(log.length);
    expect([...inverted].sort(byOpKey)).toEqual([...log].sort(byOpKey));
  });

  /**
   * The renames are target to backup, then staging to target.
   * The parent fsync must come directly after each rename. An fsync that comes after
   * the next rename leaves the first entry with no proven order.
   */
  it('AtomicPromotion_EachTreeRename_IsImmediatelyFollowedByAParentDirectoryFsync', () => {
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

  /**
   * The caller receives the fsync outcome. So a caller can tell a durable promotion from
   * an atomic promotion whose durability the platform cannot prove.
   */
  it('AtomicPromotion_OnThisPlatform_ReportsDirectoryDurabilityRatherThanAssumingIt', () => {
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_PACKAGE_DIR = path.resolve(HERE, '../../..');
const PROMOTION_MODULE_URL = pathToFileURL(
  path.join(HERE, '../../../src/install/atomic-promotion.ts'),
).href;

type KillPoint = 'between-renames' | 'after-commit';

interface KillOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * The source of the child program. The test writes it at run time, so the harness
 * cannot drift from the module that it crashes.
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

/** Throws when `tsx` does not resolve. A convergence test that skips silently is worse than no test. */
function tsxLoaderIsAvailable(): string {
  return createRequire(import.meta.url).resolve('tsx');
}

/**
 * Runs the real `promoteTreeSync` in a child `node` process and kills it at `killPoint`.
 * The child blocks its main thread with `Atomics.wait`, so it cannot run a `finally` or flush.
 * Then the parent sends `SIGKILL`, which Node maps to `TerminateProcess` on win32.
 * The only injected part is the pause in `rename`. Each filesystem call is the production call.
 * The promotion must die before it completes, so the child must not print its completion line.
 */
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
  expect(stdout).not.toContain('PROMOTION_RAN_TO_COMPLETION_WITHOUT_BEING_KILLED');
  return outcome;
}

/**
 * A real kill during a promotion must converge to the complete old tree or the complete new tree.
 * The rollback of the engine never runs, so only the journal that a later process reads
 * can repair the destination.
 *
 * `SIGKILL` kills a process, not a machine, and the page cache survives. So these tests prove
 * that the order and the recovery converge. They cannot prove that the fsyncs matter.
 * The ordering tests above pin the fsync calls.
 */
describe('atomic promotion — T3 SIGKILL convergence (DR-16)', () => {
  /**
   * win32 reports the kill as a non-zero code with no signal, and POSIX reports the signal.
   * At the kill, the old tree is in the backup and the new tree is still in staging.
   * Then recovery from the journal alone restores the complete old tree.
   */
  it('AtomicPromotion_RealSigkillBetweenRenames_ConvergesToOldCompleteNeverTorn', async () => {
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);

    const outcome = await promoteInChildAndSigkill(root, target, NEW_TREE, 'between-renames');

    expect(outcome.code).not.toBe(0);
    if (outcome.signal !== null) expect(outcome.signal).toBe('SIGKILL');

    expect(fs.existsSync(target)).toBe(false);
    expectNotTorn(target);
    expect(diskDigest(backupDir(root))).toBe(OLD_DIGEST);
    expect(diskDigest(stageDir(root))).toBe(NEW_DIGEST);
    expect(fs.existsSync(journalPath(root))).toBe(true);

    expect(recoverInterruptedPromotion(target)).toBe(true);
    expect([OLD_DIGEST, NEW_DIGEST]).toContain(diskDigest(target));
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding(root);
  });

  /**
   * The kill comes after the commit rename and before the cleanup. So the new tree is live,
   * and the scaffolding is still on disk. Both outcomes must be reachable. If not, an
   * implementation that only rolls back satisfies "old-complete or new-complete".
   */
  it('AtomicPromotion_RealSigkillAfterCommitRename_ConvergesToNewCompleteNeverTorn', async () => {
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);

    const outcome = await promoteInChildAndSigkill(root, target, NEW_TREE, 'after-commit');

    expect(outcome.code).not.toBe(0);
    if (outcome.signal !== null) expect(outcome.signal).toBe('SIGKILL');

    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNotTorn(target);
    expect(diskDigest(backupDir(root))).toBe(OLD_DIGEST);
    expect(fs.existsSync(journalPath(root))).toBe(true);

    expect(recoverInterruptedPromotion(target)).toBe(true);
    expect([OLD_DIGEST, NEW_DIGEST]).toContain(diskDigest(target));
    expect(diskDigest(target)).toBe(NEW_DIGEST);
    expectNoScaffolding(root);
  });
});

/**
 * `afterDurable` is the one link that the compiler cannot check. Each barrier has the same
 * type, so a wrong barrier compiles and fails only at run time.
 *
 * The tests pin the two halves of the condition separately. One test that violates both
 * halves survives a mutation that removes one arm of the `||`.
 */
describe('afterDurable — the DR-16 durability precondition', () => {
  /** The positive control. Without it, a guard that always throws passes both negative tests below. */
  it('AfterDurable_BarrierCoversTheDirectory_Passes', () => {
    const root = makeTempDir();

    expect(() =>
      afterDurable(
        { published: path.join(root, '.skills.exarchos-promote.json'), directory: { directory: root, status: 'synced' } },
        root,
      ),
    ).not.toThrow();
  });

  /**
   * Violates only `path.dirname(published) !== directory`: the fsync went to the right
   * directory, but the rename went to another one. The message must name that directory.
   */
  it('AfterDurable_BarrierPublishedInAnotherDirectory_ThrowsNamingTheMismatch', () => {
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
    expect((thrown as Error).message).toContain(elsewhere);
    expect((thrown as Error).message).toMatch(/durability barrier/);
  });

  /**
   * Violates only `barrier.directory.directory !== directory`: the rename went to the right
   * place, but the fsync went to another directory. Such a barrier proves nothing about the
   * entry that it names.
   */
  it('AfterDurable_FsyncTargetedAnotherDirectory_ThrowsNamingTheMismatch', () => {
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
 * A `PromotionIo` whose `syncDirectory` reports the directory `lie` on call `nthCall` (1-based).
 * All other calls use the real IO.
 *
 * `stagePlanFor` puts the journal, the backup and the target in one parent. So no public
 * entry point can pass a barrier that was published in another directory. A seam can still
 * claim a directory that it did not sync, and that makes the precondition reachable.
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
  /**
   * Pins the `afterDurable` call in `backupExistingTarget`. When the journal barrier does not
   * cover the parent, the promotion must stop before the backup rename moves the old tree.
   */
  it('AtomicPromotion_JournalBarrierFsyncsTheWrongDirectory_AbortsBeforeTouchingTheOldTree', () => {
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
    expect((cause as Error).message).toContain(lie);
    expect((cause as Error).message).toMatch(/durability barrier/);

    expect(synced).toEqual([root]);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNoScaffolding(root);
  });

  /**
   * Pins the `afterDurable` call in `promoteStagedTree`. The lie is on call 2, the fsync of
   * the backup rename. So the promotion passes the journal step and moves the old tree aside.
   * Then it must refuse to commit and must roll back to the complete old tree.
   */
  it('AtomicPromotion_BackupBarrierFsyncsTheWrongDirectory_AbortsBeforeCommitAndRollsBack', () => {
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

    expect(synced.length).toBeGreaterThanOrEqual(2);
    expect(diskDigest(target)).toBe(OLD_DIGEST);
    expectNotTorn(target);
    expectNoScaffolding(root);
  });

  /**
   * The seam returns a sentinel code for each call, which no platform can produce.
   * Each outcome names the real directory, so `afterDurable` passes.
   * The calls are the journal, the backup rename and the commit rename.
   * `directoryDurability` must be the outcome of the last call, the commit rename.
   * A hardcoded `{ status: 'synced' }` passes the platform test on POSIX, and a naive
   * wiring reports the outcome of the journal.
   */
  it('AtomicPromotion_DirectoryDurability_ReportsTheCommitStepsActualOutcomeNotAConstant', () => {
    const root = makeTempDir();
    const target = path.join(root, 'skills');
    writeTree(target, OLD_TREE);
    const produced: DirectorySyncOutcome[] = [];
    const io: PromotionIo = {
      ...defaultPromotionIo(),
      syncDirectory: (directory) => {
        const outcome: DirectorySyncOutcome = {
          directory,
          status: 'unsupported',
          code: `SENTINEL_${produced.length}`,
        };
        produced.push(outcome);
        return outcome;
      },
    };

    const report = promoteTreeSync({ target, entries: NEW_TREE }, io);

    expect(produced.length).toBeGreaterThanOrEqual(3);
    expect(report.directoryDurability).toEqual(produced[produced.length - 1]);
    expect(report.directoryDurability.code).toBe(`SENTINEL_${produced.length - 1}`);
    expect(report.directoryDurability).not.toEqual(produced[0]);
    expect(diskDigest(target)).toBe(NEW_DIGEST);
  });
});
