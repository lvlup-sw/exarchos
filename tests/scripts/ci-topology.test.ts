/**
 * Conformance tests for the CI topology in `.github/workflows/ci.yml`. They parse
 * the workflow with `js-yaml`.
 *
 *   1. Path filters and hosts. The lane globs in `.github/ci-lanes.toml` must cover
 *      the projection roots, and `ci-gate` dependencies must run the `core` and
 *      `unit` projects.
 *   2. Completeness. Each top-level job is in `ci-gate.needs` or in the
 *      non-blocking allowlist. A job outside `ci-gate.needs` can never fail a PR.
 *   3. Execution policy. `ci-gate` is the verdict job of the org `ci-lanes` action.
 *      The manifest and the `if:` text of each job hold the skip licences.
 *
 * The `check` mode of the action proves on each PR that the manifest and the
 * workflow agree, so these tests pin only the wiring.
 * The guard inventory supplies the glob and lane readers, so both read the same way.
 * The `grep-gates` job is on lane `always`, so a PR outside lane `root` still runs this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { globMatches, pathFilterGlobs, pathFilterKeys } from '../../tools/audit/gates/guard-inventory.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const FIXTURES_DIR = join(__dirname, '__fixtures__', 'ci-topology');

/** The aggregator job. The completeness scan skips it, because it cannot be in its own `needs:` list. */
const AGGREGATOR_JOB = 'ci-gate';
/** The job that computes the lanes. Each targeted job needs it. */
const PLANNER_JOB = 'plan';
/** The org action that plans the lanes, gives the verdict and checks the manifest. */
const CI_LANES_ACTION = 'lvlup-sw/.github/actions/ci-lanes@v1';

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
  'e2e-process': {
    rationale:
      'Measured 3.33% failure-when-executed over last 60 completed ci.yml runs (> 2% blocking threshold); known SQLITE_BUSY flake cluster.',
    issue: '#1718',
  },
  'binary-matrix': {
    rationale:
      'Release-lane compile evidence, not a per-PR gate (standing reason the --minify A/B was dropped).',
    issue: '#1703',
  },
  'lanes-check': {
    rationale:
      'Org ci-lanes contract check (mode: check). Failure fails the workflow run; it is not part of the required CI Gate aggregator because the gate may only cover jobs that need the planner.',
    issue: '#1921',
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

/**
 * The globs that lane `root` must hold. Without one of them, a PR that changes
 * only that path does not set lane `root`. Then `test-root` and the drift guards
 * that it hosts do not run.
 */
const REQUIRED_ROOT_PROJECTION_GLOBS = [
  /** The generated tree that holds the agents, command aliases, commands, rules and skills. */
  'rendered/**',
  'hooks/**',
  '.claude-plugin/**',
  'AGENTS.md',
  /** The agent generator sources. The drift guard must run on the PR that changes a generator. */
  'src/runtime/agents/**',
  /** `tests/scripts/release-workflow.test.ts`, in the root suite, parses this workflow. */
  '.github/workflows/release.yml',
  /**
   * This file and the next three entries are registers that the architecture
   * liveness tests read. A PR that changes only one of them must still set `root`.
   */
  '.github/CODEOWNERS',
  'knip.json',
  '.exarchos/**',
  'manifest.json',
] as const;

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

/**
 * Returns whether the job checks out the repository before it runs the verdict
 * step of the `ci-lanes` action. The verdict reads the manifest from the checkout.
 */
function verdictFollowsCheckout(job: WorkflowJob | undefined): boolean {
  const steps = job?.steps ?? [];
  const verdict = steps.findIndex((s) => s.uses === CI_LANES_ACTION && s.with?.mode === 'verdict');
  const checkout = steps.findIndex(
    (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'),
  );
  return checkout >= 0 && verdict > checkout;
}

describe('CI path-filter & guard coverage (DR-22)', () => {
  it('Filters_RootFilter_IncludesProjectionRootGlobs', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const filters = pathFilterGlobs(workflow);
    const rootGlobs = filters.root ?? [];

    const missing = REQUIRED_ROOT_PROJECTION_GLOBS.filter((glob) => !rootGlobs.includes(glob));
    expect(missing, `lane root missing required glob(s): ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * Membership is not protection. After a directory rename, a glob stays in the
   * filter and selects nothing. The gated job then does not run on the PRs that it polices.
   * A skipped required job reads as passed.
   * A negation selects by exclusion and can match nothing, so the test skips each
   * glob that starts with `!`.
   */
  it('Filters_EveryGlob_MatchesAtLeastOneTrackedFile', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const filters = pathFilterGlobs(workflow);
    const tracked = (await execFileAsync('git', ['ls-files'], { cwd: REPO_ROOT }))
      .split('\n')
      .filter(Boolean);

    const dead: string[] = [];
    let checked = 0;
    for (const [name, globs] of Object.entries(filters)) {
      for (const glob of globs) {
        if (glob.startsWith('!')) continue;
        checked += 1;
        if (!tracked.some((f) => globMatches(glob, f))) dead.push(`${name}: ${glob}`);
      }
    }

    expect(checked, 'no path-filter globs were examined').toBeGreaterThan(0);
    expect(dead, 'path-filter globs matching no tracked file').toEqual([]);
  });

  /**
   * The `core` vitest project collects `auditLayerBoundaries`. Linux hosts that
   * project as `test:coverage`, and Windows hosts it as `test:core`. Each platform
   * must keep a required `run:` step for `--project core`, on a job that `ci-gate` needs.
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
    expect(runners, 'Windows does not host the layer census').toContain('windows-latest');

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

  /**
   * `hooks:guard` is an alias of `render:guard`. A CI job must run
   * `npm run render:guard`, and each such job must gate on lane `root`. Lane `root`
   * holds the projection roots, so the guard then runs on a PR that changes one of them.
   */
  it('Guards_HooksGuardRunsInCI_AndIsRootFiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const jobNamesWithHooksGuard = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunsNpmScript(job, 'render:guard'))
      .map(([name]) => name);
    expect(jobNamesWithHooksGuard.length, 'no CI job runs "npm run render:guard"').toBeGreaterThan(
      0,
    );

    for (const jobName of jobNamesWithHooksGuard) {
      const keys = pathFilterKeys(workflow.jobs[jobName]);
      expect(keys, `job "${jobName}" running render:guard is not gated on any changes.outputs key`).toContain(
        'root',
      );
    }
  });

  /** `skills:guard` is an alias of `render:guard`, so this test makes the same two checks as the test above. */
  it('Guards_SkillsGuardCoversCommandAliasesAndAgents_RunsInCI_AndIsRootFiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const jobNamesWithSkillsGuard = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunsNpmScript(job, 'render:guard'))
      .map(([name]) => name);
    expect(
      jobNamesWithSkillsGuard.length,
      'no CI job runs "npm run render:guard"',
    ).toBeGreaterThan(0);

    for (const jobName of jobNamesWithSkillsGuard) {
      const keys = pathFilterKeys(workflow.jobs[jobName]);
      expect(
        keys,
        `job "${jobName}" running skills:guard is not gated on any changes.outputs key`,
      ).toContain('root');
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
  it('Aggregator_IsTheOrgCiLanesVerdict', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const gate = workflow.jobs[AGGREGATOR_JOB];
    expect(gate, 'ci-gate job missing').toBeDefined();
    expect(String(gate?.if ?? '').trim()).toMatch(/^(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?$/);

    const step = (gate?.steps ?? []).find(
      (s) => typeof s.uses === 'string' && s.uses === CI_LANES_ACTION,
    );
    expect(step, 'ci-gate must run ci-lanes@v1').toBeDefined();
    expect(step?.with?.mode).toBe('verdict');
    expect(step?.with?.gate).toBe(AGGREGATOR_JOB);
    expect(String(step?.with?.needs ?? '').trim()).toBe('${{ toJSON(needs) }}');
    expect(step?.['continue-on-error']).toBeUndefined();
  });

  /**
   * The verdict reads the manifest from the checkout. Without a checkout before it,
   * the action cannot read the manifest and the required check fails on each PR.
   * The `check` mode of the action does not test this, so the decoys prove the matcher.
   */
  it('Aggregator_ChecksOutTheRepositoryBeforeTheVerdict', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    expect(
      verdictFollowsCheckout(workflow.jobs[AGGREGATOR_JOB]),
      'ci-gate must check out the repository before the verdict step',
    ).toBe(true);

    const verdictStep: WorkflowStep = {
      uses: CI_LANES_ACTION,
      with: { mode: 'verdict', gate: AGGREGATOR_JOB },
    };
    const checkoutStep: WorkflowStep = { uses: 'actions/checkout@v4' };
    expect(verdictFollowsCheckout({ steps: [verdictStep] })).toBe(false);
    expect(verdictFollowsCheckout({ steps: [verdictStep, checkoutStep] })).toBe(false);
    expect(verdictFollowsCheckout({ steps: [checkoutStep, verdictStep] })).toBe(true);
  });

  it('Aggregator_NeedsPlannerPlusMappedJobs', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const needs = needsList(workflow.jobs[AGGREGATOR_JOB]);
    expect(needs).toEqual(
      expect.arrayContaining([
        PLANNER_JOB,
        'test-root',
        'test-mcp',
        'test-windows',
        'test-windows-root',
        'validate-no-legacy',
        'manifest-gate',
        'grep-gates',
        'outcome-tests',
      ]),
    );
    expect(needs).toHaveLength(9);
  });

  it('Planner_IsUnconditionalFullHistoryPlan', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const plan = workflow.jobs[PLANNER_JOB];
    expect(plan, 'planner job missing').toBeDefined();
    expect(plan?.if, 'planner must not be conditional').toBeUndefined();
    const checkout = (plan?.steps ?? []).find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'),
    );
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    const lanes = plan?.outputs?.lanes;
    expect(String(lanes ?? '').trim()).toBe('${{ steps.plan.outputs.lanes }}');
  });

  it('TargetedJobs_CarryTheCanonicalSkip', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const expected = (lane: string): string =>
      `\${{ always() && (needs.${PLANNER_JOB}.result != 'success' || fromJSON(needs.${PLANNER_JOB}.outputs.lanes).${lane} != 'false') }}`;
    const mapped: Record<string, string> = {
      'test-root': 'root',
      'test-windows-root': 'root',
      'test-mcp': 'mcp',
      'test-windows': 'mcp',
      'validate-no-legacy': 'always',
      'manifest-gate': 'always',
      'grep-gates': 'always',
      'outcome-tests': 'always',
    };
    for (const [jobName, lane] of Object.entries(mapped)) {
      const job = workflow.jobs[jobName];
      expect(needsList(job), `${jobName} must need ${PLANNER_JOB}`).toContain(PLANNER_JOB);
      expect(String(job?.if ?? '').trim(), `${jobName} skip expression`).toBe(expected(lane));
    }
  });

  /**
   * `grep-gates` is on lane `always`, which `pathFilterKeys` reads as unfiltered.
   * A narrowing `root` key on that job must show in its keys. Without that, the host
   * of the enforcement gates can skip on the PRs that it polices, and the skip reads as passed.
   */
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
