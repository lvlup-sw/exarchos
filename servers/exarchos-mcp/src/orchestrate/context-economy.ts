// ─── Context Economy Gate (T-20) ────────────────────────────────────────────
//
// Orchestrates context-economy checking by running the
// scripts/check-context-economy.sh script and emitting gate.executed events
// for quality-layer gate checks.
// ────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';
import { queryRuntimeMetrics } from '../telemetry/telemetry-queries.js';
import type { RuntimeMetrics } from '../telemetry/telemetry-queries.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ContextEconomyArgs {
  readonly featureId: string;
  readonly repoRoot?: string;
  readonly baseBranch?: string;
}

interface ContextEconomyResult {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly report: string;
  readonly runtimeMetrics?: RuntimeMetrics;
}

// ─── Output Parsing ────────────────────────────────────────────────────────

function parseContextEconomyOutput(output: string): number {
  const findingsMatch = output.match(/Result:\s*FINDINGS\*{0,2}\s*\((\d+)\s*findings detected\)/);
  if (findingsMatch) {
    return parseInt(findingsMatch[1], 10);
  }
  return 0;
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleContextEconomy(
  args: ContextEconomyArgs,
  stateDir: string,
): Promise<ToolResult> {
  // Guard clause: validate required inputs
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  // Build the script command
  const repoRoot = args.repoRoot || process.cwd();
  const baseBranch = args.baseBranch || 'main';
  const scriptCmd = `scripts/check-context-economy.sh --repo-root ${repoRoot} --base-branch ${baseBranch}`;

  let stdout = '';
  let passed = false;

  try {
    const output = execSync(scriptCmd, {
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

    // Exit code 1 = findings detected — parse the report
    stdout = execError.stdout instanceof Buffer
      ? execError.stdout.toString('utf-8')
      : String(execError.stdout ?? '');
    passed = false;
  }

  // Parse finding count from stdout
  const findingCount = parseContextEconomyOutput(stdout);

  const store = getOrCreateEventStore(stateDir);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    await emitGateEvent(store, args.featureId, 'context-economy', 'quality', passed, {
      dimension: 'D3',
      phase: 'review',
      findingCount,
    });
  } catch { /* fire-and-forget */ }

  // Query runtime metrics via telemetry query abstraction (graceful degradation on failure)
  const runtimeMetrics = await queryRuntimeMetrics(store, stateDir);

  // Return structured result
  const result: ContextEconomyResult = {
    passed,
    findingCount,
    report: stdout,
    runtimeMetrics,
  };

  return { success: true, data: result };
}
