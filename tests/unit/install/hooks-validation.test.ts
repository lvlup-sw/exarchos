import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';

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

/**
 * The hook layer only observes. `hooks/hooks.json` must hold none of these
 * enforcement hook types.
 */
const ENFORCEMENT_HOOK_TYPES = ['PreToolUse', 'TaskCompleted', 'TeammateIdle', 'SubagentStart'];
const ENFORCEMENT_SUBCOMMANDS = ['guard', 'task-gate', 'teammate-gate', 'subagent-context'];
/**
 * The observer hooks that `hooks/hooks.json` must declare. `SubagentStop`
 * records token telemetry. `SessionEnd` is not one of them.
 */
const OBSERVER_HOOK_TYPES = ['SessionStart', 'SubagentStop'];

describe('hooks/hooks.json — observe-only (#1476)', () => {
  const hooksPath = join(repoRoot, 'hooks', 'hooks.json');

  it('HooksJson_Exists_IsValidJson', () => {
    expect(existsSync(hooksPath)).toBe(true);
    const raw = readFileSync(hooksPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  /** `PreCompact` is a retired hook type that `ENFORCEMENT_HOOK_TYPES` does not list. */
  it('HooksJson_ContainsObserverHooksOnly', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const hookTypes = Object.keys(config.hooks);

    for (const t of OBSERVER_HOOK_TYPES) {
      expect(hookTypes, `missing observer hook type: ${t}`).toContain(t);
    }

    for (const t of ENFORCEMENT_HOOK_TYPES) {
      expect(hookTypes, `enforcement hook type still present: ${t}`).not.toContain(t);
    }

    expect(hookTypes).not.toContain('PreCompact');
  });

  it('HooksJson_NoEnforcementSubcommands', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const commands = collectCommands(config);
    for (const { hookType, command } of commands) {
      for (const sub of ENFORCEMENT_SUBCOMMANDS) {
        expect(
          command.includes(`exarchos ${sub}`),
          `${hookType} still invokes retired enforcement subcommand '${sub}': ${command}`,
        ).toBe(false);
      }
    }
  });

  /** The two observer hooks give two commands or more. */
  it('HooksJson_AllCommands_UseExarchosNotNode', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const commands = collectCommands(config);

    expect(commands.length).toBeGreaterThanOrEqual(2);

    for (const { hookType, command } of commands) {
      expect(
        command.startsWith('exarchos '),
        `${hookType} command does not start with 'exarchos ': ${command}`,
      ).toBe(true);
      expect(command.includes('node '), `${hookType} command still invokes node: ${command}`).toBe(false);
      expect(command.includes('dist/exarchos.js'), `${hookType} command references dist/exarchos.js: ${command}`).toBe(false);
    }
  });

  /**
   * The check uses `toContain`, because the `SessionStart` command carries a
   * trailing `--directive` argument.
   */
  it('HooksJson_EachObserverHook_InvokesExpectedSubcommand', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const expectedSubcommand: Record<string, string> = {
      SessionStart: 'session-start',
      SubagentStop: 'subagent-stop',
    };

    for (const [hookType, subcommand] of Object.entries(expectedSubcommand)) {
      const entries = config.hooks[hookType];
      expect(entries, `hook type ${hookType} not present`).toBeDefined();
      const firstCommand = entries[0].hooks[0].command;
      expect(firstCommand, `${hookType} does not invoke subcommand '${subcommand}'`).toContain(
        `exarchos ${subcommand}`,
      );
    }
  });

  it('HooksJson_PreservesObserverMatcherAndTimeoutMetadata', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    expect(config.hooks.SessionStart[0].matcher).toBe('startup|resume');
    expect(config.hooks.SubagentStop[0].matcher).toBe('*');

    expect(config.hooks.SessionStart[0].hooks[0].timeout).toBe(10);
    expect(config.hooks.SubagentStop[0].hooks[0].timeout).toBe(30);
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

describe('enforcement-handler excision grep-sweep (#1476)', () => {
  /**
   * A tracked file under `src/` or `scripts/` must not name a retired enforcement
   * subcommand, handler module or handler function. Test files are exempt.
   *
   * The path patterns must name `lifecycle/`, the directory that holds the hook
   * handlers. A pattern for a different directory can never match, so it guards
   * nothing. `git grep` exits 1 when it finds no match, and the `catch` reads
   * each failure as a pass.
   */
  it('NoSourceReferences_ToRetiredEnforcementSubcommands', async () => {
    const patterns = [
      'lifecycle/guard',
      'lifecycle/gates',
      'lifecycle/subagent-context',
      'task-gate',
      'teammate-gate',
      'handleGuard',
      'handleTaskGate',
      'handleTeammateGate',
      'handleSubagentContext',
    ];

    const offenders: string[] = [];
    for (const pattern of patterns) {
      let out = '';
      try {
        out = await execFileAsync(
          'git',
          [
            'grep',
            '-l',
            '-F',
            pattern,
            '--',
            'src/',
            'src/',
            'scripts/',
            ':!*.test.ts',
            ':!*.test.sh',
          ],
          { cwd: repoRoot },
        );
      } catch {
        out = '';
      }
      const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const f of files) offenders.push(`${pattern} → ${f}`);
    }

    expect(offenders, `retired enforcement references linger:\n${offenders.join('\n')}`).toEqual([]);
  });
});
