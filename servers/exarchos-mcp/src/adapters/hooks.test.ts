import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1476 + #1485: the hook layer is observe-only. Only the two lifecycle
// observers (`session-start`, `session-end`) are dispatched; the enforcement/
// control handlers (guard, task-gate, teammate-gate, subagent-context) and the
// unused `subagent-stop` observer were retired.
vi.mock('../cli-commands/session-end.js', () => ({
  handleSessionEnd: vi.fn(),
}));
vi.mock('../cli-commands/session-start.js', () => ({
  handleSessionStart: vi.fn(),
}));

// Mock the workflow state-store module (re-exports resolveStateDir)
vi.mock('../workflow/state-store.js', () => ({
  resolveStateDir: vi.fn(),
}));

import { isHookCommand, handleHookCommand, HOOK_COMMANDS } from './hooks.js';

describe('isHookCommand', () => {
  it('isHookCommand_SessionEnd_ReturnsTrue', () => {
    expect(isHookCommand('session-end')).toBe(true);
  });

  it('isHookCommand_SessionStart_ReturnsTrue', () => {
    // #1485: SessionStart is the new observe-only binding hook.
    expect(isHookCommand('session-start')).toBe(true);
  });

  it('isHookCommand_SubagentStop_ReturnsFalse', () => {
    // #1485: the unused subagent-stop observer was retired.
    expect(isHookCommand('subagent-stop')).toBe(false);
  });

  it('isHookCommand_RetiredEnforcementHooks_ReturnFalse', () => {
    // #1476: these enforcement/control hooks were retired.
    expect(isHookCommand('guard')).toBe(false);
    expect(isHookCommand('task-gate')).toBe(false);
    expect(isHookCommand('teammate-gate')).toBe(false);
    expect(isHookCommand('subagent-context')).toBe(false);
  });

  it('isHookCommand_T40RemovedHooks_ReturnFalse', () => {
    // pre-compact stays retired (auto-resume driver, T-40). session-start is
    // now re-added as observe-only orientation (#1485) — see above.
    expect(isHookCommand('pre-compact')).toBe(false);
  });

  it('isHookCommand_NonHookCommands_ReturnFalse', () => {
    expect(isHookCommand('mcp')).toBe(false);
    expect(isHookCommand('workflow')).toBe(false);
    expect(isHookCommand('')).toBe(false);
    expect(isHookCommand(undefined)).toBe(false);
  });

  it('HOOK_COMMANDS_IsObserverOnlySet', () => {
    expect([...HOOK_COMMANDS].sort()).toEqual(['session-end', 'session-start']);
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

    const stateStore = await import('../workflow/state-store.js');
    vi.mocked(stateStore.resolveStateDir).mockReturnValue('/mock/state-dir');

    const sessionEnd = await import('../cli-commands/session-end.js');
    vi.mocked(sessionEnd.handleSessionEnd).mockResolvedValue({ ended: true });

    const sessionStart = await import('../cli-commands/session-start.js');
    vi.mocked(sessionStart.handleSessionStart).mockResolvedValue({ continue: true });
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

  it('handleHookCommand_OperationalError_ReturnsExitCode1', async () => {
    const { handleSessionEnd } = await import('../cli-commands/session-end.js');
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
