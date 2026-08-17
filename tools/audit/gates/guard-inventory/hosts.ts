import { selfTestCandidates } from './artifact-predicates.js';
import type { GuardHost, HostingVia } from './model.js';
import { type PackageScripts, expandNpmScripts } from './package-scripts.js';
import { ROOT_ANCHOR, expandShellVars, normalizeRepoPath, shellWords } from './shell-lexer.js';
import { type ShellExecution, resolveShellExecutions } from './shell-walk.js';
import { type SuiteConfig, type SuiteMembership, suiteForTest, vitestProjectSelectors } from './vitest-projects.js';
import { AGGREGATOR_JOB, CI_WORKFLOW, type LoadedWorkflow, type Workflow, type WorkflowJob, type WorkflowStep, needsList, pathFilterKeys } from './workflows.js';

function stepWorkingDirectory(job: WorkflowJob, step: WorkflowStep): string {
  const stepDir = step['working-directory'];
  if (typeof stepDir === 'string') return stepDir === '.' ? '' : stepDir;
  const jobDir = job.defaults?.run?.['working-directory'];
  if (typeof jobDir === 'string') return jobDir === '.' ? '' : jobDir;
  return '';
}

function isTruthyFlag(value: boolean | string | undefined): boolean {
  return value === true || value === 'true';
}

/** `|| true` / `|| :` around a term, or an explicit `continue-on-error`. */
function stepSwallowsExit(job: WorkflowJob, step: WorkflowStep): boolean {
  if (isTruthyFlag(step['continue-on-error']) || isTruthyFlag(job['continue-on-error'])) return true;
  const run = step.run ?? '';
  return /\|\|\s*(true|:)\b/.test(run);
}

/** True when the workflow declares a `pull_request` trigger. */
export function runsOnPullRequest(workflow: Workflow): boolean {
  const on = workflow.on;
  if (on === 'pull_request') return true;
  if (Array.isArray(on)) return on.includes('pull_request');
  if (on !== null && typeof on === 'object') return 'pull_request' in on;
  return false;
}

export interface ResolutionContext {
  readonly workflows: readonly LoadedWorkflow[];
  readonly rootPkg: PackageScripts;
  readonly suites: readonly SuiteConfig[];
  /** `true` for every repo-relative path that exists on disk. */
  readonly exists: (path: string) => boolean;
  /**
   * Source of a repo-relative shell script, or `null` when it is not a readable
   * file. Absent means indirection is NOT followed — which
   * {@link auditGuardInventory} then reports as `[empty-indirection-walk]` rather
   * than letting a resolver that walked nothing pass as clean.
   */
  readonly readScript?: (path: string) => string | null;
  /** Precomputed wrapper-script reach, per run-step. See {@link indexShellIndirection}. */
  readonly shellIndex?: ShellIndirectionIndex;
}

/**
 * Wrapper-script reach for every `run:` step in the workflow set, computed once.
 *
 * Keyed by the parsed step OBJECT rather than by a synthesized string id, so the
 * index and {@link resolveHosts} cannot disagree about which step they are
 * talking about — they iterate the same parsed documents.
 */
export interface ShellIndirectionIndex {
  readonly byStep: ReadonlyMap<WorkflowStep, readonly ShellExecution[]>;
  /** Every `run:` step examined — zero means the resolver walked nothing. */
  readonly runStepsWalked: number;
  /** Distinct wrapper scripts actually read. */
  readonly wrapperScriptsWalked: readonly string[];
  /** Invocation words whose variables could not be resolved. */
  readonly unresolvedInvocations: readonly string[];
}

/**
 * True when a step's expanded command text executes `artifact`.
 *
 * Matching is on the artifact path, tried both repo-relative and relative to the
 * step's working directory, so a step that sets one still resolves its artifact.
 */
function commandExecutes(command: string, artifact: string, workingDir: string): boolean {
  const candidates = [artifact];
  if (workingDir !== '' && artifact.startsWith(`${workingDir}/`)) {
    candidates.push(artifact.slice(workingDir.length + 1));
  }
  return candidates.some((candidate) => command.includes(candidate));
}

/**
 * The PATH operands of a `vitest run …` tail.
 *
 * A token counts as a file operand only when it looks like a path (contains `/`
 * or carries a `.ts`/`.mts`/`.mjs` extension). Without that test, `npm run
 * test:unit` — which expands to `vitest run --project unit --project integration`
 * — reads `unit` and `integration` as file filters, and every guard whose only
 * host is the root suite resolves UNREACHABLE. That false negative is the exact
 * failure this inventory exists to prevent, so the narrower rule is deliberate.
 */
export function vitestPathOperands(tail: string): string[] {
  return tail
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith('-'))
    .filter((token) => !/^(&&|\|\||;)$/.test(token))
    .filter((token) => token.includes('/') || /\.[cm]?[jt]s$/.test(token));
}

/**
 * True when a job runs the vitest suite that collects `testPath`.
 *
 * Derived from the job's own steps: an `npm run`-expanded command containing a
 * `vitest run` invocation in the package that owns the suite. `vitest bench` is
 * NOT a suite run — it collects `*.bench.ts` only — so the benchmark job must not
 * be reported as a host of every co-located test.
 *
 * A `vitest run <explicit paths>` step counts only when one of those paths is a
 * prefix of the test file; otherwise the single-file re-assert steps
 * (`npx --no-install vitest run tests/scripts/ci-topology.test.ts`) would each read as
 * running the whole suite.
 */
function jobRunsSuiteFor(
  job: WorkflowJob,
  testPath: string,
  membership: SuiteMembership,
  ctx: ResolutionContext,
): { runs: boolean; swallowed: boolean } {
  for (const step of job.steps ?? []) {
    if (typeof step.run !== 'string') continue;
    const workingDir = stepWorkingDirectory(job, step);
    const pkg = ctx.rootPkg;
    const expanded = expandNpmScripts(step.run, pkg);
    for (const line of expanded.split('\n')) {
      const invocation = /(?:^|\s|&&|\|\|)(?:npx\s+(?:--no-install\s+)?)?vitest\s+run\b([^\n]*)/.exec(line);
      if (invocation === null) continue;
      const tail = invocation[1] ?? '';
      const selectors = vitestProjectSelectors(tail);
      // No `--project` means every project; otherwise the test must belong to a
      // SELECTED one, or this step does not collect it.
      if (selectors.length > 0 && !membership.projects.some((project) => selectors.includes(project))) continue;
      const operands = vitestPathOperands(tail);
      if (operands.length === 0) {
        return { runs: true, swallowed: stepSwallowsExit(job, step) };
      }
      const prefix = workingDir === '' ? '' : `${workingDir}/`;
      if (operands.some((op) => testPath === `${prefix}${op}` || testPath.startsWith(`${prefix}${op}`))) {
        return { runs: true, swallowed: stepSwallowsExit(job, step) };
      }
    }
  }
  return { runs: false, swallowed: false };
}

/**
 * Walk every `run:` step once and record what it reaches through shell wrappers.
 *
 * Done as ONE pass over the workflow set rather than per-guard, so the
 * non-empty-denominator numbers ({@link ShellIndirectionIndex.runStepsWalked},
 * `wrapperScriptsWalked`) describe the resolver itself and not whichever guard
 * happened to be asked about last.
 */
export function indexShellIndirection(ctx: ResolutionContext): ShellIndirectionIndex {
  const byStep = new Map<WorkflowStep, readonly ShellExecution[]>();
  const wrapperScripts = new Set<string>();
  const unresolved = new Set<string>();
  let runStepsWalked = 0;
  const read = ctx.readScript;

  for (const { doc } of ctx.workflows) {
    for (const job of Object.values(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        runStepsWalked += 1;
        if (read === undefined) continue;
        const workingDir = stepWorkingDirectory(job, step);
        const expanded = expandNpmScripts(step.run, ctx.rootPkg);
        const executions: ShellExecution[] = [];
        // The step's own text is scanned for the wrapper scripts it launches; the
        // wrappers' contents are what the walk then resolves.
        // `$GITHUB_WORKSPACE` is the checkout root — the one anchor the workflow
        // steps themselves use (`bash "$GITHUB_WORKSPACE/tools/release/npm-ci-retry.sh"`).
        const stepVars = new Map<string, string>([['GITHUB_WORKSPACE', ROOT_ANCHOR]]);
        for (const line of expanded.split('\n')) {
          for (const rawWord of shellWords(line)) {
            if (!rawWord.endsWith('.sh')) continue;
            const resolved = rawWord.includes('$') ? expandShellVars(rawWord, stepVars) : rawWord;
            if (resolved === null) continue;
            const word = normalizeRepoPath(resolved);
            if (word === null || word === '') continue;
            const candidates = [word];
            if (workingDir !== '') candidates.push(`${workingDir}/${word}`);
            for (const candidate of candidates) {
              if (read(candidate) === null) continue;
              const walk = resolveShellExecutions(candidate, read);
              for (const script of walk.scriptsWalked) wrapperScripts.add(script);
              for (const item of walk.unresolved) unresolved.add(item);
              for (const execution of walk.executions) executions.push(execution);
            }
          }
        }
        if (executions.length > 0) byStep.set(step, executions);
      }
    }
  }

  return {
    byStep,
    runStepsWalked,
    wrapperScriptsWalked: [...wrapperScripts].sort(),
    unresolvedInvocations: [...unresolved].sort(),
  };
}

/** Resolve every CI host of one guard artifact. */
export function resolveHosts(artifact: string, ctx: ResolutionContext): GuardHost[] {
  const hosts: GuardHost[] = [];
  const selfTests = selfTestCandidates(artifact).filter((c) => ctx.exists(c));

  for (const { path: workflowPath, doc } of ctx.workflows) {
    const isCi = workflowPath === CI_WORKFLOW;
    const aggregatorNeeds = new Set(isCi ? needsList(doc.jobs?.[AGGREGATOR_JOB]) : []);
    const onPullRequest = runsOnPullRequest(doc);

    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      if (jobName === AGGREGATOR_JOB) continue;
      const keys = pathFilterKeys(job);

      const record = (via: HostingVia, exitSwallowed: boolean, through: readonly string[] = []): void => {
        const blocking = isCi
          ? aggregatorNeeds.has(jobName) && !exitSwallowed
          : onPullRequest && !exitSwallowed;
        hosts.push({
          workflow: workflowPath,
          job: jobName,
          via,
          through,
          pathFilterKeys: keys,
          exitSwallowed,
          onPullRequest,
          blocking,
        });
      };

      // (a) direct execution of the artifact by a step, npm chains expanded.
      //     `directSwallowed` ANDs across matching steps: a guard run twice, once
      //     under `|| true` and once not, is still failable.
      let directSwallowed: boolean | null = null;
      // (b) direct execution of a co-located self-test by a step — the DR-10
      //     `.test.sh` re-asserts that ride the unfiltered grep-gates host so a
      //     scripts-only PR still proves the gate is failable.
      let selfTestSwallowed: boolean | null = null;
      // (a2) INDIRECT execution: a step runs a shell wrapper that runs the guard.
      //      Tracked separately from (a) so the chain survives into the verdict.
      const indirect = new Map<string, { through: readonly string[]; swallowed: boolean }>();
      const noteIndirect = (execution: ShellExecution, stepSwallowed: boolean): void => {
        const key = execution.through.join(' → ');
        const swallowed = stepSwallowed || execution.exitSwallowed;
        const prior = indirect.get(key);
        if (prior === undefined) indirect.set(key, { through: execution.through, swallowed });
        else indirect.set(key, { through: prior.through, swallowed: prior.swallowed && swallowed });
      };
      /**
       * A guard run BY ITS OWN `.test.sh` is executing against seeded fixtures, not
       * policing the repo — so that chain stays `self-test` and cannot make an
       * unwired gate read as wired. Collapsing this into `direct` would re-open the
       * exact hole {@link isEnforcingHost} exists to keep shut.
       */
      const viaFor = (through: readonly string[]): HostingVia =>
        through.some((script) => selfTests.includes(script)) ? 'self-test' : 'direct';
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        const workingDir = stepWorkingDirectory(job, step);
        const expanded = expandNpmScripts(step.run, ctx.rootPkg);
        const swallowed = stepSwallowsExit(job, step);
        // Self-test paths are checked FIRST: `…/x.test.sh` contains `…/x.test.`
        // but never `…/x.mjs`, so the two matches cannot alias. Checking the
        // artifact against a step that only names its self-test would, though —
        // hence the explicit `.test.` exclusion below.
        if (selfTests.some((selfTest) => commandExecutes(expanded, selfTest, workingDir))) {
          selfTestSwallowed = selfTestSwallowed === null ? swallowed : selfTestSwallowed && swallowed;
        }
        if (commandExecutes(expanded, artifact, workingDir)) {
          directSwallowed = directSwallowed === null ? swallowed : directSwallowed && swallowed;
        }
        for (const execution of ctx.shellIndex?.byStep.get(step) ?? []) {
          if (execution.target === artifact) noteIndirect(execution, swallowed);
          else if (selfTests.includes(execution.target)) {
            selfTestSwallowed =
              selfTestSwallowed === null
                ? swallowed || execution.exitSwallowed
                : selfTestSwallowed && (swallowed || execution.exitSwallowed);
          }
        }
      }
      if (directSwallowed !== null) record('direct', directSwallowed);
      if (selfTestSwallowed !== null) record('self-test', selfTestSwallowed);
      for (const { through, swallowed } of indirect.values()) record(viaFor(through), swallowed, through);

      // (c) execution through a co-located self-test collected by a vitest suite
      //     the job runs.
      for (const selfTest of selfTests) {
        const suite = suiteForTest(selfTest, ctx.suites);
        if (suite === null) continue;
        const { runs, swallowed } = jobRunsSuiteFor(job, selfTest, suite, ctx);
        if (runs) record('self-test', swallowed);
      }
    }
  }
  return hosts;
}

// ─── Production reachability (the R-11 axis) ─────────────────────────────────

// One entry per tree, and none nested inside another. Task 019 mapped two
// distinct source roots onto `src` and put the dissolved package's scripts
// under `scripts/core`, leaving a list that walked both trees twice — a
// silently doubled denominator for the reachability ratio below.
