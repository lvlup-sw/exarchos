// @oracle-sources: ../../../../src/dispatch/core/dispatch.ts, the post-dispatch postcondition observation — the store and the persisted-evidence reader, asked after the handler returned, rather than anything the handler said about itself
//
// ─── The remaining declared-but-unpaid gates, through the REAL dispatch path ──
//
// Ten actions declared `durable-evidence` as a postcondition and paid it with
// either a bare `gate.executed` append or with nothing at all. A `gate.executed`
// row is a DIFFERENT record on a DIFFERENT axis: the observer reads
// `admission.evidence-recorded`. Dispatch checks declared postconditions after
// the handler returns, so every one of these answered
// ENSURE_CONTRACT_VIOLATED — and inside a compiled segment a leaf that breaks
// its own postcondition halts the segment whatever its failure policy says.
//
// Nothing on the payment path is stubbed here — not the gate runner, not the
// handler table, not the registry. That is the whole point: the sibling unit
// tests stub the runner to isolate a provider verdict, which is exactly the
// seam that hid this defect. What these cases ask is what a caller gets.
//
// The two mocks below stand in for EXTERNAL WORK, never for the payment: the
// post-merge regression check otherwise shells `npm run test:run`, and the VCS
// factory otherwise reaches for `gh`. Both sit inside the provider closure, on
// the far side of the seam under test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/verbs/pure/post-merge.js', () => ({
  checkPostMerge: vi.fn(async () => ({
    status: 'pass' as const,
    prUrl: 'https://example.invalid/pull/1',
    mergeSha: 'abc1234',
    passCount: 1,
    failCount: 0,
    results: [],
    findings: [],
    report: 'post-merge: pass',
  })),
}));

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(async () => ({
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(async () => []),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  })),
}));

import {
  deriveMcpCallerIdentity,
} from '../../../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  seedActivePhaseAttempt,
  seedGateEvidence,
} from '../../../../tools/test-helpers/trusted-context.js';

const CAPABILITIES = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'isolation:worktree',
  'mcp:exarchos',
  'admission:issue-gate-evidence',
];

let stateDir: string;
let store: EventStore;

function ctx(): DispatchContext {
  return {
    stateDir,
    eventStore: store,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'unrunbooked-gate-evidence' }),
    capabilityResolver: createInMemoryResolver(CAPABILITIES),
  };
}

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  return dispatch('exarchos_orchestrate', args, ctx());
}

/** The evidence rows on a stream. */
async function evidenceCount(streamId: string): Promise<number> {
  const rows = await store.query(streamId, { type: 'admission.evidence-recorded' });
  return rows.length;
}

/**
 * Drive one gate and assert it paid what it declared.
 *
 * The verdict is deliberately NOT asserted: a gate that fails its own check
 * still owes the record, and the runner persists it either way. What is
 * asserted is that the carrier is not the contract refusal and that exactly one
 * new evidence row landed on the stream the call named.
 */
async function expectsEvidence(
  streamId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const before = await evidenceCount(streamId);
  const result = await call(args);
  expect(result.error?.code, JSON.stringify(result.error)).not.toBe('ENSURE_CONTRACT_VIOLATED');
  expect(await evidenceCount(streamId)).toBe(before + 1);
  return result;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'unrunbooked-gate-evidence-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** A stream with an active attempt in the phase the gate is bound to. */
async function streamInPhase(name: string, phase: string): Promise<string> {
  await seedActivePhaseAttempt(store, name, { phase });
  return name;
}

describe('gates that declare durable evidence pay it on dispatch', () => {
  it('CheckCoverageThresholds_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-coverage-thresholds', 'review');
    const coverageFile = path.join(stateDir, 'coverage-summary.json');
    await writeFile(
      coverageFile,
      JSON.stringify({
        total: {
          lines: { pct: 95 },
          branches: { pct: 85 },
          functions: { pct: 100 },
        },
      }),
      'utf-8',
    );

    const result = await expectsEvidence(stream, {
      action: 'check_coverage_thresholds',
      featureId: stream,
      coverageFile,
    });
    expect(result.success).toBe(true);
  });

  it('ValidatePrStack_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-pr-stack', 'synthesize');

    const result = await expectsEvidence(stream, {
      action: 'validate_pr_stack',
      featureId: stream,
      baseBranch: 'main',
    });
    expect(result.success).toBe(true);
  });

  it('DebugReviewGate_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-debug-review', 'debug-review');

    // `HEAD...HEAD` is an empty diff, so the gate reaches its verdict without a
    // test run — the subject here is the record, not the verdict.
    await expectsEvidence(stream, {
      action: 'debug_review_gate',
      featureId: stream,
      repoRoot: process.cwd(),
      baseBranch: 'HEAD',
      skipRun: true,
    });
  });

  it('PostDelegationCheck_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-post-delegation', 'delegate');
    await store.append(stream, {
      type: 'state.patched',
      data: { patch: { tasks: [{ id: 'T1', status: 'complete', branch: 'b-T1' }] } },
    });

    const result = await expectsEvidence(stream, {
      action: 'post_delegation_check',
      featureId: stream,
      repoRoot: stateDir,
      skipTests: true,
    });
    expect(result.success).toBe(true);
    // The gate also declares an unconditional `gate.executed`; it is a separate
    // ensure on a separate axis and is observed the same way.
    const signal = await store.query(stream, { type: 'gate.executed' });
    expect(signal.map((row) => (row.data as { gateName?: string }).gateName)).toContain(
      'post-delegation',
    );
  });

  it('PreSynthesisCheck_Dispatched_RecordsEvidence', async () => {
    const stream = 'wf-pre-synthesis';
    const phaseAttemptId = await seedActivePhaseAttempt(store, stream, { phase: 'synthesize' });
    // The gate's own `requires` are five prior synthesis facts; without them the
    // case would report an admission denial and say nothing about the
    // postcondition it is here to check.
    for (const gate of ['task-completion', 'tests', 'typecheck', 'document', 'stack']) {
      await seedGateEvidence(store, { streamId: stream, requirementId: gate, phaseAttemptId });
    }

    const result = await expectsEvidence(stream, {
      action: 'pre_synthesis_check',
      featureId: stream,
      repoRoot: stateDir,
      skipTests: true,
      skipStack: true,
    });
    expect(result.success).toBe(true);
    const signal = await store.query(stream, { type: 'gate.executed' });
    expect(signal.map((row) => (row.data as { gateName?: string }).gateName)).toContain(
      'pre-synthesis',
    );
  });

  it('CheckContextEconomy_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-context-economy', 'review');

    await expectsEvidence(stream, {
      action: 'check_context_economy',
      featureId: stream,
      repoRoot: process.cwd(),
      baseBranch: 'HEAD',
    });
  });

  it('CheckOperationalResilience_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-operational-resilience', 'review');

    await expectsEvidence(stream, {
      action: 'check_operational_resilience',
      featureId: stream,
      repoRoot: process.cwd(),
      baseBranch: 'HEAD',
    });
  });

  it('CheckWorkflowDeterminism_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-workflow-determinism', 'review');

    await expectsEvidence(stream, {
      action: 'check_workflow_determinism',
      featureId: stream,
      repoRoot: process.cwd(),
      baseBranch: 'HEAD',
    });
  });

  it('CheckPostMerge_Dispatched_RecordsEvidence', async () => {
    const stream = await streamInPhase('wf-post-merge', 'synthesize');

    const result = await expectsEvidence(stream, {
      action: 'check_post_merge',
      featureId: stream,
      prUrl: 'https://example.invalid/pull/1',
      mergeSha: 'abc1234',
    });
    expect(result.success).toBe(true);
  });

  it('CheckExplorationDepth_Dispatched_RecordsEvidenceOnTheSkipPath', async () => {
    const stream = await streamInPhase('wf-exploration-depth', 'plan');

    // The self-skip is the path that looked most like "nothing happened", and
    // it is exactly the path a reader needs the record for.
    const result = await expectsEvidence(stream, {
      action: 'check_exploration_depth',
      featureId: stream,
      designDepth: 'standard',
    });
    expect(result.success).toBe(true);
    expect((result.data as { skipped?: boolean }).skipped).toBe(true);
  });

  it('EachGate_AttachesTheEvidenceItRecorded_ToItsOwnCarrier', async () => {
    // The evidence is not only in the log — the gate's carrier references it, so
    // a caller reading the result can find the record without querying.
    const stream = await streamInPhase('wf-carrier-reference', 'synthesize');

    const result = await call({
      action: 'validate_pr_stack',
      featureId: stream,
      baseBranch: 'main',
    });

    const references = (result.data as { evidenceReferences?: unknown[] }).evidenceReferences;
    expect(Array.isArray(references)).toBe(true);
    expect(references).toHaveLength(1);
  });
});
