/**
 * Unit tests for the pure half of the packaged action and CLI proof. They pin these facts:
 *
 * - The denominators come from the live registries. A seeded action grows the `actions`
 *   denominator, and that denominator equals the action set of `compile().proofFixtures`.
 * - The ratchet fails on a seeded unexercised action and on a de-exercised item. It accepts a
 *   removal.
 * - Each error family maps to a stable exit code.
 * - The checked-in baseline tracks the live denominators.
 *
 * `tests/core/process/packaged-proof.test.ts` proves the numerator against the shipped binary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TOOL_REGISTRY, type CompositeTool, type ToolAction } from '../../../../../src/registry.js';
import { deriveMetaModel } from '../../../../../src/contract/compiler/meta-model.js';
import { compile } from '../../../../../src/contract/compiler/compile.js';
import {
  CONTRACT_EXIT_CODES,
  FAILURE_LAYERS,
  STABLE_ERROR_REGISTRY,
  stableErrorCodes,
  failureFamily,
} from '../../../../../src/contract/error-families.js';
import {
  COVERAGE_DIMENSIONS,
  derivePackagedDenominators,
  derivePackagedCliPlan,
  computeCoverage,
  coverageFor,
  checkRatchet,
  reportToBaseline,
  parseCoverageBaseline,
  classifyErrorLayer,
  expectedExitForCode,
  aliasId,
  type CoverageDimension,
  type DimensionSets,
  type CoverageBaseline,
} from './packaged-proof.js';

/** Clone the live registry, appending one extra (differently-named) action to
 *  `toolName`. Structural — it reuses the source action's schemas, so
 *  `deriveMetaModel` derives a valid extra entry that grows the denominator. */
function withSeededAction(
  toolName: string,
  newActionName: string,
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly CompositeTool[] {
  return registry.map((tool) => {
    if (tool.name !== toolName) return tool;
    const template = tool.actions[0];
    if (template === undefined) throw new Error(`test setup: ${toolName} has no actions to clone`);
    const seeded: ToolAction = { ...template, name: newActionName };
    return { ...tool, actions: [...tool.actions, seeded] };
  });
}

/** Build a full-coverage exercise ledger from a set of denominators. */
function fullLedger(denominators: DimensionSets): DimensionSets {
  const out = {} as Record<CoverageDimension, readonly string[]>;
  for (const dim of COVERAGE_DIMENSIONS) out[dim] = [...denominators[dim]];
  return out;
}

/** Build an exercise ledger from denominators, dropping the named items. */
function ledgerWithout(
  denominators: DimensionSets,
  drop: Partial<Record<CoverageDimension, readonly string[]>>,
): DimensionSets {
  const out = {} as Record<CoverageDimension, readonly string[]>;
  for (const dim of COVERAGE_DIMENSIONS) {
    const dropped = new Set(drop[dim] ?? []);
    out[dim] = denominators[dim].filter((x) => !dropped.has(x));
  }
  return out;
}

const EMPTY_LEDGER: DimensionSets = {
  actions: [],
  presentationAliases: [],
  hostCommands: [],
  errorFamilies: [],
  effectFamilies: [],
  cancellationPaths: [],
};

describe('packaged-proof denominators are derived from the live registry', () => {
  /**
   * The `actions` denominator is every registered action. The error families are the failure
   * layers, and the effect families are the three effect-ledger classes. Each dimension is
   * non-empty, because an empty dimension reads as full coverage and hides a gap.
   */
  it('Denominators_MatchLiveRegistryCounts', () => {
    const d = derivePackagedDenominators();
    const meta = deriveMetaModel();

    expect(d.actions).toEqual([...meta.actions.map((a) => a.actionId)].sort());

    expect([...d.errorFamilies].sort()).toEqual([...FAILURE_LAYERS].sort());

    expect(d.effectFamilies).toEqual(['filesystem', 'network', 'process']);

    for (const dim of COVERAGE_DIMENSIONS) {
      expect(d[dim].length, `dimension ${dim} must be non-empty`).toBeGreaterThan(0);
    }
  });

  /**
   * The compiled contract is the authority. The `actions` denominator equals its proof-fixture
   * action set, not only the meta-model.
   */
  it('Denominators_ActionsEqualCompiledContractProofFixtures', () => {
    const outcome = compile(deriveMetaModel());
    expect(outcome.ok, 'compile() must succeed to cross-check the denominator').toBe(true);
    if (!outcome.ok) return;
    const fixtureActionIds = [...outcome.output.proofFixtures.actions.map((a) => a.actionId)].sort();
    expect(derivePackagedDenominators().actions).toEqual(fixtureActionIds);
  });

  /**
   * A hand-kept static list does not grow. So the last assertion proves that the denominator comes
   * from the registry.
   */
  it('Denominators_GrowWhenARegisteredActionIsAdded', () => {
    const base = derivePackagedDenominators();
    const seeded = derivePackagedDenominators(
      withSeededAction('exarchos_event', 'proof_seeded_probe'),
    );
    expect(seeded.actions.length).toBe(base.actions.length + 1);
    expect(seeded.actions).toContain('exarchos_event.proof_seeded_probe');
    expect(base.actions).not.toContain('exarchos_event.proof_seeded_probe');
  });

  /**
   * `get` is the `status` alias on tool `wf`, `pipeline` is `ls`, and `ps` is a top-level verb. An
   * action without an alias keeps its own name as the subcommand.
   */
  it('CliPlan_ResolvesAliasAndTopLevelSubcommandNames', () => {
    const plan = derivePackagedCliPlan();
    const byId = new Map(plan.map((p) => [p.actionId, p]));

    expect(byId.get('exarchos_workflow.get')?.actionCliName).toBe('status');
    expect(byId.get('exarchos_workflow.get')?.toolCliName).toBe('wf');
    expect(byId.get('exarchos_view.pipeline')?.actionCliName).toBe('ls');
    expect(byId.get('exarchos_view.ps')?.topLevel).toBe('ps');
    expect(byId.get('exarchos_orchestrate.doctor')?.actionCliName).toBe('doctor');
  });
});

describe('computeCoverage', () => {
  it('Coverage_FullLedgerYields100Percent', () => {
    const d = derivePackagedDenominators();
    const report = computeCoverage(d, fullLedger(d));
    for (const dim of COVERAGE_DIMENSIONS) {
      const c = coverageFor(report, dim);
      expect(c.covered).toBe(c.total);
      expect(c.ratio).toBe(1);
      expect(c.missing).toEqual([]);
    }
  });

  it('Coverage_EmptyLedgerYieldsZeroAndListsEveryItemMissing', () => {
    const d = derivePackagedDenominators();
    const report = computeCoverage(d, EMPTY_LEDGER);
    const actions = coverageFor(report, 'actions');
    expect(actions.covered).toBe(0);
    expect(actions.ratio).toBe(0);
    expect([...actions.missing].sort()).toEqual([...d.actions].sort());
  });

  /** A ledger entry outside the denominator does not raise coverage past the denominator. */
  it('Coverage_IgnoresLedgerItemsOutsideTheDenominator', () => {
    const d = derivePackagedDenominators();
    const ledger: DimensionSets = { ...fullLedger(d), actions: [...d.actions, 'ghost.action'] };
    const actions = coverageFor(computeCoverage(d, ledger), 'actions');
    expect(actions.covered).toBe(actions.total);
    expect(actions.covered).toBe(d.actions.length);
  });

  it('Coverage_PartialLedgerReportsExactMissingSet', () => {
    const d = derivePackagedDenominators();
    const dropped = [d.actions[0]!, d.actions[3]!];
    const report = computeCoverage(d, ledgerWithout(d, { actions: dropped }));
    const actions = coverageFor(report, 'actions');
    expect(actions.covered).toBe(d.actions.length - 2);
    expect([...actions.missing].sort()).toEqual([...dropped].sort());
  });
});

describe('checkRatchet', () => {
  it('Ratchet_PassesWhenCoverageMatchesBaseline', () => {
    const d = derivePackagedDenominators();
    const report = computeCoverage(d, fullLedger(d));
    const baseline = reportToBaseline(report);
    const result = checkRatchet(report, baseline);
    expect(result.ok).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  /**
   * The baseline covers the live registry. Then a new action is registered, but the ledger covers
   * only the old set. So the ratchet reports a new gap.
   */
  it('Ratchet_FailsOnASeededUnexercisedRegisteredAction', () => {
    const baselineDen = derivePackagedDenominators();
    const baseline = reportToBaseline(computeCoverage(baselineDen, fullLedger(baselineDen)));

    const grownDen = derivePackagedDenominators(
      withSeededAction('exarchos_event', 'proof_seeded_probe'),
    );
    const ledgerMissingSeed = fullLedger(baselineDen);
    const report = computeCoverage(grownDen, ledgerMissingSeed);

    const actions = coverageFor(report, 'actions');
    expect(actions.total).toBe(baselineDen.actions.length + 1);
    expect(actions.missing).toContain('exarchos_event.proof_seeded_probe');

    const result = checkRatchet(report, baseline);
    expect(result.ok).toBe(false);
    const newGap = result.regressions.find(
      (r) => r.dimension === 'actions' && r.kind === 'new-gap',
    );
    expect(newGap, 'a new registered+unexercised action must trip a new-gap regression').toBeDefined();
    expect(newGap!.detail).toContain('exarchos_event.proof_seeded_probe');
  });

  it('Ratchet_FailsWhenAPreviouslyCoveredItemIsNoLongerExercised', () => {
    const d = derivePackagedDenominators();
    const baseline = reportToBaseline(computeCoverage(d, fullLedger(d)));
    const report = computeCoverage(d, ledgerWithout(d, { hostCommands: ['wf'] }));
    const result = checkRatchet(report, baseline);
    expect(result.ok).toBe(false);
    expect(
      result.regressions.some((r) => r.dimension === 'hostCommands' && r.kind === 'new-gap'),
    ).toBe(true);
  });

  /**
   * The baseline accepts `network` as an effect-family gap, because the compiled proof cannot make
   * a hermetic network call. A run with the same accepted gap stays green.
   */
  it('Ratchet_ToleratesAcceptedGapsRecordedInTheBaseline', () => {
    const d = derivePackagedDenominators();
    const ledger = ledgerWithout(d, { effectFamilies: ['network'] });
    const report = computeCoverage(d, ledger);
    const baseline = reportToBaseline(report);
    expect(checkRatchet(report, baseline).ok).toBe(true);
  });

  /**
   * An action removed from the registry shrinks the denominator. The covered count drops, but a
   * deletion is not a regression.
   */
  it('Ratchet_ToleratesRemovingARegisteredItem', () => {
    const full = derivePackagedDenominators();
    const baseline = reportToBaseline(computeCoverage(full, fullLedger(full)));

    const shrunkRegistry = TOOL_REGISTRY.map((t) =>
      t.name === 'exarchos_event' ? { ...t, actions: t.actions.slice(1) } : t,
    );
    const shrunkDen = derivePackagedDenominators(shrunkRegistry);
    const report = computeCoverage(shrunkDen, fullLedger(shrunkDen));
    const result = checkRatchet(report, baseline);
    expect(result.ok, JSON.stringify(result.regressions)).toBe(true);
  });
});

describe('error family exit-code mapping', () => {
  it('EveryStableCode_MapsToItsRegisteredExitCode', () => {
    for (const code of stableErrorCodes()) {
      const spec = STABLE_ERROR_REGISTRY[code];
      expect(expectedExitForCode(code)).toBe(spec.exitCode);
      expect(classifyErrorLayer(code)).toBe(spec.layer);
    }
  });

  it('EveryFailureLayer_HasADefaultCodeAndExit', () => {
    for (const layer of FAILURE_LAYERS) {
      const family = failureFamily(layer);
      expect(expectedExitForCode(family.code)).toBe(family.exitCode);
    }
  });

  it('UnregisteredCode_FallsBackToHandlerLayerAndHandlerExit', () => {
    expect(classifyErrorLayer('NOT_A_REGISTERED_CODE')).toBe('handler');
    expect(expectedExitForCode('NOT_A_REGISTERED_CODE')).toBe(CONTRACT_EXIT_CODES.HANDLER_ERROR);
  });

  it('UndefinedCode_IsSuccessExit', () => {
    expect(expectedExitForCode(undefined)).toBe(CONTRACT_EXIT_CODES.SUCCESS);
  });

  it('BoundedWaitCodes_CarryTheirSpecialisedExitCodes', () => {
    expect(expectedExitForCode('WAIT_TIMEOUT')).toBe(CONTRACT_EXIT_CODES.WAIT_TIMEOUT);
    expect(expectedExitForCode('WAIT_FAILED')).toBe(CONTRACT_EXIT_CODES.WAIT_FAILED);
  });
});

describe('parseCoverageBaseline', () => {
  it('Parse_RoundTripsAReportBaseline', () => {
    const d = derivePackagedDenominators();
    const baseline = reportToBaseline(computeCoverage(d, fullLedger(d)), 'test note');
    const roundTripped = parseCoverageBaseline(JSON.parse(JSON.stringify(baseline)));
    expect(roundTripped).toEqual(baseline);
  });

  it('Parse_ThrowsOnAMissingDimension', () => {
    const d = derivePackagedDenominators();
    const good = reportToBaseline(computeCoverage(d, fullLedger(d)));
    const broken = JSON.parse(JSON.stringify(good)) as { dimensions: Record<string, unknown> };
    delete broken.dimensions.cancellationPaths;
    expect(() => parseCoverageBaseline(broken)).toThrow(/cancellationPaths/);
  });

  it('Parse_ThrowsOnAMalformedDimension', () => {
    const d = derivePackagedDenominators();
    const good = reportToBaseline(computeCoverage(d, fullLedger(d)));
    const broken = JSON.parse(JSON.stringify(good)) as { dimensions: Record<string, unknown> };
    broken.dimensions.actions = { total: 'nope', covered: 1, missing: [] };
    expect(() => parseCoverageBaseline(broken)).toThrow(/actions/);
  });

  it('Parse_ThrowsWhenDimensionsAreAbsent', () => {
    expect(() => parseCoverageBaseline({})).toThrow(/dimensions/);
    expect(() => parseCoverageBaseline(null)).toThrow(/JSON object/);
  });
});

/**
 * A fast ratchet that needs no binary. If an action, alias or host command is added and the
 * baseline is not regenerated, a baseline `total` differs from the live surface. Then this suite
 * fails.
 */
describe('checked-in packaged-proof baseline', () => {
  const baseline: CoverageBaseline = parseCoverageBaseline(
    JSON.parse(
      readFileSync(fileURLToPath(new URL('./packaged-proof.baseline.json', import.meta.url)), 'utf8'),
    ),
  );
  const den = derivePackagedDenominators();

  it('Baseline_TotalsEqualTheLiveDenominators', () => {
    for (const dim of COVERAGE_DIMENSIONS) {
      expect(baseline.dimensions[dim].total, `baseline ${dim}.total`).toBe(den[dim].length);
    }
  });

  it('Baseline_AcceptedGapsAreRealDenominatorItems', () => {
    for (const dim of COVERAGE_DIMENSIONS) {
      const denomSet = new Set(den[dim]);
      for (const gap of baseline.dimensions[dim].missing) {
        expect(denomSet.has(gap), `baseline ${dim} accepted-gap '${gap}' must be a live denominator item`).toBe(true);
      }
    }
  });

  it('Baseline_CoveredEqualsTotalMinusAcceptedGaps', () => {
    for (const dim of COVERAGE_DIMENSIONS) {
      const b = baseline.dimensions[dim];
      expect(b.covered, `baseline ${dim}.covered`).toBe(b.total - b.missing.length);
    }
  });

  /** It guards the alias-id contract that the compiled-process ledger keys on. */
  it('Baseline_PresentationAliasesUseTheCanonicalAliasId', () => {
    expect(den.presentationAliases).toContain(aliasId('exarchos_workflow.get', 'status'));
    expect(den.presentationAliases).toContain(aliasId('exarchos_view.pipeline', 'ls'));
  });
});
