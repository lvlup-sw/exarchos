/**
 * CLI and MCP parity for `workflow_status` and `workflow_checkpoint` on seeded state.
 *
 * Each test gives the CLI arm and the MCP arm a separate state directory with the same seed.
 * It sends the same call through each adapter, then compares the normalized `ToolResult` envelopes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { CLI_EXIT_CODES } from '../../src/adapters/cli/cli.js';
import { resetMaterializerCache } from '../../src/projections/views/tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from './parity-harness.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

interface ParityArm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function makeArm(label: string): Promise<ParityArm> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `c9-parity-${label}-`));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { stateDir, ctx };
}

async function teardownArm(arm: ParityArm): Promise<void> {
  await rmrfAsync(arm.stateDir);
}

/**
 * Replaces timestamps, UUIDs of any version and `minutesSinceActivity` with placeholders.
 * It drops `_perf`. `minutesSinceActivity` depends on the clock, so the arms can differ in it.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<ISO>',
    uuidPlaceholder: '<UUID>',
    uuidRegex: UUID_ANY_RE,
    keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
    dropKeys: new Set(['_perf']),
  });
}

/**
 * `seedDuplicateTaskCompleted` appends two `task.completed` events for one task id to an arm.
 * The second event has its own `idempotencyKey`. The event store keeps both events, so only the projection can remove the duplicate.
 * The test compares the two envelopes. It does not assert the count of completed tasks.
 */
describe('CLI/MCP parity — workflow_status (C9, #1109)', () => {
  let cliArm: ParityArm;
  let mcpArm: ParityArm;

  beforeEach(async () => {
    resetMaterializerCache();
    cliArm = await makeArm('status-cli');
    mcpArm = await makeArm('status-mcp');
  });

  afterEach(async () => {
    resetMaterializerCache();
    await teardownArm(cliArm);
    await teardownArm(mcpArm);
  });

  async function seedDuplicateTaskCompleted(arm: ParityArm, featureId: string): Promise<void> {
    await arm.ctx.eventStore.append(featureId, {
      type: 'workflow.started',
      correlationId: featureId,
      data: { featureId, workflowType: 'feature' },
    });
    await arm.ctx.eventStore.append(featureId, {
      type: 'task.assigned',
      correlationId: featureId,
      data: { taskId: 't1' },
    });
    await arm.ctx.eventStore.append(featureId, {
      type: 'task.completed',
      correlationId: featureId,
      data: { taskId: 't1' },
    });
    await arm.ctx.eventStore.append(
      featureId,
      {
        type: 'task.completed',
        correlationId: featureId,
        data: { taskId: 't1' },
      },
      { idempotencyKey: `${featureId}:dup-completed` },
    );
  }

  it('assertParity_workflowStatus_cliAndMcpByteEqual', async () => {
    const featureId = 'c9-parity-status';

    await seedDuplicateTaskCompleted(cliArm, featureId);
    await seedDuplicateTaskCompleted(mcpArm, featureId);

    const mcpResult: ToolResult = await harnessCallMcp(
      mcpArm.ctx,
      'exarchos_view',
      { action: 'workflow_status', workflowId: featureId },
    );

    const { result: cliResult, exitCode } = await harnessCallCli(
      cliArm.ctx,
      'vw',
      'workflow_status',
      { workflowId: featureId },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});

/**
 * `initWorkflow` gives each arm the same initial state, so `handleCheckpoint` has state to read.
 * The normalizer replaces the timestamps in the `_checkpoint` block with `<ISO>`.
 */
describe('CLI/MCP parity — workflow_checkpoint (C9, #1109)', () => {
  let cliArm: ParityArm;
  let mcpArm: ParityArm;

  beforeEach(async () => {
    resetMaterializerCache();
    cliArm = await makeArm('checkpoint-cli');
    mcpArm = await makeArm('checkpoint-mcp');
  });

  afterEach(async () => {
    resetMaterializerCache();
    await teardownArm(cliArm);
    await teardownArm(mcpArm);
  });

  async function initWorkflow(arm: ParityArm, featureId: string): Promise<void> {
    await harnessCallMcp(arm.ctx, 'exarchos_workflow', {
      action: 'init',
      featureId,
      workflowType: 'feature',
    });
  }

  /** With no `handoff`, the handoff digest in the idempotency key of the checkpoint is the hash of `{}` on both arms. */
  it('assertParity_workflowCheckpoint_cliAndMcpByteEqual', async () => {
    const featureId = 'c9-parity-checkpoint';

    await initWorkflow(cliArm, featureId);
    await initWorkflow(mcpArm, featureId);

    const mcpResult: ToolResult = await harnessCallMcp(
      mcpArm.ctx,
      'exarchos_workflow',
      { action: 'checkpoint', featureId, summary: 'C9 parity checkpoint' },
    );

    const { result: cliResult, exitCode } = await harnessCallCli(
      cliArm.ctx,
      'wf',
      'checkpoint',
      { featureId, summary: 'C9 parity checkpoint' },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  /**
   * Both arms send the same `handoff` object.
   * The harness writes it as `--handoff <json>` for the CLI, and `coerceFlags` parses it back to an object.
   * The MCP arm receives the object directly. The test fails when one surface drops a `handoff` key that the other keeps.
   */
  it('CheckpointParity_McpCli_IdenticalEnvelope', async () => {
    const featureId = 'c9-parity-checkpoint-handoff';

    await initWorkflow(cliArm, featureId);
    await initWorkflow(mcpArm, featureId);

    const handoff = {
      context: 'T5 parity check: agent dispatch surface',
      nextSteps: ['Verify CLI/MCP envelope byte-equality post-T5'],
      suggestions: ['Pin parity test BEFORE merging T5'],
    };

    const mcpResult: ToolResult = await harnessCallMcp(
      mcpArm.ctx,
      'exarchos_workflow',
      {
        action: 'checkpoint',
        featureId,
        summary: 'C9 T5 parity handoff',
        handoff,
      },
    );

    const { result: cliResult, exitCode } = await harnessCallCli(
      cliArm.ctx,
      'wf',
      'checkpoint',
      { featureId, summary: 'C9 T5 parity handoff', handoff },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
