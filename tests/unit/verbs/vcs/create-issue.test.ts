import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../../../src/vcs/provider.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { ConcurrencyError } from '../../../../src/events/index.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleCreateIssue } from '../../../../src/verbs/vcs/create-issue.js';

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
 * An empty marker scan for tests that do not run the recovery path. The
 * handler refuses to run without `listIssuesByMarker`.
 */
const emptyMarkerScan = vi.fn().mockResolvedValue([]);

/**
 * A context whose event store `query` returns no rows, so the handler uses a
 * fresh UUID. A failed `query` makes the handler return an error.
 */
function makeMockCtx(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append: vi.fn().mockResolvedValue({ sequence: 1 }),
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

  /** The provider gets the body with an operation id marker appended for idempotency. */
  it('handleCreateIssue_ValidArgs_CallsProviderCreateIssue', async () => {
    const args = {
      title: 'Bug: crash on load',
      body: 'Steps to reproduce...',
      listIssuesByMarker: emptyMarkerScan,
    };

    await handleCreateIssue(args, ctx);

    expect(mockProvider.createIssue).toHaveBeenCalledWith({
      title: 'Bug: crash on load',
      body: expect.stringContaining('Steps to reproduce...'),
      labels: undefined,
      assignees: undefined,
    });
    const call = vi.mocked(mockProvider.createIssue).mock.calls[0][0];
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
      body: expect.stringContaining('Details'),
      labels: ['bug', 'priority-high'],
      assignees: undefined,
    });
  });

  /** The provider must get the assignees, not only the intent event. */
  it('handleCreateIssue_WithAssignees_PassedToProvider', async () => {
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

  /**
   * The handler appends `issue.create.requested` before the provider call and
   * `issue.create.executed` after it. Both events carry one operation id.
   */
  it('handleCreateIssue_Success_EmitsTwoEventSequence', async () => {
    const args = { title: 'Bug', body: 'Details', listIssuesByMarker: emptyMarkerScan };

    await handleCreateIssue(args, ctx);

    const appendCalls = vi.mocked(ctx.eventStore.append).mock.calls;
    expect(appendCalls.length).toBe(2);

    expect(appendCalls[0][0]).toBe('vcs');
    expect(appendCalls[0][1]).toMatchObject({
      type: 'issue.create.requested',
      data: { title: 'Bug' },
    });

    const executedCall = appendCalls[1][1] as { type: string; data: { operationId: string; issueNumber: number; url: string } };
    expect(appendCalls[1][0]).toBe('vcs');
    expect(executedCall.type).toBe('issue.create.executed');
    expect(executedCall.data.issueNumber).toBe(123);
    expect(executedCall.data.url).toBe('https://github.com/repo/issues/123');

    const requestedData = appendCalls[0][1] as { data: { operationId: string } };
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

  /**
   * The first `issue.create.requested` append throws `ConcurrencyError`. The
   * handler must retry that append and call the non-idempotent `createIssue`
   * exactly once.
   */
  it('CreateIssue_PhaseARetry_DoesNotRefireGhIssueCreate', async () => {
    let phaseAAttempts = 0;
    const fakeAppend = vi.fn().mockImplementation(async (_streamId: string, event: { type: string }) => {
      if (event.type === 'issue.create.requested') {
        phaseAAttempts += 1;
        if (phaseAAttempts === 1) {
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

    expect(result.success).toBe(true);

    expect(phaseAAttempts).toBeGreaterThanOrEqual(2);

    expect(mockProvider.createIssue).toHaveBeenCalledTimes(1);
  });

  /**
   * A crash leaves an issue with the marker in its body but no
   * `issue.create.executed` event. The handler must find the issue by its
   * marker and append `issue.create.executed` for it with an idempotency key.
   * It must not call `createIssue`.
   */
  it('CreateIssue_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate', async () => {
    const existingOperationId = 'a1b2c3d4-0000-0000-0000-000000000001';
    const existingIssueNumber = 456;
    const existingIssueUrl = 'https://github.com/repo/issues/456';

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

    expect(mockProvider.createIssue).not.toHaveBeenCalled();

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

  /**
   * Without `listIssuesByMarker`, the handler must refuse to run. A no-op
   * precheck disables recovery and can create duplicate issues. The cast skips
   * the type check, so the runtime guard is the subject.
   */
  it('CreateIssue_MissingListIssuesByMarker_RefusesAndDoesNotCallProvider', async () => {
    const args = { title: 'Bug', body: 'Details' } as unknown as Parameters<
      typeof handleCreateIssue
    >[0];

    const result = await handleCreateIssue(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRECONDITION_FAILED');

    expect(mockProvider.createIssue).not.toHaveBeenCalled();
  });

  /**
   * When the marker scan fails, the handler must return the failure. It must
   * not create an issue that a prior call possibly created.
   */
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

    expect(mockProvider.createIssue).not.toHaveBeenCalled();
  });

  /**
   * When the recovery query fails, the handler must return `PRECHECK_FAILED`.
   * After a crash, a fresh UUID does not match the old body marker. Then the
   * scan misses the issue, and the handler creates a duplicate.
   */
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
