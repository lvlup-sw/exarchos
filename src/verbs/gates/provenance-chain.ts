/**
 * The provenance-chain gate. It runs the pure `verifyProvenanceChain` check over the design and the plan.
 * It records a `gate.executed` event at the boundary from plan to plan-review.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { emitGateEvent, sameOperationGateKey } from './gate-utils.js';
import { verifyProvenanceChain } from '../pure/provenance-chain.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';

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

/**
 * Validates the inputs, reads both files, and runs the gate through the shared phase-gate runner.
 * A missing `eventStore` is a wiring bug, not a transient error, so the handler fails fast with `MISWIRED_CONTEXT`.
 */
export async function handleProvenanceChain(
  args: { featureId: string; designPath: string; planPath: string },
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
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

/**
 * Runs the markdown provenance check. SQLite is the authoritative structured record, so markdown parsing is the permanent path for this authoring gate.
 */
async function executeProvenanceChain(
  args: { featureId: string; designPath: string; planPath: string },
  eventStore: EventStore,
): Promise<ToolResult> {
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

  const result: ProvenanceChainResult = {
    passed,
    coverage: metrics,
    report: tsResult.output,
  };

  return { success: true, data: { ...result } };
}
