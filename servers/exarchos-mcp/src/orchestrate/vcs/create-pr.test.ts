import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider } from '../../vcs/provider.js';
import type { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { ConcurrencyError } from '../../event-store/index.js';

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
    listPrs: vi.fn(),
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
 * Includes `getAppender().decide(...)` stub and `query(...)` stub needed
 * by the B1.4 refactored handler.
 */
function makeTwoEventCtx(overrides: {
  decideResult?: Record<string, unknown>;
  appendResult?: Record<string, unknown>;
  queryResult?: unknown[];
} = {}): DispatchContext {
  const decide = vi.fn().mockResolvedValue(
    overrides.decideResult ?? {
      ok: true,
      kind: 'committed',
      sequences: [1],
      eventIds: ['evt-mock-requested'],
      timestamps: [new Date().toISOString()],
    },
  );
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
      getAppender: vi.fn().mockReturnValue({ decide }),
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
    ctx = makeMockCtx();
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

  it('handleCreatePr_Success_EmitsPrCreatedEvent', async () => {
    const args = {
      title: 'feat: add VCS actions',
      body: 'Body',
      base: 'main',
      head: 'feature/vcs',
    };

    await handleCreatePr(args, ctx);

    expect(ctx.eventStore.append).toHaveBeenCalledWith('vcs', {
      type: 'pr.created',
      data: {
        provider: 'github',
        prNumber: 42,
        url: 'https://github.com/repo/pull/42',
        base: 'main',
        head: 'feature/vcs',
      },
    });
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
    // Arrange: first decide call throws ConcurrencyError; second succeeds.
    // This simulates OCC loss on Phase A with a successful retry.
    const concurrencyErr = new ConcurrencyError('sequence mismatch on first attempt');
    const decide = vi.fn()
      .mockRejectedValueOnce(concurrencyErr)
      .mockResolvedValue({
        ok: true,
        kind: 'committed',
        sequences: [1],
        eventIds: ['evt-mock-requested'],
        timestamps: [new Date().toISOString()],
      });
    const append = vi.fn().mockResolvedValue({
      sequence: 2,
      type: 'pr.create.executed',
      timestamp: new Date().toISOString(),
    });
    const query = vi.fn().mockResolvedValue([]);

    const ctx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append,
        query,
        getAppender: vi.fn().mockReturnValue({ decide }),
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

    // Assert: withStateRetry triggered at least two decide attempts (one failure, one success).
    expect(decide).toHaveBeenCalledTimes(2);

    // Assert: createPr was called AT MOST ONCE across the entire retry cycle.
    // With the two-event split, Phase A is committed first (retried on ConcurrencyError),
    // then createPr fires ONCE after Phase A succeeds — never on the retry of Phase A itself.
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
    // Arrange: decide returns 'noop' (pr.create.requested already in stream).
    const decide = vi.fn().mockResolvedValue({
      ok: true,
      kind: 'noop',
      sequences: [],
      eventIds: [],
      timestamps: [],
    });
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
        getAppender: vi.fn().mockReturnValue({ decide }),
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
