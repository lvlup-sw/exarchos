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
// @ts-expect-error — no .d.ts for this .mjs runner; contract is asserted here.
import {
  parseManifest,
  renderCommand,
  runAllSteps,
  summarize,
  renderSummary,
  DEFAULT_MANIFEST_PATH,
} from './run-validate.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const RUNNER = path.join(SCRIPTS_DIR, 'run-validate.mjs');

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
  failed: number;
  violations: string[];
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
    expect(outcomes[0].executed).toBe(false);
    expect(outcomes[0].error).toContain('spawn exploded');
    expect(outcomes[1].passed).toBe(true);
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
});
