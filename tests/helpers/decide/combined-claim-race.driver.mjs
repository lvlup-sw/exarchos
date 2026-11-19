/** Runs one real combined handler winner while its parent pauses at an actual claim miss. */
import path from 'node:path';
import { existsSync, renameSync, writeFileSync } from 'node:fs';

import { EventStore } from '../../../src/events/store.ts';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.ts';
import { foldWorkflowState } from '../../../src/projections/guard-input/fold.ts';
import { configureStateStoreBackend } from '../../../src/workflow/state-store.ts';
import { handleSet } from '../../../src/workflow/tools.ts';

const [stateDir, featureId] = process.argv.slice(2);
if (!stateDir || !featureId) throw new Error('State directory and feature id are required');
const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
backend.initialize();
const eventStore = new EventStore(stateDir, { backend });
await eventStore.initialize();
configureStateStoreBackend(backend);
const query = eventStore.query.bind(eventStore);
const appender = eventStore.getAppender();
const decideOnce = appender.decideOnce.bind(appender);
let captured = false;
let operationId;
let requestDigest;

/** Returns the real captured outer snapshot only after the parent observes its initial claim miss. */
async function queryCapturedSnapshot(...args) {
  const rows = await query(...args);
  if (!captured && args[0] === featureId) {
    captured = true;
    const state = foldWorkflowState(rows);
    const readyTemp = path.join(stateDir, 'claim-ready.tmp');
    writeFileSync(readyTemp, JSON.stringify({ phase: state.phase, predecessor: state.phaseAttemptId }));
    renameSync(readyTemp, path.join(stateDir, 'claim-ready.json'));
    const deadline = Date.now() + 10000;
    while (!existsSync(path.join(stateDir, 'claim-go'))) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for parent claim miss');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await eventStore.append(featureId, { type: 'state.patched', data: { featureId, fields: ['tasks'], patch: { tasks: [{ id: 't1', title: 'old', status: 'pending' }] } } });
  }
  return rows;
}
eventStore.query = queryCapturedSnapshot;

/** Captures the actual operation identity without changing its decision or persisted claim. */
function recordDecision(id, digest, closure) {
  operationId = id;
  requestDigest = digest;
  return decideOnce(id, digest, closure);
}
appender.decideOnce = recordDecision;

try {
  const result = await handleSet({ featureId, phase: 'plan-review', updates: { 'artifacts.plan': 'plans/plan.md', 'tasks[0].title': 'renamed' } }, stateDir, eventStore);
  writeFileSync(path.join(stateDir, 'claim-done.json'), JSON.stringify({ result, operationId, requestDigest }));
  if (!result.success) process.exitCode = 1;
} catch (error) {
  writeFileSync(path.join(stateDir, 'claim-done.json'), JSON.stringify({ error: String(error) }));
  throw error;
} finally {
  await eventStore.close();
  backend.close();
  configureStateStoreBackend(undefined);
}
