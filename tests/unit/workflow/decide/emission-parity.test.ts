/**
 * These tests compare the emission over a definition with the frozen results of the legacy executor.
 * Each stored input of the built-in golden runs through the decide and the emission. The compared
 * projection of each result equals the golden result, except on the six known legacy defects.
 *
 * The golden runs with a gate resolver that gives no gates and with no floor. So one case pins the gate
 * union with a hand-written literal.
 *
 * @oracle-sources: ../__fixtures__/built-in.golden.json, ../../../../src/workflow/state-machine.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readStoredInputs, type EmissionInput } from '../../../helpers/definitions/built-in-golden.js';
import { builtInDefinition, isBuiltInDefinitionType } from '../../../../src/workflow/definitions/built-in.js';
import { compileDecideDefinition, type DecideDefinition } from '../../../../src/workflow/decide/edges.js';
import { decide, type DecideRequest } from '../../../../src/workflow/decide/decide.js';
import {
  denialEvents,
  phaseMoveEvents,
  type TransitionObligationFloor,
  type TransitionResult,
} from '../../../../src/workflow/decide/emit.js';
import { phaseRowsOf } from '../../../../src/workflow/decide/rows.js';
import { validateEventData } from '../../../../src/events/event-validation.js';
import { executeTransition, getHSMDefinition } from '../../../../src/workflow/state-machine.js';
import type { PhaseKind, ResolvedGate, ResolveGateSetCtx } from '../../../../src/workflow/phase-kind.js';

/** The golden file that the scratch capture wrote once. No test writes it. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/built-in.golden.json',
);

/** The text of the golden file. */
const GOLDEN_TEXT = fs.readFileSync(GOLDEN_PATH, 'utf8');

/** The six corpus fixtures where the legacy executor admits a fail-shaped state and the edge conditions deny it. */
const THE_SIX: readonly string[] = [
  'bypass-always-pass-implementation-ignores-fail-shaped-state',
  'bypass-empty-task-collection-is-complete',
  'debug-debug-implement-to-debug-validate-fail',
  'debug-hotfix-implement-to-hotfix-validate-fail',
  'debug-investigate-to-cancelled-fail',
  'refactor-polish-implement-to-polish-validate-fail',
];

/** The keys of a result that the comparison reads. */
const PROJECTED_KEYS: readonly string[] = [
  'success',
  'idempotent',
  'newPhase',
  'effects',
  'events',
  'historyUpdates',
  'resolvedGates',
  'errorCode',
];

/** The text fields of a failed result. They come from the legacy guard module, which the decide does not read. */
const EXCLUDED_KEYS: readonly string[] = ['errorMessage', 'guardDescription', 'guardExpectedShape', 'guardSuggestedFix'];

/** The external event type of each internal event type that a golden move holds. */
const EXTERNAL_TYPE: Readonly<Record<string, string>> = {
  transition: 'workflow.transition',
  cancel: 'workflow.cancel',
  cleanup: 'workflow.cleanup',
  'compound-entry': 'workflow.compound-entry',
  'compound-exit': 'workflow.compound-exit',
  'fix-cycle': 'workflow.fix-cycle',
  'plan-revision': 'workflow.plan-revision',
  'phase.exited': 'phase.exited',
  'phase.entered': 'phase.entered',
};

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the stored golden results, in the order of the stored inputs. */
function goldenResults(): readonly Record<string, unknown>[] {
  const golden: unknown = JSON.parse(GOLDEN_TEXT);
  const emissions: unknown = isRecord(golden) ? golden.emissions : undefined;
  if (!Array.isArray(emissions)) throw new Error('the golden has no emissions list');
  const entries: readonly unknown[] = emissions;
  return entries.map((entry, index) => {
    const result: unknown = isRecord(entry) ? entry.result : undefined;
    if (!isRecord(result)) throw new Error(`emissions.${index}.result is not an object`);
    return result;
  });
}

/** Returns the compiled definition of a built-in type, with no skip. */
function defOf(type: string): DecideDefinition {
  if (!isBuiltInDefinitionType(type)) throw new Error(`the type '${type}' is not a built-in type`);
  return compileDecideDefinition(type, builtInDefinition(type));
}

/** Returns the request of a stored input: a cancel case cancels, a cleanup case cleans up, and each other case transitions. */
function requestOf(input: EmissionInput): DecideRequest {
  if (input.caseKind === 'cancel') return { kind: 'cancel' };
  if (input.caseKind === 'cleanup') return { kind: 'cleanup' };
  return { kind: 'transition', target: input.target };
}

/** The live result of one stored input, or the kind of an outcome that gives no result. */
interface LiveCase {
  readonly input: EmissionInput;
  readonly result: TransitionResult | { readonly outcome: string };
  readonly guardId?: string | undefined;
}

/** Runs one stored input through the decide and the emission, with the gate resolver of the golden. */
function liveCaseOf(input: EmissionInput): LiveCase {
  const def = defOf(input.type);
  const state = { ...input.state };
  const outcome = decide(def, state, requestOf(input));
  if (outcome.kind === 'admit') {
    const guardId = outcome.move.edgeKind === 'cancel' ? undefined : outcome.move.guardId;
    return { input, result: phaseMoveEvents(def, state, outcome.move, undefined, () => []), guardId };
  }
  if (outcome.kind === 'deny') return { input, result: denialEvents(outcome.from, outcome.edge) };
  return { input, result: { outcome: outcome.kind } };
}

/** Returns the compared projection of a result: the projected keys of its JSON form. */
function projectionOf(result: unknown): Record<string, unknown> {
  const json: unknown = JSON.parse(JSON.stringify(result));
  if (!isRecord(json)) throw new Error('a result is not an object');
  const projection: Record<string, unknown> = {};
  for (const key of PROJECTED_KEYS) {
    if (Object.hasOwn(json, key)) projection[key] = json[key];
  }
  return projection;
}

/** The stored inputs, the golden results and the live cases, in one order. */
const INPUTS = readStoredInputs(GOLDEN_TEXT);
const GOLDEN = goldenResults();
const LIVE = INPUTS.map(liveCaseOf);

/** Returns the ids of the cases whose live projection differs from the golden projection. */
function deltaIds(): readonly string[] {
  return LIVE.filter(
    (live, index) => JSON.stringify(projectionOf(live.result)) !== JSON.stringify(projectionOf(GOLDEN[index])),
  ).map((live) => live.input.caseId);
}

/** A stub resolver that gives one review gate named after the tier of each coordinate. */
function tierGate(_kind: PhaseKind, ctx: ResolveGateSetCtx): readonly ResolvedGate[] {
  return [{ family: 'review', gate: `tier-${ctx.riskTier}` }];
}

describe('the emission over a definition', () => {
  it('PhaseMoveEvents_EachGoldenCase_EqualsTheGolden_ExceptTheSix', () => {
    expect(INPUTS).toHaveLength(207);
    expect(GOLDEN).toHaveLength(207);
    const kept = (caseId: string): boolean => !THE_SIX.includes(caseId);
    const live = LIVE.filter((entry) => kept(entry.input.caseId)).map((entry) => ({
      caseId: entry.input.caseId,
      result: projectionOf(entry.result),
    }));
    const golden = INPUTS.map((input, index) => ({ caseId: input.caseId, result: projectionOf(GOLDEN[index]) })).filter(
      (entry) => kept(entry.caseId),
    );
    expect(live).toHaveLength(201);
    expect(live).toEqual(golden);
  });

  it('PhaseMoveEvents_TheComparedProjection_CoversEachGoldenKey', () => {
    const covered = new Set([...PROJECTED_KEYS, ...EXCLUDED_KEYS]);
    const goldenKeys = new Set(GOLDEN.flatMap((result) => Object.keys(result)));
    expect([...goldenKeys].filter((key) => !covered.has(key))).toEqual([]);
    expect(EXCLUDED_KEYS.filter((key) => !goldenKeys.has(key))).toEqual([]);
  });

  it('PhaseMoveEvents_TheDelta_IsExactlyTheSixCorpusIds', () => {
    expect([...deltaIds()].sort()).toEqual(THE_SIX);
    const six = LIVE.filter((live) => THE_SIX.includes(live.input.caseId));
    expect(six.map((live) => projectionOf(live.result).errorCode)).toEqual(THE_SIX.map(() => 'GUARD_FAILED'));
    const cleanupCase = LIVE.find((live) => live.input.caseId === 'oneshot-synthesize-to-completed-pass');
    expect(cleanupCase === undefined ? undefined : projectionOf(cleanupCase.result).events).toEqual([
      { type: 'cleanup', from: 'synthesize', to: 'completed', trigger: 'cleanup' },
    ]);
  });

  it('PhaseMoveEvents_AFixCycleAtTheLimit_GivesCircuitOpen', () => {
    const def = defOf('feature');
    const fixCycle = { type: 'fix-cycle', metadata: { compoundStateId: 'implementation' } };
    const stateAt = (count: number): Record<string, unknown> => ({
      phase: 'review',
      reviews: { quality: { status: 'failed' } },
      _events: Array.from({ length: count }, () => fixCycle),
    });
    const resultAt = (count: number): TransitionResult => {
      const outcome = decide(def, stateAt(count), { kind: 'transition', target: 'delegate' });
      if (outcome.kind !== 'admit') throw new Error(`the fix-cycle edge gave '${outcome.kind}'`);
      return phaseMoveEvents(def, stateAt(count), outcome.move, undefined, () => []);
    };
    expect(projectionOf(resultAt(3))).toEqual({
      success: false,
      idempotent: false,
      effects: [],
      events: [
        {
          type: 'circuit-open',
          from: 'review',
          to: 'delegate',
          trigger: 'execute-transition',
          metadata: { compoundStateId: 'implementation', compoundId: 'implementation', fixCycleCount: 3, maxFixCycles: 3 },
        },
      ],
      errorCode: 'CIRCUIT_OPEN',
    });
    expect(resultAt(2).events.map((event) => event.type)).toEqual([
      'transition',
      'fix-cycle',
      'phase.exited',
      'phase.entered',
    ]);
  });

  it('PhaseRowsOf_EachMoveOfTheGolden_ParsesWithItsDataSchema', () => {
    const moves = LIVE.filter(
      (live): live is LiveCase & { readonly result: TransitionResult } =>
        'success' in live.result && live.result.success,
    );
    expect(moves).toHaveLength(134);
    const seen = new Set<string>();
    for (const move of moves) {
      const rows = phaseRowsOf(move.result.events, 'emission-parity', { guardId: move.guardId, rows: [] });
      expect(rows.map((row) => row.type)).toEqual(move.result.events.map((event) => EXTERNAL_TYPE[event.type]));
      for (const row of rows) {
        expect(() => validateEventData(row.type, row.data)).not.toThrow();
        seen.add(row.type);
      }
    }
    expect([...seen].sort()).toEqual(Object.values(EXTERNAL_TYPE).sort());
  });

  it('PhaseMoveEvents_ANonEmptyFloor_GivesTheOrderedUnion', () => {
    const def = defOf('feature');
    const state: Record<string, unknown> = {
      phase: 'delegate',
      tasks: [{ id: '001', status: 'complete' }],
      _events: [],
      riskTier: 'low',
      boundaryTouching: false,
    };
    const floor: TransitionObligationFloor = {
      gates: [
        { family: 'review', gate: 'frozen-first' },
        { family: 'review', gate: 'frozen-second' },
      ],
      coordinates: [{ risk: 'high', boundary: 'not-touching' }],
    };
    const outcome = decide(def, state, { kind: 'transition', target: 'review' });
    if (outcome.kind !== 'admit') throw new Error(`the edge delegate->review gave '${outcome.kind}'`);
    const emitted = phaseMoveEvents(def, state, outcome.move, floor, tierGate);
    const legacy = executeTransition(getHSMDefinition('feature'), state, 'review', tierGate, floor);
    const expectedGates = [
      { family: 'review', gate: 'frozen-first' },
      { family: 'review', gate: 'frozen-second' },
      { family: 'review', gate: 'tier-low' },
      { family: 'review', gate: 'tier-high' },
    ];
    const expectedEntered = {
      type: 'phase.entered',
      from: 'delegate',
      to: 'review',
      trigger: 'execute-transition',
      metadata: {
        phase: 'review',
        kind: 'REVIEW',
        resolver: 'review-contract',
        resolvedGates: expectedGates,
        riskTier: 'high',
        boundaryTouching: false,
        posture: 'read-only',
        policySource: 'builtin',
        mode: 'enforce',
      },
    };
    for (const result of [emitted, legacy]) {
      expect(result.resolvedGates).toEqual(expectedGates);
      expect(result.events.find((event) => event.type === 'phase.entered')).toEqual(expectedEntered);
    }
  });
});
