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
  DELEGATE_PHASE_REHYDRATE_FIXTURE,
} from '../__tests__/parity-harness.js';
import type { ToolResult } from '../format.js';
import type { RehydrationDocument } from '../projections/rehydration/schema.js';
import { configureWorkflowMaterializer, handleInit } from './tools.js';
import { resetMaterializerCache } from '../views/tools.js';
import { ViewMaterializer } from '../views/materializer.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from '../views/workflow-state-projection.js';

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
 * has always used. `_perf` is dropped because its `ms` field is
 * measurement-path dependent (CLI arm vs MCP dispatch arm take
 * different code paths so wall-clock durations naturally differ).
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
    dropKeys: new Set(['_perf']),
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

  // T5a.1/DR-4 (#1259, v2.11): `WorkflowParity_Set_CliAndMcp_ReturnEqualPayload`
  // removed — the `set` action is hard-cut from both adapters. Field
  // updates and phase mutations are no longer authored through this
  // surface; phase mutation flows through `transition` (covered by
  // canonical-action parity coverage).

  // ─── T-24 — delegate-phase rehydrate envelope parity (rehydration-machinery-refactor) ───
  //
  // Pins INV-2 (facade equivalence over shared dispatch core) for the v:3
  // rehydration envelope. After T-20 / T-23, both `handleRehydrate` and
  // `handleCheckpoint` compose a non-null `phasePlaybook` for delegate-phase
  // workflows. This test drives the CLI and MCP carriers against an
  // identical delegate-phase fixture, normalizes wall-clock / sequence-tied
  // fields, and asserts byte-for-byte equivalent ToolResult envelopes —
  // explicitly including `data.phasePlaybook`. If a future change makes one
  // carrier compose `phasePlaybook` differently than the other (e.g. CLI
  // skips composition, or MCP serializes a different field order), this
  // assertion fails.
  it('WorkflowParity_RehydrateDelegatePhase_ByteEquivalentEnvelopeIncludingPhasePlaybook', async () => {
    // GIVEN: identical delegate-phase fixture primed on both arms.
    await DELEGATE_PHASE_REHYDRATE_FIXTURE.setup(fixture.cliCtx);
    await DELEGATE_PHASE_REHYDRATE_FIXTURE.setup(fixture.mcpCtx);

    // WHEN: rehydrate via each carrier with identical args. Use the shared
    //   `harnessCallMcp` directly here — it accepts the canonical
    //   `{ action, ...args }` shape the fixture exposes, so we don't have
    //   to split `action` back out of `mcpCall.args` to satisfy this
    //   suite's local `callMcp` wrapper.
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

    // Both arms produced a successful rehydration.
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);

    // Sanity-check the precondition this test exists to pin: phasePlaybook
    // is composed (non-null) on both arms. If T-20/T-23 ever regresses to
    // null on the delegate phase, fail loudly with a phasePlaybook-specific
    // message rather than a giant deep-equal diff.
    const cliDoc = cliResult.data as RehydrationDocument;
    const mcpDoc = mcpResult.data as RehydrationDocument;
    expect(cliDoc.phasePlaybook).not.toBeNull();
    expect(mcpDoc.phasePlaybook).not.toBeNull();

    // THEN: byte-equivalent envelopes after wall-clock normalization.
    // The deep-equal compares the ENTIRE ToolResult, so `data.phasePlaybook`
    // is implicitly part of the byte-equivalence assertion. We additionally
    // assert it explicitly to make the contract self-documenting.
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(cliDoc.phasePlaybook).toEqual(mcpDoc.phasePlaybook);
  });
});

// ─── T8 (#1555) — `asOf` CLI↔MCP parity (INV-2 facade equivalence) ───────────
//
// `asOf` behavior lives entirely in the shared dispatch core; the CLI and MCP
// adapters only thread the param through. These tests prove the carriers emit
// byte-equivalent ToolResults for a bounded (`untilSequence`) read on both
// `get` (`exarchos_workflow`) and `workflow_status` (`exarchos_view`).
//
// The CLI arm passes `--as-of '{"untilSequence":N}'` (a JSON string); the MCP
// arm passes `asOf: { untilSequence: N }` (a native object). Equivalence here
// is the end-to-end proof that the CLI string is JSON-coerced identically to
// the MCP payload (the flag-classification contract pinned in
// `schema-to-flags.test.ts`) AND that both carriers route the same bounded
// fold through the dispatch core.

describe('asOf CLI/MCP parity (T8, #1555, INV-2)', () => {
  let cliDir: string;
  let mcpDir: string;
  let cliCtx: DispatchContext;
  let mcpCtx: DispatchContext;

  // Seed a feature workflow advanced plan → plan-review → delegate so a bound at
  // seq 1 yields a DIFFERENT phase than the live tip — the asOf must actually
  // bite for the parity comparison to be meaningful. DR-4 (#1581): plan is initial.
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
    // `get` ES-v2 path needs a configured workflow materializer. A single
    // module-level instance serves both arms (each call passes its own
    // stateDir/eventStore, and asOf reads bypass the cache anyway).
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowMaterializer(materializer);
    await seed(cliCtx);
    await seed(mcpCtx);
  });

  afterEach(async () => {
    configureWorkflowMaterializer(null);
    resetMaterializerCache();
    await fs.rm(cliDir, { recursive: true, force: true });
    await fs.rm(mcpDir, { recursive: true, force: true });
  });

  it('parity_getAsOfUntilSequence_cliEqualsMcp', async () => {
    // MCP: native object asOf.
    const mcpResult = await harnessCallMcp(mcpCtx, 'exarchos_workflow', {
      action: 'get',
      featureId: 'asof-parity',
      query: 'phase',
      asOf: { untilSequence: 1 },
    });
    // CLI: --as-of '<json>' string, JSON-coerced by the object-classified flag.
    const { result: cliResult, exitCode } = await harnessCallCli(
      cliCtx,
      'wf',
      'status',
      { featureId: 'asof-parity', query: 'phase', asOf: { untilSequence: 1 } },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    // The bound bit: phase at seq 1 is 'plan' (initial), NOT the live 'delegate'.
    expect((mcpResult as { data?: unknown }).data).toBe('plan');
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });

  it('parity_viewAsOf_cliEqualsMcp', async () => {
    // MCP: native object asOf on the workflow_status view.
    const mcpResult = await harnessCallMcp(mcpCtx, 'exarchos_view', {
      action: 'workflow_status',
      workflowId: 'asof-parity',
      asOf: { untilSequence: 1 },
    });
    // CLI: `vw workflow_status -w asof-parity --as-of '<json>'`.
    const { result: cliResult, exitCode } = await harnessCallCli(
      cliCtx,
      'vw',
      'workflow_status',
      { workflowId: 'asof-parity', asOf: { untilSequence: 1 } },
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    // The workflow-status view reports phase 'started' at seq 1 (literal seed),
    // distinct from the live 'delegate' — the bound bit.
    expect((mcpResult as { data?: { phase?: string } }).data?.phase).toBe('started');
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
