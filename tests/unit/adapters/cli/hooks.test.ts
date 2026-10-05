/**
 * Tests the hook command router. The hook layer holds three lifecycle observers and no
 * enforcement handler. The three lifecycle handlers and the state-store module are mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lifecycle/session-end.js', () => ({
  handleSessionEnd: vi.fn(),
}));
vi.mock('../../../../src/lifecycle/session-start.js', () => ({
  handleSessionStart: vi.fn(),
}));
vi.mock('../../../../src/lifecycle/subagent-stop.js', () => ({
  handleSubagentStop: vi.fn(),
}));

vi.mock('../../../../src/workflow/state-store.js', () => ({
  resolveStateDir: vi.fn(),
}));

import { isHookCommand, handleHookCommand, HOOK_COMMANDS } from '../../../../src/adapters/cli/hooks.js';

describe('isHookCommand', () => {
  it('isHookCommand_SessionEnd_ReturnsTrue', () => {
    expect(isHookCommand('session-end')).toBe(true);
  });

  it('isHookCommand_SessionStart_ReturnsTrue', () => {
    expect(isHookCommand('session-start')).toBe(true);
  });

  /** `subagent-stop` is the observer that records the token telemetry of each subagent. */
  it('isHookCommand_SubagentStop_ReturnsTrue', () => {
    expect(isHookCommand('subagent-stop')).toBe(true);
  });

  it('isHookCommand_RetiredEnforcementHooks_ReturnFalse', () => {
    expect(isHookCommand('guard')).toBe(false);
    expect(isHookCommand('task-gate')).toBe(false);
    expect(isHookCommand('teammate-gate')).toBe(false);
    expect(isHookCommand('subagent-context')).toBe(false);
  });

  /** `pre-compact` is a retired hook, so it is not a hook command. */
  it('isHookCommand_T40RemovedHooks_ReturnFalse', () => {
    expect(isHookCommand('pre-compact')).toBe(false);
  });

  it('isHookCommand_NonHookCommands_ReturnFalse', () => {
    expect(isHookCommand('mcp')).toBe(false);
    expect(isHookCommand('workflow')).toBe(false);
    expect(isHookCommand('')).toBe(false);
    expect(isHookCommand(undefined)).toBe(false);
  });

  it('HOOK_COMMANDS_IsObserverOnlySet', () => {
    expect([...HOOK_COMMANDS].sort()).toEqual(['session-end', 'session-start', 'subagent-stop']);
  });
});

describe('handleHookCommand', () => {
  let readStdin: ReturnType<typeof vi.fn>;
  let parseStdin: ReturnType<typeof vi.fn>;
  let outputJson: ReturnType<typeof vi.fn>;
  let savedPluginRoot: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();

    readStdin = vi.fn().mockResolvedValue('{}');
    parseStdin = vi.fn().mockReturnValue({});
    outputJson = vi.fn();
    savedPluginRoot = process.env.EXARCHOS_PLUGIN_ROOT;
    delete process.env.EXARCHOS_PLUGIN_ROOT;

    const stateStore = await import('../../../../src/workflow/state-store.js');
    vi.mocked(stateStore.resolveStateDir).mockReturnValue('/mock/state-dir');

    const sessionEnd = await import('../../../../src/lifecycle/session-end.js');
    vi.mocked(sessionEnd.handleSessionEnd).mockResolvedValue({ ended: true });

    const sessionStart = await import('../../../../src/lifecycle/session-start.js');
    vi.mocked(sessionStart.handleSessionStart).mockResolvedValue({ continue: true });

    const subagentStop = await import('../../../../src/lifecycle/subagent-stop.js');
    vi.mocked(subagentStop.handleSubagentStop).mockResolvedValue({ continue: true });
  });

  afterEach(() => {
    if (savedPluginRoot !== undefined) {
      process.env.EXARCHOS_PLUGIN_ROOT = savedPluginRoot;
    } else {
      delete process.env.EXARCHOS_PLUGIN_ROOT;
    }
  });

  it('handleHookCommand_RetiredGuard_ReturnsHandledFalse', async () => {
    const result = await handleHookCommand(
      'guard',
      ['node', 'exarchos', 'guard'],
      readStdin,
      parseStdin,
      outputJson,
    );
    expect(result).toEqual({ handled: false });
  });

  it('handleHookCommand_PreCompact_ReturnsHandledFalse', async () => {
    const result = await handleHookCommand(
      'pre-compact',
      ['node', 'exarchos', 'pre-compact'],
      readStdin,
      parseStdin,
      outputJson,
    );
    expect(result).toEqual({ handled: false });
  });

  it('handleHookCommand_PluginRootInArgv_SetsEnvVar', async () => {
    await handleHookCommand(
      'session-end',
      ['node', 'exarchos', 'session-end', '--plugin-root', '/custom/root'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(process.env.EXARCHOS_PLUGIN_ROOT).toBe('/custom/root');
  });

  it('handleHookCommand_SessionEnd_ReturnsHandledTrue', async () => {
    const result = await handleHookCommand(
      'session-end',
      ['node', 'exarchos', 'session-end'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result).toEqual({ handled: true });
    expect(outputJson).toHaveBeenCalledWith({ ended: true });
  });

  it('handleHookCommand_SessionStart_ReturnsHandledTrue', async () => {
    const result = await handleHookCommand(
      'session-start',
      ['node', 'exarchos', 'session-start'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result).toEqual({ handled: true });
    expect(outputJson).toHaveBeenCalledWith({ continue: true });
  });

  it('handleHookCommand_SubagentStop_RoutesToHandler_ReturnsHandledTrue', async () => {
    const subagentStop = await import('../../../../src/lifecycle/subagent-stop.js');
    const result = await handleHookCommand(
      'subagent-stop',
      ['node', 'exarchos', 'subagent-stop'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result).toEqual({ handled: true });
    expect(subagentStop.handleSubagentStop).toHaveBeenCalledWith({}, '/mock/state-dir');
    expect(outputJson).toHaveBeenCalledWith({ continue: true });
  });

  /** The router reads `--directive` from argv and passes it to the handler as `{ directive }`. */
  it('handleHookCommand_SessionStart_ForwardsDirective', async () => {
    const { handleSessionStart } = await import('../../../../src/lifecycle/session-start.js');
    await handleHookCommand(
      'session-start',
      ['node', 'exarchos', 'session-start', '--directive', 'Route SDLC through exarchos_* tools.'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(handleSessionStart).toHaveBeenCalledWith(
      expect.anything(),
      '/mock/state-dir',
      { directive: 'Route SDLC through exarchos_* tools.' },
    );
  });

  it('handleHookCommand_OperationalError_ReturnsExitCode1', async () => {
    const { handleSessionEnd } = await import('../../../../src/lifecycle/session-end.js');
    vi.mocked(handleSessionEnd).mockResolvedValueOnce({
      error: { code: 'IO_ERROR', message: 'disk full' },
    });

    const result = await handleHookCommand(
      'session-end',
      ['node', 'exarchos', 'session-end'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.exitCode).toBe(1);
    }
  });
});
