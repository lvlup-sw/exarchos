/**
 * These tests run each fixture of the transition-admission corpus on the ledger fold and on the state document.
 * The encoder gives the rows of the fold side and the document side of each fixture.
 * Both sides get the underscore fields of the fixture.
 * Each case asserts that the comparator gives a comparison before it reads the agreement, because a document side with no type gives none.
 * The kill cases show that the agreement can fail: a pass fixture with no completion rows, and a merge at `delegate` without the writer rule.
 *
 * @oracle-sources: ../../workflow/__fixtures__/transition-admission-corpus.ts, ../../../../src/projections/guard-input/fold.ts
 */
import { describe, expect, it } from 'vitest';

import {
  compareGuardInputs,
  type GuardInputComparison,
} from '../../../../src/projections/guard-input/compare.js';
import {
  documentGuardInput,
  foldGuardInput,
  type GuardInput,
} from '../../../../src/projections/guard-input/fold.js';
import { executeTransition, getHSMDefinition } from '../../../../src/workflow/state-machine.js';
import {
  encodeCorpusFixture,
  type CorpusEncodeOptions,
  type CorpusFixtureShape,
  type EncodedCorpusFixture,
} from '../../../helpers/guard-input/corpus-rows.js';
import {
  configBearingCorpus,
  legacyTransitionCorpus,
  transitionAdmissionCorpus,
  type LegacyTransitionFixture,
} from '../../workflow/__fixtures__/transition-admission-corpus.js';

/** The two guard inputs of one encoded fixture. */
interface FixtureSides {
  readonly document: GuardInput;
  readonly fold: GuardInput;
}

/** The id of the pass fixture of the feature edge `delegate -> review`. */
const DELEGATE_TO_REVIEW_PASS = 'feature-delegate-to-review-pass';

/**
 * A synthetic feature fixture at `delegate`. A task completes with a worktree, and then a merge runs.
 * The merge handler writes the merge orchestrator phase to the document, and only the writer rule of the encoder models that write.
 */
const MERGE_AT_DELEGATE: CorpusFixtureShape = {
  id: 'feature-delegate-merge-executed',
  workflowType: 'feature',
  from: 'delegate',
  state: {
    _events: [
      { type: 'task.completed', data: { taskId: 'merge-task', worktree: '.worktrees/merge-task' } },
      { type: 'merge.executed', data: { taskId: 'merge-task' } },
    ],
  },
};

/** The id and the fixture of each corpus case, for the tables of the cases. */
const CORPUS_CASES: readonly [string, LegacyTransitionFixture][] = transitionAdmissionCorpus.map((fixture) => [fixture.id, fixture]);

/** Returns the two guard inputs of an encoded fixture. Both sides get the underscore fields of the fixture. */
function sidesOf(encoded: EncodedCorpusFixture): FixtureSides {
  const options = { ephemerals: encoded.ephemerals };
  return {
    document: documentGuardInput(encoded.document, encoded.rows, options),
    fold: foldGuardInput(encoded.rows, options),
  };
}

/** Encodes a fixture and returns its two guard inputs. */
function encodedSides(fixture: CorpusFixtureShape, options?: CorpusEncodeOptions): FixtureSides {
  return sidesOf(encodeCorpusFixture(fixture, options));
}

/** Returns the comparison of the two sides, and fails the case when the comparator gives none. */
function comparisonOf(sides: FixtureSides): GuardInputComparison {
  const comparison = compareGuardInputs(sides.document, sides.fold);
  expect(comparison, 'the comparator gave no comparison, so the document side holds no built-in type').toBeDefined();
  if (comparison === undefined) throw new Error('the comparator gave no comparison');
  return comparison;
}

/** Returns the verdict that `executeTransition` gives one side for the edge of the fixture. */
function verdictOn(fixture: LegacyTransitionFixture, input: GuardInput): 'allow' | 'deny' {
  const result = executeTransition(getHSMDefinition(fixture.workflowType), { ...input }, fixture.to);
  return result.success ? 'allow' : 'deny';
}

/** Returns the corpus fixture with an id, and fails the case when the corpus holds none. */
function corpusFixture(id: string): LegacyTransitionFixture {
  const fixture = transitionAdmissionCorpus.find((candidate) => candidate.id === id);
  if (fixture === undefined) throw new Error(`the corpus holds no fixture '${id}'`);
  return fixture;
}

/** Returns the verdicts of one guard on both sides, and fails the case when the comparison lists no such guard. */
function verdictsOf(comparison: GuardInputComparison, guardId: string): { readonly document: string; readonly fold: string } {
  const entry = comparison.guards.find((verdict) => verdict.guardId === guardId);
  if (entry === undefined) throw new Error(`the comparison lists no verdict of '${guardId}'`);
  return { document: entry.document, fold: entry.fold };
}

describe('the corpus agreement of the ledger fold and the state document', () => {
  /** Each fixture gets a comparison, and the two sides agree on the phase, the facts, the config keys, the task keys and each verdict. */
  it.each(CORPUS_CASES)(
    'CorpusAgreement_%s_AgreesOnThePhaseTheFactsAndEachVerdict',
    (_id, fixture) => {
      const comparison = comparisonOf(encodedSides(fixture));

      expect(comparison.workflowType).toBe(fixture.workflowType);
      expect(comparison.phase).toEqual({ document: fixture.from, fold: fixture.from });
      expect(comparison.guards.length).toBeGreaterThan(0);
      expect(comparison.differences).toEqual([]);
      expect(comparison.classes).toEqual([]);
      expect(comparison.agrees).toBe(true);
    },
  );

  /** The corpus holds 131 fixtures: 51 edges with a pass and a fail fixture, 6 bypass fixtures and 23 config fixtures. */
  it('CorpusAgreement_TheCases_Are131In102_6_23', () => {
    const edgeFixtures = legacyTransitionCorpus.filter(
      (fixture) => fixture.scenario === 'representative-pass' || fixture.scenario === 'representative-fail',
    );
    const bypassFixtures = legacyTransitionCorpus.filter((fixture) => fixture.scenario === 'bypass');

    expect(edgeFixtures).toHaveLength(102);
    expect(bypassFixtures).toHaveLength(6);
    expect(configBearingCorpus).toHaveLength(23);
    expect(transitionAdmissionCorpus).toHaveLength(edgeFixtures.length + bypassFixtures.length + configBearingCorpus.length);
    expect(transitionAdmissionCorpus).toHaveLength(131);
  });

  /** On each side, `executeTransition` gives the verdict that the corpus records for the fixture. */
  it.each(CORPUS_CASES)(
    'CorpusAgreement_%s_EachSideGivesTheRecordedVerdict',
    (_id, fixture) => {
      const sides = encodedSides(fixture);

      expect(verdictOn(fixture, sides.document)).toBe(fixture.expected.verdict);
      expect(verdictOn(fixture, sides.fold)).toBe(fixture.expected.verdict);
    },
  );

  /** Without its completion rows, the fold gives the task `pending`, while the document keeps it `complete`. */
  it('CorpusAgreement_APassFixtureWithNoCompletionRows_DisagreesOnTaskStatus', () => {
    const encoded = encodeCorpusFixture(corpusFixture(DELEGATE_TO_REVIEW_PASS));
    const rows = encoded.rows.filter((row) => row.type !== 'task.completed');
    expect(rows).toHaveLength(encoded.rows.length - 1);

    const comparison = comparisonOf(sidesOf({ ...encoded, rows }));

    expect(comparison.classes).toEqual(['task-status']);
    expect(comparison.agrees).toBe(false);
    expect(comparison.differences).toEqual([
      { key: 'tasks.allComplete', document: true, fold: false },
      { key: 'tasks[001].complete', document: true, fold: false },
    ]);
    expect(verdictsOf(comparison, 'all-tasks-complete+team-disbanded')).toEqual({ document: 'pass', fold: 'fail' });
  });

  /** Without the writer rule, only the fold holds the terminal merge phase, so `merge-pending-entry` passes on the document only. */
  it('CorpusAgreement_AMergeAtDelegateWithoutTheWriterRule_DisagreesOnMergeOrchestrator', () => {
    const comparison = comparisonOf(encodedSides(MERGE_AT_DELEGATE, { mergeWriterRule: false }));

    expect(comparison.classes).toEqual(['merge-orchestrator']);
    expect(comparison.agrees).toBe(false);
    expect(comparison.differences).toEqual([]);
    expect(verdictsOf(comparison, 'merge-pending-entry')).toEqual({ document: 'pass', fold: 'fail' });
  });

  /** With the writer rule, both sides hold the terminal merge phase, and `merge-pending-entry` fails on both. */
  it('CorpusAgreement_AMergeAtDelegateWithTheWriterRule_Agrees', () => {
    const comparison = comparisonOf(encodedSides(MERGE_AT_DELEGATE));

    expect(comparison.classes).toEqual([]);
    expect(comparison.agrees).toBe(true);
    expect(verdictsOf(comparison, 'merge-pending-entry')).toEqual({ document: 'fail', fold: 'fail' });
  });
});
