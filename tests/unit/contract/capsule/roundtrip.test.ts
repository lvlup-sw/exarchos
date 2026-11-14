// Zod and Ajv must give the same verdict for each document.
//
// The capsule ships as a Zod schema and as a generated JSON Schema, and a
// consumer can hold either one. The corpus lives in `src/` so both validators
// read the same documents.
//
// No capsule rule is a refinement, because `z.toJSONSchema` does not emit a
// refinement. Such a rule shows here as a disagreement between the validators.

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { describe, it, expect } from 'vitest';

import { ExecuteIntentInputSchema, SegmentInputBindingV1Schema, encodeExecuteIntentBundle, decodeExecuteIntentBundle } from '../../../../src/verbs/execute/run-bundle.js';
import { TaskVerificationCoordinateSchema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { CAPSULE_ROUNDTRIP_FIXTURES } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { serializeExarchosCapsuleJsonSchema } from '../../../../src/contract/capsule/exarchos-capsule-schema.js';

const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } });
const validate: ValidateFunction = ajv.compile(
  JSON.parse(serializeExarchosCapsuleJsonSchema()) as object,
);

describe('the capsule contract, validated both ways', () => {
  it.each(CAPSULE_ROUNDTRIP_FIXTURES)('Capsule_Zod_$name', ({ valid, document }) => {
    expect(ExarchosCapsuleV1Schema.safeParse(document).success).toBe(valid);
  });

  it.each(CAPSULE_ROUNDTRIP_FIXTURES)('Capsule_Ajv_$name', ({ valid, document }) => {
    expect(validate(document)).toBe(valid);
  });

  it.each(CAPSULE_ROUNDTRIP_FIXTURES)('Capsule_BothValidatorsAgree_$name', ({ document }) => {
    expect(validate(document)).toBe(ExarchosCapsuleV1Schema.safeParse(document).success);
  });

  /** A corpus with only one verdict passes the three parameterized tests and proves nothing about either validator. */
  it('Capsule_TheCorpus_ExercisesBothVerdicts', () => {
    const accepts = CAPSULE_ROUNDTRIP_FIXTURES.filter((f) => f.valid).length;
    const rejects = CAPSULE_ROUNDTRIP_FIXTURES.length - accepts;
    expect(accepts).toBeGreaterThanOrEqual(4);
    expect(rejects).toBeGreaterThanOrEqual(12);
  });

  it('Capsule_EveryFixtureName_IsDistinct', () => {
    const names = CAPSULE_ROUNDTRIP_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('CoordinateInput_RoundtripAndClosedBinding_KeepDistinctDigests', () => {
    const coordinate = TaskVerificationCoordinateSchema.parse({
      protocolVersion: '1', taskId: 'task-verify', capsule: baseValidCapsule().identity,
      repository: '/repo/.git', rootBaseCommit: 'a'.repeat(40), diffBaseCommit: 'a'.repeat(40),
      observedHeadCommit: 'b'.repeat(40), blockers: [],
    });
    const input = ExecuteIntentInputSchema.parse({
      intent: 'task-completion', streamId: coordinate.capsule.workflowId, args: { taskId: 'task-verify', coordinate },
    });
    const run = {
      bundleVersion: '1.0', kind: 'execute-intent-run', operationId: 'segment:a', intent: input.intent,
      streamId: input.streamId, requestDigest: 'sha256:' + 'c'.repeat(64), outcome: 'committed', tailSequence: 1,
      leaves: [], interaction: { leavesExecuted: 0, eventsAppended: 0, requests: 1, deferred: [] }, input,
    } as const;
    expect(decodeExecuteIntentBundle(encodeExecuteIntentBundle({ ...run, leaves: [], interaction: { ...run.interaction, deferred: [] } })).input).toEqual(input);
    const binding = {
      namespace: 'exarchos.segment-input.v1', bindingVersion: '1', operationId: 'segment:a', streamId: input.streamId,
      callerDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
      inputDigest: { algorithm: 'sha256', value: 'b'.repeat(64) },
      inputRef: { artifactId: 'run-bundle:input:segment:a', digest: { algorithm: 'sha256', value: 'c'.repeat(64) } },
    };
    expect(SegmentInputBindingV1Schema.parse(binding)).toEqual(binding);
    expect(SegmentInputBindingV1Schema.safeParse({ ...binding, events: [] }).success).toBe(false);
    expect(SegmentInputBindingV1Schema.safeParse({ ...binding, namespace: 'terminal-run' }).success).toBe(false);
    expect(TaskVerificationCoordinateSchema.safeParse({ ...coordinate, diffBaseCommit: 'main' }).success).toBe(false);
    const provisional = { kind: 'provisional', taskId: 'blocker', headCommit: 'b'.repeat(40), capsule: coordinate.capsule,
      outerOperationId: 'outer', segmentOperationId: 'segment', segmentRecord: { eventId: 'event', sequence: 3, timestamp: '2026-11-14T00:00:00Z' },
      runBundle: binding.inputRef, completionSequence: 2, staticAnalysisSequence: 1 };
    expect(TaskVerificationCoordinateSchema.safeParse({ ...coordinate, blockers: [provisional] }).success).toBe(true);
    expect(TaskVerificationCoordinateSchema.safeParse({ ...coordinate, blockers: [{ ...provisional, outerRecordSequence: 4 }] }).success).toBe(false);
    expect(TaskVerificationCoordinateSchema.safeParse({ ...coordinate, blockers: [{ ...provisional, kind: 'accepted' }] }).success).toBe(false);
    expect(TaskVerificationCoordinateSchema.safeParse({ ...coordinate, blockers: [{ ...provisional, kind: 'accepted', outerRecordSequence: 4, settlementBundle: binding.inputRef }] }).success).toBe(true);

    expect(ExecuteIntentInputSchema.safeParse({ ...input, args: { taskId: 'other', coordinate } }).success).toBe(false);
    expect(ExecuteIntentInputSchema.safeParse({ ...input, args: { taskId: 'task-verify' } }).success).toBe(false);
  });

  it('NormalizedInput_BoundsDenseJsonBeforeNormalization', () => {
    const envelope = { intent: 'generic', streamId: 'stream', args: { text: '' } };
    const available = 131072 - Buffer.byteLength(JSON.stringify(envelope));
    envelope.args.text = 'x'.repeat(available);
    expect(ExecuteIntentInputSchema.safeParse(envelope).success).toBe(true);
    expect(ExecuteIntentInputSchema.safeParse({ ...envelope, args: { text: envelope.args.text + 'x' } }).success).toBe(false);
    const bad: unknown[] = [undefined, Number.NaN, BigInt(1), new Date(), new Array(2), { toJSON: () => 1 }];
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    bad.push(cycle, Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('hidden')]: 1 });
    let getterCalls = 0;
    bad.push(Object.defineProperty({}, 'value', { enumerable: true, get: () => { getterCalls++; return 1; } }));
    let deep: unknown = 1;
    for (let i = 0; i < 33; i++) deep = { child: deep };
    bad.push(deep, JSON.parse('{"__proto__":{"hidden":true}}'));
    for (const value of bad) expect(ExecuteIntentInputSchema.safeParse({ ...envelope, args: { value } }).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('Compiler8_OptionalWireFields_AgreeAcrossValidatorsAndRejectUnknownKeys', () => {
    const base = baseValidCapsule();
    const context = {
      taskId: 'task-compile', title: 'compile the segment', instructions: 'Keep the approved work.',
      files: ['src/a.ts'], testFiles: [], acceptance: ['Preserve behavior.'], riskTier: 'low', boundaryTouching: false,
      testLayer: 'unit', blockedBy: [], resultContractRef: 'task-compile',
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
      source: { reference: 'plan.md', digest: 'a'.repeat(64), span: { start: 0, end: 1, startLine: 1, endLine: 1 } },
    };
    const first = { ...base.graph.tasks[0], stage: { kind: 'task-batch', stepId: 'step-verify' }, taskContext: context };
    const document = { ...base, graph: { ...base.graph, tasks: [first, ...base.graph.tasks.slice(1)] } };
    expect(ExarchosCapsuleV1Schema.safeParse(document).success).toBe(true);
    expect(validate(document)).toBe(true);
    for (const taskContext of [
      { ...context, unknown: true },
      { ...context, knowledgeSlice: { ...context.knowledgeSlice, unknown: [] } },
      { ...context, files: ['../escape.ts'] },
      { ...context, testFiles: Array(65).fill('tests/a.ts') },
      { ...context, acceptance: [] },
    ]) {
      const broken = { ...document, graph: { ...document.graph, tasks: [{ ...first, taskContext }] } };
      expect(ExarchosCapsuleV1Schema.safeParse(broken).success).toBe(false);
      expect(validate(broken)).toBe(false);
    }
  });

});
