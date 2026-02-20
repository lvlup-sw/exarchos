import { bench, describe } from 'vitest';
import { ViewMaterializer } from './materializer.js';
import { pipelineProjection, PIPELINE_VIEW } from './pipeline-view.js';
import { codeQualityProjection, CODE_QUALITY_VIEW } from './code-quality-view.js';
import { createGateExecutedEvent, createMixedEvents } from '../benchmarks/event-factories.js';

describe('ViewMaterializer Benchmarks', () => {
  describe('Gate Events', () => {
    const gateEvents100 = Array.from({ length: 100 }, (_, i) =>
      createGateExecutedEvent(i + 1, 'bench-stream'),
    );

    const mixedEvents1000 = createMixedEvents(1000, 'bench-stream-1k');

    bench(
      'Materialize_100GateEvents_PipelineView',
      () => {
        const materializer = new ViewMaterializer();
        materializer.register(PIPELINE_VIEW, pipelineProjection);
        materializer.materialize('bench-stream', PIPELINE_VIEW, gateEvents100);
      },
      { warmupIterations: 5, iterations: 100 },
    );

    bench(
      'Materialize_100GateEvents_CodeQualityView',
      () => {
        const materializer = new ViewMaterializer();
        materializer.register(CODE_QUALITY_VIEW, codeQualityProjection);
        materializer.materialize('bench-stream', CODE_QUALITY_VIEW, gateEvents100);
      },
      { warmupIterations: 5, iterations: 100 },
    );

    bench(
      'Materialize_1000MixedEvents_PipelineView',
      () => {
        const materializer = new ViewMaterializer();
        materializer.register(PIPELINE_VIEW, pipelineProjection);
        materializer.materialize('bench-stream-1k', PIPELINE_VIEW, mixedEvents1000);
      },
      { warmupIterations: 5, iterations: 100 },
    );
  });
});
