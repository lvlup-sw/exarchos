/**
 * Tests for the top-level `exarchos merge-orchestrate` verb.
 *
 * The verb is top-level, like `doctor`, so an operator types `exarchos merge-orchestrate`.
 * The CLI and the MCP action share one Zod schema, and `schema-to-flags` maps the kebab-case flags
 * to the camelCase fields.
 *
 * The tests drive `buildCli` and `parseAsync` in-process, with `dispatch` and `cli-format` mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';

vi.mock('../../../../src/dispatch/core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: { phase: 'completed' } }),
  ),
}));

vi.mock('../../../../src/adapters/cli/cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
}));

import { buildCli, CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { expectedTrustedContext } from '../../../../tools/test-helpers/trusted-context.js';

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

  /** The CLI passes the flags as camelCase arguments to `exarchos_orchestrate` with `action: 'merge_orchestrate'`. */
  it('cliMergeOrchestrate_ValidArgs_CallsHandleMergeOrchestrate', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce(makeSuccessResult());
    const program = buildCli(ctx);

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
      'squash',
    ]);

    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({
        action: 'merge_orchestrate',
        featureId: 'foo',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
      }),
      expectedTrustedContext(ctx),
    );
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });

  /** A `PREFLIGHT_FAILED` result maps to HANDLER_ERROR (2), not to INVALID_INPUT (1). */
  it('cliMergeOrchestrate_PreflightFails_ExitCode2', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce({
      success: false,
      error: {
        code: 'PREFLIGHT_FAILED',
        message: 'merge preflight did not pass',
      },
    });
    const program = buildCli(ctx);

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
      'squash',
    ]);

    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);
  });

  /** `strategy` is required and has no default. Without `--strategy`, the CLI rejects the input before dispatch. */
  it('cliMergeOrchestrate_MissingStrategy_ExitCode1', async () => {
    const program = buildCli(ctx);

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

    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
  });

  /** The Zod enum rejects `--strategy bogus` in the CLI, before dispatch. */
  it('cliMergeOrchestrate_InvalidStrategy_ExitCode1', async () => {
    const program = buildCli(ctx);

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

    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.INVALID_INPUT);
  });

  it('cliMergeOrchestrate_DryRunFlag_PassesDryRunTrueToHandler', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce(makeSuccessResult());
    const program = buildCli(ctx);

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
      'squash',
      '--dry-run',
    ]);

    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({
        action: 'merge_orchestrate',
        featureId: 'foo',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        dryRun: true,
      }),
      expectedTrustedContext(ctx),
    );
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });
});
