/**
 * Tests for the top-level `exarchos init` CLI surface.
 *
 * Task 011 swap (design line 322: "init action → onboard action"): the `init`
 * action was removed from the registry and the `init` CLI verb is now a
 * one-release DR-5 **rename stub**. It prints `renamed → use 'exarchos onboard'`
 * and exits non-zero (HANDLER_ERROR=2, NOT "command not found"), runs NO
 * onboarding side effect, and dispatches nothing. The init handler
 * (`handleInitWithWriters`) + `init.executed` event were fully removed in DR-5
 * (task 018) — `onboard` reproduces init's outputs via the GENERATE writers.
 *
 * These tests drive the CLI programmatically (buildCli + parseAsync) rather than
 * spawning a subprocess, mirroring the pattern in cli-doctor.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../dispatch/core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: {} }),
  ),
}));

// PR-B (#1368): `emitResult`'s `--json` route resolves `toCliResult`
// from this module; vi.mock factories REPLACE the module, so omitting
// the export crashes the action callback. Provide a real-passthrough
// impl that mirrors the production `toCliResult(env, 'json')` behavior
// so stdout assertions still see envelope JSON.
vi.mock('./cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
  toCliResult: vi.fn((env: unknown, format: string) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    }
  }),
}));

// ─── Test Imports ───────────────────────────────────────────────────────────

import { buildCli, CLI_EXIT_CODES } from './cli.js';
import { dispatch } from '../dispatch/core/dispatch.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/init-cli-test',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

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

    // No onboarding side effect runs from the stub (DR-5 acceptance criterion).
    expect(dispatch).not.toHaveBeenCalled();
    // Non-zero, not "command not found".
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

  it('CliInit_LegacyRuntimeFlag_StillStubsAndDoesNotDispatch', async () => {
    // The legacy `--runtime <id>` flag is accepted (allowUnknownOption /
    // allowExcessArguments) but ignored — there is no init action to route to.
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
