/**
 * Conformance tests for the CI topology in `.github/workflows/ci.yml`. They parse
 * the workflow with `js-yaml`.
 *
 *   1. Path filters and hosts. The `changes` filters must cover the projection
 *      roots, and `ci-gate` dependencies must run the `core` and `unit` projects.
 *   2. Completeness. Each top-level job is in `ci-gate.needs` or in the
 *      non-blocking allowlist. A job outside `ci-gate.needs` can never fail a PR.
 *   3. Execution policy. The tests run the `Evaluate results` script of the
 *      aggregator verbatim on synthetic `needs` contexts and check its exit status.
 *
 * Execution replaces text matching on the script. A script that lost a guard
 * exits 0 on a context that it must reject. A comment or an `echo` cannot stand
 * in for the guard.
 * `globMatches` comes from the guard inventory, so both read the workflow globs
 * the same way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { globMatches } from '../../tools/audit/gates/guard-inventory.js';
import { execFileAsync, spawnAsync } from '../../tools/test-helpers/spawn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const FIXTURES_DIR = join(__dirname, '__fixtures__', 'ci-topology');

/** The aggregator job. The completeness scan skips it, because it cannot be in its own `needs:` list. */
const AGGREGATOR_JOB = 'ci-gate';

/** The aggregator step whose script the tests run. */
const EVALUATE_STEP_NAME = 'Evaluate results';

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

/**
 * Returns the evaluate step of the aggregator, with its script and its `env:` block.
 * Without a step of that name, it returns the first step that has a `run` script.
 */
function evaluateStep(workflow: Workflow): WorkflowStep {
  const gate = workflow.jobs[AGGREGATOR_JOB];
  if (!gate) {
    throw new Error(`aggregator job "${AGGREGATOR_JOB}" not found in workflow`);
  }
  const steps = gate.steps ?? [];
  const step =
    steps.find((s) => s.name === EVALUATE_STEP_NAME && typeof s.run === 'string') ??
    steps.find((s) => typeof s.run === 'string');
  if (!step?.run) {
    throw new Error(`aggregator job "${AGGREGATOR_JOB}" has no step with a "run" script`);
  }
  return step;
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
 * Returns the `changes` output keys that gate a job. It reads each
 * `needs.changes.outputs.<key>` in the raw `if:` text, and uses no hardcoded
 * table of jobs and keys.
 */
function pathFilterKeys(job: WorkflowJob | undefined): string[] {
  const ifText = job?.if ?? '';
  const pattern = /needs\.changes\.outputs\.([A-Za-z0-9_-]+)/g;
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ifText)) !== null) {
    keys.add(match[1] as string);
  }
  return [...keys];
}

/**
 * Parses the `LICENSED_SKIPS` declaration of the aggregator into a map from lane
 * to `changes` output key. The `lane=key` entries name the only lanes that can
 * report `skipped`. Each other lane is strict: a skip is a failure.
 */
function declaredLicensedSkips(step: WorkflowStep): Map<string, string> {
  const raw = step.env?.LICENSED_SKIPS;
  const map = new Map<string, string>();
  if (typeof raw !== 'string') return map;
  for (const line of raw.split('\n')) {
    const entry = line.replace(/#.*$/, '').replace(/\s+/g, '');
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return map;
}

/**
 * Derives the same map from the `if:` expression of each lane. A lane that gates
 * on `needs.changes.outputs.<key>` can skip when that key is not 'true'. A lane
 * with no gate cannot skip.
 * `multiKeyLanes` collects each lane that gates on more than one key. The
 * `lane=key` format cannot express such a lane, so the conformance test fails.
 */
function derivedLicensedSkips(workflow: Workflow): {
  map: Map<string, string>;
  multiKeyLanes: string[];
} {
  const map = new Map<string, string>();
  const multiKeyLanes: string[] = [];
  for (const lane of needsList(workflow.jobs[AGGREGATOR_JOB])) {
    if (lane === AGGREGATOR_JOB) continue;
    const keys = pathFilterKeys(workflow.jobs[lane]);
    if (keys.length === 0) continue;
    if (keys.length > 1) {
      multiKeyLanes.push(`${lane} (keys: ${keys.join(', ')})`);
      continue;
    }
    map.set(lane, keys[0] as string);
  }
  return { map, multiKeyLanes };
}

/**
 * Returns whether the declared map equals the derived map. The declaration is
 * data and can drift from the path filters, so the `if:` text stays the source.
 * The live check and the path-filter kill test both call this one comparison.
 */
function licensedSkipsMatchPathFilters(workflow: Workflow, step: WorkflowStep): boolean {
  const { map: derived, multiKeyLanes } = derivedLicensedSkips(workflow);
  if (multiKeyLanes.length > 0) return false;
  const flatten = (m: Map<string, string>): string =>
    [...m.entries()]
      .map(([lane, key]) => `${lane}=${key}`)
      .sort()
      .join('|');
  return flatten(declaredLicensedSkips(step)) === flatten(derived);
}

/** A synthetic `needs` context, in the shape that `toJSON(needs)` gives the aggregator. */
type NeedsContext = Record<string, { result: string; outputs?: Record<string, string> }>;

/** Returns each `changes` output key that a lane gates on, set to 'true', as for a PR that touches each area. */
function changesOutputsAllTrue(workflow: Workflow): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const lane of needsList(workflow.jobs[AGGREGATOR_JOB])) {
    for (const key of pathFilterKeys(workflow.jobs[lane])) outputs[key] = 'true';
  }
  return outputs;
}

/**
 * Builds a green `needs` context and then applies the overrides. In a green
 * context each lane is `success` and each gated `changes` output is 'true'.
 * The lanes come from the `needs:` list of the workflow, so the cases pin no
 * copy of the lane names.
 */
function synthesizeNeeds(
  workflow: Workflow,
  overrides: {
    results?: Record<string, string>;
    changesOutputs?: Record<string, string>;
    /** The keys to remove from `changes.outputs`, as a rename or a deletion upstream does. */
    dropChangesOutputs?: readonly string[];
    extraLanes?: Record<string, string>;
  } = {},
): NeedsContext {
  const context: NeedsContext = {};
  for (const lane of needsList(workflow.jobs[AGGREGATOR_JOB])) {
    context[lane] = { result: 'success', outputs: {} };
  }
  const changes = context['changes'];
  if (changes) {
    changes.outputs = { ...changesOutputsAllTrue(workflow), ...(overrides.changesOutputs ?? {}) };
    for (const key of overrides.dropChangesOutputs ?? []) {
      delete changes.outputs[key];
    }
  }
  for (const [lane, result] of Object.entries(overrides.results ?? {})) {
    context[lane] = { ...(context[lane] ?? { outputs: {} }), result };
  }
  for (const [lane, result] of Object.entries(overrides.extraLanes ?? {})) {
    context[lane] = { result, outputs: {} };
  }
  return context;
}

interface AggregatorRun {
  status: number;
  output: string;
}

/**
 * Runs the shipped script of the aggregator verbatim on a synthetic `needs`
 * context. So the script must hold no `${{ }}` interpolation, and must take each
 * GitHub value through `env:`.
 */
async function runAggregator(
  workflow: Workflow,
  needs: NeedsContext | string,
  licensedSkipsOverride?: string,
): Promise<AggregatorRun> {
  const step = evaluateStep(workflow);
  const licensed = licensedSkipsOverride ?? String(step.env?.LICENSED_SKIPS ?? '');
  const result = await spawnAsync('bash', ['-c', step.run as string], {
    env: {
      ...process.env,
      NEEDS_JSON: typeof needs === 'string' ? needs : JSON.stringify(needs),
      LICENSED_SKIPS: licensed,
    },
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const PATHS_FILTER_JOB = 'changes';

/**
 * Returns the filters of the `dorny/paths-filter` step. `with.filters` is one
 * YAML block scalar, so the first `js-yaml` pass leaves it as a string. This
 * function parses that string as YAML, so the tests read the real glob arrays.
 */
function getPathsFilters(workflow: Workflow): Record<string, unknown> {
  const job = workflow.jobs[PATHS_FILTER_JOB];
  if (!job) {
    throw new Error(`"${PATHS_FILTER_JOB}" job not found in workflow`);
  }
  const steps = job.steps ?? [];
  const filterStep = steps.find(
    (s) => typeof s.uses === 'string' && s.uses.startsWith('dorny/paths-filter'),
  );
  if (!filterStep) {
    throw new Error(`"${PATHS_FILTER_JOB}" job has no "dorny/paths-filter" step`);
  }
  const filtersRaw = filterStep.with?.filters;
  if (typeof filtersRaw !== 'string') {
    throw new Error(
      `"${PATHS_FILTER_JOB}" job's paths-filter step has no string "with.filters"`,
    );
  }
  const parsed = yaml.load(filtersRaw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`"${PATHS_FILTER_JOB}" job's "with.filters" did not parse to an object`);
  }
  return parsed as Record<string, unknown>;
}

/** Returns the globs of one named filter, such as `root`. An absent or malformed filter gives `[]`. */
function filterGlobs(filters: Record<string, unknown>, filterName: string): string[] {
  const value = filters[filterName];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * The globs that the `root` path filter must hold. Without one of them, a PR
 * that changes only that path does not set `needs.changes.outputs.root` to
 * 'true'. Then `test-root` and the drift guards that it hosts do not run.
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
 * `--project core-extra` does not count for `core`, although `\b` matches before a hyphen.
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
  it('Filters_RootFilter_IncludesProjectionRootGlobs', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const filters = getPathsFilters(workflow);
    const rootGlobs = filterGlobs(filters, 'root');

    const missing = REQUIRED_ROOT_PROJECTION_GLOBS.filter((glob) => !rootGlobs.includes(glob));
    expect(missing, `changes.root filter missing required glob(s): ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * Membership is not protection. After a directory rename, a glob stays in the
   * filter and selects nothing, so the gated job stops on the PRs that it polices.
   * A skipped required job reads as passed.
   * A negation selects by exclusion and can match nothing, so the test skips each
   * glob that starts with `!`.
   */
  it('Filters_EveryGlob_MatchesAtLeastOneTrackedFile', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const filters = getPathsFilters(workflow);
    const tracked = (await execFileAsync('git', ['ls-files'], { cwd: REPO_ROOT }))
      .split('\n')
      .filter(Boolean);

    const dead: string[] = [];
    let checked = 0;
    for (const name of Object.keys(filters)) {
      for (const glob of filterGlobs(filters, name)) {
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
   * `npm run render:guard`, and each such job must gate on the `root` output of
   * `changes`. The `root` filter holds the projection roots, so the guard then
   * runs on a PR that changes one of them.
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

/**
 * The first tests are structural preconditions for the tests that run the script.
 * The script must run outside GitHub, its lane list must be the `needs` context
 * itself, and its skip licences must match the path filters.
 */
describe('CI-gate execution policy (DR-10)', () => {
  /**
   * GitHub substitutes a `${{ }}` in the script body before bash reads it. These
   * tests cannot run such a script, and the substitution is a shell-injection surface.
   */
  it('Aggregator_EvaluateScript_TakesEveryGitHubValueThroughEnv', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const step = evaluateStep(workflow);
    expect(
      (step.run as string).includes('${{'),
      'the evaluate script interpolates ${{ }}; move that value into the step\'s env: block so the script stays executable verbatim',
    ).toBe(false);
  });

  /**
   * With `toJSON(needs)`, a lane that joins `needs:` appears in the context with
   * no edit to the policy. So the policy cannot omit a lane.
   */
  it('Aggregator_LaneList_IsTheNeedsContextItself', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const step = evaluateStep(workflow);
    expect(String(step.env?.NEEDS_JSON ?? '').trim()).toBe('${{ toJSON(needs) }}');
  });

  /** The size check stops a vacuous pass when both maps are empty, as when each path filter is gone. */
  it('Aggregator_LicensedSkips_RestateThePathFiltersExactly', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const step = evaluateStep(workflow);
    const declared = declaredLicensedSkips(step);
    const { map: derived, multiKeyLanes } = derivedLicensedSkips(workflow);

    expect(
      multiKeyLanes,
      'lane(s) gate on multiple changes.outputs keys; the LICENSED_SKIPS "lane=key" format cannot express that',
    ).toEqual([]);

    expect(derived.size, 'no path-filtered lane found — the comparison below would be vacuous').toBeGreaterThan(0);

    const asSorted = (m: Map<string, string>): string[] =>
      [...m.entries()].map(([lane, key]) => `${lane}=${key}`).sort();
    expect(asSorted(declared), 'LICENSED_SKIPS does not match the lanes\' own if: expressions').toEqual(
      asSorted(derived),
    );
    expect(licensedSkipsMatchPathFilters(workflow, step)).toBe(true);
  });

  /**
   * A path filter on `grep-gates` makes the host lane of the enforcement gates
   * skippable. The derived map picks up the new filter, the declaration does not
   * restate it, and the conformance check fails until someone declares the licence.
   * `Aggregator_GrepGatesSkipped_Reddens` covers the skip at run time. This check fails earlier.
   */
  it('Aggregator_LaneGainsAPathFilterWithoutALicence_Reddens', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const step = evaluateStep(workflow);
    const grepGates = workflow.jobs['grep-gates'];
    expect(grepGates, 'grep-gates lane not found').toBeDefined();
    expect(pathFilterKeys(grepGates), 'grep-gates already has a path filter').toEqual([]);

    const withFilter: Workflow = {
      ...workflow,
      jobs: {
        ...workflow.jobs,
        'grep-gates': {
          ...grepGates,
          if: `${grepGates?.if ?? ''} && needs.changes.outputs.root == 'true'`,
        },
      },
    };

    expect(derivedLicensedSkips(withFilter).map.get('grep-gates')).toBe('root');
    expect(
      licensedSkipsMatchPathFilters(withFilter, step),
      'a path filter was added to grep-gates and the conformance check still passed',
    ).toBe(false);
  });

  it('Aggregator_AllLanesSucceed_Passes', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = await runAggregator(workflow, synthesizeNeeds(workflow));
    expect(run.status, run.output).toBe(0);
  });

  /** The lanes come from the real `needs:` list. The exit status is the proof, not a text match on the script. */
  it('Aggregator_AnyLaneFailingOrCancelled_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const lanes = needsList(workflow.jobs[AGGREGATOR_JOB]);
    expect(lanes.length).toBeGreaterThan(0);

    for (const lane of lanes) {
      for (const result of ['failure', 'cancelled']) {
        const run = await runAggregator(workflow, synthesizeNeeds(workflow, { results: { [lane]: result } }));
        expect(run.status, `lane "${lane}" reporting "${result}" did not fail the gate:\n${run.output}`).not.toBe(0);
        expect(run.output).toContain(lane);
      }
    }
  });

  /** Each lane with no declared licence must fail the gate when it reports `skipped`. */
  it('Aggregator_UnlicensedLaneSkipped_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    const unlicensed = needsList(workflow.jobs[AGGREGATOR_JOB]).filter((l) => !licensed.has(l));
    expect(unlicensed.length, 'expected at least one lane with no licensed skip').toBeGreaterThan(0);

    for (const lane of unlicensed) {
      const run = await runAggregator(workflow, synthesizeNeeds(workflow, { results: { [lane]: 'skipped' } }));
      expect(run.status, `skipped lane "${lane}" was treated as passing:\n${run.output}`).not.toBe(0);
      expect(run.output).toContain(lane);
    }
  });

  /**
   * The derived loop above covers `grep-gates`, and this test names the lane
   * explicitly. The lane hosts the enforcement gates. If a path filter makes it
   * skip, CI Gate must fail.
   */
  it('Aggregator_GrepGatesSkipped_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = await runAggregator(workflow, synthesizeNeeds(workflow, { results: { 'grep-gates': 'skipped' } }));
    expect(run.status, `grep-gates skipped but the gate passed:\n${run.output}`).not.toBe(0);
    expect(run.output).toContain('grep-gates');
  });

  /**
   * The policy is total over the `needs` context. A new lane with no licence is
   * strict from the moment it joins, so an omission fails closed.
   */
  it('Aggregator_LaneAddedToNeedsWithoutPolicyEdit_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = await runAggregator(
      workflow,
      synthesizeNeeds(workflow, { extraLanes: { 'future-lane': 'skipped' } }),
    );
    expect(run.status, `an unlicensed new lane skipped without failing the gate:\n${run.output}`).not.toBe(0);
    expect(run.output).toContain('future-lane');
  });

  /** A licensed skip must pass. If it fails, the gate is noise and someone weakens it. */
  it('Aggregator_LicensedLaneSkippedUnderItsFilter_Passes', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    expect(licensed.size).toBeGreaterThan(0);

    for (const [lane, key] of licensed) {
      const run = await runAggregator(
        workflow,
        synthesizeNeeds(workflow, {
          results: { [lane]: 'skipped' },
          changesOutputs: { [key]: 'false' },
        }),
      );
      expect(run.status, `licensed skip of "${lane}" (${key}=false) was rejected:\n${run.output}`).toBe(0);
    }
  });

  /**
   * A licence names a `changes` output. A key that `changes` does not declare
   * reads as not 'true', the same as a declared 'false'. So the script must also
   * check that `changes` declares the key. If not, a renamed or deleted output
   * lets each lane on that key skip while CI Gate reports success.
   */
  it('Aggregator_LicenceKeyNotDeclaredByChanges_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    expect(licensed.size).toBeGreaterThan(0);

    for (const [lane, key] of licensed) {
      const run = await runAggregator(
        workflow,
        synthesizeNeeds(workflow, {
          results: { [lane]: 'skipped' },
          dropChangesOutputs: [key],
        }),
      );
      expect(
        run.status,
        `skip of "${lane}" was licensed by an UNDECLARED changes output "${key}":\n${run.output}`,
      ).not.toBe(0);
      expect(run.output).toContain(key);
    }
  });

  /**
   * A filtered lane that skips while its own filter key is 'true' is a
   * regression of the path filter or the matrix. It is not a licensed skip.
   */
  it('Aggregator_LicensedLaneSkippedDespiteItsFilterFiring_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    expect(licensed.size).toBeGreaterThan(0);

    for (const [lane, key] of licensed) {
      const run = await runAggregator(
        workflow,
        synthesizeNeeds(workflow, {
          results: { [lane]: 'skipped' },
          changesOutputs: { [key]: 'true' },
        }),
      );
      expect(run.status, `"${lane}" skipped with ${key}=true but the gate passed:\n${run.output}`).not.toBe(0);
      expect(run.output).toContain(lane);
    }
  });

  /**
   * A licence reads the `changes` outputs. When `changes` does not succeed, its
   * outputs are empty. Empty outputs must not read as "nothing changed" and
   * license each skip.
   */
  it('Aggregator_LicensedSkipWhileChangeDetectionDidNotSucceed_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    const [lane] = [...licensed.keys()];
    expect(lane).toBeDefined();

    const needs = synthesizeNeeds(workflow, { results: { [lane as string]: 'skipped' } });
    needs['changes'] = { result: 'failure', outputs: {} };
    const run = await runAggregator(workflow, needs);
    expect(run.status, `licensed skip honoured while changes failed:\n${run.output}`).not.toBe(0);
  });

  it('Aggregator_UnrecognisedLaneResult_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = await runAggregator(
      workflow,
      synthesizeNeeds(workflow, { results: { 'grep-gates': 'mystery-state' } }),
    );
    expect(run.status, `an unclassifiable result was treated as passing:\n${run.output}`).not.toBe(0);
  });

  /** An aggregator that cannot read the context cannot prove that a lane ran, so it must fail. */
  it('Aggregator_UnreadableNeedsContext_Reddens', async () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    for (const malformed of ['', 'not json', '[]', 'null', '{}']) {
      const run = await runAggregator(workflow, malformed);
      expect(run.status, `malformed needs context ${JSON.stringify(malformed)} passed:\n${run.output}`).not.toBe(0);
    }
  });
});
