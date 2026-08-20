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
 * ## Why these are compile probes
 *
 * All four gates are type-level, so relaxing one is observable as `tsc`
 * accepting a program it previously rejected. Each probe therefore needs only a
 * spawned compiler, not a materialized module graph to execute.
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

function compiles(dir: string, files: readonly string[]): boolean {
  try {
    execFileSync(process.execPath, [TSC_BIN, ...TSC_FLAGS, ...files], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
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
    if (!source.includes(find)) {
      throw new Error(
        `probe target not found in the carrier: ${JSON.stringify(find)}. ` +
          'The guard may have been reshaped; a probe that cannot find what it relaxes proves nothing.',
      );
    }
    source = source.replace(find, replace);
  }
  fs.writeFileSync(path.join(dir, 'effect-carrier.ts'), source, 'utf8');
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
    expect(
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-emits.ts']),
      'a plan omitting its emission declaration compiled against the REAL carrier',
    ).toBe(false);

    materialize(dir, [
      { find: '  readonly emits: PlanEmissions;', replace: '  readonly emits?: PlanEmissions;' },
      {
        find: "return plan.emits.kind === 'records' ? plan.emits.emissions : [];",
        replace:
          "return plan.emits !== undefined && plan.emits.kind === 'records' ? plan.emits.emissions : [];",
      },
    ]);
    expect(
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-emits.ts']),
      'relaxing the required field did not make the omission compile, so the gate measures something else',
    ).toBe(true);
  });

  it('KillProbe_SuccessArmDropsEvidence_ValueBecomesReachable', () => {
    write(dir, 'success-without-evidence.ts');

    materialize(dir, []);
    expect(
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'success-without-evidence.ts']),
      'a committed value without evidence compiled against the REAL carrier',
    ).toBe(false);

    materialize(dir, [
      {
        find: "| { readonly kind: 'success'; readonly value: T; readonly evidence: EmissionEvidence }",
        replace:
          "| { readonly kind: 'success'; readonly value: T; readonly evidence?: EmissionEvidence }",
      },
    ]);
    expect(
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'success-without-evidence.ts']),
      'making evidence optional did not make the evidence-free value compile',
    ).toBe(true);
  });

  it('KillProbe_WitnessUnbranded_EvidenceBecomesForgeable', () => {
    write(dir, 'forged-witness.ts');

    materialize(dir, []);
    expect(
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'forged-witness.ts']),
      'a hand-built witness satisfied EmissionEvidence against the REAL carrier',
    ).toBe(false);

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
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'forged-witness.ts']),
      'removing the brand did not make the forged witness compile',
    ).toBe(true);
  });

  it('KillProbe_RecorderMadeOptional_LiveRunNeedsNoCapability', () => {
    write(dir, 'omits-recorder.ts');

    materialize(dir, []);
    expect(
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-recorder.ts']),
      'a live run with no recorder compiled against the REAL carrier',
    ).toBe(false);

    materialize(dir, [
      { find: '  recorder: EmissionRecorder,', replace: '  recorder?: EmissionRecorder,' },
    ]);
    expect(
      compiles(dir, ['effect-carrier.ts', 'schemas.ts', 'omits-recorder.ts']),
      'widening the recorder parameter did not make the capability-free call compile',
    ).toBe(true);
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
