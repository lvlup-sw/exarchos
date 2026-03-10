// ─── Provenance Chain Gate ────────────────────────────────────────────────────
//
// Orchestrates design-to-plan provenance verification by calling the pure
// TypeScript verifyProvenanceChain function and emitting gate.executed events
// for the plan→plan-review boundary.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { getOrCreateEventStore } from '../views/tools.js';
import { emitGateEvent } from './gate-utils.js';
import { verifyProvenanceChain } from '../../../../src/orchestrate/provenance-chain.js';

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

  // Call pure TypeScript implementation
  const tsResult = verifyProvenanceChain({
    designFile: args.designPath,
    planFile: args.planPath,
  });

  if (tsResult.status === 'error') {
    return {
      success: false,
      error: {
        code: 'PROVENANCE_ERROR',
        message: tsResult.error ?? 'Provenance chain verification failed',
      },
    };
  }

  const passed = tsResult.status === 'pass';
  const metrics: ProvenanceMetrics = {
    requirements: tsResult.requirements,
    covered: tsResult.covered,
    gaps: tsResult.gaps,
    orphanRefs: tsResult.orphanRefs,
  };

  // Emit gate.executed event (fire-and-forget)
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
    report: tsResult.output,
  };

  return { success: true, data: result };
}
