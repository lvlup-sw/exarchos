import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { ConcurrencyError } from '../../event-store/index.js';
import { deriveIntent, INTENT_GROUNDING_MARKER } from '../extract-intent.js';

// Mock the factory before importing the handler
vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleCreatePr } from './create-pr.js';

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn().mockResolvedValue({ url: 'https://github.com/repo/pull/42', number: 42 }),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    // Default to "no existing PR" so the happy-path tests fall through to
    // provider.createPr(). Sentry #14059252/0 hardened the recovery
    // precheck to fail-closed (PRECHECK_FAILED) on listPrs failure, so a
    // bare vi.fn() (returns undefined → throws inside the handler) would
    // misroute every test through the new error envelope.
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
 * Build a DispatchContext with a two-event-split-aware mock event store.
 * The B1.4 refactored handler uses ctx.eventStore.append() with idempotencyKey
 * (no getAppender/decide needed — the handler uses append directly).
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
    // Use two-event-split-aware context: includes getAppender().decide() and listPrs stub.
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

  it('handleCreatePr_Success_EmitsPrCreateExecutedEvent', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Body',
      base: 'main',
      head: 'feature/vcs',
    };

    await handleCreatePr(args, ctx);

    // Two-event split: handler now emits `pr.create.executed` (Phase B) instead
    // of the legacy `pr.created`. The event data carries operationId (UUID),
    // prNumber, and url — no provider name or branch fields (those live in
    // `pr.create.requested` committed during Phase A).
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

  // ─── Sentry #14059252/0: listPrs failure must fail-closed ────────────────
  //
  // The recovery precheck MUST NOT swallow listPrs failures. If we cannot
  // determine whether a prior PR exists, proceeding to provider.createPr()
  // would risk a duplicate PR every retry — exactly the behaviour the
  // two-event split was meant to prevent. The handler returns
  // PRECHECK_FAILED so the caller can retry once the provider is healthy.
  // Mirrors the handleCreateIssue contract (CodeRabbit #3224631237).
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
    // The non-idempotent side effect must NOT have fired.
    expect(failingProvider.createPr).not.toHaveBeenCalled();
  });
});

// ─── B1.2: Phase-A retry must not refire gh pr create ───────────────────────
//
// When `pr.create.requested` commit (Phase A) throws ConcurrencyError on the
// first attempt and withStateRetry fires a second attempt, the handler must NOT
// call createPr again on the retry cycle. The side effect (createPr) must be
// called AT MOST ONCE across the entire retry sequence.
//
// Expected initial failure: the current single-event handler calls createPr
// unconditionally; a retry would invoke it a second time. The two-event split
// (B1.4) moves createPr AFTER the durable Phase A commit, so a retry that
// succeeds on Phase A does not see createPr as a "missed" step.
// ─────────────────────────────────────────────────────────────────────────────

describe('CreatePr_PhaseARetry_DoesNotRefireGhPrCreate (B1.2 RED)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CreatePr_PhaseARetry_DoesNotRefireGhPrCreate', async () => {
    // Arrange: Phase A append throws ConcurrencyError on first call; second succeeds.
    // The idempotencyKey on the Phase A append ensures the EventStore deduplicates
    // on retry — the retry calls append again with the same idempotencyKey, which
    // the substrate deduplicates. The key invariant is that createPr (the SIDE EFFECT)
    // only fires AFTER Phase A succeeds, never during or before the retry.
    const concurrencyErr = new ConcurrencyError('sequence mismatch on first attempt');
    const append = vi.fn()
      // First call is Phase A (pr.create.requested) — simulates OCC loss.
      .mockRejectedValueOnce(concurrencyErr)
      // Second call is Phase A retry — succeeds.
      .mockResolvedValueOnce({
        sequence: 1,
        type: 'pr.create.requested',
        timestamp: new Date().toISOString(),
      })
      // Third call is Phase B (pr.create.executed) — succeeds.
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

    // Act
    await handleCreatePr(
      { title: 'feat: retry test', body: 'Body', base: 'main', head: 'feature/retry' },
      ctx,
    );

    // Assert: append was called at least twice for Phase A (one ConcurrencyError, one success).
    // The append mock was called: [Phase A fail, Phase A retry, Phase B].
    expect(append).toHaveBeenCalledTimes(3);

    // Assert: createPr was called AT MOST ONCE across the entire retry cycle.
    // With the two-event split, Phase A is committed first (retried on ConcurrencyError),
    // then createPr fires ONCE after Phase A succeeds — never during the Phase A retry itself.
    expect(mockProvider.createPr).toHaveBeenCalledTimes(1);
  });
});

// ─── B1.3: Idempotent check — requested-but-not-executed recovery ────────────
//
// When `pr.create.requested` is already committed to the stream (prior interrupted
// invocation) but `pr.create.executed` is NOT, and listPrs returns a PR matching
// the requested (head, base), the handler must:
//   1. NOT call createPr (would create a duplicate PR).
//   2. Emit `pr.create.executed` with the existing PR's number.
//
// Expected initial failure: the current single-event handler always calls createPr
// without checking for an existing PR first. The B1.4 refactor adds the idempotent
// (head, base) check before invoking gh pr create.
// ─────────────────────────────────────────────────────────────────────────────

describe('CreatePr_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate (B1.3 RED)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CreatePr_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate', async () => {
    // Arrange: Phase A append succeeds (EventStore idempotency key deduplicates the
    // prior `pr.create.requested` — in the real substrate, the same idempotencyKey
    // returns the cached event; in the mock, we just let append succeed unconditionally
    // for Phase A and focus on the listPrs → short-circuit path).
    const append = vi.fn().mockResolvedValue({
      sequence: 3,
      type: 'pr.create.executed',
      timestamp: new Date().toISOString(),
    });

    // listPrs returns one PR matching the requested (head, base) — simulating
    // a prior successful gh pr create that crashed before pr.create.executed was committed.
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

    // Act
    const result = await handleCreatePr(
      { title: 'feat: interrupted', body: 'Body', base: 'main', head: 'feature/interrupted' },
      ctx,
    );

    // Assert: createPr was NOT called — would create a duplicate PR.
    expect(mockProvider.createPr).not.toHaveBeenCalled();

    // Assert: pr.create.executed was emitted with the existing PR's number.
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

// ─── CodeRabbit #3224631250: recovery-path append failure must NOT fall through ─
//
// When listPrs() returns an existing PR and the subsequent recovery-path append
// of `pr.create.executed` fails, the handler must propagate the failure rather
// than silently fall through to provider.createPr() (which would open a
// duplicate PR). Verifies the narrowed try/catch boundary.
// ─────────────────────────────────────────────────────────────────────────────

describe('CreatePr_RecoveryAppendFailure_DoesNotFallThroughToCreatePr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CreatePr_RecoveryAppendFailure_DoesNotFallThroughToCreatePr', async () => {
    // Arrange: append succeeds for Phase A (pr.create.requested) then THROWS
    // when the handler tries to commit the recovery-path pr.create.executed.
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
        // Recovery-path pr.create.executed append — synthesize a substrate failure.
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

    // Act + Assert: the recovery-path append failure propagates up the stack.
    // It is NOT silently swallowed and converted into a fall-through to
    // provider.createPr() — which would open a duplicate PR (the very
    // condition the idempotent check is designed to prevent).
    await expect(
      handleCreatePr(
        { title: 'feat: prior crash', body: 'Body', base: 'main', head: 'feature/prior' },
        ctx,
      ),
    ).rejects.toThrow('event store unavailable');

    // Load-bearing invariant: createPr was NOT called as a fallback.
    expect(mockProvider.createPr).not.toHaveBeenCalled();

    // Sanity: Phase A append + failed recovery append = 2 calls.
    expect(appendCallCount).toBe(2);
  });
});

// ─── DR-1 task 006: create_pr grounds the body in artifacts.intent ───────────
//
// When `featureId` is supplied and a meaningful `artifacts.intent` is persisted,
// the handler enriches the PR body with a deterministic `## Intent` section +
// idempotency marker BEFORE Phase A — so BOTH the durable `pr.create.requested`
// event AND the created PR carry the grounded body. Degrades cleanly (body
// unchanged) when there is no featureId / no meaningful intent / the body is
// already grounded.
// ─────────────────────────────────────────────────────────────────────────────

describe('CreatePr_Body_ReferencesIntent (DR-1 task 006)', () => {
  /**
   * A `state.patched` event whose dot-path patch materializes `artifacts.intent`
   * through the real projection — the same surface `readIntent` resolves through.
   */
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

    // The created PR body carries the grounded `## Intent` section + marker.
    const createArg = vi.mocked(provider.createPr).mock.calls[0][0];
    expect(createArg.body).toContain('## Intent');
    expect(createArg.body).toContain(INTENT_GROUNDING_MARKER);
    expect(createArg.body).toContain(intent.summary);
    // Original body content is preserved.
    expect(createArg.body).toContain('Does a thing.');

    // The durable `pr.create.requested` event carries the SAME grounded body.
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

  it('CreatePr_EmptyIntent_LeavesBodyUntouched', async () => {
    // A persisted but EMPTY intent (changedFiles: []) is not meaningful — degrade.
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

  it('CreatePr_BodyAlreadyGrounded_DoesNotDoubleInject', async () => {
    const intent = deriveIntent(['servers/a.ts']);
    const ctx = makeTwoEventCtx({
      queryResult: [intentPatchEvent({ 'artifacts.intent': intent })],
    });
    const provider = makeMockProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    // Body ALREADY carries the marker — the handler must not append a second section.
    const body = `## Summary\n\nBody.\n\n## Intent\n\n${INTENT_GROUNDING_MARKER}\n\n**Surfaces:** servers`;
    await handleCreatePr(
      { title: 'feat: thing', body, base: 'main', head: 'feature/thing', featureId: 'feat-x' },
      ctx,
    );

    const createArg = vi.mocked(provider.createPr).mock.calls[0][0];
    expect(createArg.body).toBe(body);
    // Marker appears exactly once.
    expect(createArg.body.split(INTENT_GROUNDING_MARKER).length - 1).toBe(1);
  });
});
