import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `prepare_synthesis` runs its test and typecheck legs by shelling out to
// `npm run test:run` and `npm run typecheck` in the process's own cwd — which,
// under this suite, is the MCP package. Unstubbed, the one case that gets past
// the task-completion short-circuit re-enters the entire vitest run from inside
// a test and then waits out both subprocess timeouts (120s + 60s). None of that
// bears on what these cases assert, which is that the evidence scope resolves.
// Stub the subprocess surface the way `prepare-synthesis.test.ts` does; the gate
// path under test stays real.
vi.mock('node:child_process', () => ({
  execSync: vi.fn((command: string, options?: { encoding?: string }) => {
    const text = command.includes('symbolic-ref')
      ? 'refs/remotes/origin/main'
      : 'Tests: 1 passed, 0 failed';
    return options?.encoding === 'utf-8' ? text : Buffer.from(text);
  }),
  execFileSync: vi.fn(() => Buffer.from('')),
}));

import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import { handlePlanCoverage } from '../../../src/verbs/gates/plan-coverage.js';
import { handlePrepareSynthesis } from '../../../src/verbs/team/prepare-synthesis.js';
import { handleProvenanceChain } from '../../../src/verbs/gates/provenance-chain.js';
import { handleReviewVerdict } from '../../../src/verbs/review/review-verdict.js';

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
  options: {
    failEvidence?: boolean;
    incompleteTask?: boolean;
    /** Omit the v2.12 attempt stamp, i.e. a workflow that predates it. */
    legacyNoPhaseAttempt?: boolean;
  } = {},
): EventStore {
  const sourceEvents: Record<string, unknown>[] = [
    {
      type: 'workflow.transition',
      timestamp: '2026-07-21T22:45:00.000Z',
      data: {
        to: phase,
        ...(options.legacyNoPhaseAttempt ? {} : { phaseAttemptId: PHASE_ATTEMPT_ID }),
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

  it('PlanCoverage_WorkflowPredatingThePhaseAttemptStamp_StillRunsTheGate', async () => {
    // The upgrade wedge. Every other case in this file hands the store a
    // `phaseAttemptId`, so the stamp-less state a pre-v2.12 workflow actually
    // projects was never exercised — and the phase-gate adapter answered
    // EVIDENCE_SCOPE_UNAVAILABLE for it, locking such a workflow out of all four
    // migrated gates while the sibling durable-gate adapter backfilled the same
    // state happily.
    const result = await runWithDispatchContext(dispatchContext(), () =>
      handlePlanCoverage(
        { featureId: 'feature-009', designPath, planPath },
        root,
        fakeStore('plan', { legacyNoPhaseAttempt: true }),
      ),
    );

    expect(result).toMatchObject({ success: true, data: { passed: true } });
    // Evidence is still bound to an attempt — the backfill must produce a real
    // scope, not merely dodge the error.
    expect(evidenceReference(result).subject).toMatchObject({ kind: 'artifact' });
  });

  it('PrepareSynthesis_WorkflowPredatingThePhaseAttemptStamp_IsNotWedged', async () => {
    // `prepare_synthesis` is the BLOCKING member of the migrated four, so this is
    // the case where the wedge cost the whole synthesize phase.
    const result = await runWithDispatchContext(dispatchContext(), () =>
      handlePrepareSynthesis(
        { featureId: 'feature-009' },
        root,
        fakeStore('review', { legacyNoPhaseAttempt: true }),
      ),
    );

    expect(result.success).toBe(true);
    expect(
      (result as { error?: { code?: string } }).error?.code,
    ).not.toBe('EVIDENCE_SCOPE_UNAVAILABLE');
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
