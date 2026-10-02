/**
 * CLI and MCP parity tests for the `check_test_adequacy` action.
 *
 * The MCP facade is `exarchos_orchestrate { action: 'check_test_adequacy' }`.
 * The CLI facade is `exarchos orch check_test_adequacy`, generated from the Zod schema of the action.
 * Both dispatch through the same composite, so one input must give byte-identical `ToolResult` payloads, except wall-clock fields.
 *
 * The composite stub forwards to the real `handleTestAdequacy`.
 * A mock of `runProbe` makes the gate deterministic, so the test never runs git or a test command.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Both arms get the same deterministic probe result. */
const mockRunProbe = vi.fn();
vi.mock('../../../../src/verbs/gates/test-adequacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/test-adequacy.js')>();
  return { ...actual, runProbe: (...args: unknown[]) => mockRunProbe(...args) };
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

import { handleTestAdequacy } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';

const PARITY_REPO_ROOT = '/fake/agent/worktree';

const PARITY_ARGS = {
  featureId: 'feat-test-adequacy-parity',
  taskId: 'T-parity',
  branch: 'feature/parity',
  repoRoot: PARITY_REPO_ROOT,
  baseBranch: 'main',
} as const;

function makePassResult() {
  return {
    passed: true,
    probedTests: ['src/calc.test.ts'],
    redObserved: true,
    restoredClean: true,
  };
}

function makeFailResult() {
  return {
    passed: false,
    probedTests: ['src/calc.test.ts'],
    redObserved: false,
    restoredClean: true,
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
  await seedActivePhaseAttempt(eventStore, 'feat-test-adequacy-parity');
  const ctx: DispatchContext = withTrustedCaller({ stateDir, eventStore, enableTelemetry: false });
  return { stateDir, ctx };
}

function buildTestAdequacyCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'check_test_adequacy') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `test-adequacy parity stub only handles "check_test_adequacy", got "${String(action)}"`,
        },
      };
    }
    return handleTestAdequacy(
      rest as Parameters<typeof handleTestAdequacy>[0],
      ctx.stateDir,
      ctx.eventStore,
    );
  };
}

/**
 * Drops `evidenceReferences`. Each arm has its own event store, so the content-addressed evidence id differs.
 * The gate integration suites prove evidence persistence.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta', 'evidenceReferences']),
  });
}

describe('exarchos check_test_adequacy CLI↔MCP parity (INV-2)', () => {
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
    mockRunProbe.mockReset();
  });

  /** The test covers a pass path and a fail path. A failing probe is still a successful tool call. */
  it('TestAdequacy_CliVsMcp_IdenticalResultForSameInput', async () => {
    mockRunProbe.mockResolvedValue(makePassResult());
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildTestAdequacyCompositeStub(),
    );

    const cliArm = await createArm('test-adequacy-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('test-adequacy-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'check_test_adequacy',
      PARITY_ARGS,
    );
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'check_test_adequacy',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliData = cliResult.data as { passed: boolean; redObserved: boolean };
    expect(cliData.passed).toBe(true);
    expect(cliData.redObserved).toBe(true);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    mockRunProbe.mockResolvedValue(makeFailResult());

    const cliFailArm = await createArm('test-adequacy-parity-cli-fail-');
    arms.push(cliFailArm);
    const mcpFailArm = await createArm('test-adequacy-parity-mcp-fail-');
    arms.push(mcpFailArm);

    const { result: cliFail } = await harnessCallCli(
      cliFailArm.ctx,
      'orch',
      'check_test_adequacy',
      PARITY_ARGS,
    );
    const mcpFail = await harnessCallMcp(mcpFailArm.ctx, 'exarchos_orchestrate', {
      action: 'check_test_adequacy',
      ...PARITY_ARGS,
    });

    expect(cliFail.success).toBe(true);
    expect(mcpFail.success).toBe(true);
    const cliFailData = cliFail.data as { passed: boolean; redObserved: boolean };
    expect(cliFailData.passed).toBe(false);
    expect(cliFailData.redObserved).toBe(false);

    expect(normalize(cliFail)).toEqual(normalize(mcpFail));
    expect(JSON.stringify(normalize(cliFail))).toEqual(JSON.stringify(normalize(mcpFail)));
  });
});
