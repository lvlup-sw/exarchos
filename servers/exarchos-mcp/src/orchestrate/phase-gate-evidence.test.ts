import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryResolver } from '../capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../dispatch/dispatch-context.js';
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import { handlePlanCoverage } from './plan-coverage.js';
import { handlePrepareSynthesis } from './prepare-synthesis.js';
import { handleProvenanceChain } from './provenance-chain.js';
import { handleReviewVerdict } from './review-verdict.js';

const PHASE_ATTEMPT_ID = 'phase-attempt:task-009';

function dispatchContext() {
  const identity = deriveMcpCallerIdentity({ sessionId: 'phase-gate-tests' });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(
      identity,
      createInMemoryResolver([
        'fs:read',
        'fs:write',
        'shell:exec',
        'isolation:worktree',
        'mcp:exarchos',
      ]),
    ),
  );
}

function fakeStore(
  phase: string,
  options: { failEvidence?: boolean; incompleteTask?: boolean } = {},
): EventStore {
  const sourceEvents: Record<string, unknown>[] = [
    {
      type: 'workflow.transition',
      timestamp: '2026-07-21T22:45:00.000Z',
      data: {
        to: phase,
        phaseAttemptId: PHASE_ATTEMPT_ID,
      },
    },
    ...(options.incompleteTask
      ? [{
          type: 'task.assigned',
          timestamp: '2026-07-21T22:45:01.000Z',
          data: { taskId: 'task-009', title: 'Task 009' },
        }]
      : []),
  ];
  const persisted: Record<string, unknown>[] = [];
  return {
    query: async (_streamId: string, query?: { type?: string }) => {
      const events = [...sourceEvents, ...persisted];
      return (query?.type === undefined
        ? events
        : events.filter((event) => event.type === query.type)) as never;
    },
    append: async (streamId: string, event: Record<string, unknown>) => {
      if (event.type === 'admission.evidence-recorded' && options.failEvidence) {
        throw new Error('durable evidence unavailable');
      }
      const persistedEvent = {
        id: `event-${persisted.length + 1}`,
        streamId,
        sequence: persisted.length + 1,
        timestamp: '2026-07-21T22:45:02.000Z',
        ...event,
      };
      persisted.push(persistedEvent);
      return persistedEvent as never;
    },
  } as unknown as EventStore;
}

function evidenceReference(result: ToolResult): Record<string, unknown> {
  const data = result.data as Record<string, unknown>;
  const references = data.evidenceReferences as Record<string, unknown>[];
  expect(references).toHaveLength(1);
  return references[0]!;
}

describe('migrated phase gate durable evidence', () => {
  let root: string;
  let designPath: string;
  let planPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phase-gate-evidence-'));
    designPath = join(root, 'spec.md');
    planPath = join(root, 'plan.md');
    await writeFile(
      designPath,
      [
        '## Design Requirements',
        '### DR-1: User Authentication',
        'The system authenticates users.',
      ].join('\n'),
    );
    await writeFile(
      planPath,
      [
        '### Task 001: User Authentication',
        '**Implements:** DR-1',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('PlanCoverage_CompatibleCarrier_AddsPlanSpecEvidence', async () => {
    const result = await runWithDispatchContext(dispatchContext(), () =>
      handlePlanCoverage(
        { featureId: 'feature-009', designPath, planPath },
        root,
        fakeStore('plan'),
      ),
    );

    expect(result).toMatchObject({
      success: true,
      data: { passed: true, coverage: { gaps: 0 } },
    });
    expect(evidenceReference(result).subject).toMatchObject({ kind: 'artifact' });
  });

  it('ProvenanceChain_CompatibleCarrier_AddsPlanSpecEvidence', async () => {
    const result = await runWithDispatchContext(dispatchContext(), () =>
      handleProvenanceChain(
        { featureId: 'feature-009', designPath, planPath },
        root,
        fakeStore('plan'),
      ),
    );

    expect(result).toMatchObject({
      success: true,
      data: { passed: true, coverage: { gaps: 0, orphanRefs: 0 } },
    });
    expect(evidenceReference(result).subject).toMatchObject({ kind: 'artifact' });
  });

  it('ReviewVerdict_CompatibleCarrier_AddsPhaseAttemptEvidence', async () => {
    const result = await runWithDispatchContext(dispatchContext(), () =>
      handleReviewVerdict(
        { featureId: 'feature-009', high: 0, medium: 1, low: 0 },
        root,
        fakeStore('review'),
      ),
    );

    expect(result).toMatchObject({
      success: true,
      data: { verdict: 'APPROVED', high: 0, medium: 1, low: 0 },
    });
    expect(evidenceReference(result).subject).toMatchObject({
      kind: 'phase-attempt',
      phaseAttemptId: PHASE_ATTEMPT_ID,
    });
  });

  it('PrepareSynthesis_CompatibleBlockedCarrier_AddsPhaseAttemptEvidence', async () => {
    const result = await runWithDispatchContext(dispatchContext(), () =>
      handlePrepareSynthesis(
        { featureId: 'feature-009' },
        root,
        fakeStore('synthesize', { incompleteTask: true }),
      ),
    );

    expect(result).toMatchObject({
      success: true,
      data: { ready: false, readiness: { tasksComplete: false } },
    });
    expect(evidenceReference(result).subject).toMatchObject({
      kind: 'phase-attempt',
      phaseAttemptId: PHASE_ATTEMPT_ID,
    });
  });

  it('PhaseGate_EvidenceAppendFailure_BlocksSuccess', async () => {
    const invocations = [
      () => handlePlanCoverage(
        { featureId: 'feature-009', designPath, planPath },
        root,
        fakeStore('plan', { failEvidence: true }),
      ),
      () => handleProvenanceChain(
        { featureId: 'feature-009', designPath, planPath },
        root,
        fakeStore('plan', { failEvidence: true }),
      ),
      () => handleReviewVerdict(
        { featureId: 'feature-009', high: 0, medium: 0, low: 0 },
        root,
        fakeStore('review', { failEvidence: true }),
      ),
      () => handlePrepareSynthesis(
        { featureId: 'feature-009' },
        root,
        fakeStore('synthesize', {
          failEvidence: true,
          incompleteTask: true,
        }),
      ),
    ];

    for (const invoke of invocations) {
      const result = await runWithDispatchContext(dispatchContext(), invoke);
      expect(result).toEqual({
        success: false,
        error: {
          code: 'EVIDENCE_APPEND_FAILED',
          message: 'durable evidence unavailable',
          action: 'runGate',
        },
      });
    }
  });
});
