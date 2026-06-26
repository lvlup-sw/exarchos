import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AtomicAppender } from './atomic-appender.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

/**
 * T49 — POC acceptance test for the SQLite-backed event-store substrate
 * (DR-13, #1259).
 *
 * Anchor of the integration phase. Two acceptance assertions, derived
 * directly from the design's POC scope:
 *
 *   AC3 — AtomicAppender consumers unchanged.
 *     The substrate flip is gated on the seam holding: no consumer
 *     reaches into AtomicAppender internals, so swapping the body
 *     (JSONL → SQLite) requires zero changes outside the appender. We
 *     verify by enumerating the files under `src/` (excluding
 *     `__tests__/`, `__shims__/`, and `*.test.ts`) that mention the
 *     `AtomicAppender` symbol; the set must equal exactly the
 *     consumers the design pins (the four substrate-internal files plus
 *     the Wave-4 `decide`/`aggregateStream` primitive consumers —
 *     merge-orchestrate, execute-merge, and the WLM worktree manager).
 *
 *   Bench — SQLite append throughput ≥ 1000 ops/sec/stream.
 *     The performance SLA on `event-append` (testingStrategy line 1092
 *     of the plan). We construct an `AtomicAppender` with
 *     `backend: 'sqlite'`, drive 5,000 sequential appends to a single
 *     stream via `appendUnkeyed` (avoids polluting / FIFO-evicting the
 *     idempotency cache), and assert the measured ops/sec is at or
 *     above the threshold.
 *
 * RED expectation: the consumer enumeration passes today (seven
 * consumers match), but the bench is expected to fail until T50–T54
 * land the SQLite-backend tuning. Having one half pass and the other
 * fail is still a RED test — both must pass for T49 to flip GREEN at
 * the end of Phase 8.
 */

// v2.11 (DR-6, Phase 5b): `src/agents/spec.ts` was previously listed here
// because its `validateAgentSpec` JSDoc referenced `AtomicAppender` while
// surfacing the `spec.legacy_capabilities_array` deprecation event for the
// caller to flow through the appender. The legacy-capabilities path was
// hard-cut, so spec.ts no longer mentions the appender — the consumer set
// drops back to the four substrate-internal files.
//
// v2.10.0-preview.2 Wave 3 (#1314): the new `event-store/index.ts` barrel
// re-exports `AtomicAppender` (plus the Wave 3 typed errors) for Wave 4
// consumers. The barrel is a re-export site, NOT a behavioral change to
// the consumer set — it's still the substrate-internal cluster plus the
// public surface module.
//
// v2.10.0-preview.2 Wave 4 (#1340, audit §F1.2): the reference-migration
// commits add `orchestrate/merge-orchestrate.ts` (Phase A — `decide`
// commits `merge.requested` purely before the executor's git-merge side
// effect fires) as the first consumer outside the substrate-internal
// cluster. This is the canonical "consumer outside the storage cluster"
// the AC3 gate has been waiting for since Wave 3.
const EXPECTED_CONSUMERS = [
  'src/event-store/atomic-appender.ts',
  'src/event-store/index.ts',
  'src/event-store/store.ts',
  'src/event-store/tools.ts',
  'src/orchestrate/execute-merge.ts',
  'src/orchestrate/merge-orchestrate.ts',
  'src/orchestrate/worktree/manager.ts',
  'src/storage/sqlite-backend.ts',
] as const;

const BENCH_THRESHOLD_OPS_PER_SEC = 1000;
const BENCH_APPEND_COUNT = 5000;

/**
 * Resolve `servers/exarchos-mcp/src` from this file's URL. The test
 * sits at `src/event-store/poc.acceptance.test.ts`, so two `..` jumps
 * land at `src/`.
 */
function resolveSrcRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

/**
 * Recursively walk `dir` and return every `.ts` file path (relative to
 * `dir`'s parent — i.e. starting with `src/...`) that does NOT live
 * under `__tests__/` or `__shims__/` and does NOT end with `.test.ts`.
 *
 * The walk filters at the directory level (skip whole `__tests__/` and
 * `__shims__/` subtrees) and at the file level (`.test.ts` suffix).
 */
async function listProductionTsFiles(srcRoot: string): Promise<string[]> {
  const results: string[] = [];
  const repoRoot = path.dirname(srcRoot); // .../servers/exarchos-mcp

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const name of entries) {
      const full = path.join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) {
        if (name === '__tests__' || name === '__shims__') continue;
        await walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.test.ts')) continue;
      if (name.endsWith('.bench.ts')) continue;
      // Normalize to `src/...` form for stable assertions across
      // platforms (path.relative returns OS-flavored separators).
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      results.push(rel);
    }
  }

  await walk(srcRoot);
  return results;
}

describe('Poc_SqliteBackend_AllConsumersUnchangedAndBenchHits1000OpsPerSec', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'poc-acceptance-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('AC3 — exactly the expected src consumers reference AtomicAppender', async () => {
    const srcRoot = resolveSrcRoot();
    const candidates = await listProductionTsFiles(srcRoot);

    const consumers: string[] = [];
    for (const rel of candidates) {
      const repoRoot = path.dirname(srcRoot);
      const abs = path.join(repoRoot, rel);
      const text = await readFile(abs, 'utf-8');
      if (text.includes('AtomicAppender')) {
        consumers.push(rel);
      }
    }
    consumers.sort();

    expect(consumers).toEqual([...EXPECTED_CONSUMERS]);
  });

  // Throughput bench, not a portability check: the windows-latest runner with
  // the better-sqlite3 shim sustains a few hundred ops/sec, well under the
  // 1000 target this asserts. Skipping the *assertion* platform avoids a
  // perf-environment false-negative (the Linux suite enforces the real number).
  // (#1620)
  it.skipIf(process.platform === 'win32')('Bench — SQLite-backed appender hits ≥ 1000 ops/sec/stream', async () => {
    const appender = new AtomicAppender({ stateDir, backend: 'sqlite' });
    const streamId = 'poc-bench-stream';

    // Warm-up: lazy SQLite initialization, prepared-statement compile.
    // Pre-paying these costs prevents the first measured iteration from
    // dominating the average and producing a misleading rate.
    const warmup = await appender.appendUnkeyed(streamId, [
      { type: 'task.assigned', data: { warmup: true } },
    ]);
    expect(warmup.ok).toBe(true);

    // Defensive guard: if the SQLite dispatch silently fell back to
    // the JSONL body, the bench would still run but measure the wrong
    // substrate. Confirm a `.db` file was created and no `.events.jsonl`
    // sidecar was written.
    const entriesAfterWarmup = await readdir(stateDir);
    expect(entriesAfterWarmup.some(e => e.endsWith('.db'))).toBe(true);
    expect(entriesAfterWarmup.some(e => e.endsWith('.events.jsonl'))).toBe(false);

    const start = performance.now();
    for (let i = 0; i < BENCH_APPEND_COUNT; i++) {
      const r = await appender.appendUnkeyed(streamId, [
        { type: 'task.assigned', data: { i } },
      ]);
      // A non-ok result during the bench would skew the throughput
      // calculation; fail loudly instead so the rate measurement is
      // only over real, committed appends.
      if (!r.ok) {
        throw new Error(`bench append failed at i=${i}: reason=${r.reason}`);
      }
    }
    const elapsedMs = performance.now() - start;
    const opsPerSec = (BENCH_APPEND_COUNT / elapsedMs) * 1000;

    expect(opsPerSec).toBeGreaterThanOrEqual(BENCH_THRESHOLD_OPS_PER_SEC);
  });
});
