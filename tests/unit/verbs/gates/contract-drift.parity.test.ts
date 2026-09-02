/**
 * CLI↔MCP parity tests for the `check_contract_drift` action (INV-2).
 *
 * `check_contract_drift` has two user-visible facades:
 *   1. MCP — `exarchos_orchestrate { action: 'check_contract_drift' }`.
 *   2. CLI — the auto-generated `exarchos orch check_contract_drift` surface,
 *      emitted from the action's Zod schema in registry.ts.
 *
 * Both dispatch through the same composite, so for a given input they MUST
 * project byte-identical `ToolResult` payloads (modulo wall-clock fields).
 *
 * Strategy mirrors test-adequacy.parity.test.ts: stub the composite so the
 * action forwards to the real `handleContractDrift`, and mock the pure
 * `runContractDrift` so the gate is deterministic and never shells out.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Mock the drift core so both arms compute the same deterministic result.
const mockRunContractDrift = vi.fn();
vi.mock('../../../../src/verbs/gates/contract-drift.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/contract-drift.js')>();
  return { ...actual, runContractDrift: (...args: unknown[]) => mockRunContractDrift(...args) };
});

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../parity-harness.js';

import { handleContractDrift } from '../../../../src/verbs/gates/contract-drift-handler.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';

const PARITY_REPO_ROOT = '/fake/agent/worktree';

const PARITY_ARGS = {
  featureId: 'feat-contract-parity',
  taskId: 'T-parity',
  branch: 'feature/parity',
  baseBranch: 'main',
  repoRoot: PARITY_REPO_ROOT,
} as const;

function makePassResult() {
  return { passed: true, drift: false, breaking: [], report: 'baseline ok; breaking-diff clean' };
}

function makeFailResult() {
  return {
    passed: false,
    drift: true,
    breaking: ['BREAKING: removed field foo'],
    report: 'baseline ok; breaking-diff DRIFT: 1 finding(s)',
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
  await seedActivePhaseAttempt(eventStore, 'feat-contract-parity');
  const ctx: DispatchContext = withTrustedCaller({ stateDir, eventStore, enableTelemetry: false });
  return { stateDir, ctx };
}

function buildContractDriftCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'check_contract_drift') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `contract-drift parity stub only handles "check_contract_drift", got "${String(action)}"`,
        },
      };
    }
    return handleContractDrift(
      rest as Parameters<typeof handleContractDrift>[0],
      ctx.stateDir,
      ctx.eventStore,
    );
  };
}

function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    // videnceReferences carries the durable evidence identity the canonical
    // gate runner minted for THIS arm. Each arm owns a separate state dir and
    // event store, so the content-addressed evidenceId necessarily differs —
    // it is arm-local provenance, not part of the CLI/MCP payload contract
    // under comparison. Evidence PERSISTENCE is proven by the gate integration
    // suites, which assert the reference and its digest directly.
    dropKeys: new Set(['_perf', '_meta', 'evidenceReferences']),
  });
}

describe('exarchos check_contract_drift CLI↔MCP parity (INV-2)', () => {
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
    mockRunContractDrift.mockReset();
  });

  it('ContractDrift_CliVsMcp_IdenticalResultForSameInput', async () => {
    // ─── Pass path ─────────────────────────────────────────────────────────
    mockRunContractDrift.mockResolvedValue(makePassResult());
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildContractDriftCompositeStub(),
    );

    const cliArm = await createArm('contract-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('contract-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'check_contract_drift',
      PARITY_ARGS,
    );
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'check_contract_drift',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliData = cliResult.data as { passed: boolean; drift: boolean };
    expect(cliData.passed).toBe(true);
    expect(cliData.drift).toBe(false);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    // ─── Fail path ─────────────────────────────────────────────────────────
    mockRunContractDrift.mockResolvedValue(makeFailResult());

    const cliFailArm = await createArm('contract-parity-cli-fail-');
    arms.push(cliFailArm);
    const mcpFailArm = await createArm('contract-parity-mcp-fail-');
    arms.push(mcpFailArm);

    const { result: cliFail } = await harnessCallCli(
      cliFailArm.ctx,
      'orch',
      'check_contract_drift',
      PARITY_ARGS,
    );
    const mcpFail = await harnessCallMcp(mcpFailArm.ctx, 'exarchos_orchestrate', {
      action: 'check_contract_drift',
      ...PARITY_ARGS,
    });

    // A failing gate is still a successful tool call (advisory carrier).
    expect(cliFail.success).toBe(true);
    expect(mcpFail.success).toBe(true);
    const cliFailData = cliFail.data as { passed: boolean; drift: boolean };
    expect(cliFailData.passed).toBe(false);
    expect(cliFailData.drift).toBe(true);

    expect(normalize(cliFail)).toEqual(normalize(mcpFail));
    expect(JSON.stringify(normalize(cliFail))).toEqual(JSON.stringify(normalize(mcpFail)));
  });
});
