/**
 * CLI and MCP parity tests for the `add_pr_comment` action.
 *
 * The MCP facade (`exarchos_orchestrate`) and the CLI facade (`exarchos orch add_pr_comment`)
 * must both record `pr.comment.requested` and then `pr.comment.executed`.
 * The test mocks the VCS factory. A composite stub calls the real
 * `handleAddPrComment` with a stub provider in each arm.
 */

import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import type { VcsProvider, PrComment, RepoInfo } from '../../../../src/vcs/provider.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../parity-harness.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleAddPrComment } from '../../../../src/verbs/vcs/add-pr-comment.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STUB_COMMENT_ID = 55001;
const STUB_REPO_INFO: RepoInfo = { nameWithOwner: 'owner/parity-repo', defaultBranch: 'main' };

/**
 * Build a provider stub. `addComment` and `addReply` keep the last posted body,
 * and `getPrComments` returns it as one comment. The body holds the marker with
 * the generated `operationId`, so the handler finds its own comment.
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
 * Build a composite stub that sends `add_pr_comment` to the real
 * `handleAddPrComment`. Each call installs a fresh stub provider, so both arms
 * get the same VCS behavior.
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
    const stubProvider = buildStubProvider();
    vi.mocked(createVcsProvider).mockResolvedValue(stubProvider);

    return handleAddPrComment(rest as { prId: string; body: string; threadId?: string }, ctx);
  };
}

/**
 * Replace timestamps and UUIDs with placeholders, and drop the `_perf` and
 * `_meta` keys. Each call generates a fresh `operationId` UUID.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    dropKeys: new Set(['_perf', '_meta']),
  });
}

const PARITY_ARGS = {
  prId: '42',
  body: 'Parity test comment — both carriers must observe the same event sequence.',
};

describe('exarchos add_pr_comment CLI↔MCP parity (Wave B / B2.5)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  beforeAll(() => {
  });

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rmrfAsync(arm.stateDir);
    }
    arms = [];
    vi.clearAllMocks();
  });

  /**
   * Each arm must record both events in order, with the same `body` and
   * `commentId`. The normalized `ToolResult` must be equal across the arms.
   */
  it('AddPrComment_Parity_BothCarriersObserveTwoEventSequence', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildAddPrCommentCompositeStub(),
    );

    const cliArm = await createArm('add-pr-comment-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('add-pr-comment-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'add_pr_comment',
      PARITY_ARGS,
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'add_pr_comment',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliEvents = await cliArm.ctx.eventStore.query('vcs');
    const cliTypes = cliEvents.map((e) => e.type);
    expect(cliTypes).toContain('pr.comment.requested');
    expect(cliTypes).toContain('pr.comment.executed');
    const cliIdxRequested = cliTypes.indexOf('pr.comment.requested');
    const cliIdxExecuted = cliTypes.indexOf('pr.comment.executed');
    expect(cliIdxRequested).toBeLessThan(cliIdxExecuted);

    const mcpEvents = await mcpArm.ctx.eventStore.query('vcs');
    const mcpTypes = mcpEvents.map((e) => e.type);
    expect(mcpTypes).toContain('pr.comment.requested');
    expect(mcpTypes).toContain('pr.comment.executed');
    const mcpIdxRequested = mcpTypes.indexOf('pr.comment.requested');
    const mcpIdxExecuted = mcpTypes.indexOf('pr.comment.executed');
    expect(mcpIdxRequested).toBeLessThan(mcpIdxExecuted);

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

    expect(cliNorm).toHaveLength(2);
    expect(mcpNorm).toHaveLength(2);

    expect(cliNorm[0].type).toBe('pr.comment.requested');
    expect(mcpNorm[0].type).toBe('pr.comment.requested');
    expect((cliNorm[0].data as Record<string, unknown>).body).toBe(PARITY_ARGS.body);
    expect((mcpNorm[0].data as Record<string, unknown>).body).toBe(PARITY_ARGS.body);

    expect(cliNorm[1].type).toBe('pr.comment.executed');
    expect(mcpNorm[1].type).toBe('pr.comment.executed');
    expect((cliNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);
    expect((mcpNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  /**
   * With a `threadId`, each arm must record the thread id on the intent and the
   * stub reply id on the executed event.
   */
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
    expect((cliNorm[0].data as Record<string, unknown>).threadId).toBe(201);
    expect((mcpNorm[0].data as Record<string, unknown>).threadId).toBe(201);
    expect((cliNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);
    expect((mcpNorm[1].data as Record<string, unknown>).commentId).toBe(STUB_COMMENT_ID);

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
