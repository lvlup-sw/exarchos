/**
 * These tests check that the guard-input shadow compares decide verdicts, now that the ledger fold decides each call.
 * The comparator gives the decide verdict of each edge out of the document phase, keyed by transition id.
 * The warning says that the fold decided, and the diagnostics line holds the list `edges`.
 * Each assertion binds one side to a literal: a verdict, the warning text or the empty list of legacy imports.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { compareGuardInputs, type GuardInputComparison } from '../../../../src/projections/guard-input/compare.js';
import { recordGuardInputShadow, type GuardInputShadowRun } from '../../../../src/projections/guard-input/shadow.js';
import { GUARD_INPUT_DIAGNOSTICS_DIRNAME } from '../../../../src/utils/paths.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The root of the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The comparator module that the import case reads. */
const COMPARE_MODULE = resolve(REPO_ROOT, 'src/projections/guard-input/compare.ts');

/** The legacy guard modules that the comparator must not import. */
const LEGACY_MODULES: readonly string[] = [
  'src/workflow/guards.ts',
  'src/workflow/phase-skip.ts',
  'src/workflow/state-machine.ts',
  'src/workflow/hsm-definitions.ts',
  'src/workflow/hsm-transition-guard.ts',
];

/** The feature id of the runs of this file. */
const FEATURE_ID = 'decide-verdicts';

/** Each temporary directory of the current case. The teardown removes each one. */
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rmrfAsync(dir);
});

/** Returns a guard input of `workflowType` at `phase` with no task and no event. The fields replace the defaults. */
function inputAt(workflowType: string, phase: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { featureId: FEATURE_ID, workflowType, phase, tasks: [], _events: [], ...fields };
}

/** Returns the comparison of the two inputs, and fails the case when the comparator gives none. */
function compared(document: Record<string, unknown>, fold: Record<string, unknown>): GuardInputComparison {
  const comparison = compareGuardInputs(document, fold);
  if (comparison === undefined) throw new Error('the comparator gave no comparison');
  return comparison;
}

/** Returns the run of a transition from `plan` to `plan-review` whose document alone holds the plan artifact. */
function disagreeingRun(): GuardInputShadowRun {
  const comparison = compared(inputAt('feature', 'plan', { artifacts: { plan: 'plans/plan.md' } }), inputAt('feature', 'plan'));
  return {
    kind: 'compared',
    call: 'transition',
    featureId: FEATURE_ID,
    workflowType: 'feature',
    from: 'plan',
    to: 'plan-review',
    pass: 0,
    ledgerSequence: 2,
    documentSequence: 2,
    documentVersion: 2,
    foldMs: 0,
    comparison,
  };
}

/** Returns the repository path of each relative import of a source file. */
function relativeImportsOf(file: string): readonly string[] {
  const source = readFileSync(file, 'utf8');
  const targets: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const absolute = resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
    targets.push(relative(REPO_ROOT, absolute).split('\\').join('/'));
  }
  return targets;
}

describe('the shadow compares decide verdicts', () => {
  /**
   * Two of the six legacy defects. The legacy guard admits `delegate -> review` with an empty task list, and it admits
   * `investigate -> cancelled` with no escalation. The decide denies both on each side, so the verdicts are the decide verdicts.
   */
  it('CompareGuardInputs_ComparesDecideVerdicts', () => {
    const emptyTasks = compared(inputAt('feature', 'delegate'), inputAt('feature', 'delegate'));
    const noEscalation = compared(inputAt('debug', 'investigate'), inputAt('debug', 'investigate'));

    expect(emptyTasks.edges).toEqual([
      { transitionId: 'delegate->review', to: 'review', document: 'deny', fold: 'deny' },
      { transitionId: 'delegate->merge-pending', to: 'merge-pending', document: 'deny', fold: 'deny' },
      { transitionId: 'cleanup', to: 'completed', document: 'deny', fold: 'deny' },
    ]);
    expect(noEscalation.edges).toContainEqual({
      transitionId: 'investigate->cancelled',
      to: 'cancelled',
      document: 'deny',
      fold: 'deny',
    });
    expect(emptyTasks.agrees).toBe(true);
    expect(noEscalation.agrees).toBe(true);
  });

  /** The comparator imports no legacy guard module. The case also requires the decide import, so an empty scan cannot pass. */
  it('CompareGuardInputs_ImportsNoLegacyGuardModule', () => {
    const imports = relativeImportsOf(COMPARE_MODULE);

    expect(imports).toContain('src/workflow/decide/decide.ts');
    expect(imports.filter((target) => LEGACY_MODULES.includes(target))).toEqual([]);
  });

  /** A disagreement warning says that the ledger fold decided and that the state document disagrees. A run with no line names no file. */
  it('Shadow_TheWarning_SaysTheFoldDecided', async () => {
    const warnings = await recordGuardInputShadow(disagreeingRun(), { stateDir: '', writeLine: false });

    expect(warnings).toEqual([
      'GUARD_INPUT_DISAGREEMENT: the ledger fold decided, and the state document disagrees on 2 guard inputs ' +
        'at plan -> plan-review. Keys: artifacts.plan, artifacts.planNonEmpty.',
    ]);
  });

  /** The diagnostics line holds the decide verdict of each edge under `edges`, and it holds no list `guards`. */
  it('Shadow_TheDiagnosticsLine_HoldsTheEdgeVerdicts', async () => {
    const stateDir = makeTempDir('decide-verdicts-');
    tempDirs.push(stateDir);

    await recordGuardInputShadow(disagreeingRun(), { stateDir });

    const text = await readFile(resolve(stateDir, GUARD_INPUT_DIAGNOSTICS_DIRNAME, `${FEATURE_ID}.jsonl`), 'utf8');
    const line: unknown = JSON.parse(text.trim());
    expect(line).toMatchObject({
      edges: [
        { transitionId: 'plan->plan-review', to: 'plan-review', document: 'allow', fold: 'deny' },
        { transitionId: 'cleanup', to: 'completed', document: 'deny', fold: 'deny' },
      ],
    });
    expect(line).not.toHaveProperty('guards');
  });
});
