/**
 * A golden of the fold of one mixed history of transition rows and settlement rows.
 *
 * The rows come from one run of `walkSettledFeature` in `tests/helpers/replay/settled-feature-walk.ts`.
 * A scratch script ran the walk once under `bun` and saved the rows of its stream, each without its event id.
 * No row is hand-written, because a transition appends a trail of rows and not one row.
 * The test folds `migrateEvents(rows)` through the workflow-state projection, as a stored history reaches the fold.
 * It pins the phase after each row, so a later change that lets settle append transition rows keeps this history green.
 *
 * @oracle-sources: ../../../src/projections/views/workflow-state-projection.ts, the runs of phases that the lead writes by hand from a read of the fixture
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { migrateEvents } from '../../../src/events/event-migration.js';
import {
  EVENT_DATA_SCHEMAS,
  EventTypes,
  WorkflowEventBase,
  type WorkflowEvent,
} from '../../../src/events/schemas.js';
import {
  workflowStateProjection,
  type WorkflowStateView,
} from '../../../src/projections/views/workflow-state-projection.js';

/** The fixture. Each element is one stored row of the walk stream without its event id. */
const FIXTURE_PATH = path.resolve(import.meta.dirname, '__fixtures__', 'mixed-history.events.json');

/** The six kinds of the settlement ledger. The projection folds each one as a no-op. */
const SETTLEMENT_KINDS: readonly string[] = [
  'workflow.prepared',
  'execution.settled',
  'deviation.proposed',
  'deviation.decided',
  'design.revised',
  'capsule.recompiled',
];

/** The settlement rows of the walk: two prepared rows, three settled rows and one row of each other kind. */
const SETTLEMENT_ROW_COUNT = 9;

/** Consecutive rows that leave the fold in one phase. */
interface PhaseRun {
  first: number;
  last: number;
  phase: string;
}

/** The phase after each row, written by hand from a read of the fixture as runs of rows. */
const PINNED_RUNS: readonly PhaseRun[] = [
  { first: 1, last: 2, phase: 'plan' },
  { first: 3, last: 6, phase: 'plan-review' },
  { first: 7, last: 68, phase: 'delegate' },
  { first: 69, last: 72, phase: 'review' },
];

/** The phase of the fold after one row. */
interface PhaseAfterRow {
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
}

/** The elements of the fixture as the file holds them, before a schema reads them. */
function fixtureElements(): unknown[] {
  return z.array(z.unknown()).parse(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
}

/** The rows of the fixture, each parsed with the base schema of a stored row. A refused row throws with its position. */
function fixtureRows(): WorkflowEvent[] {
  return fixtureElements().map((element, index) => {
    const parsed = WorkflowEventBase.safeParse(element);
    if (!parsed.success) throw new Error(`fixture element ${index + 1} does not parse: ${parsed.error.message}`);
    return parsed.data;
  });
}

/** The data schema of a built-in event type, or `undefined` when the registry holds no entry for it. */
function dataSchemaOf(type: string): z.ZodType | undefined {
  const builtIn = EventTypes.find((candidate) => candidate === type);
  return builtIn === undefined ? undefined : EVENT_DATA_SCHEMAS[builtIn];
}

/** Folds `migrateEvents(rows)` through the projection. It records the phase after each row and returns the last view. */
function foldRowByRow(rows: readonly WorkflowEvent[]): { steps: PhaseAfterRow[]; last: WorkflowStateView } {
  const steps: PhaseAfterRow[] = [];
  let view = workflowStateProjection.init();
  for (const row of migrateEvents(rows)) {
    view = workflowStateProjection.apply(view, row);
    steps.push({ sequence: row.sequence, type: row.type, phase: view.phase });
  }
  return { steps, last: view };
}

/** Groups the phase after each row into runs of consecutive rows with one phase. */
function runsOf(steps: readonly PhaseAfterRow[]): PhaseRun[] {
  const runs: PhaseRun[] = [];
  let open: PhaseRun | undefined;
  for (const step of steps) {
    if (open !== undefined && open.phase === step.phase) {
      open.last = step.sequence;
      continue;
    }
    open = { first: step.sequence, last: step.sequence, phase: step.phase };
    runs.push(open);
  }
  return runs;
}

describe('MixedHistoryGolden', () => {
  /** A row that the base schema or the data schema of its type refuses is a failure that names its row. */
  it('MixedHistoryGolden_EachRow_ParsesWithTheSchemaOfItsType', () => {
    const elements = fixtureElements();
    const failures: string[] = [];
    let dataChecks = 0;
    elements.forEach((element, index) => {
      const base = WorkflowEventBase.safeParse(element);
      if (!base.success) {
        failures.push(`element ${index + 1}: ${base.error.message}`);
        return;
      }
      const schema = dataSchemaOf(base.data.type);
      if (schema === undefined) return;
      dataChecks += 1;
      const data = schema.safeParse(base.data.data);
      if (!data.success) failures.push(`sequence ${base.data.sequence} (${base.data.type}): ${data.error.message}`);
    });

    expect(elements.length).toBeGreaterThan(0);
    expect(dataChecks).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });

  /** `state.patched` has no data schema. Each other type of the walk has one, so the base schema is not its only check. */
  it('MixedHistoryGolden_TheTypesWithNoDataSchema_AreOnlyStatePatched', () => {
    const types = [...new Set(fixtureRows().map((row) => row.type))];

    expect(types.length).toBeGreaterThan(1);
    expect(types.filter((type) => dataSchemaOf(type) === undefined)).toEqual(['state.patched']);
  });

  /** The denominator of the golden: each settlement kind and at least three transition rows. */
  it('MixedHistoryGolden_TheFixture_HoldsEachSettlementKindAndThreeTransitions', () => {
    const types = fixtureRows().map((row) => row.type);

    expect(SETTLEMENT_KINDS.filter((kind) => !types.includes(kind))).toEqual([]);
    expect(types.filter((type) => type === 'workflow.transition').length).toBeGreaterThanOrEqual(3);
  });

  /** The sequences run from 1 with no gap, so no row of the walk is absent between two runs. */
  it('MixedHistoryGolden_TheFold_GivesThePinnedPhaseAfterEachRow', () => {
    const { steps } = foldRowByRow(fixtureRows());

    expect(steps.map((step) => step.sequence)).toEqual(steps.map((_step, index) => index + 1));
    expect(runsOf(steps)).toEqual(PINNED_RUNS);
  });

  /** The phase after each settlement row equals the phase before it. */
  it('MixedHistoryGolden_NoSettlementRow_MovesThePhase', () => {
    const { steps } = foldRowByRow(fixtureRows());
    const moves: string[] = [];
    let settlementRows = 0;
    let before = workflowStateProjection.init().phase;
    for (const step of steps) {
      if (SETTLEMENT_KINDS.includes(step.type)) {
        settlementRows += 1;
        if (step.phase !== before) moves.push(`sequence ${step.sequence} (${step.type}): ${before} to ${step.phase}`);
      }
      before = step.phase;
    }

    expect(settlementRows).toBe(SETTLEMENT_ROW_COUNT);
    expect(moves).toEqual([]);
  });

  /** The trail of a transition enters its target before the next transition. A hand-written transition row has no such trail. */
  it('MixedHistoryGolden_EachTransitionRow_HasAPhaseEnteredRowForItsTarget', () => {
    const rows = fixtureRows();
    const unentered: string[] = [];
    let transitions = 0;
    rows.forEach((row, index) => {
      if (row.type !== 'workflow.transition') return;
      transitions += 1;
      const target = row.data?.['to'];
      const next = rows.findIndex((later, laterIndex) => laterIndex > index && later.type === 'workflow.transition');
      const trail = rows.slice(index + 1, next === -1 ? rows.length : next);
      const entered = trail.some((later) => later.type === 'phase.entered' && later.data?.['phase'] === target);
      if (typeof target !== 'string' || !entered) unentered.push(`sequence ${row.sequence} to ${String(target)}`);
    });

    expect(transitions).toBeGreaterThanOrEqual(3);
    expect(unentered).toEqual([]);
  });

  /** The product wrote each row that sets the phase, the history and the obligation of the last view. */
  it('MixedHistoryGolden_TheLastRow_EndsInReviewWithTheObligationOfReview', () => {
    const { last } = foldRowByRow(fixtureRows());

    expect(last.phase).toBe('review');
    expect(last._history).toEqual({});
    expect(last.phaseObligation?.phase).toBe('review');
    expect(last.phaseObligation?.kind).toBe('REVIEW');
  });
});
