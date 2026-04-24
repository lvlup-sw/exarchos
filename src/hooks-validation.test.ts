import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Resolve repo root (handles worktree paths)
const repoRoot = process.cwd();

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface HooksConfig {
  hooks: Record<string, HookEntry[]>;
}

/**
 * Collect every `command` string in `hooks/hooks.json` across all hook types
 * and all matchers, returning (hookType, command) tuples.
 */
function collectCommands(config: HooksConfig): Array<{ hookType: string; command: string }> {
  const out: Array<{ hookType: string; command: string }> = [];
  for (const [hookType, entries] of Object.entries(config.hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        out.push({ hookType, command: h.command });
      }
    }
  }
  return out;
}

describe('hooks/hooks.json — bare exarchos invocation', () => {
  const hooksPath = join(repoRoot, 'hooks', 'hooks.json');

  it('HooksJson_Exists_IsValidJson', () => {
    expect(existsSync(hooksPath)).toBe(true);
    const raw = readFileSync(hooksPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('HooksJson_AllCommands_UseExarchosNotNode', () => {
    const raw = readFileSync(hooksPath, 'utf-8');
    const config: HooksConfig = JSON.parse(raw);
    const commands = collectCommands(config);

    // Sanity: we expect at least 8 commands (one per hook type)
    expect(commands.length).toBeGreaterThanOrEqual(8);

    for (const { hookType, command } of commands) {
      // Every command must begin with bare `exarchos `
      expect(command.startsWith('exarchos '), `${hookType} command does not start with 'exarchos ': ${command}`).toBe(true);

      // No `node ` invocation anywhere
      expect(command.includes('node '), `${hookType} command still invokes node: ${command}`).toBe(false);

      // No reference to the bundled JS entrypoint
      expect(command.includes('dist/exarchos.js'), `${hookType} command references dist/exarchos.js: ${command}`).toBe(false);
    }
  });

  it('HooksJson_PreservesAllEightHookTypes', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const hookTypes = Object.keys(config.hooks);

    const required = [
      'PreCompact',
      'SessionStart',
      'PreToolUse',
      'TaskCompleted',
      'TeammateIdle',
      'SubagentStart',
      'SubagentStop',
      'SessionEnd',
    ];

    for (const t of required) {
      expect(hookTypes, `missing hook type: ${t}`).toContain(t);
    }
  });

  it('HooksJson_EachHookType_InvokesExpectedSubcommand', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const expectedSubcommand: Record<string, string> = {
      PreCompact: 'pre-compact',
      SessionStart: 'session-start',
      PreToolUse: 'guard',
      TaskCompleted: 'task-gate',
      TeammateIdle: 'teammate-gate',
      SubagentStart: 'subagent-context',
      SubagentStop: 'subagent-stop',
      SessionEnd: 'session-end',
    };

    for (const [hookType, subcommand] of Object.entries(expectedSubcommand)) {
      const entries = config.hooks[hookType];
      expect(entries, `hook type ${hookType} not present`).toBeDefined();
      const firstCommand = entries[0].hooks[0].command;
      expect(firstCommand, `${hookType} does not invoke subcommand '${subcommand}'`).toBe(
        // SessionStart uniquely passes --plugin-root
        hookType === 'SessionStart'
          ? `exarchos session-start --plugin-root "\${CLAUDE_PLUGIN_ROOT}"`
          : `exarchos ${subcommand}`,
      );
    }
  });

  it('HooksJson_PreservesMatcherAndTimeoutMetadata', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    // Matcher preservation
    expect(config.hooks.PreCompact[0].matcher).toBe('auto');
    expect(config.hooks.SessionStart[0].matcher).toBe('startup|resume');
    expect(config.hooks.PreToolUse[0].matcher).toBe('mcp__(plugin_exarchos_)?exarchos__.*');
    expect(config.hooks.SubagentStop[0].matcher).toBe('exarchos-implementer|exarchos-fixer');
    expect(config.hooks.SessionEnd[0].matcher).toBe('auto');

    // Timeout preservation (original values from pre-rewrite file)
    expect(config.hooks.PreCompact[0].hooks[0].timeout).toBe(30);
    expect(config.hooks.SessionStart[0].hooks[0].timeout).toBe(10);
    expect(config.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
    expect(config.hooks.TaskCompleted[0].hooks[0].timeout).toBe(120);
    expect(config.hooks.TeammateIdle[0].hooks[0].timeout).toBe(120);
    expect(config.hooks.SubagentStart[0].hooks[0].timeout).toBe(5);
    expect(config.hooks.SubagentStop[0].hooks[0].timeout).toBe(10);
    expect(config.hooks.SessionEnd[0].hooks[0].timeout).toBe(30);

    // Status message preservation where present
    expect(config.hooks.PreCompact[0].hooks[0].statusMessage).toBe('Saving workflow checkpoint...');
    expect(config.hooks.SessionStart[0].hooks[0].statusMessage).toBe('Checking for active workflows...');
    expect(config.hooks.TaskCompleted[0].hooks[0].statusMessage).toBe('Running quality gates...');
    expect(config.hooks.TeammateIdle[0].hooks[0].statusMessage).toBe('Verifying teammate work...');
  });

  it('HooksJson_SessionStart_StillFlowsPluginRootAsArg', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const cmd = config.hooks.SessionStart[0].hooks[0].command;
    // Executable position is bare `exarchos`, and plugin root flows through as an arg.
    expect(cmd.startsWith('exarchos ')).toBe(true);
    expect(cmd).toContain('--plugin-root');
    expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('HooksJson_EveryHookEntry_IsCommandType', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    for (const [hookType, entries] of Object.entries(config.hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          expect(h.type, `${hookType} hook entry has non-command type: ${h.type}`).toBe('command');
        }
      }
    }
  });
});
