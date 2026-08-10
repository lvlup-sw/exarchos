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
 *   2. Execution policy (DR-10) — the aggregator's `Evaluate results` script
 *      is EXECUTED, verbatim, over synthetic `needs` contexts, and its exit
 *      status is asserted lane by lane. That subsumes what DR-2's original
 *      assertions 2 and 3 checked by grepping the script's text.
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
import { spawnSync } from 'node:child_process';
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

/** The aggregator step whose script this test executes. */
const EVALUATE_STEP_NAME = 'Evaluate results';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
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
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/** Locates the aggregator's evaluate step (script + its `env:` block). */
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

// ─── DR-10: a lane's execution is not optional ──────────────────────────────
//
// The aggregator declares its skip policy as `LICENSED_SKIPS` — newline-
// separated `lane=changesOutputKey` entries naming the ONLY lanes whose
// `skipped` result is legitimate. Everything not named there is strict: a skip
// is a hard failure. The helpers below (a) parse that declaration, (b) derive
// the same mapping independently from each lane's own `if:` expression, and
// (c) run the shipped script over synthetic `needs` contexts.
//
// (a) vs (b) is the anti-transcription check: the declaration is data, so it
// COULD drift from the filters it describes. Deriving the truth from the `if:`
// text and demanding exact equality is what stops that — the workflow's real
// path filters remain the single source, and the declaration is only allowed
// to restate them exactly.

/** Parses the aggregator's `LICENSED_SKIPS` env declaration into lane → changes-output key. */
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
 * Derives lane → changes-output key from the lanes' own `if:` expressions: a
 * lane that gates on `needs.changes.outputs.<key>` can legitimately skip when
 * that key is not 'true'; a lane that gates on nothing cannot legitimately
 * skip at all. `multiKeyLanes` collects any lane gating on more than one key —
 * the `lane=key` declaration format cannot express those, so the conformance
 * test fails rather than silently checking the wrong thing.
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

/** A synthetic `needs` context: what GitHub hands the aggregator via `toJSON(needs)`. */
type NeedsContext = Record<string, { result: string; outputs?: Record<string, string> }>;

/** Every declared `changes` output, defaulted to 'true' (the "this PR touched everything" case). */
function changesOutputsAllTrue(workflow: Workflow): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const lane of needsList(workflow.jobs[AGGREGATOR_JOB])) {
    for (const key of pathFilterKeys(workflow.jobs[lane])) outputs[key] = 'true';
  }
  return outputs;
}

/**
 * Builds a green `needs` context (every lane `success`, every changes output
 * 'true'), then applies the given overrides. The lane set is taken from the
 * workflow's own `needs:` list, so these cases follow the aggregator rather
 * than pinning a copy of the lane names.
 */
function synthesizeNeeds(
  workflow: Workflow,
  overrides: {
    results?: Record<string, string>;
    changesOutputs?: Record<string, string>;
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
 * Executes the aggregator's shipped script verbatim against a synthetic
 * `needs` context. This is real execution of the workflow's own bash — not a
 * re-implementation of its policy — which is why the script must contain no
 * `${{ }}` interpolation (asserted below) and take every GitHub value through
 * `env:`.
 */
function runAggregator(
  workflow: Workflow,
  needs: NeedsContext | string,
  licensedSkipsOverride?: string,
): AggregatorRun {
  const step = evaluateStep(workflow);
  const licensed = licensedSkipsOverride ?? String(step.env?.LICENSED_SKIPS ?? '');
  const result = spawnSync('bash', ['-c', step.run as string], {
    env: {
      ...process.env,
      NEEDS_JSON: typeof needs === 'string' ? needs : JSON.stringify(needs),
      LICENSED_SKIPS: licensed,
    },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
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
 *   - `servers/exarchos-mcp/src/agents/**` — the agent-GENERATOR sources
 *     that feed the rendered `agents/**` projection; without it a
 *     generator-only PR ships drift unobserved and `skills:guard` only
 *     fires on some LATER PR that touches the rendered output.
 *   - `.github/workflows/release.yml` — `scripts/release-workflow.test.ts`
 *     (hosted in the root suite) parses release.yml, so a release.yml-only
 *     PR must flip `root` or the workflow's own contract test never runs
 *     on the PR that changes it.
 */
const REQUIRED_ROOT_PROJECTION_GLOBS = [
  'agents/**',
  'command-aliases/**',
  'hooks/**',
  '.claude-plugin/**',
  'AGENTS.md',
  'servers/exarchos-mcp/src/agents/**',
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

  it('Guards_HooksGuardRunsInCI_AndIsRootFiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    // `hooks:guard` must actually execute in some job (a real CI step, not
    // just an npm script that exists but is never wired in).
    const jobNamesWithHooksGuard = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunsNpmScript(job, 'hooks:guard'))
      .map(([name]) => name);
    expect(jobNamesWithHooksGuard.length, 'no CI job runs "npm run hooks:guard"').toBeGreaterThan(
      0,
    );

    // The job(s) running it must be gated on the `root` change-filter key —
    // otherwise the guard exists in CI but never fires on the PRs that need
    // it (the exact DR-22 failure mode).
    for (const jobName of jobNamesWithHooksGuard) {
      const keys = pathFilterKeys(workflow.jobs[jobName]);
      expect(keys, `job "${jobName}" running hooks:guard is not gated on any changes.outputs key`).toContain(
        'root',
      );
    }
  });

  it('Guards_SkillsGuardCoversCommandAliasesAndAgents_RunsInCI_AndIsRootFiltered', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    // `skills:guard` (src/skills-guard.ts) is the drift guard for BOTH
    // `command-aliases/` and `agents/` (it regenerates and diffs both trees
    // — see the runSkillsGuard implementation). Assert it actually runs in
    // CI and is gated on `root`, same as hooks:guard above.
    const jobNamesWithSkillsGuard = Object.entries(workflow.jobs)
      .filter(([, job]) => jobRunsNpmScript(job, 'skills:guard'))
      .map(([name]) => name);
    expect(
      jobNamesWithSkillsGuard.length,
      'no CI job runs "npm run skills:guard"',
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
  // ── Structural preconditions ────────────────────────────────────────────
  //
  // These three make the executable assertions below meaningful: the script
  // must be runnable outside GitHub (no `${{ }}`), its lane list must BE the
  // needs context rather than a copy of it, and its skip licences must match
  // the path filters they claim to describe.

  it('Aggregator_EvaluateScript_TakesEveryGitHubValueThroughEnv', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const step = evaluateStep(workflow);
    // A `${{ }}` in the script body would be pasted in by GitHub before bash
    // ever sees it — untestable here, and a shell-injection surface besides.
    expect(
      (step.run as string).includes('${{'),
      'the evaluate script interpolates ${{ }}; move that value into the step\'s env: block so the script stays executable verbatim',
    ).toBe(false);
  });

  it('Aggregator_LaneList_IsTheNeedsContextItself', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const step = evaluateStep(workflow);
    // `toJSON(needs)` is what makes the lane list underivable-by-hand: a lane
    // added to `needs:` appears here with no edit to the policy, so it cannot
    // be omitted from it.
    expect(String(step.env?.NEEDS_JSON ?? '').trim()).toBe('${{ toJSON(needs) }}');
  });

  it('Aggregator_LicensedSkips_RestateThePathFiltersExactly', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const step = evaluateStep(workflow);
    const declared = declaredLicensedSkips(step);
    const { map: derived, multiKeyLanes } = derivedLicensedSkips(workflow);

    expect(
      multiKeyLanes,
      'lane(s) gate on multiple changes.outputs keys; the LICENSED_SKIPS "lane=key" format cannot express that',
    ).toEqual([]);

    // Guards the comparison against passing vacuously if every path filter
    // were removed at once (both sides empty).
    expect(derived.size, 'no path-filtered lane found — the comparison below would be vacuous').toBeGreaterThan(0);

    const asSorted = (m: Map<string, string>): string[] =>
      [...m.entries()].map(([lane, key]) => `${lane}=${key}`).sort();
    expect(asSorted(declared), 'LICENSED_SKIPS does not match the lanes\' own if: expressions').toEqual(
      asSorted(derived),
    );
  });

  // ── Executable assertions: the shipped script, run for real ─────────────

  it('Aggregator_AllLanesSucceed_Passes', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = runAggregator(workflow, synthesizeNeeds(workflow));
    expect(run.status, run.output).toBe(0);
  });

  it('Aggregator_AnyLaneFailingOrCancelled_Reddens', () => {
    // Supersedes DR-2's "evaluate coverage" grep: derived over the real
    // `needs:` list, and proven by exit status rather than text matching.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const lanes = needsList(workflow.jobs[AGGREGATOR_JOB]);
    expect(lanes.length).toBeGreaterThan(0);

    for (const lane of lanes) {
      for (const result of ['failure', 'cancelled']) {
        const run = runAggregator(workflow, synthesizeNeeds(workflow, { results: { [lane]: result } }));
        expect(run.status, `lane "${lane}" reporting "${result}" did not fail the gate:\n${run.output}`).not.toBe(0);
        expect(run.output).toContain(lane);
      }
    }
  });

  it('Aggregator_UnlicensedLaneSkipped_Reddens', () => {
    // The headline DR-10 case. Every lane with no declared legitimate skip —
    // `grep-gates`, `manifest-gate`, `outcome-tests`, `validate-no-legacy`
    // and `changes` — must fail the gate when it does not run.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    const unlicensed = needsList(workflow.jobs[AGGREGATOR_JOB]).filter((l) => !licensed.has(l));
    expect(unlicensed.length, 'expected at least one lane with no licensed skip').toBeGreaterThan(0);

    for (const lane of unlicensed) {
      const run = runAggregator(workflow, synthesizeNeeds(workflow, { results: { [lane]: 'skipped' } }));
      expect(run.status, `skipped lane "${lane}" was treated as passing:\n${run.output}`).not.toBe(0);
      expect(run.output).toContain(lane);
    }
  });

  it('Aggregator_GrepGatesSkipped_Reddens', () => {
    // Named explicitly, not just covered by the derived loop above: this is
    // the kill fixture the task specifies. `grep-gates` hosts the whole
    // enforcement substrate, so if a future PR gives it a path filter that
    // excludes the changed files, the lane skips — and CI Gate must redden
    // rather than print success.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = runAggregator(workflow, synthesizeNeeds(workflow, { results: { 'grep-gates': 'skipped' } }));
    expect(run.status, `grep-gates skipped but the gate passed:\n${run.output}`).not.toBe(0);
    expect(run.output).toContain('grep-gates');
  });

  it('Aggregator_LaneAddedToNeedsWithoutPolicyEdit_Reddens', () => {
    // The structural claim, made executable: the policy is TOTAL over the
    // needs context, so a lane nobody has licensed is governed the moment it
    // is added. Omission fails closed.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = runAggregator(
      workflow,
      synthesizeNeeds(workflow, { extraLanes: { 'future-lane': 'skipped' } }),
    );
    expect(run.status, `an unlicensed new lane skipped without failing the gate:\n${run.output}`).not.toBe(0);
    expect(run.output).toContain('future-lane');
  });

  it('Aggregator_LicensedLaneSkippedUnderItsFilter_Passes', () => {
    // The other half of the contract: a legitimate skip must NOT redden, or
    // the gate becomes noise and gets weakened back.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    expect(licensed.size).toBeGreaterThan(0);

    for (const [lane, key] of licensed) {
      const run = runAggregator(
        workflow,
        synthesizeNeeds(workflow, {
          results: { [lane]: 'skipped' },
          changesOutputs: { [key]: 'false' },
        }),
      );
      expect(run.status, `licensed skip of "${lane}" (${key}=false) was rejected:\n${run.output}`).toBe(0);
    }
  });

  it('Aggregator_LicensedLaneSkippedDespiteItsFilterFiring_Reddens', () => {
    // Supersedes DR-2's "skip-guard coverage" grep, and preserves the wave-S
    // DR-3 guarantee: a filtered lane that skips when its own filter says the
    // area DID change is a path-filter/matrix regression, not a licence.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    expect(licensed.size).toBeGreaterThan(0);

    for (const [lane, key] of licensed) {
      const run = runAggregator(
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

  it('Aggregator_LicensedSkipWhileChangeDetectionDidNotSucceed_Reddens', () => {
    // A licence is read off the `changes` outputs, so it is only as good as
    // that lane. If change detection did not succeed its outputs are empty,
    // which would otherwise read as "nothing changed" and license everything.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const licensed = declaredLicensedSkips(evaluateStep(workflow));
    const [lane] = [...licensed.keys()];
    expect(lane).toBeDefined();

    const needs = synthesizeNeeds(workflow, { results: { [lane as string]: 'skipped' } });
    needs['changes'] = { result: 'failure', outputs: {} };
    const run = runAggregator(workflow, needs);
    expect(run.status, `licensed skip honoured while changes failed:\n${run.output}`).not.toBe(0);
  });

  it('Aggregator_UnrecognisedLaneResult_Reddens', () => {
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    const run = runAggregator(
      workflow,
      synthesizeNeeds(workflow, { results: { 'grep-gates': 'mystery-state' } }),
    );
    expect(run.status, `an unclassifiable result was treated as passing:\n${run.output}`).not.toBe(0);
  });

  it('Aggregator_UnreadableNeedsContext_Reddens', () => {
    // If the aggregator cannot read the context, it cannot prove any lane
    // ran — the one thing it exists to prove.
    const workflow = loadWorkflow(CI_WORKFLOW_PATH);
    for (const malformed of ['', 'not json', '[]', 'null', '{}']) {
      const run = runAggregator(workflow, malformed);
      expect(run.status, `malformed needs context ${JSON.stringify(malformed)} passed:\n${run.output}`).not.toBe(0);
    }
  });
});
