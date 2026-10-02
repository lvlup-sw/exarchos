import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../../../src/vcs/provider.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { ConcurrencyError } from '../../../../src/events/index.js';
import { deriveIntent, INTENT_GROUNDING_MARKER } from '../../../../src/verbs/tasks/extract-intent.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleCreatePr } from '../../../../src/verbs/vcs/create-pr.js';

/**
 * A provider that creates PR 42. `listPrs` returns no PRs by default. A bare
 * `vi.fn()` returns `undefined`, and the handler then fails closed with
 * `PRECHECK_FAILED`.
 */
function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn().mockResolvedValue({ url: 'https://github.com/repo/pull/42', number: 42 }),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn().mockResolvedValue([]),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
    ...overrides,
  };
}

function makeMockCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append: vi.fn().mockResolvedValue({ sequence: 1, type: 'pr.created', timestamp: new Date().toISOString() }),
    } as unknown as EventStore,
    enableTelemetry: false,
    ...overrides,
  };
}

/**
 * A context with mock `append` and `query`. `query` returns `queryResult`, so
 * a test can seed the workflow events that the handler reads.
 */
function makeTwoEventCtx(overrides: {
  appendResult?: Record<string, unknown>;
  queryResult?: unknown[];
} = {}): DispatchContext {
  const append = vi.fn().mockResolvedValue(
    overrides.appendResult ?? {
      sequence: 2,
      type: 'pr.create.executed',
      timestamp: new Date().toISOString(),
    },
  );
  const query = vi.fn().mockResolvedValue(overrides.queryResult ?? []);
  return {
    stateDir: '/tmp/test-state',
    eventStore: {
      append,
      query,
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

describe('handleCreatePr', () => {
  let mockProvider: VcsProvider;
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);
    ctx = makeTwoEventCtx();
  });

  it('handleCreatePr_ValidArgs_CallsProviderCreatePr', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Implements VCS MCP actions',
      base: 'main',
      head: 'feature/vcs-actions',
    };

    await handleCreatePr(args, ctx);

    expect(mockProvider.createPr).toHaveBeenCalledWith({
      title: 'feat: add VCS actions',
      body: 'Implements VCS MCP actions',
      baseBranch: 'main',
      headBranch: 'feature/vcs-actions',
      draft: undefined,
      labels: undefined,
    });
  });

  it('handleCreatePr_ValidArgs_ReturnsSuccessWithData', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Implements VCS MCP actions',
      base: 'main',
      head: 'feature/vcs-actions',
    };

    const result = await handleCreatePr(args, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ url: 'https://github.com/repo/pull/42', number: 42 });
  });

  it('handleCreatePr_DraftAndLabels_PassedToProvider', async () => {
    const args = {
      title: 'feat: WIP',
      body: 'Draft PR',
      base: 'main',
      head: 'feature/wip',
      draft: true,
      labels: ['enhancement', 'wip'],
    };

    await handleCreatePr(args, ctx);

    expect(mockProvider.createPr).toHaveBeenCalledWith({
      title: 'feat: WIP',
      body: 'Draft PR',
      baseBranch: 'main',
      headBranch: 'feature/wip',
      draft: true,
      labels: ['enhancement', 'wip'],
    });
  });

  /**
   * The `pr.create.executed` data carries the operation id, the PR number and
   * the URL. The branch fields are in `pr.create.requested`.
   */
  it('handleCreatePr_Success_EmitsPrCreateExecutedEvent', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Body',
      base: 'main',
      head: 'feature/vcs',
    };

    await handleCreatePr(args, ctx);

    const appendCalls = vi.mocked(ctx.eventStore.append).mock.calls;
    const executedCall = appendCalls.find(
      (call) => (call[1] as { type: string }).type === 'pr.create.executed',
    );
    expect(executedCall).toBeDefined();
    const executedData = (executedCall![1] as { data: { prNumber: number; url: string; operationId: string } }).data;
    expect(executedData.prNumber).toBe(42);
    expect(executedData.url).toBe('https://github.com/repo/pull/42');
    expect(typeof executedData.operationId).toBe('string');
  });

  it('handleCreatePr_ProviderError_ReturnsFailure', async () => {
    vi.mocked(mockProvider.createPr).mockRejectedValue(new Error('Network error'));

    const args = {
      title: 'feat: broken',
      body: 'Body',
      base: 'main',
      head: 'feature/broken',
    };

    const result = await handleCreatePr(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VCS_ERROR');
    expect(result.error?.message).toContain('Network error');
  });

  /**
   * When `listPrs` fails, the handler must return `PRECHECK_FAILED` and not
   * call `createPr`. A create after a failed lookup can open a duplicate PR on
   * each retry.
   */
  it('handleCreatePr_ListPrsFailure_ReturnsPrecheckFailedWithoutCallingCreatePr', async () => {
    const failingProvider = makeMockProvider({
      listPrs: vi.fn().mockRejectedValue(new Error('GitHub API timeout')),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(failingProvider);

    const args = {
      title: 'feat: precheck-fails',
      body: 'Body',
      base: 'main',
      head: 'feature/precheck-fails',
    };

    const result = await handleCreatePr(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PRECHECK_FAILED');
    expect(result.error?.message).toContain('listPrs');
    expect(result.error?.message).toContain('GitHub API timeout');
    expect(failingProvider.createPr).not.toHaveBeenCalled();
  });
});

/**
 * The first `pr.create.requested` append throws `ConcurrencyError`. The handler
 * must retry that append and call `createPr` exactly once, after the append
 * succeeds. The append mock gets three calls: the failure, the retry, and
 * `pr.create.executed`.
 */
describe('CreatePr_PhaseARetry_DoesNotRefireGhPrCreate (B1.2 RED)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CreatePr_PhaseARetry_DoesNotRefireGhPrCreate', async () => {
    const concurrencyErr = new ConcurrencyError('sequence mismatch on first attempt');
    const append = vi.fn()
      .mockRejectedValueOnce(concurrencyErr)
      .mockResolvedValueOnce({
        sequence: 1,
        type: 'pr.create.requested',
        timestamp: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        sequence: 2,
        type: 'pr.create.executed',
        timestamp: new Date().toISOString(),
      });

    const ctx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append,
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    await handleCreatePr(
      { title: 'feat: retry test', body: 'Body', base: 'main', head: 'feature/retry' },
      ctx,
    );

    expect(append).toHaveBeenCalledTimes(3);

    expect(mockProvider.createPr).toHaveBeenCalledTimes(1);
  });
});

/**
 * An append error that is not `ConcurrencyError` or `StorageBusyError` must
 * return `APPEND_FAILED`, not throw, and `createPr` must not run. A throw
 * reaches the dispatch safety net, which reports a generic `INTERNAL_ERROR`.
 */
describe('CreatePr_PhaseAAppendUnknownError_ReturnsCodedEnvelopeNotThrow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CreatePr_PhaseAAppendUnknownError_ReturnsCodedEnvelopeNotThrow', async () => {
    const append = vi.fn().mockRejectedValue(new Error('disk full'));

    const ctx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append,
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const mockProvider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const result = await handleCreatePr(
      { title: 'feat: unknown-append-error', body: 'Body', base: 'main', head: 'feature/unknown' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('APPEND_FAILED');
    expect(result.error?.message).toContain('disk full');
    expect(mockProvider.createPr).not.toHaveBeenCalled();
  });
});

/**
 * `listPrs` finds an open PR with the same head and base, left by an
 * interrupted call. The handler must not call `createPr`. It must append
 * `pr.create.executed` with the number of that PR.
 */
describe('CreatePr_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate (B1.3 RED)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CreatePr_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate', async () => {
    const append = vi.fn().mockResolvedValue({
      sequence: 3,
      type: 'pr.create.executed',
      timestamp: new Date().toISOString(),
    });

    const existingPr = {
      number: 99,
      url: 'https://github.com/repo/pull/99',
      title: 'feat: interrupted',
      headRefName: 'feature/interrupted',
      baseRefName: 'main',
      state: 'open',
    };

    const mockProvider = makeMockProvider({
      listPrs: vi.fn().mockResolvedValue([existingPr]),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const ctx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append,
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    const result = await handleCreatePr(
      { title: 'feat: interrupted', body: 'Body', base: 'main', head: 'feature/interrupted' },
      ctx,
    );

    expect(mockProvider.createPr).not.toHaveBeenCalled();

    expect(result.success).toBe(true);
    const executedCall = (append as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[1] as { type: string }).type === 'pr.create.executed',
    );
    expect(executedCall).toBeDefined();
    const executedData = (executedCall![1] as { data: { prNumber: number; url: string } }).data;
    expect(executedData.prNumber).toBe(99);
    expect(executedData.url).toBe('https://github.com/repo/pull/99');
  });
});

/**
 * `listPrs` finds an open PR, but the recovery append of `pr.create.executed`
 * throws. The error must propagate, and the handler must not fall through to
 * `createPr`, which opens a duplicate PR.
 */
describe('CreatePr_RecoveryAppendFailure_DoesNotFallThroughToCreatePr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CreatePr_RecoveryAppendFailure_DoesNotFallThroughToCreatePr', async () => {
    let appendCallCount = 0;
    const append = vi.fn().mockImplementation(
      async (_streamId: string, event: { type: string }) => {
        appendCallCount += 1;
        if (event.type === 'pr.create.requested') {
          return {
            sequence: 1,
            type: 'pr.create.requested',
            timestamp: new Date().toISOString(),
          };
        }
        throw new Error('event store unavailable');
      },
    );

    const existingPr = {
      number: 77,
      url: 'https://github.com/repo/pull/77',
      title: 'feat: prior crash',
      headRefName: 'feature/prior',
      baseRefName: 'main',
      state: 'open',
    };

    const mockProvider = makeMockProvider({
      listPrs: vi.fn().mockResolvedValue([existingPr]),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(mockProvider);

    const ctx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append,
        query: vi.fn().mockResolvedValue([]),
      } as unknown as EventStore,
      enableTelemetry: false,
    };

    await expect(
      handleCreatePr(
        { title: 'feat: prior crash', body: 'Body', base: 'main', head: 'feature/prior' },
        ctx,
      ),
    ).rejects.toThrow('event store unavailable');

    expect(mockProvider.createPr).not.toHaveBeenCalled();

    expect(appendCallCount).toBe(2);
  });
});

/**
 * With a `featureId` and a meaningful `artifacts.intent`, the handler adds an
 * `## Intent` section and a marker before the `pr.create.requested` append.
 * Thus the event and the PR carry the same body. Without a `featureId`, with
 * an empty intent, or with a marked body, the body stays the same. The test
 * events set `artifacts.intent` through the real projection.
 */
describe('CreatePr_Body_ReferencesIntent (DR-1 task 006)', () => {
  function intentPatchEvent(patch: Record<string, unknown>) {
    return {
      streamId: 'feat-x',
      sequence: 1,
      type: 'state.patched',
      timestamp: new Date().toISOString(),
      data: { patch },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);
  });

  it('CreatePr_MeaningfulIntent_EnrichesRequestedEventAndCreatedPrBody', async () => {
    const intent = deriveIntent(['servers/a.ts', 'docs/b.md']);
    const ctx = makeTwoEventCtx({
      queryResult: [intentPatchEvent({ 'artifacts.intent': intent })],
    });
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const result = await handleCreatePr(
      {
        title: 'feat: thing',
        body: '## Summary\n\nDoes a thing.',
        base: 'main',
        head: 'feature/thing',
        featureId: 'feat-x',
      },
      ctx,
    );

    expect(result.success).toBe(true);

    const createArg = vi.mocked(provider.createPr).mock.calls[0][0];
    expect(createArg.body).toContain('## Intent');
    expect(createArg.body).toContain(INTENT_GROUNDING_MARKER);
    expect(createArg.body).toContain(intent.summary);
    expect(createArg.body).toContain('Does a thing.');

    const requestedCall = vi
      .mocked(ctx.eventStore.append)
      .mock.calls.find((call) => (call[1] as { type: string }).type === 'pr.create.requested');
    expect(requestedCall).toBeDefined();
    const requestedBody = (requestedCall![1] as { data: { body: string } }).data.body;
    expect(requestedBody).toContain(INTENT_GROUNDING_MARKER);
    expect(requestedBody).toBe(createArg.body);
  });

  it('CreatePr_NoFeatureId_LeavesBodyUntouched', async () => {
    const ctx = makeTwoEventCtx();
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const body = '## Summary\n\nNo grounding here.';
    await handleCreatePr(
      { title: 'feat: thing', body, base: 'main', head: 'feature/thing' },
      ctx,
    );

    const createArg = vi.mocked(provider.createPr).mock.calls[0][0];
    expect(createArg.body).toBe(body);
    expect(createArg.body).not.toContain(INTENT_GROUNDING_MARKER);
  });

  /** A stored intent with no changed files is not meaningful, so the body stays the same. */
  it('CreatePr_EmptyIntent_LeavesBodyUntouched', async () => {
    const empty = deriveIntent([]);
    const ctx = makeTwoEventCtx({
      queryResult: [intentPatchEvent({ 'artifacts.intent': empty })],
    });
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const body = '## Summary\n\nNothing changed.';
    await handleCreatePr(
      { title: 'feat: thing', body, base: 'main', head: 'feature/thing', featureId: 'feat-x' },
      ctx,
    );

    const createArg = vi.mocked(provider.createPr).mock.calls[0][0];
    expect(createArg.body).toBe(body);
    expect(createArg.body).not.toContain(INTENT_GROUNDING_MARKER);
  });

  /** When the body already carries the marker, the handler must not add a second section. */
  it('CreatePr_BodyAlreadyGrounded_DoesNotDoubleInject', async () => {
    const intent = deriveIntent(['servers/a.ts']);
    const ctx = makeTwoEventCtx({
      queryResult: [intentPatchEvent({ 'artifacts.intent': intent })],
    });
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const body = `## Summary\n\nBody.\n\n## Intent\n\n${INTENT_GROUNDING_MARKER}\n\n**Surfaces:** servers`;
    await handleCreatePr(
      { title: 'feat: thing', body, base: 'main', head: 'feature/thing', featureId: 'feat-x' },
      ctx,
    );

    const createArg = vi.mocked(provider.createPr).mock.calls[0][0];
    expect(createArg.body).toBe(body);
    expect(createArg.body.split(INTENT_GROUNDING_MARKER).length - 1).toBe(1);
  });
});

/**
 * Only the initial synthesize creates a PR. The shepherd loop runs in the same
 * phase, so a phase check cannot block it. When the projected state records a
 * PR in `artifacts.pr` or `synthesis.prUrl`, the handler refuses with
 * `PR_ALREADY_OWNED` and has no side effect. The `listPrs` guard covers the
 * crash window before the state records the PR.
 */
describe('CreatePr_SinglePrOwnerGuard (DR-4 task 007)', () => {
  function prPatchEvent(patch: Record<string, unknown>) {
    return {
      streamId: 'feat-owned',
      sequence: 1,
      type: 'state.patched',
      timestamp: new Date().toISOString(),
      data: { patch },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The state records the PR in `artifacts.pr` and in `synthesis.prUrl`, as
   * after the initial synthesize. The guard runs before any append.
   */
  it('CreatePr_ShepherdContext_Refused', async () => {
    const ctx = makeTwoEventCtx({
      queryResult: [
        prPatchEvent({
          'artifacts.pr': 'https://github.com/repo/pull/100',
          'synthesis.prUrl': 'https://github.com/repo/pull/100',
        }),
      ],
    });
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const result = await handleCreatePr(
      {
        title: 'feat: resubmit from shepherd',
        body: 'Body',
        base: 'main',
        head: 'feature/owned',
        featureId: 'feat-owned',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PR_ALREADY_OWNED');
    expect(result.error?.message).toContain('feat-owned');

    expect(provider.createPr).not.toHaveBeenCalled();

    const requestedAppend = vi
      .mocked(ctx.eventStore.append)
      .mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'pr.create.requested',
      );
    expect(requestedAppend).toBeUndefined();
    expect(vi.mocked(ctx.eventStore.append)).not.toHaveBeenCalled();
  });

  /** Only `synthesis.prUrl` records the PR. Either field must cause the refusal. */
  it('CreatePr_OwnedViaPrUrlOnly_Refused', async () => {
    const ctx = makeTwoEventCtx({
      queryResult: [
        prPatchEvent({ 'synthesis.prUrl': 'https://github.com/repo/pull/101' }),
      ],
    });
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const result = await handleCreatePr(
      {
        title: 'feat: resubmit',
        body: 'Body',
        base: 'main',
        head: 'feature/owned',
        featureId: 'feat-owned',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PR_ALREADY_OWNED');
    expect(provider.createPr).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.eventStore.append)).not.toHaveBeenCalled();
  });

  /**
   * Without a `featureId`, the handler skips the state guard. The `listPrs`
   * guard must then return the open PR for the same head and base and append
   * `pr.create.executed` for it, with no second create.
   */
  it('CreatePr_DoubleCreateGuard_RetainedAndPinned', async () => {
    const existingPr = {
      number: 88,
      url: 'https://github.com/repo/pull/88',
      title: 'feat: recovered',
      headRefName: 'feature/recovered',
      baseRefName: 'main',
      state: 'open',
    };
    const provider = makeMockProvider({
      listPrs: vi.fn().mockResolvedValue([existingPr]),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(provider);
    const ctx = makeTwoEventCtx();

    const result = await handleCreatePr(
      {
        title: 'feat: recovered',
        body: 'Body',
        base: 'main',
        head: 'feature/recovered',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ url: existingPr.url, number: existingPr.number });
    expect(provider.createPr).not.toHaveBeenCalled();

    const executedAppend = vi
      .mocked(ctx.eventStore.append)
      .mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'pr.create.executed',
      );
    expect(executedAppend).toBeDefined();
    const executedData = (
      executedAppend![1] as { data: { prNumber: number; url: string } }
    ).data;
    expect(executedData.prNumber).toBe(88);
    expect(executedData.url).toBe(existingPr.url);
  });

  /**
   * The state records no PR, as on the first create. The state guard must not
   * refuse, and `listPrs` finds no PR, so the handler creates one.
   */
  it('CreatePr_FeatureIdButNoPrRecorded_ProceedsToNormalCreate', async () => {
    const ctx = makeTwoEventCtx({ queryResult: [] });
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const result = await handleCreatePr(
      {
        title: 'feat: initial synthesize',
        body: 'Body',
        base: 'main',
        head: 'feature/fresh',
        featureId: 'feat-fresh',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(provider.createPr).toHaveBeenCalledTimes(1);
  });
});

/**
 * The handler prevents a duplicate PR without a check by the caller. With a
 * `featureId` but no recorded PR, the state guard does not refuse. The
 * `listPrs` guard must then return the open PR for the same head and base,
 * append `pr.create.executed` for it, and not call `createPr`.
 */
describe('PrIdempotency_SingleAuthority_HandlerGuardOnly (DR-4 task 009)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PrIdempotency_SingleAuthority_HandlerGuardOnly', async () => {
    const existingPr = {
      number: 55,
      url: 'https://github.com/repo/pull/55',
      title: 'feat: single-authority',
      headRefName: 'feature/single-authority',
      baseRefName: 'main',
      state: 'open',
    };
    const provider = makeMockProvider({
      listPrs: vi.fn().mockResolvedValue([existingPr]),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(provider);
    const ctx = makeTwoEventCtx({ queryResult: [] });

    const result = await handleCreatePr(
      {
        title: 'feat: single-authority',
        body: 'Body',
        base: 'main',
        head: 'feature/single-authority',
        featureId: 'feat-single-authority',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ url: existingPr.url, number: existingPr.number });

    expect(provider.createPr).not.toHaveBeenCalled();

    const executedAppend = vi
      .mocked(ctx.eventStore.append)
      .mock.calls.find(
        (call) => (call[1] as { type: string }).type === 'pr.create.executed',
      );
    expect(executedAppend).toBeDefined();
    const executedData = (
      executedAppend![1] as { data: { prNumber: number; url: string } }
    ).data;
    expect(executedData.prNumber).toBe(55);
    expect(executedData.url).toBe(existingPr.url);
  });
});
