// ─── The verdict widening is invisible to every existing reader ──────────────
//
// Widening a durable record has two failure modes, and only one of them is
// caught by parsing the record. The schema test next door proves a historical
// row still VALIDATES. It cannot prove that a stream carrying the new field
// still PROJECTS to the same place — a fold that started keying on `verdict`,
// or that stopped keying on `passed`, would sail past a schema check and
// silently move every view built on it.
//
// So this drives the real projections over the same events twice: once in the
// shape they have on a stream today, once with the derived verdict added, and
// requires the two results to be indistinguishable. The verdict is additive
// exactly to the extent that this holds.
//
// @oracle-sources: ../../src/projections/views/code-quality-view.ts, ../../src/projections/views/delegation-readiness-view.ts
//
// The authorities are the FOLDS, and they are separately maintained: neither
// imports the other, and each decides independently what a `gate.executed` row
// means to it. The schema is the subject here, not an oracle — every projection
// imports it, so pairing it with one of them would be one authority wearing two
// names.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import { GateExecutedData, type WorkflowEvent } from '../../src/events/schemas.js';
import { codeQualityProjection } from '../../src/projections/views/code-quality-view.js';
import { synthesisReadinessProjection } from '../../src/projections/views/synthesis-readiness-view.js';
import { delegationReadinessProjection } from '../../src/projections/views/delegation-readiness-view.js';
import type { ViewProjection } from '../../src/projections/views/types.js';

/**
 * A stream that exercises every arm the folds branch on: the review gate name
 * they special-case, the mutation gate whose `details` they read, and ordinary
 * pass/fail rows. A replay proof over rows that all take one branch proves that
 * branch and nothing else.
 */
const GATE_ROWS: readonly Record<string, unknown>[] = [
  { gateName: 'check_static_analysis', layer: 'review', passed: true, duration: 1200 },
  { gateName: 'check_security_scan', layer: 'review', passed: false, duration: 340 },
  { gateName: 'review', layer: 'review', passed: true, duration: 900 },
  { gateName: 'spec-review', layer: 'review', passed: false },
  {
    gateName: 'check_mutation_adequacy',
    layer: 'review',
    passed: true,
    duration: 45_000,
    details: { mutationScore: 0.82, taskId: 'task-007' },
  },
  { gateName: 'check_test_adequacy', layer: 'delegate', passed: true, details: { taskId: 'task-007' } },
  { gateName: 'check_diff_hygiene', layer: 'review', passed: false, duration: 77 },
];

/** The derivation under test, applied as a writer would apply it. */
const withVerdict = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  verdict: row.passed === true ? 'pass' : 'fail',
});

const asEvent = (data: Record<string, unknown>, sequence: number): WorkflowEvent => ({
  streamId: 'verdict-replay',
  sequence,
  timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
  type: 'gate.executed' as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

function replay<T>(projection: ViewProjection<T>, rows: readonly Record<string, unknown>[]): T {
  return rows.reduce<T>(
    (state, row, index) => projection.apply(state, asEvent(row, index + 1)),
    projection.init(),
  );
}

const PROJECTIONS = [
  { name: 'code-quality', projection: codeQualityProjection as ViewProjection<unknown> },
  { name: 'synthesis-readiness', projection: synthesisReadinessProjection as ViewProjection<unknown> },
  { name: 'delegation-readiness', projection: delegationReadinessProjection as ViewProjection<unknown> },
];

describe('gate.executed verdict replay', () => {
  it('Replay_ProducesTheSameProjection', () => {
    // Denominators first. A corpus that does not parse, or a projection list
    // that failed to load, would make every comparison below trivially true.
    expect(GATE_ROWS.length, 'the replay corpus is empty').toBeGreaterThan(5);
    expect(PROJECTIONS.length, 'no projection was loaded to replay against').toBeGreaterThan(2);

    const rejected = GATE_ROWS.map(withVerdict).filter((row) => !GateExecutedData.safeParse(row).success);
    expect(rejected, 'the verdict-carrying corpus does not satisfy the schema').toEqual([]);

    const moved: string[] = [];
    for (const { name, projection } of PROJECTIONS) {
      const historical = replay(projection, GATE_ROWS);
      const widened = replay(projection, GATE_ROWS.map(withVerdict));
      if (JSON.stringify(historical) !== JSON.stringify(widened)) moved.push(name);
    }

    expect(moved, 'a projection moved when the derived verdict was added').toEqual([]);
  });

  it('Replay_SeededDivergence_IsReported', () => {
    // The kill probe. The comparison above reports `[]` both when nothing moved
    // and when the fold silently ignored the whole corpus, so a divergence the
    // projections CAN see has to be shown to surface — otherwise the case
    // proves only that two identical computations agree.
    const flipped = GATE_ROWS.map((row) => ({ ...row, passed: row.passed !== true }));

    const moved = PROJECTIONS.filter(({ projection }) => {
      const before = JSON.stringify(replay(projection, GATE_ROWS));
      const after = JSON.stringify(replay(projection, flipped));
      return before !== after;
    });

    expect(
      moved.length,
      'flipping every `passed` moved no projection — the replay comparison is inert',
    ).toBeGreaterThan(0);
  });

  it('Replay_HistoricalAndWidenedRows_Interleave', () => {
    // A real stream during the migration carries BOTH shapes: rows written
    // before the field and rows written after it, in one order. Replaying the
    // mixture must land where the all-historical replay lands, or the widening
    // is additive only for streams that were never mixed — which is no stream
    // that matters.
    const interleaved = GATE_ROWS.map((row, index) => (index % 2 === 0 ? withVerdict(row) : row));

    const moved = PROJECTIONS.filter(
      ({ projection }) =>
        JSON.stringify(replay(projection, GATE_ROWS)) !==
        JSON.stringify(replay(projection, interleaved)),
    ).map(({ name }) => name);

    expect(moved, 'a projection distinguished a mixed-shape stream').toEqual([]);
  });
});
