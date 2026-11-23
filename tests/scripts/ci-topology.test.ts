/**
 * Conformance tests for the CI topology in `.github/workflows/ci.yml`. They parse
 * the workflow with `js-yaml`.
 *
 *   1. Hosts. The `ci-gate` dependencies must run the `core` and `unit` projects.
 *      No gated job carries a path filter. The workflow runs only on a push to main and on dispatch.
 *   2. Completeness. Each top-level job is in `ci-gate.needs` or in the non-blocking allowlist.
 *   3. Execution policy. `ci-gate` is an inline verdict that fails unless every needed job succeeded.
 *
 * The workflow uses no action from `lvlup-sw/.github`. That repository is private, and a public
 * repository cannot resolve its actions. Pull request validation runs on Buildkite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { pathFilterKeys } from '../../tools/audit/gates/guard-inventory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
/** The nightly workflow that runs the `core` project on Windows. */
const WINDOWS_NIGHTLY_PATH = join(REPO_ROOT, '.github', 'workflows', 'windows-nightly.yml');
/** The condition of the Windows `core` job in `ci.yml`: every non-PR event, and a PR with the `ci:windows` label. */
const WINDOWS_CORE_IF =
  "github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'ci:windows')";
const FIXTURES_DIR = join(__dirname, '__fixtures__', 'ci-topology');

/** The aggregator job. The completeness scan skips it, because it cannot be in its own `needs:` list. */
const AGGREGATOR_JOB = 'ci-gate';
/** The prefix of an action in the private org repository. A public repository cannot resolve it. */
const PRIVATE_ORG_ACTION_PREFIX = 'lvlup-sw/.github/';
/** The jobs that `ci-gate` needs. */
const GATED_JOBS = ['test-root', 'test-mcp', 'test-windows-root', 'grep-gates', 'outcome-tests', 'e2e-process', 'testgen'];

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  /** A literal boolean, or a GitHub expression string such as `${{ true }}`. */
  readonly 'continue-on-error'?: boolean | string;
  readonly env?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly 'runs-on'?: string;
  readonly steps?: readonly WorkflowStep[];
  readonly outputs?: Record<string, string>;
}

interface Workflow {
  readonly on?: Record<string, unknown>;
  readonly jobs: Record<string, WorkflowJob>;
}

interface AllowlistEntry {
  rationale: string;
  issue?: string;
}

/**
 * The top-level jobs that can stay outside `ci-gate.needs`, each with its reason.
 * The list is in this test file and not in a separate config. The diff that adds
 * such a job then also shows the allowlist edit.
 * `docs/guides/ci-gate-hosting.md` states the contract for an entry.
 */
const NON_BLOCKING_ALLOWLIST: Record<string, AllowlistEntry> = {
  'startup-budget': {
    rationale:
      'Wall-clock cold-start budgets of the compiled binary. Soaking: no measured failure rate yet against the 2% blocking threshold. Runs on non-PR events only.',
  },
  'binary-matrix': {
    rationale:
      'Release-lane compile evidence, not a per-PR gate (standing reason the --minify A/B was dropped). Runs on non-PR events only.',
    issue: '#1703',
  },
  'test-windows': {
    rationale:
      'The Windows core suite takes about 15 minutes. It runs on pushes to main, on dispatch, on a PR with the ci:windows label, and each night in windows-nightly.yml.',
  },
};

function loadWorkflow(filePath: string): Workflow {
  const raw = readFileSync(filePath, 'utf8');
  const doc = yaml.load(raw) as Workflow;
  if (!doc || typeof doc !== 'object' || !doc.jobs) {
    throw new Error(`${filePath}: parsed workflow has no top-level "jobs" map`);
  }
  return doc;
}

/**
 * Returns the `needs` of a job as an array. The check is `typeof === 'string'`,
 * because `Array.isArray` does not narrow a `string | readonly string[]` union.
 */
function needsList(job: WorkflowJob | undefined): string[] {
  if (!job || !job.needs) return [];
  return typeof job.needs === 'string' ? [job.needs] : [...job.needs];
}

interface CheckResult {
  pass: boolean;
  violations: string[];
}

/** Lists each job that is not the aggregator, not in `ci-gate.needs` and not in the allowlist. */
function checkCompleteness(workflow: Workflow): CheckResult {
  const gate = workflow.jobs[AGGREGATOR_JOB];
  const needs = new Set(needsList(gate));
  const violations: string[] = [];
  for (const jobName of Object.keys(workflow.jobs)) {
    if (jobName === AGGREGATOR_JOB) continue;
    if (needs.has(jobName)) continue;
    if (NON_BLOCKING_ALLOWLIST[jobName]) continue;
    violations.push(jobName);
  }
  return { pass: violations.length === 0, violations };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches `npm run <script>` at the start of a run step. A suffixed name or an echo does not match. */
function npmRunInvocation(scriptName: string): RegExp {
  return new RegExp(`^npm run ${escapeRegExp(scriptName)}(?:\\s|$)`);
}

/**
 * Returns whether `cmd` is a vitest invocation that selects exactly `project`.
 * The option must be an argument of vitest itself. `echo --project unit` runs
 * nothing, and `vitest && echo --project unit` gives the option to a later command.
 * `--project core-extra` does not count for `core`. The pattern ends at white
 * space or at the end of the text, because `\b` also matches before a hyphen.
 *
 * Only the first shell command belongs to vitest. The function cuts at `;`, `|`,
 * `&` and a newline before it matches, so `\s+` cannot span a newline.
 */
function isVitestProjectCommand(cmd: string, project: string): boolean {
  const head = cmd.trim().split(/[;|&\r\n]/, 1)[0] ?? '';
  const invocation = /^(?:npx\s+)?vitest(?:\s+|$)/.exec(head);
  if (invocation === null) return false;
  const args = head.slice(invocation[0].length);
  return new RegExp(`(?:^|\\s)--project ${escapeRegExp(project)}(?:\\s|$)`).test(args);
}

/** Returns whether `cmd` runs the `core` vitest project. */
function isCoreProjectCommand(cmd: string): boolean {
  return isVitestProjectCommand(cmd, 'core');
}

/**
 * A step is a required host only when `continue-on-error` is absent or a literal
 * `false`. An expression string such as `${{ true }}` stays a string after the
 * YAML parse, and counts as soft-fail.
 */
function isRequiredHostStep(step: WorkflowStep): boolean {
  const softFail = step['continue-on-error'];
  return softFail === undefined || softFail === false;
}

/** Returns whether a step in `job` runs `npm run <script>`. */
function jobRunsNpmScript(job: WorkflowJob | undefined, scriptName: string): boolean {
  const steps = job?.steps ?? [];
  const re = npmRunInvocation(scriptName);
  return steps.some((s) => typeof s.run === 'string' && re.test(s.run.trim()));
}

/**
 * Returns whether a required step in `job` runs `npm run <script>`, with optional
 * trailing arguments. An echo of the script name does not count.
 */
function jobRunsCoreProjectScript(job: WorkflowJob | undefined, scriptName: string): boolean {
  const steps = job?.steps ?? [];
  const re = npmRunInvocation(scriptName);
  return steps.some(
    (s) => typeof s.run === 'string' && re.test(s.run.trim()) && isRequiredHostStep(s),
  );
}

/**
 * Returns whether `scripts[name]` runs `--project unit`, directly or through one
 * hop of `npm run <alias>`. `test:run` is `npm run test:unit`, and CI calls the alias.
 * The tree has one hop. A deeper chain is a new shape to pin, so the function rejects it.
 */
function isUnitProjectScript(scripts: Record<string, string>, name: string, hops = 0): boolean {
  const cmd = scripts[name];
  if (cmd === undefined) return false;
  if (isVitestProjectCommand(cmd, 'unit')) return true;
  const alias = /^npm run (\S+)\s*$/.exec(cmd.trim());
  return alias !== null && hops < 1 && isUnitProjectScript(scripts, alias[1] ?? '', hops + 1);
}

describe('CI path-filter & guard coverage (DR-22)', () => {
  /** The workflow runs only on a push to main and on dispatch. A gated job that skips reads as passed. */
  it('GatedJobs_RunUnfiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    for (const jobName of GATED_JOBS) {
      const job = workflow.jobs[jobName];
      expect(job, `${jobName} missing`).toBeDefined();
      expect(pathFilterKeys(job), `${jobName} carries a path filter`).toEqual([]);
      expect(String(job?.if ?? '').trim(), `${jobName} condition`).toBe('${{ !cancelled() }}');
    }
  });

  /**
   * The `core` vitest project collects `auditLayerBoundaries`. Linux hosts that
   * project as `test:coverage`, on a job that `ci-gate` needs. Windows hosts it as
   * `test:core`, on a `ci.yml` job that runs on every push to main, and in the nightly workflow.
   *
   * The decoys prove the matchers. An echo of the script name, a soft-fail step
   * and a suffixed script name are not hosts. An expression in `continue-on-error`
   * stays a string after the YAML parse, so that step is soft-fail too.
   */
  it('LayerCensus_HostScripts_AreRunStepsOnBothPlatforms', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const coreScripts = Object.entries(pkg.scripts ?? {})
      .filter(([, cmd]) => typeof cmd === 'string' && isCoreProjectCommand(cmd))
      .map(([name]) => name);
    expect(coreScripts, 'package.json declares no --project core script').not.toEqual([]);

    const needs = new Set(needsList(workflow.jobs[AGGREGATOR_JOB]));
    const hosts = Object.entries(workflow.jobs).filter(
      ([name, job]) => needs.has(name) && coreScripts.some((s) => jobRunsCoreProjectScript(job, s)),
    );
    expect(
      hosts.map(([name]) => name),
      'no ci-gate dependency runs a script whose expansion is --project core',
    ).not.toEqual([]);

    const runners = hosts.map(([, job]) => job['runs-on']);
    expect(runners, 'Linux does not host the layer census').toContain('ubuntu-latest');

    const windowsHosts = Object.values(workflow.jobs).filter(
      (job) => job['runs-on'] === 'windows-latest' && coreScripts.some((s) => jobRunsCoreProjectScript(job, s)),
    );
    expect(windowsHosts, 'Windows does not host the layer census in ci.yml').not.toEqual([]);
    expect(
      windowsHosts.some((job) => job.needs === undefined && String(job.if ?? '').trim() === WINDOWS_CORE_IF),
      'the Windows layer census must run on every push to main',
    ).toBe(true);

    const nightly = loadWorkflow(WINDOWS_NIGHTLY_PATH);
    expect(nightly.on?.schedule, 'windows-nightly.yml has no schedule').toBeDefined();
    const nightlyHosts = Object.values(nightly.jobs).filter(
      (job) => job['runs-on'] === 'windows-latest' && coreScripts.some((s) => jobRunsCoreProjectScript(job, s)),
    );
    expect(nightlyHosts, 'windows-nightly.yml does not host the layer census').not.toEqual([]);

    const decoy: WorkflowJob = {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo "npm run test:coverage"' }],
    };
    expect(jobRunsCoreProjectScript(decoy, 'test:coverage')).toBe(false);

    const soft: WorkflowJob = {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'npm run test:coverage', 'continue-on-error': true }],
    };
    expect(jobRunsCoreProjectScript(soft, 'test:coverage')).toBe(false);

    const prefixed: WorkflowJob = {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'npm run test:coverage-extra' }],
    };
    expect(jobRunsCoreProjectScript(prefixed, 'test:coverage')).toBe(false);
    expect(jobRunsNpmScript(prefixed, 'test:coverage')).toBe(false);

    const expressionSoft: WorkflowJob = {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'npm run test:coverage', 'continue-on-error': '${{ true }}' }],
    };
    expect(jobRunsCoreProjectScript(expressionSoft, 'test:coverage')).toBe(false);

    const literalFalse: WorkflowJob = {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'npm run test:coverage', 'continue-on-error': false }],
    };
    expect(jobRunsCoreProjectScript(literalFalse, 'test:coverage')).toBe(true);

    expect(isCoreProjectCommand('vitest --project core')).toBe(true);
    expect(isCoreProjectCommand('vitest --project core --run')).toBe(true);
    expect(isCoreProjectCommand('vitest --project core-extra')).toBe(false);
    expect(isCoreProjectCommand('npx vitest run --project core')).toBe(true);
    expect(isCoreProjectCommand('echo --project core')).toBe(false);
    expect(isCoreProjectCommand("echo 'vitest run --project core'")).toBe(false);
    expect(isCoreProjectCommand('vitest && echo --project core')).toBe(false);
    expect(isCoreProjectCommand('vitest --project unit && echo --project core')).toBe(false);
    expect(isCoreProjectCommand('vitest --project core && echo done')).toBe(true);
    expect(isCoreProjectCommand('vitest & echo --project core')).toBe(false);
    expect(isCoreProjectCommand('vitest\necho --project core')).toBe(false);
  });

  /**
   * The `unit` vitest project collects the architecture oracles. CI hosts it as
   * `npm run test:run`, an alias of `test:unit`. Without this pin, a workflow edit
   * can drop the step and leave those oracles uncollected while each job stays green.
   * The test resolves the alias through `package.json` and does not match it by name.
   */
  it('LayerCensus_UnitProjectHostScripts_AreRunStepsOnBothPlatforms', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const pkg: { scripts?: Record<string, string> } = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const scripts = pkg.scripts ?? {};
    const unitScripts = Object.keys(scripts).filter((name) => isUnitProjectScript(scripts, name));
    expect(unitScripts, 'package.json declares no script expanding to --project unit').not.toEqual(
      [],
    );

    const needs = new Set(needsList(workflow.jobs[AGGREGATOR_JOB]));
    const hosts = Object.entries(workflow.jobs).filter(
      ([name, job]) => needs.has(name) && unitScripts.some((s) => jobRunsCoreProjectScript(job, s)),
    );
    expect(
      hosts.map(([name]) => name),
      'no ci-gate dependency runs a script whose expansion is --project unit',
    ).not.toEqual([]);

    const runners = hosts.map(([, job]) => job['runs-on']);
    expect(runners, 'Linux does not host the unit project').toContain('ubuntu-latest');
    expect(runners, 'Windows does not host the unit project').toContain('windows-latest');
  });

  it('IsUnitProjectScript_ResolvesOneAliasHopAndNoMore', () => {
    const scripts: Record<string, string> = {
      'test:unit': 'vitest run --project unit',
      'test:run': 'npm run test:unit',
      'test:deep': 'npm run test:run',
      'test:unit-extra': 'vitest run --project unit-extra',
      'test:echo': "echo 'npm run test:unit'",
      'test:option-echo': 'echo --project unit',
      'test:npx': 'npx vitest run --project unit',
      'test:chained': 'vitest run && echo --project unit',
    };
    expect(isUnitProjectScript(scripts, 'test:unit')).toBe(true);
    expect(isUnitProjectScript(scripts, 'test:run')).toBe(true);
    expect(isUnitProjectScript(scripts, 'test:deep'), 'two hops is a new shape').toBe(false);
    expect(isUnitProjectScript(scripts, 'test:unit-extra')).toBe(false);
    expect(isUnitProjectScript(scripts, 'test:echo')).toBe(false);
    expect(isUnitProjectScript(scripts, 'test:option-echo'), 'the option alone runs nothing').toBe(
      false,
    );
    expect(isUnitProjectScript(scripts, 'test:npx')).toBe(true);
    expect(isUnitProjectScript(scripts, 'test:chained'), 'a later command is not vitest').toBe(
      false,
    );
    expect(isUnitProjectScript(scripts, 'test:absent')).toBe(false);
  });

  /** `hooks:guard` is an alias of `render:guard`. A CI job must run `npm run render:guard`, with no path filter. */
  it('Guards_HooksGuardRunsInCI_AndIsUnfiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const jobNamesWithHooksGuard = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunsNpmScript(job, 'render:guard'))
      .map(([name]) => name);
    expect(jobNamesWithHooksGuard.length, 'no CI job runs "npm run render:guard"').toBeGreaterThan(
      0,
    );

    for (const jobName of jobNamesWithHooksGuard) {
      expect(pathFilterKeys(workflow.jobs[jobName]), `job "${jobName}" running render:guard is filtered`).toEqual([]);
    }
  });

  /** `skills:guard` is an alias of `render:guard`, so this test makes the same two checks as the test above. */
  it('Guards_SkillsGuardCoversCommandAliasesAndAgents_RunsInCI_AndIsUnfiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const jobNamesWithSkillsGuard = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunsNpmScript(job, 'render:guard'))
      .map(([name]) => name);
    expect(
      jobNamesWithSkillsGuard.length,
      'no CI job runs "npm run render:guard"',
    ).toBeGreaterThan(0);

    for (const jobName of jobNamesWithSkillsGuard) {
      expect(pathFilterKeys(workflow.jobs[jobName]), `job "${jobName}" running skills:guard is filtered`).toEqual([]);
    }
  });
});

describe('CI-topology conformance (DR-2)', () => {
  it('Topology_CurrentWorkflow_Passes', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);

    const completeness = checkCompleteness(workflow);
    expect(completeness.violations, 'completeness violations').toEqual([]);
    expect(completeness.pass).toBe(true);
  });

  it('Topology_UnlistedJobOutsideAllowlist_Fails', () => {
    const workflow = loadWorkflow(join(FIXTURES_DIR, 'unlisted-job.yml'));
    const result = checkCompleteness(workflow);
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('orphan-job');
  });
});

describe('CI-gate execution policy (DR-10)', () => {
  /** The verdict is inline, so it needs no org action. It fails unless every needed job succeeded. */
  it('Aggregator_IsAnInlineAllSuccessVerdict', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const gate = workflow.jobs[AGGREGATOR_JOB];
    expect(gate, 'ci-gate job missing').toBeDefined();
    expect(String(gate?.if ?? '').trim()).toMatch(/^(?:\$\{\{\s*)?!cancelled\(\)(?:\s*\}\})?$/);
    const steps = gate?.steps ?? [];
    expect(steps.some((step) => typeof step.uses === 'string'), 'ci-gate runs an action').toBe(false);
    const verdict = steps.find((step) => typeof step.run === 'string' && step.run.includes('"success"'));
    expect(verdict, 'ci-gate has no all-success verdict step').toBeDefined();
    expect(String(verdict?.env?.['NEEDS'] ?? '').trim()).toBe('${{ toJSON(needs) }}');
    expect(verdict?.['continue-on-error']).toBeUndefined();
  });

  it('Aggregator_NeedsTheGatedJobs', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    expect([...needsList(workflow.jobs[AGGREGATOR_JOB])].sort()).toEqual([...GATED_JOBS].sort());
  });

  /** A public repository cannot resolve an action from the private org repository, so such a job fails before its first step. */
  it('Workflow_UsesNoActionFromThePrivateOrgRepository', () => {
    const privateActions = (workflow: Workflow): string[] =>
      Object.entries(workflow.jobs).flatMap(([name, job]) =>
        (job.steps ?? [])
          .filter((step) => typeof step.uses === 'string' && step.uses.startsWith(PRIVATE_ORG_ACTION_PREFIX))
          .map((step) => `${name}: ${step.uses}`),
      );
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    expect(privateActions(workflow)).toEqual([]);
    const seeded: Workflow = {
      ...workflow,
      jobs: { ...workflow.jobs, seeded: { steps: [{ uses: `${PRIVATE_ORG_ACTION_PREFIX}actions/ci-lanes@v1` }] } },
    };
    expect(privateActions(seeded)).toEqual([`seeded: ${PRIVATE_ORG_ACTION_PREFIX}actions/ci-lanes@v1`]);
  });

  /** A narrowing lane key on `grep-gates` must show in its keys, so the host of the enforcement gates cannot skip unseen. */
  it('Aggregator_LaneGainsANarrowingFilter_IsDetected', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const grepGates = workflow.jobs['grep-gates'];
    expect(grepGates, 'grep-gates lane not found').toBeDefined();
    expect(pathFilterKeys(grepGates), 'grep-gates already has a narrowing path filter').toEqual([]);

    const withFilter: Workflow = {
      ...workflow,
      jobs: {
        ...workflow.jobs,
        'grep-gates': {
          ...grepGates,
          if: `${grepGates?.if ?? ''} && fromJSON(needs.plan.outputs.lanes).root != 'false'`,
        },
      },
    };

    expect(pathFilterKeys(withFilter.jobs['grep-gates'])).toContain('root');
  });
});
