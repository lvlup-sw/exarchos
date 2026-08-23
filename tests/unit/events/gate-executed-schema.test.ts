// ─── gate.executed: the verdict widening ─────────────────────────────────────
//
// `passed: boolean` had to answer four different questions with two values. A
// gate that ran and failed, a probe that could not run, and an obligation that
// was withdrawn all reached the stream as `passed: false` — or, for a withdrawn
// one, as `passed: true`, which reads as a gate that ran and succeeded. A
// reader gating on the boolean cannot tell any of them apart, so a stop it
// should have made and a stop it should not have made look identical.
//
// The widening has to hold two things at once, and they pull against each
// other: the new field must be expressive enough to carry the distinction, and
// the change must be ADDITIVE — every row already on a stream stays valid, and
// every reader written against `passed` keeps working. The cases below are that
// pair, plus the derivation that keeps the two fields from drifting.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';

import { GateExecutedData, GateVerdictSchema } from '../../../src/events/schemas.js';

/** A row in the shape that predates the field, as it appears on a stream. */
const historicalRow = (passed: boolean): Record<string, unknown> => ({
  gateName: 'check_static_analysis',
  layer: 'review',
  passed,
  duration: 12.5,
  details: { exitCode: passed ? 0 : 1 },
});

describe('gate.executed verdict widening', () => {
  it('HistoricalRow_WithoutVerdict_StillParses', () => {
    // The additive claim, stated over the two historical shapes directly.
    const passing = GateExecutedData.parse(historicalRow(true));
    const failing = GateExecutedData.parse(historicalRow(false));

    expect(passing.passed).toBe(true);
    expect(failing.passed).toBe(false);
    // Absent, not defaulted. A default would silently assert a verdict the
    // emitter never computed — precisely the claim this field exists to stop
    // being made on someone else's behalf.
    expect(passing.verdict).toBeUndefined();
    expect(failing.verdict).toBeUndefined();
  });

  it('HistoricalRow_AnyShape_RemainsValid', () => {
    // The additive property, quantified rather than sampled: no combination of
    // the pre-existing fields is refused by the widened schema.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.boolean(),
        fc.option(fc.double({ min: 0, max: 1e6, noNaN: true }), { nil: undefined }),
        (gateName, layer, passed, duration) => {
          const parsed = GateExecutedData.safeParse({
            gateName,
            layer,
            passed,
            ...(duration === undefined ? {} : { duration }),
          });
          return parsed.success;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('Passed_EqualsVerdictIsPass', () => {
    // The derivation, both directions, over the WHOLE vocabulary rather than a
    // sampled member — a fifth verdict added later inherits this case instead
    // of slipping past a hand-listed three.
    const vocabulary = GateVerdictSchema.options;
    expect(vocabulary.length, 'the verdict vocabulary is empty').toBeGreaterThan(3);

    const contradictions: string[] = [];
    for (const verdict of vocabulary) {
      const agreeing = verdict === 'pass';

      const ok = GateExecutedData.safeParse({ ...historicalRow(agreeing), verdict });
      if (!ok.success) contradictions.push(`agreeing row rejected: verdict=${verdict}`);

      const bad = GateExecutedData.safeParse({ ...historicalRow(!agreeing), verdict });
      if (bad.success) contradictions.push(`contradicting row accepted: verdict=${verdict}`);
    }

    expect(contradictions, 'the derivation is not enforced over the whole vocabulary').toEqual([]);
  });

  it('IndeterminateRow_DoesNotReadAsPass', () => {
    // The finding that motivated the field. Both non-decisions must be
    // expressible, and neither may reach a boolean reader as a pass.
    for (const verdict of ['indeterminate', 'not-applicable'] as const) {
      const row = GateExecutedData.parse({ ...historicalRow(false), verdict });
      expect(row.verdict, `${verdict} was not carried onto the row`).toBe(verdict);
      expect(row.passed, `${verdict} reached a boolean reader as a pass`).toBe(false);
    }

    // And the converse, so the two above are not passing because the schema
    // refuses everything: a real pass still round-trips as one.
    const decided = GateExecutedData.parse({ ...historicalRow(true), verdict: 'pass' });
    expect(decided.passed).toBe(true);
    expect(decided.verdict).toBe('pass');
  });

  it('WithdrawnObligation_IsNotWrittenDownAsAFailure', () => {
    // `not-applicable` is the one that used to have NO honest encoding: written
    // as `passed: true` it reads as a gate that ran and succeeded, and as
    // `passed: false` it reads as a stop. The derivation forces the second
    // spelling, so the boolean is not a pass — and the verdict is what says the
    // difference between "failed" and "was never owed".
    const withdrawn = GateExecutedData.parse({
      ...historicalRow(false),
      verdict: 'not-applicable',
    });
    expect(withdrawn.passed).toBe(false);
    expect(withdrawn.verdict).not.toBe('fail');

    // The old spelling is now refused outright rather than silently accepted.
    const oldSpelling = GateExecutedData.safeParse({
      ...historicalRow(true),
      verdict: 'not-applicable',
    });
    expect(
      oldSpelling.success,
      'a withdrawn obligation was still expressible as a gate that passed',
    ).toBe(false);
  });
});
