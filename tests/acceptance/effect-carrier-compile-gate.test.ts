/**
 * DR-3 — a handler that effects without committing its event fails the BUILD.
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
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '../..');
const CARRIER = path.join(packageRoot, 'src/dispatch/core/effect-carrier.ts');

/**
 * Resolved rather than path-joined.
 *
 * `node_modules` is not necessarily under `packageRoot`: a git worktree resolves
 * its dependencies from the parent checkout by walking up, so a hardcoded
 * `packageRoot/node_modules/...` is absent exactly when the suite runs in one.
 * `require.resolve` follows the same walk Node does.
 */
const TSC_BIN = createRequire(import.meta.url).resolve('typescript/bin/tsc');

const TSC_FLAGS = [
  '--noEmit',
  '--strict',
  '--exactOptionalPropertyTypes',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--target',
  'ES2022',
];

interface TscRun {
  readonly accepted: boolean;
  readonly output: string;
}

function runTsc(files: readonly string[], cwd: string): TscRun {
  try {
    const output = execFileSync(
      process.execPath,
      [TSC_BIN, ...TSC_FLAGS, ...files],
      { cwd, encoding: 'utf8', stdio: 'pipe' },
    );
    return { accepted: true, output };
  } catch (err: unknown) {
    const streams: string[] = [];
    if (typeof err === 'object' && err !== null) {
      for (const key of ['stdout', 'stderr']) {
        const value: unknown = Reflect.get(err, key);
        if (typeof value === 'string') streams.push(value);
        else if (value instanceof Uint8Array) streams.push(Buffer.from(value).toString('utf8'));
      }
    }
    return { accepted: false, output: streams.join('') };
  }
}

/** The carrier, standalone: its one import rewritten to a local stub. */
function materializeCarrier(dir: string, relax: boolean): void {
  fs.writeFileSync(
    path.join(dir, 'schemas.ts'),
    'export type EventType = string;\n',
    'utf8',
  );
  let source = fs.readFileSync(CARRIER, 'utf8');
  source = source.replace("from '../../events/schemas.js'", "from './schemas.js'");

  if (relax) {
    const required = '  readonly emits: PlanEmissions;';
    if (!source.includes(required)) {
      throw new Error(
        'the relaxation target moved: the carrier no longer declares `readonly emits: PlanEmissions;`. ' +
          'A probe that cannot find what it relaxes proves nothing, so this fails loudly.',
      );
    }
    source = source.replace(required, '  readonly emits?: PlanEmissions;');
    // The proof aliases assert the very property being relaxed, so they would
    // fail the RELAXED build for the right reason and mask the fixture's own
    // result. Drop them; the fixture is the subject here.
    source = source.slice(0, source.indexOf('// ─── DR-1 / DR-2 compile claims'));
    // `declaredEmissions` reads the now-optional field.
    source = source.replace(
      "return plan.emits.kind === 'records' ? plan.emits.emissions : [];",
      "return plan.emits !== undefined && plan.emits.kind === 'records' ? plan.emits.emissions : [];",
    );
  }
  fs.writeFileSync(path.join(dir, 'effect-carrier.ts'), source, 'utf8');
}

/** A handler that performs an effect and does NOT say what records it. */
const OMITTING_FIXTURE = `
import type { EffectPlan } from './effect-carrier.js';

// The pre-DR-1 shape: an owner, an idempotency boundary, a compensation
// contract — and no statement of what running this records.
export const plan: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'a-handler-that-effects-without-committing',
  description: 'write a file and say nothing about it',
  idempotent: true,
};
`;

describe('DR-3 — omission fails the build, not the run', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-compile-gate-'));
  });

  afterEach(() => {
    // Removed on BOTH paths: a throwing assertion must not leave a tree behind.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('CompileFail_EffectWithoutCommittedEvent_FailsTypecheck', () => {
    materializeCarrier(dir, false);
    fs.writeFileSync(path.join(dir, 'fixture.ts'), OMITTING_FIXTURE, 'utf8');

    const run = runTsc(['effect-carrier.ts', 'schemas.ts', 'fixture.ts'], dir);

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
    materializeCarrier(dir, true);
    fs.writeFileSync(path.join(dir, 'fixture.ts'), OMITTING_FIXTURE, 'utf8');

    const run = runTsc(['effect-carrier.ts', 'schemas.ts', 'fixture.ts'], dir);

    expect(
      run.accepted,
      `the fixture still failed with the guard relaxed, so it is not measuring the guard:\n${run.output}`,
    ).toBe(true);
  });

  it('CompileGate_ProbeLeavesTheLiveTreeUntouched', () => {
    // The probes run against copies. This asserts the property rather than
    // trusting it: the real carrier still declares the required field after a
    // relaxed copy has been built from it.
    materializeCarrier(dir, true);
    expect(fs.readFileSync(CARRIER, 'utf8')).toContain('readonly emits: PlanEmissions;');
  });
});
