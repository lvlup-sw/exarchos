/** Structural prepared bundles retain old bytes and optional field absence.
 * @oracle-sources: ../../src/contract/capsule/prepared-bundle.ts, old bundle bytes captured from the immutable base and literal receipt cases
 */
import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { readFileSync } from 'node:fs';
import { encodePreparedBundle, decodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { baseValidCapsule, baseValidDefinition } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { compileDecideDefinition } from '../../src/workflow/decide/edges.js';
import { builtInDefinition } from '../../src/workflow/definitions/built-in.js';
import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { lowerDefinition } from '../../src/verbs/prepare/lower-definition.js';
import { recompiledSliceOf } from '../../src/verbs/prepare/recompiled-slice.js';
import { adjudicateSettlement } from '../../src/verbs/settle/adjudicate.js';
import { selectPreparedAuthority, verifyPreparedCustody } from '../../src/workflow/capsule/prepared-custody.js';
import { fixture, prepared } from '../helpers/capsule/prepared-authority.js';
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';

describe('prepared bundle compatibility', () => {
  it('Codec_OldBundle_RoundTrips', () => {
    const bytes = readFileSync(new URL('../support/fixtures/prepared-bundle-before-entry-epoch.json', import.meta.url));
    const decoded = decodePreparedBundle(bytes);
    expect(Object.hasOwn(decoded,'designRecord')).toBe(false);
    expect(Object.hasOwn(decoded.capsule.settlementContract,'skipPhases')).toBe(false);
    expect(Buffer.from(encodePreparedBundle(decoded))).toEqual(bytes);
    for (const compiler of [5, 6, 7]) {
      const original = fixture(undefined, compiler === 7);
      const definition = compiler === 5
        ? lowerDefinition('feature', builtInDefinition('feature')).definition
        : original.definition;
      const capsule = original.capsule;
      capsule.identity.definitionVersion = contentDigest(definition);
      capsule.provenance.compilerVersion = `exarchos-prepare-${compiler}`;
      capsule.provenance.sources = capsule.provenance.sources.map(source => source.sourceId === 'workflow-definition'
        ? { ...source, digest: contentDigest(definition) } : source);
      if (compiler < 7) delete capsule.settlementContract.skipPhases;
      const bundle = { ...original, definition };
      const stored = decodePreparedBundle(encodePreparedBundle(bundle));
      expect(stored).toEqual(bundle);
      const record = prepared(stored);
      const selection = selectPreparedAuthority([record], capsule.identity.workflowId);
      if (selection === undefined) throw new Error('Missing prepared authority');
      const authority = verifyPreparedCustody(selection, stored);
      expect(authority.kind).toBe(compiler === 7 ? 'typed' : 'legacy');
      expect(authority.pinnedDefinition !== undefined).toBe(compiler !== 5);
      expect(authority.skipPhases).toEqual(compiler === 7 ? [] : undefined);
      expect(() => verifyPreparedCustody({
        ...selection, record: { ...selection.record, compilerVersion: 'exarchos-prepare-99' },
      }, stored)).toThrow('Prepared custody identity mismatch');
      const partial = structuredClone(capsule);
      partial.settlementContract.requiredResults = ['task-compile', 'task-verify'];
      partial.contracts.taskResults['task-compile'] = [{ name: 'passed', type: 'boolean', required: true }];
      const claim = { taskId: 'task-compile', fields: { passed: true }, evidence: [] };
      const verdict = adjudicateSettlement(partial, [claim], [], { evidenceResolves: () => true });
      expect(verdict.outcome).toBe('rejected');
      expect(verdict.findings.map(({ kind, subject }) => ({ kind, subject })))
        .toEqual([{ kind: 'missing-claim', subject: 'task-verify' }]);
      const completed = adjudicateSettlement(partial, [claim], [], {
        evidenceResolves: () => true, taskComplete: id => id === 'task-verify',
      });
      expect(completed.outcome).toBe('settled');
      expect(completed.acceptedTasks).toEqual(['task-compile']);
    }
    const plan = [
      { id: 'tail', title: 'tail', status: 'pending', blockedBy: ['middle'] },
      { id: 'root', title: 'root', status: 'pending', blockedBy: [] },
      { id: 'middle', title: 'middle', status: 'complete', blockedBy: ['root'] },
      { id: 'sibling', title: 'sibling', status: 'pending', blockedBy: ['root'] },
    ];
    expect(recompiledSliceOf(['root', 'root', 'missing'], plan)).toEqual({
      declared: ['missing', 'root'], invalidated: ['root', 'sibling'],
    });
    expect(recompiledSliceOf(['root'], plan.map(entry => ({ ...entry, status: 'pending' })))).toEqual({
      declared: ['root'], invalidated: ['tail', 'root', 'middle', 'sibling'],
    });
  });

  it('Codec_GeneratedStructures_PreserveAbsenceAndEmptySkipList', () => {
    fc.assert(fc.property(fc.option(fc.array(fc.constantFrom('','unknown','plan','review','synthesize')), {nil:undefined}), fc.option(fc.record({reference:fc.string(),text:fc.string()}),{nil:undefined}), (skipPhases,designRecord) => {
      const capsule = baseValidCapsule();
      if (skipPhases !== undefined) capsule.settlementContract.skipPhases = skipPhases;
      const bundle = {capsule,definition:baseValidDefinition(),...(designRecord === undefined ? {} : {designRecord})};
      const decoded = decodePreparedBundle(encodePreparedBundle(bundle));
      expect(decoded).toEqual(bundle);
      expect(Object.hasOwn(decoded.capsule.settlementContract,'skipPhases')).toBe(skipPhases !== undefined);
      expect(Object.hasOwn(decoded,'designRecord')).toBe(designRecord !== undefined);
    }));
    const capsule=baseValidCapsule();
    capsule.settlementContract.skipPhases=['','unknown'];
    const retained = decodePreparedBundle(encodePreparedBundle({capsule,definition:baseValidDefinition()})).capsule.settlementContract.skipPhases;
    expect(retained).toEqual(['','unknown']);
    expect(compileDecideDefinition('feature',builtInDefinition('feature'),retained)).toEqual(compileDecideDefinition('feature',builtInDefinition('feature'),[]));
    capsule.settlementContract.skipPhases=[];
    expect(decodePreparedBundle(encodePreparedBundle({capsule,definition:baseValidDefinition()})).capsule.settlementContract.skipPhases).toEqual([]);
  });

  it.each([undefined,'outcome-does-not-move','design-revision','unpinned-definition','skip-phases-config','fold-failed','off-batch-step','prepared-authority-mismatch'])('Receipt_OldAbsentAndPreviousReasons_StillDecode %s', (reason) => {
    const receipt = {operationId:'op',streamId:'cold-user',capsule:{workflowId:'cold-user',definitionVersion:'v1',designVersion:'v1',capsuleVersion:1,batchId:'batch'},outcome:'settled',acceptedTasks:[],findings:[],adjudicated:{claims:0,requiredResults:0,fields:0,evidence:0,deviations:0},requestDigest:'digest',tailSequence:1,...(reason === undefined ? {} : {phaseMove:{kind:'not-decided',reason}})};
    expect(SettlementReceiptData.parse(receipt)).toEqual(receipt);
  });
});
