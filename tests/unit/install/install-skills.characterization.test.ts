/**
 * Characterization tests for `installSkills()`. They pin the outputs that the
 * code gives now. They are regression oracles, not behavior specifications.
 *
 * The tests pin two surfaces:
 *   1. The local-copy targets: which skill directories `installSkills()` copies,
 *      and to which expanded destination. `installSkills()` creates the real
 *      destination root itself, so a temp dir stands in for `$HOME`. An injected
 *      `copyDir` recorder captures each skill copy.
 *   2. The JSON object that `registerExarchosInClaudeJson()` merges into
 *      `~/.claude.json`.
 *
 * The tests replace the absolute home path with a `<HOME>` token, so the pinned
 * values do not depend on the environment.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeMap } from '../../../src/install/runtimes/types.js';
import {
  installSkills,
  registerExarchosInClaudeJson,
  type SpawnResult,
} from '../../../src/install/install-skills.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/** Create a fresh, writable temp dir to stand in for `$HOME`. */
function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-home-'));
}

/** Build a normalizer that replaces each occurrence of `home` with a `<HOME>` token. */
function homeNormalizer(home: string): (value: string) => string {
  return (value: string) => value.split(home).join('<HOME>');
}

/**
 * Minimal valid runtime map factory (mirrors the unit-test factory). Overrides
 * vary only the field under characterization.
 */
function makeRuntime(overrides: Partial<RuntimeMap> = {}): RuntimeMap {
  return {
    name: 'claude',
    capabilities: {
      hasSubagents: true,
      hasSlashCommands: true,
      hasSkillChaining: true,
      mcpPrefix: 'mcp__plugin_exarchos_exarchos__',
    },
    skillsInstallPath: '~/.claude/skills',
    detection: {
      binaries: ['claude'],
      envVars: ['CLAUDE_CODE_SESSION'],
    },
    placeholders: {},
    ...overrides,
  };
}

/** Fake spawn. The local-copy path does not spawn, and the fake keeps a real `npx` launch out of the test. */
function fakeSpawn(): (cmd: string, args: string[]) => Promise<SpawnResult> {
  return vi.fn(async (): Promise<SpawnResult> => ({ code: 0, stderr: '' }));
}

/**
 * Build a temporary `skills/` source tree with one
 * `<root>/<runtime>/<skill>/SKILL.md` file for each skill. Return the source
 * root and a disposer.
 */
function makeSkillsSource(
  runtimeName: string,
  skills: string[],
): { skillsSource: string; dispose: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-skills-'));
  const skillsSource = path.join(tmp, 'skills');
  for (const skill of skills) {
    const dir = path.join(skillsSource, runtimeName, skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${skill}\n`, 'utf8');
  }
  return {
    skillsSource,
    dispose: () => rmrf(tmp),
  };
}

describe('install-skills characterization (DR-9, task 003)', () => {
  /**
   * Pins one `copyDir` call for each skill. The source is relative to the source
   * root, and the destination is `<HOME>/.claude/skills/<skill>`. It also pins
   * one MCP registration with the home dir. The copy order follows `readdir`, so
   * the test sorts the calls. `platform: 'linux'` and a no-op `symlink` select
   * the POSIX placement branch on each host. A real symlink needs elevated
   * privileges on Windows.
   */
  it('InstallSkills_LocalCopyAndRegister_PinnedWrites', async () => {
    const home = makeTmpHome();
    const normalizeHome = homeNormalizer(home);
    const { skillsSource, dispose } = makeSkillsSource('claude', [
      'beta-skill',
      'alpha-skill',
    ]);

    const copyDirCalls: Array<{ src: string; dest: string }> = [];
    const copyDir = (src: string, dest: string): void => {
      copyDirCalls.push({
        src: normalizeHome(src.slice(skillsSource.length)),
        dest: normalizeHome(dest),
      });
    };

    const registerCalls: string[] = [];
    const registerMcp = (h: string): void => {
      registerCalls.push(normalizeHome(h));
    };

    try {
      await installSkills({
        agent: 'claude',
        runtimes: [makeRuntime()],
        spawn: fakeSpawn(),
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource,
        copyDir,
        registerMcp,
        platform: 'linux',
        symlink: () => {},
      });
    } finally {
      dispose();
      rmrf(home);
    }

    const sortedCopies = [...copyDirCalls].sort((a, b) =>
      a.dest.localeCompare(b.dest),
    );
    expect(sortedCopies).toEqual([
      {
        src: `${path.sep}claude${path.sep}alpha-skill`,
        dest: `<HOME>${path.sep}.claude${path.sep}skills${path.sep}alpha-skill`,
      },
      {
        src: `${path.sep}claude${path.sep}beta-skill`,
        dest: `<HOME>${path.sep}.claude${path.sep}skills${path.sep}beta-skill`,
      },
    ]);

    expect(registerCalls).toEqual(['<HOME>']);
  });

  it('InstallSkills_LocalCopyNonClaude_DoesNotRegisterMcp', async () => {
    const home = makeTmpHome();
    const normalizeHome = homeNormalizer(home);
    const { skillsSource, dispose } = makeSkillsSource('codex', ['only-skill']);

    const copyDirCalls: Array<{ src: string; dest: string }> = [];
    const copyDir = (src: string, dest: string): void => {
      copyDirCalls.push({
        src: normalizeHome(src.slice(skillsSource.length)),
        dest: normalizeHome(dest),
      });
    };
    const registerCalls: string[] = [];
    const registerMcp = (h: string): void => {
      registerCalls.push(h);
    };

    try {
      await installSkills({
        agent: 'codex',
        runtimes: [
          makeRuntime({
            name: 'codex',
            skillsInstallPath: '~/.codex/skills',
            detection: { binaries: ['codex'], envVars: [] },
          }),
        ],
        spawn: fakeSpawn(),
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource,
        copyDir,
        registerMcp,
        platform: 'linux',
        symlink: () => {},
      });
    } finally {
      dispose();
      rmrf(home);
    }

    expect(copyDirCalls).toEqual([
      {
        src: `${path.sep}codex${path.sep}only-skill`,
        dest: `<HOME>${path.sep}.codex${path.sep}skills${path.sep}only-skill`,
      },
    ]);
    expect(registerCalls).toEqual([]);
  });

  /**
   * Pins the full text that `registerExarchosInClaudeJson` writes into a new
   * `~/.claude.json`: 2-space indent and a trailing newline. The file is JSON
   * text, so `JSON.stringify` doubles each backslash of a Windows home path. The
   * test escapes `home` in the same way before it replaces the path.
   */
  it('RegisterExarchosInClaudeJson_FreshHome_PinnedJsonShape', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-cj-'));
    try {
      registerExarchosInClaudeJson(home);
      const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
      const normalized = raw.split(home.replace(/\\/g, '\\\\')).join('<HOME>');

      const expected =
        JSON.stringify(
          {
            mcpServers: {
              exarchos: {
                type: 'stdio',
                command: 'exarchos',
                args: ['mcp'],
                env: {
                  WORKFLOW_STATE_DIR: path.join(
                    '<HOME>',
                    '.claude',
                    'workflow-state',
                  ),
                },
              },
            },
          },
          null,
          2,
        ) + '\n';

      expect(normalized).toBe(expected);
    } finally {
      rmrf(home);
    }
  });

  /**
   * The merge keeps the existing top-level keys and the sibling `mcpServers`
   * entries. It writes only `mcpServers.exarchos`.
   */
  it('RegisterExarchosInClaudeJson_ExistingConfig_MergesPreservingOthers', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-char-cj2-'));
    try {
      const existing = {
        numberOfStartups: 7,
        mcpServers: {
          'user-thing': { type: 'stdio', command: 'whatever' },
        },
      };
      fs.writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify(existing, null, 2),
        'utf8',
      );

      registerExarchosInClaudeJson(home);

      const parsed = JSON.parse(
        fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
      ) as Record<string, unknown>;
      const mcp = parsed.mcpServers as Record<string, unknown>;

      expect(parsed.numberOfStartups).toBe(7);
      expect(mcp['user-thing']).toEqual({ type: 'stdio', command: 'whatever' });
      expect(mcp.exarchos).toEqual({
        type: 'stdio',
        command: 'exarchos',
        args: ['mcp'],
        env: {
          WORKFLOW_STATE_DIR: path.join(home, '.claude', 'workflow-state'),
        },
      });
    } finally {
      rmrf(home);
    }
  });
});
