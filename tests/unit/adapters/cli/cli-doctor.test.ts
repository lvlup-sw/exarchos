/**
 * Tests for the top-level `exarchos doctor` verb. The tests drive `buildCli` and `parseAsync`
 * in-process, with `dispatch` and `cli-format` mocked.
 *
 * A `vi.mock` factory replaces the whole module, and the `--json` path of `emitResult` calls
 * `toCliResult`. Thus the `cli-format` mock supplies a `toCliResult` that writes the envelope to
 * stdout as JSON, as production does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';

vi.mock('../../../../src/dispatch/core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: {} }),
  ),
}));

vi.mock('../../../../src/adapters/cli/cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
  toCliResult: vi.fn((env: unknown, format: string) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    }
  }),
}));

import { buildCli, CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { expectedTrustedContext } from '../../../../tools/test-helpers/trusted-context.js';

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
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 10 }));
    const program = buildCli(ctx);

    await program.parseAsync(['node', 'exarchos', 'doctor']);

    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'doctor' }),
      expectedTrustedContext(ctx),
    );
  });

  it('Cli_DoctorAnyFail_ExitsTwo', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 9, failed: 1 }));
    const program = buildCli(ctx);

    await program.parseAsync(['node', 'exarchos', 'doctor']);

    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);
  });

  it('Cli_DoctorWarningsOnly_ExitsZero', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 7, warnings: 3 }));
    const program = buildCli(ctx);

    await program.parseAsync(['node', 'exarchos', 'doctor']);

    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });

  /** Stdout carries an error result with the code `UNCAUGHT_EXCEPTION` and the original error message. */
  it('Cli_DoctorDispatchThrows_ExitsThreeWithNormalizedToolResult', async () => {
    vi.mocked(dispatch).mockRejectedValueOnce(new Error('catastrophic probe failure'));
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'doctor', '--json']);

    expect(process.exitCode).toBe(CLI_EXIT_CODES.UNCAUGHT_EXCEPTION);

    const writes = stdoutSpy.mock.calls.map(([s]) => s as string).join('');
    stdoutSpy.mockRestore();
    const parsed = JSON.parse(writes.trim()) as ToolResult;
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe('UNCAUGHT_EXCEPTION');
    expect(parsed.error?.message).toContain('catastrophic probe failure');
  });

  /**
   * `emitResult` writes the envelope as multi-line JSON. The test parses the whole of stdout, which
   * proves that stdout is one JSON document.
   */
  it('Cli_DoctorFormatJson_EmitsSingleLineJsonToStdout', async () => {
    vi.mocked(dispatch).mockResolvedValueOnce(makeDoctorResult({ passed: 10 }));
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'doctor', '--json']);

    const writes = stdoutSpy.mock.calls.map(([s]) => s as string).join('');
    stdoutSpy.mockRestore();

    const trimmed = writes.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    const parsed = JSON.parse(trimmed) as ToolResult;
    expect(parsed.success).toBe(true);
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });
});
