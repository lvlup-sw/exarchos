// The differential proof sends one `ToolResult` through the real CLI command
// tree (`buildCli`). It compares the CLI envelope and exit code with the MCP
// rendering of the same result. The `dispatch` mock supplies the handler
// result. The `cli-format` mock sends the `--json` envelope to a stdout spy.
// `format.toEnvelope` is real, so both surfaces use the shared projection.

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

import { buildCli, resolveExitCode } from '../../../../src/adapters/cli/cli.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { toEnvelope } from '../../../../src/format.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { DIFFERENTIAL_CASES } from '../../../../src/contract/cli/differential-fixtures.js';
import { FAILURE_LAYERS, CONTRACT_EXIT_CODES } from '../../../../src/contract/error-families.js';

function createContext(): DispatchContext {
  return {
    stateDir: '/tmp/exarchos-differential',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

describe('CLI ⇄ MCP differential (exit-code agreement)', () => {
  /**
   * `resolveExitCode` delegates to the contract authority, so a comparison of those two is a tautology.
   * This test compares the verdict of the authority with the hand-written expectation of each fixture.
   */
  it('CliResolveExitCode_EqualsContractExit_ForEveryCase', () => {
    for (const differential of DIFFERENTIAL_CASES) {
      expect(resolveExitCode(differential.result)).toBe(differential.expectedExit);
    }
  });

  /**
   * `ToolResult` is not a discriminated union, so `success: false` with no `error` is legal.
   * The MCP wire renders that result as an error, so exit code 0 from the CLI is a disagreement.
   * The failure branch has a floor of `HANDLER_ERROR`, and an unregistered code gets the same floor.
   * A success result still exits 0.
   */
  it('ResolveExitCode_FailureResultWithoutError_DoesNotExitZero', () => {
    const errorless: ToolResult = { success: false };

    expect(resolveExitCode(errorless)).not.toBe(CONTRACT_EXIT_CODES.SUCCESS);
    expect(resolveExitCode(errorless)).toBe(CONTRACT_EXIT_CODES.HANDLER_ERROR);

    const unregistered: ToolResult = {
      success: false,
      error: { code: 'NOT_IN_THE_REGISTRY', message: 'novel code' },
    };
    expect(resolveExitCode(unregistered)).toBe(CONTRACT_EXIT_CODES.HANDLER_ERROR);

    expect(resolveExitCode({ success: true, data: {} })).toBe(CONTRACT_EXIT_CODES.SUCCESS);
  });

  /**
   * The fixture table must hold a failure with no `error`.
   * Without that case, the differential proof cannot see an exit code of 0 for such a failure.
   */
  it('DifferentialCases_CoverTheErrorlessFailure', () => {
    const errorless = DIFFERENTIAL_CASES.filter((c) => !c.result.success && c.result.error === undefined);
    expect(errorless.length).toBeGreaterThan(0);
    for (const c of errorless) {
      expect(c.expectedExit).not.toBe(CONTRACT_EXIT_CODES.SUCCESS);
    }
  });

  it('EveryFailureFamily_AndSuccess_IsRepresented', () => {
    const families = new Set(DIFFERENTIAL_CASES.map((c) => c.family));
    for (const layer of FAILURE_LAYERS) {
      expect(families.has(layer)).toBe(true);
    }
    expect(families.has('success')).toBe(true);
  });
});

describe('CLI ⇄ MCP differential (end-to-end through buildCli)', () => {
  let ctx: DispatchContext;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createContext();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  for (const differential of DIFFERENTIAL_CASES) {
    /**
     * The mocked `dispatch` gives the fixture result to the CLI.
     * The CLI envelope must equal `toEnvelope(result)`, which the MCP wire puts into `structuredContent`.
     * The exit code of the real CLI path must equal the hand-written expectation of the fixture.
     */
    it(`CLI output + exit equal MCP · ${differential.name}`, async () => {
      vi.mocked(dispatch).mockResolvedValueOnce(differential.result);

      const program = buildCli(ctx);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      await program.parseAsync(['node', 'exarchos', ...differential.argv, '--json']);

      const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
      stdoutSpy.mockRestore();

      const mcpStructuredContent = toEnvelope(differential.result);
      const cliEmitted: unknown = JSON.parse(stdoutText.trim());
      expect(cliEmitted).toEqual(mcpStructuredContent);

      expect(process.exitCode).toBe(differential.expectedExit);
    });
  }

  /** The success case reaches the mocked `dispatch`, so the differential does not stop at CLI validation. */
  it('SuccessCase_ReachesDispatch_ErrorEnvelopesAreEchoed', async () => {
    const successCase = DIFFERENTIAL_CASES.find((c) => c.family === 'success');
    expect(successCase).toBeDefined();
    if (!successCase) return;
    vi.mocked(dispatch).mockResolvedValueOnce(successCase.result);
    const program = buildCli(ctx);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await program.parseAsync(['node', 'exarchos', ...successCase.argv, '--json']);
    stdoutSpy.mockRestore();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
