/**
 * CLI and MCP parity for the `create_issue` action. Both carriers must record
 * `issue.create.requested` and then `issue.create.executed`, with one
 * operation id per arm and the same issue data. Each arm has its own state
 * directory, a stub VCS provider, and a composite stub that calls the real
 * `handleCreateIssue`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../parity-harness.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import type { VcsProvider } from '../../../../src/vcs/provider.js';
import { handleCreateIssue } from '../../../../src/verbs/vcs/create-issue.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const ISSUE_NUMBER = 789;
const ISSUE_URL = 'https://github.com/test-owner/test-repo/issues/789';

/** A provider with a fixed issue result and an empty marker scan. These tests do not run the recovery path. */
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
    searchIssuesByMarker: vi.fn().mockResolvedValue([]),
    getRepository: vi.fn(),
  };
}

/**
 * Forwards `create_issue` to the real `handleCreateIssue` and rejects other
 * actions. It adds an empty `listIssuesByMarker`, because the handler requires
 * one.
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
    return handleCreateIssue(
      {
        ...(rest as Omit<Parameters<typeof handleCreateIssue>[0], 'listIssuesByMarker'>),
        listIssuesByMarker: async () => [],
      },
      ctx,
    );
  };
}

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

/**
 * Replaces UUIDs and timestamps with placeholders and drops `_perf` and
 * `_meta`, so the two arms compare equal. The issue number and URL stay.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    dropKeys: new Set(['_perf', '_meta']),
  });
}

const PARITY_ARGS = {
  title: 'Parity test issue',
  body: 'This issue was created by the parity harness.',
  labels: ['parity-test'],
};

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

  /** Each arm makes its own operation id, so the results compare equal only after normalization. */
  it('CreateIssue_Parity_BothCarriersObserveTwoEventSequence', async () => {
    vi.mocked(createVcsProvider).mockResolvedValue(makeStubProvider());
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildCreateIssueCompositeStub(),
    );

    const cliArm = await createArm('create-issue-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('create-issue-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'create_issue',
      PARITY_ARGS,
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'create_issue',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliEvents = await cliArm.eventStore.query('vcs');
    const mcpEvents = await mcpArm.eventStore.query('vcs');

    const cliTypes = cliEvents.map((e) => e.type);
    const mcpTypes = mcpEvents.map((e) => e.type);

    expect(cliTypes).toEqual(['issue.create.requested', 'issue.create.executed']);
    expect(mcpTypes).toEqual(['issue.create.requested', 'issue.create.executed']);

    const cliRequested = cliEvents.find((e) => e.type === 'issue.create.requested');
    const cliExecuted = cliEvents.find((e) => e.type === 'issue.create.executed');
    const mcpRequested = mcpEvents.find((e) => e.type === 'issue.create.requested');
    const mcpExecuted = mcpEvents.find((e) => e.type === 'issue.create.executed');

    expect(cliRequested).toBeDefined();
    expect(cliExecuted).toBeDefined();
    expect(mcpRequested).toBeDefined();
    expect(mcpExecuted).toBeDefined();

    const cliRequestedData = cliRequested!.data as { operationId: string };
    const cliExecutedData = cliExecuted!.data as { operationId: string; issueNumber: number; url: string };
    const mcpRequestedData = mcpRequested!.data as { operationId: string };
    const mcpExecutedData = mcpExecuted!.data as { operationId: string; issueNumber: number; url: string };

    expect(cliExecutedData.operationId).toBe(cliRequestedData.operationId);
    expect(mcpExecutedData.operationId).toBe(mcpRequestedData.operationId);

    expect(cliExecutedData.issueNumber).toBe(ISSUE_NUMBER);
    expect(mcpExecutedData.issueNumber).toBe(ISSUE_NUMBER);
    expect(cliExecutedData.url).toBe(ISSUE_URL);
    expect(mcpExecutedData.url).toBe(ISSUE_URL);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));
  });
});
