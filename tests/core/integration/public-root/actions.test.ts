// The public-root integration tier: each composite action goes through
// `dispatch()` with a real event store and a real state directory. No handler
// is mocked, and no dispatch context is synthesized.
//
// A sweep that only asserts "nothing threw" proves nothing, because
// `dispatch()` returns an envelope for an unknown action too. Three choices
// give the assertions weight:
// 1. `classifyRouting` (`_harness.ts`) sorts each observation into reached or
//    not reached. A typed error from a resolved action counts as reached.
// 2. A control arm dispatches each action name with `UNREGISTERED_SUFFIX`. That
//    call must be not reached, and its rejection must name the changed action.
// 3. The ratchet has two sources. The denominator is
//    `derivePackagedDenominators().actions`, and the numerator is the runtime
//    ledger `harness.reachedActionIds()`.

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
} from '../../../../tools/conformance/src/parity/__tests__/packaged-proof.js';
import { TOOL_REGISTRY, type CompositeTool, type ToolAction } from '../../../../src/registry.js';

/**
 * The action denominator on the tree that this tier started from. The ratchet
 * has two sides: coverage has no missing action, and the covered count stays
 * at or above this floor. Thus deleted actions cannot make the sweep pass.
 * Raise the floor when the surface grows. A lower floor needs a review.
 */
const ACTION_COVERAGE_FLOOR = 120;

/**
 * The floor for actions whose outcome comes from the composite handler when
 * the payload is empty. Such an outcome is a success, or a failure outside the
 * `protocol` and `authorization` layers that run before the handler.
 */
const HANDLER_ENTRY_FLOOR = 20;

/** A suffix that makes a registered action name unroutable. */
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

/**
 * Runs the sweep once. Before the first action, it points HOME and USERPROFILE
 * at the scratch directory, blanks the GitHub tokens and changes to the
 * non-git scratch cwd. Thus git and gh actions fail fast in contract, and no
 * action reaches the home directory, the repository or the network.
 *
 * The loop iterates `registeredActions()`, but no assertion uses that array.
 * Coverage is scored against the packaged denominator with the runtime ledger.
 */
beforeAll(async () => {
  harness = await createPublicRootHarness();

  savedCwd = process.cwd();
  for (const key of ['HOME', 'USERPROFILE', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = harness.workspaceDir;
  process.env.USERPROFILE = harness.workspaceDir;
  process.env.GH_TOKEN = '';
  process.env.GITHUB_TOKEN = '';
  process.chdir(harness.workspaceDir);

  const started = Date.now();
  const controls: DispatchObservation[] = [];

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

describe('DR-27 — T1 public-root tier', () => {
  /**
   * The denominator is the derivation of the packaged sweep. The numerator is
   * the ledger that the harness records at runtime inside `dispatch()`. The
   * first assertions guard the two-source property: the ledger is not the
   * denominator array, and the sweep ran. The covered count also has a floor,
   * so a smaller surface cannot lower it.
   */
  it('PublicRoot_EveryRegisteredAction_ReachableThroughDispatch', () => {
    const denominator = packagedActionDenominator();
    const ledger = SWEEP.reached;

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

    expect(
      actions.covered,
      `action coverage fell to ${actions.covered}; floor is ${ACTION_COVERAGE_FLOOR}`,
    ).toBeGreaterThanOrEqual(ACTION_COVERAGE_FLOOR);
    expect(actions.total).toBeGreaterThanOrEqual(ACTION_COVERAGE_FLOOR);
    expect(actions.ratio).toBe(1);
  });

  /** The last assertions prove that the loop validated each observation and skipped none. */
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
    expect(validated).toBe(SWEEP.observations.length);
    expect(validated).toBeGreaterThanOrEqual(ACTION_COVERAGE_FLOOR);
  });
});

describe('DR-27 — the T1 tier cannot be vacuous', () => {
  /**
   * The control arm for each action. If `classifyRouting` returns reached for
   * each call, this test fails for all actions. The rejection must also name
   * the requested action, so the envelope of another action cannot satisfy a
   * probe.
   */
  it('PublicRoot_UnregisteredActionName_IsNotReachedThroughDispatch', () => {
    const wronglyReached = SWEEP.controls
      .filter((c) => c.reached)
      .map((c) => `${c.toolName}.${c.actionName}`);
    expect(wronglyReached, 'unregistered action names that were reported REACHED').toEqual([]);

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

  /**
   * `assertNoStubbedCompositeHandlers` throws when the handler cache of the
   * dispatch core holds a value that is not the real module export. A stub or
   * a `vi.mock` has that shape. The count assertion keeps the check from a
   * vacuous pass on an empty cache.
   */
  it('PublicRoot_CompositeHandlers_AreTheRealModuleExports', () => {
    expect(SWEEP.verifiedRealHandlers.length).toBeGreaterThanOrEqual(5);
    expect([...SWEEP.verifiedRealHandlers].sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_sync',
      'exarchos_view',
      'exarchos_workflow',
    ]);
  });

  /**
   * The denominator is the packaged derivation, and it is live: a synthetic
   * action in the registry makes it grow. An action that is in the denominator
   * but not in the runtime ledger is reported as missing, and the ratchet
   * fails on that.
   */
  it('PublicRoot_DenominatorSource_IsThePackagedSweepDerivation', () => {
    expect([...packagedActionDenominator()]).toEqual([...derivePackagedDenominators().actions]);
    expect([...packagedActionDenominator()].sort()).toEqual(
      registeredActions()
        .map((a) => a.actionId)
        .sort(),
    );

    const grown = packagedActionDenominator(seededRegistry());
    expect(grown.length).toBe(packagedActionDenominator().length + 1);
    expect(grown).toContain('exarchos_event.t36_unexercised_seed');

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

  /**
   * Pins both sides of the classifier, the line between "reachable" and
   * "non-throwing". A reached action that rejects its input is not a routing
   * failure.
   */
  it('PublicRoot_RoutingClassifier_SeparatesRoutingFailureFromTypedError', () => {
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
    expect(
      classifyRouting({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'exarchos_workflow/init: featureId is required' },
      }),
    ).toBeNull();
    expect(classifyRouting({ success: true, data: {} })).toBeNull();
  });

  /**
   * Reachability alone accepts a surface that answers only INVALID_INPUT. This
   * test counts the actions that pass schema validation and the capability
   * gates and enter the composite handler. It holds a floor under that count.
   */
  it('PublicRoot_Sweep_ActuallyEntersProductionHandlers', () => {
    const entered = SWEEP.observations.filter((o) => o.handlerEntered);
    expect(
      entered.length,
      `only ${entered.length} of ${SWEEP.observations.length} actions got past the ` +
        `pre-handler layers into a production composite handler`,
    ).toBeGreaterThanOrEqual(HANDLER_ENTRY_FLOOR);
  });
});

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
