// Behavioral, through the real dispatch(): proves the vcs journal actions'
// observation declarations (Lane A) actually resolve at the dispatch
// boundary, not just in the contract fixture. Three regressions this guards
// against:
//
//   1. `merge_pr` declared no infra stream and named `pr.merged` as an
//      unconditional success postcondition, so dispatch resolved
//      `observedStreamId === undefined` and reported
//      ENSURE_CONTRACT_VIOLATED for every successful merge.
//   2. `add_pr_comment`'s Phase-A `pr.comment.requested` row rode
//      `appendComputed`, which never stamps the ambient dispatch operation
//      id — so the emission verifier's operation-scoped query never found
//      it, and every successful dispatch would fail EMISSION_CONTRACT_VIOLATED
//      once the action declared the shared stream.
//   3. `create_issue` keyed its Phase-A/Phase-B idempotency on the RECOVERED
//      body-marker uuid rather than the ambient dispatch operation id. A
//      dispatch that recovers from a prior crash (same title/body, no paired
//      `issue.create.executed`) reuses that uuid and collides with the first
//      attempt's idempotency key at the EventStore boundary — the retry's
//      Phase A append becomes a cache-hit and lands NO row under the retry's
//      own operation id, so the verifier finds Phase C's row but not Phase
//      A's and reports EMISSION_CONTRACT_VIOLATED on a call that succeeded.

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

// ─── In-memory EventStore harness ───────────────────────────────────────────
//
// Mirrors tests/acceptance/action-contract-observation.test.ts: `append`
// stamps the ambient operation id from `getDispatchContext()` exactly as
// the real `EventStore.append` does (src/events/store.ts).

interface MemoryRow {
  readonly type: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly data?: unknown;
  readonly operationId?: string;
}

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

// ─── create_issue crash recovery — real EventStore ──────────────────────────
//
// The in-memory harness above stamps the ambient operation id but does not
// model idempotencyKey cache-hit collapse, which is exactly the mechanism
// regression 3 lives in. This block runs against the real `EventStore` so
// the idempotencyKey path is genuine, not simulated.

describe('create_issue — crash recovery keys the retry under its own operation', () => {
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
          // First dispatch crashes after Phase A committed `issue.create.requested`
          // but before the provider call landed — the exact window the
          // body-marker recovery scan exists for.
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

      // Same title/body, no operationId supplied — the handler's own recovery
      // scan finds the unpaired `issue.create.requested` from the first
      // dispatch and reuses its body-marker uuid. That reuse must not make
      // this second, genuinely new dispatch collide with the first at the
      // EventStore idempotency-key boundary.
      const second = await dispatch(
        'exarchos_orchestrate',
        { action: 'create_issue', title: 'crash-recovery probe', body: 'same title and body' },
        dispatchCtx,
      );

      expect(second.error?.code).not.toBe('EMISSION_CONTRACT_VIOLATED');
      expect(second.success).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
