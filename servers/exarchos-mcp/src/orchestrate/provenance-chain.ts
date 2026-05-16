// ─── Provenance Chain Gate ────────────────────────────────────────────────────
//
// Orchestrates design-to-plan provenance verification by calling the pure
// TypeScript verifyProvenanceChain function and emitting gate.executed events
// for the plan→plan-review boundary.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { emitGateEvent } from './gate-utils.js';
import { verifyProvenanceChain } from './pure/provenance-chain.js';
import { loadDesignSidecar, loadPlanSidecar } from './sidecar-lookup.js';
import type { DesignSidecarV1, PlanSidecarV1 } from './sidecar-schemas.js';

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
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Fail-fast on miswired DispatchContext: a missing eventStore here is a
  // wiring bug, not a transient error. Without this guard the fire-and-forget
  // emit below silently swallows the failure. See PR #1185 / CR review 4177990662.
  if (!eventStore) {
    return {
      success: false,
      error: {
        code: 'MISWIRED_CONTEXT',
        message: 'handleProvenanceChain: eventStore is required',
      },
    };
  }

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

  // Prefer the sidecars (T15) when both are present + conformant.
  const designSidecar = loadDesignSidecar(args.designPath);
  const planSidecar = loadPlanSidecar(args.planPath);
  if (designSidecar && planSidecar) {
    const sidecarResult = evaluateProvenanceFromSidecars(designSidecar, planSidecar);
    try {
      await emitGateEvent(eventStore, args.featureId, 'provenance-chain', 'planning', sidecarResult.passed, {
        dimension: 'D1',
        phase: 'plan',
        requirements: sidecarResult.coverage.requirements,
        covered: sidecarResult.coverage.covered,
        gaps: sidecarResult.coverage.gaps,
        orphanRefs: sidecarResult.coverage.orphanRefs,
      });
    } catch { /* fire-and-forget */ }
    return {
      success: true,
      data: { ...sidecarResult, source: 'sidecar' as const },
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
    const store = eventStore;
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

  return { success: true, data: { ...result, source: 'regex' as const } };
}

// ─── Sidecar evaluation ─────────────────────────────────────────────────────

/**
 * Verify the design-to-plan provenance chain from the structured sidecars.
 *
 * A DR is "covered" when at least one `provenance` entry in the plan
 * sidecar references it. An "orphan reference" is a plan provenance entry
 * pointing at a DR id that does not appear in the design sidecar's `drs`.
 */
function evaluateProvenanceFromSidecars(
  design: DesignSidecarV1,
  plan: PlanSidecarV1,
): {
  passed: boolean;
  coverage: { requirements: number; covered: number; gaps: number; orphanRefs: number };
  report: string;
} {
  const drIds = new Set(design.drs.map((d) => d.id));
  const provenanceDrs = new Set(plan.provenance.map((p) => p.dr));
  let covered = 0;
  const missing: string[] = [];
  for (const dr of drIds) {
    if (provenanceDrs.has(dr)) covered++;
    else missing.push(dr);
  }
  const orphanRefs = [...provenanceDrs].filter((d) => !drIds.has(d));
  const requirements = drIds.size;
  const gaps = missing.length;
  const passed = gaps === 0 && orphanRefs.length === 0;
  const report = [
    '## Provenance Chain Report (sidecar)',
    '',
    `- Requirements: ${requirements}`,
    `- Covered: ${covered}`,
    `- Gaps: ${gaps}${gaps > 0 ? ` (${missing.join(', ')})` : ''}`,
    `- Orphan provenance refs: ${orphanRefs.length}${orphanRefs.length > 0 ? ` (${orphanRefs.join(', ')})` : ''}`,
    '',
    passed ? '**Result: PASS**' : '**Result: FAIL**',
  ].join('\n');

  return {
    passed,
    coverage: { requirements, covered, gaps, orphanRefs: orphanRefs.length },
    report,
  };
}
