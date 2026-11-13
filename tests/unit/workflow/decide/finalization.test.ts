/** Tests the finalization boundary with real SQLite transactions and literal source identities. */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../../../../src/events/store.js';
import { FinalizationChanged, FinalizationReplayFailed, validateFinalization } from '../../../../src/workflow/decide/finalization.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const releases: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0).reverse()) await release();
});

/** Opens a fresh event store without any host state. */
async function openStore(): Promise<EventStore> {
  const directory = makeTempDir('finalization-');
  releases.push(() => rmrfAsync(directory));
  const store = new EventStore(path.join(directory, 'state'));
  await store.initialize();
  releases.push(() => store.close());
  await store.append('finalization', { type: 'workflow.started', data: { featureId: 'finalization', workflowType: 'feature', phase: 'plan' } });
  return store;
}

/** A changed source at backend entry cannot pass an earlier caller-side validation. */
describe('Final lifecycle transaction', () => {
  it('EventStore_FinalValidation_AChangeAtTransactionEntry_RefusesTheStaleTrail', async () => {
    const store = await openStore();
    const backend = store.getAppender().ensureSqliteBackendSync();
    const original = backend.atomicDecideOnce.bind(backend);
    vi.spyOn(backend, 'atomicDecideOnce').mockImplementationOnce(async (args) => {
      await store.append('finalization', { type: 'workflow.transition', data: { featureId: 'finalization', from: 'plan', to: 'review' } });
      return original(args);
    });
    const trail = [{ type: 'workflow.cancel', data: { from: 'plan', to: 'cancelled' } }, { type: 'phase.entered', data: { phase: 'cancelled' } }];
    await expect(store.appendTrailAtomically('finalization', trail, 'stale-final-trail', (snapshot) => {
      validateFinalization(snapshot, { from: 'plan', foldAttemptId: undefined, phaseSequence: 1 });
    })).rejects.toBeInstanceOf(FinalizationChanged);
    expect((await store.query('finalization')).map((row) => row.type)).toEqual(['workflow.started', 'workflow.transition']);
    expect(backend.lookupOperationClaim('stale-final-trail')).toBeUndefined();
  });

  it('Finalization_ABrokenSnapshot_RejectsWithoutClaim', async () => {
    const store = await openStore();
    await store.append('finalization', { type: 'state.patched', data: { featureId: 'finalization', fields: ['artifacts[0].x'], patch: { 'artifacts[0].x': 1 } } });
    const before = await store.query('finalization');
    await expect(store.appendTrailAtomically('finalization', [{ type: 'workflow.cancel' }], 'broken-final-trail', (snapshot) => {
      validateFinalization(snapshot, { from: 'plan', foldAttemptId: undefined, phaseSequence: 1 });
    })).rejects.toBeInstanceOf(FinalizationReplayFailed);
    expect(await store.query('finalization')).toEqual(before);
    expect(store.getAppender().ensureSqliteBackendSync().lookupOperationClaim('broken-final-trail')).toBeUndefined();
  });
});
