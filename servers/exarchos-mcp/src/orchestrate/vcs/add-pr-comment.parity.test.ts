/**
 * CLI↔MCP parity tests for the `add_pr_comment` action (Wave B / B2.5).
 *
 * add_pr_comment has two user-visible facades:
 *   1. MCP — `exarchos_orchestrate { action: 'add_pr_comment' }` over the MCP SDK
 *   2. CLI — `exarchos orch add_pr_comment` (auto-generated subcommand)
 *
 * Both facades MUST observe the same two-event sequence
 * [pr.comment.requested, pr.comment.executed] with identical data.
 *
 * Strategy (mirrors doctor.parity.test.ts / merge-orchestrate.parity.test.ts):
 *   - vi.mock '../../vcs/factory.js' so createVcsProvider returns a
 *     deterministic stub provider in both arms.
 *   - stubCompositeHandler installs the real handleAddPrComment call path
 *     under the 'exarchos_orchestrate' composite — both CLI and MCP dispatch
 *     through this stub, which calls the real handler with the mocked provider.
 *   - Query the event store after both arms run and assert:
 *       [pr.comment.requested, pr.comment.executed] in order, identical data.
 *   - normalize strips wall-clock fields (operationId is a UUID generated
 *     fresh per invocation, so it's also normalized).
 */

import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../../core/dispatch.js';
import { stubCompositeHandler } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { VcsProvider, PrComment, RepoInfo } from '../../vcs/provider.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../__tests__/parity-harness.js';

// ─── Mock the VCS factory before importing the real handler ──────────────────

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import { handleAddPrComment } from './add-pr-comment.js';

// ─── Deterministic VCS provider stub ─────────────────────────────────────────

const STUB_COMMENT_ID = 55001;
const STUB_REPO_INFO: RepoInfo = { nameWithOwner: 'owner/parity-repo', defaultBranch: 'main' };

/**
 * Build a provider stub that: addComment succeeds, getPrComments returns the
 * posted comment (marker detected), getRepository returns stable repo info.
 *
 * We use a closure that captures the `marker` after the handler embeds it so
 * getPrComments (called AFTER addComment) can return a comment body containing
 * the marker. Since we don't know the operationId in advance, we track the
 * last call to addComment and extract the marker from its body argument.
 */
function buildStubProvider(): VcsProvider {
  let lastPostedBody = '';

  const provider: VcsProvider = {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn().mockImplementation(async (_prId: string, body: string) => {
      lastPostedBody = body;
    }),
    addReply: vi.fn().mockImplementation(async (_prId: string, _threadId: string, body: string) => {
      lastPostedBody = body;
      return { id: STUB_COMMENT_ID };
    }),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn().mockImplementation(async (): Promise<PrComment[]> => {
      if (!lastPostedBody) return [];
      // Return the "posted" comment with the body that was passed to addComment.
      return [
        {
          id: STUB_COMMENT_ID,
          author: 'github-actions[bot]',
          body: lastPostedBody,
          createdAt: '2026-05-12T00:00:00.000Z',
        },
      ];
    }),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn().mockResolvedValue(STUB_REPO_INFO),
  };

  return provider;
}

// ─── Arm helpers ─────────────────────────────────────────────────────────────

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  };
  return { stateDir, ctx };
}

/**
 * Composite stub that forwards add_pr_comment to the real handleAddPrComment
 * with a fresh deterministic stub provider installed on each call.
 */
function buildAddPrCommentCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'add_pr_comment') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `add-pr-comment parity stub only handles "add_pr_comment", got "${String(action)}"`,
        },
      };
    }
    // Install a fresh provider stub so both arms share the same deterministic
    // behaviour (each arm gets its own EventStore but the VCS side-effects
    // are identical mocks).
    const stubProvider = buildStubProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(stubProvider);

    return handleAddPrComment(rest as { prId: string; body: string; threadId?: string }, ctx);
  };
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

/**
 * Strip wall-clock and per-run opaque fields. operationId is a UUID generated
 * fresh per invocation; commentUrl encodes the operationId; both are normalized.
 * dropKeys removes _perf / _meta envelope fields.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Parity args ──────────────────────────────────────────────────────────────

const PARITY_ARGS = {
  prId: '42',
  body: 'Parity test comment — both carriers must observe the same event sequence.',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('exarchos add_pr_comment CLI↔MCP parity (Wave B / B2.5)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  beforeAll(() => {
    // vi.mock is hoisted; no additional setup needed.
  });

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rm(arm.stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    arms = [];
    vi.clearAllMocks();
  });

  it('AddPrComment_Parity_BothCarriersObserveTwoEventSequence', async () => {
    // ── Arrange ─────────────────────────────────────────────────────────────
    //
    // Install the composite stub so both CLI and MCP arms go through the
    // real handleAddPrComment with the deterministic VCS provider.
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildAddPrCommentCompositeStub(),
    );

    const cliArm = await createArm('add-pr-comment-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('add-pr-comment-parity-mcp-');
    arms.push(mcpArm);

    // ── Act (CLI arm) ────────────────────────────────────────────────────────
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'add_pr_comment',
      PARITY_ARGS,
    );

    // ── Act (MCP arm) ────────────────────────────────────────────────────────
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'add_pr_comment',
      ...PARITY_ARGS,
    });

    // ── Assert — both surfaces succeed ───────────────────────────────────────
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    // ── Assert — CLI arm event sequence: [pr.comment.requested, pr.comment.executed] ──
    const cliEvents = await cliArm.ctx.eventStore.query('vcs');
    const cliTypes = cliEvents.map((e) => e.type);
    expect(cliTypes).toContain('pr.comment.requested');
    expect(cliTypes).toContain('pr.comment.executed');
    const cliIdxRequested = cliTypes.indexOf('pr.comment.requested');
    const cliIdxExecuted = cliTypes.indexOf('pr.comment.executed');
    expect(cliIdxRequested).toBeLessThan(cliIdxExecuted);

    // ── Assert — MCP arm event sequence: [pr.comment.requested, pr.comment.executed] ──
    const mcpEvents = await mcpArm.ctx.eventStore.query('vcs');
    const mcpTypes = mcpEvents.map((e) => e.type);
    expect(mcpTypes).toContain('pr.comment.requested');
    expect(mcpTypes).toContain('pr.comment.executed');
    const mcpIdxRequested = mcpTypes.indexOf('pr.comment.requested');
    const mcpIdxExecuted = mcpTypes.indexOf('pr.comment.executed');
    expect(mcpIdxRequested).toBeLessThan(mcpIdxExecuted);

    // ── Assert — event data shape is structurally identical across arms ───────
    //
    // Normalize timestamps and UUIDs (operationId) so the comparison is
    // byte-equal modulo non-deterministic values. The commentId (55001) and
    // pr.comment.requested body field must be identical.
    const normalizePrCommentData = (events: Awaited<ReturnType<typeof cliArm.ctx.eventStore.query>>) => {
      return events
        .filter((e) => e.type === 'pr.comment.requested' || e.type === 'pr.comment.executed')
        .map((e) => ({
          type: e.type,
          data: normalize(e.data),
        }));
    };

    const cliNorm = normalizePrCommentData(cliEvents);
    const mcpNorm = normalizePrCommentData(mcpEvents);

    // Both must have exactly 2 events in the same order.
    expect(cliNorm).toHaveLength(2);
    expect(mcpNorm).toHaveLength(2);

    // Both must have pr.comment.requested with the same body.
    expect(cliNorm[0].type).toBe('pr.comment.requested');
    expect(mcpNorm[0].type).toBe('pr.comment.requested');
    expect((cliNorm[0].data as Record<string, unknown>).body).toBe(PARITY_ARGS.body);
    expect((mcpNorm[0].data as Record<string, unknown>).body).toBe(PARITY_ARGS.body);

    // Both must have pr.comment.executed with the same commentId.
    expect(cliNorm[1].type).toBe('pr.comment.executed');
    expect(mcpNorm[1].type).toBe('pr.comment.executed');
    expect((cliNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);
    expect((mcpNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);

    // ── Assert — ToolResult parity across surfaces ────────────────────────────
    //
    // After stripping UUIDs and timestamps, the ToolResult shape must be
    // byte-equal across CLI and MCP carriers.
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  // T9 / #1165 — the new thread-reply surface (threadId routes through
  // addReply) MUST also be reachable identically from BOTH carriers (INV-2).
  it('AddPrReply_Parity_BothCarriersRouteThreadReplyThroughAddReply', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildAddPrCommentCompositeStub(),
    );

    const cliArm = await createArm('add-pr-reply-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('add-pr-reply-parity-mcp-');
    arms.push(mcpArm);

    const REPLY_ARGS = { ...PARITY_ARGS, threadId: '201' };

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'add_pr_comment',
      REPLY_ARGS,
    );
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'add_pr_comment',
      ...REPLY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    // Both carriers must observe the same two-event sequence with the reply id.
    const collect = async (arm: ArmContext) => {
      const events = await arm.ctx.eventStore.query('vcs');
      return events
        .filter((e) => e.type === 'pr.comment.requested' || e.type === 'pr.comment.executed')
        .map((e) => ({ type: e.type, data: normalize(e.data) }));
    };
    const cliNorm = await collect(cliArm);
    const mcpNorm = await collect(mcpArm);

    expect(cliNorm).toHaveLength(2);
    expect(mcpNorm).toHaveLength(2);
    // requested intent records the reply target on both carriers.
    expect((cliNorm[0].data as Record<string, unknown>).threadId).toBe(201);
    expect((mcpNorm[0].data as Record<string, unknown>).threadId).toBe(201);
    // executed carries the addReply-returned commentId on both carriers.
    expect((cliNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);
    expect((mcpNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);

    // ToolResult parity across carriers.
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
