/**
 * All pure checks share the reader snapshot, its exact edges and its source evidence.
 * @oracle-sources: ../../src/workflow/design-record/plan-checks.ts, authored records and literal expected edges and advisories in this file
 */
import { describe, expect, it } from 'vitest';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { evaluatePlanCoverage, evaluatePlanDecomposition, evaluatePlanProvenance, evaluatePlanTraceability } from '../../src/workflow/design-record/plan-checks.js';

function record(design: string, patch: Record<string, unknown> = {}) {
  const task = { id: 'T-01', title: 'DR-1 acceptance tests', implements: ['DR-1'], blockedBy: [],
    files: ['a/file.custom', 'b/file.custom', 'c/file.custom', 'd/file.custom', 'e/file.custom'], testFiles: ['tests/acceptance/thing.test.ts'],
    riskTier: 'low', boundaryTouching: false, testLayer: 'unit', acceptance: ['Given: X. When: Y. Then: Z.'],
    instructions: 'Implement DR-1.', parallelizable: false, ...patch };
  const text = '\uFEFF# Design & Rationale\r\n' + design + '\r\n## Tasks\r\n```exarchos-plan-v1\r\n'
    + JSON.stringify({ version: 1, requirements: ['DR-1'], tasks: [task] }) + '\r\n```\r\n';
  const read = readDesignRecord(Buffer.from(text), 'docs/plan.md');
  if (read.kind !== 'typed') throw new Error(JSON.stringify(read));
  return { snapshot: read.snapshot, text };
}
const gwt = '\r\n**Given** a record\r\n**When** it changes\r\n**Then** the result changes';

describe('shared typed plan checks', () => {
  it('Coverage_GwtWithoutAcceptanceTask_AdvisoryOnly', () => {
    const { snapshot } = record('### DR-1: Behavior' + gwt);
    const coverage = evaluatePlanCoverage(snapshot);
    expect(coverage.passed).toBe(true);
    expect(coverage.findings).toEqual([]);
    expect(coverage.advisories).toHaveLength(1);
    expect(coverage.advisories[0]).toContain('DR-1');
    expect(evaluatePlanCoverage(record('### DR-1: Behavior' + gwt, { testLayer: 'acceptance' }).snapshot).advisories).toEqual([]);
    expect(evaluatePlanCoverage(record('### DR-1: Behavior' + gwt, { testLayer: 'acceptance', implements: [] }).snapshot).advisories).toHaveLength(1);
  });
  it('finds GWT under deeper and setext authoritative headings', () => {
    for (const heading of ['#### DR-1: Deep', 'DR-1: Setext\r\n-----------']) {
      const { snapshot, text } = record(heading + gwt);
      expect(evaluatePlanCoverage(snapshot).advisories).toHaveLength(1);
      const definition = snapshot.definitions[0]!;
      expect(text.slice(definition.span.start, definition.span.end)).toBe(heading);
      expect(text.slice(definition.bodySpan.start, definition.bodySpan.end)).toContain('**Given**');
    }
  });
  it('does not leak GWT from adjacent prose or a later design boundary', () => {
    for (const suffix of ['\r\n### Other prose' + gwt, '\r\n## Appendix' + gwt]) {
      expect(evaluatePlanCoverage(record('### DR-1: Behavior' + suffix).snapshot).advisories).toEqual([]);
    }
  });
  it('keeps section bounds across fenced, HTML and container pseudoheadings', () => {
    for (const example of ['```text\r\n### Fake\r\n```', '<!--\r\n### Fake\r\n-->', '> ### Fake', '- ### Fake']) {
      expect(evaluatePlanCoverage(record('### DR-1: Behavior\r\n' + example + gwt).snapshot).advisories).toHaveLength(1);
    }
  });
  it('uses exact edges and the same digest for coverage, traceability and provenance', () => {
    const { snapshot } = record('### DR-1: Behavior');
    const coverage = evaluatePlanCoverage(snapshot);
    const trace = evaluatePlanTraceability(snapshot);
    const provenance = evaluatePlanProvenance(snapshot);
    expect(coverage.edges).toEqual([{ taskId: 'T-01', requirementId: 'DR-1' }]);
    expect(trace.edges).toEqual(coverage.edges);
    expect(trace.report).toContain('| DR-1 | T-01 |');
    expect(provenance.edges).toEqual(coverage.edges);
    expect(provenance.digest).toBe(snapshot.digest);
    expect(provenance.reference).toBe(snapshot.reference);
  });
  it('all evaluators return whole-plan failures instead of canned passes', () => {
    const { snapshot } = record('### DR-1: Behavior', { implements: [], blockedBy: ['absent'] });
    const coverage = evaluatePlanCoverage(snapshot);
    for (const evaluate of [evaluatePlanDecomposition, evaluatePlanProvenance, evaluatePlanTraceability]) {
      expect(evaluate(snapshot).passed).toBe(false);
      expect(evaluate(snapshot).findings).toEqual(coverage.findings);
    }
  });
  it('keeps semantic plausibility challenges advisory on typed fields', () => {
    const result = evaluatePlanDecomposition(record('### DR-1: Behavior').snapshot);
    expect(result.passed).toBe(true);
    expect(result.plausibility.challenges).toMatchObject([{ signal: 'breadth', taskId: 'T-01', observed: 5 }]);
  });
});
