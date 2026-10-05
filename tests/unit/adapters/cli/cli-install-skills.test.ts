/**
 * Tests for the top-level `exarchos install-skills` verb, a rename stub like `init`.
 *
 * The stub prints `renamed → use 'exarchos onboard'` and exits with HANDLER_ERROR (2), not with
 * "command not found". It runs no install side effect, because `onboard` runs the install step.
 *
 * The tests drive `buildCli` and `parseAsync` in-process. A recorder mock replaces the
 * install-skills bridge, so each test can assert that the stub never calls the bridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lifecycle/install-skills-bridge.js', () => ({
  runInstallSkills: vi.fn(async () => {}),
}));

import { buildCli, CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/install-skills-cli-test',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

describe('exarchos install-skills CLI (DR-5 rename stub)', () => {
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

  it('CliInstallSkills_NoArgs_DoesNotInstall_AndExitsNonZero', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'install-skills']);

    const { runInstallSkills } = await import(
      '../../../../src/lifecycle/install-skills-bridge.js'
    );
    expect(runInstallSkills).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });

  it('CliInstallSkills_PrintsRenameMessage_PointingAtOnboard', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync(['node', 'exarchos', 'install-skills']);

    const written = stderrSpy.mock.calls.map(([s]) => String(s)).join('');
    expect(written).toMatch(/renamed/i);
    expect(written).toContain('exarchos onboard');

    stderrSpy.mockRestore();
  });

  /** The stub accepts the legacy `--agent <id>` flag and ignores it. */
  it('CliInstallSkills_LegacyAgentFlag_StillStubs_NoInstall', async () => {
    const program = buildCli(ctx);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync([
      'node',
      'exarchos',
      'install-skills',
      '--agent',
      'claude',
    ]);

    const { runInstallSkills } = await import(
      '../../../../src/lifecycle/install-skills-bridge.js'
    );
    expect(runInstallSkills).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(CLI_EXIT_CODES.HANDLER_ERROR);

    stderrSpy.mockRestore();
  });
});
