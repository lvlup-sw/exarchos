/**
 * The child program of `multi-process-append.test.ts`. The test spawns one real OS process for
 * each writer. Each process opens its own `SqliteBackend` connection on one shared SQLite file,
 * so the writers contend on the cross-connection `BEGIN IMMEDIATE` and `SQLITE_BUSY` path.
 * Workers in one process share a connection, and the per-stream mutex of the appender serializes
 * them before SQLite sees contention.
 *
 * The program runs under `bun`, because `sqlite-backend.ts` imports `bun:sqlite`. The vitest
 * alias to `better-sqlite3` does not apply to a child process, so a `node` child fails at module
 * resolution. Under `bun`, the processes use the production driver. The program imports the
 * TypeScript source, so a change to `sqlite-backend.ts` shows in the next run with no compile.
 *
 * `--mode`, `--db`, `--stream` and `--tag` give the mode, the shared file, the shared stream and
 * the name of this writer.
 */

import * as fs from 'node:fs';

import { SqliteBackend } from '../../../src/storage/sqlite-backend.ts';

/**
 * The prefixes of the two JSON lines that the program writes to stdout. The parent finds each
 * line by its prefix, so logger output on the same stream does not confuse it.
 */
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

/**
 * `append` mode issues `--count` appends. The process first sleeps until the `--start-at` epoch
 * time, so all writers reach `BEGIN IMMEDIATE` together. It sleeps `--gap-ms` between appends.
 * With no gap, each writer finishes its burst before the others start, and the run is serial but
 * still dense and unique. A writer that exhausts its busy retries reports the error and goes on.
 *
 * `startup-repair` mode reads the sequence gate after `initialize()` and before any append, and
 * prints it in the READY line. It then waits for the `--go-file` sentinel, so the parent can
 * inspect the database before this process appends an event. Last, it issues one append.
 */
const mode = arg('mode', 'append');
const dbPath = arg('db');
const streamId = arg('stream');
const tag = arg('tag', 'solo');

/** Builds the event row of one append from the base sequence that the gate assigned. */
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

/**
 * The attempt budget of `initialize()` on `SQLITE_BUSY`. `initialize()` writes the schema and runs
 * the startup repair `repairSequenceHighWaterMarks`. The sibling processes run it at the same
 * time, before the `--start-at` barrier. Without a retry, a process that loses that race exits
 * before it writes its RESULT line. The backoff is random and not exponential, because processes
 * with one schedule collide again as a group.
 */
const INIT_ATTEMPTS = 10;
for (let attempt = 1; ; attempt++) {
  try {
    backend.initialize();
    break;
  } catch (err) {
    const busy = /SQLITE_BUSY|database is locked/i.test(String(err?.message ?? err));
    if (!busy || attempt >= INIT_ATTEMPTS) throw err;
    await Bun.sleep(25 + Math.floor(Math.random() * 75));
  }
}

if (mode === 'startup-repair') {
  const gateAfterInit = backend.readSequenceHighWaterMark(streamId);
  process.stdout.write(READY_PREFIX + JSON.stringify({ pid: process.pid, gateAfterInit }) + '\n');

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

  const waitMs = startAt - Date.now();
  if (waitMs > 0) await Bun.sleep(waitMs);

  const appends = [];
  let busyExhausted = 0;

  for (let i = 0; i < count; i++) {
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
