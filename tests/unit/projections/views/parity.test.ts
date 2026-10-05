/**
 * CLI and MCP payload parity for `exarchos_view`.
 *
 * Each test calls a view action through both adapters with one shared `DispatchContext`, then
 * compares the normalized payloads. The state directory is empty, so the tests prove that the
 * payload shapes match. They do not prove that a view holds data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  UUID_ANY_RE,
} from '../../parity-harness.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const VIEW_TOOL = 'exarchos_view';

interface RunArtifacts {
  tmpDir: string;
  ctx: DispatchContext;
}

async function setupCtx(): Promise<RunArtifacts> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-parity-'));
  const eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir: tmpDir,
    eventStore,
    enableTelemetry: false,
  };
  return { tmpDir, ctx };
}

async function cleanupCtx(artifacts: RunArtifacts): Promise<void> {
  await rmrfAsync(artifacts.tmpDir);
}

/** Call the MCP transport-agnostic dispatch directly. */
async function callMcp(
  action: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  return harnessCallMcp(ctx, VIEW_TOOL, { action, ...args });
}

/**
 * Returns the CLI subcommand name for a view action. Commander registers
 * `action.cli?.alias ?? action.name`, so `pipeline` becomes `ls`.
 */
function resolveCliActionName(action: string): string {
  const tool = TOOL_REGISTRY.find((t) => t.name === VIEW_TOOL);
  if (!tool) throw new Error(`Tool ${VIEW_TOOL} missing from registry`);
  const def = tool.actions.find((a) => a.name === action);
  if (!def) throw new Error(`Action ${action} missing on ${VIEW_TOOL}`);
  return def.cli?.alias ?? def.name;
}

/** Runs the CLI program in-process and parses the `ToolResult` from stdout. Resolves the `cli.alias` first. */
async function callCli(
  action: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<{ result: ToolResult; exitCode: number }> {
  const cliAction = resolveCliActionName(action);
  return harnessCallCli(ctx, 'vw', cliAction, args);
}

/** Replaces timestamps with `<ISO>` and UUIDs of any version with `<UUID>`, and drops `_perf`. */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<ISO>',
    uuidPlaceholder: '<UUID>',
    uuidRegex: UUID_ANY_RE,
    dropKeys: new Set(['_perf']),
  });
}

describe('exarchos_view CLI/MCP payload parity (DR-3)', () => {
  let artifacts: RunArtifacts;

  /** Clears the singleton materializer cache, so each temporary state directory gets fresh projection state. */
  beforeEach(async () => {
    resetMaterializerCache();
    artifacts = await setupCtx();
  });

  afterEach(async () => {
    resetMaterializerCache();
    await cleanupCtx(artifacts);
  });

  it('ViewParity_Pipeline_CliAndMcp_ReturnEqualPayload', async () => {
    const args = { limit: 10, offset: 0 };

    const mcpResult = await callMcp('pipeline', args, artifacts.ctx);
    const { result: cliResult, exitCode } = await callCli('pipeline', args, artifacts.ctx);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('ViewParity_WorkflowStatus_CliAndMcp_ReturnEqualPayload', async () => {
    const args = { workflowId: 'parity-test-feature' };

    const mcpResult = await callMcp('workflow_status', args, artifacts.ctx);
    const { result: cliResult, exitCode } = await callCli('workflow_status', args, artifacts.ctx);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  /** `limit` and `offset` exercise argument coercion in the CLI schema-to-flags layer. */
  it('ViewParity_Tasks_CliAndMcp_ReturnEqualPayload', async () => {
    const args = { workflowId: 'parity-test-feature', limit: 5, offset: 0 };

    const mcpResult = await callMcp('tasks', args, artifacts.ctx);
    const { result: cliResult, exitCode } = await callCli('tasks', args, artifacts.ctx);

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(mcpResult.success).toBe(true);
    expect(cliResult.success).toBe(true);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
