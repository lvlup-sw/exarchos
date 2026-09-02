// ─── Provenance Chain Gate ────────────────────────────────────────────────────
//
// Orchestrates design-to-plan provenance verification by calling the pure
// TypeScript verifyProvenanceChain function and emitting gate.executed events
// for the plan→plan-review boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { emitGateEvent, sameOperationGateKey } from './gate-utils.js';
import { verifyProvenanceChain } from '../pure/provenance-chain.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';

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
  // wiring bug, not a transient error. See PR #1185 / CR review 4177990662.
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

  let designContent: string;
  let planContent: string;
  try {
    [designContent, planContent] = await Promise.all([
      readFile(args.designPath, 'utf8'),
      readFile(args.planPath, 'utf8'),
    ]);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'PROVENANCE_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const artifactId =
    `plan-spec:${createHash('sha256').update(args.featureId).digest('hex').slice(0, 32)}`;
  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'provenance-chain',
    requirementId: 'requirement:provenance-chain',
    stateDir: _stateDir,
    eventStore,
    subject: () => createEvidenceSubject(
      { kind: 'artifact', artifactId },
      {
        designPath: args.designPath,
        planPath: args.planPath,
        designContent,
        planContent,
      },
    ),
    providerInput: args,
    executeProvider: async () => executeProvenanceChain(args, eventStore),
  });
}

async function executeProvenanceChain(
  args: { featureId: string; designPath: string; planPath: string },
  eventStore: EventStore,
): Promise<ToolResult> {
  // The YAML gate-sidecar layer (#1298) was abandoned in #1494 — SQLite is
  // the authoritative structured record, so markdown parsing is the
  // permanent authoring-gate path.

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

  await emitGateEvent(
    eventStore,
    args.featureId,
    'provenance-chain',
    'planning',
    passed,
    {
      dimension: 'D1',
      phase: 'plan',
      requirements: metrics.requirements,
      covered: metrics.covered,
      gaps: metrics.gaps,
      orphanRefs: metrics.orphanRefs,
    },
    sameOperationGateKey('provenance-chain'),
  );

  // Return structured result
  const result: ProvenanceChainResult = {
    passed,
    coverage: metrics,
    report: tsResult.output,
  };

  return { success: true, data: { ...result } };
}
