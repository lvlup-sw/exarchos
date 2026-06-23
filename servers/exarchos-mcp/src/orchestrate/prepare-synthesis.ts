// ─── Prepare Synthesis Composite Action ─────────────────────────────────────
//
// Orchestrates pre-synthesis readiness checks: task completion, test suite,
// typecheck, and branch stack health. Emits gate.executed events for both
// SynthesisReadinessView and CodeQualityView flywheel integration.
// ────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
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
}

interface TypecheckResult {
  passed: boolean;
  errorCount: number;
  errors?: string[];
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

// ─── Test Runner ───────────────────────────────────────────────────────────

function runTestSuite(): TestResult {
  try {
    const output = execSync('npm run test:run', {
      encoding: 'buffer',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = output.toString('utf-8');
    const { passCount, failCount } = parseTestOutput(text);
    return { passed: true, passCount, failCount, output: text };
  } catch (err: unknown) {
    const execError = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const text = [execError.stdout, execError.stderr]
      .filter((chunk): chunk is Buffer => chunk instanceof Buffer)
      .map((chunk) => chunk.toString('utf-8'))
      .join('\n');
    const { passCount, failCount } = parseTestOutput(text);
    return { passed: false, passCount, failCount, output: text };
  }
}

function parseTestOutput(output: string): { passCount: number; failCount: number } {
  // Match patterns like "10 passed" and "2 failed"
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  return {
    passCount: passMatch ? parseInt(passMatch[1], 10) : 0,
    failCount: failMatch ? parseInt(failMatch[1], 10) : 0,
  };
}

// ─── Typecheck Runner ──────────────────────────────────────────────────────

function runTypecheck(): TypecheckResult {
  try {
    execSync('npm run typecheck', {
      encoding: 'buffer',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, errorCount: 0 };
  } catch (err: unknown) {
    const execError = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const text = [execError.stdout, execError.stderr]
      .filter((chunk): chunk is Buffer => chunk instanceof Buffer)
      .map((chunk) => chunk.toString('utf-8'))
      .join('\n');
    const errors = parseTypecheckErrors(text);
    return { passed: false, errorCount: errors.length, errors };
  }
}

function parseTypecheckErrors(output: string): string[] {
  // Match lines like "error TS2322: ..."
  const errorLines = output.split('\n').filter((line) => line.includes('error TS'));
  return errorLines.length > 0 ? errorLines : output.trim() ? [output.trim()] : [];
}

// ─── Default Branch Detection ─────────────────────────────────────────────

function detectDefaultBranch(): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
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

function verifyStack(): StackResult {
  try {
    const baseBranch = detectDefaultBranch();
    const output = execSync(`git log --oneline --graph ${baseBranch}..HEAD`, {
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

/** Changed files between the default base branch and HEAD (name-only). */
function changedFilesAgainstBase(): string[] {
  try {
    const baseBranch = detectDefaultBranch();
    const output = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
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
    return [];
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

export async function handlePrepareSynthesis(
  args: { featureId: string; projectConfig?: ResolvedProjectConfig },
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // 1. Validate input
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const streamId = args.featureId;

  try {
    const store = eventStore;

    // 2. Resolve task status from the CANONICAL source — resolveWorkflowState,
    //    the same event-store projection exarchos_workflow get reads (#1536).
    //    The old task-detail materializer could fold a divergent task array
    //    (phantom in-progress), phantom-blocking synthesis on tasks the
    //    canonical state showed complete.
    const resolved = await resolveWorkflowState({ featureId: streamId, eventStore: store });
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

    // 4. Run test suite
    const tests = runTestSuite();

    // 5. Emit gate.executed event for test-suite (feeds flywheel)
    await emitGateEvent(store, streamId, 'test-suite', 'CI', tests.passed, {
      dimension: 'D1',
      phase: 'synthesize',
      passCount: tests.passCount,
      failCount: tests.failCount,
    });

    // 6. Run typecheck
    const typecheck = runTypecheck();

    // 7. Emit gate.executed event for typecheck (feeds flywheel)
    await emitGateEvent(store, streamId, 'typecheck', 'CI', typecheck.passed, {
      dimension: 'D1',
      phase: 'synthesize',
      errorCount: typecheck.errorCount,
      errors: typecheck.errors,
    });

    // 8. Verify branch stack
    const stack = verifyStack();

    // 9. Evaluate the document-readiness leg (DR-2, #1594) and emit its gate.
    //    Roster order is task-completion→tests→typecheck→document→stack; gate
    //    EMISSION order here is immaterial (the readiness view folds
    //    gate.executed by name), so the leg is evaluated after the stack check.
    //    `passed` reflects structural coverage; whether an uncovered leg BLOCKS
    //    readiness is the severity decision (documentLegBlocks).
    const docCfg = args.projectConfig?.synthesis.documentLeg ?? DEFAULT_DOCUMENT_LEG;
    const documentLeg = evaluateDocumentLeg(changedFilesAgainstBase(), docCfg);
    await emitGateEvent(store, streamId, 'document-coverage', 'synthesize', documentLeg.covered, {
      dimension: 'D1',
      phase: 'synthesize',
      evaluated: documentLeg.evaluated,
      severity: documentLeg.severity,
      surfaceFiles: documentLeg.surfaceFiles,
      ...(documentLeg.message !== undefined ? { message: documentLeg.message } : {}),
    });

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
