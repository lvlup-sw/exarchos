/**
 * Handler for the `prepare_synthesis` action. It runs the readiness checks before synthesis: task completion, test suite, typecheck, document coverage and branch stack.
 * It emits a `gate.executed` event for the test suite, the typecheck and the document leg.
 */

import { execSync, execFileSync } from 'node:child_process';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { runCommandSync } from '../../utils/process.js';
import { resolveRunnableCommand, type RunnableCommand } from '../../config/test-runtime-resolver.js';
import { resolveWorkflowState } from '../resolve-state.js';
import { emitGateEvent } from '../gates/gate-utils.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { globToRegExp } from '../../architecture/glob-to-regexp.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from '../gates/gate-runner.js';

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

/**
 * Runs a resolved command in `repoRoot` in argument form, with no shell. The caller names the tree,
 * and the server working directory is never used.
 */
function runLeg(
  command: Extract<RunnableCommand, { kind: 'runnable' }>,
  repoRoot: string,
  timeout: number,
): LegRun {
  try {
    const output = runCommandSync(command.bin, command.args, {
      cwd: repoRoot,
      encoding: 'buffer',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitedZero: true, output: outputText(output) };
  } catch (err: unknown) {
    const execError = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output = [execError.stdout, execError.stderr]
      .filter((chunk): chunk is Buffer | string => chunk !== undefined && chunk !== null)
      .map(outputText)
      .join('\n');
    const message = err instanceof Error ? err.message : String(err);
    return { exitedZero: false, output: output.trim().length > 0 ? output : message };
  }
}

function outputText(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
}

/** Runs the resolved test command. No resolved command fails the leg. */
function runTestSuite(repoRoot: string): TestResult {
  const resolved = resolveRunnableCommand(repoRoot, 'test');
  if (resolved.kind !== 'runnable') {
    return { passed: false, passCount: 0, failCount: 0, command: null, reason: resolved.reason };
  }
  const run = runLeg(resolved, repoRoot, 120_000);
  const { passCount, failCount } = parseTestOutput(run.output);
  return { passed: run.exitedZero, passCount, failCount, command: resolved.command, output: run.output };
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
function runTypecheck(repoRoot: string): TypecheckResult {
  const resolved = resolveRunnableCommand(repoRoot, 'typecheck');
  if (resolved.kind === 'unresolved') {
    return { passed: true, errorCount: 0, command: null, reason: resolved.reason };
  }
  if (resolved.kind === 'invalid') {
    return { passed: false, errorCount: 1, command: null, errors: [resolved.reason], reason: resolved.reason };
  }
  const run = runLeg(resolved, repoRoot, 60_000);
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

/** Returns the default branch from `origin/HEAD`, or `'main'`. A branch name with unexpected characters also gives `'main'`, which prevents command injection. */
function detectDefaultBranch(repoRoot: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const branch = ref.replace('refs/remotes/origin/', '');
    return /^[a-zA-Z0-9/_.-]+$/.test(branch) ? branch : 'main';
  } catch {
    return 'main';
  }
}

function verifyStack(repoRoot: string): StackResult {
  try {
    const baseBranch = detectDefaultBranch(repoRoot);
    const output = execSync(`git log --oneline --graph ${baseBranch}..HEAD`, {
      cwd: repoRoot,
      encoding: 'buffer',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = output.toString('utf-8');
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
 * Returns the names of the files that changed between the default branch and HEAD.
 * It returns `null`, not `[]`, when git fails, so the caller can fail closed and not waive a blocking leg.
 * It uses the argv form of `execFileSync`, so no shell runs.
 */
function changedFilesAgainstBase(repoRoot: string): string[] | null {
  try {
    const baseBranch = detectDefaultBranch(repoRoot);
    const output = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      cwd: repoRoot,
      encoding: 'buffer',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output
      .toString('utf-8')
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

export async function handlePrepareSynthesis(
  args: PrepareSynthesisArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'prepare-synthesis',
    requirementId: 'requirement:prepare-synthesis',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) => createEvidenceSubject(
      { kind: 'phase-attempt', phaseAttemptId },
      { gate: 'prepare-synthesis' },
    ),
    providerInput: args,
    executeProvider: async () => executePrepareSynthesis(args, stateDir, eventStore),
  });
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

    const tests = runTestSuite(repoRoot);
    await emitGateEvent(store, streamId, 'test-suite', 'CI', tests.passed, {
      dimension: 'D1',
      phase: 'synthesize',
      passCount: tests.passCount,
      failCount: tests.failCount,
      command: tests.command,
      ...(tests.reason !== undefined ? { reason: tests.reason } : {}),
    });

    const typecheck = runTypecheck(repoRoot);
    if (typecheck.command !== null || !typecheck.passed) {
      await emitGateEvent(store, streamId, 'typecheck', 'CI', typecheck.passed, {
        dimension: 'D1',
        phase: 'synthesize',
        errorCount: typecheck.errorCount,
        errors: typecheck.errors,
        command: typecheck.command,
      });
    }

    const stack = verifyStack(repoRoot);

    const docCfg = args.projectConfig?.synthesis?.documentLeg ?? DEFAULT_DOCUMENT_LEG;
    const changedFiles = changedFilesAgainstBase(repoRoot);
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
    return {
      success: false,
      error: {
        code: 'PREPARE_SYNTHESIS_FAILED',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
