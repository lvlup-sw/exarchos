import { createHash } from 'node:crypto';

import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { evidenceArtifactStore } from '../../workflow/admission/evidence-artifact.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import type { EvidenceSubjectV1 } from '../../workflow/admission/types.js';
import { resolveActivePhaseAttemptId } from '../tasks/active-phase-attempt.js';
import { resolveWorkflowState } from '../resolve-state.js';
import { defaultGitExec } from './gate-utils.js';
import { runGateWithEvidence } from './gate-runner.js';

export interface DurableGateScope {
  readonly gateClass:
    | 'static-analysis'
    | 'test-adequacy'
    | 'integration-suite'
    | 'contract-drift'
    | 'mock-boundary';
  readonly featureId: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly baseRef?: string;
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly eventStore: EventStore;
}

/**
 * The requirement id under which a ladder gate records its evidence.
 * It is exported so that a reader of a cited gate class, such as settlement, uses the same spelling as the producer.
 */
export function ladderRequirementId(gateClass: string): string {
  return `verification-ladder:${gateClass}`;
}

function scopeError(code: string, message: string): ToolResult {
  return { success: false, error: { code, message } };
}

/**
 * Uses the same resolver as the phase-gate adapter in `gate-runner`.
 * A workflow with no phase-attempt stamp thus gets a derived attempt id, not an error.
 */
async function activePhaseAttemptId(
  featureId: string,
  eventStore: EventStore,
): Promise<string | ToolResult> {
  const resolved = await resolveWorkflowState({ featureId, eventStore });
  if ('error' in resolved) return resolved.error;
  return resolveActivePhaseAttemptId(featureId, resolved.state);
}

function fallbackArtifactId(scope: DurableGateScope, phaseAttemptId: string): string {
  const digest = createHash('sha256')
    .update(
      [
        scope.featureId,
        scope.gateClass,
        phaseAttemptId,
        scope.repoRoot,
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
  return `gate-target:${digest}`;
}

/**
 * Selects the immutable proof target. A run with a `taskId` binds to a task subject.
 * Other runs bind to the `HEAD` commit. When `HEAD` does not resolve, they bind to an artifact target.
 * Mutable workflow state is not a commit, so the producer never uses it as one.
 */
function selectSubject(
  scope: DurableGateScope,
  phaseAttemptId: string,
): EvidenceSubjectV1 {
  const target = {
    gateClass: scope.gateClass,
    ...(scope.branch ? { branch: scope.branch } : {}),
    ...(scope.baseRef ? { diffBase: scope.baseRef } : {}),
  };
  if (scope.taskId) {
    return createEvidenceSubject(
      { kind: 'task', taskId: scope.taskId },
      target,
    );
  }

  const head = defaultGitExec(scope.repoRoot, ['rev-parse', 'HEAD']);
  const commitId = head.exitCode === 0 ? head.stdout.trim() : '';
  if (commitId.length > 0) {
    return createEvidenceSubject({ kind: 'commit', commitId }, target);
  }
  return createEvidenceSubject(
    {
      kind: 'artifact',
      artifactId: fallbackArtifactId(scope, phaseAttemptId),
    },
    target,
  );
}

/**
 * Canonical audit/shadow producer boundary for the migrated ladder handlers.
 * The provider carrier is returned byte-for-byte except for additive evidence
 * references, and no success carrier escapes before the durable append.
 */
export async function runDurableGateProducer(
  scope: DurableGateScope,
  executeProvider: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const context = getDispatchContext();
  if (context?.authorization === undefined) {
    return scopeError(
      'TRUSTED_CALLER_REQUIRED',
      'runGate requires trusted dispatch caller identity.',
    );
  }

  const activeAttempt = await activePhaseAttemptId(
    scope.featureId,
    scope.eventStore,
  );
  if (typeof activeAttempt !== 'string') return activeAttempt;

  let subject: EvidenceSubjectV1;
  try {
    subject = selectSubject(scope, activeAttempt);
  } catch (error) {
    return scopeError(
      'INVALID_GATE_SCOPE',
      error instanceof Error ? error.message : String(error),
    );
  }

  return runGateWithEvidence(
    {
      streamId: scope.featureId,
      gateClass: scope.gateClass,
      phaseAttemptId: activeAttempt,
      requirementId: ladderRequirementId(scope.gateClass),
      subject,
      providerInput: {
        featureId: scope.featureId,
        ...(scope.taskId ? { taskId: scope.taskId } : {}),
        ...(scope.branch ? { branch: scope.branch } : {}),
        ...(scope.baseRef ? { baseRef: scope.baseRef } : {}),
      },
    },
    {
      eventStore: scope.eventStore,
      artifactStore: evidenceArtifactStore(scope.stateDir),
      executeProvider: async () => executeProvider(),
    },
  );
}
