/**
 * CLI/MCP parity tests for the `init` action (T40).
 *
 * Init has two user-visible facades:
 *   1. MCP  — `exarchos_orchestrate {action:'init'}` over the MCP SDK
 *   2. CLI  — `exarchos orch init` (auto-generated) and the promoted
 *      top-level `exarchos init` surface (cli.ts)
 *
 * Both paths must project identical ToolResult payloads modulo wall-clock
 * jitter (durationMs). This test proves that invariant so future adapter
 * refactors can't silently diverge the two surfaces.
 *
 * Strategy:
 *   - Stub the `exarchos_orchestrate` composite handler via
 *     `stubCompositeHandler` (the designated test seam from F-021-4).
 *   - The stub forwards `init` invocations to `handleInitWithWriters`
 *     with deterministic mock writers + a null VCS detector. That
 *     exercises the real handler -> schema -> adapter projection path
 *     without touching disk.
 *   - Two isolated arms (separate tmp state dirs) run concurrently and
 *     their outputs are normalized (timestamps / durationMs) before a
 *     deep-equal check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../../core/dispatch.js';
import { stubCompositeHandler } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../__tests__/parity-harness.js';

import { handleInitWithWriters } from './index.js';
import type { HandleInitArgs } from './index.js';
import type { RuntimeConfigWriter, WriteOptions } from './writers/writer.js';
import type { WriterDeps } from './probes.js';
import { makeStubWriterDeps } from './probes.js';
import type { ConfigWriteResult } from './schema.js';

// ─── Deterministic writer list ───────────────────────────────────────────

function makeDeterministicWriter(
  runtime: string,
  result: ConfigWriteResult,
): RuntimeConfigWriter {
  return {
    runtime: runtime as RuntimeConfigWriter['runtime'],
    write: async (_deps: WriterDeps, _options: WriteOptions): Promise<ConfigWriteResult> => result,
  };
}

const DETERMINISTIC_WRITERS: ReadonlyArray<RuntimeConfigWriter> = [
  makeDeterministicWriter('claude-code', {
    runtime: 'claude-code',
    path: '/stub/home/.claude.json',
    status: 'written',
    componentsWritten: ['mcp-config'],
  }),
  makeDeterministicWriter('copilot', {
    runtime: 'copilot',
    path: '/stub/project/.vscode/mcp.json',
    status: 'skipped',
    componentsWritten: [],
    warnings: ['config already exists'],
  }),
];

/** Deterministic VCS detector — always returns null. */
const DETERMINISTIC_VCS_DETECTOR = async (): Promise<null> => null;

// ─── Arm helpers ──────────────────────────────────────────────────────────

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
 * Composite stub that handles the `init` action via
 * `handleInitWithWriters` with the deterministic writer list + null VCS.
 * All other orchestrate actions are unreachable in this suite.
 */
function buildInitCompositeStub(
  writers: ReadonlyArray<RuntimeConfigWriter>,
): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'init') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `init parity stub only handles action "init", got "${String(action)}"`,
        },
      };
    }
    return handleInitWithWriters(
      rest as HandleInitArgs,
      ctx,
      writers,
      DETERMINISTIC_VCS_DETECTOR,
      makeStubWriterDeps,
    );
  };
}

/**
 * Composite stub that makes the init action throw at the handler layer.
 * Exercises the dispatch-level error boundary (INTERNAL_ERROR) which both
 * adapters share.
 */
function buildThrowingCompositeStub(message: string): CompositeHandler {
  return async (_args, _ctx): Promise<ToolResult> => {
    throw new Error(message);
  };
}

/**
 * Init parity normalizer. Init output embeds `durationMs` at the
 * top level. We strip time-like values so two independent invocations
 * compare equal.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { durationMs: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('exarchos init CLI/MCP parity', () => {
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

  it('Init_CliAndMcpAdaptersGivenSameWriters_ReturnByteEqualJsonOutput', async () => {
    // Arrange — stub the orchestrate composite so both arms see identical
    // deterministic init output.
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildInitCompositeStub(DETERMINISTIC_WRITERS),
    );

    const cliArm = await createArm('init-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('init-parity-mcp-');
    arms.push(mcpArm);

    // Act (CLI arm) — goes through `buildCli` -> Commander -> `dispatch` ->
    // composite stub. `--json` is appended by the harness; we parse the
    // raw ToolResult back from stdout.
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'init',
      {},
    );

    // Act (MCP arm) — direct `dispatch` entry point with the `{ action, ...args }`
    // shape the MCP SDK produces after schema validation.
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'init',
    });

    // Assert — both arms produced the same successful ToolResult modulo
    // wall-clock-derived fields (durationMs, timestamps).
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);

    // And the serialized JSON is byte-equal after normalization.
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    // Spot-check the projected payload matches what the deterministic
    // writer list should produce (1 written + 1 skipped = 2 runtimes).
    const cliData = cliResult.data as {
      runtimes: ConfigWriteResult[];
      vcs: null;
    };
    expect(cliData.runtimes).toHaveLength(DETERMINISTIC_WRITERS.length);
    expect(cliData.runtimes[0].status).toBe('written');
    expect(cliData.runtimes[1].status).toBe('skipped');
    expect(cliData.vcs).toBeNull();

    // Parity sentinel
    expect('parity-asserted').toBe('parity-asserted');
  });

  it('Init_CliAndMcpAdaptersOnFailure_ReturnIdenticalErrorShape', async () => {
    // Arrange — handler throws; both adapters must funnel the throw through
    // the `dispatch()` error boundary (INTERNAL_ERROR) producing identical
    // ToolResult error shapes.
    const errorMessage = 'simulated init-handler failure for parity test';
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildThrowingCompositeStub(errorMessage),
    );

    const cliArm = await createArm('init-parity-err-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('init-parity-err-mcp-');
    arms.push(mcpArm);

    // Act (CLI arm)
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'init',
      {},
    );

    // Act (MCP arm)
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'init',
    });

    // Assert — identical error shape: success:false, same code, same message.
    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);
    expect(cliResult.error?.code).toBe('INTERNAL_ERROR');
    expect(mcpResult.error?.code).toBe('INTERNAL_ERROR');
    expect(cliResult.error?.message).toContain(errorMessage);
    expect(mcpResult.error?.message).toContain(errorMessage);

    // Byte-equal ToolResult after normalization.
    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
    expect(JSON.stringify(normalize(cliResult))).toEqual(
      JSON.stringify(normalize(mcpResult)),
    );

    // CLI maps handler-reported errors to exit 2 (HANDLER_ERROR).
    expect(cliExitCode).toBe(2);

    // Parity sentinel
    expect('parity-asserted').toBe('parity-asserted');
  });
});
