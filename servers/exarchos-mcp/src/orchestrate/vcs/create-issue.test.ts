import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { ConcurrencyError } from '../../event-store/index.js';

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleCreateIssue } from './create-issue.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn().mockResolvedValue({ number: 123, url: 'https://github.com/repo/issues/123' }),
    searchIssuesByMarker: vi.fn().mockResolvedValue([]),
    getRepository: vi.fn(),
    ...overrides,
  };
}

/**
 * Default empty marker scan. Tests that do NOT exercise the recovery branch
 * pass this explicitly — the handler now refuses to run without the
 * dependency injected (CodeRabbit #3224631237).
 */
const emptyMarkerScan = vi.fn().mockResolvedValue([]);

function makeMockCtx(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append: vi.fn().mockResolvedValue({ sequence: 1 }),
      // recoverOperationId now propagates query failures (CodeRabbit
      // review #4278133032 — fail-closed instead of minting a fresh
      // UUID that the marker scan would never match). Default to an
      // empty result so the happy-path tests fall through to a fresh
      // randomUUID() exactly like before.
      query: vi.fn().mockResolvedValue([]),
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

describe('handleCreateIssue', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);
    ctx = makeMockCtx();
  });

  it('handleCreateIssue_ValidArgs_CallsProviderCreateIssue', async () => {
    const args = {
      title: 'Bug: crash on load',
      body: 'Steps to reproduce...',
      listIssuesByMarker: emptyMarkerScan,
    };

    await handleCreateIssue(args, ctx);

    // The body now includes the operationId marker embedded for idempotency.
    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug: crash on load',
      body: expect.stringContaining('Steps to reproduce...'),
      labels: undefined,
      assignees: undefined,
    });
    // Verify the marker is embedded in the body.
    const call = vi.mocked(mockProvider.createIssue).mock.calls[0]![0];
    expect(call.body).toMatch(/<!-- exarchos-op:[0-9a-f-]{36} -->/);
  });

  it('handleCreateIssue_Success_ReturnsSuccessWithData', async () => {
    const args = { title: 'Bug: crash', body: 'Details', listIssuesByMarker: emptyMarkerScan };

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ number: 123, url: 'https://github.com/repo/issues/123' });
  });

  it('handleCreateIssue_WithLabels_PassedToProvider', async () => {
    const args = {
      title: 'Bug',
      body: 'Details',
      labels: ['bug', 'priority-high'],
      listIssuesByMarker: emptyMarkerScan,
    };

    await handleCreateIssue(args, ctx);

    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug',
      // Body includes the operationId marker appended after original content.
      body: expect.stringContaining('Details'),
      labels: ['bug', 'priority-high'],
      assignees: undefined,
    });
  });

  it('handleCreateIssue_WithAssignees_PassedToProvider', async () => {
    // CodeRabbit #3224631240: assignees must be threaded through to the
    // provider, not just recorded in the durable intent event.
    const args = {
      title: 'Bug',
      body: 'Details',
      assignees: ['alice', 'bob'],
      listIssuesByMarker: emptyMarkerScan,
    };

    await handleCreateIssue(args, ctx);

    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug',
      body: expect.stringContaining('Details'),
      labels: undefined,
      assignees: ['alice', 'bob'],
    });
  });

  it('handleCreateIssue_Success_EmitsTwoEventSequence', async () => {
    const args = { title: 'Bug', body: 'Details', listIssuesByMarker: emptyMarkerScan };

    await handleCreateIssue(args, ctx);

    // Two-event split: Phase A emits issue.create.requested, Phase C emits
    // issue.create.executed. Both use the same operationId.
    const appendCalls = vi.mocked(ctx.eventStore.append).mock.calls;
    expect(appendCalls.length).toBe(2);

    // Phase A — durable intent.
    expect(appendCalls[0]![0]).toBe('vcs');
    expect(appendCalls[0]![1]).toMatchObject({
      type: 'issue.create.requested',
      data: { title: 'Bug' },
    });

    // Phase C — execution record.
    const executedCall = appendCalls[1]![1] as { type: string; data: { operationId: string; issueNumber: number; url: string } };
    expect(appendCalls[1]![0]).toBe('vcs');
    expect(executedCall.type).toBe('issue.create.executed');
    expect(executedCall.data.issueNumber).toBe(123);
    expect(executedCall.data.url).toBe('https://github.com/repo/issues/123');

    // Both events share the same operationId.
    const requestedData = appendCalls[0]![1] as { data: { operationId: string } };
    expect(executedCall.data.operationId).toBe(requestedData.data.operationId);
  });

  it('handleCreateIssue_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.createIssue).mockRejectedValue(new Error('Rate limited'));

    const args = { title: 'Bug', body: 'Details', listIssuesByMarker: emptyMarkerScan };

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('Rate limited');
  });

  // ─── B3.2 RED: Phase-A retry must not refire gh issue create ──────────────
  //
  // Verifies the two-event split property: if the event-store append for
  // `issue.create.requested` throws ConcurrencyError on the first attempt
  // (Phase A OCC loss), withStateRetry retries Phase A and the retry must NOT
  // re-call createIssue. The non-idempotent VCS side effect fires AT MOST ONCE
  // across all Phase A retry attempts.
  //
  // RED with the current single-event handler: it has no Phase A boundary at
  // all, so phaseAAttempts will be 0 (the `issue.create.requested` event type
  // doesn't exist yet), causing the `phaseAAttempts >= 2` assertion to fail.
  it('CreateIssue_PhaseARetry_DoesNotRefireGhIssueCreate', async () => {
    // Track how many times the handler attempts to append issue.create.requested
    // (the Phase A durable intent event). In the two-event split, this must
    // be retried when a ConcurrencyError is thrown; in the old single-event
    // handler there is no Phase A, so phaseAAttempts stays 0.
    let phaseAAttempts = 0;
    const fakeAppend = vi.fn().mockImplementation(async (_streamId: string, event: { type: string }) => {
      if (event.type === 'issue.create.requested') {
        phaseAAttempts += 1;
        if (phaseAAttempts === 1) {
          // First Phase A attempt — synthesize OCC loss to force retry.
          throw new ConcurrencyError({
            streamId: 'vcs',
            reducerId: 'create-issue',
            expectedVersion: 0,
            actualVersion: 1,
          });
        }
      }
      return { sequence: 1 };
    });

    const retryCtx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append: fakeAppend,
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const args = { title: 'Retry test', body: 'Phase A retry', listIssuesByMarker: emptyMarkerScan };

    const result = await handleCreateIssue(args, retryCtx);

    // The handler should succeed after the Phase A retry.
    expect(result.success).toBe(true);

    // Property 1: Phase A was retried (the retry loop engaged).
    // RED with current handler: no Phase A → phaseAAttempts === 0 → fails.
    expect(phaseAAttempts).toBeGreaterThanOrEqual(2);

    // Property 2: the non-idempotent VCS createIssue side effect must fire
    // AT MOST ONCE across all Phase A retry attempts.
    expect(mockProvider.createIssue).toHaveBeenCalledTimes(1);
  });

  // ─── B3.3 RED: Idempotent recovery via operationId marker in issue body ────
  //
  // Simulates the crash-recovery scenario: issue.create.requested was committed
  // to the stream, the issue was created on GitHub (body has the marker), but
  // the handler crashed before emitting issue.create.executed.
  //
  // On re-invocation: the handler must detect the existing issue via the
  // operationId marker, emit issue.create.executed with the existing issue's
  // data, and NOT call createIssue again.
  it('CreateIssue_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate', async () => {
    const existingOperationId = 'a1b2c3d4-0000-0000-0000-000000000001';
    const existingIssueNumber = 456;
    const existingIssueUrl = 'https://github.com/repo/issues/456';

    // Stub listIssuesByMarker to return an existing issue whose body
    // contains the operationId marker — simulates the crashed state where
    // the issue was created but issue.create.executed was never committed.
    const listIssuesByMarker = vi.fn().mockResolvedValue([
      {
        number: existingIssueNumber,
        url: existingIssueUrl,
        body: `Issue body\n\n<!-- exarchos-op:${existingOperationId} -->`,
      },
    ]);

    const idempotentCtx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append: vi.fn().mockResolvedValue({ sequence: 1 }),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const args = {
      title: 'Recovery test',
      body: 'Original body',
      operationId: existingOperationId,
      listIssuesByMarker,
    };

    const result = await handleCreateIssue(args, idempotentCtx);

    // The handler must NOT call createIssue — the issue already exists.
    expect(mockProvider.createIssue).not.toHaveBeenCalled();

    // The handler must emit issue.create.executed with the existing issue data.
    // The append carries an idempotencyKey so retries dedupe at the EventStore.
    expect(idempotentCtx.eventStore.append).toHaveBeenCalledWith(
      'vcs',
      {
        type: 'issue.create.executed',
        data: {
          operationId: existingOperationId,
          issueNumber: existingIssueNumber,
          url: existingIssueUrl,
        },
      },
      { idempotencyKey: `issue.create.executed:${existingOperationId}` },
    );

    expect(result.success).toBe(true);
    expect((result.data as { issueNumber: number }).issueNumber).toBe(existingIssueNumber);
  });

  // ─── CodeRabbit #3224631237: missing listIssuesByMarker must refuse to run ──
  //
  // The handler MUST NOT fall back to a silent no-op precheck — that disables
  // recovery and produces duplicate issues. The dependency is required at the
  // handler boundary; the composite handler injects the provider-backed real
  // implementation.
  it('CreateIssue_MissingListIssuesByMarker_RefusesAndDoesNotCallProvider', async () => {
    // Note: we deliberately omit listIssuesByMarker from args.
    // TypeScript would normally block this at the call site; the handler's
    // runtime guard is defense-in-depth for callers that bypass the type.
    const args = { title: 'Bug', body: 'Details' } as unknown as Parameters<
      typeof handleCreateIssue
    >[0];

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRECONDITION_FAILED');

    // Critical: provider.createIssue was NOT called — would duplicate on retry.
    expect(mockProvider.createIssue).not.toHaveBeenCalled();
  });

  // ─── CodeRabbit #3224631237: precheck failure must NOT fall through to create
  //
  // When the marker scan fails (provider unhealthy, network error, etc.) the
  // handler MUST surface the failure rather than proceed with creating a
  // possibly-duplicate issue.
  it('CreateIssue_PrecheckFailure_DoesNotCallProvider', async () => {
    const failingScan = vi.fn().mockRejectedValue(new Error('gh search unavailable'));

    const args = {
      title: 'Bug',
      body: 'Details',
      listIssuesByMarker: failingScan,
    };

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRECHECK_FAILED');
    expect(result.error?.message).toContain('gh search unavailable');

    // The non-idempotent side effect MUST NOT fire when we cannot verify
    // whether a prior invocation already created the issue.
    expect(mockProvider.createIssue).not.toHaveBeenCalled();
  });

  // ─── CodeRabbit review #4278133032: operationId-recovery must not fail-open ──
  //
  // recoverOperationId previously swallowed eventStore.query failures and let
  // the handler mint a fresh UUID. After a Phase-A/Phase-C crash this
  // produced a duplicate issue: the body marker was the OLD UUID, the
  // marker scan searched for the NEW UUID, and Phase C re-fired
  // gh issue create. The handler now propagates query failures as
  // PRECHECK_FAILED so the operation can be retried once the event store
  // is healthy.
  it('CreateIssue_RecoverOperationIdQueryFailure_ReturnsPrecheckFailedWithoutCallingProvider', async () => {
    const failingQueryCtx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append: vi.fn().mockResolvedValue({ sequence: 1 }),
        query: vi.fn().mockRejectedValue(new Error('event store offline')),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const args = {
      title: 'Bug',
      body: 'Details',
      listIssuesByMarker: vi.fn().mockResolvedValue([]),
    };

    const result = await handleCreateIssue(args, failingQueryCtx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRECHECK_FAILED');
    expect(result.error?.message).toContain('event store offline');
    expect(mockProvider.createIssue).not.toHaveBeenCalled();
  });
});
