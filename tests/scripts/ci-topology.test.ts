/**
 * CI-topology conformance test (DR-2, wave-S enforcement-substrate spec;
 * DR-10, internal-mechanics-residue spec).
 *
 * `ci-gate.needs` is a hand-edited list that has already drifted once
 * (`e2e-process` carried a "Blocking gate" comment while being absent from
 * `needs:` — it could never fail a PR). This test makes that class of drift
 * a vitest failure by parsing `.github/workflows/ci.yml` with js-yaml
 * (already a root dep — see scripts/ci-workflow-shape.test.ts for the same
 * pattern) and asserting:
 *
 *   1. Completeness (DR-2) — every top-level job key is either in
 *      `ci-gate.needs` or in the non-blocking allowlist below (rationale +
 *      issue ref). Checked by structural containment over the parsed YAML.
 *   2. Execution policy (DR-10) — `ci-gate` is the org `ci-lanes@v1` verdict
 *      job (required check name `CI Gate`). Skip licences live in
 *      `.github/ci-lanes.toml` and the byte-exact job `if:` expressions;
 *      the action's `check` mode re-proves that contract on every PR.
 *
 * The `ci-gate` job itself is excluded from the completeness scan: it is
 * the aggregator, not a dependency of itself, and cannot sensibly appear in
 * its own `needs:` or in a "non-blocking" allowlist (it IS the blocking
 * mechanism).
 *
 * ── Why the text-matching coverage helpers are gone (task 091) ─────────────
 * DR-2 originally asserted "every lane has a `failure|cancelled` clause" and
 * "every path-filtered lane has a skip-guard" by extracting `if [[ … ]]`
 * conditions from the script and matching tokens against them, with decoy
 * fixtures proving a comment or an `echo` could not stand in for a removed
 * guard. Those helpers, and the four fixtures defending them, described a
 * shape the aggregator no longer has: the per-lane clauses were replaced by
 * one policy applied to the `needs` context, so there is no per-lane text to
 * match. Nothing was relaxed. The decoy attack the fixtures existed to catch
 * — guard deleted, tokens surviving in a comment or a print statement — is
 * not merely detected but impossible against execution: a gutted script
 * exits 0 on a context it should reject, and every case below reddens.
 * `unlisted-job.yml` is still used, by the completeness fixture test.
 *
 * This test's own unfiltered execution host (a grep-gates tsx-tail step,
 * `npx --no-install vitest run scripts/ci-topology.test.ts`) is wired by
 * task 007.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
// The repo's own glob semantics, so this agrees with the guard inventory's
// reading of the same workflow rather than inventing a second one.
import { globMatches, pathFilterGlobs, pathFilterKeys } from '../../tools/audit/gates/guard-inventory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const FIXTURES_DIR = join(__dirname, '__fixtures__', 'ci-topology');

/** The aggregator job's name. Excluded from its own completeness scan (see header doc). */
const AGGREGATOR_JOB = 'ci-gate';
const PLANNER_JOB = 'plan';
const CI_LANES_ACTION = 'lvlup-sw/.github/actions/ci-lanes@v1';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  /** Literal booleans or GitHub expression strings such as `${{ true }}`. */
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

/**
 * The non-blocking allowlist (DR-4 measured dispositions). Reviewable in the
 * same diff that adds a top-level job outside `ci-gate.needs` — this lives
 * in the test file itself, never a separate config (per the DR-2 acceptance
 * criteria and docs/guides/ci-gate-hosting.md's allowlist contract).
 */
interface AllowlistEntry {
  rationale: string;
  issue?: string;
}

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

function needsList(job: WorkflowJob | undefined): string[] {
  if (!job || !job.needs) return [];
  // `typeof === 'string'`, not `Array.isArray`: the latter does not narrow a
  // `string | readonly string[]` union, so the scalar branch kept the union.
  return typeof job.needs === 'string' ? [job.needs] : [...job.needs];
}

interface CheckResult {
  pass: boolean;
  violations: string[];
}

/** Assertion 1: completeness. */
function checkCompleteness(workflow: Workflow): CheckResult {
  const gate = workflow.jobs[AGGREGATOR_JOB];
  const needs = new Set(needsList(gate));
  const violations: string[] = [];
  for (const jobName of Object.keys(workflow.jobs)) {
    if (jobName === AGGREGATOR_JOB) continue; // the aggregator itself — see header doc
    if (needs.has(jobName)) continue;
    if (NON_BLOCKING_ALLOWLIST[jobName]) continue;
    violations.push(jobName);
  }
  return { pass: violations.length === 0, violations };
}

/**
 * Projection-root globs the `root` path filter MUST contain (DR-22
 * acceptance criteria, verbatim): the shipped agent, command-alias, hook,
 * and Claude-plugin-manifest surfaces, plus the top-level `AGENTS.md`.
 * Without these, a PR that only deletes/mutates one of these paths never
 * flips lane `root` to true, so `test-root` (and the `skills:guard` /
 * `hooks:guard` drift guards it hosts) never runs.
 *
 * Two coverage-closing additions ride the same contract:
 *   - `src/runtime/agents/**` — the agent-GENERATOR sources
 *     that feed the rendered `agents/**` projection; without it a
 *     generator-only PR ships drift unobserved and `skills:guard` only
 *     fires on some LATER PR that touches the rendered output.
 *   - `.github/workflows/release.yml` — `scripts/release-workflow.test.ts`
 *     (hosted in the root suite) parses release.yml, so a release.yml-only
 *     PR must flip `root` or the workflow's own contract test never runs
 *     on the PR that changes it.
 */
const REQUIRED_ROOT_PROJECTION_GLOBS = [
  // Was `agents/**` + `command-aliases/**` + `commands/**` + `rules/**` +
  // `skills/**` until the DR-4 block folded all five into one generated tree.
  // This list went on naming them, and the assertion below only ever asked
  // whether the filter CONTAINED each glob — never whether the glob matched a
  // file — so it kept passing while every one of them matched nothing and the
  // protection it encodes was void. `MatchAtLeastOneTrackedFile` is the tooth
  // that was missing.
  'rendered/**',
  'hooks/**',
  '.claude-plugin/**',
  'AGENTS.md',
  'src/runtime/agents/**',
  '.github/workflows/release.yml',
  // Fail-open registers the architecture liveness closer reads. A PR that
  // only edits one of these must still flip `root`, or the live-oracle
  // teeth skip while the register evaporates.
  '.github/CODEOWNERS',
  'knip.json',
  '.exarchos/**',
  'manifest.json',
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `npm run <script>` at the start of a run step, not a suffix or an echo. */
function npmRunInvocation(scriptName: string): RegExp {
  return new RegExp(`^npm run ${escapeRegExp(scriptName)}(?:\\s|$)`);
}

/**
 * True iff `cmd` is a vitest invocation selecting exactly `project`. The
 * option has to be one of vitest's own arguments: `echo --project unit` names
 * the option without running anything, and `vitest && echo --project unit`
 * hands it to a later command — either would otherwise satisfy a topology pin
 * while the project it names is collected by nobody. `--project core-extra`
 * must not count for `core` — `\b` after `core` still matches a hyphen.
 */
function isVitestProjectCommand(cmd: string, project: string): boolean {
  // Only the first shell command is vitest's: cut at `;`, either `|` form,
  // either `&` form (a backgrounded vitest included), or a newline BEFORE
  // matching the invocation, so `\s+` cannot swallow a newline boundary.
  const head = cmd.trim().split(/[;|&\r\n]/, 1)[0] ?? '';
  const invocation = /^(?:npx\s+)?vitest(?:\s+|$)/.exec(head);
  if (invocation === null) return false;
  const args = head.slice(invocation[0].length);
  return new RegExp(`(?:^|\\s)--project ${escapeRegExp(project)}(?:\\s|$)`).test(args);
}

/** True iff `cmd` runs the `core` vitest project. */
function isCoreProjectCommand(cmd: string): boolean {
  return isVitestProjectCommand(cmd, 'core');
}

/**
 * Only an absent field or a literal `false` is a required host. Expression
 * strings (`${{ true }}`) stay strings after YAML parse and are soft-fail.
 */
function isRequiredHostStep(step: WorkflowStep): boolean {
  const softFail = step['continue-on-error'];
  return softFail === undefined || softFail === false;
}

/** True iff some step in `job` runs the given `npm run <script>` invocation. */
function jobRunsNpmScript(job: WorkflowJob | undefined, scriptName: string): boolean {
  const steps = job?.steps ?? [];
  const re = npmRunInvocation(scriptName);
  return steps.some((s) => typeof s.run === 'string' && re.test(s.run.trim()));
}

/**
 * True iff a step's `run` value *is* `npm run <script>` (optional trailing
 * args), not an echo or comment that merely mentions the name.
 */
function jobRunsCoreProjectScript(job: WorkflowJob | undefined, scriptName: string): boolean {
  const steps = job?.steps ?? [];
  const re = npmRunInvocation(scriptName);
  return steps.some(
    (s) => typeof s.run === 'string' && re.test(s.run.trim()) && isRequiredHostStep(s),
  );
}

/**
 * True iff `scripts[name]` runs `--project unit`, directly or through ONE hop
 * of `npm run <alias>` — `test:run` is `npm run test:unit`, and CI invokes the
 * alias. One hop is what the tree has; a deeper chain is a new shape to pin,
 * not one to resolve silently.
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
    const filters = pathFilterGlobs(workflow);
    const rootGlobs = filters.root ?? [];

    const missing = REQUIRED_ROOT_PROJECTION_GLOBS.filter((glob) => !rootGlobs.includes(glob));
    expect(missing, `lane root missing required glob(s): ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('Filters_EveryGlob_MatchesAtLeastOneTrackedFile', () => {
    // Membership is not protection. A filter listing `agents/**` reads as
    // covering the agents, and goes on reading that way after the directory is
    // renamed — the entry is still there, it just selects nothing, and the job
    // it gates stops firing on exactly the PRs it exists to police. A skipped
    // required job reads as passed (#1711), so this fails silent in the
    // direction that looks green.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const filters = pathFilterGlobs(workflow);
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 2e8,
    })
      .split('\n')
      .filter(Boolean);

    const dead: string[] = [];
    let checked = 0;
    for (const [name, globs] of Object.entries(filters)) {
      for (const glob of globs) {
        // Negations select by exclusion and legitimately match nothing.
        if (glob.startsWith('!')) continue;
        checked += 1;
        if (!tracked.some((f) => globMatches(glob, f))) dead.push(`${name}: ${glob}`);
      }
    }

    expect(checked, 'no path-filter globs were examined').toBeGreaterThan(0);
    expect(dead, 'path-filter globs matching no tracked file').toEqual([]);
  });

  it('LayerCensus_HostScripts_AreRunStepsOnBothPlatforms', () => {
    // `auditLayerBoundaries` is collected by the `core` vitest project.
    // Linux hosts that project as `test:coverage`; Windows hosts it as
    // `test:core`. A substring in a comment is not a host. Both platforms
    // that ship must keep a `run:` step whose script expands to
    // `--project core`, on a job `ci-gate` actually needs.
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

    // Teeth: an echo that names the script is not a run step.
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

    // A suffixed script name is not the host (`\b` after `coverage` still
    // matches `coverage-extra` because `-` is a non-word character).
    const prefixed: WorkflowJob = {
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'npm run test:coverage-extra' }],
    };
    expect(jobRunsCoreProjectScript(prefixed, 'test:coverage')).toBe(false);
    expect(jobRunsNpmScript(prefixed, 'test:coverage')).toBe(false);

    // Expression-valued continue-on-error stays a string after YAML parse.
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

  it('LayerCensus_UnitProjectHostScripts_AreRunStepsOnBothPlatforms', () => {
    // The architecture oracles — the event-authority declaration conjunct and
    // the raw-reader census among them — are collected by the `unit` vitest
    // project, which CI hosts as `npm run test:run`, an alias of `test:unit`.
    // The core pin above says nothing about that lane, so a workflow edit that
    // dropped the step would leave those oracles collected by nothing while
    // every job stayed green. Same shape as the core pin, with the alias chain
    // resolved through package.json rather than matched by name.
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

  it('Guards_HooksGuardRunsInCI_AndIsRootFiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    // `hooks:guard` must actually execute in some job (a real CI step, not
    // just an npm script that exists but is never wired in).
    const jobNamesWithHooksGuard = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunsNpmScript(job, 'render:guard'))
      .map(([name]) => name);
    expect(jobNamesWithHooksGuard.length, 'no CI job runs "npm run render:guard"').toBeGreaterThan(
      0,
    );

    // The job(s) running it must be gated on the `root` change-filter key —
    // otherwise the guard exists in CI but never fires on the PRs that need
    // it (the exact DR-22 failure mode).
    for (const jobName of jobNamesWithHooksGuard) {
      const keys = pathFilterKeys(workflow.jobs[jobName]);
      expect(keys, `job "${jobName}" running render:guard is not gated on any changes.outputs key`).toContain(
        'root',
      );
    }
  });

  it('Guards_SkillsGuardCoversCommandAliasesAndAgents_RunsInCI_AndIsRootFiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    // `skills:guard` (src/install/skills-guard.ts) is the drift guard for BOTH
    // `command-aliases/` and `agents/` (it regenerates and diffs both trees
    // — see the runSkillsGuard implementation). Assert it actually runs in
    // CI and is gated on `root`, same as hooks:guard above.
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

  it('Aggregator_LaneGainsANarrowingFilter_IsDetected', () => {
    // grep-gates rides lane `always`, which pathFilterKeys treats as unfiltered.
    // Giving it a narrowing `root` key must surface so the substrate host cannot
    // become skip-as-passed on the PRs it polices.
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
