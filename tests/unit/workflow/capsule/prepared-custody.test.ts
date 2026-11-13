/**
 * Custody witnesses distinguish legacy lookup from whole-plan authority.
 * @oracle-sources: ../../../../src/workflow/design-record/validate.ts, literal corruptions and expected identities in this file
 */
import { describe, expect, it } from 'vitest';
import { baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { capsuleDigest, contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { decodePreparedBundle, encodePreparedBundle } from '../../../../src/contract/capsule/prepared-bundle.js';
import { WorkflowPreparedData } from '../../../../src/events/schemas.js';
import { capsuleOfRecord, latestPreparedRecordOf, preparedRecordOf } from '../../../../src/verbs/prepare/prepared-record.js';
import { selectPreparedAuthority, verifyPreparedCustody, recheckPreparedAuthority } from '../../../../src/workflow/capsule/prepared-custody.js';
import { fixture, prepared, row, task, textOf } from '../../../helpers/capsule/prepared-authority.js';

function selected(rows = [prepared()]) {
  const result = selectPreparedAuthority(rows, 'wf-capsule-corpus');
  if (!result) throw new Error('Missing selection');
  return result;
}

describe('prepared custody', () => {
  it('Legacy_NamedAndLatestUtilities_KeepSkippedMalformedRows', () => {
    const good = prepared(fixture(textOf(), false));
    const bad = row(2, 'workflow.prepared', {});
    expect(preparedRecordOf([good, bad], 7)?.sequence).toBe(1);
    expect(latestPreparedRecordOf([good, bad])?.sequence).toBe(1);
  });
  it('Legacy_MissingReference_IsUndefined_AndMissingBlobThrows', async () => {
    const record = WorkflowPreparedData.parse(prepared().data);
    const store = { resolve: async () => { throw new Error('absent blob'); } };
    await expect(capsuleOfRecord({ ...record, bundleRefs: [] }, store)).resolves.toBeUndefined();
    await expect(capsuleOfRecord(record, store)).rejects.toThrow('absent blob');
  });
  it('Custody_WholePlanExceedsFrontier_AndReferenceIsMetadata', () => {
    const bundle = fixture();
    const authority = verifyPreparedCustody(selected(), decodePreparedBundle(encodePreparedBundle(bundle)));
    expect(authority.kind).toBe('typed');
    if (authority.kind !== 'typed') throw new Error('Expected typed authority');
    expect(authority.snapshot.tasks.map(t => t.id)).toEqual(['task-compile', 'task-verify', 'later']);
    expect(authority.selection.record.taskCount).toBe(2);
    expect(verifyPreparedCustody(selected(), { ...bundle, designRecord: { reference: '../display-only', text: textOf() } }).kind).toBe('typed');
  });
  it('Custody_MissingTypedRecord_FailsClosed', () => {
    expect(() => verifyPreparedCustody(selected(), fixture(textOf(), false))).toThrow(/design record/i);
  });
  it('Custody_DuplicateDesignSource_Refuses', () => {
    const bundle = fixture();
    const sources = bundle.capsule.provenance.sources;
    const changed = { ...bundle, capsule: { ...bundle.capsule, provenance: { ...bundle.capsule.provenance, sources: [...sources, ...sources.filter(s => s.sourceId === 'design-record')] } } };
    expect(() => verifyPreparedCustody(selected([prepared(changed)]), changed)).toThrow(/design.record source/i);
  });
  it.each([undefined, null, '', 12, 'not-a-digest'])('Authority_LaterMissingMarker_RefusesDowngrade_%s', marker => {
    const later = prepared(fixture(), 9);
    const data = { ...later.data, planRecordDigest: marker };
    if (marker === undefined) delete data.planRecordDigest;
    expect(() => selected([prepared(), { ...later, data }])).toThrow();
  });
  it('Authority_HighestSequenceWins_AndMalformedLatestRefuses', () => {
    expect(selected([prepared(fixture(), 9), prepared(fixture(), 2)]).sequence).toBe(9);
    expect(() => selected([prepared(), row(9, 'workflow.prepared', {})])).toThrow();
    expect(selectPreparedAuthority([], 'wf-capsule-corpus')).toBeUndefined();
  });
  it('Authority_RecheckIsPure_AndTracksPreparedIdentity', () => {
    const rows = [prepared()];
    const selection = selected(rows);
    expect(recheckPreparedAuthority(selection, rows)).toBe(true);
    expect(recheckPreparedAuthority(selection, [...rows, row(2, 'task.completed', { taskId: 'later' })])).toBe(true);
    expect(recheckPreparedAuthority(selection, [prepared(fixture(), 2)])).toBe(false);
    expect(recheckPreparedAuthority(selection, [row(1, 'workflow.prepared', {})])).toBe(false);
  });
  it.each(['workflowId', 'workflowType', 'capsuleVersion', 'definitionVersion', 'designVersion', 'compilerVersion', 'capsuleDigest', 'taskCount'])('Custody_RowIdentityMismatch_%s', field => {
    const original = prepared();
    const value = field === 'taskCount' || field === 'capsuleVersion' ? 99 : 'wrong';
    expect(() => verifyPreparedCustody(selected([{ ...original, data: { ...original.data, [field]: value } }]), fixture())).toThrow();
  });
  it('Custody_StreamAndEnvelopeMismatch_Refuses', () => {
    expect(() => selected([{ ...prepared(), streamId: 'wrong' }])).toThrow();
    expect(() => selected([{ ...prepared(), schemaVersion: '2.0' }])).toThrow();
  });
  it.each(['edited prose', 'invalid fence', 'cycle', 'unknown dependency', 'duplicate id'])('Custody_InvalidWholeTextOrGraph_Refuses_%s', change => {
    const text = change === 'edited prose' ? textOf() + 'An edit outside JSON.\n'
      : change === 'invalid fence' ? textOf().replace('exarchos-plan-v1', 'exarchos-plan-v2')
      : change === 'cycle' ? textOf([task('a', { blockedBy: ['b'] }), task('b', { blockedBy: ['a'] })])
      : change === 'unknown dependency' ? textOf([task('a', { blockedBy: ['absent'] })])
      : textOf([task('a'), task('a')]);
    const bundle = fixture(text);
    const selection = change === 'edited prose' ? selected() : selected([prepared(bundle)]);
    expect(() => verifyPreparedCustody(selection, bundle)).toThrow();
  });
  it('Custody_FullDefinitionAndSourceDigest_RefusesDamage', () => {
    const original = fixture();
    const definition = { ...original.definition, exarchos: {} };
    const capsule = { ...original.capsule, identity: { ...original.capsule.identity, definitionVersion: contentDigest(definition) } };
    const bundle = { ...original, definition, capsule };
    expect(() => verifyPreparedCustody(selected([prepared(bundle)]), bundle)).toThrow(/definition/i);
    const changed = { ...original, capsule: { ...original.capsule, provenance: { ...original.capsule.provenance, sources: [] } } };
    expect(() => verifyPreparedCustody(selected([prepared(changed)]), changed)).toThrow(/source/i);
    expect(capsuleDigest(original.capsule)).not.toBe(capsuleDigest(capsule));
  });
  it('Custody_LegacyAbsentSkipsAndPinnedEmptySkipsRemainDistinct', () => {
    const original = fixture(textOf(), false);
    const { skipPhases: _skip, ...contract } = original.capsule.settlementContract;
    const legacy = { ...original, capsule: { ...original.capsule, provenance: { ...original.capsule.provenance, compilerVersion: 'exarchos-prepare-6' }, settlementContract: contract } };
    expect(verifyPreparedCustody(selected([prepared(legacy)]), legacy).skipPhases).toBeUndefined();
    expect(verifyPreparedCustody(selected(), fixture()).skipPhases).toEqual([]);
  });
  it('Custody_OrderedRepeatedAndUnknownSkipsRemainExact', () => {
    const original = fixture();
    const skips = ['unknown', 'plan-review', 'plan-review', 'unknown'];
    const bundle = { ...original, capsule: { ...original.capsule, settlementContract: { ...original.capsule.settlementContract, skipPhases: skips } } };
    expect(verifyPreparedCustody(selected([prepared(bundle)]), bundle).skipPhases).toEqual(skips);
  });
  it.each(['plan', 'completed'])('Custody_InvalidEntryOrFinalSkip_Refuses_%s', skip => {
    const original = fixture();
    const bundle = { ...original, capsule: { ...original.capsule, settlementContract: { ...original.capsule.settlementContract, skipPhases: [skip] } } };
    expect(() => verifyPreparedCustody(selected([prepared(bundle)]), bundle)).toThrow();
  });
  it('Custody_KernelOnlyLegacyRemainsUnsupported_AndNewPinCannotDisappear', () => {
    const original = fixture(textOf(), false);
    const definition = WorkflowDefinitionV1Schema.parse(baseValidDefinition());
    const bundle = { ...original, definition, capsule: { ...original.capsule,
      identity: { ...original.capsule.identity, definitionVersion: contentDigest(definition) },
      provenance: { ...original.capsule.provenance, compilerVersion: 'exarchos-prepare-5' } } };
    expect(verifyPreparedCustody(selected([prepared(bundle)]), bundle).pinnedDefinition).toBeUndefined();
    const fresh = { ...bundle, capsule: { ...bundle.capsule, provenance: { ...bundle.capsule.provenance, compilerVersion: 'exarchos-prepare-7' } } };
    expect(() => verifyPreparedCustody(selected([prepared(fresh)]), fresh)).toThrow(/definition/i);
    const { skipPhases: _skips, ...contract } = original.capsule.settlementContract;
    const missing = { ...original, capsule: { ...original.capsule, settlementContract: contract } };
    expect(() => verifyPreparedCustody(selected([prepared(missing)]), missing)).toThrow(/skip/i);
  });
  it('Custody_MarkerAndSourceCannotHideChangedRawText', () => {
    const original = fixture();
    const edited = { ...original, designRecord: { reference: 'plan.md', text: textOf() + 'extra prose' } };
    expect(() => verifyPreparedCustody(selected(), edited)).toThrow(/digest/i);
    const sources = original.capsule.provenance.sources.map(source => source.sourceId === 'design-record' ? { ...source, digest: 'b'.repeat(64) } : source);
    const changed = { ...original, capsule: { ...original.capsule, provenance: { ...original.capsule.provenance, sources } } };
    expect(() => verifyPreparedCustody(selected([prepared(changed)]), changed)).toThrow(/source/i);
  });
  it('Custody_UserDefinitionUsesItsStoredType', () => {
    const original = fixture();
    const definition = { ...original.definition, name: 'local-check' };
    const bundle = { ...original, definition, capsule: { ...original.capsule, identity: { ...original.capsule.identity, definitionVersion: contentDigest(definition) } } };
    const event = prepared(bundle);
    const selection = selected([{ ...event, data: { ...event.data, workflowType: 'local-check' } }]);
    expect(verifyPreparedCustody(selection, bundle).pinnedDefinition?.name).toBe('local-check');
  });

  it('Authority_NamedLegacyPrefix_RemainsSeparateFromLatestTypedAuthority', () => {
    const legacy = fixture(textOf(), false);
    const rows = [prepared(legacy, 1), prepared(fixture(), 2)];
    const named = selected(rows.filter(event => event.sequence <= 1));
    expect(verifyPreparedCustody(named, legacy).kind).toBe('legacy');
    expect(verifyPreparedCustody(selected(rows), fixture()).kind).toBe('typed');
  });

});
