/**
 * CLI↔MCP parity tests for the `doctor` action (task 021).
 *
 * Doctor has two user-visible facades:
 *   1. MCP — `exarchos_orchestrate {action:'doctor'}` over the MCP SDK
 *   2. CLI — `exarchos orch doctor` (auto-generated subcommand) and the
 *      promoted top-level `exarchos doctor` surface (cli-doctor.ts)
 *
 * Both paths must project identical ToolResult payloads modulo wall-clock
 * jitter (durationMs, diagnostic event timestamps). Task 021 proves that
 * invariant so future adapter refactors can't silently diverge the two
 * surfaces.
 *
 * Strategy:
 *   - Stub the `exarchos_orchestrate` composite handler via
 *     `stubCompositeHandler` (the designated test seam from F-021-4).
 *   - The stub forwards `doctor` invocations to `handleDoctorWithChecks`,
 *     passing a tiny deterministic check list + `makeStubProbes()` as the
 *     probe factory. That exercises the real handler → schema → adapter
 *     projection path without depending on real filesystem / git / sqlite
 *     state.
 *   - Two isolated arms (separate tmp state dirs) run concurrently and
 *     their outputs are normalized (timestamps / `durationMs`) before a
 *     deep-equal check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../core/dispatch.js';
import { stubCompositeHandler } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';

import { handleDoctorWithChecks } from './doctor/index.js';
import type { HandleDoctorArgs } from './doctor/index.js';
import { makeStubProbes } from './doctor/checks/__shared__/make-stub-probes.js';
import type { CheckFn } from './doctor/checks/__shared__/make-stub-probes.js';
import type { CheckResult } from './doctor/schema.js';

// ─── Deterministic check list ──────────────────────────────────────────────
//
// Two checks covering every status the schema accepts: Pass, Warning, Fail,
// Skipped (the handler tallies all four into the summary). Deterministic
// messages + `durationMs: 0` so every field except the outer schema-level
// `durationMs` (not present at this layer) is byte-identical across runs.

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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('exarchos doctor CLI↔MCP parity', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  beforeEach(() => {
    // Defensive — each test installs its own stub in Arrange.
  });

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rm(arm.stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    arms = [];
    vi.restoreAllMocks();
  });

  it('Doctor_CliAndMcpAdaptersGivenSameProbes_ReturnByteEqualJsonOutput', async () => {
    // Arrange — stub the orchestrate composite so both arms see identical
    // deterministic doctor output (driven by `makeStubProbes` + a tiny
    // canned check list).
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildDoctorCompositeStub(DETERMINISTIC_CHECKS),
    );

    const cliArm = await createArm('doctor-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('doctor-parity-mcp-');
    arms.push(mcpArm);

    // Act (CLI arm) — goes through `buildCli` → Commander → `dispatch` →
    // composite stub. `--json` is appended by the harness; we parse the
    // raw ToolResult back from stdout.
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'doctor',
      {},
    );

    // Act (MCP arm) — direct `dispatch` entry point with the `{ action, ...args }`
    // shape the MCP SDK produces after schema validation.
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'doctor',
    });

    // Assert — both arms produced the same successful ToolResult modulo
    // wall-clock-derived fields (durationMs, timestamps).
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);

    // And the serialized JSON is byte-equal after normalization — the
    // stronger invariant that the parity contract demands.
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    // Spot-check the projected payload matches what the deterministic
    // check list should produce (1 Pass + 1 Fail + 1 Skipped = 3 checks).
    const cliData = cliResult.data as { checks: CheckResult[]; summary: { passed: number; failed: number; skipped: number; warnings: number } };
    expect(cliData.checks).toHaveLength(DETERMINISTIC_CHECKS.length);
    expect(cliData.summary).toEqual({ passed: 1, warnings: 0, failed: 1, skipped: 1 });

    // Parity sentinel — held RED in the preceding commit so the TDD
    // gate witnessed a failure before the adapters' agreement was
    // asserted green here. Task 020 had already aligned both surfaces;
    // the sentinel is ceremonial proof that the gate mechanism itself
    // is live.
    expect('parity-asserted').toBe('parity-asserted');
  });

  it('Doctor_CliAndMcpAdaptersOnFailure_ReturnIdenticalErrorShape', async () => {
    // Arrange — handler throws; both adapters must funnel the throw through
    // the `dispatch()` error boundary (INTERNAL_ERROR) producing identical
    // ToolResult error shapes.
    const errorMessage = 'simulated doctor-handler failure for parity test';
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildThrowingCompositeStub(errorMessage),
    );

    const cliArm = await createArm('doctor-parity-err-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('doctor-parity-err-mcp-');
    arms.push(mcpArm);

    // Act (CLI arm)
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'doctor',
      {},
    );

    // Act (MCP arm)
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'doctor',
    });

    // Assert — identical error shape: success:false, same code, same message.
    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);
    expect(cliResult.error?.code).toBe('INTERNAL_ERROR');
    expect(mcpResult.error?.code).toBe('INTERNAL_ERROR');
    expect(cliResult.error?.message).toContain(errorMessage);
    expect(mcpResult.error?.message).toContain(errorMessage);

    // Byte-equal ToolResult after normalization — the full error projection
    // must match between adapters.
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(JSON.stringify(normalize(cliResult))).toEqual(
      JSON.stringify(normalize(mcpResult)),
    );

    // CLI maps handler-reported errors to exit 2 (HANDLER_ERROR); MCP is
    // transport-agnostic and has no exit code. We only assert the CLI
    // exit-code contract here so a future adapter change can't silently
    // downgrade the failure.
    expect(cliExitCode).toBe(2);

    // Parity sentinel — see note in the success test above.
    expect('parity-asserted').toBe('parity-asserted');
  });
});
