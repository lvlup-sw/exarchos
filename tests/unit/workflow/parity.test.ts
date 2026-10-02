/**
 * Parity tests for the CLI and MCP adapters of `exarchos_workflow`, and for the `asOf` read of `exarchos_view`.
 * Each adapter runs in process against its own temporary state directory, with the same feature id.
 * The tests normalize timestamps and UUIDs, then compare the full `ToolResult` of the two adapters.
 */

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
  DELEGATE_PHASE_REHYDRATE_FIXTURE,
} from '../parity-harness.js';
import type { ToolResult } from '../../../src/format.js';
import type { RehydrationDocument } from '../../../src/projections/rehydration/schema.js';
import { handleInit } from '../../../src/workflow/tools.js';
import { resetMaterializerCache } from '../../../src/projections/views/tools.js';
import { ViewMaterializer } from '../../../src/projections/views/materializer.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from '../../../src/projections/views/workflow-state-projection.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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
 * The harness normalizer with a `<MINUTES>` placeholder for `minutesSinceActivity`.
 * It drops `_perf`, because the CLI and MCP paths measure different durations.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
    dropKeys: new Set(['_perf']),
  });
}

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
  await rmrfAsync(fixture.cliDir);
  await rmrfAsync(fixture.mcpDir);
});

describe('exarchos_workflow CLI/MCP parity (DR-3)', () => {
  it('WorkflowParity_Init_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-init-feature';
    const workflowType = 'feature';

    const mcpResult = await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', {
      featureId,
      workflowType,
    });

    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      'wf',
      'init',
      { featureId, workflowType },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('WorkflowParity_Get_CliAndMcp_ReturnEqualPayload', async () => {
    const featureId = 'parity-get-feature';
    const workflowType = 'feature';

    await callMcp(fixture.mcpCtx, 'exarchos_workflow', 'init', { featureId, workflowType });
    await callMcp(fixture.cliCtx, 'exarchos_workflow', 'init', { featureId, workflowType });

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

  /**
   * `handleRehydrate` composes a non-null `phasePlaybook` for a delegate-phase workflow.
   * The CLI and MCP envelopes must be equal after normalization. The test also compares `data.phasePlaybook` alone.
   * The test calls `harnessCallMcp` directly, because the fixture holds the `{ action, ...args }` shape.
   * The non-null checks give a clear message before the large deep-equal diff.
   */
  it('WorkflowParity_RehydrateDelegatePhase_ByteEquivalentEnvelopeIncludingPhasePlaybook', async () => {
    await DELEGATE_PHASE_REHYDRATE_FIXTURE.setup(fixture.cliCtx);
    await DELEGATE_PHASE_REHYDRATE_FIXTURE.setup(fixture.mcpCtx);

    const mcpResult = await harnessCallMcp(
      fixture.mcpCtx,
      DELEGATE_PHASE_REHYDRATE_FIXTURE.mcpCall.tool,
      DELEGATE_PHASE_REHYDRATE_FIXTURE.mcpCall.args,
    );
    const { result: cliResult, exitCode } = await callCli(
      fixture.cliCtx,
      DELEGATE_PHASE_REHYDRATE_FIXTURE.cliCall.toolAlias,
      DELEGATE_PHASE_REHYDRATE_FIXTURE.cliCall.action,
      DELEGATE_PHASE_REHYDRATE_FIXTURE.cliCall.flags as Record<string, string>,
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);

    const cliDoc = cliResult.data as RehydrationDocument;
    const mcpDoc = mcpResult.data as RehydrationDocument;
    expect(cliDoc.phasePlaybook).not.toBeNull();
    expect(mcpDoc.phasePlaybook).not.toBeNull();

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliDoc.phasePlaybook).toEqual(mcpDoc.phasePlaybook);
  });
});

/**
 * `asOf` lives in the shared dispatch core, and the adapters only pass it through.
 * The CLI passes `--as-of` as a JSON string, and MCP passes a native object.
 * Equal results prove that the CLI flag parses to the same payload and that both adapters run the same bounded fold.
 * `seed` advances the workflow from `plan` to `delegate`, so the phase at sequence 1 differs from the live phase.
 */
describe('asOf CLI/MCP parity (T8, #1555, INV-2)', () => {
  let cliDir: string;
  let mcpDir: string;
  let cliCtx: DispatchContext;
  let mcpCtx: DispatchContext;

  async function seed(ctx: DispatchContext): Promise<void> {
    await handleInit({ featureId: 'asof-parity', workflowType: 'feature' }, ctx.stateDir, ctx.eventStore);
    await ctx.eventStore.append('asof-parity', {
      type: 'workflow.transition',
      data: { from: 'plan', to: 'plan-review' },
    });
    await ctx.eventStore.append('asof-parity', {
      type: 'workflow.transition',
      data: { from: 'plan-review', to: 'delegate' },
    });
  }

  beforeEach(async () => {
    resetMaterializerCache();
    cliDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-asof-cli-'));
    mcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-asof-mcp-'));
    cliCtx = makeCtx(cliDir);
    mcpCtx = makeCtx(mcpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    await seed(cliCtx);
    await seed(mcpCtx);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(cliDir);
    await rmrfAsync(mcpDir);
  });

  it('parity_getAsOfUntilSequence_cliEqualsMcp', async () => {
    const mcpResult = await harnessCallMcp(mcpCtx, 'exarchos_workflow', {
      action: 'get',
      featureId: 'asof-parity',
      query: 'phase',
      asOf: { untilSequence: 1 },
    });
    const { result: cliResult, exitCode } = await harnessCallCli(
      cliCtx,
      'wf',
      'status',
      { featureId: 'asof-parity', query: 'phase', asOf: { untilSequence: 1 } },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect((mcpResult as { data?: unknown }).data).toBe('plan');
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('parity_viewAsOf_cliEqualsMcp', async () => {
    const mcpResult = await harnessCallMcp(mcpCtx, 'exarchos_view', {
      action: 'workflow_status',
      workflowId: 'asof-parity',
      asOf: { untilSequence: 1 },
    });
    const { result: cliResult, exitCode } = await harnessCallCli(
      cliCtx,
      'vw',
      'workflow_status',
      { workflowId: 'asof-parity', asOf: { untilSequence: 1 } },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect((mcpResult as { data?: { phase?: string } }).data?.phase).toBe('started');
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
