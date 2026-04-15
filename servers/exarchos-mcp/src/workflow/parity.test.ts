import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLI_EXIT_CODES } from '../adapters/cli.js';
import { type DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';
import type { ToolResult } from '../format.js';

// ─── Task 014: CLI-vs-MCP Parity for exarchos_workflow (DR-3) ─────────────────
// These tests prove that the CLI adapter (task 013 work) and the MCP adapter
// emit byte-for-byte equal ToolResult payloads for the three core workflow
// actions: init, get, set. Downstream parity tasks (015-017) extend this
// pattern to the other composite tools.
//
// Strategy:
// - Run both adapters in-process against *separate* tmp state dirs with the
//   same feature id so their side effects don't collide.
// - Normalize timestamps (ISO 8601) and UUIDs before deep-equal comparison
//   so wall-clock jitter between the two calls doesn't produce false diffs.
// - Compare the full ToolResult (success flag + data + _meta + error shape).

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

/**
 * Thin adapter over the shared `harnessCallCli`. Preserves this suite's
 * existing call-site shape (flags: Record<string, string>) while the
 * harness accepts `Record<string, unknown>`.
 */
async function callCli(
  ctx: DispatchContext,
  toolAlias: string,
  actionFlag: string,
  flags: Record<string, string>,
): Promise<{ result: ToolResult; exitCode: number }> {
  return harnessCallCli(ctx, toolAlias, actionFlag, flags);
}

/**
 * Thin adapter over the shared `harnessCallMcp`. Merges the `action`
 * into the args object (the harness takes the raw `{ action, ...args }`
 * shape the MCP dispatch entry expects).
 */
async function callMcp(
  ctx: DispatchContext,
  tool: string,
  action: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return harnessCallMcp(ctx, tool, { action, ...args });
}

/**
 * Workflow suite normalizer — default placeholders (`<TS>` / `<UUID>`)
 * plus the bespoke `minutesSinceActivity` keyed transform this suite
 * has always used.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
  });
}

// ─── Fixture Harness ─────────────────────────────────────────────────────────

interface ParityFixture {
  readonly cliDir: string;
  readonly mcpDir: string;
  readonly cliCtx: DispatchContext;
  readonly mcpCtx: DispatchContext;
}

let fixture: ParityFixture;

beforeEach(async () => {
  const cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-parity-cli-'));
  const mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-parity-mcp-'));
  fixture = {
    cliDir,
    mcpDir,
    cliCtx: makeCtx(cliDir),
    mcpCtx: makeCtx(mcpDir),
  };
});

afterEach(async () => {
  await fs.rm(fixture.cliDir, { recursive: true, force: true });
  await fs.rm(fixture.mcpDir, { recursive: true, force: true });
});

// ─── Parity Tests ────────────────────────────────────────────────────────────

describe('exarchos_workflow CLI/MCP parity (DR-3)', () => {
  it('WorkflowParity_Init_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-init-feature';
    const workflowType = 'feature';

    // MCP adapter call — dispatch in-process.
    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', {
      featureId,
      workflowType,
    });

    // CLI adapter call — parseAsync in-process, --json flag, parse stdout.
    // CLI alias for exarchos_workflow is 'wf'; init action has no cli.alias.
    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { featureId, workflowType },
    );

    // Exit-code contract (task 013): success → 0.
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

    // Normalize timestamps so wall-clock jitter doesn't produce false diffs,
    // then deep-equal the full ToolResult (success + data + _meta).
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('WorkflowParity_Get_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-get-feature';
    const workflowType = 'feature';

    // Arrange: init the same workflow on *both* state dirs so each adapter
    // has state to read. This primes the fixture; we then compare the GET
    // call, not the init call.
    await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', { featureId, workflowType });
    await callMcp(fixture.cliCtx, 'exarchos_workflow', 'init', { featureId, workflowType });

    // Act — read via both adapters. `get` is exposed as CLI alias `status`.
    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'get', {
      featureId,
      query: 'phase',
    });
    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'status',
      { featureId, query: 'phase' },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('WorkflowParity_Set_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-set-feature';
    const workflowType = 'feature';

    // Arrange: init both dirs so `set` has state to mutate.
    await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', { featureId, workflowType });
    await callMcp(fixture.cliCtx, 'exarchos_workflow', 'init', { featureId, workflowType });

    // Act — issue the same `set` call through both adapters. We set an
    // artifacts field via --updates rather than a phase transition to keep
    // the test focused on the payload shape (phase transitions trigger HSM
    // guards that would dominate the assertion signal).
    const updates = { 'artifacts.design': 'docs/design.md' };

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'set', {
      featureId,
      updates,
    });
    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'set',
      { featureId, updates: JSON.stringify(updates) },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
