/**
 * CLI and MCP parity for the `check_contract_drift` action.
 *
 * Both facades dispatch through the same composite, so for one input they must
 * return byte-identical `ToolResult` payloads after normalization. The stub
 * forwards to the real `handleContractDrift`. A mock of `runContractDrift` keeps
 * the gate deterministic and stops it from running shell commands.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** The drift core mock, so both arms compute the same result. */
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

/**
 * Drop `evidenceReferences` with `_perf` and `_meta`. Each arm owns a separate
 * event store, so the content-addressed evidence id differs per arm.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
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

  /**
   * CLI and MCP results match for a passing gate and for a failing gate. A
   * failing gate is still a successful tool call.
   */
  it('ContractDrift_CliVsMcp_IdenticalResultForSameInput', async () => {
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

    expect(cliFail.success).toBe(true);
    expect(mcpFail.success).toBe(true);
    const cliFailData = cliFail.data as { passed: boolean; drift: boolean };
    expect(cliFailData.passed).toBe(false);
    expect(cliFailData.drift).toBe(true);

    expect(normalize(cliFail)).toEqual(normalize(mcpFail));
    expect(JSON.stringify(normalize(cliFail))).toEqual(JSON.stringify(normalize(mcpFail)));
  });
});
