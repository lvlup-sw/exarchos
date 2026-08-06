/**
 * EFF-001 multi-process append driver (DR-19).
 *
 * Spawned as a REAL OS child process — one per contending writer — by
 * `multi-process-append.test.ts`. Each invocation opens its OWN
 * `SqliteBackend` connection against a SHARED SQLite file, which is the only
 * configuration that actually exercises the cross-connection
 * `BEGIN IMMEDIATE` / `SQLITE_BUSY` path. In-process workers (threads,
 * `Promise.all` over one backend) cannot: they share a connection and are
 * serialised by the appender's per-stream mutex long before SQLite's write
 * lock is ever contended.
 *
 * Run under `bun`, not `node`. That is deliberate, and it is the fix for the
 * defect that killed the original driver (#1324): `sqlite-backend.ts` imports
 * `bun:sqlite`, a virtual module that only resolves under Bun. vitest's
 * `bun:sqlite` -> `better-sqlite3` alias is configuration of the *vitest
 * process only* and is NOT inherited by a spawned child, so a `node` child
 * importing this module dies at resolve time. Running the child under `bun`
 * resolves `bun:sqlite` natively — which also means these processes contend
 * through the REAL production driver rather than through the test shim.
 *
 * Importing the TypeScript source directly (rather than driving the compiled
 * binary) is what keeps this fixture kill-probe-able: breaking the production
 * mechanism in `sqlite-backend.ts` is observable on the very next test run,
 * with no `bun build --compile` step in between.
 *
 * Protocol: argv carries the run parameters; single JSON lines are written to
 * stdout behind `EXARCHOS_DRIVER_READY ` / `EXARCHOS_DRIVER_RESULT ` prefixes
 * so the parent can parse them without being confused by logger chatter on
 * the same stream.
 *
 *   --mode <append|startup-repair>
 *   --db <path>        shared SQLite file
 *   --stream <id>      shared stream id
 *   --tag <label>      this writer's identity, stamped into each event
 *   --count <n>        appends to issue                          (append mode)
 *   --start-at <ms>    epoch-ms barrier; writers bust it together (append mode)
 *   --gap-ms <n>       sleep between appends, keeps writers overlapping (append)
 *   --go-file <path>   parent-created sentinel that releases the single append
 *                      (startup-repair mode)
 */

import * as fs from 'node:fs';

import { SqliteBackend } from '../../src/storage/sqlite-backend.ts';

const READY_PREFIX = 'EXARCHOS_DRIVER_READY ';
const RESULT_PREFIX = 'EXARCHOS_DRIVER_RESULT ';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required driver argument --${name}`);
  }
  return process.argv[idx + 1];
}

const mode = arg('mode', 'append');
const dbPath = arg('db');
const streamId = arg('stream');
const tag = arg('tag', 'solo');

/** Build one pre-allocated event row from the gate-assigned base. */
function finalizeOne(base, index) {
  const sequence = base + 1;
  const timestamp = new Date().toISOString();
  return {
    events: [
      {
        sequence,
        type: 'eff001.append-probe',
        timestamp,
        data: { tag, index },
        payload: JSON.stringify({
          eventId: `${tag}-${index}`,
          type: 'eff001.append-probe',
          sequence,
          timestamp,
          data: { tag, index },
        }),
      },
    ],
  };
}

const backend = new SqliteBackend(dbPath);

// `initialize()` is where the EFF-001 startup reconciliation
// (`repairSequenceHighWaterMarks`) runs. Everything the startup-repair mode
// observes below is therefore strictly AFTER repair and strictly BEFORE this
// process has accepted a single write.
backend.initialize();

if (mode === 'startup-repair') {
  // Read the gate through production code the instant init returns, with zero
  // appends issued by this process. This is the "before accepting writes" half
  // of the ordering claim.
  const gateAfterInit = backend.readSequenceHighWaterMark(streamId);
  process.stdout.write(READY_PREFIX + JSON.stringify({ pid: process.pid, gateAfterInit }) + '\n');

  // Hold here so the PARENT can independently inspect the database while this
  // process is provably still write-free. An end-state-only assertion could not
  // distinguish "repaired at startup" from "repaired lazily on first append";
  // pausing between the two lets the parent observe the ordering directly.
  const goFile = arg('go-file');
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error(`go-file never appeared: ${goFile}`);
    await Bun.sleep(10);
  }

  let firstSequence;
  let firstError;
  try {
    const result = await backend.atomicAppend({
      streamId,
      idempotencyKey: null,
      n: 1,
      finalize: (base) => finalizeOne(base, 0),
    });
    firstSequence = result.sequences[0];
  } catch (err) {
    firstError = err?.name ?? String(err);
  }

  backend.close();
  process.stdout.write(
    RESULT_PREFIX +
      JSON.stringify({ mode, pid: process.pid, gateAfterInit, firstSequence, firstError }) +
      '\n',
  );
} else {
  const count = Number(arg('count'));
  const startAt = Number(arg('start-at'));
  const gapMs = Number(arg('gap-ms', '2'));

  /**
   * Wall-clock barrier. Every writer spawns, opens its connection and runs
   * schema/init work at its own pace; without this they would trickle into the
   * write lock one at a time. Sleeping to a shared deadline makes all N writers
   * arrive at `BEGIN IMMEDIATE` together.
   */
  const waitMs = startAt - Date.now();
  if (waitMs > 0) await Bun.sleep(waitMs);

  const appends = [];
  let busyExhausted = 0;

  for (let i = 0; i < count; i++) {
    /**
     * Inter-append gap. Without it each writer completes its whole burst in
     * well under a millisecond — faster than its siblings can be scheduled off
     * the barrier — so the run degenerates into N CONTIGUOUS per-process blocks
     * (`aaa...bbb...ccc`). That run is still dense and unique, so the density
     * assertions pass while nothing was ever contended: precisely the
     * false-green this fixture exists to rule out. Measured directly: with no
     * gap the interleaving witness came back `runs: 3 / 60` — the serial floor.
     * Spreading each burst over tens of milliseconds keeps all N writers alive
     * in the write-lock queue simultaneously, so the lock must arbitrate.
     */
    if (i > 0 && gapMs > 0) await Bun.sleep(gapMs);

    const startedAt = Date.now();
    try {
      const result = await backend.atomicAppend({
        streamId,
        idempotencyKey: null,
        n: 1,
        finalize: (base) => finalizeOne(base, i),
      });
      appends.push({ index: i, sequence: result.sequences[0], startedAt, endedAt: Date.now() });
    } catch (err) {
      // A writer that loses its whole retry budget is a real outcome worth
      // reporting rather than crashing on — the parent asserts on it.
      if (err?.name === 'SqliteBusyExhaustedError') busyExhausted += 1;
      appends.push({
        index: i,
        error: err?.name ?? String(err),
        message: String(err?.message ?? '').slice(0, 300),
        startedAt,
        endedAt: Date.now(),
      });
    }
  }

  backend.close();
  process.stdout.write(
    RESULT_PREFIX + JSON.stringify({ mode, tag, pid: process.pid, appends, busyExhausted }) + '\n',
  );
}
