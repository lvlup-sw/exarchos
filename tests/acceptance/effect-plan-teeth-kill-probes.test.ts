/**
 * Kill probes for the gates of the effect carrier. Each probe relaxes one gate and observes that
 * the failure goes away. A guard with no kill probe does not show that it measures anything.
 *
 * The probes cover four gates. Three are type-level: the required `emits` field, the evidence on
 * the success arm and the branded replay witness. The fourth is the recorder that a live run
 * requires. `effect-carrier-compile-gate.test.ts` probes the compile fixture itself.
 *
 * Each relaxation applies to a copy of the carrier in a temp directory. A probe that edits `src/`
 * cannot restore it after a thrown assertion, a timeout or a worker crash. The last test asserts
 * that the live carrier keeps each guard.
 *
 * For a type-level gate, `tsc` accepts the fixture after the relaxation. The recorder gate also
 * has a runtime half, the brand check. That gate gets a compile probe on the parameter and a
 * probe that runs the relaxed copy in a spawned node process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CARRIER_PATH,
  TSC_BIN,
  compile,
  materializeCarrier,
  type Relaxation,
} from '../helpers/carrier-compile-harness.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

/**
 * The control arm. The real carrier must reject the fixture, and the diagnostic must name the
 * fixture.
 *
 * `accepted === false` alone is not sufficient. The control keeps the proof block of the carrier,
 * and the treatment truncates it. If the control fails for an unrelated reason (for example a
 * proof alias that fails with the widened `EventType` stub), it passes on a false negative. The
 * treatment then passes on the truncation, and neither arm measures the guard.
 */
async function expectRejectedForTheFixture(
  dir: string,
  files: readonly string[],
  fixture: string,
): Promise<void> {
  const run = await compile(dir, files);
  expect(run.accepted, `the REAL carrier accepted ${fixture}`).toBe(false);
  expect(
    run.output,
    `the REAL carrier rejected something, but not ${fixture} — the control arm is measuring an unrelated error:\n${run.output}`,
  ).toContain(fixture);
}

/**
 * Emits the carrier copy to JavaScript and runs it.
 *
 * The recorder gate has a runtime half that a compiler cannot observe. The runner calls
 * `runEffect` with `undefined` in the capability position, as a transpiled or untyped caller
 * does. The outcome comes from stdout, not from the exit code, so a harness crash does not look
 * like a refused effect.
 *
 * The function emits the local stubs with the carrier, because replay identity is a runtime
 * import. `tsc` emits output when it reports errors, and the copy can produce some. Thus the
 * function ignores the exit status of `tsc`.
 */
async function runLiveWithNoRecorder(dir: string, relaxations: readonly Relaxation[]): Promise<string> {
  materializeCarrier(dir, relaxations);

  try {
    await execFileAsync(
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
        'request-context.ts',
        'action-contract.ts',
        'effect-carrier.ts',
      ],
      { cwd: dir },
    );
  } catch {
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

  const stdout = await execFileAsync(process.execPath, ['out/runner.cjs'], {
    cwd: dir,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('OUTCOME:'));
  if (line === undefined) {
    throw new Error(`the runtime probe produced no outcome line:\n${stdout}`);
  }
  return line;
}

const FIXTURES: Record<string, string> = {
  /** A plan with no emission declaration. */
  'omits-emits.ts': `
import type { EffectPlan } from './effect-carrier.js';
export const plan: EffectPlan = {
  effectClass: 'filesystem',
  owner: 'o',
  description: 'd',
  idempotent: true,
};
`,
  /** A success carrier with no evidence. */
  'success-without-evidence.ts': `
import type { EffectOutcome } from './effect-carrier.js';
export const outcome: EffectOutcome<number> = { kind: 'success', value: 1 };
`,
  /** A witness that nobody minted. */
  'forged-witness.ts': `
import type { EmissionEvidence } from './effect-carrier.js';
export const evidence: EmissionEvidence = {
  kind: 'replayed',
  event: 'vcs.executed',
  source: 'forged by hand',
};
`,
  /** A live run that supplies no capability. */
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

describe('kill probes: every gate is shown to fail', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-kill-probe-'));
  });

  afterEach(() => {
    rmrf(dir);
  });

  it('KillProbe_RequiredEmissionsRelaxed_TypecheckStopsFailing', async () => {
    write(dir, 'omits-emits.ts');

    materializeCarrier(dir, []);
    await expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-emits.ts'], 'omits-emits.ts');

    materializeCarrier(dir, [
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
    ]);
    expect(
      (await compile(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-emits.ts'])).accepted,
      'relaxing the required field did not make the omission compile, so the gate measures something else',
    ).toBe(true);
  });

  it('KillProbe_SuccessArmDropsEvidence_ValueBecomesReachable', async () => {
    write(dir, 'success-without-evidence.ts');

    materializeCarrier(dir, []);
    await expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'success-without-evidence.ts'], 'success-without-evidence.ts');

    materializeCarrier(dir, [
      {
        find: "| { readonly kind: 'success'; readonly value: T; readonly evidence: EmissionEvidence }",
        replace:
          "| { readonly kind: 'success'; readonly value: T; readonly evidence?: EmissionEvidence }",
      },
    ]);
    expect(
      (await compile(dir, ['effect-carrier.ts', 'schemas.ts', 'success-without-evidence.ts'])).accepted,
      'making evidence optional did not make the evidence-free value compile',
    ).toBe(true);
  });

  /**
   * The second relaxation removes the brand from the constructor, which mints it. Without that
   * relaxation, the copy fails at the mint site, not at the forgery.
   */
  it('KillProbe_WitnessUnbranded_EvidenceBecomesForgeable', async () => {
    write(dir, 'forged-witness.ts');

    materializeCarrier(dir, []);
    await expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'forged-witness.ts'], 'forged-witness.ts');

    materializeCarrier(dir, [
      {
        find: 'export interface ReplayedEvidence {\n  readonly [EMISSION_EVIDENCE_BRAND]: true;',
        replace: 'export interface ReplayedEvidence {',
      },
      {
        find: "  return { [EMISSION_EVIDENCE_BRAND]: true, kind: 'replayed', event, source };",
        replace: "  return { kind: 'replayed', event, source };",
      },
    ]);
    expect(
      (await compile(dir, ['effect-carrier.ts', 'schemas.ts', 'forged-witness.ts'])).accepted,
      'removing the brand did not make the forged witness compile',
    ).toBe(true);
  });

  it('KillProbe_RecorderMadeOptional_LiveRunNeedsNoCapability', async () => {
    write(dir, 'omits-recorder.ts');

    materializeCarrier(dir, []);
    await expectRejectedForTheFixture(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-recorder.ts'], 'omits-recorder.ts');

    materializeCarrier(dir, [
      { find: '  recorder: EmissionRecorder,', replace: '  recorder?: EmissionRecorder,' },
    ]);
    expect(
      (await compile(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-recorder.ts'])).accepted,
      'widening the recorder parameter did not make the capability-free call compile',
    ).toBe(true);
  });

  /**
   * The probe that runs code. The relaxation restores the `declaredEmissions(plan).length > 0 &&`
   * condition. The parameter stays required, so the compile probe above stays green. A
   * `records-nothing` plan then needs no capability, and only a run of the code shows that.
   * The `find` text has two lines, because the first line alone also matches `recordEmissions`.
   */
  it('KillProbe_RecorderMadeConditional_LiveRunProceeds', async () => {
    const refused = await runLiveWithNoRecorder(dir, []);
    expect(refused, 'the REAL carrier committed a live run with no capability').toMatch(
      /^OUTCOME:refused:/,
    );

    const proceeded = await runLiveWithNoRecorder(dir, [
      {
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

  /**
   * The check covers only what the probes write, not the byte identity of the repository. Other
   * tiers write coverage, SQLite and `.exarchos/` state at the same time, and a whole-repository
   * assertion measures their work. The live carrier must still declare each guard that the
   * probes relaxed.
   */
  it('KillProbes_LeaveNoResidue_InTheirOwnWriteSet', () => {
    materializeCarrier(dir, [
      { find: '  readonly emits: PlanEmissions;', replace: '  readonly emits?: PlanEmissions;' },
    ]);

    const live = fs.readFileSync(CARRIER_PATH, 'utf8');
    expect(live).toContain('  readonly emits: PlanEmissions;');
    expect(live).toContain('  recorder: EmissionRecorder,');
    expect(live).toContain('readonly [EMISSION_EVIDENCE_BRAND]: true;');
    expect(live).toContain('export type _EffectCarrier_PlanWithoutEmissions_IsNotAnEffectPlan = Expect<');
  });
});
