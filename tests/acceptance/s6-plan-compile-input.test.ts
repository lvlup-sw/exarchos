/**
 * Exercises a complete typed feature through registered prepare and settle.
 * @oracle-sources: The approved bytes, authored task IDs and durable phase and completion rows.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

import { deriveLocalOperatorIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { foldGuardInput } from '../../src/projections/guard-input/fold.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 's6-typed-acceptance';
const BASE = 'integration';
const PLAN = 'design.md';
const IDS = ['T-01', 'T-02'];
const OK = 'node -e ""';

it('Acceptance_TypedFeature_PrepareAndSettleUsesApprovedPlan', async () => {
  const text = textOf(IDS.map(id => task(id, {
    title: id === IDS[0] ? 'Task 999 is only a title' : 'Second task',
    files: [`src/${id}.js`], testFiles: [`tests/${id}.test.js`],
  })));
  const checkout = await scopedRepository({
    integrationBranch: BASE,
    files: {
      [PLAN]: text,
      'package.json': JSON.stringify({
        type: 'module', scripts: { lint: OK, typecheck: OK, 'test:files': 'node --test', 'test:run': 'node --test' },
      }),
    },
  });
  const dir = makeTempDir('s6-typed-acceptance-');
  const events = new EventStore(dir);
  const context = { stateDir: dir, eventStore: events, callerIdentity: deriveLocalOperatorIdentity(dir), enableTelemetry: false };
  const orchestrate = (action: string, fields: Record<string, unknown>) =>
    dispatch('exarchos_orchestrate', { action, featureId: STREAM, ...fields }, context);
  const workflow = (action: string, fields: Record<string, unknown>) =>
    dispatch('exarchos_workflow', { action, featureId: STREAM, ...fields }, context);
  try {
    await events.initialize();
    const designDigest = createHash('sha256').update(text).digest('hex');
    const request = {
      repoRoot: checkout.checkout,
      intent: { mode: 'bootstrap', workflowType: 'feature', baseRef: BASE, designRef: PLAN,
        approval: { decision: 'approved', designDigest } },
    };
    const invalid = text.replace('"version":1', '"version":1,"version":1');
    await writeFile(path.join(checkout.checkout, PLAN), invalid);
    const invalidResult = await orchestrate('prepare', {
      ...request, intent: { ...request.intent, approval: { decision: 'approved', designDigest: createHash('sha256').update(invalid).digest('hex') } },
    });
    expect(invalidResult).toMatchObject({ success: false, error: { code: 'PLAN_UNSOUND' } });
    expect(await events.query(STREAM)).toEqual([]);

    await writeFile(path.join(checkout.checkout, PLAN), text);
    const first = await orchestrate('prepare', request);
    expect(first.success, JSON.stringify(first.error)).toBe(true);
    expect(first.data).toMatchObject({
      capsuleVersion: 1,
      capsule: {
        graph: { tasks: IDS.map(taskId => expect.objectContaining({ taskId, stepId: 'delegate' })) },
        provenance: { sources: expect.arrayContaining([{ sourceId: 'design-record', digest: designDigest }]) },
      },
    });
    const rows = await events.query(STREAM);
    const pin = selectPreparedAuthority(rows, STREAM);
    if (pin === undefined) throw new Error('Missing typed authority');
    const custody = await loadPreparedCustody(pin, events.bundleStore);
    if (custody.kind !== 'typed') throw new Error('Expected typed custody');
    expect(custody.snapshot.tasks.map(({ id }) => id)).toEqual(IDS);
    expect(custody.designRecord?.text).toBe(text);

    const patch = await workflow('update', { updates: { tasks: [] } });
    expect(patch.success, JSON.stringify(patch.error)).toBe(true);
    const denied = await workflow('transition', { target: 'review' });
    expect(denied).toMatchObject({ success: false, error: { code: 'GUARD_FAILED' } });

    const worktrees = await Promise.all(IDS.map(id => checkout.worktreeFor(id, { [`src/${id}.js`]: 'export const value = 2;\n' })));
    const settle = {
      capsuleVersion: 1, batchId: 'typed-wave',
      claims: IDS.map((taskId, i) => ({ taskId, fields: { worktreePath: worktrees[i], files: [`src/${taskId}.js`] }, evidence: [] })),
    };
    const verdict = await orchestrate('settle', settle);
    expect(verdict.success, JSON.stringify(verdict.error)).toBe(true);
    expect(verdict.data).toMatchObject({ outcome: 'settled', acceptedTasks: IDS, phaseMove: { kind: 'moved', from: 'delegate', to: 'review' } });
    const after = await events.query(STREAM);
    expect(after.filter(row => row.type === 'task.completed').map(row => row.data?.taskId)).toEqual(IDS);
    expect(after.filter(row => row.type === 'workflow.started')).toMatchObject([{ schemaVersion: '1.1', data: { initialPhase: 'plan' } }]);
    expect(after.filter(row => row.type === 'workflow.prepared')).toHaveLength(1);
    expect(after.filter(row => row.type === 'execution.settled')).toHaveLength(1);
    expect(after.filter(row => row.type === 'phase.entered').at(-1)?.data).toMatchObject({ phase: 'review' });
    expect(foldGuardInput(after, { authoritativeTasks: custody.snapshot.tasks }).tasks).toEqual(
      IDS.map(id => expect.objectContaining({ id, status: 'complete' })),
    );
    expect((await orchestrate('settle', settle)).data).toEqual(verdict.data);
    expect((await orchestrate('prepare', request)).data).toEqual(first.data);
    expect(await events.query(STREAM)).toEqual(after);
  } finally {
    events.close();
    await Promise.all([rmrfAsync(dir), rmrfAsync(checkout.root)]);
  }
}, 60_000);
