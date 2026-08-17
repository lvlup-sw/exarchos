/**
 * Tests for the top-level `exarchos install-skills` CLI surface.
 *
 * DR-5 (task 018): `install-skills` is RETIRED. The reconciler's GENERATE step
 * (the init writers' `mcp-json-writer` + the per-runtime config writers) plus
 * onboard's `installStep` now own skills + MCP registration, so the standalone
 * `install-skills` verb is a one-release **rename stub** — it prints
 * `renamed → use 'exarchos onboard'` and exits non-zero (HANDLER_ERROR=2, NOT
 * "command not found"), runs NO install side effect, and reaches the bridge
 * never. Removed entirely at v3.0. Mirrors the `init` rename stub (cli-init.test.ts).
 *
 * These tests drive the CLI programmatically (buildCli + parseAsync) rather than
 * spawning a subprocess, mirroring the pattern in cli-init.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The bridge must NEVER be reached by the stub. Mock it with a recorder so the
// test can assert zero invocations (no install side effect).
vi.mock('../../../../src/lifecycle/install-skills-bridge.js', () => ({
  runInstallSkills: vi.fn(async () => {}),
}));

import { buildCli, CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/install-skills-cli-test',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

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

    // No install side effect runs from the stub (DR-5 acceptance criterion):
    // the bridge is never reached.
    const { runInstallSkills } = await import(
      '../../../../src/lifecycle/install-skills-bridge.js'
    );
    expect(runInstallSkills).not.toHaveBeenCalled();
    // Non-zero, not "command not found".
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

  it('CliInstallSkills_LegacyAgentFlag_StillStubs_NoInstall', async () => {
    // The legacy `--agent <id>` flag is accepted (allowUnknownOption /
    // allowExcessArguments) but ignored — there is no installer to route to.
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
