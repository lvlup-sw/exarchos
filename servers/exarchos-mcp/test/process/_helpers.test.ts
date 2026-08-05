// ─── T-38 / DR-29: process-tier binary build serialization ──────────────────
//
// `test/process/*.test.ts` files each call `ensureBinaryBuilt` from their own
// `beforeAll`. Because `vitest.config.ts` runs this suite with `pool: 'forks'`
// and default file parallelism, those files run concurrently in SEPARATE OS
// processes — a plain module-level promise memo would not serialize anything
// across them. `withBuildLock` (an exclusive lockfile created with the `wx`
// flag, which is atomic at the OS/filesystem layer) is what actually holds
// across processes, and `ensureBinaryBuilt` pairs it with a
// build-to-temp-dir + atomic-rename sequence so the canonical binary path
// never exposes a partially-written file.
//
// These cases exercise the REAL lock/rename primitives (real filesystem
// calls, real `wx`-flag exclusivity) with an injected/fake build step, so the
// race is proven hermetically — no `bun` invocation, no dependency on the
// real `dist/bin` artifact.
//
//   1. `withBuildLock` never lets two concurrent async critical sections run
//      at the same time, even when N calls are fired concurrently in ONE
//      process (`Promise.all`) — that is the primitive `ensureBinaryBuilt`
//      is built on.
//   2. A lock that looks abandoned (stale mtime) is reclaimed rather than
//      wedging every future run forever.
//   3. A lock that is genuinely still held times out with a clear error
//      instead of hanging.
//   4. `ensureBinaryBuilt`, fired N times concurrently with an injected
//      builder, runs the real build step EXACTLY ONCE — every other caller
//      observes the fresh artifact via the double-checked freshness recheck
//      instead of racing a second build.
//   5. No caller (nor an external observer polling the canonical path) ever
//      sees a partially-written binary — only the complete previous file or
//      the complete new one, because the write happens to a scratch temp
//      path and only the final `rename()` exposes it.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureBinaryBuilt, hostBinaryPath, withBuildLock } from './_helpers.js';

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
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('withBuildLock (T-38 / DR-29 mutual-exclusion primitive)', () => {
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
          // A real await point: if the lock were a no-op, another
          // "concurrent" caller's critical section could interleave here.
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
    // The lock file itself must not be left behind once every holder has
    // released it.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('WithBuildLock_StaleLock_IsReclaimedRatherThanHanging', async () => {
    const dir = await makeTempDir('exarchos-buildlock-stale-');
    const lockPath = path.join(dir, 'artifact.lock');

    // Simulate an abandoned lock: create it directly (bypassing the API)
    // and backdate its mtime far past any reasonable staleness window.
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

  it('WithBuildLock_GenuinelyHeldLock_TimesOutWithClearError', async () => {
    const dir = await makeTempDir('exarchos-buildlock-timeout-');
    const lockPath = path.join(dir, 'artifact.lock');

    // A FRESH lock (mtime "now") looks like an active holder, not an
    // abandoned one — the waiter must not reclaim it.
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
      // Slow, multi-step "build": if two of these ran concurrently against
      // the shared outDir/lock, this is exactly the window where they would
      // interleave.
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

    // No stray lock file or scratch build directory should survive.
    expect(fs.existsSync(`${expectedBinaryPath}.lock`)).toBe(false);
    const siblings = fs.readdirSync(path.dirname(expectedBinaryPath));
    expect(siblings.some((name) => name.startsWith('.build-tmp-'))).toBe(false);
  });

  it('EnsureBinaryBuilt_SlowBuilder_NeverExposesAPartiallyWrittenBinary', async () => {
    const repoRoot = await makeTempDir('exarchos-ensure-built-partial-');
    const expectedBinaryPath = hostBinaryPath(repoRoot);
    const chunks = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE'];
    const fullContent = chunks.join('');

    const fakeRunBuild = async (_repoRoot: string, outDir: string): Promise<void> => {
      const target = path.join(outDir, path.basename(expectedBinaryPath));
      // Write incrementally with real await points in between, to widen the
      // window during which a non-atomic "build straight to the canonical
      // path" implementation would expose a torn file.
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
