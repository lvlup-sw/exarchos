// ─── Provenance Chain Composite Action ──────────────────────────────────────
//
// Orchestrates design-to-plan provenance verification by running the
// verify-provenance-chain.sh script and emitting gate.executed events for
// the plan→plan-review boundary.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';

// ─── Result Types ──────────────────────────────────────────────────────────

interface ProvenanceMetrics {
  readonly requirements: number;
  readonly covered: number;
  readonly gaps: number;
  readonly orphanRefs: number;
}

interface ProvenanceChainResult {
  readonly passed: boolean;
  readonly coverage: ProvenanceMetrics;
  readonly report: string;
}

// ─── Output Parsing ────────────────────────────────────────────────────────

function parseProvenanceMetrics(output: string): ProvenanceMetrics {
  const requirementsMatch = output.match(/Requirements:\s*(\d+)/);
  const coveredMatch = output.match(/Covered:\s*(\d+)/);
  const gapsMatch = output.match(/Gaps:\s*(\d+)/);
  const orphanMatch = output.match(/Orphan refs:\s*(\d+)/);

  return {
    requirements: requirementsMatch ? parseInt(requirementsMatch[1], 10) : 0,
    covered: coveredMatch ? parseInt(coveredMatch[1], 10) : 0,
    gaps: gapsMatch ? parseInt(gapsMatch[1], 10) : 0,
    orphanRefs: orphanMatch ? parseInt(orphanMatch[1], 10) : 0,
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleProvenanceChain(
  args: { featureId: string; designPath: string; planPath: string },
  stateDir: string,
): Promise<ToolResult> {
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
      'scripts/verify-provenance-chain.sh',
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

    // Exit code 1 = gaps found — parse the report
    stdout = execError.stdout instanceof Buffer
      ? execError.stdout.toString('utf-8')
      : String(execError.stdout ?? '');
    passed = false;
  }

  // Parse provenance metrics from stdout
  const metrics = parseProvenanceMetrics(stdout);

  // Emit gate.executed event (fire-and-forget: emission failure must not break the gate check)
  try {
    const store = getOrCreateEventStore(stateDir);
    await emitGateEvent(store, args.featureId, 'provenance-chain', 'planning', passed, {
      dimension: 'D1',
      phase: 'plan',
      requirements: metrics.requirements,
      covered: metrics.covered,
      gaps: metrics.gaps,
      orphanRefs: metrics.orphanRefs,
    });
  } catch { /* fire-and-forget */ }

  // Return structured result
  const result: ProvenanceChainResult = {
    passed,
    coverage: metrics,
    report: stdout,
  };

  return { success: true, data: result };
}
