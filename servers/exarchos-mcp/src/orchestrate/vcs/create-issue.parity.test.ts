/**
 * CLI↔MCP parity harness for the `create_issue` action (B3.5).
 *
 * Verifies that both the CLI carrier (`exarchos orch create_issue`) and the
 * MCP carrier (`exarchos_orchestrate { action: 'create_issue' }`) observe
 * the same two-event sequence:
 *
 *   [issue.create.requested, issue.create.executed]
 *
 * …in that order, with identical operationId and issue data across both
 * carriers. This is the parity invariant for the Wave B two-event split.
 *
 * Strategy:
 *   - Stub `createVcsProvider` (vi.mock) to return a deterministic provider
 *     that resolves createIssue with a fixed issueNumber + url.
 *   - Stub the `exarchos_orchestrate` composite via `stubCompositeHandler`
 *     to forward `create_issue` invocations to the real `handleCreateIssue`.
 *   - Two isolated arms (CLI + MCP) run against separate tmp state dirs and
 *     their captured event sequences are compared for order + data equality.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { DispatchContext, CompositeHandler } from '../../core/dispatch.js';
import { stubCompositeHandler } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../__tests__/parity-harness.js';

// ─── VCS provider mock ────────────────────────────────────────────────────────

vi.mock('../../vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../vcs/factory.js';
import type { VcsProvider } from '../../vcs/provider.js';
import { handleCreateIssue } from './create-issue.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

const ISSUE_NUMBER = 789;
const ISSUE_URL = 'https://github.com/test-owner/test-repo/issues/789';

function makeStubProvider(): VcsProvider {
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
    createIssue: vi.fn().mockResolvedValue({ number: ISSUE_NUMBER, url: ISSUE_URL }),
    // Empty marker scan — parity test does NOT exercise the recovery branch.
    // Required by handleCreateIssue per CodeRabbit #3224631237.
    searchIssuesByMarker: vi.fn().mockResolvedValue([]),
    getRepository: vi.fn(),
  };
}

// ─── Composite stub ───────────────────────────────────────────────────────────

/**
 * Composite stub that forwards `create_issue` to the real `handleCreateIssue`
 * handler. All other actions are unreachable in this parity suite.
 */
function buildCreateIssueCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'create_issue') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `create-issue parity stub only handles "create_issue", got "${String(action)}"`,
        },
      };
    }
    // Inject the empty marker scan that the handler now requires (see
    // CodeRabbit #3224631237). Parity tests don't exercise recovery, so
    // an empty scan is correct here.
    return handleCreateIssue(
      {
        ...(rest as Omit<Parameters<typeof handleCreateIssue>[0], 'listIssuesByMarker'>),
        listIssuesByMarker: async () => [],
      },
      ctx,
    );
  };
}

// ─── Arm helpers ─────────────────────────────────────────────────────────────

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
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
  return { stateDir, ctx, eventStore };
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Strip UUIDs (operationId) and timestamps so two arms with different
 * in-process UUID generation produce byte-equal normalized output.
 * We preserve issueNumber and url — the core result data.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Fixture args ─────────────────────────────────────────────────────────────

const PARITY_ARGS = {
  title: 'Parity test issue',
  body: 'This issue was created by the parity harness.',
  labels: ['parity-test'],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('create_issue CLI↔MCP parity (B3.5)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rmrfAsync(arm.stateDir);
    }
    arms = [];
    vi.restoreAllMocks();
  });

  it('CreateIssue_Parity_BothCarriersObserveTwoEventSequence', async () => {
    // Arrange — install a deterministic VCS provider stub and the composite stub.
    vi.mocked(createVcsProvider).mockResolvedValue(makeStubProvider());
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildCreateIssueCompositeStub(),
    );

    const cliArm = await createArm('create-issue-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('create-issue-parity-mcp-');
    arms.push(mcpArm);

    // Act — CLI arm.
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'create_issue',
      PARITY_ARGS,
    );

    // Act — MCP arm.
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'create_issue',
      ...PARITY_ARGS,
    });

    // Assert — both surfaces report success.
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    // Assert — both event streams contain exactly [requested, executed] in order.
    const cliEvents = await cliArm.eventStore.query('vcs');
    const mcpEvents = await mcpArm.eventStore.query('vcs');

    const cliTypes = cliEvents.map((e) => e.type);
    const mcpTypes = mcpEvents.map((e) => e.type);

    expect(cliTypes).toEqual(['issue.create.requested', 'issue.create.executed']);
    expect(mcpTypes).toEqual(['issue.create.requested', 'issue.create.executed']);

    // Assert — both streams have matching operationId across the two phases.
    const cliRequested = cliEvents.find((e) => e.type === 'issue.create.requested');
    const cliExecuted = cliEvents.find((e) => e.type === 'issue.create.executed');
    const mcpRequested = mcpEvents.find((e) => e.type === 'issue.create.requested');
    const mcpExecuted = mcpEvents.find((e) => e.type === 'issue.create.executed');

    expect(cliRequested).toBeDefined();
    expect(cliExecuted).toBeDefined();
    expect(mcpRequested).toBeDefined();
    expect(mcpExecuted).toBeDefined();

    // Within each arm, operationId must be consistent across both events.
    const cliRequestedData = cliRequested!.data as { operationId: string };
    const cliExecutedData = cliExecuted!.data as { operationId: string; issueNumber: number; url: string };
    const mcpRequestedData = mcpRequested!.data as { operationId: string };
    const mcpExecutedData = mcpExecuted!.data as { operationId: string; issueNumber: number; url: string };

    expect(cliExecutedData.operationId).toBe(cliRequestedData.operationId);
    expect(mcpExecutedData.operationId).toBe(mcpRequestedData.operationId);

    // Assert — both arms resolve to the same issueNumber and url.
    expect(cliExecutedData.issueNumber).toBe(ISSUE_NUMBER);
    expect(mcpExecutedData.issueNumber).toBe(ISSUE_NUMBER);
    expect(cliExecutedData.url).toBe(ISSUE_URL);
    expect(mcpExecutedData.url).toBe(ISSUE_URL);

    // Assert — ToolResult payloads are byte-equal after UUID normalization.
    // UUIDs differ between arms (each generates its own operationId), so
    // we normalize both before comparing.
    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));
  });
});
