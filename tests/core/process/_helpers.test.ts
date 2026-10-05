/**
 * Tests the build serialization of `ensureBinaryBuilt` and `withBuildLock` in `_helpers.ts`. The
 * cases use the real lock and rename calls on a real filesystem, with an injected fake build
 * step. No case runs `bun` or reads the real `dist/bin` binary.
 *
 * This file declares no oracle sources. The suite-invariant sweep puts it in scope for one
 * `readdirSync` call. That call is the leak check for a `.build-tmp-` scratch directory in a temp
 * directory that the test made. The check compares the listing with a prefix literal copied from
 * `_helpers.ts`, so it has no second source to name. The gap `dr29/process-helpers-fs-sweep` in
 * `tests/core/integration/suite-invariants/registry.ts` owns the obligation.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureBinaryBuilt, hostBinaryPath, withBuildLock } from './_helpers.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rmrfAsync(dir).catch(() => undefined);
  }
});

describe('withBuildLock (T-38 / DR-29 mutual-exclusion primitive)', () => {
  /**
   * The guarded section holds a real await, so a lock that does nothing lets a second caller in.
   * The lock file must be gone after the last release.
   */
  it('WithBuildLock_NConcurrentCallers_NeverOverlapAndAllRun', async () => {
    const dir = await makeTempDir('exarchos-buildlock-');
    const lockPath = path.join(dir, 'artifact.lock');

    const CONCURRENCY = 8;
    let active = 0;
    let maxActive = 0;
    let totalRuns = 0;

    const runOne = () =>
      withBuildLock(
        lockPath,
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await delay(20);
          totalRuns++;
          active--;
        },
        { pollIntervalMs: 5 },
      );

    await Promise.all(Array.from({ length: CONCURRENCY }, () => runOne()));

    expect(totalRuns, 'every caller must have run the guarded section').toBe(CONCURRENCY);
    expect(
      maxActive,
      'two callers were inside the lock-guarded section at the same time',
    ).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  /**
   * The test writes the lock file directly and sets its mtime 60 s into the past. The `staleMs` of
   * the call is 1 s, so the lock counts as abandoned.
   */
  it('WithBuildLock_StaleLock_IsReclaimedRatherThanHanging', async () => {
    const dir = await makeTempDir('exarchos-buildlock-stale-');
    const lockPath = path.join(dir, 'artifact.lock');

    fs.writeFileSync(lockPath, '999999');
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, longAgo, longAgo);

    let ran = false;
    const result = await withBuildLock(
      lockPath,
      () => {
        ran = true;
        return 'done';
      },
      { staleMs: 1_000, pollIntervalMs: 5, timeoutMs: 5_000 },
    );

    expect(ran, 'a stale lock must be reclaimed, not treated as permanently held').toBe(true);
    expect(result).toBe('done');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  /** A lock file with a fresh mtime is a live holder, so the waiter must not reclaim it. */
  it('WithBuildLock_GenuinelyHeldLock_TimesOutWithClearError', async () => {
    const dir = await makeTempDir('exarchos-buildlock-timeout-');
    const lockPath = path.join(dir, 'artifact.lock');

    fs.writeFileSync(lockPath, String(process.pid));

    try {
      await expect(
        withBuildLock(lockPath, () => 'unreachable', {
          staleMs: 60_000,
          pollIntervalMs: 5,
          timeoutMs: 80,
        }),
      ).rejects.toThrow(/Timed out.*build lock/);
    } finally {
      fs.unlinkSync(lockPath);
    }
  });
});

describe('ensureBinaryBuilt (T-38 / DR-29 serialized build)', () => {
  /**
   * The fake build has two await points, where two builds that are not serialized interleave.
   * One caller must build. No lock file and no `.build-tmp-` scratch directory must remain.
   */
  it('EnsureBinaryBuilt_NConcurrentCallers_BuildsExactlyOnceAndNeverOverlaps', async () => {
    const repoRoot = await makeTempDir('exarchos-ensure-built-repo-');
    const expectedBinaryPath = hostBinaryPath(repoRoot);
    const expectedContent = 'FAKE-BINARY-PAYLOAD-v1';

    let active = 0;
    let maxActive = 0;
    let buildInvocations = 0;

    const fakeRunBuild = async (_repoRoot: string, outDir: string): Promise<void> => {
      active++;
      maxActive = Math.max(maxActive, active);
      buildInvocations++;
      await delay(15);
      const target = path.join(outDir, path.basename(expectedBinaryPath));
      await fsp.writeFile(target, expectedContent, 'utf8');
      await delay(15);
      active--;
    };

    const CONCURRENCY = 6;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        ensureBinaryBuilt(repoRoot, {
          runBuild: fakeRunBuild,
          lockOptions: { pollIntervalMs: 5 },
        }),
      ),
    );

    expect(
      buildInvocations,
      'the injected builder must run exactly once across all concurrent callers',
    ).toBe(1);
    expect(maxActive, 'two builders ran inside the guarded section at once').toBe(1);

    for (const result of results) {
      expect(result.binaryPath).toBe(expectedBinaryPath);
    }
    const rebuiltCount = results.filter((r) => r.rebuilt).length;
    expect(
      rebuiltCount,
      'exactly one caller should have performed (and observed) the real build',
    ).toBe(1);

    expect(fs.existsSync(expectedBinaryPath)).toBe(true);
    expect(fs.readFileSync(expectedBinaryPath, 'utf8')).toBe(expectedContent);

    expect(fs.existsSync(`${expectedBinaryPath}.lock`)).toBe(false);
    const siblings = fs.readdirSync(path.dirname(expectedBinaryPath));
    expect(siblings.some((name) => name.startsWith('.build-tmp-'))).toBe(false);
  });

  /**
   * The fake build appends the content in chunks with an await after each chunk. In that window, a
   * build that writes straight to the final path shows a partial file to the observer loop.
   */
  it('EnsureBinaryBuilt_SlowBuilder_NeverExposesAPartiallyWrittenBinary', async () => {
    const repoRoot = await makeTempDir('exarchos-ensure-built-partial-');
    const expectedBinaryPath = hostBinaryPath(repoRoot);
    const chunks = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE'];
    const fullContent = chunks.join('');

    const fakeRunBuild = async (_repoRoot: string, outDir: string): Promise<void> => {
      const target = path.join(outDir, path.basename(expectedBinaryPath));
      for (const chunk of chunks) {
        await fsp.appendFile(target, chunk, 'utf8');
        await delay(10);
      }
    };

    let stopObserving = false;
    const observations: string[] = [];
    const observe = async (): Promise<void> => {
      while (!stopObserving) {
        if (fs.existsSync(expectedBinaryPath)) {
          observations.push(fs.readFileSync(expectedBinaryPath, 'utf8'));
        }
        await delay(2);
      }
    };
    const observer = observe();

    await ensureBinaryBuilt(repoRoot, {
      runBuild: fakeRunBuild,
      lockOptions: { pollIntervalMs: 5 },
    });
    stopObserving = true;
    await observer;

    expect(fs.readFileSync(expectedBinaryPath, 'utf8')).toBe(fullContent);
    for (const observation of observations) {
      expect(
        observation,
        `observed a partially-written binary: ${JSON.stringify(observation)}`,
      ).toBe(fullContent);
    }
  });

  it('EnsureBinaryBuilt_AlreadyFreshBinary_SkipsBuildEntirely', async () => {
    const repoRoot = await makeTempDir('exarchos-ensure-built-fresh-');
    const binaryPath = hostBinaryPath(repoRoot);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, 'already-built');

    let calls = 0;
    const result = await ensureBinaryBuilt(repoRoot, {
      runBuild: () => {
        calls++;
      },
    });

    expect(result.rebuilt).toBe(false);
    expect(calls, 'a fresh binary must not trigger a rebuild').toBe(0);
  });
});
