/**
 * Handler for the `prepare_synthesis` action. It runs the readiness checks before synthesis: task completion, test suite, typecheck, document coverage and branch stack.
 * It emits a `gate.executed` event for the test suite, the typecheck and the document leg.
 *
 * The local approved-check executor runs the test and typecheck legs in one lifecycle check of the phase attempt, with no verifier provisioning.
 * The stack and changed-file legs read Git only through the constrained reader with the process-wide Git path.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveRunnableCommand, type RunnableCommand } from '../../config/test-runtime-resolver.js';
import { resolveWorkflowState } from '../resolve-state.js';
import { emitGateEvent, observeCurrentCheckout, type CurrentCheckoutRead } from '../gates/gate-utils.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { globToRegExp } from '../../architecture/glob-to-regexp.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { processObservationalGitPath } from '../../utils/git-tree.js';
import { HostedAdequacyPending, hostedPendingResult, runPhaseGateWithEvidence } from '../gates/gate-runner.js';
import { admitLifecycleLegs, type LifecycleLeg } from '../verification/lifecycle-check.js';
import type { CheckExecutor } from '../verification/check-executor.js';

interface SynthesisReadinessState {
  tasksComplete: boolean;
  testsPass: boolean;
  typecheckPass: boolean;
  documentReady: boolean;
  stackHealthy: boolean;
}

/**
 * The test leg. `passed` is the exit status of the resolved command. The counts
 * are read from its output where the runner prints them, else they are 0.
 * `command` is null when no test command resolved, and then the leg fails.
 */
interface TestResult {
  passed: boolean;
  passCount: number;
  failCount: number;
  command: string | null;
  output?: string;
  reason?: string;
}

/**
 * The typecheck leg. `command` is null when the toolchain declares no typecheck
 * command. Then the leg does not run and does not block. A typecheck command
 * that resolves but cannot be parsed fails the leg.
 */
interface TypecheckResult {
  passed: boolean;
  errorCount: number;
  command: string | null;
  errors?: string[];
  reason?: string;
}

interface StackResult {
  healthy: boolean;
  branches?: string[];
  error?: string;
}

interface PrepareSynthesisResult {
  ready: boolean;
  readiness: SynthesisReadinessState;
  blockers?: string[];
  tests: TestResult;
  typecheck: TypecheckResult;
  document: DocumentLegResult;
  stack: StackResult;
}

/** The outcome of one resolved command, decided by its exit status. */
interface LegRun {
  readonly exitedZero: boolean;
  readonly output: string;
}

/** The runner of one leg. The local runner reads the observed leg of that kind. */
type LegRunner = (
  kind: LifecycleLeg['kind'], command: Extract<RunnableCommand, { kind: 'runnable' }>, repoRoot: string, timeout: number,
) => LegRun;

/** A leg that the approved plan does not hold refuses here and never runs. */
const unplannedLeg: LegRunner = (kind) => {
  throw new Error(`The ${kind} leg is not in the approved plan, so it does not run`);
};

/** The test and typecheck commands of one call. The call reads them once, so the plan and the legs see the same commands. */
interface LegCommands {
  readonly test: RunnableCommand;
  readonly typecheck: RunnableCommand;
}

/** Read the test and typecheck commands of the checkout once. */
function legCommandsOf(repoRoot: string): LegCommands {
  return { test: resolveRunnableCommand(repoRoot, 'test'), typecheck: resolveRunnableCommand(repoRoot, 'typecheck') };
}

/** The event store, the executor and the phase attempt that scope the legs of one call. */
interface PrepareSynthesisRun {
  readonly eventStore: EventStore;
  readonly executor?: CheckExecutor;
  readonly phaseAttemptId: () => string | undefined;
}

/**
 * Run each resolvable leg in one local check and return a runner that reads the observed legs.
 * Both legs run in the one check. A refusal returns as the gate result. A pending result and a leg with no verdict throw the pending signal.
 * The runner refuses a leg whose command differs from the planned leg, so no command outside the plan runs.
 */
async function localLegRunner(
  streamId: string, repoRoot: string, run: PrepareSynthesisRun, commands: LegCommands,
): Promise<LegRunner | ToolResult> {
  const legs: LifecycleLeg[] = [];
  for (const [kind, resolved] of [['command', commands.test], ['typecheck', commands.typecheck]] satisfies [LifecycleLeg['kind'], RunnableCommand][]) {
    if (resolved.kind === 'runnable') legs.push({ kind, argv: [resolved.bin, ...resolved.args] });
  }
  if (legs.length === 0) return unplannedLeg;
  const phaseAttemptId = run.phaseAttemptId();
  const admitted = await admitLifecycleLegs({
    eventStore: run.eventStore, checkout: repoRoot, legs, streamId, ...(phaseAttemptId === undefined ? {} : { phaseAttemptId }),
    ...(run.executor === undefined ? {} : { executor: run.executor }),
  });
  if ('success' in admitted) return admitted;
  return (kind, command) => {
    const planned = legs.find((leg) => leg.kind === kind);
    if (planned === undefined || planned.argv.join('\0') !== [command.bin, ...command.args].join('\0')) return unplannedLeg(kind, command, repoRoot, 0);
    const observed = admitted.find((leg) => leg.kind === kind)?.run;
    if (observed === undefined) throw new Error(`The executor returned no ${kind} leg`);
    const output = [observed.stdout, observed.stderr].filter((chunk) => chunk.length > 0).join('\n');
    return { exitedZero: observed.exitCode === 0, output };
  };
}

/** Runs the resolved test command. No resolved command fails the leg. */
function runTestSuite(repoRoot: string, run: LegRunner, resolved: RunnableCommand): TestResult {
  if (resolved.kind !== 'runnable') {
    return { passed: false, passCount: 0, failCount: 0, command: null, reason: resolved.reason };
  }
  return testResultOf(resolved.command, run('command', resolved, repoRoot, 120_000));
}

/** The test leg result of one run. */
function testResultOf(command: string, run: LegRun): TestResult {
  const { passCount, failCount } = parseTestOutput(run.output);
  return { passed: run.exitedZero, passCount, failCount, command, output: run.output };
}

/** Counts printed as "<n> passed" and "<n> failed". Informational only. */
function parseTestOutput(output: string): { passCount: number; failCount: number } {
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  return {
    passCount: passMatch ? parseInt(passMatch[1] ?? '0', 10) : 0,
    failCount: failMatch ? parseInt(failMatch[1] ?? '0', 10) : 0,
  };
}

/** Runs the resolved typecheck command when the toolchain declares one. */
function runTypecheck(repoRoot: string, runner: LegRunner, resolved: RunnableCommand): TypecheckResult {
  if (resolved.kind === 'unresolved') {
    return { passed: true, errorCount: 0, command: null, reason: resolved.reason };
  }
  if (resolved.kind === 'invalid') {
    return { passed: false, errorCount: 1, command: null, errors: [resolved.reason], reason: resolved.reason };
  }
  const run = runner('typecheck', resolved, repoRoot, 60_000);
  if (run.exitedZero) {
    return { passed: true, errorCount: 0, command: resolved.command };
  }
  const errors = parseTypecheckErrors(run.output, resolved.command);
  return { passed: false, errorCount: errors.length, command: resolved.command, errors };
}

/**
 * Returns the TypeScript error lines when the output has them, or else the whole output as one error.
 * A failed run always gives at least one error.
 */
function parseTypecheckErrors(output: string, command: string): string[] {
  const errorLines = output.split('\n').filter((line) => line.includes('error TS'));
  if (errorLines.length > 0) return errorLines;
  const trimmed = output.trim();
  return [trimmed.length > 0 ? trimmed : `${command} exited with a non-zero status`];
}

/** The default base name when the origin HEAD symbolic ref does not read. */
const DEFAULT_BASE_NAME = 'main';

/** The prefix of the origin HEAD target. The rest is the base name. */
const ORIGIN_REF_PREFIX = 'refs/remotes/origin/';

/** The observed checkout of the stack and changed-file legs with its resolved base commit, or the cause of a refusal. */
type SynthesisCheckout =
  | { readonly kind: 'observed'; readonly read: Extract<CurrentCheckoutRead, { kind: 'observed' }>; readonly base: string }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Observe the checkout root above `repoRoot` once with the process-wide Git path, and resolve the base.
 * The base name is the origin HEAD target with no `refs/remotes/origin/` prefix, or `main` when that ref does not read.
 * The name resolves by the closed base-name order, so a local branch comes first, as `main...HEAD` resolves today.
 * An unusable Git path, a refused observation and a refused base give a refusal, and no leg reads Git after it.
 */
async function synthesisCheckout(gitPath: string | undefined, repoRoot: string): Promise<SynthesisCheckout> {
  if (gitPath === undefined) return { kind: 'refused', reason: 'No usable Git executable observes the checkout.' };
  const read = await observeCurrentCheckout(gitPath, repoRoot);
  if (read.kind === 'refused') return read;
  const { observer, checkout } = read;
  let name = DEFAULT_BASE_NAME;
  try {
    const target = (await observer.reads.originHead(checkout.gitDir, checkout.checkout)).trim();
    if (target.startsWith(ORIGIN_REF_PREFIX) && target.length > ORIGIN_REF_PREFIX.length) name = target.slice(ORIGIN_REF_PREFIX.length);
  } catch {
    name = DEFAULT_BASE_NAME;
  }
  const base = await observer.base(checkout, name);
  return base.kind === 'observed' ? { kind: 'observed', read, base: base.value } : base;
}

/** The commits of the stack from the base to the head, as one-line graph entries. A refused checkout or a failed read is not healthy. */
async function verifyStack(synthesis: SynthesisCheckout): Promise<StackResult> {
  if (synthesis.kind === 'refused') return { healthy: false, branches: [], error: synthesis.reason };
  const { observer, checkout } = synthesis.read;
  try {
    const text = await observer.reads.commitRange(checkout.gitDir, checkout.checkout, synthesis.base, checkout.head);
    const branches = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { healthy: branches.length > 0, branches };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { healthy: false, branches: [], error: message };
  }
}

export type DocumentLegConfig = ResolvedProjectConfig['synthesis']['documentLeg'];

/** Default when the call has no `projectConfig`. The severity is advisory and the surface globs are empty, so the leg waives and is never a blocker. */
const DEFAULT_DOCUMENT_LEG: DocumentLegConfig = {
  severity: 'advisory',
  surfaceGlobs: [],
  docGlobs: ['docs/**', '**/*.md'],
};

export interface DocumentLegResult {
  /** False when the leg waived because the changeset touched no doc-bearing surface. */
  readonly evaluated: boolean;
  /** False when a doc-bearing surface changed with no doc update. True when docs changed or the leg waived. */
  readonly covered: boolean;
  readonly severity: 'advisory' | 'blocking';
  readonly surfaceFiles: readonly string[];
  readonly message?: string;
}

/**
 * Evaluates the `document` readiness leg. When the changeset touches a doc-bearing surface, a doc path must also change, or the leg is uncovered.
 * When no doc-bearing surface changed, the leg waives.
 * It is pure over the changed-file list, and the rule is the same for every workflow type.
 */
export function evaluateDocumentLeg(
  files: readonly string[],
  cfg: DocumentLegConfig,
): DocumentLegResult {
  const matchesAny = (globs: readonly string[], f: string): boolean =>
    globs.some((g) => globToRegExp(g).test(f));
  const surfaceFiles = files.filter((f) => matchesAny(cfg.surfaceGlobs, f));
  if (surfaceFiles.length === 0) {
    return { evaluated: false, covered: true, severity: cfg.severity, surfaceFiles: [] };
  }
  const docsChanged = files.some((f) => matchesAny(cfg.docGlobs, f));
  if (docsChanged) {
    return { evaluated: true, covered: true, severity: cfg.severity, surfaceFiles };
  }
  return {
    evaluated: true,
    covered: false,
    severity: cfg.severity,
    surfaceFiles,
    message:
      `Doc-bearing surface changed without a documentation update: ${surfaceFiles.join(', ')}. ` +
      `Update the relevant docs, or tune synthesis.documentLeg in .exarchos.yml to waive.`,
  };
}

/**
 * Whether the document leg blocks synthesis readiness. Only an evaluated, uncovered leg with `'blocking'` severity blocks.
 * An advisory uncovered leg still records a failed `gate.executed`, but does not block.
 */
export function documentLegBlocks(result: DocumentLegResult): boolean {
  return result.evaluated && !result.covered && result.severity === 'blocking';
}

/**
 * Returns the names of the files that changed from the merge base of the resolved base and HEAD to HEAD. This is the meaning of `base...HEAD`.
 * It returns `null`, not `[]`, when the observation, the base, the merge base or the diff fails. The caller then fails closed and does not waive a blocking leg.
 * No merge base gives `null`, never a two-dot diff.
 */
async function changedFilesAgainstBase(synthesis: SynthesisCheckout): Promise<string[] | null> {
  if (synthesis.kind === 'refused') return null;
  const { observer, checkout } = synthesis.read;
  try {
    const mergeBase = (await observer.reads.mergeBase(checkout.gitDir, checkout.checkout, synthesis.base, checkout.head)).trim();
    const output = await observer.reads.nameOnly(checkout.gitDir, checkout.checkout, mergeBase, checkout.head);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Minimal shape of a task entry in the canonical workflow-state projection. */
interface ResolvedTaskEntry {
  readonly id: string;
  readonly status: string;
}

/** A task is complete only with status `'complete'`, the value of the canonical workflow-state projection that `exarchos_workflow get` reads. */
function checkTaskCompletion(
  tasks: readonly ResolvedTaskEntry[],
): { allComplete: boolean; blockers: string[] } {
  if (tasks.length === 0) {
    return { allComplete: true, blockers: [] };
  }

  const blockers: string[] = [];
  for (const task of tasks) {
    if (task.status !== 'complete') {
      blockers.push(`Task '${task.id}' is ${task.status}`);
    }
  }

  return { allComplete: blockers.length === 0, blockers };
}

/**
 * `repoRoot` is required and has no default, so no in-repo caller can get a verdict for an unrelated tree.
 * {@link executePrepareSynthesis} also refuses a missing value at runtime, and never falls back to `process.cwd()`.
 */
interface PrepareSynthesisArgs {
  readonly featureId: string;
  readonly repoRoot: string;
  readonly projectConfig?: ResolvedProjectConfig;
}

/**
 * Runs the readiness legs through the shared phase-gate runner.
 * The test and typecheck legs run in the local executor with no verifier provisioning. A pending result maps to its existing code with no evidence.
 *
 * @param executor - The local check executor. The default is the real executor. A test passes its own executor.
 */
export async function handlePrepareSynthesis(
  args: PrepareSynthesisArgs,
  stateDir: string,
  eventStore: EventStore,
  executor?: CheckExecutor,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  let attempt: string | undefined;
  const run: PrepareSynthesisRun = { eventStore, ...(executor === undefined ? {} : { executor }), phaseAttemptId: () => attempt };
  try {
    return await runPhaseGateWithEvidence({
      streamId: args.featureId,
      gateClass: 'prepare-synthesis',
      requirementId: 'requirement:prepare-synthesis',
      stateDir,
      eventStore,
      subject: (phaseAttemptId) => {
        attempt = phaseAttemptId;
        return createEvidenceSubject(
          { kind: 'phase-attempt', phaseAttemptId },
          { gate: 'prepare-synthesis' },
        );
      },
      providerInput: args,
      executeProvider: async () => executePrepareSynthesis(args, stateDir, eventStore, run),
    });
  } catch (error) {
    return hostedPendingResult(error);
  }
}

/**
 * Runs the readiness legs. It reads task status from `resolveWorkflowState`, the same projection that `exarchos_workflow get` reads.
 * It checks `repoRoot` after the task check, because a not-ready verdict on tasks runs no leg.
 *
 * `repoRoot` must be absolute, because a relative path resolves against the server cwd. The schema rejects it at dispatch, and this check covers direct callers.
 * The `typeof` check comes first, because `RegExp.test()` converts an array such as `['/repo']` to a string that passes.
 * When git cannot list the changed files, the document leg is uncovered, so a blocking leg blocks and does not waive.
 * Gate emission order does not matter, because the readiness view folds `gate.executed` by name.
 */
async function executePrepareSynthesis(
  args: PrepareSynthesisArgs,
  stateDir: string,
  eventStore: EventStore,
  run: PrepareSynthesisRun,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const streamId = args.featureId;

  try {
    const store = eventStore;

    const resolved = await resolveWorkflowState({ featureId: streamId, eventStore: store });
    if ('error' in resolved) {
      return resolved.error;
    }
    const tasks = (resolved.state.tasks as ResolvedTaskEntry[] | undefined) ?? [];

    const { allComplete, blockers } = checkTaskCompletion(tasks);
    if (!allComplete) {
      const readiness: SynthesisReadinessState = {
        tasksComplete: false,
        testsPass: false,
        typecheckPass: false,
        documentReady: false,
        stackHealthy: false,
      };

      const result: PrepareSynthesisResult = {
        ready: false,
        readiness,
        blockers,
        tests: { passed: false, passCount: 0, failCount: 0, command: null },
        typecheck: { passed: false, errorCount: 0, command: null },
        document: { evaluated: false, covered: false, severity: 'advisory', surfaceFiles: [] },
        stack: { healthy: false },
      };

      return { success: true, data: result };
    }

    if (!args.repoRoot) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'repoRoot is required: prepare_synthesis shells out to the test suite, ' +
            'typecheck, stack, and changed-files legs, and refuses to guess which ' +
            "repository they run against — it will not fall back to the server's " +
            'own process.cwd().',
        },
      };
    }
    if (
      typeof args.repoRoot !== 'string' ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(args.repoRoot)
    ) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'repoRoot must be an absolute path, received ' +
            (typeof args.repoRoot === 'string'
              ? `'${args.repoRoot}'`
              : `a ${typeof args.repoRoot}`) +
            ". A relative path resolves against the server's own working directory, so " +
            'the legs would measure a repository the caller never named.',
        },
      };
    }
    const repoRoot = args.repoRoot;

    const commands = legCommandsOf(repoRoot);
    const runner = await localLegRunner(streamId, repoRoot, run, commands);
    if (typeof runner !== 'function') return runner;
    const tests = runTestSuite(repoRoot, runner, commands.test);
    await emitGateEvent(store, streamId, 'test-suite', 'CI', tests.passed, {
      dimension: 'D1',
      phase: 'synthesize',
      passCount: tests.passCount,
      failCount: tests.failCount,
      command: tests.command,
      ...(tests.reason !== undefined ? { reason: tests.reason } : {}),
    });

    const typecheck = runTypecheck(repoRoot, runner, commands.typecheck);
    if (typecheck.command !== null || !typecheck.passed) {
      await emitGateEvent(store, streamId, 'typecheck', 'CI', typecheck.passed, {
        dimension: 'D1',
        phase: 'synthesize',
        errorCount: typecheck.errorCount,
        errors: typecheck.errors,
        command: typecheck.command,
      });
    }

    const synthesis = await synthesisCheckout(processObservationalGitPath(), repoRoot);
    const stack = await verifyStack(synthesis);

    const docCfg = args.projectConfig?.synthesis?.documentLeg ?? DEFAULT_DOCUMENT_LEG;
    const changedFiles = await changedFilesAgainstBase(synthesis);
    const documentLeg: DocumentLegResult = changedFiles === null
      ? {
          evaluated: true,
          covered: false,
          severity: docCfg.severity,
          surfaceFiles: [],
          message:
            'Changed-file detection failed (git unavailable); document-readiness leg '
            + 'could not be verified. Re-run synthesis, or waive via synthesis.documentLeg.',
        }
      : evaluateDocumentLeg(changedFiles, docCfg);
    await emitGateEvent(store, streamId, 'document-coverage', 'synthesize', documentLeg.covered, {
      dimension: 'D1',
      phase: 'synthesize',
      evaluated: documentLeg.evaluated,
      severity: documentLeg.severity,
      surfaceFiles: documentLeg.surfaceFiles,
      ...(documentLeg.message !== undefined ? { message: documentLeg.message } : {}),
    });

    const readiness: SynthesisReadinessState = {
      tasksComplete: allComplete,
      testsPass: tests.passed,
      typecheckPass: typecheck.passed,
      documentReady: !documentLegBlocks(documentLeg),
      stackHealthy: stack.healthy,
    };

    const ready = readiness.tasksComplete
      && readiness.testsPass
      && readiness.typecheckPass
      && readiness.documentReady
      && readiness.stackHealthy;

    const allBlockers: string[] = [];
    if (!readiness.testsPass) {
      allBlockers.push(
        tests.command === null
          ? `Test suite not run: ${tests.reason ?? 'no test command resolved'}`
          : `Test suite failed (${tests.command})`,
      );
    }
    if (!readiness.typecheckPass) {
      allBlockers.push(
        typecheck.command === null
          ? `Typecheck not run: ${typecheck.reason ?? 'the typecheck command is invalid'}`
          : `Typecheck failed (${typecheck.command})`,
      );
    }
    if (!readiness.documentReady) {
      allBlockers.push(documentLeg.message ?? 'Documentation not updated for a doc-bearing change');
    }
    if (!readiness.stackHealthy) allBlockers.push('Stack not healthy');

    const result: PrepareSynthesisResult = {
      ready,
      readiness,
      ...(allBlockers.length > 0 ? { blockers: allBlockers } : {}),
      tests,
      typecheck,
      document: documentLeg,
      stack,
    };

    return { success: true, data: result };
  } catch (err) {
    if (err instanceof HostedAdequacyPending) throw err;
    return {
      success: false,
      error: {
        code: 'PREPARE_SYNTHESIS_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
