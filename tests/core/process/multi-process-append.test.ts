/**
 * Proves dense and unique sequences under a real multi-process append. Three OS processes each
 * hold their own `SqliteBackend` connection on one SQLite file, so they contend on the
 * cross-connection `BEGIN IMMEDIATE` and `SQLITE_BUSY` path. Workers in one process cannot reach
 * that path, because the per-stream mutex of the appender serializes them first.
 *
 * The children run under `bun`, because `sqlite-backend.ts` imports `bun:sqlite` and the vitest
 * alias to `better-sqlite3` does not apply to a child process.
 *
 * The test measures the contention, because a run with no overlap is also dense and unique. It
 * counts the contiguous blocks of one writer in sequence order, and it needs at least
 * `MIN_INTERLEAVE_RUNS` blocks.
 *
 * The second case builds a divergence between the gate and the tail on disk and starts a fresh
 * process. It observes from outside that the repair lands before that process accepts a write.
 */

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { needsWindowsShell } from '../../../src/utils/process.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DRIVER = path.join(__dirname, 'multi-process-append.driver.mjs');

const READY_PREFIX = 'EXARCHOS_DRIVER_READY ';
const RESULT_PREFIX = 'EXARCHOS_DRIVER_RESULT ';

/** The writers. Each one is a real child process, and the proof needs at least three. */
const WRITERS = ['alpha', 'bravo', 'charlie'] as const;
const APPENDS_PER_WRITER = 20;
const TOTAL_APPENDS = WRITERS.length * APPENDS_PER_WRITER;

/**
 * The lower bound on the interleaving witness. `runs` counts the maximal contiguous blocks of one
 * writer in sequence order. Serial writers score `WRITERS.length` (3), and perfect alternation
 * scores `TOTAL_APPENDS` (60). Repeated runs of this fixture scored 52 to 59. The bound is four
 * times the serial floor, so a serial run fails and scheduler jitter does not.
 */
const MIN_INTERLEAVE_RUNS = 12;

interface DriverAppend {
  readonly index: number;
  readonly sequence?: number;
  readonly error?: string;
  readonly message?: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

interface DriverResult {
  readonly mode: string;
  readonly tag?: string;
  readonly pid: number;
  readonly appends?: DriverAppend[];
  readonly busyExhausted?: number;
  readonly gateAfterInit?: number;
  readonly firstSequence?: number;
  readonly firstError?: string;
}

const tempDirs: string[] = [];

async function makeStoreDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eff001-mpa-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rmrfAsync(dir).catch(() => undefined);
  }
});

/**
 * Spawns one driver child under `bun`. `onReady` fires when the child prints its READY line. The
 * startup-repair case uses it to inspect the database before the child appends. On Windows, `bun`
 * is a shim that needs a shell, and `needsWindowsShell` holds that rule.
 */
function runDriver(
  args: readonly string[],
  onReady?: (payload: DriverResult) => void | Promise<void>,
): Promise<DriverResult> {
  return new Promise((resolve, reject) => {
    const useShell = needsWindowsShell('bun');
    const child = spawn('bun', [DRIVER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(useShell ? { shell: true } : {}),
    });

    let stdout = '';
    let stderr = '';
    let readyFired = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!readyFired && onReady) {
        const line = stdout.split('\n').find((l) => l.startsWith(READY_PREFIX));
        if (line) {
          readyFired = true;
          void onReady(JSON.parse(line.slice(READY_PREFIX.length)) as DriverResult);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(
          new Error(
            `driver produced no result (exit ${String(code)})\nargs: ${args.join(' ')}\n` +
              `stdout:\n${stdout.slice(0, 2000)}\nstderr:\n${stderr.slice(0, 4000)}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice(RESULT_PREFIX.length)) as DriverResult);
    });
  });
}

/** Opens the store read-only through `better-sqlite3`, with no production class. */
function inspect<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readGate(dbPath: string, streamId: string): number {
  return inspect(dbPath, (db) => {
    const row = db.prepare('SELECT sequence FROM sequences WHERE streamId = ?').get(streamId) as
      | { sequence: number }
      | undefined;
    return row ? row.sequence : 0;
  });
}

function readSequences(dbPath: string, streamId: string): number[] {
  return inspect(dbPath, (db) =>
    (
      db
        .prepare('SELECT sequence FROM events WHERE streamId = ? ORDER BY sequence')
        .all(streamId) as { sequence: number }[]
    ).map((r) => r.sequence),
  );
}

describe('EFF-001 multi-process append (DR-19)', () => {
  /**
   * The 5 s lead before `--start-at` lets each child spawn, open its connection and run its schema
   * init before the barrier. Without it, the writers arrive one at a time and the run is serial.
   * A writer that exhausts its `SQLITE_BUSY` budget at this load is an availability defect, so the
   * count must be 0. The `runs` witness proves the contention. Without it, the test passes on a
   * run in which the processes never overlap.
   */
  it(
    'MultiProcessAppend_ThreeProcesses_ProducesDenseUniqueSequences',
    async () => {
      const dir = await makeStoreDir();
      const dbPath = path.join(dir, 'exarchos.db');
      const streamId = 'eff001-shared-stream';

      const startAt = Date.now() + 5_000;

      const results = await Promise.all(
        WRITERS.map((tag) =>
          runDriver([
            '--mode',
            'append',
            '--db',
            dbPath,
            '--stream',
            streamId,
            '--tag',
            tag,
            '--count',
            String(APPENDS_PER_WRITER),
            '--start-at',
            String(startAt),
            '--gap-ms',
            '2',
          ]),
        ),
      );

      const pids = results.map((r) => r.pid);
      expect(new Set(pids).size, `expected ${WRITERS.length} distinct child PIDs, got ${pids.join()}`).toBe(
        WRITERS.length,
      );
      expect(pids, 'children must not be the vitest process').not.toContain(process.pid);

      const all = results.flatMap((r) => (r.appends ?? []).map((a) => ({ ...a, tag: r.tag! })));
      const failed = all.filter((a) => a.error !== undefined);
      expect(failed, `appends failed: ${JSON.stringify(failed.slice(0, 5))}`).toHaveLength(0);
      expect(all).toHaveLength(TOTAL_APPENDS);

      for (const r of results) expect(r.busyExhausted ?? 0).toBe(0);

      const assigned = all.map((a) => a.sequence!).sort((x, y) => x - y);
      expect(new Set(assigned).size, 'two processes were handed the same sequence').toBe(
        TOTAL_APPENDS,
      );

      expect(assigned).toEqual(Array.from({ length: TOTAL_APPENDS }, (_, i) => i + 1));

      expect(readSequences(dbPath, streamId)).toEqual(assigned);

      expect(readGate(dbPath, streamId)).toBe(TOTAL_APPENDS);

      const bySequence = [...all].sort((x, y) => x.sequence! - y.sequence!);
      let runs = 1;
      for (let i = 1; i < bySequence.length; i++) {
        if (bySequence[i]!.tag !== bySequence[i - 1]!.tag) runs++;
      }
      expect(
        runs,
        `writers did not interleave (runs=${runs}); the ${WRITERS.length} processes ran ` +
          `serially, so nothing about the cross-connection BEGIN IMMEDIATE path was proven. ` +
          `order=${bySequence.map((a) => a.tag[0]).join('')}`,
      ).toBeGreaterThanOrEqual(MIN_INTERLEAVE_RUNS);

      for (const tag of WRITERS) {
        expect(all.filter((a) => a.tag === tag)).toHaveLength(APPENDS_PER_WRITER);
      }
    },
    180_000,
  );

  /**
   * Production code writes the seed store of 10 events. The test then sets the gate to 4, below
   * the durable tail. That is the dangerous direction, because the next allocation gives sequence
   * 5 a second time.
   *
   * The `onReady` callback reads the database from this process after the child ran `initialize()`
   * and before it appends. A repair that waits for the first append still shows the diverged gate
   * at that point. The first append must then land at the tail plus one.
   */
  it(
    'StartupRepair_GateTailDivergence_RepairsBeforeAcceptingWrites',
    async () => {
      const dir = await makeStoreDir();
      const dbPath = path.join(dir, 'exarchos.db');
      const streamId = 'eff001-repair-stream';
      const SEEDED = 10;
      const DIVERGED_GATE = 4;

      const seed = await runDriver([
        '--mode',
        'append',
        '--db',
        dbPath,
        '--stream',
        streamId,
        '--tag',
        'seeder',
        '--count',
        String(SEEDED),
        '--start-at',
        String(Date.now()),
        '--gap-ms',
        '0',
      ]);
      expect((seed.appends ?? []).filter((a) => a.error !== undefined)).toHaveLength(0);
      expect(readGate(dbPath, streamId)).toBe(SEEDED);

      const writable = new Database(dbPath);
      writable.prepare('UPDATE sequences SET sequence = ? WHERE streamId = ?').run(
        DIVERGED_GATE,
        streamId,
      );
      writable.close();

      expect(readGate(dbPath, streamId)).toBe(DIVERGED_GATE);
      expect(Math.max(...readSequences(dbPath, streamId))).toBe(SEEDED);

      const goFile = path.join(dir, 'go.sentinel');
      const observed: { gate: number; eventCount: number; gateAfterInit: number }[] = [];

      const result = await runDriver(
        [
          '--mode',
          'startup-repair',
          '--db',
          dbPath,
          '--stream',
          streamId,
          '--tag',
          'restarted',
          '--go-file',
          goFile,
        ],
        async (ready) => {
          observed.push({
            gate: readGate(dbPath, streamId),
            eventCount: readSequences(dbPath, streamId).length,
            gateAfterInit: ready.gateAfterInit!,
          });
          await fsp.writeFile(goFile, 'go', 'utf8');
        },
      );

      expect(observed, 'child never reported readiness').toHaveLength(1);
      const snapshot = observed[0]!;
      expect(
        snapshot.eventCount,
        'the child accepted a write before we could observe the repair',
      ).toBe(SEEDED);
      expect(
        snapshot.gate,
        'gate was still diverged after startup — repair did not run before writes were accepted',
      ).toBe(SEEDED);
      expect(result.gateAfterInit).toBe(SEEDED);

      expect(result.firstError).toBeUndefined();
      expect(
        result.firstSequence,
        `first post-restart append must continue from the durable tail (${SEEDED + 1}), ` +
          `not from the diverged gate (${DIVERGED_GATE + 1})`,
      ).toBe(SEEDED + 1);

      const finalSequences = readSequences(dbPath, streamId);
      expect(finalSequences).toEqual(Array.from({ length: SEEDED + 1 }, (_, i) => i + 1));
      expect(new Set(finalSequences).size).toBe(SEEDED + 1);
      expect(readGate(dbPath, streamId)).toBe(SEEDED + 1);
    },
    180_000,
  );
});
