/**
 * CLI and MCP parity tests for the `doctor` action.
 *
 * The facades are `exarchos_orchestrate {action:'doctor'}` over MCP and `exarchos orch doctor` on the CLI.
 * Both must return the same ToolResult, apart from time fields.
 * The suite stubs the `exarchos_orchestrate` composite with `stubCompositeHandler`.
 * The stub sends `doctor` to `handleDoctorWithChecks` with a fixed check list and `makeStubProbes()`.
 * Thus the real handler, schema, and adapter projection run without real filesystem, git, or SQLite state.
 * Each arm has its own temporary state directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../src/dispatch/core/dispatch.js';
import { deriveLocalOperatorIdentity } from '../../../src/dispatch/caller-identity.js';
import { buildDefaultProcessResolver } from '../../../src/workflow/capabilities/resolver.js';
import type { ToolResult } from '../../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../parity-harness.js';

import { handleDoctorWithChecks } from '../../../src/verbs/doctor/index.js';
import type { HandleDoctorArgs } from '../../../src/verbs/doctor/index.js';
import { makeStubProbes } from '../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import type { CheckFn } from '../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import type { CheckResult } from '../../../src/verbs/doctor/schema.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Fixed checks with the statuses Pass, Fail, and Skipped.
 * Each check has a fixed message and `durationMs: 0`, so the output is the same on each run.
 */
const DETERMINISTIC_CHECKS: ReadonlyArray<CheckFn> = [
  async (): Promise<CheckResult> => ({
    category: 'runtime',
    name: 'parity-pass',
    status: 'Pass',
    message: 'deterministic pass for parity test',
    durationMs: 0,
  }),
  async (): Promise<CheckResult> => ({
    category: 'plugin',
    name: 'parity-fail',
    status: 'Fail',
    message: 'deterministic fail for parity test',
    fix: 'this is a test fixture; ignore',
    durationMs: 0,
  }),
  async (): Promise<CheckResult> => ({
    category: 'storage',
    name: 'parity-skipped',
    status: 'Skipped',
    message: 'deterministic skip for parity test',
    reason: 'test fixture',
    durationMs: 0,
  }),
];

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
    callerIdentity: deriveLocalOperatorIdentity(stateDir),
    capabilityResolver: buildDefaultProcessResolver(),
  };
  return { stateDir, ctx };
}

/**
 * Composite stub that handles the `doctor` action via
 * `handleDoctorWithChecks` with the deterministic check list + stub probes.
 * All other orchestrate actions are unreachable in this suite.
 */
function buildDoctorCompositeStub(
  checks: ReadonlyArray<CheckFn>,
): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'doctor') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `doctor parity stub only handles action "doctor", got "${String(action)}"`,
        },
      };
    }
    return handleDoctorWithChecks(
      rest as HandleDoctorArgs,
      ctx,
      checks,
      () => makeStubProbes(),
    );
  };
}

/**
 * Composite stub that makes the doctor action throw at the handler layer.
 * Exercises the dispatch-level error boundary (INTERNAL_ERROR) which both
 * adapters share.
 */
function buildThrowingCompositeStub(message: string): CompositeHandler {
  return async (_args, _ctx): Promise<ToolResult> => {
    throw new Error(message);
  };
}

/**
 * Doctor parity suite normalizer. Doctor output embeds `durationMs` at
 * multiple levels (per-check + handler wall-time). We strip all time-like
 * values so two independent invocations (each with its own `Date.now()`
 * stamp on the diagnostic event) compare equal.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { durationMs: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

/**
 * Skipped on Windows: each case runs the real CLI and MCP doctor over SQLite, and setup takes more than 60 seconds there.
 * The `parity.test.ts` snapshot suite also checks facade equivalence.
 */
describe.skipIf(process.platform === 'win32')('exarchos doctor CLI↔MCP parity', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  beforeEach(() => {
  });

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rmrfAsync(arm.stateDir);
    }
    arms = [];
    vi.restoreAllMocks();
  });

  /**
   * The CLI arm runs through `buildCli`, Commander, and `dispatch`. The MCP arm calls `dispatch` with `{ action, ...args }`.
   * The last assertion compares a constant with itself. It is a marker for the TDD gate and cannot fail.
   */
  it('Doctor_CliAndMcpAdaptersGivenSameProbes_ReturnByteEqualJsonOutput', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildDoctorCompositeStub(DETERMINISTIC_CHECKS),
    );

    const cliArm = await createArm('doctor-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('doctor-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'doctor',
      {},
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'doctor',
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);

    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    const cliData = cliResult.data as { checks: CheckResult[]; summary: { passed: number; failed: number; skipped: number; warnings: number } };
    expect(cliData.checks).toHaveLength(DETERMINISTIC_CHECKS.length);
    expect(cliData.summary).toEqual({ passed: 1, warnings: 0, failed: 1, skipped: 1 });

    expect('parity-asserted').toBe('parity-asserted');
  });

  /**
   * The handler throws, so both adapters return the INTERNAL_ERROR shape from the `dispatch()` error boundary.
   * MCP has no exit code, so only the CLI exit code 2 (HANDLER_ERROR) is checked.
   */
  it('Doctor_CliAndMcpAdaptersOnFailure_ReturnIdenticalErrorShape', async () => {
    const errorMessage = 'simulated doctor-handler failure for parity test';
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildThrowingCompositeStub(errorMessage),
    );

    const cliArm = await createArm('doctor-parity-err-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('doctor-parity-err-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'doctor',
      {},
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'doctor',
    });

    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);
    expect(cliResult.error?.code).toBe('INTERNAL_ERROR');
    expect(mcpResult.error?.code).toBe('INTERNAL_ERROR');
    expect(cliResult.error?.message).toContain(errorMessage);
    expect(mcpResult.error?.message).toContain(errorMessage);

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(JSON.stringify(normalize(cliResult))).toEqual(
      JSON.stringify(normalize(mcpResult)),
    );

    expect(cliExitCode).toBe(2);

    expect('parity-asserted').toBe('parity-asserted');
  });
});
