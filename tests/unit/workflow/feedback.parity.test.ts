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

// ─── #1319 — feedback action CLI/MCP parity (INV-2 facade equivalence) ────────
//
// The `feedback` action's behavior lives entirely in the shared dispatch core
// (handleWorkflow → handleFeedback); the CLI and MCP adapters only thread the
// args through. These tests prove both carriers emit byte-equivalent
// ToolResults for `feedback`, so the documented `exarchos wf feedback
// --message …` CLI form and the `exarchos_workflow({action:"feedback"})` MCP
// form cannot drift.

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

function normalize(value: unknown): unknown {
  // `_perf.ms` is measurement-path dependent (CLI parseAsync vs MCP dispatch),
  // so drop it before deep-equal — every other field must match.
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

describe('exarchos_workflow.feedback CLI/MCP parity (INV-2, #1319)', () => {
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

    // Both arms actually wrote to their own meta/feedback stream.
    expect(await cliCtx.eventStore.query(FEEDBACK_STREAM_ID)).toHaveLength(1);
    expect(await mcpCtx.eventStore.query(FEEDBACK_STREAM_ID)).toHaveLength(1);
  });

  it('FeedbackParity_WithSessionContext_CliAndMcp_ReturnEqualPayload', async () => {
    const message = 'check_static_analysis ran in the wrong worktree';
    const sessionContext = { action: 'check_static_analysis', errorCode: 'GATE_FAILED' };

    const mcpResult = await harnessCallMcp(mcpCtx, 'exarchos_workflow', {
      action: 'feedback',
      message,
      sessionContext,
    });
    // The CLI arm passes `--session-context '<json>'`; the object-classified
    // flag JSON-coerces it to the same shape the MCP arm received.
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
