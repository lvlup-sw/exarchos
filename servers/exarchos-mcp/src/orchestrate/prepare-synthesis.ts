// ─── Prepare Synthesis Composite Action ─────────────────────────────────────
//
// Orchestrates pre-synthesis readiness checks: task completion, test suite,
// typecheck, and branch stack health. Emits gate.executed events for both
// SynthesisReadinessView and CodeQualityView flywheel integration.
//
// DR-26: this is the MERGED synthesis-readiness gate — the former
// `pre_synthesis_check` action is a deprecated alias that routes here (see
// `composite.ts`). Test/typecheck commands resolve through the layered
// toolchain resolver (`resolveTestRuntime`, INV-6) — never a hardcoded
// package-manager literal — so monorepo roots, non-node toolchains, and
// `.exarchos.yml` overrides all pick the right command (#1537 class).
// ────────────────────────────────────────────────────────────────────────────

import { execSync, execFileSync } from 'node:child_process';
import { runCommandSync } from '../utils/process.js';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { resolveTestRuntime } from '../config/test-runtime-resolver.js';
import { splitCommand } from '../config/tokenize-command.js';
import { resolveWorkflowState } from './resolve-state.js';
import { emitGateEvent } from './gate-utils.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { globToRegExp } from '../architecture/glob-to-regexp.js';

// ─── Result Types ──────────────────────────────────────────────────────────

interface SynthesisReadinessState {
  tasksComplete: boolean;
  testsPass: boolean;
  typecheckPass: boolean;
  documentReady: boolean;
  stackHealthy: boolean;
}

interface TestResult {
  passed: boolean;
  passCount: number;
  failCount: number;
  output?: string;
  /** True when the leg did not run (skipTests, or no resolvable test command). */
  skipped?: boolean;
  /** The resolver-routed command that ran (null when skipped). */
  command?: string | null;
}

interface TypecheckResult {
  passed: boolean;
  errorCount: number;
  errors?: string[];
  /** True when the leg did not run (skipTests, or no resolvable typecheck command). */
  skipped?: boolean;
  /** The resolver-routed command that ran (null when skipped). */
  command?: string | null;
}

interface StackResult {
  healthy: boolean;
  branches?: string[];
  error?: string;
  /** True when the caller asked to skip the stack check (skipStack). */
  skipped?: boolean;
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

// ─── Command Resolution (DR-26 / #1537) ────────────────────────────────────
//
// Test + typecheck commands come from the layered toolchain resolver — the
// single source of truth for toolchain identity (`config/toolchains.ts`). An
// explicit `testCommand` rides the resolver's override tier; `unresolved`
// degrades to a graceful SKIP (the #1174 contract: never run a guessed
// package-manager command against an unknown project layout).

interface ResolvedGateCommands {
  readonly test: string | null;
  readonly typecheck: string | null;
  readonly remediation?: string;
}

function resolveGateCommands(repoRoot: string, testCommand?: string): ResolvedGateCommands {
  try {
    const resolved = resolveTestRuntime(
      repoRoot,
      testCommand ? { override: { test: testCommand } } : undefined,
    );
    if (resolved.source === 'unresolved') {
      return {
        test: null,
        typecheck: null,
        remediation: resolved.remediation ?? 'no test runtime resolved',
      };
    }
    return { test: resolved.test, typecheck: resolved.typecheck };
  } catch (err) {
    return {
      test: null,
      typecheck: null,
      remediation: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Decode a runCommandSync return (string | Buffer) to utf-8 text. */
function commandOutputText(output: string | Buffer): string {
  return typeof output === 'string' ? output : output.toString('utf-8');
}

/** Collect stdout+stderr text from a thrown exec error. */
function execErrorText(err: unknown): string {
  const execError = err as { stdout?: Buffer | string; stderr?: Buffer | string };
  return [execError.stdout, execError.stderr]
    .filter((chunk): chunk is Buffer | string => chunk instanceof Buffer || typeof chunk === 'string')
    .map((chunk) => commandOutputText(chunk))
    .join('\n');
}

// ─── Test Runner ───────────────────────────────────────────────────────────

function runTestSuite(command: string | null, cwd: string, remediation?: string): TestResult {
  if (command === null) {
    // Graceful skip (#1174): no resolvable test command is a SKIP with
    // remediation, never a guessed hardcoded invocation.
    return {
      passed: true,
      passCount: 0,
      failCount: 0,
      skipped: true,
      command: null,
      ...(remediation !== undefined ? { output: remediation } : {}),
    };
  }
  const { cmd, args } = splitCommand(command);
  if (cmd === '') {
    return { passed: false, passCount: 0, failCount: 0, command, output: 'empty test command' };
  }
  try {
    // runCommandSync (not raw execSync): the resolved test command may be a
    // package-manager shim whose `.cmd` launcher execFile refuses to start on
    // Windows since CVE-2024-27980 (#1623); argv-form also removes the shell.
    const output = runCommandSync(cmd, args as string[], {
      cwd,
      encoding: 'buffer',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = commandOutputText(output);
    const { passCount, failCount } = parseTestOutput(text);
    return { passed: true, passCount, failCount, output: text, command };
  } catch (err: unknown) {
    const text = execErrorText(err);
    const { passCount, failCount } = parseTestOutput(text);
    return { passed: false, passCount, failCount, output: text, command };
  }
}

function parseTestOutput(output: string): { passCount: number; failCount: number } {
  // Match patterns like "10 passed" and "2 failed"
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  return {
    passCount: passMatch ? parseInt(passMatch[1] ?? '0', 10) : 0,
    failCount: failMatch ? parseInt(failMatch[1] ?? '0', 10) : 0,
  };
}

// ─── Typecheck Runner ──────────────────────────────────────────────────────

function runTypecheck(command: string | null, cwd: string): TypecheckResult {
  if (command === null) {
    // No resolvable typecheck command (many toolchains have none) — skip.
    return { passed: true, errorCount: 0, skipped: true, command: null };
  }
  const { cmd, args } = splitCommand(command);
  if (cmd === '') {
    return { passed: false, errorCount: 1, errors: ['empty typecheck command'], command };
  }
  try {
    runCommandSync(cmd, args as string[], {
      cwd,
      encoding: 'buffer',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, errorCount: 0, command };
  } catch (err: unknown) {
    const text = execErrorText(err);
    const errors = parseTypecheckErrors(text);
    return { passed: false, errorCount: errors.length, errors, command };
  }
}

function parseTypecheckErrors(output: string): string[] {
  // Match lines like "error TS2322: ..."
  const errorLines = output.split('\n').filter((line) => line.includes('error TS'));
  return errorLines.length > 0 ? errorLines : output.trim() ? [output.trim()] : [];
}

// ─── Default Branch Detection ─────────────────────────────────────────────

function detectDefaultBranch(cwd: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const branch = ref.replace('refs/remotes/origin/', '');
    // Sanitize to prevent command injection via crafted ref names
    return /^[a-zA-Z0-9/_.-]+$/.test(branch) ? branch : 'main';
  } catch {
    return 'main';
  }
}

// ─── Stack Verifier ────────────────────────────────────────────────────────

function verifyStack(cwd: string): StackResult {
  try {
    const baseBranch = detectDefaultBranch(cwd);
    const output = execSync(`git log --oneline --graph ${baseBranch}..HEAD`, {
      cwd,
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

// ─── DR-2: Document-Readiness Leg (#1594) ───────────────────────────────────

export type DocumentLegConfig = ResolvedProjectConfig['synthesis']['documentLeg'];

/**
 * Behavior-neutral default when no resolved config is threaded (e.g. a unit
 * test invoking the handler without `projectConfig`): advisory severity + empty
 * surface globs ⇒ the leg auto-waives, so the absence of config is never a
 * blocker.
 */
const DEFAULT_DOCUMENT_LEG: DocumentLegConfig = {
  severity: 'advisory',
  surfaceGlobs: [],
  docGlobs: ['docs/**', '**/*.md'],
};

export interface DocumentLegResult {
  /** false ⇒ auto-waived: no doc-bearing surface was touched. */
  readonly evaluated: boolean;
  /** docs changed (or auto-waived). false ⇒ a doc-bearing surface changed with no doc update. */
  readonly covered: boolean;
  readonly severity: 'advisory' | 'blocking';
  readonly surfaceFiles: readonly string[];
  readonly message?: string;
}

/**
 * Evaluate the `document` readiness leg structurally: when the changeset touches
 * a configured doc-bearing surface, a configured doc path must also have changed
 * — otherwise the leg is uncovered. Pure: the caller supplies the changed-file
 * list (from `git diff --name-only`), so the rule itself is deterministic and
 * directly testable. No doc-bearing surface touched ⇒ auto-waive (the
 * no-ceremony default for ordinary changes). INV-6: no workflow-type branch —
 * the same rule holds for every workflow type.
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
 * Whether the document leg BLOCKS synthesis readiness. Only a `'blocking'`
 * severity on an evaluated-and-uncovered leg blocks; an advisory uncovered leg
 * still records `gate.executed { passed:false }` (visible) but does not block.
 */
export function documentLegBlocks(result: DocumentLegResult): boolean {
  return result.evaluated && !result.covered && result.severity === 'blocking';
}

/**
 * Changed files between the default base branch and HEAD (name-only). Returns
 * `null` — NOT `[]` — when git detection fails, so the document-leg caller can
 * tell "no surface changed" apart from "couldn't determine" and fail CLOSED on
 * the latter rather than silently auto-waiving a blocking leg. argv-form
 * `execFileSync` (not shell-form `execSync`) eliminates the shell surface even
 * though `baseBranch` is already sanitized by `detectDefaultBranch`.
 */
function changedFilesAgainstBase(cwd: string): string[] | null {
  try {
    const baseBranch = detectDefaultBranch(cwd);
    const output = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      cwd,
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

// ─── Task Readiness Check ──────────────────────────────────────────────────

/** Minimal shape of a task entry in the canonical workflow-state projection. */
interface ResolvedTaskEntry {
  readonly id: string;
  readonly status: string;
}

function checkTaskCompletion(
  tasks: readonly ResolvedTaskEntry[],
): { allComplete: boolean; blockers: string[] } {
  if (tasks.length === 0) {
    return { allComplete: true, blockers: [] };
  }

  const blockers: string[] = [];
  for (const task of tasks) {
    // #1536: the canonical workflowStateProjection uses status 'complete' (not
    // 'completed' — the value the old task-detail materializer used). Matching
    // the canonical value here is what keeps readiness in lock-step with
    // exarchos_workflow get and eliminates phantom in-progress blockers.
    if (task.status !== 'complete') {
      blockers.push(`Task '${task.id}' is ${task.status}`);
    }
  }

  return { allComplete: blockers.length === 0, blockers };
}

// ─── Handler ───────────────────────────────────────────────────────────────

/**
 * Args for the merged synthesis-readiness gate (DR-26). `featureId` OR
 * `stateFile` — the handler enforces "at least one source" (#1499 contract,
 * inherited from the merged-away `pre_synthesis_check`). The skip flags +
 * `repoRoot`/`testCommand` are the alias-compat surface: `testCommand` rides
 * the toolchain resolver's override tier.
 */
export interface PrepareSynthesisArgs {
  featureId?: string;
  stateFile?: string;
  repoRoot?: string;
  skipTests?: boolean;
  skipStack?: boolean;
  testCommand?: string;
  projectConfig?: ResolvedProjectConfig;
}

export async function handlePrepareSynthesis(
  args: PrepareSynthesisArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // 1. Validate input — at least one state source (#1499: stateFile-only
  //    callers stay supported through the deprecation window).
  if (!args.featureId && !args.stateFile) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId or stateFile is required' },
    };
  }

  // The event stream to emit gates on. Absent for stateFile-only callers —
  // gate emission is skipped in that case (no stream to append to).
  const streamId = args.featureId;
  const repoRoot = args.repoRoot ?? process.cwd();

  try {
    const store = eventStore;

    // 2. Resolve task status from the CANONICAL source — resolveWorkflowState,
    //    the same event-store projection exarchos_workflow get reads (#1536).
    //    The old task-detail materializer could fold a divergent task array
    //    (phantom in-progress), phantom-blocking synthesis on tasks the
    //    canonical state showed complete. An explicit `stateFile` still wins
    //    inside the resolver (file → event-store fallback).
    const resolved = await resolveWorkflowState({
      stateFile: args.stateFile,
      featureId: streamId,
      eventStore: store,
    });
    if ('error' in resolved) {
      return resolved.error;
    }
    const tasks = (resolved.state.tasks as ResolvedTaskEntry[] | undefined) ?? [];

    // 3. Check task completion — early return if tasks not all complete
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
        tests: { passed: false, passCount: 0, failCount: 0 },
        typecheck: { passed: false, errorCount: 0 },
        document: { evaluated: false, covered: false, severity: 'advisory', surfaceFiles: [] },
        stack: { healthy: false },
      };

      return { success: true, data: result };
    }

    // 4. Resolve the test/typecheck commands ONCE via the layered toolchain
    //    resolver (DR-26 / INV-6) and run the suite. `skipTests` skips both
    //    command legs (the alias-compat contract of the merged-away
    //    `pre_synthesis_check`); a skipped leg counts as non-blocking and
    //    emits NO gate.executed (no fake CI greens in the flywheel).
    const commands: ResolvedGateCommands = args.skipTests
      ? { test: null, typecheck: null, remediation: 'skipped (skipTests)' }
      : resolveGateCommands(repoRoot, args.testCommand);
    const tests = args.skipTests
      ? { passed: true, passCount: 0, failCount: 0, skipped: true, command: null } satisfies TestResult
      : runTestSuite(commands.test, repoRoot, commands.remediation);

    // 5. Emit gate.executed event for test-suite (feeds flywheel) — only when
    //    the leg actually ran and a stream exists to emit on.
    if (streamId !== undefined && tests.skipped !== true) {
      await emitGateEvent(store, streamId, 'test-suite', 'CI', tests.passed, {
        dimension: 'D1',
        phase: 'synthesize',
        passCount: tests.passCount,
        failCount: tests.failCount,
      });
    }

    // 6. Run typecheck (resolver-routed; skipped alongside tests)
    const typecheck = args.skipTests
      ? { passed: true, errorCount: 0, skipped: true, command: null } satisfies TypecheckResult
      : runTypecheck(commands.typecheck, repoRoot);

    // 7. Emit gate.executed event for typecheck (feeds flywheel)
    if (streamId !== undefined && typecheck.skipped !== true) {
      await emitGateEvent(store, streamId, 'typecheck', 'CI', typecheck.passed, {
        dimension: 'D1',
        phase: 'synthesize',
        errorCount: typecheck.errorCount,
        errors: typecheck.errors,
      });
    }

    // 8. Verify branch stack
    const stack: StackResult = args.skipStack === true
      ? { healthy: true, skipped: true }
      : verifyStack(repoRoot);

    // 9. Evaluate the document-readiness leg (DR-2, #1594) and emit its gate.
    //    Roster order is task-completion→tests→typecheck→document→stack; gate
    //    EMISSION order here is immaterial (the readiness view folds
    //    gate.executed by name), so the leg is evaluated after the stack check.
    //    `passed` reflects structural coverage; whether an uncovered leg BLOCKS
    //    readiness is the severity decision (documentLegBlocks).
    const docCfg = args.projectConfig?.synthesis?.documentLeg ?? DEFAULT_DOCUMENT_LEG;
    const changedFiles = changedFilesAgainstBase(repoRoot);
    // Fail CLOSED when git detection is unavailable: report the leg as
    // evaluated-but-uncovered so a `blocking` severity blocks readiness instead
    // of being silently auto-waived (an empty-list waive would bypass the gate).
    // An `advisory` leg still only records a visible `gate.executed{passed:false}`.
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
    if (streamId !== undefined) {
      await emitGateEvent(store, streamId, 'document-coverage', 'synthesize', documentLeg.covered, {
        dimension: 'D1',
        phase: 'synthesize',
        evaluated: documentLeg.evaluated,
        severity: documentLeg.severity,
        surfaceFiles: documentLeg.surfaceFiles,
        ...(documentLeg.message !== undefined ? { message: documentLeg.message } : {}),
      });
    }

    // 10. Build readiness state
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
    if (!readiness.testsPass) allBlockers.push('Test suite failed');
    if (!readiness.typecheckPass) allBlockers.push('Typecheck failed');
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
