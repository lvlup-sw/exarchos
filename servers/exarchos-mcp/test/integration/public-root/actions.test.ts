// ─── T-36 / DR-27 — the T1 PUBLIC-ROOT integration tier ─────────────────────
//
// "Every composite action driven through `dispatch()` with a real event store
// and state dir; no mocked handler, no synthesized dispatch context."
//
// WHAT THIS FILE PROVES, AND HOW IT AVOIDS PROVING NOTHING
//
// A sweep that iterates a registry and asserts "nothing threw" is worthless —
// `dispatch()` returns a structured envelope for an unknown action too, so a
// non-throwing sweep would stay green even if routing were entirely broken.
// Three structural choices make the assertions load-bearing:
//
//  1. REACHABLE ≠ NON-THROWING. Every observation is classified by
//     `classifyRouting` (`_harness.ts`) into reached / not-reached. Not-reached
//     means dispatch answered with a ROUTING rejection — `UNKNOWN_TOOL`,
//     `UNKNOWN_ACTION`, `COMPOSITE_LOAD_FAILED`, or the built-in path's
//     `INVALID_INPUT: … unknown action "<name>"` — or it threw / timed out.
//     A typed error envelope from a resolved action (missing required field,
//     denied capability, handler failure) IS reached: the action exists and
//     answered in-contract.
//
//  2. A PER-ACTION CONTROL ARM. For every registered action the sweep also
//     dispatches `<name>__t36_unregistered` against the same tool. That call
//     MUST come back not-reached, and its rejection message must name the
//     mutated action. Without this arm, `classifyRouting` returning `reached`
//     unconditionally would still pass the sweep. With it, the classifier has
//     to discriminate, per action, on the exact name.
//
//  3. THE RATCHET IS TWO-SOURCED. The DENOMINATOR is
//     `derivePackagedDenominators().actions` — the *same* derivation the
//     compiled-binary sweep in `test/process/packaged-proof.test.ts` measures
//     itself against (DR-27: "the same 120-action denominator the packaged
//     sweep uses"). The NUMERATOR is `harness.reachedActionIds()`, a ledger
//     appended at RUNTIME inside the harness's `dispatch()` wrapper. Deleting
//     an action from this file's execution loop therefore drops the numerator
//     while the denominator is unchanged, and the ratchet goes red. If both
//     came off the same array the ratio would be 1 by construction and the
//     ratchet would be decorative.
//
// Hermeticity: a real SQLite state dir + a real NON-git scratch cwd, with
// HOME/USERPROFILE repointed at the scratch dir and GH_TOKEN/GITHUB_TOKEN
// blanked, exactly as the packaged sweep does — so git/gh-backed actions fail
// fast in-contract instead of touching the developer's repo or the network.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'node:os';

import {
  createPublicRootHarness,
  registeredActions,
  packagedActionDenominator,
  classifyRouting,
  assertNoStubbedCompositeHandlers,
  type PublicRootHarness,
  type DispatchObservation,
} from '../_harness.js';
import {
  derivePackagedDenominators,
  computeCoverage,
  coverageFor,
} from '../../../src/parity/__tests__/packaged-proof.js';
import { TOOL_REGISTRY, type CompositeTool, type ToolAction } from '../../../src/registry.js';

// ─── Ratchet floors ────────────────────────────────────────────────────────
//
// The measured action denominator on the tree this tier was built against.
// The ratchet is two-sided: coverage must have NO missing items (every
// registered action reached), AND the covered count must not fall below this
// floor — so "delete actions until the sweep passes" is not a way out. Raise
// it deliberately when the surface grows; lowering it is a reviewed decision.
const ACTION_COVERAGE_FLOOR = 120;

/**
 * Measured floor for actions whose outcome could only have come from the
 * composite handler (a success, or a failure outside the `protocol` /
 * `authorization` pre-handler layers) when driven with an empty payload.
 */
const HANDLER_ENTRY_FLOOR = 20;

/** Suffix appended to make a registered action name deliberately unroutable. */
const UNREGISTERED_SUFFIX = '__t36_unregistered';

interface SweepResult {
  readonly observations: readonly DispatchObservation[];
  readonly controls: readonly DispatchObservation[];
  readonly reached: readonly string[];
  readonly verifiedRealHandlers: readonly string[];
  readonly elapsedMs: number;
}

let harness: PublicRootHarness;
let SWEEP: SweepResult;

const savedEnv: Record<string, string | undefined> = {};
let savedCwd = '';

beforeAll(async () => {
  harness = await createPublicRootHarness();

  savedCwd = process.cwd();
  for (const key of ['HOME', 'USERPROFILE', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    savedEnv[key] = process.env[key];
  }
  // Repoint the ambient filesystem/network handles at the hermetic scratch dir
  // BEFORE any action runs, so nothing in the sweep can reach the developer's
  // home directory, repository, or a real GitHub remote.
  process.env.HOME = harness.workspaceDir;
  process.env.USERPROFILE = harness.workspaceDir;
  process.env.GH_TOKEN = '';
  process.env.GITHUB_TOKEN = '';
  process.chdir(harness.workspaceDir);

  const started = Date.now();
  const controls: DispatchObservation[] = [];

  // The execution loop. NOTE: it iterates `registeredActions()` — the live
  // registry — but nothing here is asserted against that array; coverage is
  // scored against the packaged sweep's denominator using the harness's
  // runtime ledger.
  for (const action of registeredActions()) {
    await harness.runAction(action.toolName, action.actionName, {}, { timeoutMs: 20_000 });
    controls.push(
      await harness.probe(
        action.toolName,
        { action: `${action.actionName}${UNREGISTERED_SUFFIX}` },
        { timeoutMs: 20_000 },
      ),
    );
  }

  const elapsedMs = Date.now() - started;

  SWEEP = {
    observations: harness.observations(),
    controls,
    reached: harness.reachedActionIds(),
    verifiedRealHandlers: await assertNoStubbedCompositeHandlers(),
    elapsedMs,
  };

  // eslint-disable-next-line no-console
  console.log(
    `[public-root T1] ${SWEEP.observations.length} actions driven through dispatch() in ` +
      `${SWEEP.elapsedMs}ms on ${os.platform()}; reached ${SWEEP.reached.length}; ` +
      `handler-entered ${SWEEP.observations.filter((o) => o.handlerEntered).length}; ` +
      `success ${SWEEP.observations.filter((o) => o.success === true).length}`,
  );
}, 600_000);

afterAll(async () => {
  if (savedCwd !== '') process.chdir(savedCwd);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await harness?.dispose();
});

// ─── The two named acceptance tests ────────────────────────────────────────

describe('DR-27 — T1 public-root tier', () => {
  it('PublicRoot_EveryRegisteredAction_ReachableThroughDispatch', () => {
    // DENOMINATOR — the packaged sweep's own derivation, off the live registry.
    const denominator = packagedActionDenominator();
    // NUMERATOR — recorded at runtime by the harness inside the dispatch call.
    const ledger = SWEEP.reached;

    // Guard the two-source property itself: the ledger is not the denominator
    // array, and it was built by executing something.
    expect(ledger).not.toBe(denominator);
    expect(SWEEP.observations.length).toBeGreaterThan(0);

    const report = computeCoverage(derivePackagedDenominators(), {
      actions: ledger,
      presentationAliases: [],
      hostCommands: [],
      errorFamilies: [],
      effectFamilies: [],
      cancellationPaths: [],
    });
    const actions = coverageFor(report, 'actions');

    const unreached = SWEEP.observations.filter((o) => !o.reached);
    expect(
      unreached.map(
        (o) => `${o.actionId} → ${o.rejection}${o.threw !== undefined ? ` (${o.threw})` : ''}`,
      ),
      'actions that dispatch() could not route to',
    ).toEqual([]);

    expect(
      actions.missing,
      `registered actions never reached through dispatch(): ${actions.missing.join(', ')}`,
    ).toEqual([]);

    // Ratchet, second side: the covered count cannot be lowered by shrinking
    // the surface.
    expect(
      actions.covered,
      `action coverage fell to ${actions.covered}; floor is ${ACTION_COVERAGE_FLOOR}`,
    ).toBeGreaterThanOrEqual(ACTION_COVERAGE_FLOOR);
    expect(actions.total).toBeGreaterThanOrEqual(ACTION_COVERAGE_FLOOR);
    expect(actions.ratio).toBe(1);
  });

  it('PublicRoot_ActionEnvelope_MatchesRegisteredOutputSchema', () => {
    const schemaById = new Map(registeredActions().map((a) => [a.actionId, a.outputSchema]));

    const violations: string[] = [];
    let validated = 0;

    for (const observation of SWEEP.observations) {
      const schema = schemaById.get(observation.actionId);
      if (schema === undefined) {
        violations.push(`${observation.actionId}: no registered outputSchema`);
        continue;
      }
      if (observation.envelope === undefined) {
        violations.push(`${observation.actionId}: no envelope produced (${observation.rejection})`);
        continue;
      }
      const parsed = schema.safeParse(observation.envelope);
      validated += 1;
      if (!parsed.success) {
        const issues = (
          parsed.error as { issues?: readonly { path?: unknown[]; message?: string }[] }
        ).issues;
        const detail = (issues ?? [])
          .slice(0, 3)
          .map((i) => `${(i.path ?? []).join('.') || '<root>'}: ${i.message ?? '?'}`)
          .join(' | ');
        violations.push(`${observation.actionId}: ${detail}`);
      }
    }

    expect(
      violations,
      `envelopes that failed their REGISTERED outputSchema:\n${violations.join('\n')}`,
    ).toEqual([]);
    // Non-vacuity: the loop above must actually have validated the whole
    // surface, not silently skipped it.
    expect(validated).toBe(SWEEP.observations.length);
    expect(validated).toBeGreaterThanOrEqual(ACTION_COVERAGE_FLOOR);
  });
});

// ─── Anti-vacuity controls ─────────────────────────────────────────────────

describe('DR-27 — the T1 tier cannot be vacuous', () => {
  it('PublicRoot_UnregisteredActionName_IsNotReachedThroughDispatch', () => {
    // The per-action control arm. If `classifyRouting` returned `reached` for
    // everything, this fails for all ~120 actions.
    const wronglyReached = SWEEP.controls
      .filter((c) => c.reached)
      .map((c) => `${c.toolName}.${c.actionName}`);
    expect(wronglyReached, 'unregistered action names that were reported REACHED').toEqual([]);

    // …and the rejection must name the action that was actually asked for,
    // so a probe on action A can never be satisfied by action B's envelope.
    const misattributed = SWEEP.controls.filter(
      (c) => !(c.result?.error?.message ?? '').includes(c.actionName),
    );
    expect(
      misattributed.map((c) => `${c.actionId}: ${c.result?.error?.message ?? '<no message>'}`),
      'routing rejections that did not name the requested action',
    ).toEqual([]);

    expect(SWEEP.controls.length).toBe(SWEEP.observations.length);
    expect(SWEEP.controls.every((c) => c.rejection === 'unknown-action')).toBe(true);
  });

  it('PublicRoot_CompositeHandlers_AreTheRealModuleExports', () => {
    // `assertNoStubbedCompositeHandlers` throws if the dispatch core's handler
    // cache holds anything other than the genuine module export — the exact
    // shape a `stubCompositeHandler()` install (or a `vi.mock`) would take.
    // Asserting on the count keeps the check from being vacuous when the cache
    // happens to be empty.
    expect(SWEEP.verifiedRealHandlers.length).toBeGreaterThanOrEqual(5);
    expect([...SWEEP.verifiedRealHandlers].sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_sync',
      'exarchos_view',
      'exarchos_workflow',
    ]);
  });

  it('PublicRoot_DenominatorSource_IsThePackagedSweepDerivation', () => {
    // Same source, and a LIVE one: seeding a synthetic action into the
    // registry grows the denominator, so the ratchet is measured against the
    // real surface rather than a frozen list.
    expect([...packagedActionDenominator()]).toEqual([...derivePackagedDenominators().actions]);
    expect([...packagedActionDenominator()].sort()).toEqual(
      registeredActions()
        .map((a) => a.actionId)
        .sort(),
    );

    const grown = packagedActionDenominator(seededRegistry());
    expect(grown.length).toBe(packagedActionDenominator().length + 1);
    expect(grown).toContain('exarchos_event.t36_unexercised_seed');

    // …and an action present in the denominator but absent from the runtime
    // ledger is reported MISSING — the mechanism the ratchet fails on.
    const report = computeCoverage(derivePackagedDenominators(seededRegistry()), {
      actions: SWEEP.reached,
      presentationAliases: [],
      hostCommands: [],
      errorFamilies: [],
      effectFamilies: [],
      cancellationPaths: [],
    });
    expect(coverageFor(report, 'actions').missing).toEqual([
      'exarchos_event.t36_unexercised_seed',
    ]);
  });

  it('PublicRoot_RoutingClassifier_SeparatesRoutingFailureFromTypedError', () => {
    // The classifier is the line between "reachable" and "non-throwing"; pin
    // both sides of it directly so the sweep's verdict is interpretable.
    expect(classifyRouting({ success: false, error: { code: 'UNKNOWN_TOOL', message: 'x' } })).toBe(
      'unknown-tool',
    );
    expect(
      classifyRouting({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'x' } }),
    ).toBe('unknown-action');
    expect(
      classifyRouting({ success: false, error: { code: 'MISSING_ACTION', message: 'x' } }),
    ).toBe('unknown-action');
    expect(
      classifyRouting({ success: false, error: { code: 'COMPOSITE_LOAD_FAILED', message: 'x' } }),
    ).toBe('handler-load-failed');
    expect(
      classifyRouting({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'exarchos_workflow: unknown action "nope". Valid actions: init',
        },
      }),
    ).toBe('unknown-action');
    // A REACHED action that merely rejected the input is not a routing failure.
    expect(
      classifyRouting({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'exarchos_workflow/init: featureId is required' },
      }),
    ).toBeNull();
    expect(classifyRouting({ success: true, data: {} })).toBeNull();
  });

  it('PublicRoot_Sweep_ActuallyEntersProductionHandlers', () => {
    // Reachability alone tolerates a surface that only ever answers
    // INVALID_INPUT. Record how many actions got PAST the pre-handler layers
    // (schema validation + the capability gates) into the composite handler
    // itself, and hold a floor under it, so "everything returns
    // INVALID_INPUT" cannot masquerade as a healthy tier.
    const entered = SWEEP.observations.filter((o) => o.handlerEntered);
    expect(
      entered.length,
      `only ${entered.length} of ${SWEEP.observations.length} actions got past the ` +
        `pre-handler layers into a production composite handler`,
    ).toBeGreaterThanOrEqual(HANDLER_ENTRY_FLOOR);
  });
});

// ─── seeded registry helper (local to this tier) ───────────────────────────

/** `TOOL_REGISTRY` plus one extra, never-exercised action on `exarchos_event`. */
function seededRegistry(): readonly CompositeTool[] {
  return TOOL_REGISTRY.map((tool) => {
    if (tool.name !== 'exarchos_event') return tool;
    const template = tool.actions[0];
    if (template === undefined) throw new Error('test setup: exarchos_event has no actions');
    const seeded: ToolAction = { ...template, name: 't36_unexercised_seed' };
    return { ...tool, actions: [...tool.actions, seeded] };
  });
}
