/**
 * A handler that performs an effect and does not commit its event fails the build.
 *
 * The exported `@proof` aliases of the carrier are the standing claim. They live in `src/`, the
 * root `tsc` reads them on every build, and they fail when `src/` relaxes.
 * An alias asserts only that a bad shape is not assignable. This file spawns a compiler and
 * shows that a fixture fails. The fixtures compile against a copy of the carrier, so this file
 * does not guard `src/`.
 *
 * The file is in the acceptance tier because it spawns one compiler for each case.
 *
 * The harness points the imports of the copy at local stubs, so the copy compiles standalone.
 * The stub widens `EventType` to `string`. That is sound, because the subject is an omitted
 * emission declaration, not a registered event name. The copy also lets the probe relax the
 * guard with no change to the live tree.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CARRIER_PATH,
  compile,
  materializeCarrier,
  type Relaxation,
} from '../helpers/carrier-compile-harness.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

/**
 * The relaxation that this suite needs. The emission declaration becomes optional, and each site
 * that reads it accepts an absent declaration.
 */
const RELAX_REQUIRED_EMITS: readonly Relaxation[] = [
  { find: '  readonly emits: PlanEmissions;', replace: '  readonly emits?: PlanEmissions;' },
  {
    find: "return plan.emits.kind === 'records' ? plan.emits.emissions : [];",
    replace:
      "return plan.emits !== undefined && plan.emits.kind === 'records' ? plan.emits.emissions : [];",
  },
  {
    find: 'planEmissionsFromContract(fields.emits, contract.emissions)',
    replace:
      'planEmissionsFromContract(fields.emits ?? recordsNothing("relaxed"), contract.emissions)',
  },
  {
    find: '? fields.emits',
    replace: '? fields.emits ?? recordsNothing("relaxed")',
  },
];

/** A handler that performs an effect and does NOT say what records it. */
const OMITTING_FIXTURE = `
import type { EffectPlan } from './effect-carrier.js';

// The older shape: an owner, an idempotency boundary, a compensation
// contract — and no statement of what running this records.
export const plan: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'a-handler-that-effects-without-committing',
  description: 'write a file and say nothing about it',
  idempotent: true,
};
`;

describe('omission fails the build, not the run', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-compile-gate-'));
  });

  afterEach(() => {
    rmrf(dir);
  });

  /**
   * The output must name the fixture and the `emits` field. A fixture that fails for an unrelated
   * reason otherwise looks like a guard that holds.
   */
  it('CompileFail_EffectWithoutCommittedEvent_FailsTypecheck', async () => {
    materializeCarrier(dir, []);
    fs.writeFileSync(path.join(dir, 'fixture.ts'), OMITTING_FIXTURE, 'utf8');

    const run = await compile(dir, ['effect-carrier.ts', 'schemas.ts', 'fixture.ts']);

    expect(run.accepted, `a plan omitting its emission declaration compiled:\n${run.output}`).toBe(
      false,
    );
    expect(run.output).toContain('fixture.ts');
    expect(run.output).toMatch(/emits/);
  });

  /**
   * The kill probe compiles the same fixture against a copy with the guard relaxed. If the fixture
   * still fails, the first test measures a typo, not the requirement.
   */
  it('CompileFail_FixtureCompilesWhenGuardRemoved', async () => {
    materializeCarrier(dir, RELAX_REQUIRED_EMITS);
    fs.writeFileSync(path.join(dir, 'fixture.ts'), OMITTING_FIXTURE, 'utf8');

    const run = await compile(dir, ['effect-carrier.ts', 'schemas.ts', 'fixture.ts']);

    expect(
      run.accepted,
      `the fixture still failed with the guard relaxed, so it is not measuring the guard:\n${run.output}`,
    ).toBe(true);
  });

  /**
   * The probes run against copies. After the harness builds a relaxed copy, the real carrier must
   * still declare the required field.
   */
  it('CompileGate_ProbeLeavesTheLiveTreeUntouched', () => {
    materializeCarrier(dir, RELAX_REQUIRED_EMITS);
    expect(fs.readFileSync(CARRIER_PATH, 'utf8')).toContain('readonly emits: PlanEmissions;');
  });
});
