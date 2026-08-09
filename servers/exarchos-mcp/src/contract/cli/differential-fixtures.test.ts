import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../../format.js';

// ─── Mocks (mirror adapters/cli.test.ts) ─────────────────────────────────────
//
// The differential proof drives the SAME `ToolResult` through the real CLI
// command tree (`buildCli`) and compares the CLI's rendered envelope + resolved
// exit code against the MCP wire's rendering of the same result. `dispatch` is
// mocked so we control the handler result; `cli-format` is mocked so the
// `--json` path's envelope reaches a stdout spy (the mock mirrors the real
// `toCliResult` json branch). `format.toEnvelope` is NOT mocked — both surfaces
// resolve through the real, shared envelope projection.

vi.mock('../../core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => ({ success: true, data: {} }),
  ),
}));

vi.mock('../../adapters/cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
  toCliResult: vi.fn((env: unknown, format: string) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    }
  }),
}));

import { buildCli, resolveExitCode } from '../../adapters/cli.js';
import { dispatch } from '../../core/dispatch.js';
import { toEnvelope } from '../../format.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { DIFFERENTIAL_CASES } from './differential-fixtures.js';
import { FAILURE_LAYERS, CONTRACT_EXIT_CODES } from '../error-families.js';

function createContext(): DispatchContext {
  return {
    stateDir: '/tmp/exarchos-differential',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

// ─── Pure agreement: the CLI resolves the SAME stable exit as the contract ───

describe('CLI ⇄ MCP differential (exit-code agreement)', () => {
  it('CliResolveExitCode_EqualsContractExit_ForEveryCase', () => {
    for (const differential of DIFFERENTIAL_CASES) {
      // `resolveExitCode` DELEGATES to the contract authority, so comparing the
      // two names would be a tautology (it was one, and it is gone). What is
      // measured here is the authority's verdict against the fixture's own
      // hand-written expectation.
      expect(resolveExitCode(differential.result)).toBe(differential.expectedExit);
    }
  });

  it('ResolveExitCode_FailureResultWithoutError_DoesNotExitZero', () => {
    // `ToolResult` is not a discriminated union: `success:false` with no `error`
    // is type-legal for every handler, and the MCP wire renders it `isError`.
    // A silent 0 here is the CLI disagreeing with the wire about one value.
    const errorless: ToolResult = { success: false };

    expect(resolveExitCode(errorless)).not.toBe(CONTRACT_EXIT_CODES.SUCCESS);
    expect(resolveExitCode(errorless)).toBe(CONTRACT_EXIT_CODES.HANDLER_ERROR);

    // The floor is a property of the failure branch, not a special case for the
    // absent code: an unregistered code takes the same floor.
    const unregistered: ToolResult = {
      success: false,
      error: { code: 'NOT_IN_THE_REGISTRY', message: 'novel code' },
    };
    expect(resolveExitCode(unregistered)).toBe(CONTRACT_EXIT_CODES.HANDLER_ERROR);

    // …and success is still 0, so the floor did not simply redden everything.
    expect(resolveExitCode({ success: true, data: {} })).toBe(CONTRACT_EXIT_CODES.SUCCESS);
  });

  it('DifferentialCases_CoverTheErrorlessFailure', () => {
    // Guards the table itself: the differential proof was blind to this shape,
    // so its absence is what let the defect survive a green suite.
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

// ─── End-to-end: same action through the real CLI tree vs the MCP envelope ───

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
    it(`CLI output + exit equal MCP · ${differential.name}`, async () => {
      // The contract handler (mocked dispatch) returns this result on BOTH
      // surfaces — the MCP wire would put `toEnvelope(result)` into
      // structuredContent; the CLI renders the same result to stdout.
      vi.mocked(dispatch).mockResolvedValueOnce(differential.result);

      const program = buildCli(ctx);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      await program.parseAsync(['node', 'exarchos', ...differential.argv, '--json']);

      const stdoutText = stdoutSpy.mock.calls.map(([s]) => s).join('');
      stdoutSpy.mockRestore();

      // 1. Rendering agrees by construction — the CLI-emitted envelope is
      //    byte-equal (post-JSON-roundtrip) to the MCP structuredContent.
      const mcpStructuredContent = toEnvelope(differential.result);
      const cliEmitted: unknown = JSON.parse(stdoutText.trim());
      expect(cliEmitted).toEqual(mcpStructuredContent);

      // 2. The exit code the REAL CLI path set agrees with the fixture's
      //    hand-written expectation. This is the measurement — comparing it
      //    against a second call to the same authority would not be.
      expect(process.exitCode).toBe(differential.expectedExit);
    });
  }

  it('SuccessCase_ReachesDispatch_ErrorEnvelopesAreEchoed', async () => {
    // Sanity: the success vehicle actually reaches the (mocked) contract
    // handler — i.e. the differential is exercising the real dispatch seam,
    // not short-circuiting at the CLI validation layer.
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
