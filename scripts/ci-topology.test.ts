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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const FIXTURES_DIR = join(__dirname, '__fixtures__', 'ci-topology');

/** The aggregator job's name. Excluded from its own completeness scan (see header doc). */
const AGGREGATOR_JOB = 'ci-gate';

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
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
  return Array.isArray(job.needs) ? job.needs : [job.needs];
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
  const re = /if\s+\[\[([\s\S]*?)\]\]/g;
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
