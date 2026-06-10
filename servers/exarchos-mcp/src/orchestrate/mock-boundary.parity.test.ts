/**
 * CLI↔MCP parity tests for the `check_mock_boundary` action (INV-2).
 *
 * `check_mock_boundary` has two user-visible facades:
 *   1. MCP — `exarchos_orchestrate { action: 'check_mock_boundary' }`.
 *   2. CLI — the auto-generated `exarchos orch check_mock_boundary` surface,
 *      emitted from the action's Zod schema in registry.ts.
 *
 * Both dispatch through the same composite, so for a given input they MUST
 * project byte-identical `ToolResult` payloads (modulo wall-clock fields).
 *
 * Strategy mirrors contract-drift.parity.test.ts: stub the composite so the
 * action forwards to the real `handleMockBoundary`, and mock the pure
 * `detectMockFindings` so the gate is deterministic and never shells out to git.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Mock the mock-boundary core so both arms compute the same deterministic result.
const mockDetectMockFindings = vi.fn();
vi.mock('./mock-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mock-boundary.js')>();
  return { ...actual, detectMockFindings: (...args: unknown[]) => mockDetectMockFindings(...args) };
});

import { EventStore } from '../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../core/dispatch.js';
import { stubCompositeHandler } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';

import { handleMockBoundary } from './mock-boundary-handler.js';

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
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
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

function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

describe('exarchos check_mock_boundary CLI↔MCP parity (INV-2)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rm(arm.stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    arms = [];
    vi.restoreAllMocks();
    mockDetectMockFindings.mockReset();
  });

  it('MockBoundary_CliVsMcp_IdenticalResultForSameInput', async () => {
    // ─── Clean path (no findings) ────────────────────────────────────────────
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

    // ─── Unowned-finding path ────────────────────────────────────────────────
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

    // An unowned finding is still a successful tool call (advisory carrier).
    expect(cliFinding.success).toBe(true);
    expect(mcpFinding.success).toBe(true);
    const cliFindingData = cliFinding.data as { findings: Array<{ mockedTarget: string }> };
    expect(cliFindingData.findings.some((f) => f.mockedTarget === 'axios')).toBe(true);

    expect(normalize(cliFinding)).toEqual(normalize(mcpFinding));
    expect(JSON.stringify(normalize(cliFinding))).toEqual(JSON.stringify(normalize(mcpFinding)));
  });
});
