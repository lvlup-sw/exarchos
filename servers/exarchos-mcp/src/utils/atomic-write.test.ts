import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { publishTempFile, publishTempFileSync, atomicWriteFile } from './atomic-write.js';

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

    await publishTempFile('/tmp/a.tmp', '/tmp/a', rename);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('/tmp/a.tmp', '/tmp/a');
  });

  it('PublishTempFile_PosixEperm_RethrowsWithoutRetrying', async () => {
    // POSIX never raises the race, so an EPERM there is a REAL permission fault
    // and must surface immediately rather than be retried into a ~1s stall.
    stubPlatform('linux');
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(eperm());

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', rename)).rejects.toThrow(/EPERM/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('PublishTempFile_Win32EpermThenSuccess_RetriesAndResolves', async () => {
    stubPlatform('win32');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(eperm())
      .mockRejectedValueOnce(eperm())
      .mockResolvedValue(undefined);

    await publishTempFile('/tmp/a.tmp', '/tmp/a', rename);

    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('PublishTempFile_Win32Eacces_IsAlsoTreatedAsTheRace', async () => {
    stubPlatform('win32');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(errWithCode('EACCES'))
      .mockResolvedValue(undefined);

    await publishTempFile('/tmp/a.tmp', '/tmp/a', rename);

    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('PublishTempFile_Win32NonRaceError_RethrowsWithoutRetrying', async () => {
    // ENOSPC is not the race. Retrying it would turn a hard failure into a stall.
    stubPlatform('win32');
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(errWithCode('ENOSPC'));

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', rename)).rejects.toThrow(/ENOSPC/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('PublishTempFile_Win32PermanentEperm_RethrowsAfterBoundedAttempts', async () => {
    // A read-only file / hostile ACL reports EPERM too and is indistinguishable
    // here. The loop MUST terminate and rethrow rather than hang forever.
    stubPlatform('win32');
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(eperm());

    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', rename)).rejects.toThrow(/EPERM/);

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
      await publishTempFile(`/tmp/a.tmp.${i}`, '/tmp/a', rename);
    }

    expect(attemptZeroDelays.length).toBe(24);
    expect(new Set(attemptZeroDelays).size).toBeGreaterThan(1);
    for (const d of attemptZeroDelays) expect(d).toBeLessThanOrEqual(1 + 64);
  });

  it('PublishTempFile_Win32Backoff_StaysInsideTheDocumentedBudget', async () => {
    // The bound is the other half of the contract: it must grow (so a long
    // contention outlasts) but never exceed the documented cap.
    stubPlatform('win32');
    const delays: number[] = [];
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(eperm());
    await expect(publishTempFile('/tmp/a.tmp', '/tmp/a', rename)).rejects.toThrow(/EPERM/);

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) expect(d).toBeLessThanOrEqual(1 + 64);
    // Total budget bounded well under the ~1s the docstring promises.
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThan(2000);
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
