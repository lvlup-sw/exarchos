// Progress discipline for long-running CLI actions. Under MCP the host can show progress, but a
// CLI process that is silent for about 5 seconds looks broken. The heartbeat interval is 2 seconds.
//
// The suite pins two invariants:
// 1. The registry flags an exact set of orchestrate actions with `longRunning`, the signal that
//    the CLI must emit heartbeats.
// 2. A flagged action that is slow under `--json` writes a line-buffered heartbeat to stderr.
//
// Heartbeats go to stderr, so `--json` stdout stays one JSON document.
//
// A `vi.mock` factory replaces the whole module. Thus the `cli-format` mock also supplies a
// `toCliResult` that writes the envelope to stdout as JSON, as production does.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';

/** The delay of the mocked dispatch. A test sets it to simulate a slow handler with no real command. */
const dispatchDelayMs = { current: 0 };

vi.mock('../../../../src/dispatch/core/dispatch.js', () => ({
  dispatch: vi.fn<(tool: string, args: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>>(
    async () => {
      const delay = dispatchDelayMs.current;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return { success: true, data: { mocked: true } };
    },
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

vi.mock('../../../../src/adapters/mcp/mcp.js', () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(async () => {}),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(() => ({})),
}));

import { buildCli } from '../../../../src/adapters/cli/cli.js';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

/** Matches a heartbeat line: it holds `[heartbeat]` and ends with a newline. The other words are free. */
const HEARTBEAT_PATTERN = /\[heartbeat\].*\n/;

/**
 * The orchestrate actions that must carry `longRunning: true`. The test compares the exact set, so
 * each addition or removal in the registry needs an edit here.
 * The registry states the reason for each flag: each action runs shell tools or the action executor.
 */
const EXPECTED_LONG_RUNNING_ACTIONS: ReadonlySet<string> = new Set([
  'prepare_synthesis',
  'pre_synthesis_check',
  'assess_stack',
  'check_static_analysis',
  'check_integration_suite',
  'post_delegation_check',
  'check_test_adequacy',
  'check_contract_drift',
  'mutation-adequacy',
  'execute_intent',
  'settle',
]);

describe('orchestrate action registry — longRunning metadata (DR-5)', () => {
  it('OrchestrateActionRegistry_LongRunningFlagPresent', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate, 'exarchos_orchestrate must exist').toBeDefined();

    const flaggedNames = new Set(
      orchestrate!.actions
        .filter((a) => a.longRunning === true)
        .map((a) => a.name),
    );

    expect(
      Array.from(flaggedNames).sort(),
      'registry longRunning actions drifted from the canonical audit set',
    ).toEqual(Array.from(EXPECTED_LONG_RUNNING_ACTIONS).sort());
  });
});

/** The extra required flags of each flagged action under test. */
const EXTRA_ARGS_PER_ACTION: Record<string, string[]> = {
  /**
   * The `prepare_synthesis` schema requires `repoRoot`. Without the flag, the CLI rejects the input
   * before dispatch, and the test never reaches the heartbeat path.
   */
  prepare_synthesis: ['--repo-root', process.cwd()],
  assess_stack: ['--pr-numbers', '[1]'],
  check_integration_suite: [],
};

/**
 * Runs `invoke` with timers and `Date` on a fake clock, stepping the clock
 * 100 ms at a time until the call settles. Real I/O still runs between steps,
 * so the verdict depends on the code's timers, not on the host's speed.
 */
async function runOnFakeClock(invoke: () => Promise<unknown>): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  try {
    let settled = false;
    const run = invoke().finally(() => {
      settled = true;
    });
    while (!settled) {
      await vi.advanceTimersByTimeAsync(100);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run;
  } finally {
    vi.useRealTimers();
  }
}

describe('CLI long-running heartbeat emission (DR-5)', () => {
  let ctx: DispatchContext;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    ctx = createTestContext();
    dispatchDelayMs.current = 0;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    dispatchDelayMs.current = 0;
    process.exitCode = originalExitCode;
  });

  /** The same test runs for each listed action, so the result does not depend on the registry order. */
  describe.each(['prepare_synthesis', 'assess_stack', 'check_integration_suite'] as const)(
    'flagged action: %s',
    (actionName) => {
      /**
       * The mocked handler takes 2600 ms, longer than the 2 s heartbeat interval, so stderr must hold
       * at least one heartbeat. The call uses `--json`, because only that mode emits heartbeats.
       * Stdout must hold no heartbeat and must parse as one JSON document.
       */
      it('LongRunningOrchestrateAction_CliInvocation_EmitsLineBufferedProgressOrExitsQuickly', async () => {
        const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
        expect(orchestrate).toBeDefined();
        const flagged = orchestrate!.actions.find((a) => a.name === actionName);
        expect(flagged, `${actionName} must exist in registry`).toBeDefined();
        expect(
          flagged!.longRunning,
          `${actionName} must carry longRunning: true`,
        ).toBe(true);

        dispatchDelayMs.current = 2600;

        const program = buildCli(ctx);

        await runOnFakeClock(() =>
          program.parseAsync([
            'node',
            'exarchos',
            orchestrate!.cli?.alias ?? 'orch',
            flagged!.cli?.alias ?? flagged!.name,
            '--feature-id',
            'dr5-test',
            ...(EXTRA_ARGS_PER_ACTION[actionName] ?? []),
            '--json',
          ]),
        );

        const stderrText = stderrSpy.mock.calls
          .map(([chunk]) => String(chunk))
          .join('');

        const heartbeatMatches =
          stderrText.match(new RegExp(HEARTBEAT_PATTERN, 'g')) ?? [];

        expect(
          heartbeatMatches.length,
          `expected a heartbeat on stderr before the ${dispatchDelayMs.current}ms handler returned; ` +
            `action=${actionName}, stderr=${JSON.stringify(stderrText).slice(0, 200)}`,
        ).toBeGreaterThanOrEqual(1);

        for (const line of heartbeatMatches) {
          expect(line.endsWith('\n')).toBe(true);
        }

        const stdoutText = stdoutSpy.mock.calls
          .map(([chunk]) => String(chunk))
          .join('');
        expect(stdoutText).not.toMatch(HEARTBEAT_PATTERN);
        const trimmed = stdoutText.trim();
        expect(trimmed.length).toBeGreaterThan(0);
        expect(() => JSON.parse(trimmed)).not.toThrow();
      }, 10_000);
    },
  );

  /** The control case. `prepare_delegation` has no flag, so a slow dispatch must write no heartbeat. */
  it('NonLongRunningAction_CliInvocation_DoesNotEmitHeartbeats', async () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const nonFlagged = orchestrate!.actions.find((a) => a.name === 'prepare_delegation');
    expect(nonFlagged, 'need prepare_delegation for control case').toBeDefined();
    expect(nonFlagged!.longRunning).not.toBe(true);

    dispatchDelayMs.current = 2400;

    const program = buildCli(ctx);
    await program.parseAsync([
      'node',
      'exarchos',
      'orch',
      nonFlagged!.cli?.alias ?? nonFlagged!.name,
      '--feature-id',
      'dr5-test',
      '--json',
    ]);

    const stderrText = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stderrText).not.toMatch(HEARTBEAT_PATTERN);
  }, 10_000);
});
