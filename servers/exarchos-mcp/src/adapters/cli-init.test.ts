/**
 * Tests for the top-level `exarchos init` CLI surface. Init is
 * promoted to a top-level verb (like doctor) so an operator types
 * `exarchos init` rather than `exarchos orch init`.
 *
 * These tests drive the CLI programmatically (buildCli + parseAsync)
 * rather than spawning a subprocess, mirroring the pattern in
 * cli-doctor.test.ts.
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
    stateDir: '/tmp/init-cli-test',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

function makeInitResult(overrides?: {
  runtimes?: Array<{ runtime: string; status: string; path: string; componentsWritten: string[]; error?: string }>;
  vcs?: { provider: string; remoteUrl: string; cliAvailable: boolean } | null;
}): ToolResult {
  const runtimes = overrides?.runtimes ?? [
    { runtime: 'claude-code', status: 'written', path: '/home/.claude.json', componentsWritten: ['mcp-config'] },
  ];
  const vcs = overrides?.vcs !== undefined ? overrides.vcs : null;
  return {
    success: true,
    data: {
      runtimes,
      vcs,
      durationMs: 42,
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('exarchos init CLI', () => {
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

  it('CliInit_NoArgs_DispatchesInitAction', async () => {
    // Arrange: default init — no flags
    vi.mocked(dispatch).mockResolvedValueOnce(makeInitResult());
    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init']);

    // Assert
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'init' }),
      ctx,
    );
  });

  it('CliInit_RuntimeFlag_PassesRuntime', async () => {
    // Arrange: --runtime copilot
    vi.mocked(dispatch).mockResolvedValueOnce(makeInitResult());
    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init', '--runtime', 'copilot']);

    // Assert
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'init', runtime: 'copilot' }),
      ctx,
    );
  });

  it('CliInit_NonInteractive_PassesFlag', async () => {
    // Arrange: --non-interactive
    vi.mocked(dispatch).mockResolvedValueOnce(makeInitResult());
    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init', '--non-interactive']);

    // Assert
    expect(dispatch).toHaveBeenCalledWith(
      'exarchos_orchestrate',
      expect.objectContaining({ action: 'init', nonInteractive: true }),
      ctx,
    );
  });

  it('CliInit_FormatJson_PassesFormat', async () => {
    // Arrange: --format json via --json flag
    vi.mocked(dispatch).mockResolvedValueOnce(makeInitResult());
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init', '--json']);

    // Assert: JSON output on stdout
    const writes = stdoutSpy.mock.calls.map(([s]) => s as string).join('');
    stdoutSpy.mockRestore();
    const trimmed = writes.trim();
    expect(trimmed).not.toBe('');
    const parsed = JSON.parse(trimmed) as ToolResult;
    expect(parsed.success).toBe(true);
    expect(process.exitCode ?? 0).toBe(CLI_EXIT_CODES.SUCCESS);
  });

  it('CliInit_AllWritesFailed_ExitsWithHandlerError', async () => {
    // Arrange: all runtimes report failed status
    const failedResult = makeInitResult({
      runtimes: [
        { runtime: 'claude-code', status: 'failed', path: '/home/.claude.json', componentsWritten: [], error: 'permission denied' },
      ],
    });
    vi.mocked(dispatch).mockResolvedValueOnce(failedResult);
    const program = buildCli(ctx);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init']);

    // Assert: exit 2 for handler error (any failed writer)
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);
  });

  it('CliInit_DispatchThrows_ExitsThree', async () => {
    // Arrange: dispatch throws an exception
    vi.mocked(dispatch).mockRejectedValueOnce(new Error('unexpected failure'));
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // Act
    await program.parseAsync(['node', 'exarchos', 'init', '--json']);

    // Assert
    expect(process.exitCode).toBe(CLI_EXIT_CODES.UNCAUGHT_EXCEPTION);
    const writes = stdoutSpy.mock.calls.map(([s]) => s as string).join('');
    stdoutSpy.mockRestore();
    const parsed = JSON.parse(writes.trim()) as ToolResult;
    expect(parsed.success).toBe(false);
    expect(parsed.error?.code).toBe('UNCAUGHT_EXCEPTION');
  });
});
