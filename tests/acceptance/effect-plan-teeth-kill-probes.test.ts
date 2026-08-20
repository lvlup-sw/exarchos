/**
 * DR-5 — every gate this slice adds is killed on purpose and observed to fail.
 *
 * ## What this file is for
 *
 * A guard with no kill probe has not been shown to measure anything. That is
 * the finding this programme keeps re-deriving, and it is the reason the plan
 * behind this slice was refuted three times: gates were repeatedly sited where
 * no compiler read them and no runner ran them, so they would have passed by
 * never being checked.
 *
 * Four gates land here, and each is relaxed in a COPY of the carrier before
 * being asserted to stop failing:
 *
 *   1. `emits` required                — the DR-1 closure
 *   2. evidence on the success arm     — DR-2's flagship, unprobed until now
 *   3. the branded replay witness      — DR-2's second arm
 *   4. the recorder required in live   — DR-2's unconditional demand
 *
 * The fifth gate — the compile fixture itself — is probed by the harness that
 * owns it (`effect-carrier-compile-gate.test.ts`, second case) and is
 * deliberately not duplicated here.
 *
 * ## Why copies, and never the live tree
 *
 * A probe that edits `src/` cannot restore cleanly across a thrown assertion, a
 * timeout or a worker crash, and residue in the source tree reddens unrelated
 * gates for reasons that have nothing to do with the probe. Every relaxation
 * below is applied to text in a temp directory; the live carrier is never
 * opened for writing, and the last case asserts exactly that.
 *
 * ## Compile probes, and the one that must EXECUTE
 *
 * Three of the four gates are type-level, so relaxing one is observable as
 * `tsc` accepting a program it previously rejected. The fourth is NOT, and an
 * earlier draft of this file said it was: the unconditional-recorder demand has
 * a type-level half (the parameter) AND a runtime half (the brand check, whose
 * own comment calls itself "the boundary the type system does not govern").
 * Probing only the parameter leaves the runtime half unmeasured — restoring the
 * `declaredEmissions(plan).length > 0 &&` condition reopens the abstention hole
 * for every `records-nothing` plan while the type stays required and a
 * compile-only probe stays green.
 *
 * So that gate gets both: a compile probe on the parameter, and an EXECUTING
 * probe that emits the relaxed copy to JavaScript and runs it in a spawned
 * node process, reading the outcome off stdout.
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

interface CompileResult {
  readonly accepted: boolean;
  readonly output: string;
}

function compile(dir: string, files: readonly string[]): CompileResult {
  try {
    execFileSync(process.execPath, [TSC_BIN, ...TSC_FLAGS, ...files], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { accepted: true, output: '' };
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

/**
 * The control arm: the REAL carrier must reject the fixture, and must reject it
 * FOR THE FIXTURE.
 *
 * Asserting only `accepted === false` is how both arms of a probe go vacuous at
 * once. The two arms are asymmetric by construction — the control keeps the
 * carrier's proof block while the treatment truncates it — so anything that
 * makes the control fail for an unrelated reason (a proof alias that does not
 * hold under this file's widened `EventType` stub, say) would leave the control
 * passing on a false negative and the treatment passing on a truncation, with
 * neither measuring the guard. Naming the fixture in the diagnostic is what
 * rules that out.
 */
function expectRejectedForTheFixture(dir: string, files: readonly string[], fixture: string): void {
  const run = compile(dir, files);
  expect(run.accepted, `the REAL carrier accepted ${fixture}`).toBe(false);
  expect(
    run.output,
    `the REAL carrier rejected something, but not ${fixture} — the control arm is measuring an unrelated error:\n${run.output}`,
  ).toContain(fixture);
}

/**
 * One relaxation: the text it replaces and what it becomes.
 *
 * `find` is asserted present before the edit. A probe whose target has moved
 * would otherwise silently relax NOTHING and then report that the guard still
 * holds — a false green of exactly the kind this file exists to prevent.
 */
interface Relaxation {
  readonly find: string;
  readonly replace: string;
}

/**
 * Where the carrier's compile-time proofs begin.
 *
 * The EARLIER of the two proof blocks, deliberately. The module has two — the
 * original capability proofs and the DR-1/DR-2 claims appended after them — and
 * truncating at the later marker leaves the first block asserting a property the
 * probe is trying to relax, so the copy fails for the right reason and the probe
 * reads as the guard holding.
 */
const PROOF_BLOCK_MARKER = '// ─── Compile-time proofs';

function materialize(dir: string, relaxations: readonly Relaxation[]): void {
  fs.writeFileSync(path.join(dir, 'schemas.ts'), 'export type EventType = string;\n', 'utf8');
  let source = fs.readFileSync(CARRIER, 'utf8');
  source = source.replace("from '../../events/schemas.js'", "from './schemas.js'");

  // The proof aliases assert exactly the properties a relaxation removes, so a
  // relaxed copy that kept them would fail for the RIGHT reason and mask the
  // fixture's own result. Truncating is deliberate: commenting the block out
  // would leave an unterminated comment and the copy would fail to parse, which
  // reads identically to the guard holding.
  if (relaxations.length > 0) {
    const at = source.indexOf(PROOF_BLOCK_MARKER);
    if (at === -1) {
      throw new Error(
        'the in-source proof block is gone from the carrier. A probe that cannot find it ' +
          'would relax a copy that still asserts what the probe removes, and report a false green.',
      );
    }
    source = source.slice(0, at);
  }

  for (const { find, replace } of relaxations) {
    // Presence is not enough — the target must be UNIQUE. `String.replace` with
    // a string edits the first match, so a `find` that occurs twice silently
    // relaxes the wrong site and the probe then reports that the guard held.
    // This file caught exactly that: the capability check is spelled
    // identically in `recordEmissions` and in `runEffect`, and the first draft
    // of the executing probe relaxed the former while asserting about the
    // latter.
    const occurrences = source.split(find).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `probe target not found in the carrier: ${JSON.stringify(find)}. ` +
          'The guard may have been reshaped; a probe that cannot find what it relaxes proves nothing.',
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `probe target is AMBIGUOUS (${occurrences} matches): ${JSON.stringify(find)}. ` +
          'Relaxing the first match would edit a site this probe is not asserting about.',
      );
    }
    source = source.replace(find, replace);
  }
  fs.writeFileSync(path.join(dir, 'effect-carrier.ts'), source, 'utf8');
}

/**
 * Emit the (possibly relaxed) carrier to JavaScript and RUN it.
 *
 * The recorder demand is the one gate with a runtime half, so it is the one
 * probe a compiler cannot observe. `runEffect` is called with `undefined` where
 * the capability belongs — the shape a transpiled or untyped caller produces,
 * which is exactly the population the runtime brand check exists for — and the
 * outcome is read off stdout rather than an exit code, so a crash in the
 * harness cannot be mistaken for the effect being refused.
 */
function runLiveWithNoRecorder(dir: string, relaxations: readonly Relaxation[]): string {
  materialize(dir, relaxations);

  // Emit rather than type-check. The carrier's one import is type-only, so the
  // emitted module has no imports at all and needs no resolution at runtime.
  try {
    execFileSync(
      process.execPath,
      [
        TSC_BIN,
        '--module',
        'commonjs',
        '--target',
        'ES2022',
        '--skipLibCheck',
        '--outDir',
        'out',
        'schemas.ts',
        'effect-carrier.ts',
      ],
      { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch {
    // tsc emits even when it reports errors; the relaxed copy is expected to
    // produce some. The runner below is the observation, not this exit status.
  }

  fs.writeFileSync(
    path.join(dir, 'out', 'runner.cjs'),
    `
const carrier = require('./effect-carrier.js');
const plan = {
  effectClass: 'filesystem',
  owner: 'probe-owner',
  description: 'an effect whose plan records nothing',
  idempotent: true,
  emits: carrier.recordsNothing('the probe declares an abstention'),
};
carrier
  .runEffect({ kind: 'live' }, plan, () => Promise.resolve('value'), undefined)
  .then((outcome) => { console.log('OUTCOME:committed:' + outcome.kind); })
  .catch((err) => { console.log('OUTCOME:refused:' + (err && err.code)); });
`,
    'utf8',
  );

  const stdout = execFileSync(process.execPath, ['out/runner.cjs'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const line = stdout.split('\n').find((l) => l.startsWith('OUTCOME:'));
  if (line === undefined) {
    throw new Error(`the runtime probe produced no outcome line:\n${stdout}`);
  }
  return line;
}

const FIXTURES: Record<string, string> = {
  // A plan with no emission declaration.
  'omits-emits.ts': `
import type { EffectPlan } from './effect-carrier.js';
export const plan: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'o',
  description: 'd',
  idempotent: true,
};
`,
  // A success carrier with no evidence.
  'success-without-evidence.ts': `
import type { EffectOutcome } from './effect-carrier.js';
export const outcome: EffectOutcome<number> = { kind: 'success', value: 1 };
`,
  // A witness nobody minted.
  'forged-witness.ts': `
import type { EmissionEvidence } from './effect-carrier.js';
export const evidence: EmissionEvidence = {
  kind: 'replayed',
  event: 'vcs.executed',
  source: 'forged by hand',
};
`,
  // A live run that supplies no capability.
  'omits-recorder.ts': `
import { runEffect, LIVE, recordsNothing } from './effect-carrier.js';
import type { EffectPlan } from './effect-carrier.js';
const plan: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'o',
  description: 'd',
  idempotent: true,
  emits: recordsNothing('nothing durable follows'),
};
export const run = (): Promise<unknown> => runEffect(LIVE, plan, () => Promise.resolve(1));
`,
};

function write(dir: string, fixture: string): void {
  const body = FIXTURES[fixture];
  if (body === undefined) throw new Error(`unknown fixture ${fixture}`);
  fs.writeFileSync(path.join(dir, fixture), body, 'utf8');
}

describe('DR-5 — kill probes: every gate is shown to fail', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-kill-probe-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('KillProbe_RequiredEmissionsRelaxed_TypecheckStopsFailing', () => {
    write(dir, 'omits-emits.ts');

    materialize(dir, []);
    expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-emits.ts'], 'omits-emits.ts');

    materialize(dir, [
      { find: '  readonly emits: PlanEmissions;', replace: '  readonly emits?: PlanEmissions;' },
      {
        find: "return plan.emits.kind === 'records' ? plan.emits.emissions : [];",
        replace:
          "return plan.emits !== undefined && plan.emits.kind === 'records' ? plan.emits.emissions : [];",
      },
    ]);
    expect(
      compile(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-emits.ts']).accepted,
      'relaxing the required field did not make the omission compile, so the gate measures something else',
    ).toBe(true);
  });

  it('KillProbe_SuccessArmDropsEvidence_ValueBecomesReachable', () => {
    write(dir, 'success-without-evidence.ts');

    materialize(dir, []);
    expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'success-without-evidence.ts'], 'success-without-evidence.ts');

    materialize(dir, [
      {
        find: "| { readonly kind: 'success'; readonly value: T; readonly evidence: EmissionEvidence }",
        replace:
          "| { readonly kind: 'success'; readonly value: T; readonly evidence?: EmissionEvidence }",
      },
    ]);
    expect(
      compile(dir, ['effect-carrier.ts', 'schemas.ts', 'success-without-evidence.ts']).accepted,
      'making evidence optional did not make the evidence-free value compile',
    ).toBe(true);
  });

  it('KillProbe_WitnessUnbranded_EvidenceBecomesForgeable', () => {
    write(dir, 'forged-witness.ts');

    materialize(dir, []);
    expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'forged-witness.ts'], 'forged-witness.ts');

    materialize(dir, [
      {
        find: 'export interface ReplayedEvidence {\n  readonly [EMISSION_EVIDENCE_BRAND]: true;',
        replace: 'export interface ReplayedEvidence {',
      },
      // The constructor mints the brand it no longer declares, so it has to be
      // relaxed with the type. Leaving it would fail the copy on the MINT site
      // rather than on the forgery, which is a different claim entirely.
      {
        find: "  return { [EMISSION_EVIDENCE_BRAND]: true, kind: 'replayed', event, source };",
        replace: "  return { kind: 'replayed', event, source };",
      },
    ]);
    expect(
      compile(dir, ['effect-carrier.ts', 'schemas.ts', 'forged-witness.ts']).accepted,
      'removing the brand did not make the forged witness compile',
    ).toBe(true);
  });

  it('KillProbe_RecorderMadeOptional_LiveRunNeedsNoCapability', () => {
    write(dir, 'omits-recorder.ts');

    materialize(dir, []);
    expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-recorder.ts'], 'omits-recorder.ts');

    materialize(dir, [
      { find: '  recorder: EmissionRecorder,', replace: '  recorder?: EmissionRecorder,' },
    ]);
    expect(
      compile(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-recorder.ts']).accepted,
      'widening the recorder parameter did not make the capability-free call compile',
    ).toBe(true);
  });

  it('KillProbe_RecorderMadeConditional_LiveRunProceeds', () => {
    // The EXECUTING probe, and the reason this file no longer claims every gate
    // is type-level. Restoring the `declaredEmissions(plan).length > 0 &&`
    // condition leaves the PARAMETER required, so the compile probe above stays
    // green and the type-level proof stays true — while a `records-nothing`
    // plan silently stops needing a capability at all. That is the abstention
    // hole DR-2 closed, and only running the code can see it reopen.
    const refused = runLiveWithNoRecorder(dir, []);
    expect(refused, 'the REAL carrier committed a live run with no capability').toMatch(
      /^OUTCOME:refused:/,
    );

    const proceeded = runLiveWithNoRecorder(dir, [
      {
        // Two lines, because the first alone also matches `recordEmissions`.
        find:
          '  if (!isEmissionRecorder(recorder)) {\n' +
          "    throw new UnrecordedEmissionError(plan, 'before', 0, declaredEmissions(plan).length);",
        replace:
          '  if (declaredEmissions(plan).length > 0 && !isEmissionRecorder(recorder)) {\n' +
          "    throw new UnrecordedEmissionError(plan, 'before', 0, declaredEmissions(plan).length);",
      },
    ]);
    expect(
      proceeded,
      'restoring the declared-count condition did not let a capability-free live run commit, ' +
        'so this probe is not measuring the runtime half of the gate',
    ).toMatch(/^OUTCOME:committed:success/);
  });

  it('KillProbes_LeaveNoResidue_InTheirOwnWriteSet', () => {
    // Scoped to what the probes write, NOT to repository byte-identity: this
    // suite runs alongside tiers that legitimately write coverage, SQLite and
    // `.exarchos/` state, so a whole-repo assertion would measure their work
    // and fail for reasons unrelated to any probe.
    materialize(dir, [
      { find: '  readonly emits: PlanEmissions;', replace: '  readonly emits?: PlanEmissions;' },
    ]);

    // The live carrier still declares every guard the probes relaxed.
    const live = fs.readFileSync(CARRIER, 'utf8');
    expect(live).toContain('  readonly emits: PlanEmissions;');
    expect(live).toContain('  recorder: EmissionRecorder,');
    expect(live).toContain('readonly [EMISSION_EVIDENCE_BRAND]: true;');
    expect(live).toContain('// ─── DR-1 / DR-2 compile claims');
  });
});
