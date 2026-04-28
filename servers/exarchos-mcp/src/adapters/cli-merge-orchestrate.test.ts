/**
 * Tests for the top-level `exarchos merge-orchestrate` CLI surface (T21).
 *
 * Per design DR-MO-1, `merge-orchestrate` is promoted to a top-level verb
 * (like `doctor` and `init`) so an operator types
 * `exarchos merge-orchestrate ...` rather than
 * `exarchos orch merge-orchestrate ...`.
 *
 * The Zod arg schema (HandleMergeOrchestrateArgsSchema) is shared with the
 * MCP action registration (T20) so CLI flags and MCP args stay in lock-step
 * — kebab-case CLI flags translate back to camelCase fields automatically
 * via schema-to-flags.
 *
 * These tests drive the CLI programmatically (buildCli + parseAsync)
 * rather than spawning a subprocess, mirroring cli-init.test.ts and
 * cli-doctor.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: { phase: 'completed' } }),
  ),
}));

vi.mock('./cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
}));

// ─── Test Imports ───────────────────────────────────────────────────────────

import { buildCli, CLI_EXIT_CODES } from './cli.js';
import { dispatch } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/merge-orchestrate-cli-test',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

function makeSuccessResult(): ToolResult {
  return {
    success: true,
    data: {
      phase: 'completed',
      mergeSha: 'abc1234',
      rollbackSha: 'def5678',
      preflight: { passed: true },
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('exarchos merge-orchestrate CLI', () => {
  let ctx: DispatchContext;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createTestContext();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('cliMergeOrchestrate_ValidArgs_CallsHandleMergeOrchestrate', async () => {
    // Arrange: handler returns success.
    vi.mocked(dispatch).mockResolvedValueOnce(makeSuccessResult());
    const program = buildCli(ctx);

    // Act
    await program.parseAsync([
      'node',
      'exarchos',
      'merge-orchestrate',
      '--feature-id',
      'foo',
      '--source-branch',
      'feat/x',
      '--target-branch',
      'main',
    ]);

    // Assert: dispatch was called with translated camelCase args via the
    // exarchos_orchestrate composite + action: 'merge_orchestrate'.
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({
        action: 'merge_orchestrate',
        featureId: 'foo',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
      }),
      ctx,
    );
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });

  it('cliMergeOrchestrate_PreflightFails_ExitCode2', async () => {
    // Arrange: handler returns PREFLIGHT_FAILED — should map to HANDLER_ERROR.
    vi.mocked(dispatch).mockResolvedValueOnce({
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: 'merge preflight did not pass',
      },
    });
    const program = buildCli(ctx);

    // Act
    await program.parseAsync([
      'node',
      'exarchos',
      'merge-orchestrate',
      '--feature-id',
      'foo',
      '--source-branch',
      'feat/x',
      '--target-branch',
      'main',
    ]);

    // Assert: exit 2 (HANDLER_ERROR), not exit 1 (INVALID_INPUT).
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);
  });

  it('cliMergeOrchestrate_InvalidStrategy_ExitCode1', async () => {
    // Arrange: --strategy bogus is rejected by the Zod enum at the CLI layer
    // BEFORE dispatch is invoked.
    const program = buildCli(ctx);

    // Act
    await program.parseAsync([
      'node',
      'exarchos',
      'merge-orchestrate',
      '--feature-id',
      'foo',
      '--source-branch',
      'feat/x',
      '--target-branch',
      'main',
      '--strategy',
      'bogus',
    ]);

    // Assert: dispatch was never called and exit 1 is set.
    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
  });

  it('cliMergeOrchestrate_DryRunFlag_PassesDryRunTrueToHandler', async () => {
    // Arrange: success path; we only care that dryRun: true reaches dispatch.
    vi.mocked(dispatch).mockResolvedValueOnce(makeSuccessResult());
    const program = buildCli(ctx);

    // Act
    await program.parseAsync([
      'node',
      'exarchos',
      'merge-orchestrate',
      '--feature-id',
      'foo',
      '--source-branch',
      'feat/x',
      '--target-branch',
      'main',
      '--dry-run',
    ]);

    // Assert
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({
        action: 'merge_orchestrate',
        featureId: 'foo',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        dryRun: true,
      }),
      ctx,
    );
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });
});
