// ─── Plan Coverage Composite Action ─────────────────────────────────────────
//
// Orchestrates plan-to-design coverage verification by running the
// verify-plan-coverage.sh script and emitting gate.executed events for
// the plan→plan-review boundary.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Result Types ──────────────────────────────────────────────────────────

interface CoverageMetrics {
  readonly covered: number;
  readonly gaps: number;
  readonly deferred: number;
  readonly total: number;
}

interface PlanCoverageResult {
  readonly passed: boolean;
  readonly coverage: CoverageMetrics;
  readonly report: string;
}

// ─── Output Parsing ────────────────────────────────────────────────────────

function parseCoverageMetrics(output: string): CoverageMetrics {
  const coveredMatch = output.match(/Covered:\s*(\d+)/);
  const gapsMatch = output.match(/Gaps:\s*(\d+)/);
  const deferredMatch = output.match(/Deferred:\s*(\d+)/);
  const totalMatch = output.match(/Design sections:\s*(\d+)/);

  return {
    covered: coveredMatch ? parseInt(coveredMatch[1], 10) : 0,
    gaps: gapsMatch ? parseInt(gapsMatch[1], 10) : 0,
    deferred: deferredMatch ? parseInt(deferredMatch[1], 10) : 0,
    total: totalMatch ? parseInt(totalMatch[1], 10) : 0,
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handlePlanCoverage(
  args: { featureId: string; designPath: string; planPath: string },
  stateDir: string,
): Promise<ToolResult> {
  // Input validation
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.designPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'designPath is required' },
    };
  }

  if (!args.planPath) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'planPath is required' },
    };
  }

  let stdout = '';
  let passed = false;

  try {
    const output = execFileSync(
      'scripts/verify-plan-coverage.sh',
      ['--design-file', args.designPath, '--plan-file', args.planPath],
      { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
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

    // Exit code 1 = gaps found — parse the report
    stdout = execError.stdout instanceof Buffer
      ? execError.stdout.toString('utf-8')
      : String(execError.stdout ?? '');
    passed = false;
  }

  // Parse coverage metrics from stdout
  const metrics = parseCoverageMetrics(stdout);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'plan-coverage', 'planning', passed, {
      dimension: 'D1',
      phase: 'plan',
      covered: metrics.covered,
      gaps: metrics.gaps,
      deferred: metrics.deferred,
      totalSections: metrics.total,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: PlanCoverageResult = {
    passed,
    coverage: metrics,
    report: stdout,
  };

  return { success: true, data: result };
}
