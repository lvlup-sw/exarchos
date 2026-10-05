/**
 * These tests check CLI and MCP parity for `check_mock_boundary`. The MCP call
 * and the generated `exarchos orch check_mock_boundary` command dispatch
 * through the same composite. For one input, they must return the same
 * `ToolResult`, except for wall-clock fields.
 *
 * The composite stub forwards the action to the real `handleMockBoundary`. A
 * mock of `detectMockFindings` keeps the gate deterministic and away from git.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Both arms read this mock, so they compute the same result. */
const mockDetectMockFindings = vi.fn();
vi.mock('../../../../src/verbs/gates/mock-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/mock-boundary.js')>();
  return { ...actual, detectMockFindings: (...args: unknown[]) => mockDetectMockFindings(...args) };
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

import { handleMockBoundary } from '../../../../src/verbs/gates/mock-boundary-handler.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';

const PARITY_REPO_ROOT = '/fake/agent/worktree';

const PARITY_ARGS = {
  featureId: 'feat-mock-boundary-parity',
  taskId: 'T-parity',
  branch: 'feature/parity',
  baseBranch: 'main',
  repoRoot: PARITY_REPO_ROOT,
} as const;

function makeCleanFindings() {
  return [];
}

function makeUnownedFindings() {
  return [
    { file: 'src/http.test.ts', line: 2, identifier: 'mock', mockedTarget: 'axios', unowned: true },
  ];
}

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  await seedActivePhaseAttempt(eventStore, 'feat-mock-boundary-parity');
  const ctx: DispatchContext = withTrustedCaller({ stateDir, eventStore, enableTelemetry: false });
  return { stateDir, ctx };
}

function buildMockBoundaryCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'check_mock_boundary') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `mock-boundary parity stub only handles "check_mock_boundary", got "${String(action)}"`,
        },
      };
    }
    return handleMockBoundary(
      rest as Parameters<typeof handleMockBoundary>[0],
      ctx.stateDir,
      ctx.eventStore,
    );
  };
}

/**
 * Drops `_perf`, `_meta` and `evidenceReferences`. Each arm has its own event
 * store, so the gate runner mints a different evidence id in each. The gate
 * integration suites test evidence persistence.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta', 'evidenceReferences']),
  });
}

describe('exarchos check_mock_boundary CLI↔MCP parity (INV-2)', () => {
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
    mockDetectMockFindings.mockReset();
  });

  /**
   * Runs a clean path, then a path with an unowned finding. An unowned finding
   * is advisory, so the tool call still succeeds.
   */
  it('MockBoundary_CliVsMcp_IdenticalResultForSameInput', async () => {
    mockDetectMockFindings.mockReturnValue(makeCleanFindings());
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildMockBoundaryCompositeStub(),
    );

    const cliArm = await createArm('mock-boundary-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('mock-boundary-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'check_mock_boundary',
      PARITY_ARGS,
    );
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'check_mock_boundary',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliData = cliResult.data as { passed: boolean; findings: unknown[] };
    expect(cliData.passed).toBe(true);
    expect(cliData.findings).toEqual([]);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    mockDetectMockFindings.mockReturnValue(makeUnownedFindings());

    const cliFailArm = await createArm('mock-boundary-parity-cli-finding-');
    arms.push(cliFailArm);
    const mcpFailArm = await createArm('mock-boundary-parity-mcp-finding-');
    arms.push(mcpFailArm);

    const { result: cliFinding } = await harnessCallCli(
      cliFailArm.ctx,
      'orch',
      'check_mock_boundary',
      PARITY_ARGS,
    );
    const mcpFinding = await harnessCallMcp(mcpFailArm.ctx, 'exarchos_orchestrate', {
      action: 'check_mock_boundary',
      ...PARITY_ARGS,
    });

    expect(cliFinding.success).toBe(true);
    expect(mcpFinding.success).toBe(true);
    const cliFindingData = cliFinding.data as { findings: Array<{ mockedTarget: string }> };
    expect(cliFindingData.findings.some((f) => f.mockedTarget === 'axios')).toBe(true);

    expect(normalize(cliFinding)).toEqual(normalize(mcpFinding));
    expect(JSON.stringify(normalize(cliFinding))).toEqual(JSON.stringify(normalize(mcpFinding)));
  });
});
