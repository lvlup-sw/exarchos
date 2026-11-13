/**
 * Capped phase targets use complete names and literal counts. Replay reads a stored operation claim, not a bundle.
 * @oracle-sources: ../../../../src/verbs/settle/economy.ts, literal receipts and SQLite operation claims in this file
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateOutputTokens } from '../../../../src/dispatch/core/economy.js';
import { EventStore } from '../../../../src/events/store.js';
import { toEnvelope } from '../../../../src/format.js';
import { withCappedShape } from '../../../../src/output-schema-declaration.js';
import { SqliteBackend } from '../../../../src/storage/sqlite-backend.js';
import { summarizeSettlementReceipt } from '../../../../src/verbs/settle/economy.js';
import { SettlementOutputSchema } from '../../../../src/verbs/settle/schemas.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const releases: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); });

/** A receipt whose many findings force a cap. Core values and custody references remain small. */
function receipt(targets: readonly string[] = ['review', 'publish']) {
  return {
    operationId: 'settle:summary', outcome: 'settled', round: 0,
    capsule: { workflowId: 'summary', capsuleVersion: 1, batchId: 'batch-1' },
    acceptedTasks: ['task-a'], adjudicated: { claims: 1, findings: 300 }, tailSequence: 12,
    bundleRefs: [{ artifactId: 'bundle:summary', digest: { algorithm: 'sha256', value: 'a'.repeat(64) } }],
    findings: Array.from({ length: 300 }, () => ({ kind: 'invalid-result', subject: 'task-a', at: 'claims[0]', message: 'finding'.repeat(100) })),
    verification: [],
    phaseMove: { kind: 'stayed', phase: 'build', reason: 'edges-admit', edges: targets.map((to) => ({ to, verdict: 'allow', transitionId: `build->${to}`, falseFacts: [] })) },
  };
}

/** Checks the actual declared capped envelope and every fixed core value of the fixture. */
function capped(value: ReturnType<typeof receipt>) {
  const result = summarizeSettlementReceipt(value);
  expect(estimateOutputTokens(result)).toBeLessThanOrEqual(1000);
  expect(withCappedShape(SettlementOutputSchema).safeParse(toEnvelope({ success: true, data: result })).success).toBe(true);
  for (const key of ['operationId', 'outcome', 'round', 'capsule', 'adjudicated', 'tailSequence', 'bundleRefs']) {
    expect(Reflect.get(result, key)).toEqual(Reflect.get(value, key));
  }
  expect(result.phaseMove).toMatchObject({ kind: 'stayed', phase: 'build', reason: 'edges-admit' });
  expect(result.phaseMove).not.toHaveProperty('edges');
  return result;
}

describe('admitted targets in capped settlement output', () => {
  it('SettleSummary_TwoAdmittedTargets_SurviveTheCapAndReplay', async () => {
    const dir = makeTempDir('summary-claim-');
    releases.push(() => rmrfAsync(dir));
    const backend = new SqliteBackend(path.join(dir, 'exarchos.db'));
    backend.initialize();
    releases.push(() => backend.close());
    const store = new EventStore(dir, { backend });
    await store.initialize();
    releases.push(() => store.close());
    const original = receipt(['review', 'publish', 'review']);
    const first = await store.getAppender().decideOnce('settle:summary', 'digest', () => ({ streamId: 'summary', events: [{ type: 'workflow.started', data: { featureId: 'summary', workflowType: 'feature' } }], result: original }));
    const replayed = await store.getAppender().decideOnce('settle:summary', 'digest', () => { throw new Error('Replay ran the closure'); });
    expect(replayed).toEqual(first);
    expect(capped(first).phaseMove).toEqual({ kind: 'stayed', phase: 'build', reason: 'edges-admit', admittedTargets: ['review', 'publish'], admittedTargetsOmitted: 0 });
    expect(summarizeSettlementReceipt(replayed)).toEqual(capped(first));
    expect(first.phaseMove).not.toHaveProperty('admittedTargets');
    expect(await store.query('summary')).toHaveLength(1);
  });

  it.each([3, 12])('SettleSummary_LongTargets_AreWholeAndTheirOmissionIsCounted (%i)', (count) => {
    const names = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index).repeat(2000));
    const result = capped(receipt(names));
    expect(result.phaseMove?.admittedTargets).toEqual([names[0]]);
    expect(result.phaseMove?.admittedTargetsOmitted).toBe(count - 1);
    expect(result.firstPage).toEqual([]);
    const none = capped(receipt(['x'.repeat(5000)]));
    expect(none.phaseMove?.admittedTargets).toEqual([]);
    expect(none.phaseMove?.admittedTargetsOmitted).toBe(1);
  });

  it('SettleSummary_DeniedEdges_DoNotBecomeTargets', () => {
    const value = receipt();
    value.phaseMove.edges = value.phaseMove.edges.map((edge, index) => ({ ...edge, verdict: index === 0 ? 'deny' : 'indeterminate' }));
    expect(capped(value).phaseMove).toEqual({ kind: 'stayed', phase: 'build', reason: 'edges-admit' });
  });

  it('SettleSummary_AnOlderReceipt_GainsNoPhaseMove', () => {
    const { phaseMove, ...old } = receipt();
    expect(phaseMove.kind).toBe('stayed');
    const result = summarizeSettlementReceipt(old);
    expect(result).not.toHaveProperty('phaseMove');
    expect(estimateOutputTokens(result)).toBeLessThanOrEqual(1000);
    expect(withCappedShape(SettlementOutputSchema).safeParse(toEnvelope({ success: true, data: result })).success).toBe(true);
  });

  it('SettleSummary_TargetFieldOverhead_UsesABoundedOmissionMarker', () => {
    const value = receipt(['x'.repeat(5000)]);
    value.operationId = 'o'.repeat(3350);
    const { edges, ...move } = value.phaseMove;
    const previous = summarizeSettlementReceipt({ ...value, phaseMove: move });
    expect(edges).toHaveLength(1);
    expect(estimateOutputTokens(previous)).toBeLessThanOrEqual(1000);
    expect(estimateOutputTokens({ ...previous, phaseMove: { ...move, admittedTargets: [], admittedTargetsOmitted: 1 } })).toBeGreaterThan(1000);
    const result = capped(value);
    expect(result.phaseMove).toEqual(move);
    expect(result.summary).toBe('Admitted target detail omitted.');
  });

  it('SettleSummary_AnOversizedImmutableCore_KeepsItsIndependentLimit', () => {
    const value = receipt();
    value.operationId = 'o'.repeat(5000);
    const result = summarizeSettlementReceipt(value);
    const previous = summarizeSettlementReceipt({ ...value, phaseMove: { kind: 'stayed', phase: 'build', reason: 'edges-admit' } });
    expect(estimateOutputTokens(previous)).toBeGreaterThan(1000);
    expect(estimateOutputTokens(result)).toBeGreaterThan(1000);
    expect(result.operationId).toBe(value.operationId);
    expect(result.bundleRefs).toEqual(value.bundleRefs);
  });
});
