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

// ─── Result Types ──────────────────────────────────────────────────────────

interface SynthesisReadinessState {
  tasksComplete: boolean;
  testsPass: boolean;
  typecheckPass: boolean;
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
  args: { featureId: string },
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
        stackHealthy: false,
      };

      const result: PrepareSynthesisResult = {
        ready: false,
        readiness,
        blockers,
        tests: { passed: false, passCount: 0, failCount: 0 },
        typecheck: { passed: false, errorCount: 0 },
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

    // 9. Build readiness state
    const readiness: SynthesisReadinessState = {
      tasksComplete: allComplete,
      testsPass: tests.passed,
      typecheckPass: typecheck.passed,
      stackHealthy: stack.healthy,
    };

    const ready = readiness.tasksComplete
      && readiness.testsPass
      && readiness.typecheckPass
      && readiness.stackHealthy;

    const allBlockers: string[] = [];
    if (!readiness.testsPass) allBlockers.push('Test suite failed');
    if (!readiness.typecheckPass) allBlockers.push('Typecheck failed');
    if (!readiness.stackHealthy) allBlockers.push('Stack not healthy');

    const result: PrepareSynthesisResult = {
      ready,
      readiness,
      ...(allBlockers.length > 0 ? { blockers: allBlockers } : {}),
      tests,
      typecheck,
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
