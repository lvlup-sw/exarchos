// ─── Static Analysis Composite Action ────────────────────────────────────────
//
// Orchestrates static analysis checks (lint + typecheck) by running the
// static-analysis-gate.sh script and emitting gate.executed events for
// the quality layer.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Argument & Result Types ─────────────────────────────────────────────────

interface StaticAnalysisArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly taskId?: string;
  readonly skipLint?: boolean;
  readonly skipTypecheck?: boolean;
}

interface StaticAnalysisResult {
  readonly passed: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly report: string;
}

// ─── Output Parsing ──────────────────────────────────────────────────────────

function parseStaticAnalysisOutput(output: string): { passCount: number; failCount: number } {
  // Match "Result: PASS (2/2 checks passed)" or "Result: FAIL (1/2 checks failed)"
  const resultMatch = output.match(/\((\d+)\/(\d+)\s+checks\s+(?:passed|failed)\)/);

  if (!resultMatch) {
    return { passCount: 0, failCount: 0 };
  }

  const count = parseInt(resultMatch[1], 10);
  const total = parseInt(resultMatch[2], 10);

  // PASS line: (N/M checks passed) → passCount=N, failCount=M-N
  // FAIL line: (N/M checks failed) → failCount=N, passCount=M-N
  if (output.includes('Result: PASS')) {
    return { passCount: count, failCount: total - count };
  }

  return { passCount: total - count, failCount: count };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleStaticAnalysis(
  args: StaticAnalysisArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Input validation
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  // Build command arguments
  const repoRoot = args.repoRoot || process.cwd();
  const scriptArgs = ['--repo-root', repoRoot];

  if (args.skipLint) {
    scriptArgs.push('--skip-lint');
  }

  if (args.skipTypecheck) {
    scriptArgs.push('--skip-typecheck');
  }

  let stdout = '';
  let passed = false;

  try {
    const output = execFileSync('scripts/static-analysis-gate.sh', scriptArgs, {
      timeout: 60_000,
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

    // Timeout or spawn errors have no status — treat as script error
    if (execError.status == null) {
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // Exit code 2 = usage error — return as script error
    if (execError.status === 2) {
      const stderr = execError.stderr instanceof Buffer
        ? execError.stderr.toString('utf-8')
        : String(execError.stderr ?? '');
      return {
        success: false,
        error: {
          code: 'SCRIPT_ERROR',
          message: stderr || 'Script usage error',
        },
      };
    }

    // Exit code 1 = findings found — parse the report
    stdout = execError.stdout instanceof Buffer
      ? execError.stdout.toString('utf-8')
      : String(execError.stdout ?? '');
    passed = false;
  }

  // Parse pass/fail counts from stdout
  const { passCount, failCount } = parseStaticAnalysisOutput(stdout);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'static-analysis', 'quality', passed, {
      dimension: 'D2',
      phase: 'delegate',
      passCount,
      failCount,
      ...(args.taskId ? { taskId: args.taskId } : {}),
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: StaticAnalysisResult = {
    passed,
    passCount,
    failCount,
    report: stdout,
  };

  return { success: true, data: result };
}
