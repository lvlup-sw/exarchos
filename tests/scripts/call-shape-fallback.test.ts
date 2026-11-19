/** The live measurement includes all normal work before the fallback transition. */
import { describe, expect, it } from 'vitest';
import { measureLiveCallShape } from '../../tools/audit/core/call-shape/measure.js';

/** Measures the delegation intent from the authored calls. */
function delegation() {
  const measured = measureLiveCallShape();
  expect(measured.errors).toEqual([]);
  const intent = measured.census.intents.find((entry) => entry.id === 'delegation');
  if (intent === undefined) throw new Error('No delegation intent');
  return intent;
}

describe('the complete delegation fallback', () => {
  it('CallShape_ThePhaseFallback_IncludesLandingAndBothBackstops', () => {
    const intent = delegation();
    const fallback = intent.exceptions.find((entry) => entry.id === 'phase-not-moved');
    expect(fallback?.counts.exarchos).toEqual({ fixed: 5, perTask: 1, perPr: 0, formula: '5 + 1*tasks', atUnit: 6 });
    expect(fallback?.through).toBeNull();
    expect(intent.normal.calls.filter((entry) => entry.role === 'work').map((entry) => entry.call)).toEqual([
      'exarchos_orchestrate.prepare',
      'exarchos_orchestrate.settle',
      'exarchos_orchestrate.serialize_merge',
      'exarchos_orchestrate.check_integration_suite',
      'exarchos_orchestrate.check_operational_resilience',
    ]);
    expect(fallback?.extraCalls.map((entry) => entry.call)).toEqual(['exarchos_workflow.transition']);
  });

  it('CallShape_TheNormalPath_KeepsItsCount', () => {
    expect(delegation().normal.counts.exarchos).toEqual({ fixed: 4, perTask: 1, perPr: 0, formula: '4 + 1*tasks', atUnit: 5 });
  });
});
