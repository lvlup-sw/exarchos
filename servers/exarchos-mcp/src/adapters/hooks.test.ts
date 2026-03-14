import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all cli-command modules before importing the module under test
vi.mock('../cli-commands/pre-compact.js', () => ({
  handlePreCompact: vi.fn(),
}));
vi.mock('../cli-commands/session-start.js', () => ({
  handleSessionStart: vi.fn(),
}));
vi.mock('../cli-commands/guard.js', () => ({
  handleGuard: vi.fn(),
}));
vi.mock('../cli-commands/gates.js', () => ({
  handleTaskGate: vi.fn(),
  handleTeammateGate: vi.fn(),
}));
vi.mock('../cli-commands/subagent-context.js', () => ({
  handleSubagentContext: vi.fn(),
}));
vi.mock('../cli-commands/session-end.js', () => ({
  handleSessionEnd: vi.fn(),
}));

// Mock the workflow state-store module (re-exports resolveStateDir)
vi.mock('../workflow/state-store.js', () => ({
  resolveStateDir: vi.fn(),
}));

// Mock the utils/paths module (resolveTeamsDir)
vi.mock('../utils/paths.js', () => ({
  resolveStateDir: vi.fn(),
  resolveTeamsDir: vi.fn(),
}));

import { isHookCommand, handleHookCommand } from './hooks.js';

describe('isHookCommand', () => {
  it('isHookCommand_PreCompact_ReturnsTrue', () => {
    expect(isHookCommand('pre-compact')).toBe(true);
  });

  it('isHookCommand_SessionStart_ReturnsTrue', () => {
    expect(isHookCommand('session-start')).toBe(true);
  });

  it('isHookCommand_Guard_ReturnsTrue', () => {
    expect(isHookCommand('guard')).toBe(true);
  });

  it('isHookCommand_TaskGate_ReturnsTrue', () => {
    expect(isHookCommand('task-gate')).toBe(true);
  });

  it('isHookCommand_TeammateGate_ReturnsTrue', () => {
    expect(isHookCommand('teammate-gate')).toBe(true);
  });

  it('isHookCommand_SubagentContext_ReturnsTrue', () => {
    expect(isHookCommand('subagent-context')).toBe(true);
  });

  it('isHookCommand_SessionEnd_ReturnsTrue', () => {
    expect(isHookCommand('session-end')).toBe(true);
  });

  it('isHookCommand_Mcp_ReturnsFalse', () => {
    expect(isHookCommand('mcp')).toBe(false);
  });

  it('isHookCommand_Workflow_ReturnsFalse', () => {
    expect(isHookCommand('workflow')).toBe(false);
  });

  it('isHookCommand_Empty_ReturnsFalse', () => {
    expect(isHookCommand('')).toBe(false);
  });

  it('isHookCommand_Undefined_ReturnsFalse', () => {
    expect(isHookCommand(undefined)).toBe(false);
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

    // Reset mock return values for path resolvers
    const stateStore = await import('../workflow/state-store.js');
    vi.mocked(stateStore.resolveStateDir).mockReturnValue('/mock/state-dir');

    const paths = await import('../utils/paths.js');
    vi.mocked(paths.resolveStateDir).mockReturnValue('/mock/state-dir');
    vi.mocked(paths.resolveTeamsDir).mockReturnValue('/mock/teams-dir');

    // Reset mock return values for handlers
    const preCompact = await import('../cli-commands/pre-compact.js');
    vi.mocked(preCompact.handlePreCompact).mockResolvedValue({ compacted: true });

    const sessionStart = await import('../cli-commands/session-start.js');
    vi.mocked(sessionStart.handleSessionStart).mockResolvedValue({ started: true });

    const guard = await import('../cli-commands/guard.js');
    vi.mocked(guard.handleGuard).mockResolvedValue({ allowed: true });

    const gates = await import('../cli-commands/gates.js');
    vi.mocked(gates.handleTaskGate).mockResolvedValue({ passed: true });
    vi.mocked(gates.handleTeammateGate).mockResolvedValue({ passed: true });

    const subagentContext = await import('../cli-commands/subagent-context.js');
    vi.mocked(subagentContext.handleSubagentContext).mockResolvedValue({ context: 'test' });

    const sessionEnd = await import('../cli-commands/session-end.js');
    vi.mocked(sessionEnd.handleSessionEnd).mockResolvedValue({ ended: true });
  });

  afterEach(() => {
    if (savedPluginRoot !== undefined) {
      process.env.EXARCHOS_PLUGIN_ROOT = savedPluginRoot;
    } else {
      delete process.env.EXARCHOS_PLUGIN_ROOT;
    }
  });

  it('handleHookCommand_PreCompact_CallsPreCompactHandler', async () => {
    const result = await handleHookCommand(
      'pre-compact',
      ['node', 'exarchos', 'pre-compact'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result.handled).toBe(true);
    expect(readStdin).toHaveBeenCalled();
    expect(parseStdin).toHaveBeenCalled();
    expect(outputJson).toHaveBeenCalledWith({ compacted: true });

    const { handlePreCompact } = await import('../cli-commands/pre-compact.js');
    expect(handlePreCompact).toHaveBeenCalledWith({}, '/mock/state-dir');
  });

  it('handleHookCommand_SessionStart_CallsSessionStartHandler', async () => {
    const result = await handleHookCommand(
      'session-start',
      ['node', 'exarchos', 'session-start'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result.handled).toBe(true);
    expect(outputJson).toHaveBeenCalledWith({ started: true });

    const { handleSessionStart } = await import('../cli-commands/session-start.js');
    expect(handleSessionStart).toHaveBeenCalledWith({}, '/mock/state-dir', '/mock/teams-dir');
  });

  it('handleHookCommand_PluginRootInArgv_SetsEnvVar', async () => {
    await handleHookCommand(
      'pre-compact',
      ['node', 'exarchos', 'pre-compact', '--plugin-root', '/custom/root'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(process.env.EXARCHOS_PLUGIN_ROOT).toBe('/custom/root');
  });

  it('handleHookCommand_GateFailure_ReturnsExitCode', async () => {
    const { handleTaskGate } = await import('../cli-commands/gates.js');
    vi.mocked(handleTaskGate).mockResolvedValueOnce({
      error: { code: 'GATE_FAILED', message: 'gate blocked' },
    });

    const result = await handleHookCommand(
      'task-gate',
      ['node', 'exarchos', 'task-gate'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.exitCode).toBe(2);
    }
  });

  it('handleHookCommand_Success_ReturnsHandledTrue', async () => {
    const result = await handleHookCommand(
      'guard',
      ['node', 'exarchos', 'guard'],
      readStdin,
      parseStdin,
      outputJson,
    );

    expect(result).toEqual({ handled: true });
  });
});
