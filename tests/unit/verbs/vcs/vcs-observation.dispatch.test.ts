// Runs the vcs journal actions through the real `dispatch()`. The tests prove
// that their observation declarations resolve at the dispatch boundary, not
// only in the contract fixture.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatch, type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { getDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { VcsProvider, RepoInfo } from '../../../../src/vcs/provider.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';

interface MemoryRow {
  readonly type: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly data?: unknown;
  readonly operationId?: string;
}

/**
 * An in-memory EventStore. Its `append` adds the operation id from
 * `getDispatchContext()`, as the real `EventStore.append` does.
 */
function memoryEventStore(): EventStore {
  const rows = new Map<string, MemoryRow[]>();
  const append = async (
    streamId: string,
    event: { type: string; data?: unknown; operationId?: string },
  ): Promise<WorkflowEvent> => {
    const dispatchCtx = getDispatchContext();
    const operationId = event.operationId ?? dispatchCtx?.operationId;
    const list = rows.get(streamId) ?? [];
    const stored: MemoryRow = {
      type: event.type,
      streamId,
      sequence: list.length + 1,
      ...(event.data !== undefined ? { data: event.data } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
    };
    list.push(stored);
    rows.set(streamId, list);
    return stored as WorkflowEvent;
  };
  return {
    async initialize() {},
    async query(streamId: string, filters?: { type?: string; operationId?: string }) {
      return (rows.get(streamId) ?? []).filter((row) => {
        if (filters?.type !== undefined && row.type !== filters.type) return false;
        if (filters?.operationId !== undefined && row.operationId !== filters.operationId) {
          return false;
        }
        return true;
      }) as WorkflowEvent[];
    },
    async append(streamId: string, event: { type: string; data?: unknown }) {
      return append(streamId, event);
    },
    async appendValidated(streamId: string, event: WorkflowEvent) {
      return append(streamId, {
        type: event.type,
        ...(event.data !== undefined ? { data: event.data } : {}),
        ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
      });
    },
    listStreams() {
      return [...rows.keys()];
    },
  } as unknown as EventStore;
}

function makeMockProvider(overrides: Partial<VcsProvider> = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    addReply: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn().mockResolvedValue([]),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    searchIssuesByMarker: vi.fn().mockResolvedValue([]),
    getRepository: vi.fn().mockResolvedValue({
      nameWithOwner: 'owner/repo',
      defaultBranch: 'main',
    } satisfies RepoInfo),
    ...overrides,
  };
}

function ctx(): DispatchContext {
  return {
    stateDir: path.join(os.tmpdir(), 'vcs-observation-dispatch-unused'),
    eventStore: memoryEventStore(),
    enableTelemetry: false,
  };
}

describe('vcs journal actions — dispatch-level observation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Dispatch must resolve an observed stream for `merge_pr`. Without one, each
   * successful merge reports `ENSURE_CONTRACT_VIOLATED`.
   */
  it('MergePr_MergedSuccessfully_DispatchReturnsSuccess', async () => {
    const provider = makeMockProvider({
      mergePr: vi.fn().mockResolvedValue({ merged: true, sha: 'abc123' }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'merge_pr', prId: '42', strategy: 'squash' },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('ENSURE_CONTRACT_VIOLATED');
  });

  it('MergePr_ProviderDeclinedTheMerge_DispatchStillReturnsSuccess', async () => {
    const provider = makeMockProvider({
      mergePr: vi.fn().mockResolvedValue({ merged: false, error: 'Conflicts' }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'merge_pr', prId: '42', strategy: 'merge' },
      ctx(),
    );

    expect(result.success).toBe(true);
  });

  /**
   * Both journal rows must carry the dispatch operation id. The emission
   * verifier queries by that id, so a row without it fails the call with
   * `EMISSION_CONTRACT_VIOLATED`.
   */
  it('AddPrComment_Dispatched_BothJournalRowsAreFindableByTheDispatchOperation', async () => {
    let postedBody = '';
    const provider = makeMockProvider({
      addComment: vi.fn().mockImplementation(async (_prId: string, body: string) => {
        postedBody = body;
      }),
      getPrComments: vi.fn().mockImplementation(async () => {
        if (!postedBody) return [];
        return [{ id: 9001, author: 'bot', body: postedBody, createdAt: new Date().toISOString() }];
      }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const dispatchCtx = ctx();
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'add_pr_comment', prId: '42', body: 'observation probe' },
      dispatchCtx,
    );

    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('EMISSION_CONTRACT_VIOLATED');

    const rows = await dispatchCtx.eventStore.query('vcs');
    const requested = rows.find((r) => r.type === 'pr.comment.requested');
    const executed = rows.find((r) => r.type === 'pr.comment.executed');
    expect(requested).toBeDefined();
    expect(executed).toBeDefined();
    expect(requested?.operationId).toBeDefined();
    expect(executed?.operationId).toBeDefined();
    expect(requested?.operationId).toBe(executed?.operationId);
  });

  it('CreateIssue_Dispatched_BothJournalRowsLandOnTheSharedStream', async () => {
    const provider = makeMockProvider({
      createIssue: vi.fn().mockResolvedValue({ number: 501, url: 'https://example.invalid/issues/501' }),
    });
    vi.mocked(createVcsProvider).mockResolvedValue(provider);

    const dispatchCtx = ctx();
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'create_issue', title: 'observed issue', body: 'observation probe' },
      dispatchCtx,
    );

    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('EMISSION_CONTRACT_VIOLATED');

    const rows = await dispatchCtx.eventStore.query('vcs');
    const requested = rows.find((r) => r.type === 'issue.create.requested');
    const executed = rows.find((r) => r.type === 'issue.create.executed');
    expect(requested).toBeDefined();
    expect(executed).toBeDefined();
    expect(requested?.operationId).toBeDefined();
    expect(executed?.operationId).toBeDefined();
    expect(requested?.operationId).toBe(executed?.operationId);
  });
});

/**
 * These tests use the real `EventStore`, because the in-memory store does not
 * collapse a repeated idempotency key into a cache hit.
 */
describe('create_issue — crash recovery keys the retry under its own operation', () => {
  /**
   * The first dispatch fails after `issue.create.requested` lands. The retry
   * has the same title and body, so the handler reuses the recovered
   * body-marker uuid. The retry must key its rows on its own dispatch
   * operation id. If it keys them on the uuid, its first append is a cache hit,
   * and the verifier reports `EMISSION_CONTRACT_VIOLATED`.
   */
  it('CreateIssue_RetryAfterPriorCrash_DispatchReturnsSuccessNotEmissionViolation', async () => {
    const { EventStore } = await import('../../../../src/events/store.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'create-issue-crash-recovery-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const dispatchCtx: DispatchContext = { stateDir: tmpDir, eventStore, enableTelemetry: false };

    try {
      let attempt = 0;
      const provider = makeMockProvider({
        createIssue: vi.fn().mockImplementation(async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('simulated provider crash');
          return { number: 777, url: 'https://example.invalid/issues/777' };
        }),
      });
      vi.mocked(createVcsProvider).mockResolvedValue(provider);

      const first = await dispatch(
        'exarchos_orchestrate',
        { action: 'create_issue', title: 'crash-recovery probe', body: 'same title and body' },
        dispatchCtx,
      );
      expect(first.success).toBe(false);

      const second = await dispatch(
        'exarchos_orchestrate',
        { action: 'create_issue', title: 'crash-recovery probe', body: 'same title and body' },
        dispatchCtx,
      );

      expect(second.error?.code).not.toBe('EMISSION_CONTRACT_VIOLATED');
      expect(second.success).toBe(true);
    } finally {
      eventStore.close();
      const { rmrfAsync } = await import('../../../../tools/test-helpers/temp-dir.js');
      await rmrfAsync(tmpDir);
    }
  });
});
