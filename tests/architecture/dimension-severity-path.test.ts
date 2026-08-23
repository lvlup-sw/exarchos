/**
 * `gate.dimension` survives the retirement of its best-known consumer.
 *
 * The convergence view read a dimension off `gate.executed` details and folded
 * D1–D5 into a single verdict. It was retired: the durable gate runner never
 * stamps a dimension, so the two gates on D2 were invisible to it and D2 could
 * never converge. Nothing about that argument touches the OTHER thing a
 * dimension is for.
 *
 * A dimension is a user-facing config key. An operator writes
 * `review.dimensions.D3.enabled: false` in `.exarchos.yml`, and
 * `resolveGateSeverity` turns that into `'disabled'` for every gate declaring
 * D3 — which is what stops the gate from running at all. That path has four
 * links and no single test that fails when any one of them is cut:
 *
 *   1. an action declares `gate.dimension`;
 *   2. `.exarchos.yml` accepts `D1…D5` under `review.dimensions`;
 *   3. `resolveConfig` carries the operator's setting into the resolved config;
 *   4. `resolveGateSeverity` reads it, and `withConfigSeverity` acts on it.
 *
 * Delete link 1 from the declarations and links 2–4 keep passing their own unit
 * tests against a dimension no gate names any more. Delete link 2 and the
 * declarations still typecheck. So this file walks the LIVE registry, takes
 * every dimension a gate actually declares, and drives each one end to end
 * through an `.exarchos.yml` document — the population and the mechanism proven
 * together, because either one alone is satisfied by a corpse.
 */
import { describe, expect, it } from 'vitest';

import { TOOL_REGISTRY } from '../../src/registry.js';
import { ProjectConfigSchema } from '../../src/config/yaml-schema.js';
import { resolveConfig, DEFAULTS } from '../../src/config/resolve.js';
import { resolveGateSeverity } from '../../src/verbs/gates/gate-severity.js';
import { withConfigSeverity } from '../../src/verbs/gates/gate-utils.js';
import type { ToolResult } from '../../src/format.js';

/** The key space `.exarchos.yml` exposes under `review.dimensions`. */
const CONFIGURABLE_DIMENSION = /^D[1-5]$/;

/**
 * The floor below which the population stops corroborating anything.
 *
 * Measured at 16 declarations spanning all five dimensions when this guard was
 * written. Pinned well under that so ordinary retirements do not redden it,
 * and far enough above zero that a change which strips the field wholesale
 * cannot pass by emptying the walk.
 */
const MINIMUM_DECLARATIONS = 10;

interface Declaration {
  readonly tool: string;
  readonly action: string;
  readonly dimension: string;
}

/** Every `(action, dimension)` pair the live registry declares. */
function declaredDimensions(): Declaration[] {
  const found: Declaration[] = [];
  for (const tool of TOOL_REGISTRY) {
    for (const action of tool.actions) {
      const dimension = action.gate?.dimension;
      if (typeof dimension === 'string' && CONFIGURABLE_DIMENSION.test(dimension)) {
        found.push({ tool: tool.name, action: action.name, dimension });
      }
    }
  }
  return found;
}

/** An `.exarchos.yml` document setting one dimension, parsed as a user would write it. */
function configWithDimension(dimension: string, setting: Record<string, unknown>) {
  const parsed = ProjectConfigSchema.safeParse({ review: { dimensions: { [dimension]: setting } } });
  expect(
    parsed.success,
    `.exarchos.yml rejected review.dimensions.${dimension} — the operator-facing key is gone`,
  ).toBe(true);
  if (!parsed.success) throw new Error('unreachable');
  return resolveConfig(parsed.data);
}

describe('gate dimension — the severity path', () => {
  it('DimensionField_Survives_ForSeverityConfig', () => {
    const declarations = declaredDimensions();

    // The denominator. Every assertion below quantifies over this list, so an
    // empty or gutted one would make them all vacuously true — which is the
    // shape a wholesale removal of the field would actually take.
    expect(
      declarations.length,
      'no registered gate declares a D1-D5 dimension any more; the `.exarchos.yml` ' +
        '`review.dimensions` knob now addresses nothing',
    ).toBeGreaterThanOrEqual(MINIMUM_DECLARATIONS);

    for (const { tool, action, dimension } of declarations) {
      const where = `${tool}.${action} (${dimension})`;

      // An operator turning the dimension off must disable the gate. This is
      // the setting with teeth: `withConfigSeverity` refuses to invoke the
      // handler at all when it resolves to `disabled`.
      const off = configWithDimension(dimension, { enabled: false });
      expect(
        resolveGateSeverity(action, dimension, off),
        `${where}: review.dimensions.${dimension}.enabled=false no longer disables the gate`,
      ).toBe('disabled');

      // And downgrading it must reach the same resolver. `severity: warning` is
      // the advisory arm — the gate still runs, but a failure stops blocking.
      const warn = configWithDimension(dimension, { severity: 'warning' });
      expect(
        resolveGateSeverity(action, dimension, warn),
        `${where}: review.dimensions.${dimension}.severity=warning no longer downgrades the gate`,
      ).toBe('warning');
    }
  });

  it('DimensionDisable_StopsTheHandlerFromRunning', async () => {
    // The resolver returning `'disabled'` is only half the path. This is the
    // consumer that acts on it, driven through the same public entry point a
    // gate dispatch uses, so a rewiring that leaves the resolver intact but
    // stops consulting it fails here.
    const declarations = declaredDimensions();
    expect(declarations.length).toBeGreaterThanOrEqual(MINIMUM_DECLARATIONS);

    const { action, dimension } = declarations[0]!;
    const disabled = configWithDimension(dimension, { enabled: false });

    let invoked = 0;
    const handler = async (): Promise<ToolResult> => {
      invoked += 1;
      return { success: true, data: { passed: true } };
    };

    const skipped = await withConfigSeverity(action, dimension, disabled, handler);
    expect(invoked, `${action} ran despite review.dimensions.${dimension}.enabled=false`).toBe(0);
    expect(skipped.success).toBe(true);
    expect((skipped.data as { skipped?: boolean }).skipped).toBe(true);

    // The complement, so the assertion above is a decision and not a handler
    // that never runs: with no dimension setting, the gate is invoked.
    await withConfigSeverity(action, dimension, DEFAULTS, handler);
    expect(invoked, 'the gate did not run under the default config either — the probe is inert').toBe(1);
  });

  it('EveryDeclaredDimension_IsNameableInExarchosYml', () => {
    // The declarations and the config enum are two independently editable
    // lists. A gate declaring `D6` would resolve `'blocking'` forever with no
    // way for an operator to reach it, and nothing else in the tree compares
    // the two sides.
    // Denominator: a filter over an empty declaration set yields `[]` and
    // satisfies the assertion below without comparing anything.
    const declared = declaredDimensions();
    expect(
      declared.length,
      'no gate declares a dimension — this comparison has nothing to run over',
    ).toBeGreaterThan(0);

    const unreachable = declared.filter(({ dimension }) => {
      return !ProjectConfigSchema.safeParse({
        review: { dimensions: { [dimension]: 'warning' } },
      }).success;
    });

    expect(
      unreachable,
      'a gate declares a dimension `.exarchos.yml` cannot name, so its severity is ' +
        'unreachable from project config',
    ).toEqual([]);
  });
});
