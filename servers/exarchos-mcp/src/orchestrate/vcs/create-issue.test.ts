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
    getRepository: vi.fn(),
    ...overrides,
  };
}

function makeMockCtx(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append: vi.fn().mockResolvedValue({ sequence: 1 }),
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
    const args = { title: 'Bug: crash on load', body: 'Steps to reproduce...' };

    await handleCreateIssue(args, ctx);

    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug: crash on load',
      body: 'Steps to reproduce...',
      labels: undefined,
    });
  });

  it('handleCreateIssue_Success_ReturnsSuccessWithData', async () => {
    const args = { title: 'Bug: crash', body: 'Details' };

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ number: 123, url: 'https://github.com/repo/issues/123' });
  });

  it('handleCreateIssue_WithLabels_PassedToProvider', async () => {
    const args = { title: 'Bug', body: 'Details', labels: ['bug', 'priority-high'] };

    await handleCreateIssue(args, ctx);

    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug',
      body: 'Details',
      labels: ['bug', 'priority-high'],
    });
  });

  it('handleCreateIssue_Success_EmitsIssueCreatedEvent', async () => {
    const args = { title: 'Bug', body: 'Details' };

    await handleCreateIssue(args, ctx);

    expect(ctx.eventStore.append).toHaveBeenCalledWith('vcs', {
      type: 'issue.created',
      data: {
        provider: 'github',
        issueNumber: 123,
        url: 'https://github.com/repo/issues/123',
      },
    });
  });

  it('handleCreateIssue_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.createIssue).mockRejectedValue(new Error('Rate limited'));

    const args = { title: 'Bug', body: 'Details' };

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
      eventStore: { append: fakeAppend } as unknown as EventStore,
      enableTelemetry: false,
    };

    const args = { title: 'Retry test', body: 'Phase A retry' };

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
    expect(idempotentCtx.eventStore.append).toHaveBeenCalledWith('vcs', {
      type: 'issue.create.executed',
      data: {
        operationId: existingOperationId,
        issueNumber: existingIssueNumber,
        url: existingIssueUrl,
      },
    });

    expect(result.success).toBe(true);
    expect((result.data as { issueNumber: number }).issueNumber).toBe(existingIssueNumber);
  });
});
