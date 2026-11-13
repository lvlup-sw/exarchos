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
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';

describe('prepared bundle compatibility', () => {
  it('Codec_OldBundle_RoundTrips', () => {
    const bytes = readFileSync(new URL('../support/fixtures/prepared-bundle-before-entry-epoch.json', import.meta.url));
    const decoded = decodePreparedBundle(bytes);
    expect(Object.hasOwn(decoded,'designRecord')).toBe(false);
    expect(Object.hasOwn(decoded.capsule.settlementContract,'skipPhases')).toBe(false);
    expect(Buffer.from(encodePreparedBundle(decoded))).toEqual(bytes);
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
