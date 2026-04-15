// ─── Task 023: Long-running CLI progress discipline (DR-5) ──────────────────
//
// Under MCP, the host can render progress; under CLI a silent process for 5+
// seconds looks broken.  This suite locks in two invariants:
//
// 1. At least one orchestrate action in the registry carries a `longRunning`
//    metadata flag — the canonical signal for "emit heartbeats under CLI".
// 2. When such an action is invoked via `--json` CLI, the adapter either
//    completes quickly or emits a line-buffered stderr heartbeat within 2.5s
//    of spawn.  A silent >2s CLI is what we're rejecting.
//
// Heartbeats go to stderr so `--json` stdout stays a single ToolResult line.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../format.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock dispatch with a configurable delay so we can simulate a slow handler
// without actually running npm run test:run (which prepare_synthesis does).
const dispatchDelayMs = { current: 0 };

vi.mock('../core/dispatch.js', () => ({
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

vi.mock('./cli-format.js', () => ({
  prettyPrint: vi.fn(),
  printError: vi.fn(),
}));

vi.mock('./mcp.js', () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(async () => {}),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(() => ({})),
}));

// ─── Test Imports ───────────────────────────────────────────────────────────

import { buildCli } from './cli.js';
import { TOOL_REGISTRY } from '../registry.js';
import type { DispatchContext } from '../core/dispatch.js';

function createTestContext(): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

// ─── Heartbeat regex ────────────────────────────────────────────────────────

// Matches the heartbeat line we require on stderr.  Loose on the exact wording
// but strict that it ends with a newline and contains "heartbeat".
const HEARTBEAT_PATTERN = /\[heartbeat\].*\n/;

// ─── Registry flag test ─────────────────────────────────────────────────────

describe('orchestrate action registry — longRunning metadata (DR-5)', () => {
  it('OrchestrateActionRegistry_LongRunningFlagPresent', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate, 'exarchos_orchestrate must exist').toBeDefined();

    const flagged = orchestrate!.actions.filter((a) => a.longRunning === true);
    expect(
      flagged.length,
      'at least one orchestrate action must carry longRunning: true (e.g. prepare_synthesis or assess_stack)',
    ).toBeGreaterThanOrEqual(1);
  });
});

// ─── CLI heartbeat behavior ─────────────────────────────────────────────────

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

  it('LongRunningOrchestrateAction_CliInvocation_EmitsLineBufferedProgressOrExitsQuickly', async () => {
    // Arrange — locate a flagged action to exercise.
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();
    const flagged = orchestrate!.actions.find((a) => a.longRunning === true);
    expect(flagged, 'need at least one longRunning action to test heartbeats').toBeDefined();

    // Simulate a slow handler (longer than the 2s heartbeat interval) so we
    // can observe at least one heartbeat on stderr.
    dispatchDelayMs.current = 2600;

    const program = buildCli(ctx);

    // Invoke the flagged action via --json so the adapter sees a "machine"
    // caller — heartbeats must only emit in this mode (not in pretty-print).
    const spawnStart = Date.now();
    await program.parseAsync([
      'node',
      'exarchos',
      orchestrate!.cli?.alias ?? 'orch',
      flagged!.cli?.alias ?? flagged!.name,
      '--feature-id',
      'dr5-test',
      ...(flagged!.name === 'assess_stack' ? ['--pr-numbers', '[1]'] : []),
      '--json',
    ]);
    const totalMs = Date.now() - spawnStart;

    // Collect everything written to stderr during the invocation.
    const stderrText = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');

    const heartbeatMatches = stderrText.match(new RegExp(HEARTBEAT_PATTERN, 'g')) ?? [];

    // Either the process finished within ~2s (no heartbeat needed), OR we
    // observed at least one heartbeat line within 2.5s of spawn.
    const exitedQuickly = totalMs < 2000;
    const emittedHeartbeatInTime = heartbeatMatches.length >= 1 && totalMs <= 3500;

    expect(
      exitedQuickly || emittedHeartbeatInTime,
      `expected either quick exit (<2s) or heartbeat on stderr within 2.5s; ` +
        `totalMs=${totalMs}, heartbeatCount=${heartbeatMatches.length}, ` +
        `stderr=${JSON.stringify(stderrText).slice(0, 200)}`,
    ).toBe(true);

    // Heartbeat lines, if any, must each end with a newline (line-buffered).
    for (const line of heartbeatMatches) {
      expect(line.endsWith('\n')).toBe(true);
    }

    // --json stdout contract: exactly one ToolResult line.  Heartbeats must
    // not have leaked onto stdout.
    const stdoutText = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stdoutText).not.toMatch(HEARTBEAT_PATTERN);
    // When the mocked dispatch resolves, exactly one JSON line is written.
    const stdoutLines = stdoutText.split('\n').filter((l) => l.length > 0);
    expect(stdoutLines.length).toBe(1);
    expect(() => JSON.parse(stdoutLines[0]!)).not.toThrow();
  }, 10_000);

  it('NonLongRunningAction_CliInvocation_DoesNotEmitHeartbeats', async () => {
    // Arrange — prepare_delegation takes only featureId and is not flagged
    // as longRunning.  A slow dispatch on a non-flagged action must stay
    // silent on stderr.
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const nonFlagged = orchestrate!.actions.find((a) => a.name === 'prepare_delegation');
    expect(nonFlagged, 'need prepare_delegation for control case').toBeDefined();
    expect(nonFlagged!.longRunning).not.toBe(true);

    // Even with a delay, no heartbeats should emit for unflagged actions.
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
