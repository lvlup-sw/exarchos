import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { ViewMaterializer } from './materializer.js';
import { codeQualityProjection, CODE_QUALITY_VIEW } from './code-quality-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── Event Generators ─────────────────────────────────────────────────────

/** Event types that the code quality projection actually processes. */
const RELEVANT_EVENT_TYPES = [
  'gate.executed',
  'benchmark.completed',
  'workflow.transition',
] as const;

/** Generate a random event type from those relevant to the projection. */
const arbRelevantEventType = fc.constantFrom(...RELEVANT_EVENT_TYPES);

/** Generate a gate.executed event with realistic data. */
const arbGateEvent = fc.record({
  gateName: fc.constantFrom('typecheck', 'lint', 'test', 'build', 'coverage'),
  layer: fc.constantFrom('L1', 'L2', 'L3'),
  passed: fc.boolean(),
  duration: fc.nat({ max: 10000 }),
  details: fc.record({
    skill: fc.constantFrom('delegation', 'review', 'synthesis', 'quality-review'),
    commit: fc.stringMatching(/^[0-9a-f]{7}$/),
    reason: fc.constantFrom('timeout', 'assertion-failed', 'compilation-error', undefined),
  }),
});

/** Generate a benchmark.completed event with realistic data. */
const arbBenchmarkEvent = fc.record({
  taskId: fc.string({ minLength: 3, maxLength: 20 }),
  results: fc.array(
    fc.record({
      operation: fc.constantFrom('query', 'append', 'materialize', 'transition'),
      metric: fc.constantFrom('p50', 'p95', 'p99', 'throughput'),
      value: fc.double({ min: 0.01, max: 10000, noNaN: true }),
      unit: fc.constantFrom('ms', 'ops/s', 'bytes'),
      passed: fc.boolean(),
    }),
    { minLength: 1, maxLength: 5 },
  ),
});

/** Generate a WorkflowEvent with a specific sequence number. */
function arbWorkflowEvent(sequence: number, streamId: string): fc.Arbitrary<WorkflowEvent> {
  return arbRelevantEventType.chain((type) => {
    if (type === 'gate.executed') {
      return arbGateEvent.map((data) => ({
        streamId,
        sequence,
        timestamp: new Date(Date.now() + sequence * 1000).toISOString(),
        type: 'gate.executed' as const,
        schemaVersion: '1.0',
        data,
      }));
    }
    if (type === 'benchmark.completed') {
      return arbBenchmarkEvent.map((data) => ({
        streamId,
        sequence,
        timestamp: new Date(Date.now() + sequence * 1000).toISOString(),
        type: 'benchmark.completed' as const,
        schemaVersion: '1.0',
        data,
      }));
    }
    // workflow.transition -- projection ignores this, useful for noise
    return fc.constant({
      streamId,
      sequence,
      timestamp: new Date(Date.now() + sequence * 1000).toISOString(),
      type: 'workflow.transition' as const,
      schemaVersion: '1.0',
      data: { from: 'plan', to: 'delegate', trigger: 'execute-transition', featureId: 'test' },
    });
  });
}

/**
 * Generate a sequence of WorkflowEvents with monotonically increasing sequences.
 * Length is between 1 and maxLength.
 */
function arbEventSequence(
  streamId: string,
  maxLength: number = 15,
): fc.Arbitrary<WorkflowEvent[]> {
  return fc
    .integer({ min: 1, max: maxLength })
    .chain((length) => {
      const arbs: fc.Arbitrary<WorkflowEvent>[] = [];
      for (let i = 1; i <= length; i++) {
        arbs.push(arbWorkflowEvent(i, streamId));
      }
      return fc.tuple(...(arbs as [fc.Arbitrary<WorkflowEvent>, ...fc.Arbitrary<WorkflowEvent>[]]));
    })
    .map((tuple) => [...tuple]);
}

// ─── Property Tests ─────────────────────────────────────────────────────

describe('ViewMaterializer Property Tests', () => {
  const STREAM_ID = 'test-stream';
  const VIEW_NAME = CODE_QUALITY_VIEW;

  describe('Materializer_DoubleApplication_Idempotent', () => {
    it('materializing same events twice produces identical view state', () => {
      fc.assert(
        fc.property(arbEventSequence(STREAM_ID), (events) => {
          // First materialization
          const mat1 = new ViewMaterializer();
          mat1.register(VIEW_NAME, codeQualityProjection);
          const view1 = mat1.materialize(STREAM_ID, VIEW_NAME, events);

          // Second materialization of same events on same materializer
          // (should be idempotent due to high-water mark)
          const view2 = mat1.materialize(STREAM_ID, VIEW_NAME, events);

          expect(view1).toEqual(view2);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Materializer_IncrementalVsBatch_SameResult', () => {
    it('materializing events one-at-a-time vs all-at-once produces same view state', () => {
      fc.assert(
        fc.property(arbEventSequence(STREAM_ID), (events) => {
          // Batch: all events at once
          const batchMat = new ViewMaterializer();
          batchMat.register(VIEW_NAME, codeQualityProjection);
          const batchView = batchMat.materialize(STREAM_ID, VIEW_NAME, events);

          // Incremental: one event at a time
          const incMat = new ViewMaterializer();
          incMat.register(VIEW_NAME, codeQualityProjection);
          let incView: unknown;
          for (let i = 0; i < events.length; i++) {
            // Pass all events up to current index -- materializer uses
            // high-water mark to only process new ones
            incView = incMat.materialize(STREAM_ID, VIEW_NAME, events.slice(0, i + 1));
          }

          expect(incView).toEqual(batchView);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Materializer_HighWaterMark_MonotonicallyIncreasing', () => {
    it('after each materialization call, the high-water mark is >= the previous value', () => {
      fc.assert(
        fc.property(arbEventSequence(STREAM_ID), (events) => {
          const mat = new ViewMaterializer();
          mat.register(VIEW_NAME, codeQualityProjection);

          let previousHwm = 0;

          for (let i = 0; i < events.length; i++) {
            mat.materialize(STREAM_ID, VIEW_NAME, events.slice(0, i + 1));
            const state = mat.getState(STREAM_ID, VIEW_NAME);

            expect(state).toBeDefined();
            const currentHwm = state!.highWaterMark;
            expect(currentHwm).toBeGreaterThanOrEqual(previousHwm);
            previousHwm = currentHwm;
          }
        }),
        { numRuns: 50 },
      );
    });
  });
});
