// ─── Task Decomposition Composite Action ────────────────────────────────────
//
// Orchestrates task decomposition quality verification by running the
// check-task-decomposition.sh script and emitting gate.executed events for
// the plan→plan-review boundary (D5: Workflow Determinism).
// ────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Types ───────────────────────────────────────────────────────────────

interface TaskDecompositionArgs {
  readonly featureId: string;
  readonly planPath: string;
}

interface TaskDecompositionMetrics {
  readonly wellDecomposed: number;
  readonly needsRework: number;
  readonly totalTasks: number;
}

interface TaskDecompositionResult {
  readonly passed: boolean;
  readonly wellDecomposed: number;
  readonly needsRework: number;
  readonly totalTasks: number;
  readonly report: string;
}

// ─── Output Parsing ──────────────────────────────────────────────────────

function parseDecompositionMetrics(output: string): TaskDecompositionMetrics {
  const wellDecomposedMatch = output.match(/Well-decomposed:\s*(\d+)\/(\d+)/);
  const needsReworkMatch = output.match(/Needs rework:\s*(\d+)\/(\d+)/);

  const totalTasks = wellDecomposedMatch
    ? parseInt(wellDecomposedMatch[2], 10)
    : needsReworkMatch
      ? parseInt(needsReworkMatch[2], 10)
      : 0;

  return {
    wellDecomposed: wellDecomposedMatch ? parseInt(wellDecomposedMatch[1], 10) : 0,
    needsRework: needsReworkMatch ? parseInt(needsReworkMatch[1], 10) : 0,
    totalTasks,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handleTaskDecomposition(
  args: TaskDecompositionArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.planPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'planPath is required' },
    };
  }

  const scriptCmd = `scripts/check-task-decomposition.sh --plan-file ${args.planPath}`;

  let stdout = '';
  let passed = false;

  try {
    const output = execSync(scriptCmd, {
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdout = Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
    passed = true;
  } catch (err: unknown) {
    const execError = err as {
      status?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };

    // Exit code 2 = input error — return as script error
    if (execError.status === 2) {
      const stderr = execError.stderr instanceof Buffer
        ? execError.stderr.toString('utf-8')
        : String(execError.stderr ?? '');
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: stderr || 'Script input error',
        },
      };
    }

    // Exit code 1 = decomposition gaps found — parse the report
    stdout = execError.stdout instanceof Buffer
      ? execError.stdout.toString('utf-8')
      : String(execError.stdout ?? '');
    passed = false;
  }

  // Parse decomposition metrics from stdout
  const metrics = parseDecompositionMetrics(stdout);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'task-decomposition', 'planning', passed, {
      dimension: 'D5',
      phase: 'plan',
      wellDecomposed: metrics.wellDecomposed,
      needsRework: metrics.needsRework,
      totalTasks: metrics.totalTasks,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: TaskDecompositionResult = {
    passed,
    wellDecomposed: metrics.wellDecomposed,
    needsRework: metrics.needsRework,
    totalTasks: metrics.totalTasks,
    report: stdout,
  };

  return { success: true, data: result };
}
