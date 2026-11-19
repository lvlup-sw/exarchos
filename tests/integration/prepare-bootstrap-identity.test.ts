/**
 * Bootstrap binds the first entry to the exact durable claim.
 * @oracle-sources: ../../src/workflow/definitions/feature.workflow.json, authored requests and ledger trails in this file
 */
import { mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDigest } from '../../src/contract/request-context.js';
import * as eventFactory from '../../src/events/event-factory.js';
import * as designReader from '../../src/workflow/design-record/read.js';
import { readStateFile } from '../../src/workflow/state-store.js';
import { bootstrapFixture, BASE, planText, receipt, REF, STREAM } from '../helpers/capsule/bootstrap-store.js';
import { releaseCheckDefinition } from '../helpers/definitions/user-definition.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('bootstrap receipt identity', () => {
  it('Bootstrap_StartV11_EqualsValidatedEntry', async () => {
    const s = await bootstrapFixture(cleanup);
    const first = receipt(await s.call());
    const rows = await s.events.query(STREAM);
    expect(rows.map(({ type }) => type)).toEqual([
      'workflow.started', 'state.patched', 'phase.entered',
      'workflow.transition', 'phase.exited', 'phase.entered',
      'workflow.transition', 'workflow.compound-entry', 'phase.exited', 'phase.entered',
      'task.assigned', 'workflow.prepared',
    ]);
    expect(rows[0]).toMatchObject({
      schemaVersion: '1.1', streamId: STREAM, sequence: 1,
      data: { initialPhase: 'plan', phaseAttemptId: expect.any(String), repoRoot: path.join(s.checkout, '.git') },
    });
    expect(rows.at(-1)?.data?.bootstrapRequestDigest).toBe(requestDigest({
      protocol: 'prepare-bootstrap-request-v1', streamId: STREAM, repoRoot: s.checkout,
      intent: { ...s.intent(), designDepth: 'standard', refactor: null },
    }));
    expect(first.tailSequence).toBe(rows.length);
    const group = rows.find(({ type }) => type === 'workflow.compound-entry');
    expect(group?.data).toMatchObject({ featureId: STREAM, compoundStateId: 'implementation' });
    expect(await readStateFile(s.stateFile)).toMatchObject({
      featureId: STREAM, workflowType: 'feature', phase: 'delegate', _eventSequence: rows.length,
      artifacts: { plan: REF, design: REF }, planReview: { approved: true },
      tasks: [{ id: 'task-0', status: 'pending' }], synthesis: { integrationBranch: BASE },
    });
    expect(receipt(await s.call(s.intent(undefined, { designDepth: 'standard' }), {}, {
      repoRoot: `${s.checkout}/./`,
    }))).toEqual(first);
  });

  it('Bootstrap_RefactorOverhaul_UsesOnlyValidatedScopeFacts', async () => {
    const s = await bootstrapFixture(cleanup);
    const refactor = { track: 'overhaul', scopeAssessment: 'Cross-cutting refactor' };
    const intent = s.intent(undefined, { workflowType: 'refactor', refactor });
    const first = receipt(await s.call(intent));
    const rows = await s.events.query(STREAM);
    expect(rows[0]?.data?.initialPhase).toBe('explore');
    expect(rows.filter(({ type }) => type === 'phase.exited').map(({ data }) => data?.phase)).toEqual([
      'explore', 'brief', 'overhaul-plan', 'overhaul-plan-review',
    ]);
    expect(await readStateFile(s.stateFile)).toMatchObject({ workflowType: 'refactor', track: 'overhaul',
      explore: { scopeAssessment: refactor.scopeAssessment } });
    expect(receipt(await s.call(intent))).toEqual(first);
  });

  it('Bootstrap_ChangedHeadAfterCommit_ReplaysOriginal', async () => {
    const s = await bootstrapFixture(cleanup);
    const first = receipt(await s.call());
    s.setHead('b'.repeat(40));
    s.observe.mockClear();
    s.commitOf.mockClear();
    expect(receipt(await s.call(undefined, { compilerVersion: 'new-compiler' }))).toEqual(first);
    expect(s.observe).not.toHaveBeenCalled();
    expect(s.commitOf).not.toHaveBeenCalled();
  });

  it('Bootstrap_MissingFileAndBundle_ReplaysClaim', async () => {
    const s = await bootstrapFixture(cleanup);
    const first = receipt(await s.call());
    await unlink(path.join(s.checkout, REF));
    const bundles = s.events.bundleStore;
    await rename(bundles.root, `${bundles.root}-removed`);
    const read = vi.spyOn(bundles, 'resolve');
    const design = vi.spyOn(designReader, 'readDesignRecordAt');
    const put = vi.spyOn(bundles, 'put');
    s.observe.mockClear();
    expect(receipt(await s.call())).toEqual(first);
    expect(s.observe).not.toHaveBeenCalled();
    expect(design).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('Bootstrap_ForgedMarkerWithoutClaim_Refuses', async () => {
    const s = await bootstrapFixture(cleanup);
    const first = receipt(await s.call());
    const rows = await s.events.query(STREAM);
    const lookup = vi.spyOn(s.backend, 'lookupOperationClaim').mockReturnValue(undefined);
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_INTEGRITY' } });
    expect(lookup).toHaveBeenCalledWith(first.operationId);
    expect(await s.events.query(STREAM)).toEqual(rows);
  });

  it.each(['claim-stream', 'claim-digest', 'claim-sequence', 'claim-event', 'receipt-tail', 'receipt-bundle', 'frozen-depth'] as const)(
    'Bootstrap_Corrupt_%s_RefusesTheReplay', async (corruption) => {
      const s = await bootstrapFixture(cleanup);
      const first = receipt(await s.call());
      const claim = s.backend.lookupOperationClaim(first.operationId);
      if (claim === undefined) throw new Error('The bootstrap did not commit a claim.');
      if (corruption === 'frozen-depth') {
        const query = s.events.query.bind(s.events);
        vi.spyOn(s.events, 'query').mockImplementation(async (...args) => (await query(...args)).map((row) =>
          row.type === 'phase.entered' && row.data?.kind === 'PLAN'
            ? { ...row, data: { ...row.data, designDepth: 'thin' } } : row));
      } else {
        vi.spyOn(s.backend, 'lookupOperationClaim').mockReturnValue({
          ...claim,
          ...(corruption === 'claim-stream' ? { streamId: 'another-stream' } : {}),
          ...(corruption === 'claim-digest' ? { requestDigest: 'other-digest' } : {}),
          ...(corruption === 'claim-sequence' ? { sequences: claim.sequences.slice(0, -1) } : {}),
          ...(corruption === 'claim-event' ? { eventIds: [...claim.eventIds.slice(0, -1), 'forged-event'] } : {}),
          result: {
            ...first,
            ...(corruption === 'receipt-tail' ? { tailSequence: first.tailSequence + 1 } : {}),
            ...(corruption === 'receipt-bundle' ? { bundleRefs: [] } : {}),
          },
        });
      }
      s.observe.mockClear();
      expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_INTEGRITY' } });
      expect(s.observe).not.toHaveBeenCalled();
    },
  );

  it('Bootstrap_LegacyNoMarker_Conflicts', async () => {
    const s = await bootstrapFixture(cleanup);
    await s.events.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
    expect(s.observe).not.toHaveBeenCalled();
    expect(await s.events.query(STREAM)).toHaveLength(1);
  });

  it('Bootstrap_PathUnsafeSubject_RefusesBeforeReads', async () => {
    const s = await bootstrapFixture(cleanup);
    const query = vi.spyOn(s.events, 'query');
    expect(await s.call(undefined, {}, { streamId: '../escaped' })).toMatchObject({
      success: false, error: { code: 'INVALID_INPUT' },
    });
    expect(query).not.toHaveBeenCalled();
    expect(s.observe).not.toHaveBeenCalled();
  });

  it('Bootstrap_InvalidStartRow_CommitsNothing', async () => {
    const s = await bootstrapFixture(cleanup);
    const build = eventFactory.buildValidatedEvent;
    const start = vi.spyOn(eventFactory, 'buildValidatedEvent').mockImplementation((streamId, sequence, input) =>
      input.type === 'workflow.started'
        ? build(streamId, sequence, { ...input, data: { ...input.data, initialPhase: 42 } })
        : build(streamId, sequence, input));
    const put = vi.spyOn(s.events.bundleStore, 'put');
    expect(await s.call()).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
    expect(start).toHaveBeenCalledWith(STREAM, 1, expect.objectContaining({ type: 'workflow.started', schemaVersion: '1.1' }));
    expect(await s.events.query(STREAM)).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    await expect(readStateFile(s.stateFile)).rejects.toMatchObject({ code: 'STATE_NOT_FOUND' });
  });

  it('Bootstrap_UserEntryAndDefinitionLoss_ReplayWithoutRegistration', async () => {
    const s = await bootstrapFixture(cleanup);
    await mkdir(path.join(s.checkout, '.exarchos/workflows'), { recursive: true });
    const ref = '.exarchos/workflows/release-check.json';
    await s.write(JSON.stringify(releaseCheckDefinition()), ref);
    const intent = s.intent(undefined, { workflowType: 'release-check' });
    const first = receipt(await s.call(intent));
    expect((await s.events.query(STREAM))[0]?.data?.initialPhase).toBe('scope');
    expect(await readStateFile(s.stateFile)).toMatchObject({ workflowType: 'release-check', phase: 'build' });
    await unlink(path.join(s.checkout, ref));
    s.observe.mockClear();
    expect(receipt(await s.call(intent))).toEqual(first);
    expect(s.observe).not.toHaveBeenCalled();
  });

  it('Bootstrap_LexicalContainment_AllowsMountedPlanAndRefusesEscape', async () => {
    const s = await bootstrapFixture(cleanup);
    const external = path.join(s.root, REF);
    await writeFile(external, planText());
    const put = vi.spyOn(s.events.bundleStore, 'put');
    expect(await s.call(s.intent(undefined, { designRef: `../${REF}` }))).toMatchObject({
      success: false, error: { code: 'PLAN_UNSOUND' },
    });
    expect(put).not.toHaveBeenCalled();
    await symlink(external, path.join(s.checkout, 'mounted.md'));
    expect(receipt(await s.call(s.intent(undefined, { designRef: 'mounted.md' }))).capsuleVersion).toBe(1);
  });

  it('Bootstrap_ChangedApprovalRequiresCompile_OriginalEntryStillReplays', async () => {
    const s = await bootstrapFixture(cleanup);
    const first = receipt(await s.call());
    const changed = planText(2);
    await s.write(changed);
    expect(await s.call(s.intent(changed))).toMatchObject({ success: false, error: { code: 'BOOTSTRAP_CONFLICT' } });
    const second = receipt(await s.call(s.intent(changed, { mode: 'compile' })));
    expect(second.capsuleVersion).toBe(2);
    expect(second.capsuleDigest).not.toBe(first.capsuleDigest);
    expect(receipt(await s.call())).toEqual(first);
  });

  it.each([1, 20])('Bootstrap_BoundedPlan_%i_MeasuresCommitAndReplay', async (size) => {
    const s = await bootstrapFixture(cleanup, planText(size));
    const start = performance.now();
    const first = receipt(await s.call());
    const fresh = performance.now() - start;
    const replayStart = performance.now();
    expect(receipt(await s.call())).toEqual(first);
    const replay = performance.now() - replayStart;
    expect(first.capsule.graph.tasks).toHaveLength(size);
    console.info(`bootstrap ${size} tasks: commit ${fresh.toFixed(2)} ms, replay ${replay.toFixed(2)} ms`);
  });
});
