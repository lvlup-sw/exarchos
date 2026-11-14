/** Holds a completed Git read after original SQLite gate claims or a segment terminal exist. */
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const args = process.argv.slice(2);
const result = await new Promise((resolve, reject) => {
  execFile(process.env.S7_REAL_GIT, args, { encoding: 'utf8', timeout: 15000 }, (error, stdout, stderr) => {
    if (error !== null && typeof error.code !== 'number') return reject(error);
    resolve({ code: error?.code ?? 0, stdout, stderr });
  });
});
const expected = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', process.env.S7_TREE, 'status', '--porcelain', '--untracked-files=all'];
if (result.code === 0 && args.length === expected.length && args.every((arg, i) => arg === expected[i])) {
  const db = new Database(process.env.S7_DATABASE, { readonly: true });
  let facts;
  try {
    const rows = db.prepare('SELECT payload FROM events WHERE streamId = ? ORDER BY sequence').all(process.env.S7_STREAM).map(row => JSON.parse(row.payload));
    const claims = db.prepare('SELECT * FROM idempotency_claims ORDER BY streamId, idempotencyKey').all();
    const operations = claims.filter(claim => claim.streamId === '__decide_once_operations__');
    const bindings = claims.filter(claim => claim.streamId === '__segment_input_bindings_v1__');
    if (process.env.S7_MODE === 'adequacy') {
      const signal = rows.find(row => row.type === 'gate.executed' && row.data?.gateName === 'test-adequacy' && row.data?.passed === true && row.data?.details?.taskId === process.env.S7_TASK);
      const evidence = rows.find(row => row.type === 'admission.evidence-recorded' && row.data?.evidence?.evidenceId === signal?.data?.details?.evidenceId);
      if (signal && evidence && evidence.sequence < signal.sequence) {
        const pair = [evidence, signal];
        const members = pair.map(row => claims.find(claim => claim.streamId === process.env.S7_STREAM && claim.idempotencyKey === row.idempotencyKey));
        const original = members.every((claim, i) => claim && JSON.stringify(JSON.parse(claim.events_json)) === JSON.stringify([pair[i]]) && JSON.stringify(JSON.parse(claim.sequences)) === JSON.stringify([pair[i].sequence]) && JSON.stringify(JSON.parse(claim.eventIds)) === JSON.stringify([pair[i].eventId]) && JSON.stringify(JSON.parse(claim.timestamps)) === JSON.stringify([pair[i].timestamp]));
        if (original && !rows.some(row => row.type === 'orchestrate.intent_executed' || row.type === 'execution.settled')) facts = { rows: pair, members, bindings, operations, argv: args };
      }
    } else {
      const terminal = rows.find(row => row.type === 'orchestrate.intent_executed');
      const operation = operations.find(claim => claim.idempotencyKey === terminal?.data?.operationId);
      if (terminal && operation && JSON.parse(operation.sequences).includes(terminal.sequence)) facts = { terminal, operation, bindings, argv: args };
    }
  } finally { db.close(); }
  if (facts) {
    const directory = process.env.S7_BARRIER;
    let owns = false;
    try { await mkdir(path.join(directory, 'owner')); owns = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (owns) {
      const temporary = path.join(directory, `ready.${process.pid}`);
      await writeFile(temporary, JSON.stringify(facts));
      await rename(temporary, path.join(directory, 'ready.json'));
      const deadline = Date.now() + 45000;
      while (true) {
        try { await access(path.join(directory, 'release')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (Date.now() > deadline) throw new Error('S7 Git barrier timed out');
        await setTimeout(15);
      }
    }
  }
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
