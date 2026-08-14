/**
 * CI-topology conformance test (DR-2, wave-S enforcement-substrate spec).
 *
 * `ci-gate.needs` is a hand-edited list that has already drifted once
 * (`e2e-process` carried a "Blocking gate" comment while being absent from
 * `needs:` — it could never fail a PR). This test makes that class of drift
 * a vitest failure by parsing `.github/workflows/ci.yml` with js-yaml
 * (already a root dep — see scripts/ci-workflow-shape.test.ts for the same
 * pattern) and asserting, by STRUCTURAL CONTAINMENT over the YAML plus the
 * `ci-gate` evaluate step's raw script text (fixture-tested, NOT bash-parsed):
 *
 *   1. Completeness — every top-level job key is either in `ci-gate.needs`
 *      or in the non-blocking allowlist below (rationale + issue ref).
 *   2. Evaluate coverage — every job in `ci-gate.needs` (except `ci-gate`
 *      itself) has a `needs.<job>.result` clause matched against
 *      failure|cancelled somewhere in the evaluate script.
 *   3. Skip-guard coverage — every PATH-FILTERED job in `ci-gate.needs`
 *      (its `if:` references `needs.changes.outputs.<key>`) has a
 *      fail-closed skip-guard in the evaluate script keyed on that same
 *      `changes.outputs.<key>`. The job→key mapping is DERIVED from the
 *      job's own `if:` text, never hardcoded.
 *
 * The `ci-gate` job itself is excluded from the completeness scan: it is
 * the aggregator, not a dependency of itself, and cannot sensibly appear in
 * its own `needs:` or in a "non-blocking" allowlist (it IS the blocking
 * mechanism). This mirrors the explicit "except ci-gate itself" carve-out
 * DR-2 already states for evaluate coverage.
 *
 * This test's own unfiltered execution host (a grep-gates tsx-tail step,
 * `npx --no-install vitest run scripts/ci-topology.test.ts`) is wired by
 * task 007 — this task only authors the test + fixtures.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
// The repo's own glob semantics, so this agrees with the guard inventory's
// reading of the same workflow rather than inventing a second one.
import { globMatches } from '../../tools/audit/gates/guard-inventory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const FIXTURES_DIR = join(__dirname, '__fixtures__', 'ci-topology');

/** The aggregator job's name. Excluded from its own completeness scan (see header doc). */
const AGGREGATOR_JOB = 'ci-gate';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly steps?: readonly WorkflowStep[];
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

/** Locates and returns the raw script text of the aggregator's evaluate step. */
function evaluateScript(workflow: Workflow): string {
  const gate = workflow.jobs[AGGREGATOR_JOB];
  if (!gate) {
    throw new Error(`aggregator job "${AGGREGATOR_JOB}" not found in workflow`);
  }
  const steps = gate.steps ?? [];
  const evalStep =
    steps.find((s) => s.name === 'Evaluate results' && typeof s.run === 'string') ??
    steps.find((s) => typeof s.run === 'string');
  if (!evalStep?.run) {
    throw new Error(`aggregator job "${AGGREGATOR_JOB}" has no step with a "run" script`);
  }
  return evalStep.run;
}

/**
 * Extract the CONDITION text of every `if [[ ... ]]` test in a bash script,
 * with whole-line comments removed and `\`-continued lines joined. Matching an
 * EXECUTABLE condition — rather than a proximity window — is what stops an
 * explanatory comment, a `needs.<job>.result` echo line, or an adjacent job's
 * clause from standing in for a removed guard: a `#`-comment naming a job +
 * "skipped", or `echo "job=${{ needs.job.result }}"`, is not an `if [[ ]]`
 * test and so never contributes a match.
 *
 * The `if` keyword is anchored to a line/command boundary (`^\s*if`, `m` flag)
 * rather than matched anywhere in the joined text — otherwise a REMOVED guard
 * whose tokens survive only inside an `echo '...'` string (e.g.
 * `echo 'if [[ "${{ needs.job.result }}" =~ ^(failure|cancelled)$ ]]'`, a
 * print statement, never executed) would still be picked up as if it were a
 * real, executable `if [[ ]]` test, false-passing the coverage assertions
 * (CodeRabbit round 2, #1719 finding B).
 */
function extractIfConditions(script: string): string[] {
  const noComments = script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  // Join `\`-continued lines so a multi-line `[[ … \` <newline> `… ]]`
  // condition (the skip-guards) becomes one logical clause.
  const joined = noComments.replace(/\\\n/g, ' ');
  const conditions: string[] = [];
  const re = /^\s*if\s+\[\[([\s\S]*?)\]\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) !== null) {
    conditions.push(m[1] as string);
  }
  return conditions;
}

/**
 * True iff SOME executable `if [[ ... ]]` condition references
 * `needs.<jobName>.result` AND contains every one of `requiredTokens`. Binds
 * the tokens to a SINGLE executable clause — never scattered across comments,
 * echo lines, or an adjacent job's guard (the failure mode a proximity window
 * admitted).
 */
function scriptHasResultClause(script: string, jobName: string, requiredTokens: string[]): boolean {
  const needle = `needs.${jobName}.result`;
  return extractIfConditions(script).some(
    (cond) => cond.includes(needle) && requiredTokens.every((tok) => cond.includes(tok)),
  );
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

/** Assertion 2: evaluate coverage. */
function checkEvaluateCoverage(workflow: Workflow): CheckResult {
  const script = evaluateScript(workflow);
  const jobs = needsList(workflow.jobs[AGGREGATOR_JOB]).filter((j) => j !== AGGREGATOR_JOB);
  const violations: string[] = [];
  for (const jobName of jobs) {
    if (!scriptHasResultClause(script, jobName, ['failure|cancelled'])) {
      violations.push(jobName);
    }
  }
  return { pass: violations.length === 0, violations };
}

/**
 * Derives the `changes.outputs.<key>` set a job's `if:` expression is gated
 * on, by parsing `needs.changes.outputs.<key>` out of the raw `if:` text —
 * never a hardcoded job→key table.
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

/** Assertion 3: skip-guard coverage. */
function checkSkipGuardCoverage(workflow: Workflow): CheckResult {
  const script = evaluateScript(workflow);
  const jobs = needsList(workflow.jobs[AGGREGATOR_JOB]).filter((j) => j !== AGGREGATOR_JOB);
  const violations: string[] = [];
  for (const jobName of jobs) {
    const keys = pathFilterKeys(workflow.jobs[jobName]);
    if (keys.length === 0) continue; // not path-filtered — no skip-guard required
    for (const key of keys) {
      const hasGuard = scriptHasResultClause(script, jobName, [
        `needs.changes.outputs.${key}`,
        'skipped',
      ]);
      if (!hasGuard) {
        violations.push(`${jobName} (key: ${key})`);
      }
    }
  }
  return { pass: violations.length === 0, violations };
}

// ─── DR-22: projection roots cannot change unobserved in CI ─────────────────
//
// The `changes` job's `dorny/paths-filter@v3` step configures its filters via
// a single YAML *block-scalar string* (`with.filters: |`), not nested YAML
// nodes — `js-yaml` parses that string as opaque text on the first pass. The
// helper below re-parses that string as YAML on a SECOND pass to recover the
// actual `root`/`mcp`/`prompts` glob arrays, so the assertions below check
// the filter's REAL structure rather than regex-matching the workflow's raw
// text (per the boundary note: parse the real file, don't loosely pattern
// match it).

const PATHS_FILTER_JOB = 'changes';
const PATHS_FILTER_STEP_ID = 'filter';

/** Parses the `dorny/paths-filter` step's `with.filters` block scalar as YAML. */
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

/** Returns the glob list for a single named filter (e.g. `root`), or `[]` if absent/malformed. */
function filterGlobs(filters: Record<string, unknown>, filterName: string): string[] {
  const value = filters[filterName];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Projection-root globs the `root` path filter MUST contain (DR-22
 * acceptance criteria, verbatim): the shipped agent, command-alias, hook,
 * and Claude-plugin-manifest surfaces, plus the top-level `AGENTS.md`.
 * Without these, a PR that only deletes/mutates one of these paths never
 * flips `needs.changes.outputs.root` to `'true'`, so `test-root` (and the
 * `skills:guard` / `hooks:guard` drift guards it hosts) never runs.
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
] as const;

/** True iff some step in `job` runs the given `npm run <script>` invocation. */
function jobRunsNpmScript(job: WorkflowJob | undefined, scriptName: string): boolean {
  const steps = job?.steps ?? [];
  const re = new RegExp(`npm run ${scriptName}\\b`);
  return steps.some((s) => typeof s.run === 'string' && re.test(s.run));
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

  it('Filters_EveryGlob_MatchesAtLeastOneTrackedFile', () => {
    // Membership is not protection. A filter listing `agents/**` reads as
    // covering the agents, and goes on reading that way after the directory is
    // renamed — the entry is still there, it just selects nothing, and the job
    // it gates stops firing on exactly the PRs it exists to police. A skipped
    // required job reads as passed (#1711), so this fails silent in the
    // direction that looks green.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const filters = getPathsFilters(workflow);
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 2e8,
    })
      .split('\n')
      .filter(Boolean);

    const dead: string[] = [];
    let checked = 0;
    for (const name of Object.keys(filters)) {
      for (const glob of filterGlobs(filters, name)) {
        // Negations select by exclusion and legitimately match nothing.
        if (glob.startsWith('!')) continue;
        checked += 1;
        if (!tracked.some((f) => globMatches(glob, f))) dead.push(`${name}: ${glob}`);
      }
    }

    expect(checked, 'no path-filter globs were examined').toBeGreaterThan(0);
    expect(dead, 'path-filter globs matching no tracked file').toEqual([]);
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

    const evaluateCoverage = checkEvaluateCoverage(workflow);
    expect(evaluateCoverage.violations, 'evaluate-coverage violations').toEqual([]);
    expect(evaluateCoverage.pass).toBe(true);

    const skipGuardCoverage = checkSkipGuardCoverage(workflow);
    expect(skipGuardCoverage.violations, 'skip-guard-coverage violations').toEqual([]);
    expect(skipGuardCoverage.pass).toBe(true);
  });

  it('Topology_UnlistedJobOutsideAllowlist_Fails', () => {
    const workflow = loadWorkflow(join(FIXTURES_DIR, 'unlisted-job.yml'));
    const result = checkCompleteness(workflow);
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('orphan-job');
  });

  it('Topology_FilteredNeedsJobWithoutSkipGuard_Fails', () => {
    const workflow = loadWorkflow(join(FIXTURES_DIR, 'missing-skip-guard.yml'));
    const result = checkSkipGuardCoverage(workflow);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.startsWith('test-root'))).toBe(true);
  });

  it('Topology_NeedsJobWithoutEvaluateClause_Fails', () => {
    const workflow = loadWorkflow(join(FIXTURES_DIR, 'missing-evaluate-clause.yml'));
    const result = checkEvaluateCoverage(workflow);
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('validate-no-legacy');
  });

  // ── Finding 7 decoys: a removed guard whose tokens survive only in an echo
  // line or a comment must STILL be detected (a proximity window would not).
  it('Topology_EvaluateGuardReplacedByEchoAndComment_Fails', () => {
    const workflow = loadWorkflow(join(FIXTURES_DIR, 'decoy-evaluate-echo-comment.yml'));
    const result = checkEvaluateCoverage(workflow);
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('validate-no-legacy');
  });

  it('Topology_SkipGuardReplacedByComment_Fails', () => {
    const workflow = loadWorkflow(join(FIXTURES_DIR, 'decoy-skip-guard-comment.yml'));
    const result = checkSkipGuardCoverage(workflow);
    expect(result.pass).toBe(false);
    expect(result.violations.some((v) => v.startsWith('test-root'))).toBe(true);
  });
});
