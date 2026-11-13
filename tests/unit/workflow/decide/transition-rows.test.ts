/**
 * These tests compare the result and the stream rows of the three guarded handlers with a golden.
 * A scratch script wrote the golden once, before any change of the guarded handlers. No test writes it.
 * Each scenario runs on its own temporary SQLite store, so the state document is the `workflow_state` row.
 * The mask replaces each value that changes on each run, so the golden holds no value of one run.
 *
 * The transition handler decides on the ledger fold and commits each move through one operation claim.
 * So the capture differs from the golden by a named delta. A phase row of a transition move holds no idempotency key.
 * Each move has one operation claim. The one denial gains the valid targets of the fold phase.
 *
 * Cleanup backfill patches only the supplied synthesis fields and the absent PR artifact.
 * The six corpus defects are no scenario here.
 *
 * @oracle-sources: ./__fixtures__/transition-rows.golden.json, ../../../../src/workflow/handlers/set.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  captureTransitionRows,
  maskRows,
  renderTransitionRowsGolden,
  TRANSITION_ROW_SCENARIOS,
  transitionClaimsOf,
} from '../../../helpers/decide/transition-rows.js';

/** The golden file that the scratch capture wrote once. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/transition-rows.golden.json',
);

/** The part of a golden entry that the tests read. */
const GoldenEntrySchema = z.object({
  name: z.string(),
  result: z.looseObject({ success: z.boolean() }),
  rows: z.array(z.looseObject({ type: z.string() })),
});

/** The eleven scenarios of the golden, in golden order. */
const ELEVEN_SCENARIOS: readonly string[] = [
  'feature plan -> plan-review',
  'feature plan-review -> delegate',
  'feature delegate -> review',
  'feature review -> delegate as a fix cycle',
  'feature delegate -> review denied with a pending task',
  'feature review -> synthesize at the high tier',
  'oneshot implementing -> synthesize',
  'debug triage -> investigate',
  'debug investigate -> cancelled with investigation.escalate',
  'cancel of a debug workflow at investigate',
  'cleanup of a feature at synthesize with merge evidence',
];

/** The row kinds that the golden holds at least once. */
const ROW_KINDS: readonly string[] = [
  'workflow.transition',
  'phase.exited',
  'phase.entered',
  'workflow.fix-cycle',
  'workflow.guard-failed',
  'workflow.cancel',
  'workflow.cleanup',
];

/** A phase attempt id of the digest form, as the transition after init allocates it. */
const PHASE_ATTEMPT_ID = `phase-attempt:${'a1'.repeat(32)}`;

/** A UUID, as init allocates it for the first phase attempt id. */
const UUID = '0f8e2b7c-4d1a-4c3e-9b6f-2a5d8c7e1f30';

/** A cancel idempotency key, as a digest over the cancel id. */
const CANCEL_KEY = `cancel:${'b2'.repeat(32)}`;

/** Reads the golden as JSON. */
function readGolden(): unknown {
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
}

/** The key form of a phase row that the legacy transition guard appended: the feature, the event, the edge and the document version. */
const LEGACY_TRANSITION_KEY = /^[^:]+:(transition|phase\.exited|phase\.entered|compound-entry|compound-exit|fix-cycle|plan-revision|cancel|cleanup):[^:]+:[^:]+:\d+$/;

/** The valid targets of the fold phase `delegate` of a feature, which the one denial gains. */
const DELEGATE_VALID_TARGETS: readonly string[] = ['review', 'merge-pending', 'cancelled', 'completed'];

/** The name of the one denied scenario. */
const DENIED_SCENARIO = 'feature delegate -> review denied with a pending task';

/** A golden row with its idempotency key, as the delta reads it. */
const GoldenRowSchema = z.looseObject({ idempotencyKey: z.string().nullable() });

/** A golden entry, as the delta reads it. */
const DeltaEntrySchema = z.looseObject({
  name: z.string(),
  result: z.looseObject({ error: z.looseObject({}).optional() }),
  rows: z.array(GoldenRowSchema),
});

/**
 * Applies the named deltas to the golden. Transition phase rows lose their keys, and the denial gains valid targets.
 * Cleanup backfill uses exact supplied dot paths. No other value changes.
 */
function goldenWithTheDelta(golden: unknown): unknown {
  return z.array(DeltaEntrySchema).parse(golden).map((entry) => ({
    ...entry,
    rows: entry.rows.map((row) => {
      if (row.idempotencyKey === 'transition-rows-feature-cleanup:cleanup:patch:synthesize') {
        const data = z.record(z.string(), z.unknown()).parse(row.data);
        expect(data.fields).toEqual(['synthesis', 'artifacts']);
        expect(data.patch).toEqual({
          synthesis: {
            integrationBranch: null,
            mergeOrder: [],
            mergedBranches: ['feat/transition-rows-cleanup'],
            prFeedback: [],
            prUrl: 'https://example.com/pr/1',
          },
          artifacts: { design: null, plan: 'plans/plan.md', pr: 'https://example.com/pr/1' },
        });
        return { ...row, data: {
          ...data,
          fields: ['synthesis.prUrl', 'synthesis.mergedBranches', 'artifacts.pr'],
          patch: {
            'synthesis.prUrl': 'https://example.com/pr/1',
            'synthesis.mergedBranches': ['feat/transition-rows-cleanup'],
            'artifacts.pr': 'https://example.com/pr/1',
          },
        } };
      }
      return row.idempotencyKey !== null && LEGACY_TRANSITION_KEY.test(row.idempotencyKey) ? { ...row, idempotencyKey: null } : row;
    }),
    ...(entry.name === DENIED_SCENARIO && entry.result.error !== undefined
      ? { result: { ...entry.result, error: { ...entry.result.error, validTargets: DELEGATE_VALID_TARGETS } } }
      : {}),
  }));
}

describe('the rows and results of the guarded handlers', () => {
  /**
   * Each scenario runs on the live handlers, and the masked capture equals the golden.
   * A change of a handler result or of a stream row changes the capture.
   */
  it('TransitionRows_EachScenario_EqualsTheGolden', async () => {
    const entries: unknown[] = [];
    for (const scenario of TRANSITION_ROW_SCENARIOS) {
      entries.push(maskRows(await captureTransitionRows(scenario)));
    }

    expect(JSON.parse(renderTransitionRowsGolden(entries))).toStrictEqual(
      JSON.parse(renderTransitionRowsGolden(z.array(z.unknown()).parse(goldenWithTheDelta(readGolden())))),
    );
    for (const scenario of TRANSITION_ROW_SCENARIOS) {
      const claims = transitionClaimsOf(scenario.name);
      expect(claims?.moveAttemptIds.length, scenario.name).toBeGreaterThan(0);
      expect(claims?.claimedAttemptIds, scenario.name).toEqual(claims?.moveAttemptIds);
    }
  });

  /** The golden holds the eleven scenarios in order, the one denial, and each row kind of a move, a denial, a cancel and a cleanup. */
  it('TransitionRows_TheGolden_HoldsElevenScenariosAndEachRowKind', () => {
    const golden = z.array(GoldenEntrySchema).parse(readGolden());

    expect(golden.map((entry) => entry.name)).toEqual(ELEVEN_SCENARIOS);
    expect(golden.filter((entry) => !entry.result.success).map((entry) => entry.name)).toEqual([
      'feature delegate -> review denied with a pending task',
    ]);
    const kinds = new Set(golden.flatMap((entry) => entry.rows.map((row) => row.type)));
    for (const kind of ROW_KINDS) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  /** Each row holds one literal of one masked kind, and the mask gives its token. A value of no masked kind stays. */
  it('TransitionRows_TheMask_ReplacesEachVolatileField', () => {
    const rows: readonly { readonly literal: Record<string, unknown>; readonly masked: Record<string, unknown> }[] = [
      { literal: { phaseAttemptId: PHASE_ATTEMPT_ID }, masked: { phaseAttemptId: '<phase-attempt-id>' } },
      { literal: { cancelId: `cancel:${PHASE_ATTEMPT_ID}` }, masked: { cancelId: 'cancel:<phase-attempt-id>' } },
      { literal: { phaseAttemptId: UUID }, masked: { phaseAttemptId: '<uuid>' } },
      { literal: { instanceId: `cancel-instance:${UUID}` }, masked: { instanceId: 'cancel-instance:<uuid>' } },
      { literal: { idempotencyKey: CANCEL_KEY }, masked: { idempotencyKey: '<cancel-key>' } },
      { literal: { requestedAt: '2026-11-12T10:52:44.404Z' }, masked: { requestedAt: '<timestamp>' } },
      { literal: { caller: { principalId: 'operator:local:3f9a' } }, masked: { caller: { principalId: '<principal-id>' } } },
      {
        literal: { contentDigest: { algorithm: 'sha256', value: 'c3'.repeat(32) } },
        masked: { contentDigest: '<content-digest>' },
      },
      { literal: { from: 'investigate', trigger: 'user-cancel' }, masked: { from: 'investigate', trigger: 'user-cancel' } },
    ];

    for (const row of rows) {
      expect(maskRows([row.literal])).toStrictEqual([row.masked]);
    }
  });
});
