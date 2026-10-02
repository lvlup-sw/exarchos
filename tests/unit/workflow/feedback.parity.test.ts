import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLI_EXIT_CODES } from '../../../src/adapters/cli/cli.js';
import { type DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../parity-harness.js';
import { FEEDBACK_STREAM_ID } from '../../../src/workflow/feedback.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

/** Drops `_perf`, because its timing depends on the carrier. Every other field must match. */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, { dropKeys: new Set(['_perf']) });
}

let cliDir: string;
let mcpDir: string;
let cliCtx: DispatchContext;
let mcpCtx: DispatchContext;

beforeEach(async () => {
  cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-feedback-parity-cli-'));
  mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-feedback-parity-mcp-'));
  cliCtx = makeCtx(cliDir);
  mcpCtx = makeCtx(mcpDir);
});

afterEach(async () => {
  await rmrfAsync(cliDir);
  await rmrfAsync(mcpDir);
});

/**
 * The `feedback` action runs in the shared dispatch core. The CLI form `exarchos wf feedback`
 * and the MCP form of `exarchos_workflow` must return equal results, so the two cannot drift.
 */
describe('exarchos_workflow.feedback CLI/MCP parity (INV-2, #1319)', () => {
  /** Each carrier must also write one event to its own feedback stream. */
  it('FeedbackParity_Message_CliAndMcp_ReturnEqualPayload', async () => {
    const message = 'rehydrate envelope omitted taskProgress when projection lagged';

    const mcpResult = await harnessCallMcp(mcpCtx, 'exarchos_workflow', {
      action: 'feedback',
      message,
    });
    const { result: cliResult, exitCode } = await harnessCallCli(cliCtx, 'wf', 'feedback', {
      message,
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));

    expect(await cliCtx.eventStore.query(FEEDBACK_STREAM_ID)).toHaveLength(1);
    expect(await mcpCtx.eventStore.query(FEEDBACK_STREAM_ID)).toHaveLength(1);
  });

  /**
   * The CLI carrier passes `--session-context` as JSON. The object flag parses it to the shape
   * that the MCP carrier receives.
   */
  it('FeedbackParity_WithSessionContext_CliAndMcp_ReturnEqualPayload', async () => {
    const message = 'check_static_analysis ran in the wrong worktree';
    const sessionContext = { action: 'check_static_analysis', errorCode: 'GATE_FAILED' };

    const mcpResult = await harnessCallMcp(mcpCtx, 'exarchos_workflow', {
      action: 'feedback',
      message,
      sessionContext,
    });
    const { result: cliResult, exitCode } = await harnessCallCli(cliCtx, 'wf', 'feedback', {
      message,
      sessionContext,
    });

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));

    const [cliEvent] = await cliCtx.eventStore.query(FEEDBACK_STREAM_ID);
    expect((cliEvent.data as { sessionContext?: unknown }).sessionContext).toEqual(sessionContext);
  });
});
