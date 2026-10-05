/**
 * Self-tests for the runner of `npm run validate` (`tools/audit/gates/run-validate.mjs`).
 *
 * The runner must show each gate that did not run. An `&&` chain stops at the first red
 * step and does not report the steps that it skipped. Thus the assertions are about
 * execution:
 *
 *   1. A red step does not stop the later steps. The pure loop and a spawned CLI run each
 *      prove this, because the pure loop cannot see a short circuit in the CLI path.
 *   2. Zero declared steps fail the run, and zero executed steps fail the run.
 *   3. A step that cannot spawn shows as NOT RUN, fails the run, and does not count as
 *      passed.
 *   4. The declared count comes from the manifest, not from a literal in the runner.
 *
 * The runner is an `.mjs` module with no `.d.ts` file. `allowJs` in `tests/tsconfig.json`
 * lets the checker infer its types.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { spawnAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

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
 * Writes a manifest into a new temp directory, and returns its path and a cleanup function.
 * Concurrent runs share the system temp directory, so a fixed path lets one run overwrite
 * the fixture of another.
 */
function seedManifest(steps: unknown[]): { manifestPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-validate-fixture-'));
  const file = path.join(dir, 'validate-manifest.json');
  fs.writeFileSync(file, JSON.stringify({ steps }, null, 2));
  return { manifestPath: file, cleanup: () => rmrf(dir) };
}

async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const result = await spawnAsync('node', [RUNNER, ...args], { cwd: REPO_ROOT });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('run-validate — anti-truncation (task 064, DR-24)', () => {
  /**
   * The pure loop runs steps 2 and 3 after a red step 1. The run still fails, and the
   * outcomes show that the later steps ran and passed.
   */
  it('RunValidate_FailingFirstStep_StillExecutesEveryLaterStep', () => {
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

  /** The loop records the error on the step that threw, as a step that did not run. */
  it('RunValidate_ThrowingStepRunner_DoesNotAbortTheRemainingSteps', () => {
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
    expect(summary.passed).toBe(1);
    expect(renderSummary(outcomes, summary)).toContain('NOT RUN');
  });
});

describe('run-validate — declared count comes from data (task 064, DR-24)', () => {
  it('RunValidate_DeclaredCount_TracksTheManifestNotAHardCodedInteger', () => {
    const three: Step[] = [step('a'), step('b'), step('c')];
    const four: Step[] = [...three, step('d')];
    const run = (steps: Step[]): Summary => summarize(steps, runAllSteps(steps, () => ({ status: 0 })));
    expect(run(three).declared).toBe(3);
    expect(run(four).declared).toBe(4);
    expect(run(four).executed).toBe(4);
  });

  /** The shipped manifest must keep the `plugin-packaging` step. */
  it('RunValidate_ShippedManifest_ParsesAndDeclaresAtLeastOneStep', () => {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8'),
    );
    const parsed = parseManifest(raw) as { steps?: Step[]; error?: string };
    expect(parsed.error).toBeUndefined();
    expect(parsed.steps!.length).toBeGreaterThan(0);
    expect(parsed.steps!.map((s) => s.id)).toContain('plugin-packaging');
    for (const s of parsed.steps!) {
      expect(typeof s.command).toBe('string');
      expect(renderCommand(s).length).toBeGreaterThan(0);
    }
  });

  /**
   * A manifest that names a deleted script must fail here, not only as a spawn failure at
   * run time. The check reads only the arguments that start with `scripts/`. Each script of
   * the shipped manifest is under `tools/audit/gates/`, so the check reads zero paths.
   */
  it('RunValidate_ShippedManifestSteps_AllPointAtFilesThatExist', () => {
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

/**
 * The verdict of a step must be the verdict that the step computed. The gate
 * `check-measured-premises.mjs` gives `gaps` its own exit code. The runner must show the
 * verdict that the manifest declares for that code and must not count the step as passed.
 * These tests cover the runner. `MeasuredPremises_GapsVerdict_ExitsDistinctFromPass` in
 * `check-measured-premises.test.ts` covers the gate.
 */
describe('run-validate — verdict fidelity (task 078, DR-7)', () => {
  const TODAY = '2026-08-09';
  type ValidateStep = import('../../tools/audit/gates/run-validate.mjs').ValidateStep;
  const gapsStep = (severity: 'advisory' | 'fail', expires = '2026-11-30'): ValidateStep => ({
    id: 'measured-premises',
    command: 'node',
    args: [],
    outcomes: { '3': { verdict: 'gaps', severity, issue: '#1789', expires } },
  });

  /**
   * An advisory `gaps` step counts as tolerated, not as passed. The summary shows `GAPS`,
   * the run stays ok, and a notice reports the step.
   */
  it('ValidateAggregator_StepReportingGaps_IsNotRecordedAsPass', () => {
    const steps = [gapsStep('advisory'), step('other')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, (s: Step) =>
      s.id === 'measured-premises' ? { status: 3 } : { status: 0 },
    );
    const summary: Summary = summarize(steps, outcomes, TODAY);

    expect(summary.passed).toBe(1);
    expect(summary.tolerated).toBe(1);
    expect(summary.classifications['measured-premises']?.severity).not.toBe('pass');
    expect(summary.classifications['measured-premises']?.verdict).toBe('gaps');

    const rendered: string = renderSummary(outcomes, summary);
    expect(rendered).toContain('GAPS');
    expect(rendered).toMatch(/GAPS\s+measured-premises/);
    expect(rendered).not.toMatch(/PASS\s+measured-premises/);
    expect(rendered).toContain('tolerated non-pass');
    expect(rendered).toContain('#1789');

    expect(summary.ok).toBe(true);
    expect(summary.notices.join('\n')).toContain('[tolerated-non-pass]');
  });

  /** The same verdict with the severity `fail` proves that the declared severity decides the result. */
  it('ValidateAggregator_GapsDeclaredAsFail_FailsTheChain', () => {
    const steps = [gapsStep('fail')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: 3 }));
    const summary: Summary = summarize(steps, outcomes, TODAY);
    expect(summary.failed).toBe(1);
    expect(summary.passed).toBe(0);
    expect(summary.ok).toBe(false);
    expect(renderSummary(outcomes, summary)).toMatch(/GAPS\s+measured-premises/);
  });

  /** An expired toleration must fail, or the exemption becomes permanent. */
  it('ValidateAggregator_ExpiredAdvisory_StopsBeingTolerated', () => {
    const steps = [gapsStep('advisory', '2026-08-08')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: 3 }));
    const summary: Summary = summarize(steps, outcomes, TODAY);
    expect(summary.tolerated).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.violations.join('\n')).toContain('[expired-toleration]');
    expect(summary.violations.join('\n')).toContain('#1789');
  });

  /**
   * `expires` is the last tolerated day. `--tolerate-gaps-until` in
   * `check-measured-premises.mjs` is inclusive in the same way. The advisory holds on the
   * date and fails one day later.
   */
  it('ValidateAggregator_AdvisoryOnItsExpiryDate_IsStillTolerated', () => {
    const onExpiry = [gapsStep('advisory', TODAY)] as unknown as Step[];
    const summary: Summary = summarize(
      onExpiry,
      runAllSteps(onExpiry, () => ({ status: 3 })),
      TODAY,
    );
    expect(summary.tolerated).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.ok).toBe(true);

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

  /** A toleration applies to one declared exit code. An undeclared code fails. */
  it('ValidateAggregator_UndeclaredNonZeroExit_StillFails', () => {
    const steps = [gapsStep('advisory')] as unknown as Step[];
    const outcomes: Outcome[] = runAllSteps(steps, () => ({ status: 4 }));
    const summary: Summary = summarize(steps, outcomes, TODAY);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
    expect(summary.classifications['measured-premises']?.verdict).toBe('fail');
  });

  it('ValidateAggregator_PlainSteps_KeepTheirTwoValuedVerdicts', () => {
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
    expect(
      classifyOutcome(
        gapsStep('advisory'),
        { id: 'x', command: 'node', executed: true, status: 0, passed: true },
        TODAY,
      ),
    )
      .toMatchObject({ severity: 'pass', verdict: 'pass' });
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

  /**
   * The exit code that the shipped manifest tolerates must be the code that
   * `check-measured-premises.mjs` exits with. The key comes from `EXIT_GAPS`, because
   * JSON cannot import the constant and no other check holds the two together. The
   * expiry date must be in the future, because an expired declaration fails the chain.
   */
  it('ValidateManifest_ShippedMeasuredPremisesStep_DeclaresItsGapsVerdict', () => {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, DEFAULT_MANIFEST_PATH), 'utf8'),
    );
    const { steps } = parseManifest(raw) as {
      steps: Array<Step & { outcomes?: Record<string, { verdict: string; severity: string; expires?: string; issue?: string }> }>;
    };
    const premises = steps.find((s) => s.id === 'measured-premises');
    expect(premises).toBeDefined();
    const gaps = premises!.outcomes?.[String(EXIT_GAPS)];
    expect(gaps).toBeDefined();
    expect(gaps!.verdict).toBe('gaps');
    expect(gaps!.issue).toBeTruthy();
    expect(gaps!.expires! > new Date().toISOString().slice(0, 10)).toBe(true);
  });

});

describe('run-validate — CLI (task 064, DR-24)', () => {
  it('RunValidateCli_RedFirstStep_StillRunsAndReportsTheLaterSteps', async () => {
    const seeded = seedManifest([
      { id: 'seeded-red', command: 'node', args: ['-e', 'process.exit(1)'] },
      { id: 'seeded-green-a', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'seeded-green-b', command: 'node', args: ['-e', 'process.exit(0)'] },
    ]);
    try {
      const { status, stdout } = await runCli(['--json', '--manifest', seeded.manifestPath]);
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

  it('RunValidateCli_EmptyManifest_ExitsNonZero', async () => {
    const seeded = seedManifest([]);
    try {
      const { status, stdout } = await runCli(['--json', '--manifest', seeded.manifestPath]);
      expect(status).toBe(1);
      const report = JSON.parse(stdout) as Summary;
      expect(report.ok).toBe(false);
      expect(report.violations.join('\n')).toContain('[empty-manifest]');
    } finally {
      seeded.cleanup();
    }
  }, 20000);

  /** A runner that cannot read its manifest knows no gates. That state must not look like a pass. */
  it('RunValidateCli_UnreadableManifest_ExitsTwoNotZero', async () => {
    const { status, stderr } = await runCli(['--manifest', 'scripts/does-not-exist.json']);
    expect(status).toBe(2);
    expect(stderr).toContain('could not be read');
  }, 20000);

  it('RunValidateCli_List_EnumeratesTheShippedSteps', async () => {
    const { status, stdout } = await runCli(['--list']);
    expect(status).toBe(0);
    expect(stdout).toContain('plugin-packaging');
    expect(stdout).toContain('declared step(s)');
  }, 20000);

  /**
   * A spawned step exits with the declared advisory code. The run exits 0, but only the
   * other step counts as passed.
   */
  it('RunValidateCli_StepExitingWithDeclaredGapsCode_ReportsGapsNotPass', async () => {
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
      const { status, stdout } = await runCli(['--json', '--manifest', seeded.manifestPath]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as Summary & { steps: Outcome[] };
      expect(report.passed).toBe(1);
      expect(report.tolerated).toBe(1);
      expect(report.classifications['seeded-gaps']?.verdict).toBe('gaps');
      expect(report.classifications['seeded-gaps']?.severity).toBe('tolerated');
      expect(report.notices.join('\n')).toContain('seeded-gaps');
    } finally {
      seeded.cleanup();
    }
  }, 20000);

  /**
   * The date of the measured-premises toleration is in three places: the `ci.yml` flag,
   * the `outcomes` entry of the manifest, and the shell waiver in
   * `installer-verify.test.ts`. A new date in only one place causes no failure elsewhere,
   * so this test reads all three and requires one date. A date that the test cannot find
   * also fails it.
   */
  it('MeasuredPremisesToleration_ThreeCallSites_CarryOneDate', () => {
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
