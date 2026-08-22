/**
 * A handler that effects without committing its event fails the BUILD.
 *
 * ## Why this file exists, and what it does NOT carry
 *
 * The carrier's exported `@proof` aliases are the standing claim: they live in
 * `src/`, the root `tsc` reads them on every build, and they go red the moment
 * `src/` relaxes. That is the half that catches a regression.
 *
 * This file carries the other half, which an alias cannot: an alias asserts
 * that a bad shape is *not assignable*, but only a spawned compiler shows a
 * fixture actually FAILING. Both halves are needed and they are not
 * interchangeable — a fixture compiled against a COPY can never redden when the
 * real source relaxes, so nothing here should be read as guarding `src/`.
 *
 * ## Why the acceptance tier
 *
 * Not for isolation, and not because this tier is typechecked (whether the
 * HARNESS typechecks has no bearing on whether the FIXTURE compiles). It is
 * here because it spawns a compiler per case, which is an acceptance-shaped
 * cost rather than a unit-shaped one.
 *
 * ## Why copying the carrier is tractable
 *
 * `effect-carrier.ts` has exactly ONE import — `import type { EventType }` —
 * so a copy with that specifier rewritten to a local stub compiles standalone.
 * The stub widens `EventType` to `string`, which is sound for this fixture: the
 * subject is whether a plan may omit its emission declaration, not whether an
 * event name is registered. A copy is also what lets the kill probe relax the
 * guard without ever touching the live tree.
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

/**
 * The single relaxation this suite needs: the emission declaration becomes
 * optional again, and the one accessor that reads it is widened to match.
 */
const RELAX_REQUIRED_EMITS: readonly Relaxation[] = [
  { find: '  readonly emits: PlanEmissions;', replace: '  readonly emits?: PlanEmissions;' },
  {
    find: "return plan.emits.kind === 'records' ? plan.emits.emissions : [];",
    replace:
      "return plan.emits !== undefined && plan.emits.kind === 'records' ? plan.emits.emissions : [];",
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
    // Removed on BOTH paths: a throwing assertion must not leave a tree behind.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('CompileFail_EffectWithoutCommittedEvent_FailsTypecheck', () => {
    materializeCarrier(dir, []);
    fs.writeFileSync(path.join(dir, 'fixture.ts'), OMITTING_FIXTURE, 'utf8');

    const run = compile(dir, ['effect-carrier.ts', 'schemas.ts', 'fixture.ts']);

    expect(run.accepted, `a plan omitting its emission declaration compiled:\n${run.output}`).toBe(
      false,
    );
    // Named, not merely non-zero: a fixture that fails for an unrelated reason
    // would otherwise read as the guard working.
    expect(run.output).toContain('fixture.ts');
    expect(run.output).toMatch(/emits/);
  });

  it('CompileFail_FixtureCompilesWhenGuardRemoved', () => {
    // The probe: the SAME fixture against a copy whose guard is relaxed. If it
    // still failed, the first assertion would be measuring a typo rather than
    // the requirement.
    materializeCarrier(dir, RELAX_REQUIRED_EMITS);
    fs.writeFileSync(path.join(dir, 'fixture.ts'), OMITTING_FIXTURE, 'utf8');

    const run = compile(dir, ['effect-carrier.ts', 'schemas.ts', 'fixture.ts']);

    expect(
      run.accepted,
      `the fixture still failed with the guard relaxed, so it is not measuring the guard:\n${run.output}`,
    ).toBe(true);
  });

  it('CompileGate_ProbeLeavesTheLiveTreeUntouched', () => {
    // The probes run against copies. This asserts the property rather than
    // trusting it: the real carrier still declares the required field after a
    // relaxed copy has been built from it.
    materializeCarrier(dir, RELAX_REQUIRED_EMITS);
    expect(fs.readFileSync(CARRIER_PATH, 'utf8')).toContain('readonly emits: PlanEmissions;');
  });
});
