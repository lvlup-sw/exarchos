/**
 * Tests for the top-level `exarchos init` verb, a rename stub.
 *
 * The stub prints `renamed → use 'exarchos onboard'` and exits with HANDLER_ERROR (2), not with
 * "command not found". It dispatches nothing and runs no onboarding side effect.
 *
 * The tests drive `buildCli` and `parseAsync` in-process, with `dispatch` and `cli-format` mocked.
 * A `vi.mock` factory replaces the whole module, so the `cli-format` mock also supplies `toCliResult`.
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

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/init-cli-test',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

describe('exarchos init CLI (DR-5 rename stub)', () => {
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

  it('CliInit_NoArgs_DoesNotDispatch_AndExitsNonZero', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });

  it('CliInit_PrintsRenameMessage_PointingAtOnboard', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init']);

    const written = stderrSpy.mock.calls.map(([s]) => String(s)).join('');
    expect(written).toMatch(/renamed/i);
    expect(written).toContain('exarchos onboard');

    stderrSpy.mockRestore();
  });

  /** The stub accepts the legacy `--runtime <id>` flag and ignores it. */
  it('CliInit_LegacyRuntimeFlag_StillStubsAndDoesNotDispatch', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init', '--runtime', 'copilot']);

    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });

  it('CliInit_LegacyNonInteractiveFlag_StillStubs', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init', '--non-interactive']);

    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });

  it('CliInit_LegacyJsonFlag_StillStubs_NoDispatch', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'init', '--json']);

    expect(dispatch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });
});
