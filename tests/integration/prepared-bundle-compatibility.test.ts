/** Structural prepared bundles retain old bytes and optional field absence.
 * @oracle-sources: ../../src/contract/capsule/prepared-bundle.ts, old bundle bytes captured from the immutable base and literal receipt cases
 */
import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { readFileSync } from 'node:fs';
import { encodePreparedBundle, decodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { baseValidCapsule, baseValidDefinition, profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { compileDecideDefinition } from '../../src/workflow/decide/edges.js';
import { builtInDefinition } from '../../src/workflow/definitions/built-in.js';
import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { lowerDefinition } from '../../src/verbs/prepare/lower-definition.js';
import { recompiledSliceOf } from '../../src/verbs/prepare/recompiled-slice.js';
import { adjudicateSettlement } from '../../src/verbs/settle/adjudicate.js';
import { selectPreparedAuthority, verifyPreparedCustody } from '../../src/workflow/capsule/prepared-custody.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { resolveCapsuleReferences } from '../../src/contract/capsule/capsule-references.js';
import { fixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';

/** Independent approved tasks provide a complete graph and exact immutable source spans. */
function completeGraphBundle() {
  const text = textOf([task('a'), task('b'), task('c', { blockedBy: ['a', 'b'] })]);
  const bundle = fixture(text);
  const read = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
  if (read.kind !== 'typed') throw new Error('Invalid test plan');
  const capsule = bundle.capsule;
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = read.snapshot.tasks.map(entry => ({
    taskId: entry.id, title: entry.title, stepId: 'delegate', stage: { kind: 'task-batch', stepId: 'delegate' },
    taskContext: {
      taskId: entry.id, title: entry.title, instructions: entry.instructions,
      files: [...entry.files], testFiles: [...entry.testFiles], acceptance: [...entry.acceptance],
      riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
      source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
    },
  }));
  capsule.graph.dependencies = [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }];
  capsule.graph.joins = [{ joinId: 'join-c', forTaskId: 'c', waitsFor: ['a', 'b'], mode: 'all' }];
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = {
    a: [{ name: 'passed', type: 'boolean', required: true }],
    b: [{ name: 'passed', type: 'boolean', required: true }],
    c: [{ name: 'passed', type: 'boolean', required: true }, { name: 'forkCommit', type: 'string', required: true }],
  };
  capsule.settlementContract = {
    ...profiledValidCapsule().settlementContract, requiredResults: ['a', 'b', 'c'], skipPhases: [],
    verificationMode: 'immutable-task-diff-v1',
    taskVerification: Object.fromEntries(['a', 'b', 'c'].map(id => [id, {
      riskTier: 'low', boundaryTouching: false, baseRef: 'main', baseCommit: 'a'.repeat(40),
    }])),
  };
  return bundle;
}

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
  it('Compiler8_CompleteCustody_RoundTripsWithoutLegacyFallback', () => {
    const bundle = completeGraphBundle();
    expect(resolveCapsuleReferences(bundle.capsule, { definition: bundle.definition }).ok).toBe(true);
    expect(decodePreparedBundle(encodePreparedBundle(bundle))).toEqual(bundle);
    const bytes = Buffer.from(encodePreparedBundle(bundle));
    const offset = bytes.indexOf(Buffer.from('"title":"a"')) + '"title":"'.length;
    expect(offset).toBeGreaterThan(8);
    const invalidUtf8 = Buffer.concat([bytes.subarray(0, offset), Buffer.from([255]), bytes.subarray(offset + 1)]);
    expect(() => decodePreparedBundle(invalidUtf8)).toThrow('Invalid UTF-8 custody');
    for (const key of ['stage', 'taskContext'] as const) {
      const broken = structuredClone(bundle);
      const first = broken.capsule.graph.tasks[0];
      if (first === undefined) throw new Error('Missing task');
      delete first[key];
      expect(() => encodePreparedBundle(broken)).toThrow('Incomplete compiler-8 custody');
      const raw = JSON.stringify({ bundleVersion: '1.0', kind: 'prepared-capsule', ...broken });
      expect(() => decodePreparedBundle(Buffer.from(raw))).toThrow('Incomplete compiler-8 custody');
    }
    expect(() => encodePreparedBundle({ capsule: bundle.capsule, definition: bundle.definition })).toThrow('approved design record');
  });

  it('Compiler8_ContextMustMatchApprovedTaskAndSpan', () => {
    const bundle = completeGraphBundle();
    const changed = structuredClone(bundle);
    const context = changed.capsule.graph.tasks[0]?.taskContext;
    if (context === undefined) throw new Error('Missing context');
    context.instructions = 'Replace the approved work';
    expect(() => encodePreparedBundle(changed)).toThrow('differs from approved instructions');
    context.instructions = 'Build it.';
    context.source.span.startLine += 1;
    context.source.span.endLine += 1;
    expect(() => encodePreparedBundle(changed)).toThrow('stored design bytes');
    context.source.span.startLine -= 1;
    context.source.span.endLine -= 1;
    context.source.span.end = context.source.span.start;
    expect(() => encodePreparedBundle(changed)).toThrow('Incomplete compiler-8 custody');
    const omitted = structuredClone(bundle);
    omitted.capsule.graph.tasks.shift();
    expect(() => encodePreparedBundle(omitted)).toThrow();
  });

  it('Compiler8_JoinModel_RejectsCollisionsAndReorderedWaiters', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), fault => {
      const bundle = completeGraphBundle();
      expect(resolveCapsuleReferences(bundle.capsule).ok).toBe(true);
      const join = bundle.capsule.graph.joins[0];
      if (join === undefined) throw new Error('Missing join');
      if (fault === 0) join.joinId = 'a';
      if (fault === 1) join.waitsFor.reverse();
      if (fault === 2) join.forTaskId = 'ghost';
      if (fault === 3) bundle.capsule.graph.joins = [];
      expect(resolveCapsuleReferences(bundle.capsule).ok).toBe(false);
    }), { seed: 192702, numRuns: 24 });
    const differentBase = completeGraphBundle();
    const terms = differentBase.capsule.settlementContract.taskVerification?.c;
    if (terms === undefined) throw new Error('Missing terms');
    terms.baseCommit = 'b'.repeat(40);
    expect(resolveCapsuleReferences(differentBase.capsule).ok).toBe(false);
  });

  it('Compiler8_ContextUtf8AndAggregateBounds_RejectWithoutTruncation', () => {
    const bundle = completeGraphBundle();
    const context = bundle.capsule.graph.tasks[0]?.taskContext;
    const node = bundle.capsule.graph.tasks[0];
    if (context === undefined || node === undefined) throw new Error('Missing context');
    context.title = node.title = 'é'.repeat(128);
    expect(resolveCapsuleReferences(bundle.capsule).ok).toBe(true);
    context.title = node.title = 'é'.repeat(129);
    expect(resolveCapsuleReferences(bundle.capsule).ok).toBe(false);
    context.title = node.title = 'a';
    context.instructions = 'x'.repeat(8192);
    context.acceptance = Array(8).fill('x'.repeat(2048));
    expect(resolveCapsuleReferences(bundle.capsule).ok).toBe(false);
  });

});
