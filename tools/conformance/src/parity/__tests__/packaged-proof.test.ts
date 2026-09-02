// ─── Packaged-proof coverage engine + ratchet — unit tests (P05-02) ──────────
//
// The PURE half of the packaged action/CLI proof. These tests pin:
//   • denominators are derived from the LIVE registries (exit-proof a) — a
//     seeded/extra registered action grows the denominator, it is not a static
//     list; and the `actions` denominator equals the compiled contract's action
//     set (`compile().proofFixtures`).
//   • the ratchet FAILS on a seeded, unexercised registered action (exit-proof
//     b) and on de-exercising an existing item, but tolerates removals.
//   • the error-family → stable-exit-code mapping the compiled-process proof
//     asserts against (exit-proof c, contract half).
//   • the checked-in baseline tracks the live denominators (a new action forces
//     a baseline update — a fast, binary-free ratchet signal).
//
// The compiled-process numerator (does the SHIPPED BINARY actually exercise
// each item) is proven separately in `test/process/packaged-proof.test.ts`.
// ────────────────────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Denominators are LIVE, not a static list (exit-proof a) ─────────────────

describe('packaged-proof denominators are derived from the live registry', () => {
  it('Denominators_MatchLiveRegistryCounts', () => {
    const d = derivePackagedDenominators();
    const meta = deriveMetaModel();

    // actions denominator == every registered action (no omission possible).
    expect(d.actions).toEqual([...meta.actions.map((a) => a.actionId)].sort());

    // error families are exactly the six P03-02 failure layers.
    expect([...d.errorFamilies].sort()).toEqual([...FAILURE_LAYERS].sort());

    // effect families are the three effect-ledger classes (P04-01).
    expect(d.effectFamilies).toEqual(['filesystem', 'network', 'process']);

    // every dimension is non-empty (a dimension collapsing to zero would make
    // its coverage trivially "100%" and hide a real gap).
    for (const dim of COVERAGE_DIMENSIONS) {
      expect(d[dim].length, `dimension ${dim} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('Denominators_ActionsEqualCompiledContractProofFixtures', () => {
    // Ties the `actions` denominator to the COMPILED CONTRACT (not just the
    // meta-model): the compiler's proof-fixture action set is the authority.
    const outcome = compile(deriveMetaModel());
    expect(outcome.ok, 'compile() must succeed to cross-check the denominator').toBe(true);
    if (!outcome.ok) return;
    const fixtureActionIds = [...outcome.output.proofFixtures.actions.map((a) => a.actionId)].sort();
    expect(derivePackagedDenominators().actions).toEqual(fixtureActionIds);
  });

  it('Denominators_GrowWhenARegisteredActionIsAdded', () => {
    const base = derivePackagedDenominators();
    const seeded = derivePackagedDenominators(
      withSeededAction('exarchos_event', 'proof_seeded_probe'),
    );
    expect(seeded.actions.length).toBe(base.actions.length + 1);
    expect(seeded.actions).toContain('exarchos_event.proof_seeded_probe');
    // A hand-maintained static list would NOT have grown — this is the
    // discriminating assertion that the denominator is registry-derived.
    expect(base.actions).not.toContain('exarchos_event.proof_seeded_probe');
  });

  it('CliPlan_ResolvesAliasAndTopLevelSubcommandNames', () => {
    const plan = derivePackagedCliPlan();
    const byId = new Map(plan.map((p) => [p.actionId, p]));

    // `get` is exposed on the CLI under its alias `status` on tool `wf`.
    expect(byId.get('exarchos_workflow.get')?.actionCliName).toBe('status');
    expect(byId.get('exarchos_workflow.get')?.toolCliName).toBe('wf');
    // `pipeline` under alias `ls`; `ps` promoted to a top-level verb.
    expect(byId.get('exarchos_view.pipeline')?.actionCliName).toBe('ls');
    expect(byId.get('exarchos_view.ps')?.topLevel).toBe('ps');
    // an alias-less action keeps its own name as the subcommand.
    expect(byId.get('exarchos_orchestrate.doctor')?.actionCliName).toBe('doctor');
  });
});

// ─── Coverage computation ────────────────────────────────────────────────────

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

  it('Coverage_IgnoresLedgerItemsOutsideTheDenominator', () => {
    const d = derivePackagedDenominators();
    // A stale/bogus ledger entry must not inflate coverage past the denominator.
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

// ─── The ratchet (exit-proof b) ──────────────────────────────────────────────

describe('checkRatchet', () => {
  it('Ratchet_PassesWhenCoverageMatchesBaseline', () => {
    const d = derivePackagedDenominators();
    const report = computeCoverage(d, fullLedger(d));
    const baseline = reportToBaseline(report);
    const result = checkRatchet(report, baseline);
    expect(result.ok).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('Ratchet_FailsOnASeededUnexercisedRegisteredAction', () => {
    // Baseline: everything covered against the live registry.
    const baselineDen = derivePackagedDenominators();
    const baseline = reportToBaseline(computeCoverage(baselineDen, fullLedger(baselineDen)));

    // Now a new action is REGISTERED but the exercise ledger does NOT cover it.
    const grownDen = derivePackagedDenominators(
      withSeededAction('exarchos_event', 'proof_seeded_probe'),
    );
    const ledgerMissingSeed = fullLedger(baselineDen); // covers only the OLD set
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

  it('Ratchet_ToleratesAcceptedGapsRecordedInTheBaseline', () => {
    // Baseline accepts `network` as an effect-family gap (the compiled proof
    // cannot hermetically make a network call).
    const d = derivePackagedDenominators();
    const ledger = ledgerWithout(d, { effectFamilies: ['network'] });
    const report = computeCoverage(d, ledger);
    const baseline = reportToBaseline(report);
    // Re-running with the SAME accepted gap must stay green.
    expect(checkRatchet(report, baseline).ok).toBe(true);
  });

  it('Ratchet_ToleratesRemovingARegisteredItem', () => {
    // Baseline covers the full live set…
    const full = derivePackagedDenominators();
    const baseline = reportToBaseline(computeCoverage(full, fullLedger(full)));

    // …then an action is REMOVED from the registry (denominator shrinks). The
    // covered count drops by one, but that is a deletion, not a regression.
    const shrunkRegistry = TOOL_REGISTRY.map((t) =>
      t.name === 'exarchos_event' ? { ...t, actions: t.actions.slice(1) } : t,
    );
    const shrunkDen = derivePackagedDenominators(shrunkRegistry);
    const report = computeCoverage(shrunkDen, fullLedger(shrunkDen));
    const result = checkRatchet(report, baseline);
    expect(result.ok, JSON.stringify(result.regressions)).toBe(true);
  });
});

// ─── Error-family → stable-exit-code mapping (exit-proof c, contract half) ───

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

// ─── Baseline parsing (fail-closed) ──────────────────────────────────────────

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

// ─── The checked-in baseline tracks the live denominators ────────────────────
//
// A fast, binary-free ratchet signal: if a registered action (alias / host
// command / …) is added but the baseline is not regenerated, the baseline's
// denominator `total` no longer matches the live surface and this test fails —
// forcing the author to regenerate the baseline (which the compiled-process
// test then holds to a real numerator).

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

  it('Baseline_PresentationAliasesUseTheCanonicalAliasId', () => {
    // Guards the alias-id contract the compiled-process ledger keys against.
    expect(den.presentationAliases).toContain(aliasId('exarchos_workflow.get', 'status'));
    expect(den.presentationAliases).toContain(aliasId('exarchos_view.pipeline', 'ls'));
  });
});
