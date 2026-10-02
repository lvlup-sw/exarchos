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
 * Wrapper-script reach for each `run:` step in the workflow set, computed once.
 * The map key is the parsed step object, so the index and {@link resolveHosts} read the same step.
 */
export interface ShellIndirectionIndex {
  readonly byStep: ReadonlyMap<WorkflowStep, readonly ShellExecution[]>;
  /** Every `run:` step examined — zero means the resolver walked nothing. */
  readonly runStepsWalked: number;
  /** Distinct wrapper scripts actually read. */
  readonly wrapperScriptsWalked: readonly string[];
  /** Invocation words with variables that the walk cannot resolve. */
  readonly unresolvedInvocations: readonly string[];
}

/**
 * True when the expanded command text of a step executes `artifact`.
 * The match tries the artifact path as repo-relative and as relative to the working directory of the step.
 */
function commandExecutes(command: string, artifact: string, workingDir: string): boolean {
  const candidates = [artifact];
  if (workingDir !== '' && artifact.startsWith(`${workingDir}/`)) {
    candidates.push(artifact.slice(workingDir.length + 1));
  }
  return candidates.some((candidate) => command.includes(candidate));
}

/**
 * The path operands of a `vitest run …` tail.
 * A token is a file operand only when it holds `/` or ends in a JavaScript or TypeScript extension.
 * Without this rule, the `unit` in `--project unit` reads as a file filter, and a guard whose only host is the root suite resolves as unreachable.
 */
export function vitestPathOperands(tail: string): string[] {
  return tail
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith('-'))
    .filter((token) => !/^(&&|\|\||;)$/.test(token))
    .filter((token) => token.includes('/') || /\.[cm]?[jt]s$/.test(token));
}

/**
 * True when a job runs the vitest suite that collects `testPath`, from an npm-expanded `vitest run` step.
 * `vitest bench` does not count, because it collects only `*.bench.ts`.
 * A `--project` list must select a project of the test.
 * A step with explicit paths counts only when one path is a prefix of the test file. Otherwise each single-file re-assert step reads as a run of the whole suite.
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
 * Walk each `run:` step once and record what it reaches through shell wrappers.
 * One pass over the workflow set makes the walk counts describe the resolver, not the last guard that was asked.
 * The walk anchors `$GITHUB_WORKSPACE` at the checkout root, as the workflow steps do.
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

/**
 * Resolve each CI host of one guard artifact. A job hosts the guard in three ways:
 * - a step runs the artifact after npm-script expansion (`direct`).
 * - a step runs a shell wrapper that runs the artifact (`direct`, with the wrapper chain in `through`).
 * - a step runs a self-test of the artifact, or the job runs a vitest suite that collects one (`self-test`).
 *
 * A wrapper chain through a self-test of the guard is `self-test`, because it runs against seeded fixtures.
 * Several matching steps swallow the exit only when each step swallows it.
 */
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

      let directSwallowed: boolean | null = null;
      let selfTestSwallowed: boolean | null = null;
      const indirect = new Map<string, { through: readonly string[]; swallowed: boolean }>();
      const noteIndirect = (execution: ShellExecution, stepSwallowed: boolean): void => {
        const key = execution.through.join(' → ');
        const swallowed = stepSwallowed || execution.exitSwallowed;
        const prior = indirect.get(key);
        if (prior === undefined) indirect.set(key, { through: execution.through, swallowed });
        else indirect.set(key, { through: prior.through, swallowed: prior.swallowed && swallowed });
      };
      const viaFor = (through: readonly string[]): HostingVia =>
        through.some((script) => selfTests.includes(script)) ? 'self-test' : 'direct';
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        const workingDir = stepWorkingDirectory(job, step);
        const expanded = expandNpmScripts(step.run, ctx.rootPkg);
        const swallowed = stepSwallowsExit(job, step);
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
