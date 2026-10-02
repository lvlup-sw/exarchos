/**
 * CLI and MCP parity for the `create_pr` action. Both carriers must record
 * `pr.create.requested` first and then `pr.create.executed`, with the same
 * event data after normalization. A composite stub calls the real
 * `handleCreatePr` with a stub VCS provider, so no arm calls `gh`. Each arm
 * has its own EventStore.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import type { VcsProvider } from '../../../../src/vcs/provider.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../parity-harness.js';

vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleCreatePr } from '../../../../src/verbs/vcs/create-pr.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STUB_PR_NUMBER = 42;
const STUB_PR_URL = 'https://github.com/lvlup-sw/exarchos/pull/42';

/**
 * A provider with a fixed PR result. `listPrs` returns no PRs, so the open-PR
 * check finds nothing and the handler calls `createPr`.
 */
function makeStubProvider(): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn().mockResolvedValue({ url: STUB_PR_URL, number: STUB_PR_NUMBER }),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn().mockResolvedValue([]),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    searchIssuesByMarker: vi.fn().mockResolvedValue([]),
    getRepository: vi.fn(),
  };
}

/**
 * Forwards `create_pr` to the real `handleCreatePr` with a new stub provider
 * for each call, and rejects other actions. Only the VCS side effect is a
 * stub.
 */
function buildCreatePrCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'create_pr') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `create-pr parity stub only handles "create_pr", got "${String(action)}"`,
        },
      };
    }
    vi.mocked(createVcsProvider).mockResolvedValue(makeStubProvider());
    return handleCreatePr(
      rest as Parameters<typeof handleCreatePr>[0],
      ctx,
    );
  };
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
 * Replaces timestamps and UUIDs with placeholders and drops `_perf` and
 * `_meta`. Each call makes a fresh `operationId`, so the arms compare equal
 * only after this step.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    uuidKeys: new Set(['operationId']),
    dropKeys: new Set(['_perf', '_meta']),
  });
}

const PARITY_ARGS = {
  title: 'feat: parity pin for create_pr two-event split',
  body: 'Verifies Wave B B1.4 two-event split is carrier-equivalent.',
  base: 'main',
  head: 'feature/parity-create-pr',
} as const;

describe('CreatePr_Parity_BothCarriersObserveTwoEventSequence (B1.5)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    vi.clearAllMocks();
    for (const arm of arms) {
      await rmrfAsync(arm.stateDir);
    }
    arms = [];
  });

  it('CreatePr_Parity_BothCarriersObserveTwoEventSequence', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildCreatePrCompositeStub(),
    );

    const cliArm = await createArm('create-pr-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('create-pr-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'create_pr',
      PARITY_ARGS,
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'create_pr',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliEvents = await cliArm.ctx.eventStore.query('vcs');
    const mcpEvents = await mcpArm.ctx.eventStore.query('vcs');

    expect(cliEvents.length).toBeGreaterThanOrEqual(2);
    expect(mcpEvents.length).toBeGreaterThanOrEqual(2);

    expect(cliEvents[0].type).toBe('pr.create.requested');
    expect(mcpEvents[0].type).toBe('pr.create.requested');

    const cliExecuted = cliEvents.find((e) => e.type === 'pr.create.executed');
    const mcpExecuted = mcpEvents.find((e) => e.type === 'pr.create.executed');
    expect(cliExecuted).toBeDefined();
    expect(mcpExecuted).toBeDefined();

    const cliRequestedData = normalize(cliEvents[0].data);
    const mcpRequestedData = normalize(mcpEvents[0].data);
    expect(cliRequestedData).toEqual(mcpRequestedData);

    const cliExecutedData = normalize(cliExecuted!.data);
    const mcpExecutedData = normalize(mcpExecuted!.data);
    expect(cliExecutedData).toEqual(mcpExecutedData);

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
