/**
 * Self-tests for the aggregating `npm run validate` runner (task 064, DR-24).
 *
 * The defect under test is not "a gate is wrong" — it is "a gate never ran and
 * the reader could not tell". Measured on the integration tip on 2026-08-07 the
 * `&&` chain executed 1 of its 9 declared steps and printed one failure, which
 * is byte-for-byte what "1 red, 8 green" would look like to a human.
 *
 * So the assertions here are about EXECUTION, not about verdicts:
 *
 *   1. KILL FIXTURE — a red step 1 does not stop steps 2..n. This is the
 *      property that would have surfaced the eight hidden gates. It is asserted
 *      both against the pure loop and against a real spawned run, because the
 *      pure loop cannot catch a short-circuit reintroduced in the CLI path.
 *   2. NON-EMPTY DENOMINATOR — zero declared steps, and zero executed steps,
 *      each fail loudly rather than rendering as a clean run.
 *   3. TRUNCATION DETECTION — a step that could not execute at all (spawn
 *      failure) is reported as NOT RUN and fails the run; it is never counted
 *      as passed.
 *   4. DECLARED COUNT IS DATA — the runner's denominator tracks the manifest,
 *      so appending a step cannot leave a stale hard-coded expectation behind.
 *      A hard-coded count would be this task's own defect, one level up.
 *
 * The gate is authored as ESM `.mjs`; NodeNext resolution requires the explicit
 * extension at import time.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// No .d.ts for this .mjs runner, but `allowJs` infers one from the source.
import {
  parseManifest,
  parseDeclaredOutcomes,
  classifyOutcome,
  renderCommand,
  runAllSteps,
  summarize,
  renderSummary,
  DEFAULT_MANIFEST_PATH,
} from '../../tools/audit/gates/run-validate.mjs';
import { EXIT_GAPS } from '../../tools/audit/gates/check-measured-premises.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../..');
const RUNNER = path.join(SCRIPTS_DIR, '../../tools/audit/gates/run-validate.mjs');

interface Step {
  id: string;
  command: string;
  args: string[];
  why?: string;
}

interface Outcome {
  id: string;
  command: string;
  executed: boolean;
  status: number | null;
  passed: boolean;
  error?: string;
}

interface Summary {
  ok: boolean;
  declared: number;
  executed: number;
  passed: number;
  tolerated: number;
  failed: number;
  violations: string[];
  notices: string[];
  classifications: Record<string, { severity: string; verdict: string; note?: string }>;
}

const step = (id: string, args: string[] = []): Step => ({ id, command: 'node', args });

/**
 * Write a throwaway manifest into a per-invocation temp dir and hand back its
 * absolute path. `mkdtemp` (not a fixed `/tmp/<name>.json`) because concurrent
 * agents share `/tmp` and a fixed path lets one run clobber another's fixture.
 */
function seedManifest(steps: unknown[]): { manifestPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-validate-fixture-'));
  const file = path.join(dir, 'validate-manifest.json');
  fs.writeFileSync(file, JSON.stringify({ steps }, null, 2));
  return { manifestPath: file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [RUNNER, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('run-validate — anti-truncation (task 064, DR-24)', () => {
  it('RunValidate_FailingFirstStep_StillExecutesEveryLaterStep', () => {
    // THE KILL FIXTURE, in its pure form. Step 1 is red; 2 and 3 must still run.
    const steps: Step[] = [step('red-first'), step('later-a'), step('later-b')];
    const attempted: string[] = [];
    const outcomes: Outcome[] = runAllSteps(steps, (s: Step) => {
      attempted.push(s.id);
      return { status: s.id === 'red-first' ? 1 : 0 };
    });

    expect(attempted).toEqual(['red-first', 'later-a', 'later-b']);
    expect(outcomes.every((o) => o.executed)).toBe(true);
    expect(outcomes.map((o) => o.passed)).toEqual([false, true, true]);

    const summary: Summary = summarize(steps, outcomes);
    expect(summary.executed).toBe(3);
    expect(summary.declared).toBe(3);
    expect(summary.failed).toBe(1);
    // The run fails — aggregation is not leniency. What changed is that the
    // reader now learns the later two ran and were green.
    expect(summary.ok).toBe(false);
    expect(summary.violations).toEqual([]);
  });

  it('RunValidate_EveryStepFails_ReportsAllOfThemNotJustTheFirst', () => {
    const steps: Step[] = [step('a'), step('b'), step('c')];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: 1 }));
    const summary: Summary = summarize(steps, outcomes);
    expect(summary.executed).toBe(3);
    expect(summary.failed).toBe(3);
    const rendered: string = renderSummary(outcomes, summary);
    for (const id of ['a', 'b', 'c']) expect(rendered).toContain(id);
  });

  it('RunValidate_ThrowingStepRunner_DoesNotAbortTheRemainingSteps', () => {
    // A runner that throws must not restore short-circuiting through the back
    // door — the throw is recorded against its own step and the loop continues.
    const steps: Step[] = [step('boom'), step('after')];
    const attempted: string[] = [];
    const outcomes: Outcome[] = runAllSteps(steps, (s: Step) => {
      attempted.push(s.id);
      if (s.id === 'boom') throw new Error('spawn exploded');
      return { status: 0 };
    });
    expect(attempted).toEqual(['boom', 'after']);
    const [boom, after] = outcomes;
    if (!boom || !after) throw new Error('both steps must be reported');
    expect(boom.executed).toBe(false);
    expect(boom.error).toContain('spawn exploded');
    expect(after.passed).toBe(true);
  });
});

describe('run-validate — non-empty denominator (task 064, DR-24)', () => {
  it('RunValidate_ZeroDeclaredSteps_FailsRatherThanReportingSuccess', () => {
    const summary: Summary = summarize([], []);
    expect(summary.ok).toBe(false);
    expect(summary.declared).toBe(0);
    expect(summary.violations.join('\n')).toContain('[empty-manifest]');
  });

  it('RunValidate_ZeroExecutedSteps_FailsRatherThanReportingSuccess', () => {
    const steps: Step[] = [step('a'), step('b')];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: null, error: 'ENOENT' }));
    const summary: Summary = summarize(steps, outcomes);
    expect(summary.executed).toBe(0);
    expect(summary.ok).toBe(false);
    expect(summary.violations.join('\n')).toContain('[empty-run]');
  });

  it('RunValidate_PartiallyExecutedRun_IsReportedAsTruncatedNotAsPassed', () => {
    const steps: Step[] = [step('ran'), step('never-ran')];
    const outcomes: Outcome[] = runAllSteps(steps, (s: Step) =>
      s.id === 'ran' ? { status: 0 } : { status: null, error: 'ENOENT' },
    );
    const summary: Summary = summarize(steps, outcomes);
    expect(summary.executed).toBe(1);
    expect(summary.declared).toBe(2);
    expect(summary.ok).toBe(false);
    const joined = summary.violations.join('\n');
    expect(joined).toContain('[truncated-run]');
    expect(joined).toContain('never-ran');
    // A step that did not run must never be counted among the passes.
    expect(summary.passed).toBe(1);
    expect(renderSummary(outcomes, summary)).toContain('NOT RUN');
  });
});

describe('run-validate — declared count comes from data (task 064, DR-24)', () => {
  it('RunValidate_DeclaredCount_TracksTheManifestNotAHardCodedInteger', () => {
    // Appending a step must move the denominator with no code change. If the
    // count were a literal in the runner, this test is where it would break.
    const three: Step[] = [step('a'), step('b'), step('c')];
    const four: Step[] = [...three, step('d')];
    const run = (steps: Step[]): Summary => summarize(steps, runAllSteps(steps, () => ({ status: 0 })));
    expect(run(three).declared).toBe(3);
    expect(run(four).declared).toBe(4);
    expect(run(four).executed).toBe(4);
  });

  it('RunValidate_ShippedManifest_ParsesAndDeclaresAtLeastOneStep', () => {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8'),
    );
    const parsed = parseManifest(raw) as { steps?: Step[]; error?: string };
    expect(parsed.error).toBeUndefined();
    expect(parsed.steps!.length).toBeGreaterThan(0);
    // The plugin-packaging gate stays in the chain. This replaces the old
    // `pkg.scripts.validate` substring assertion, which could only see a string.
    expect(parsed.steps!.map((s) => s.id)).toContain('plugin-packaging');
    for (const s of parsed.steps!) {
      expect(typeof s.command).toBe('string');
      expect(renderCommand(s).length).toBeGreaterThan(0);
    }
  });

  it('RunValidate_ShippedManifestSteps_AllPointAtFilesThatExist', () => {
    // A manifest naming a deleted script would otherwise surface only as a
    // spawn failure at run time — and the whole point of this task is that a
    // step which cannot run must not be discoverable only by reading output.
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8'),
    );
    const { steps } = parseManifest(raw) as { steps: Step[] };
    const missing = steps
      .flatMap((s) => s.args)
      .filter((a) => a.startsWith('scripts/'))
      .filter((a) => !fs.existsSync(path.join(REPO_ROOT, a)));
    expect(missing).toEqual([]);
  });
});

describe('run-validate — malformed manifests fail closed (task 064, DR-24)', () => {
  it.each([
    ['not an object', 42, 'not a JSON object'],
    ['no steps array', { steps: 'nope' }, 'no `steps` array'],
    ['step without id', { steps: [{ command: 'node' }] }, 'has no `id`'],
    ['step without command', { steps: [{ id: 'a' }] }, 'has no `command`'],
    ['duplicate ids', { steps: [{ id: 'a', command: 'node' }, { id: 'a', command: 'node' }] }, 'repeats the id'],
    ['non-string args', { steps: [{ id: 'a', command: 'node', args: [1] }] }, 'non-string-array'],
  ])('RunValidate_MalformedManifest_%s_IsRejected', (_label, json, expected) => {
    const parsed = parseManifest(json) as { error?: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain(expected as string);
  });
});

// ─── DR-7 (task 078): a step's verdict is the step's own verdict ────────────
//
// THE KILL FIXTURE for site 2. `check-measured-premises.mjs` printed
// `VERDICT: GAPS` — with the words "reportable, NOT a pass" — and exited 0, so
// this aggregate recorded `PASS measured-premises`, 9/9, exit 0. The exit code
// was the only thing the runner could see, and the gate had spent its only
// machine-readable channel saying "pass".
//
// Two halves have to hold together for that to be closed: the GATE must give
// `gaps` its own exit code, and the AGGREGATOR must render the verdict rather
// than infer it from `status === 0`. These test the aggregator half; the gate
// half is `MeasuredPremises_GapsVerdict_ExitsDistinctFromPass` in
// check-measured-premises.test.ts.

describe('run-validate — verdict fidelity (task 078, DR-7)', () => {
  const TODAY = '2026-08-09';
  const gapsStep = (severity: string, expires = '2026-11-30'): Step & { outcomes: unknown } => ({
    id: 'measured-premises',
    command: 'node',
    args: [],
    outcomes: { '3': { verdict: 'gaps', severity, issue: '#1789', expires } },
  });

  it('ValidateAggregator_StepReportingGaps_IsNotRecordedAsPass', () => {
    const steps = [gapsStep('advisory'), step('other')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, (s: Step) =>
      s.id === 'measured-premises' ? { status: 3 } : { status: 0 },
    );
    const summary: Summary = summarize(steps, outcomes, TODAY);

    // THE assertion. Before the fix this step landed in `passed`.
    expect(summary.passed).toBe(1);
    expect(summary.tolerated).toBe(1);
    expect(summary.classifications['measured-premises'].severity).not.toBe('pass');
    expect(summary.classifications['measured-premises'].verdict).toBe('gaps');

    // The reader sees the real verdict, and sees that it is not a pass.
    const rendered: string = renderSummary(outcomes, summary);
    expect(rendered).toContain('GAPS');
    expect(rendered).toMatch(/GAPS\s+measured-premises/);
    expect(rendered).not.toMatch(/PASS\s+measured-premises/);
    expect(rendered).toContain('tolerated non-pass');
    expect(rendered).toContain('#1789');

    // The exit code reflects the CONFIGURED severity: advisory ⇒ the chain
    // still passes, and the non-pass is reported rather than hidden.
    expect(summary.ok).toBe(true);
    expect(summary.notices.join('\n')).toContain('[tolerated-non-pass]');
  });

  it('ValidateAggregator_GapsDeclaredAsFail_FailsTheChain', () => {
    // The same verdict under the other configured severity. This is what makes
    // "the exit code reflects the configured severity" a real dial rather than
    // a euphemism for "always tolerated".
    const steps = [gapsStep('fail')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: 3 }));
    const summary: Summary = summarize(steps, outcomes, TODAY);
    expect(summary.failed).toBe(1);
    expect(summary.passed).toBe(0);
    expect(summary.ok).toBe(false);
    expect(renderSummary(outcomes, summary)).toMatch(/GAPS\s+measured-premises/);
  });

  it('ValidateAggregator_ExpiredAdvisory_StopsBeingTolerated', () => {
    // A toleration nobody revisits is a permanent exemption wearing a date.
    const steps = [gapsStep('advisory', '2026-08-08')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: 3 }));
    const summary: Summary = summarize(steps, outcomes, TODAY);
    expect(summary.tolerated).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.violations.join('\n')).toContain('[expired-toleration]');
    expect(summary.violations.join('\n')).toContain('#1789');
  });

  it('ValidateAggregator_AdvisoryOnItsExpiryDate_IsStillTolerated', () => {
    // The boundary the two halves have to agree on. `expires` is documented as
    // the LAST tolerated day here and `--tolerate-gaps-until` is documented as
    // inclusive in check-measured-premises.mjs, so ON the date both must still
    // tolerate. The pair above and below this line is what makes that a
    // property rather than a comment: one day earlier tolerates, one day later
    // does not, and neither `<=` nor `>` can satisfy both at once.
    const onExpiry = [gapsStep('advisory', TODAY)] as unknown as Step[];
    const summary: Summary = summarize(
      onExpiry,
      runAllSteps(onExpiry, () => ({ status: 3 })),
      TODAY,
    );
    expect(summary.tolerated).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.ok).toBe(true);

    // …and the day after is where it stops. Same inputs, one day later.
    const dayAfter = [gapsStep('advisory', TODAY)] as unknown as Step[];
    const expired: Summary = summarize(
      dayAfter,
      runAllSteps(dayAfter, () => ({ status: 3 })),
      '2026-08-10',
    );
    expect(expired.tolerated).toBe(0);
    expect(expired.failed).toBe(1);
    expect(expired.violations.join('\n')).toContain('[expired-toleration]');
  });

  it('ValidateAggregator_UndeclaredNonZeroExit_StillFails', () => {
    // Toleration is opt-in per exit code. A gate that starts exiting 4 has said
    // nothing about what 4 means, so it fails — the fail-closed default.
    const steps = [gapsStep('advisory')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: 4 }));
    const summary: Summary = summarize(steps, outcomes, TODAY);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.classifications['measured-premises'].verdict).toBe('fail');
  });

  it('ValidateAggregator_PlainSteps_KeepTheirTwoValuedVerdicts', () => {
    // The discriminating half: adding a third value must not make ordinary
    // steps ambiguous. A green step is still a pass, a red one still a fail.
    const steps: Step[] = [step('green'), step('red')];
    const outcomes: Outcome[] = runAllSteps(steps, (s: Step) =>
      s.id === 'green' ? { status: 0 } : { status: 1 },
    );
    const summary: Summary = summarize(steps, outcomes, TODAY);
    expect(summary.passed).toBe(1);
    expect(summary.tolerated).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
    const rendered: string = renderSummary(outcomes, summary);
    expect(rendered).toMatch(/PASS\s+green/);
    expect(rendered).toMatch(/FAIL\s+red/);
  });

  it('ClassifyOutcome_ExitZero_IsAlwaysPassAndNeverDeclarable', () => {
    expect(classifyOutcome(gapsStep('advisory'), { id: 'x', executed: true, status: 0 }, TODAY))
      .toMatchObject({ severity: 'pass', verdict: 'pass' });
    // …and the manifest cannot claim otherwise.
    const rejected = parseDeclaredOutcomes('s', { '0': { verdict: 'nope', severity: 'fail' } }) as {
      error?: string;
    };
    expect(rejected.error).toContain('exit code 0');
  });

  it.each([
    ['non-object outcomes', 'nope', 'non-object `outcomes`'],
    ['non-numeric key', { abc: { verdict: 'g', severity: 'fail' } }, 'not an exit code'],
    ['missing verdict', { '3': { severity: 'fail' } }, 'has no `verdict`'],
    ['verdict named pass', { '3': { verdict: 'pass', severity: 'fail' } }, 'names its verdict "pass"'],
    ['bad severity', { '3': { verdict: 'g', severity: 'meh' } }, 'expected \'advisory\' or \'fail\''],
    ['advisory without expiry', { '3': { verdict: 'g', severity: 'advisory', issue: '#1' } }, 'no `expires`'],
    ['advisory without issue', { '3': { verdict: 'g', severity: 'advisory', expires: '2099-01-01' } }, 'names no `issue`'],
  ])('ValidateManifest_MalformedOutcome_%s_IsRejected', (_label, raw, expected) => {
    const parsed = parseDeclaredOutcomes('step-x', raw) as { error?: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain(expected as string);
  });

  it('ValidateManifest_ShippedMeasuredPremisesStep_DeclaresItsGapsVerdict', () => {
    // Binds the shipped data to the shipped gate: the exit code the manifest
    // tolerates must be the one `check-measured-premises.mjs` actually emits.
    // A drift here is how a declared toleration silently stops applying.
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8'),
    );
    const { steps } = parseManifest(raw) as {
      steps: Array<Step & { outcomes?: Record<string, { verdict: string; severity: string; expires?: string; issue?: string }> }>;
    };
    const premises = steps.find((s) => s.id === 'measured-premises');
    expect(premises).toBeDefined();
    // Keyed off the gate's own exported constant, not the literal `3`. JSON
    // cannot import `EXIT_GAPS`, so this assertion is the only place the
    // shipped manifest key and the exit code the gate emits are held together —
    // without it the comment above claims a binding that does not exist.
    const gaps = premises!.outcomes?.[String(EXIT_GAPS)];
    expect(gaps).toBeDefined();
    expect(gaps!.verdict).toBe('gaps');
    expect(gaps!.issue).toBeTruthy();
    // The expiry is in the future — an already-expired declaration would fail
    // the chain, which is the intended behaviour but not a shippable default.
    expect(gaps!.expires! > new Date().toISOString().slice(0, 10)).toBe(true);
  });

});

describe('run-validate — CLI (task 064, DR-24)', () => {
  it('RunValidateCli_RedFirstStep_StillRunsAndReportsTheLaterSteps', () => {
    // THE KILL FIXTURE end-to-end. `node -e 'process.exit(1)'` is a genuine red
    // step 1; the two after it must appear in the JSON report as executed.
    const seeded = seedManifest([
      { id: 'seeded-red', command: 'node', args: ['-e', 'process.exit(1)'] },
      { id: 'seeded-green-a', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'seeded-green-b', command: 'node', args: ['-e', 'process.exit(0)'] },
    ]);
    try {
      const { status, stdout } = runCli(['--json', '--manifest', seeded.manifestPath]);
      expect(status).toBe(1);
      const report = JSON.parse(stdout) as Summary & { steps: Outcome[] };
      expect(report.declared).toBe(3);
      expect(report.executed).toBe(3);
      expect(report.failed).toBe(1);
      expect(report.steps.map((s) => [s.id, s.executed, s.passed])).toEqual([
        ['seeded-red', true, false],
        ['seeded-green-a', true, true],
        ['seeded-green-b', true, true],
      ]);
    } finally {
      seeded.cleanup();
    }
  }, 20000);

  it('RunValidateCli_EmptyManifest_ExitsNonZero', () => {
    const seeded = seedManifest([]);
    try {
      const { status, stdout } = runCli(['--json', '--manifest', seeded.manifestPath]);
      expect(status).toBe(1);
      const report = JSON.parse(stdout) as Summary;
      expect(report.ok).toBe(false);
      expect(report.violations.join('\n')).toContain('[empty-manifest]');
    } finally {
      seeded.cleanup();
    }
  }, 20000);

  it('RunValidateCli_UnreadableManifest_ExitsTwoNotZero', () => {
    // Fail CLOSED. A runner that cannot find its manifest knows of no gates,
    // and "knows of no gates" must never render as "all gates passed".
    const { status, stderr } = runCli(['--manifest', 'scripts/does-not-exist.json']);
    expect(status).toBe(2);
    expect(stderr).toContain('could not be read');
  }, 20000);

  it('RunValidateCli_List_EnumeratesTheShippedSteps', () => {
    const { status, stdout } = runCli(['--list']);
    expect(status).toBe(0);
    expect(stdout).toContain('plugin-packaging');
    expect(stdout).toContain('declared step(s)');
  }, 20000);

  it('RunValidateCli_StepExitingWithDeclaredGapsCode_ReportsGapsNotPass', () => {
    // DR-7 end to end through a REAL spawned step: the runner classifies what
    // the process actually returned, not what the pure loop was handed.
    const seeded = seedManifest([
      {
        id: 'seeded-gaps',
        command: 'node',
        args: ['-e', 'process.exit(3)'],
        outcomes: {
          '3': { verdict: 'gaps', severity: 'advisory', issue: '#1789', expires: '2099-01-01' },
        },
      },
      { id: 'seeded-green', command: 'node', args: ['-e', 'process.exit(0)'] },
    ]);
    try {
      const { status, stdout } = runCli(['--json', '--manifest', seeded.manifestPath]);
      // Advisory ⇒ the chain still exits 0 …
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as Summary & { steps: Outcome[] };
      // … but exactly ONE step passed, and it was not this one.
      expect(report.passed).toBe(1);
      expect(report.tolerated).toBe(1);
      expect(report.classifications['seeded-gaps'].verdict).toBe('gaps');
      expect(report.classifications['seeded-gaps'].severity).toBe('tolerated');
      expect(report.notices.join('\n')).toContain('seeded-gaps');
    } finally {
      seeded.cleanup();
    }
  }, 20000);

  it('MeasuredPremisesToleration_ThreeCallSites_CarryOneDate', () => {
    // The #1789 toleration is spelled in three places that no gate was binding:
    // the ci.yml flag, the manifest `outcomes` entry the aggregator reads, and
    // the installer suite's shell waiver. Re-dating one and not the others is
    // silent — the lane keeps passing while the three disagree about when the
    // exemption ends. Reading all three here is what makes them one date.
    const ciYml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const manifest = fs.readFileSync(path.join(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8');
    const installer = fs.readFileSync(path.join(SCRIPTS_DIR, 'installer-verify.test.ts'), 'utf8');

    const ciDate = /--tolerate-gaps-until\s+(\d{4}-\d{2}-\d{2})/.exec(ciYml)?.[1];
    const manifestDate = (
      JSON.parse(manifest) as {
        steps: { id: string; outcomes?: Record<string, { expires?: string }> }[];
      }
    ).steps.find((s) => s.id === 'measured-premises')?.outcomes?.['3']?.expires;
    const waiverDate = /SHELL_SKIP_WAIVER[\s\S]{0,200}?expires:\s*'(\d{4}-\d{2}-\d{2})'/.exec(
      installer,
    )?.[1];

    // Each must be FOUND, or the regex has gone stale and the check is vacuous.
    for (const [name, found] of [
      ['ci.yml --tolerate-gaps-until', ciDate],
      ['validate-manifest.json expires', manifestDate],
      ['installer-verify SHELL_SKIP_WAIVER.expires', waiverDate],
    ] as const) {
      expect(found, `${name} not located — the binding check has gone blind`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
    expect(new Set([ciDate, manifestDate, waiverDate]).size).toBe(1);
  });

});
