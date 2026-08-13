// ─── EFF-001 / DR-19: real multi-process append, proven with N OS processes
//
// The cross-connection `BEGIN IMMEDIATE` / `SQLITE_BUSY` path had no real
// fixture: the original subprocess driver was deleted (#1324) and never
// replaced, so INV-7's dense-unique-sequence guarantee was asserted but never
// demonstrated under genuine multi-process contention.
//
// What makes this fixture real, and why the cheaper shapes were rejected:
//
//   - N=3 SEPARATE OS PROCESSES, each with its OWN `SqliteBackend` connection
//     against ONE SQLite file. In-process workers (threads, `Promise.all` over
//     a single backend) would be serialised by the appender's per-stream mutex
//     and would never reach SQLite's write lock — they cannot exercise the
//     cross-connection path at all. The test asserts three distinct child PIDs,
//     none of them the vitest process, so this cannot silently regress into an
//     in-process fake.
//
//   - The children run under `bun`, not `node`. That is the fix for the defect
//     that killed the original driver (#1324): `sqlite-backend.ts` imports
//     `bun:sqlite`, and vitest's `bun:sqlite` -> `better-sqlite3` alias belongs
//     to the vitest process only — a spawned `node` child does not inherit it
//     and dies at module resolution. Under `bun` the children contend through
//     the REAL production driver.
//
//   - Contention is MEASURED, not assumed. Dense-and-unique is trivially true
//     of a run that never contended, so the fixture also asserts an
//     interleaving witness: the number of contiguous same-writer blocks in
//     sequence order. Three writers that never overlap produce exactly 3 (the
//     serial floor); genuine write-lock arbitration shatters that into dozens.
//     This is not hypothetical — the first version of this fixture measured
//     `runs: 3 / 60`, dense and unique and completely uncontended, until the
//     driver's inter-append gap was added.
//
// The second case covers DR-19's restart-repair arm: a gate/tail divergence is
// constructed on disk, a fresh process is started, and the repair is shown to
// land BEFORE that process accepts any write — observed externally, mid-flight,
// rather than inferred from the end state.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { needsWindowsShell } from '../../../src/utils/process.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DRIVER = path.join(__dirname, 'multi-process-append.driver.mjs');

const READY_PREFIX = 'EXARCHOS_DRIVER_READY ';
const RESULT_PREFIX = 'EXARCHOS_DRIVER_RESULT ';

/** N >= 3 real child processes, per DR-19's acceptance criteria. */
const WRITERS = ['alpha', 'bravo', 'charlie'] as const;
const APPENDS_PER_WRITER = 20;
const TOTAL_APPENDS = WRITERS.length * APPENDS_PER_WRITER;

/**
 * Lower bound on the interleaving witness. `runs` counts maximal contiguous
 * blocks of the same writer in sequence order, so perfectly serialised writers
 * score exactly `WRITERS.length` (3) and perfect alternation scores
 * `TOTAL_APPENDS` (60). Observed on this fixture across repeated runs: 52-59.
 * The bound sits at 4x the serial floor — far enough above 3 that an
 * accidentally-serialised run fails, far enough below 52 that ordinary
 * scheduler jitter does not flake it.
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
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Spawn one driver child. `onReady` fires when the child publishes its READY
 * line, which the startup-repair case uses to inspect the database while the
 * child is still provably write-free.
 */
function runDriver(
  args: readonly string[],
  onReady?: (payload: DriverResult) => void | Promise<void>,
): Promise<DriverResult> {
  return new Promise((resolve, reject) => {
    // `bun` is a `.cmd`/`.ps1` shim on Windows and cannot be spawned without a
    // shell; the repo already owns that rule rather than re-deriving it here.
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

/** Read-only inspection of the store, independent of any production class. */
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
  it(
    'MultiProcessAppend_ThreeProcesses_ProducesDenseUniqueSequences',
    async () => {
      const dir = await makeStoreDir();
      const dbPath = path.join(dir, 'exarchos.db');
      const streamId = 'eff001-shared-stream';

      // Generous lead time: every child must finish spawning, opening its own
      // connection and running schema init BEFORE the barrier, or the writers
      // trickle in one at a time and the run serialises by accident.
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

      // ─── These really were separate OS processes ──────────────────────────
      const pids = results.map((r) => r.pid);
      expect(new Set(pids).size, `expected ${WRITERS.length} distinct child PIDs, got ${pids.join()}`).toBe(
        WRITERS.length,
      );
      expect(pids, 'children must not be the vitest process').not.toContain(process.pid);

      // ─── Every append succeeded ───────────────────────────────────────────
      const all = results.flatMap((r) => (r.appends ?? []).map((a) => ({ ...a, tag: r.tag! })));
      const failed = all.filter((a) => a.error !== undefined);
      expect(failed, `appends failed: ${JSON.stringify(failed.slice(0, 5))}`).toHaveLength(0);
      expect(all).toHaveLength(TOTAL_APPENDS);

      // No writer may lose its whole SQLITE_BUSY budget at this contention
      // level — that would be a real availability defect, not a test artifact.
      for (const r of results) expect(r.busyExhausted ?? 0).toBe(0);

      // ─── Unique ───────────────────────────────────────────────────────────
      const assigned = all.map((a) => a.sequence!).sort((x, y) => x - y);
      expect(new Set(assigned).size, 'two processes were handed the same sequence').toBe(
        TOTAL_APPENDS,
      );

      // ─── Dense: exactly 1..N, nothing missing ─────────────────────────────
      expect(assigned).toEqual(Array.from({ length: TOTAL_APPENDS }, (_, i) => i + 1));

      // The durable rows must agree with what the writers were told.
      expect(readSequences(dbPath, streamId)).toEqual(assigned);

      // ─── High-water mark consistent with the appended set ─────────────────
      expect(readGate(dbPath, streamId)).toBe(TOTAL_APPENDS);

      // ─── Contention actually happened ─────────────────────────────────────
      // Order the writers by the sequence each was granted and count contiguous
      // same-writer blocks. Serialised writers score exactly WRITERS.length;
      // real write-lock arbitration shatters that. Without this assertion the
      // case above passes on a run where the processes never overlapped at all.
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

      // Every writer must have won some of the contested slots — an interleaved
      // run in which one process did nothing is not 3-way contention.
      for (const tag of WRITERS) {
        expect(all.filter((a) => a.tag === tag)).toHaveLength(APPENDS_PER_WRITER);
      }
    },
    180_000,
  );

  it(
    'StartupRepair_GateTailDivergence_RepairsBeforeAcceptingWrites',
    async () => {
      const dir = await makeStoreDir();
      const dbPath = path.join(dir, 'exarchos.db');
      const streamId = 'eff001-repair-stream';
      const SEEDED = 10;
      const DIVERGED_GATE = 4;

      // ─── Arrange: a healthy store, written by production code ─────────────
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

      // ─── Arrange: drive the gate BELOW the durable tail ───────────────────
      // This is the dangerous direction (dogfood CB-1): the next allocation
      // would re-issue sequence 5, which is already persisted.
      const writable = new Database(dbPath);
      writable.prepare('UPDATE sequences SET sequence = ? WHERE streamId = ?').run(
        DIVERGED_GATE,
        streamId,
      );
      writable.close();

      // The divergence is real before we restart anything.
      expect(readGate(dbPath, streamId)).toBe(DIVERGED_GATE);
      expect(Math.max(...readSequences(dbPath, streamId))).toBe(SEEDED);

      // ─── Act: restart into a fresh process, and observe it MID-FLIGHT ─────
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
          // The child has completed `initialize()` and has issued ZERO appends.
          // Inspecting from OUT HERE, in a different process, is what makes this
          // an ordering claim rather than an end-state claim: a lazily-repairing
          // implementation would still show the diverged gate at this instant.
          observed.push({
            gate: readGate(dbPath, streamId),
            eventCount: readSequences(dbPath, streamId).length,
            gateAfterInit: ready.gateAfterInit!,
          });
          await fsp.writeFile(goFile, 'go', 'utf8');
        },
      );

      // ─── Assert the ORDERING: repaired while still write-free ─────────────
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
      // ...and production code inside the child saw the repaired gate too.
      expect(result.gateAfterInit).toBe(SEEDED);

      // ─── Assert the CONSEQUENCE: the first write lands past the tail ──────
      expect(result.firstError).toBeUndefined();
      expect(
        result.firstSequence,
        `first post-restart append must continue from the durable tail (${SEEDED + 1}), ` +
          `not from the diverged gate (${DIVERGED_GATE + 1})`,
      ).toBe(SEEDED + 1);

      // ─── Assert the END STATE stayed dense and unique ─────────────────────
      const finalSequences = readSequences(dbPath, streamId);
      expect(finalSequences).toEqual(Array.from({ length: SEEDED + 1 }, (_, i) => i + 1));
      expect(new Set(finalSequences).size).toBe(SEEDED + 1);
      expect(readGate(dbPath, streamId)).toBe(SEEDED + 1);
    },
    180_000,
  );
});
