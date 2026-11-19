/**
 * This test checks the document side of the guard input against the state that `handleSet` gave the guard before the ledger fold decided.
 * The guard-state golden holds that state. The case runs the seven transitions of the golden.
 * Inside the guard wrapper, it reads the state document and the rows of the stream.
 * Literal deltas to the frozen golden cover projected obligations, admission records, preserved checkpoint summaries and canonical task defaults.
 * The handler injects the default review gates also with no options, so the case passes `{}` as the live shadow does.
 *
 * @oracle-sources: ../../../../src/projections/guard-input/fold.ts, ./__fixtures__/handle-set-guard-state.golden.json
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { documentGuardInput, type GuardInput } from '../../../../src/projections/guard-input/fold.js';
import { readStateFile } from '../../../../src/workflow/state-store.js';
import { captureTransitionGuardStates, maskGuardState } from '../../../helpers/guard-input/guard-state-spy.js';

/** The golden of the state that the guard got before the ledger fold decided. */
const GOLDEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/handle-set-guard-state.golden.json');

/** The part of a golden entry that the test reads. */
const GoldenEntrySchema = z.object({ name: z.string(), state: z.record(z.string(), z.unknown()) });

/** Returns the golden state of each transition, by name. */
function goldenStates(): ReadonlyMap<string, Record<string, unknown>> {
  const golden = z.array(GoldenEntrySchema).parse(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')));
  return new Map(golden.map((entry) => [entry.name, entry.state]));
}

/** The state document and the rows of one transition, as the wrapper reads them at the guard call. */
interface DocumentRead {
  readonly document: GuardInput;
  readonly rows: readonly WorkflowEvent[];
}

/** The seven transitions of the golden, in golden order. */
const SEVEN_TRANSITIONS: readonly string[] = [
  'feature plan -> plan-review',
  'feature plan-review -> delegate',
  'feature delegate -> review',
  'feature review -> synthesize at the high tier',
  'feature review -> synthesize at the medium tier',
  'oneshot implementing -> synthesize',
  'debug triage -> investigate',
];

/**
 * Returns a copy of a guard state without the phase attempt id.
 * The handler sets that id before the guard call, and the document side does not set it.
 */
function withoutPhaseAttemptId(state: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => key !== '_pendingPhaseAttemptId'));
}

/** The empty admission record that complete replay adds to every seeded document. */
const EMPTY_PROOF = {
  evidenceHistory: [], contradictionHistory: [], activeEvidence: [], supersessions: [], contradictions: [], diagnostics: [],
  requirementHistory: [], decisionHistory: [], phaseAttempts: [], phaseAttemptDiagnostics: [], phaseAttemptIntegrity: 'intact',
};

/** The common frozen fields of these literal phase-entry fixtures. */
const OBLIGATION_FIELDS = {
  policySource: 'builtin', mode: 'enforce', riskTier: 'unknown', boundaryTouching: true,
  enteredAt: '<timestamp>', exited: false, allRequiredGatesPassed: null,
};

/** Complete replay retains the source phase obligation instead of omitting it from the document. */
const OBLIGATION_BY_PHASE: Readonly<Record<string, unknown>> = {
  plan: null,
  triage: null,
  'plan-review': { ...OBLIGATION_FIELDS, phase: 'plan-review', kind: 'PLAN', resolver: 'plan-structure', posture: 'read-only',
    resolvedGates: [
      { family: 'plan', gate: 'check_task_decomposition' }, { family: 'plan', gate: 'check_plan_coverage' },
      { family: 'plan', gate: 'spec_coverage_check' }, { family: 'plan', gate: 'check_provenance_chain' },
      { family: 'plan', gate: 'generate_traceability' },
    ] },
  delegate: { ...OBLIGATION_FIELDS, phase: 'delegate', kind: 'IMPLEMENT', resolver: 'verification-ladder', posture: 'task-isolated', resolvedGates: [] },
  review: { ...OBLIGATION_FIELDS, phase: 'review', kind: 'REVIEW', resolver: 'review-contract', posture: 'read-only', resolvedGates: [{ family: 'review', gate: 'review' }] },
  implementing: { ...OBLIGATION_FIELDS, phase: 'implementing', kind: 'IMPLEMENT', resolver: 'verification-ladder', posture: 'task-isolated', resolvedGates: [] },
};

describe('the document side of the guard input', () => {
  /**
   * The document side equals the frozen golden with the declared projection deltas and no pending phase attempt id.
   * Five transitions pass no options, and the three feature transitions among them still hold the default review gate.
   */
  it('DocumentSide_EachGoldenTransition_EqualsTheStateThatTheGuardGets', async () => {
    const reads = new Map<string, DocumentRead>();
    const entries = await captureTransitionGuardStates(async ({ name, stateDir, eventStore, attempt }) => {
      const document = await readStateFile(path.join(stateDir, `${attempt.featureId}.state.json`));
      const rows = await eventStore.query(attempt.featureId);
      reads.set(name, { document, rows });
    });

    expect(entries.map((entry) => entry.name)).toEqual(SEVEN_TRANSITIONS);
    expect([...reads.keys()]).toEqual(SEVEN_TRANSITIONS);
    expect(entries.filter((entry) => entry.options === undefined)).toHaveLength(5);
    const golden = goldenStates();
    for (const entry of entries) {
      const read = reads.get(entry.name);
      if (read === undefined) throw new Error(`the wrapper read no document for '${entry.name}'`);
      expect(read.rows.length, entry.name).toBeGreaterThan(0);
      expect(entry.state._pendingPhaseAttemptId, entry.name).toEqual(expect.any(String));

      const documentSide = documentGuardInput(read.document, read.rows, { config: entry.options ?? {} });
      const goldenState = golden.get(entry.name);
      if (goldenState === undefined) throw new Error(`the golden holds no state for '${entry.name}'`);

      const masked = maskGuardState(documentSide);
      const expected = withoutPhaseAttemptId(goldenState);
      const checkpoint = z.record(z.string(), z.unknown()).parse(expected._checkpoint);
      const tasks = z.array(z.record(z.string(), z.unknown())).parse(expected.tasks);
      expect(masked.phaseObligation, entry.name).toEqual(OBLIGATION_BY_PHASE[entry.from]);
      expect(masked.admissionProof, entry.name).toEqual(EMPTY_PROOF);
      expect(masked._checkpoint, entry.name).toEqual({ ...checkpoint, summary: 'Workflow initialized' });
      expect(masked.tasks, entry.name).toEqual(tasks.map((task) => ({ ...task, blockedBy: [] })));
      expect(masked, entry.name).toStrictEqual({
        ...expected,
        phaseObligation: OBLIGATION_BY_PHASE[entry.from],
        admissionProof: EMPTY_PROOF,
        _checkpoint: { ...checkpoint, summary: 'Workflow initialized' },
        tasks: tasks.map((task) => ({ ...task, blockedBy: [] })),
      });
      const captured = maskGuardState(entry.state);
      for (const field of ['phase', 'phaseAttemptId', 'phaseObligation', 'admissionProof', 'artifacts', '_history', 'reviews', 'synthesis', 'worktrees', '_events']) {
        expect(masked[field], `${entry.name}: ${field}`).toEqual(captured[field]);
      }
    }
    const featureWithNoOptions = entries.filter((entry) => entry.workflowType === 'feature' && entry.options === undefined);
    expect(featureWithNoOptions.map((entry) => entry.state._requiredReviews)).toEqual([['review'], ['review'], ['review']]);
  });
});
