/**
 * A stored whole plan supplies guard membership. Document edits cannot change its task denominator.
 * @oracle-sources: ../../src/projections/guard-input/fold.ts, independent generated traces and literal task membership expectations
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { foldGuardInput } from '../../src/projections/guard-input/fold.js';
import { loadPreparedCustody, recheckPreparedAuthority, selectPreparedAuthority, verifyPreparedCustody } from '../../src/workflow/capsule/prepared-custody.js';
import { projectStateToFacts } from '../../src/workflow/admission/legacy-state-translation.js';
import { fixture, prepared, row, task, textOf } from '../helpers/capsule/prepared-authority.js';

function authority(text = textOf()) {
  const bundle = fixture(text);
  const selection = selectPreparedAuthority([prepared(bundle)], 'wf-capsule-corpus');
  if (!selection) throw new Error('Missing selection');
  const value = verifyPreparedCustody(selection, bundle);
  if (value.kind !== 'typed') throw new Error('Expected typed plan');
  return value;
}

describe('prepared plan authority', () => {
  it('Membership_ProjectDeletesPendingTask_KeepsIt', () => {
    const pin = authority();
    const rows = [prepared(), row(2, 'task.completed', { taskId: 'task-compile' }),
      row(3, 'state.patched', { patch: { tasks: [{ id: 'task-compile', status: 'complete' }] } })];
    const cleanup = vi.fn(() => false);
    const input = foldGuardInput(rows, { authoritativeTasks: pin.snapshot.tasks, cleanupEvidence: cleanup });
    expect(input.tasks).toMatchObject([{ id: 'task-compile', status: 'complete' }, { id: 'task-verify', status: 'pending' }, { id: 'later', status: 'pending' }]);
    expect(cleanup.mock.calls[0]?.[0]).toEqual(input);
    const facts = projectStateToFacts(input);
    expect(facts.fields).toMatchObject({ 'tasks.count': 3, 'tasks.allComplete': false });
  });
  it('Membership_LastFailureRow_Wins', () => {
    const pin = authority(textOf([task('T-01'), task('T-1')]));
    const rows = [row(1, 'task.completed', { taskId: 'T-01' }), row(2, 'task.failed', { taskId: 'T-01' }),
      row(3, 'task.completed', { taskId: 'unknown' })];
    expect(foldGuardInput(rows, { authoritativeTasks: pin.snapshot.tasks }).tasks).toMatchObject([
      { id: 'T-01', status: 'failed' }, { id: 'T-1', status: 'pending' },
    ]);
    expect(foldGuardInput([...rows, row(4, 'task.completed', { taskId: 'T-01' })], { authoritativeTasks: pin.snapshot.tasks }).tasks)
      .toMatchObject([{ id: 'T-01', status: 'complete' }, { id: 'T-1', status: 'pending' }]);
  });
  it('Membership_GeneratedDocumentEdits_DoNotChangeMembershipOrCompletion', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 15 }), fc.array(fc.tuple(fc.nat(18), fc.boolean()), { maxLength: 50 }),
      fc.array(fc.tuple(fc.nat(18), fc.string()), { maxLength: 20 }), (count, trace, edits) => {
        const tasks = Array.from({ length: count }, (_, n) => task(`T-${n}`));
        const pin = authority(textOf(tasks));
        const rows = trace.map(([n, done], i) => row(i + 1, done ? 'task.completed' : 'task.failed', { taskId: `T-${n}` }));
        rows.push(row(rows.length + 1, 'state.patched', { patch: { tasks: edits.map(([n, title]) => ({ id: `T-${n}`, title, status: 'complete' })) } }));
        const expected = tasks.map((t, n) => {
          const final = trace.filter(([id]) => id === n).at(-1);
          return { ...t, status: final === undefined ? 'pending' : final[1] ? 'complete' : 'failed' };
        });
        const actual = foldGuardInput(rows, { authoritativeTasks: pin.snapshot.tasks }).tasks;
        expect(actual).toMatchObject(expected);
        expect(Array.isArray(actual) && actual.length).toBe(count);
      }), { seed: 192704, numRuns: 150 });
  });
  it('Membership_ProseEditRetainsCompletionByExactId', () => {
    const rows = [row(1, 'task.completed', { taskId: 'task-compile' })];
    const before = authority();
    const after = authority(textOf().replace('Keep all work.', 'Preserve every task.'));
    expect(after.snapshot.digest).not.toBe(before.snapshot.digest);
    for (const pin of [before, after]) {
      expect(foldGuardInput(rows, { authoritativeTasks: pin.snapshot.tasks }).tasks)
        .toMatchObject([{ id: 'task-compile', status: 'complete' }, { id: 'task-verify', status: 'pending' }, { id: 'later', status: 'pending' }]);
    }
  });
  it('Custody_LoadOutsideCommit_ThenPureRecheckAndCurrentCompletion', async () => {
    const bundle = fixture();
    const rows = [prepared(bundle)];
    const selection = selectPreparedAuthority(rows, 'wf-capsule-corpus');
    if (!selection) throw new Error('Missing selection');
    let committing = false;
    const resolve = vi.fn(async () => {
      expect(committing).toBe(false);
      return Buffer.from(encodePreparedBundle(bundle));
    });
    const pin = await loadPreparedCustody(selection, { resolve });
    committing = true;
    rows.push(row(2, 'task.completed', { taskId: 'task-compile' }));
    expect(recheckPreparedAuthority(pin.selection, rows)).toBe(true);
    if (pin.kind !== 'typed') throw new Error('Expected typed plan');
    expect(foldGuardInput(rows, { authoritativeTasks: pin.snapshot.tasks }).tasks).toMatchObject([{ status: 'complete' }, { status: 'pending' }, { status: 'pending' }]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(recheckPreparedAuthority(pin.selection, [...rows, prepared(bundle, 3)])).toBe(false);
  });
  it('Custody_MissingOrCorruptBytes_NeverFallback', async () => {
    const selection = authority().selection;
    await expect(loadPreparedCustody(selection, { resolve: async () => { throw new Error('missing'); } })).rejects.toThrow('missing');
    await expect(loadPreparedCustody(selection, { resolve: async () => Buffer.from('{}') })).rejects.toThrow();
  });
});
