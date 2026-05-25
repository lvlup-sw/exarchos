import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// #1476 (T9): the hook layer is observe-only. The four enforcement/control
// hooks were excised; only the two lifecycle observers remain. See
// docs/adrs/2026-05-24-hook-layer-observe-only.md.
const ENFORCEMENT_HOOK_TYPES = ['PreToolUse', 'TaskCompleted', 'TeammateIdle', 'SubagentStart'];
const ENFORCEMENT_SUBCOMMANDS = ['guard', 'task-gate', 'teammate-gate', 'subagent-context'];
const OBSERVER_HOOK_TYPES = ['SubagentStop', 'SessionEnd'];

describe('hooks/hooks.json — observe-only (#1476)', () => {
  const hooksPath = join(repoRoot, 'hooks', 'hooks.json');

  it('HooksJson_Exists_IsValidJson', () => {
    expect(existsSync(hooksPath)).toBe(true);
    const raw = readFileSync(hooksPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('HooksJson_ContainsObserverHooksOnly', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const hookTypes = Object.keys(config.hooks);

    // Only the two observer hooks survive.
    for (const t of OBSERVER_HOOK_TYPES) {
      expect(hookTypes, `missing observer hook type: ${t}`).toContain(t);
    }

    // None of the enforcement/control hooks may remain.
    for (const t of ENFORCEMENT_HOOK_TYPES) {
      expect(hookTypes, `enforcement hook type still present: ${t}`).not.toContain(t);
    }

    // T-40 removals stay removed.
    expect(hookTypes).not.toContain('PreCompact');
    expect(hookTypes).not.toContain('SessionStart');
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

  it('HooksJson_AllCommands_UseExarchosNotNode', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const commands = collectCommands(config);

    // Observer set: SubagentStop + SessionEnd → at least 2 commands.
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

  it('HooksJson_EachObserverHook_InvokesExpectedSubcommand', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const expectedSubcommand: Record<string, string> = {
      SubagentStop: 'subagent-stop',
      SessionEnd: 'session-end',
    };

    for (const [hookType, subcommand] of Object.entries(expectedSubcommand)) {
      const entries = config.hooks[hookType];
      expect(entries, `hook type ${hookType} not present`).toBeDefined();
      const firstCommand = entries[0].hooks[0].command;
      expect(firstCommand, `${hookType} does not invoke subcommand '${subcommand}'`).toBe(
        `exarchos ${subcommand}`,
      );
    }
  });

  it('HooksJson_PreservesObserverMatcherAndTimeoutMetadata', () => {
    const config: HooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    expect(config.hooks.SubagentStop[0].matcher).toBe('exarchos-implementer|exarchos-fixer');
    expect(config.hooks.SessionEnd[0].matcher).toBe('auto');

    expect(config.hooks.SubagentStop[0].hooks[0].timeout).toBe(10);
    expect(config.hooks.SessionEnd[0].hooks[0].timeout).toBe(30);
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
  // After T9, no source file may reference the retired enforcement
  // subcommands or their deleted handler modules. We grep the tracked
  // source (excluding docs/historical artifacts, dist, node_modules, and
  // this test itself, which legitimately names them to assert absence).
  it('NoSourceReferences_ToRetiredEnforcementSubcommands', () => {
    const patterns = [
      'cli-commands/guard',
      'cli-commands/subagent-context',
      'handleGuard',
      'handleTaskGate',
      'handleTeammateGate',
      'handleSubagentContext',
    ];

    const offenders: string[] = [];
    for (const pattern of patterns) {
      let out = '';
      try {
        // `git grep` searches only tracked files; the pathspecs exclude
        // tests, docs, the changelog, and the generated dist tree.
        out = execFileSync(
          'git',
          [
            'grep',
            '-l',
            '-F',
            pattern,
            '--',
            'src/',
            'servers/exarchos-mcp/src/',
            'scripts/',
            ':!*.test.ts',
            ':!*.test.sh',
          ],
          { cwd: repoRoot, encoding: 'utf-8' },
        );
      } catch {
        // `git grep` exits 1 when there are no matches — that's the pass case.
        out = '';
      }
      const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const f of files) offenders.push(`${pattern} → ${f}`);
    }

    expect(offenders, `retired enforcement references linger:\n${offenders.join('\n')}`).toEqual([]);
  });
});
