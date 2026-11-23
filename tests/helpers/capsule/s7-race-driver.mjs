/**
 * Holds a completed Git read after original SQLite gate claims or a segment terminal exist.
 * The Git wrapper passes its own barrier settings. Each read runs the real Git with the same argument vector, environment and standard input that the wrapper received.
 * The standard input carries the blob IDs of a `cat-file --batch` read, so the wrapper passes it on.
 * Only a constrained read that names the work tree of the barrier can hold. The capability probe names no work tree, so it never holds.
 */
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

/**
 * Run one Git read through the real Git, then hold it at the barrier when the original facts exist.
 * `settings` holds the real Git path, the tree, the task, the database, the stream, the mode and the barrier directory.
 */
export async function drive(settings) {
  const args = process.argv.slice(2);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(settings.realGit, args, { stdio: ['inherit', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL' });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === null) return reject(new Error(`Git stopped on signal ${signal}`));
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
  if (result.code === 0 && args.includes(`--work-tree=${settings.tree}`)) {
    const db = new Database(settings.database, { readonly: true });
    let facts;
    try {
      const rows = db.prepare('SELECT payload FROM events WHERE streamId = ? ORDER BY sequence').all(settings.stream).map(row => JSON.parse(row.payload));
      const claims = db.prepare('SELECT * FROM idempotency_claims ORDER BY streamId, idempotencyKey').all();
      const operations = claims.filter(claim => claim.streamId === '__decide_once_operations__');
      const bindings = claims.filter(claim => claim.streamId === '__segment_input_bindings_v1__');
      if (settings.mode === 'adequacy') {
        const signal = rows.find(row => row.type === 'gate.executed' && row.data?.gateName === 'test-adequacy' && row.data?.passed === true && row.data?.details?.taskId === settings.task);
        const evidence = rows.find(row => row.type === 'admission.evidence-recorded' && row.data?.evidence?.evidenceId === signal?.data?.details?.evidenceId);
        if (signal && evidence && evidence.sequence < signal.sequence) {
          const pair = [evidence, signal];
          const members = pair.map(row => claims.find(claim => claim.streamId === settings.stream && claim.idempotencyKey === row.idempotencyKey));
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
      const directory = settings.barrier;
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
}
