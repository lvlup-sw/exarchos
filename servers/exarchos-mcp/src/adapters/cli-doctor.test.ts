/**
 * Tests for the top-level `exarchos doctor` CLI surface. Doctor is
 * special-cased on top of the auto-generated subcommand tree so an
 * operator types `exarchos doctor` rather than `exarchos orch doctor`.
 *
 * These tests drive the CLI programmatically (buildCli + parseAsync)
 * rather than spawning a subprocess, mirroring the pattern in
 * cli.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: {} }),
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
    stateDir: '/tmp/doctor-cli-test',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

function makeDoctorResult(overrides?: {
  failed?: number;
  warnings?: number;
  passed?: number;
  skipped?: number;
}): ToolResult {
  const summary = {
    passed: overrides?.passed ?? 10,
    warnings: overrides?.warnings ?? 0,
    failed: overrides?.failed ?? 0,
    skipped: overrides?.skipped ?? 0,
  };
  const statuses = [
    ...Array(summary.passed).fill('Pass' as const),
    ...Array(summary.warnings).fill('Warning' as const),
    ...Array(summary.failed).fill('Fail' as const),
    ...Array(summary.skipped).fill('Skipped' as const),
  ];
  const checks = statuses.map((status, i) => ({
    category: 'runtime' as const,
    name: `check-${i}`,
    status,
    message: 'ok',
    ...(status === 'Warning' || status === 'Fail' ? { fix: 'fixture fix' } : {}),
    ...(status === 'Skipped' ? { reason: 'fixture skip' } : {}),
    durationMs: 0,
  }));
  return { success: true, data: { checks, summary } };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('exarchos doctor CLI', () => {
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

  it('Cli_DoctorNoFailures_ExitsZeroWithTableOutput', async () => {
    // Arrange: 10 passes, no failures.
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 10 }));
    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'doctor']);

    // Assert
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'doctor' }),
      ctx,
    );
  });

  it('Cli_DoctorAnyFail_ExitsTwo', async () => {
    // Arrange: 9 pass, 1 fail.
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 9, failed: 1 }));
    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'doctor']);

    // Assert
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);
  });

  it('Cli_DoctorWarningsOnly_ExitsZero', async () => {
    // Arrange: warnings do NOT fail the overall run.
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 7, warnings: 3 }));
    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'doctor']);

    // Assert
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });

  it('Cli_DoctorDispatchThrows_ExitsThreeWithNormalizedToolResult', async () => {
    // Arrange: simulate an unexpected exception surfacing out of dispatch
    // (e.g. a broken probe throws synchronously, or an unhandled reject
    // escapes from a check).
    vi.mocked(dispatch).mockRejectedValueOnce(new Error('catastrophic probe failure'));
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'doctor', '--json']);

    // Assert — exit 3 and a normalized ToolResult on stdout carrying
    // code: 'UNCAUGHT_EXCEPTION' with the original error message.
    expect(process.exitCode).toBe(CLI_EXIT_CODES.UNCAUGHT_EXCEPTION);

    const writes = stdoutSpy.mock.calls.map(([s]) => s as string).join('');
    stdoutSpy.mockRestore();
    const parsed = JSON.parse(writes.trim()) as ToolResult;
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe('UNCAUGHT_EXCEPTION');
    expect(parsed.error?.message).toContain('catastrophic probe failure');
  });

  it('Cli_DoctorFormatJson_EmitsSingleLineJsonToStdout', async () => {
    // Arrange: --json should produce a single parseable JSON line.
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 10 }));
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'doctor', '--json']);

    // Assert
    const writes = stdoutSpy.mock.calls.map(([s]) => s as string).join('');
    stdoutSpy.mockRestore();

    // Output should be exactly one line of JSON (trailing newline).
    const trimmed = writes.trim();
    const lines = trimmed.split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as ToolResult;
    expect(parsed.success).toBe(true);
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });
});
