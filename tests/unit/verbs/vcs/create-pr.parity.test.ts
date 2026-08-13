/**
 * CLI↔MCP parity tests for the `create_pr` action (Wave B, B1.5).
 *
 * Verifies that the two-event split refactor (B1.4) preserves carrier
 * equivalence: both the CLI (`exarchos orch create_pr`) and MCP
 * (`exarchos_orchestrate {action:"create_pr"}`) surfaces observe the
 * [pr.create.requested, pr.create.executed] two-event sequence in the
 * same order with identical data shapes.
 *
 * Strategy (mirrors doctor.parity.test.ts):
 *   - Stub the `exarchos_orchestrate` composite handler via
 *     `stubCompositeHandler`. The stub forwards `create_pr` invocations
 *     to the real `handleCreatePr` with a deterministic VCS provider so
 *     neither arm shells out to `gh` or hits real GitHub infrastructure.
 *   - Two isolated arms (separate tmp EventStore instances) run
 *     sequentially and capture emitted events via eventStore.query().
 *   - Assert both arms observe [pr.create.requested, pr.create.executed]
 *     in the same order with the same data shape (operationId normalized).
 *
 * This test passes immediately (no source change needed) if B1.4 is
 * correctly routed through the shared dispatch core — it acts as a parity
 * pin preventing future carrier divergence.
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

// Mock the VCS factory so neither arm invokes `gh` CLI.
vi.mock('../../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from '../../../../src/vcs/factory.js';
import { handleCreatePr } from '../../../../src/verbs/vcs/create-pr.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

// ─── Deterministic VCS provider stub ──────────────────────────────────────

const STUB_PR_NUMBER = 42;
const STUB_PR_URL = 'https://github.com/lvlup-sw/exarchos/pull/42';

function makeStubProvider(): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn().mockResolvedValue({ url: STUB_PR_URL, number: STUB_PR_NUMBER }),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    // listPrs returns empty so the idempotent check falls through to createPr.
    listPrs: vi.fn().mockResolvedValue([]),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    // Wave-B added searchIssuesByMarker as a required interface member
    // for handleCreateIssue's recovery precheck. handleCreatePr does not
    // invoke it, so an empty-array stub is sufficient to satisfy the
    // strict VcsProvider interface here.
    searchIssuesByMarker: vi.fn().mockResolvedValue([]),
    getRepository: vi.fn(),
  };
}

// ─── Composite stub ────────────────────────────────────────────────────────

/**
 * Build a composite stub that routes `create_pr` to the real
 * `handleCreatePr` with a deterministic VCS provider. Identical to the
 * doctor parity pattern: same real handler + real EventStore path across
 * both CLI and MCP arms, only the VCS side effect is stubbed out.
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
    // Install the stub provider for this invocation.
    vi.mocked(createVcsProvider).mockResolvedValue(makeStubProvider());
    return handleCreatePr(
      rest as Parameters<typeof handleCreatePr>[0],
      ctx,
    );
  };
}

// ─── Arm helpers ───────────────────────────────────────────────────────────

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

// ─── Normalization ─────────────────────────────────────────────────────────

/**
 * Strip wall-clock / UUID fields. `operationId` is a fresh UUID per
 * invocation — normalize it to a stable placeholder so two arm
 * invocations produce byte-equal event sequences.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    uuidKeys: new Set(['operationId']),
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Parity args ───────────────────────────────────────────────────────────

const PARITY_ARGS = {
  title: 'feat: parity pin for create_pr two-event split',
  body: 'Verifies Wave B B1.4 two-event split is carrier-equivalent.',
  base: 'main',
  head: 'feature/parity-create-pr',
} as const;

// ─── Tests ─────────────────────────────────────────────────────────────────

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
    // Arrange — install the deterministic stub on the orchestrate composite.
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildCreatePrCompositeStub(),
    );

    const cliArm = await createArm('create-pr-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('create-pr-parity-mcp-');
    arms.push(mcpArm);

    // Act (CLI arm) — `exarchos orch create_pr --title ... --body ... --base ... --head ...`
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'create_pr',
      PARITY_ARGS,
    );

    // Act (MCP arm) — direct dispatch entry point.
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'create_pr',
      ...PARITY_ARGS,
    });

    // Assert — both surfaces report success.
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    // Assert — both arms observe the two-event sequence: [requested, executed].
    const cliEvents = await cliArm.ctx.eventStore.query('vcs');
    const mcpEvents = await mcpArm.ctx.eventStore.query('vcs');

    // Verify at least two events were committed (Phase A + Phase B).
    expect(cliEvents.length).toBeGreaterThanOrEqual(2);
    expect(mcpEvents.length).toBeGreaterThanOrEqual(2);

    // Verify Phase A (pr.create.requested) is first.
    expect(cliEvents[0].type).toBe('pr.create.requested');
    expect(mcpEvents[0].type).toBe('pr.create.requested');

    // Verify Phase B (pr.create.executed) follows.
    const cliExecuted = cliEvents.find((e) => e.type === 'pr.create.executed');
    const mcpExecuted = mcpEvents.find((e) => e.type === 'pr.create.executed');
    expect(cliExecuted).toBeDefined();
    expect(mcpExecuted).toBeDefined();

    // Assert — event data shapes are identical modulo operationId (UUID).
    const cliRequestedData = normalize(cliEvents[0].data);
    const mcpRequestedData = normalize(mcpEvents[0].data);
    expect(cliRequestedData).toEqual(mcpRequestedData);

    const cliExecutedData = normalize(cliExecuted!.data);
    const mcpExecutedData = normalize(mcpExecuted!.data);
    expect(cliExecutedData).toEqual(mcpExecutedData);

    // Assert — ToolResult payloads are byte-equivalent across carriers
    // after stripping wall-clock / UUID fields.
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
