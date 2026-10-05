/**
 * Unit tests for `installSkills()` and its provenance helpers.
 *
 * The tests inject spawn, log, errLog and homeDir, so no test starts a child
 * process. The runtime fixtures are in-memory `RuntimeMap` values, and no test
 * reads `content/harness/runtimes/`. A test that writes files uses a temp
 * directory.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeMap } from '../../../src/install/runtimes/types.js';
import {
  createDefaultSpawn,
  installSkills,
  mapRuntimeToSkillsCliAgent,
  registerExarchosInClaudeJson,
  detectLayoutDrift,
  resolveSkillsManifestPath,
  hashSkillMdContent,
  hashSkillMdFile,
  hashSkillDirContent,
  indexLegacyHashesBySkill,
  loadLegacyHashIndex,
  findLegacyHashManifestPath,
  installManifestVouchesForDir,
  type SkillsProvenanceManifest,
  type LegacySkillRenderManifest,
  type SpawnResult,
} from '../../../src/install/install-skills.js';
import { normalizeAndHash } from '../../../tools/release/generate-legacy-skill-hashes.mjs';
import { expandTilde } from '../../../src/install/install-skills.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import type { ChildSpawn } from '../../../src/utils/process.js';

/**
 * Minimal valid runtime map factory for unit-test use. Overrides let each
 * test vary only the field it cares about without repeating boilerplate.
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

const CLAUDE = makeRuntime();
const CODEX = makeRuntime({
  name: 'codex',
  skillsInstallPath: '~/.codex/skills',
  detection: { binaries: ['codex'], envVars: [] },
});
const GENERIC = makeRuntime({
  name: 'generic',
  skillsInstallPath: './.skills',
  detection: { binaries: [], envVars: [] },
});

const ALL_RUNTIMES: RuntimeMap[] = [CLAUDE, CODEX, GENERIC];

/**
 * Build a fake spawn that records its invocation and returns a successful exit
 * (`code: 0`) by default. Tests that need failure inject their own.
 */
function fakeSpawn(result: SpawnResult = { code: 0, stderr: '' }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = vi.fn(async (cmd: string, args: string[]): Promise<SpawnResult> => {
    calls.push({ cmd, args });
    return result;
  });
  return { fn, calls };
}

describe('installSkills scaffold (task 019)', () => {
  /** The `--agent claude-code` argument proves that runtime resolution selected the claude runtime. */
  it('InstallSkills_WithAgentFlag_LoadsMatchingRuntime', async () => {
    const spawn = fakeSpawn();
    const logs: string[] = [];

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn: spawn.fn,
      log: (msg) => logs.push(msg),
      homeDir: () => '/home/tester',
      registerMcp: () => {},
    });

    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0].args;
    const agentIdx = args.indexOf('--agent');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(args[agentIdx + 1]).toBe('claude-code');
  });

  /** The flags make the upstream `skills` CLI install each skill for the agent with no prompt. */
  it('InstallSkills_WithAgentFlag_ConstructsCorrectNpxCommand', async () => {
    const spawn = fakeSpawn();

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn: spawn.fn,
      log: () => {},
      homeDir: () => '/home/tester',
      registerMcp: () => {},
    });

    expect(spawn.calls).toHaveLength(1);
    const { cmd, args } = spawn.calls[0];
    expect(cmd).toBe('npx');
    expect(args).toEqual([
      '--yes',
      'skills',
      'add',
      'github:lvlup-sw/exarchos',
      '--skill',
      '*',
      '--agent',
      'claude-code',
      '-y',
      '-g',
      '--copy',
    ]);
  });

  it('InstallSkills_WithAgentFlag_PrintsCommandBeforeExecuting', async () => {
    const events: Array<{ kind: 'log' | 'spawn'; payload: string }> = [];
    const spawn = vi.fn(async (cmd: string, args: string[]): Promise<SpawnResult> => {
      events.push({ kind: 'spawn', payload: `${cmd} ${args.join(' ')}` });
      return { code: 0, stderr: '' };
    });
    const log = (msg: string) => events.push({ kind: 'log', payload: msg });

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn,
      log,
      homeDir: () => '/home/tester',
      registerMcp: () => {},
    });

    const logIdx = events.findIndex(
      (e) =>
        e.kind === 'log' &&
        e.payload.includes('npx') &&
        e.payload.includes('skills') &&
        e.payload.includes('add'),
    );
    const spawnIdx = events.findIndex((e) => e.kind === 'spawn');
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeLessThan(spawnIdx);
  });

  /**
   * `--target` is not a flag of the upstream `skills` CLI. The install passes
   * `--agent <id>`, and `mapRuntimeToSkillsCliAgent` gives the id.
   */
  it('InstallSkills_WithAgentFlag_MapsRuntimeToUpstreamAgentId', async () => {
    const spawn = fakeSpawn();

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn: spawn.fn,
      log: () => {},
      homeDir: () => '/home/alice',
      registerMcp: () => {},
    });

    const args = spawn.calls[0].args;
    const agentIdx = args.indexOf('--agent');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(args[agentIdx + 1]).toBe('claude-code');
    expect(args).not.toContain('--target');
  });

  it('InstallSkills_UnknownAgent_ThrowsWithSupportedList', async () => {
    const spawn = fakeSpawn();

    await expect(
      installSkills({
        agent: 'nonesuch',
        runtimes: ALL_RUNTIMES,
        spawn: spawn.fn,
        log: () => {},
        homeDir: () => '/home/tester',
      }),
    ).rejects.toThrow(/Unknown runtime.*nonesuch/);

    expect(spawn.calls).toHaveLength(0);

    let caught: unknown;
    try {
      await installSkills({
        agent: 'nonesuch',
        runtimes: ALL_RUNTIMES,
        spawn: spawn.fn,
        log: () => {},
        homeDir: () => '/home/tester',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('claude');
    expect(msg).toContain('codex');
    expect(msg).toContain('generic');
  });
});

describe('installSkills error handling (task 021)', () => {
  /** The error carries the exit code of the child, so the CLI can exit with it. */
  it('InstallSkills_NpxFailure_ExitsWithChildCode', async () => {
    const spawn = vi.fn(async (): Promise<SpawnResult> => ({
      code: 2,
      stderr: 'boom',
    }));
    let caught: unknown;
    try {
      await installSkills({
        agent: 'claude',
        runtimes: ALL_RUNTIMES,
        spawn,
        log: () => {},
        errLog: () => {},
        homeDir: () => '/home/tester',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { exitCode?: number }).exitCode).toBe(2);
  });

  it('InstallSkills_NpxFailure_PrintsExactCommandForRetry', async () => {
    const spawn = vi.fn(async (): Promise<SpawnResult> => ({
      code: 1,
      stderr: 'nope',
    }));
    const errLines: string[] = [];
    try {
      await installSkills({
        agent: 'claude',
        runtimes: ALL_RUNTIMES,
        spawn,
        log: () => {},
        errLog: (msg) => errLines.push(msg),
        homeDir: () => '/home/tester',
      });
    } catch {
    }
    const joined = errLines.join('\n');
    expect(joined).toContain(
      'npx --yes skills add github:lvlup-sw/exarchos --skill * --agent claude-code -y -g --copy',
    );
  });

  /**
   * Two runtimes match through PATH and none through the environment.
   * Interactive mode calls the injected prompt to select one.
   */
  it('InstallSkills_AmbiguousDetection_InteractivePrompt', async () => {
    const spawn = fakeSpawn();
    const prompt = vi.fn(async (_q: string, choices: string[]) => {
      expect(choices).toEqual(expect.arrayContaining(['claude', 'codex']));
      return 'claude';
    });

    await installSkills({
      runtimes: ALL_RUNTIMES,
      spawn: spawn.fn,
      log: () => {},
      errLog: () => {},
      homeDir: () => '/home/tester',
      isInteractive: true,
      prompt,
      registerMcp: () => {},
      detectDeps: {
        which: (cmd) =>
          cmd === 'claude' || cmd === 'codex' ? `/fake/bin/${cmd}` : null,
        env: {},
      },
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0].args;
    const agentIdx = args.indexOf('--agent');
    expect(args[agentIdx + 1]).toBe('claude-code');
  });

  /** The error or the `errLog` output must name `--agent` as the remedy. */
  it('InstallSkills_AmbiguousDetection_NonInteractiveExitsNonZero', async () => {
    const spawn = fakeSpawn();
    const errLines: string[] = [];

    let caught: unknown;
    try {
      await installSkills({
        runtimes: ALL_RUNTIMES,
        spawn: spawn.fn,
        log: () => {},
        errLog: (msg) => errLines.push(msg),
        homeDir: () => '/home/tester',
        isInteractive: false,
        detectDeps: {
          which: (cmd) =>
            cmd === 'claude' || cmd === 'codex' ? `/fake/bin/${cmd}` : null,
          env: {},
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const combined = `${(caught as Error).message}\n${errLines.join('\n')}`;
    expect(combined).toContain('--agent');
    expect(spawn.calls).toHaveLength(0);
  });

  it('InstallSkills_UnknownRuntimeFlag_PrintsSupportedList', async () => {
    const spawn = fakeSpawn();
    let caught: unknown;
    try {
      await installSkills({
        agent: 'bogus',
        runtimes: ALL_RUNTIMES,
        spawn: spawn.fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => '/home/tester',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    for (const r of ALL_RUNTIMES) {
      expect(msg).toContain(r.name);
    }
    expect(msg).toContain('bogus');
  });

  /** The stderr text of the failed spawn must reach `errLog` unchanged. */
  it('InstallSkills_NetworkError_PropagatesStderrVerbatim', async () => {
    const STDERR =
      'npm ERR! code ENOTFOUND\nnpm ERR! network request to https://... failed\n';
    const spawn = vi.fn(async (): Promise<SpawnResult> => ({
      code: 1,
      stderr: STDERR,
    }));
    const errLines: string[] = [];
    try {
      await installSkills({
        agent: 'claude',
        runtimes: ALL_RUNTIMES,
        spawn,
        log: () => {},
        errLog: (msg) => errLines.push(msg),
        homeDir: () => '/home/tester',
      });
    } catch {
    }
    const joined = errLines.join('\n');
    expect(joined).toContain(STDERR);
  });

  /** The `generic` runtime maps to the upstream `universal` agent. */
  it('InstallSkills_NoDetectedAgent_InstallsGenericWithMessage', async () => {
    const spawn = fakeSpawn();
    const logs: string[] = [];

    await installSkills({
      runtimes: ALL_RUNTIMES,
      spawn: spawn.fn,
      log: (msg) => logs.push(msg),
      errLog: () => {},
      homeDir: () => '/home/tester',
      isInteractive: false,
      detectDeps: { which: () => null, env: {} },
    });

    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0].args;
    const agentIdx = args.indexOf('--agent');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(args[agentIdx + 1]).toBe('universal');

    const joined = logs.join('\n');
    expect(joined.toLowerCase()).toContain('no agent detected');
    expect(joined.toLowerCase()).toContain('generic');
  });
});

describe('mapRuntimeToSkillsCliAgent (#1217)', () => {
  it('mapRuntimeToSkillsCliAgent_claude_returnsClaudeCode', () => {
    expect(mapRuntimeToSkillsCliAgent('claude')).toBe('claude-code');
  });
  it('mapRuntimeToSkillsCliAgent_copilot_returnsGithubCopilot', () => {
    expect(mapRuntimeToSkillsCliAgent('copilot')).toBe('github-copilot');
  });
  it('mapRuntimeToSkillsCliAgent_generic_returnsUniversal', () => {
    expect(mapRuntimeToSkillsCliAgent('generic')).toBe('universal');
  });
  it('mapRuntimeToSkillsCliAgent_codex_passesThrough', () => {
    expect(mapRuntimeToSkillsCliAgent('codex')).toBe('codex');
  });
  /** A name with no mapping passes through, so a new runtime works when its name is an upstream agent ID. */
  it('mapRuntimeToSkillsCliAgent_unknown_passesThrough', () => {
    expect(mapRuntimeToSkillsCliAgent('zencoder')).toBe('zencoder');
  });
});

describe('registerExarchosInClaudeJson (#1217)', () => {
  function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-claudejson-'));
  }

  it('registerExarchosInClaudeJson_emptyHome_writesFreshFile', () => {
    const home = makeTmpHome();
    try {
      registerExarchosInClaudeJson(home);
      const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toMatchObject({
        mcpServers: {
          exarchos: {
            type: 'stdio',
            command: 'exarchos',
            args: ['mcp'],
            env: {
              WORKFLOW_STATE_DIR: path.join(home, '.claude', 'workflow-state'),
            },
          },
        },
      });
    } finally {
      rmrf(home);
    }
  });

  it('registerExarchosInClaudeJson_existingUserServers_arePreserved', () => {
    const home = makeTmpHome();
    try {
      const existing = {
        mcpServers: {
          'user-thing': { type: 'stdio', command: 'whatever' },
        },
        somethingElse: 42,
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
      expect((parsed.mcpServers as Record<string, unknown>)['user-thing']).toEqual({
        type: 'stdio',
        command: 'whatever',
      });
      expect((parsed.mcpServers as Record<string, unknown>).exarchos).toBeDefined();
      expect(parsed.somethingElse).toBe(42);
    } finally {
      rmrf(home);
    }
  });

  /** The test waits 20 ms before the second call, so a second write gives a different `mtimeMs`. */
  it('registerExarchosInClaudeJson_idempotent_secondCallPreservesMtime', async () => {
    const home = makeTmpHome();
    try {
      registerExarchosInClaudeJson(home);
      const configPath = path.join(home, '.claude.json');
      const beforeMtime = fs.statSync(configPath).mtimeMs;

      await new Promise((r) => setTimeout(r, 20));

      registerExarchosInClaudeJson(home);
      const afterMtime = fs.statSync(configPath).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    } finally {
      rmrf(home);
    }
  });
});

/**
 * When a runtime declares `commandsInstallPath` and a `command-aliases/<runtime>/`
 * source tree exists, the install copies the alias files into the expanded
 * commands directory. Then it prints the skills destination, the commands
 * destination and a restart hint. The gate is those two conditions, never a
 * runtime name.
 *
 * `OPENCODE` declares `commandsInstallPath`, as `content/harness/runtimes/opencode.yaml`
 * does. `makeAliasFixture` builds a skills tree with one skill and an alias tree
 * with two files.
 */
describe('installSkills command aliases (T3, #1471/#1472)', () => {
  const OPENCODE = makeRuntime({
    name: 'opencode',
    capabilities: {
      hasSubagents: true,
      hasSlashCommands: true,
      hasSkillChaining: false,
      mcpPrefix: 'mcp__exarchos__',
      canonicalCommandAliases: true,
    },
    skillsInstallPath: '~/.config/opencode/skills',
    commandsInstallPath: '~/.config/opencode/commands',
    detection: { binaries: ['opencode'], envVars: [] },
  });

  function makeAliasFixture(runtimeName: string): {
    skillsSource: string;
    aliasesSource: string;
    aliasFiles: string[];
    dispose: () => void;
  } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-aliases-'));
    const skillsSource = path.join(tmp, 'skills');
    const aliasesSource = path.join(tmp, 'command-aliases');

    const skillDir = path.join(skillsSource, runtimeName, 'sample-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# sample\n', 'utf8');

    const aliasDir = path.join(aliasesSource, runtimeName);
    fs.mkdirSync(aliasDir, { recursive: true });
    const aliasFiles = ['ideate.md', 'plan.md'];
    for (const f of aliasFiles) {
      fs.writeFileSync(path.join(aliasDir, f), `---\ndescription: ${f}\n---\n`, 'utf8');
    }

    return {
      skillsSource,
      aliasesSource,
      aliasFiles,
      dispose: () => rmrf(tmp),
    };
  }

  it('InstallSkills_OpencodeWithCommandsPath_CopiesAliasFiles', async () => {
    const fx = makeAliasFixture('opencode');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-home-'));
    try {
      await installSkills({
        agent: 'opencode',
        runtimes: [OPENCODE],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: fx.skillsSource,
        aliasesSource: fx.aliasesSource,
        registerMcp: () => {},
      });

      const destDir = expandTilde('~/.config/opencode/commands', home);
      for (const f of fx.aliasFiles) {
        expect(fs.existsSync(path.join(destDir, f))).toBe(true);
      }
    } finally {
      fx.dispose();
      rmrf(home);
    }
  });

  /**
   * With no `skillsSource`, the skills install through `npx skills add`. The
   * alias install runs after that branch too.
   */
  it('InstallSkills_OpencodeShellOutPath_StillCopiesAliasFiles', async () => {
    const fx = makeAliasFixture('opencode');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-home-'));
    try {
      await installSkills({
        agent: 'opencode',
        runtimes: [OPENCODE],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: undefined,
        aliasesSource: fx.aliasesSource,
        registerMcp: () => {},
      });

      const destDir = expandTilde('~/.config/opencode/commands', home);
      for (const f of fx.aliasFiles) {
        expect(fs.existsSync(path.join(destDir, f))).toBe(true);
      }
    } finally {
      fx.dispose();
      rmrf(home);
    }
  });

  /** The runtime has no `commandsInstallPath`, so the install must not copy the alias tree for `generic`. */
  it('InstallSkills_RuntimeWithoutCommandsPath_WritesNoAliasFiles', async () => {
    const fx = makeAliasFixture('generic');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-home-'));
    const GENERIC_NO_CMDS = makeRuntime({
      name: 'generic',
      skillsInstallPath: '~/.agents/skills',
      detection: { binaries: [], envVars: [] },
    });
    try {
      await installSkills({
        agent: 'generic',
        runtimes: [GENERIC_NO_CMDS],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: fx.skillsSource,
        aliasesSource: fx.aliasesSource,
        registerMcp: () => {},
      });

      const commandsRoot = path.join(home, '.config', 'opencode', 'commands');
      expect(fs.existsSync(commandsRoot)).toBe(false);
      const genericCmds = expandTilde('~/.agents/commands', home);
      expect(fs.existsSync(genericCmds)).toBe(false);
    } finally {
      fx.dispose();
      rmrf(home);
    }
  });

  it('InstallSkills_Opencode_PrintsDestinationsAndRestartHint', async () => {
    const fx = makeAliasFixture('opencode');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-home-'));
    const logs: string[] = [];
    try {
      await installSkills({
        agent: 'opencode',
        runtimes: [OPENCODE],
        spawn: fakeSpawn().fn,
        log: (msg) => logs.push(msg),
        errLog: () => {},
        homeDir: () => home,
        skillsSource: fx.skillsSource,
        aliasesSource: fx.aliasesSource,
        registerMcp: () => {},
      });

      const joined = logs.join('\n');
      const skillsDest = expandTilde('~/.config/opencode/skills', home);
      const cmdsDest = expandTilde('~/.config/opencode/commands', home);
      expect(joined).toContain(skillsDest);
      expect(joined).toContain(cmdsDest);
      expect(joined.toLowerCase()).toContain('restart');
    } finally {
      fx.dispose();
      rmrf(home);
    }
  });
});

/**
 * The canonical skill set is the procedural skills in `skills/standard/` and the
 * orchestration skills of the runtime in `skills/<runtime>/`. The install places
 * the set at the cross-client path (`~/.agents/skills` for user scope) and in
 * the native dir of the harness. On `win32` the cross-client entry is a file
 * copy, never a symlink. Each install updates the provenance manifest of the
 * scope, and `detectLayoutDrift` reports a changed copy and writes nothing.
 *
 * `makeSkillsTree` writes a real source tree, so placement and hashing use the
 * filesystem.
 */
describe('installSkills canonical layout + provenance (Task 010, DR-4/DR-8)', () => {
  const IS_WIN = process.platform === 'win32';

  function makeSkillsTree(spec: {
    standard: string[];
    runtimes: Record<string, string[]>;
  }): { skillsSource: string; dispose: () => void } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-canon-src-'));
    const skillsSource = path.join(tmp, 'skills');
    const writeSkill = (parent: string, name: string): void => {
      const dir = path.join(skillsSource, parent, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`, 'utf8');
    };
    for (const p of spec.standard) writeSkill('standard', p);
    for (const [rt, skills] of Object.entries(spec.runtimes)) {
      for (const s of skills) writeSkill(rt, s);
    }
    return { skillsSource, dispose: () => rmrf(tmp) };
  }

  function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-canon-home-'));
  }

  /** On POSIX each canonical entry is a symlink to the native copy. The win32 copy has its own test. */
  it('installSkills_CanonicalLayout_PlacesAgentsSkillsDir', async () => {
    const src = makeSkillsTree({ standard: ['plan'], runtimes: { claude: ['ideate'] } });
    const home = makeTmpHome();
    try {
      await installSkills({
        agent: 'claude',
        runtimes: [CLAUDE],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: src.skillsSource,
        registerMcp: () => {},
        version: 'test-1.0.0',
      });

      const nativeDir = expandTilde('~/.claude/skills', home);
      expect(fs.existsSync(path.join(nativeDir, 'plan', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(nativeDir, 'ideate', 'SKILL.md'))).toBe(true);

      const canonicalDir = expandTilde('~/.agents/skills', home);
      expect(fs.existsSync(path.join(canonicalDir, 'plan', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(canonicalDir, 'ideate', 'SKILL.md'))).toBe(true);

      if (!IS_WIN) {
        expect(fs.lstatSync(path.join(canonicalDir, 'plan')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(canonicalDir, 'ideate')).isSymbolicLink()).toBe(true);
      }
    } finally {
      src.dispose();
      rmrf(home);
    }
  });

  /**
   * The test injects `platform: 'win32'`. Recorders for `copyDir` and `symlink`
   * show which one ran for each placement.
   */
  it('installSkills_Win32_UsesCopyNotSymlink', async () => {
    const src = makeSkillsTree({ standard: ['plan'], runtimes: { claude: ['ideate'] } });
    const home = makeTmpHome();
    const copyCalls: Array<{ src: string; dest: string }> = [];
    const symlinkCalls: Array<{ target: string; link: string }> = [];
    try {
      await installSkills({
        agent: 'claude',
        runtimes: [CLAUDE],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: src.skillsSource,
        registerMcp: () => {},
        version: 'test-1.0.0',
        platform: 'win32',
        copyDir: (s, d) => copyCalls.push({ src: s, dest: d }),
        symlink: (t, l) => symlinkCalls.push({ target: t, link: l }),
      });

      expect(symlinkCalls).toHaveLength(0);
      const canonicalDir = expandTilde('~/.agents/skills', home);
      const copiedIntoCanonical = copyCalls.some((c) => c.dest.startsWith(canonicalDir));
      expect(copiedIntoCanonical).toBe(true);
      const nativeDir = expandTilde('~/.claude/skills', home);
      const copiedIntoNative = copyCalls.some((c) => c.dest.startsWith(nativeDir));
      expect(copiedIntoNative).toBe(true);
    } finally {
      src.dispose();
      rmrf(home);
    }
  });

  /**
   * The manifest lists the canonical and native placements of the harness, with
   * a content hash for each skill. A second install into the same scope merges
   * into the manifest, so the native placements of both harnesses stay.
   */
  it('installSkills_EveryInstall_WritesScopedProvenanceManifest', async () => {
    const src = makeSkillsTree({
      standard: ['plan'],
      runtimes: { claude: ['ideate'], codex: ['refactor'] },
    });
    const home = makeTmpHome();
    try {
      await installSkills({
        agent: 'claude',
        runtimes: [CLAUDE, CODEX],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: src.skillsSource,
        registerMcp: () => {},
        version: 'test-9.9.9',
      });

      const manifestPath = resolveSkillsManifestPath('user', home, home);
      expect(fs.existsSync(manifestPath)).toBe(true);
      const m1 = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SkillsProvenanceManifest;

      expect(m1.schema).toBe('exarchos-skills-provenance/v1');
      expect(m1.version).toBe('test-9.9.9');
      expect(m1.scope).toBe('user');
      expect(m1.skills).toEqual(expect.arrayContaining(['ideate', 'plan']));

      const claudeNative = m1.placements.find(
        (p) => p.harness === 'claude' && p.kind === 'native',
      );
      expect(claudeNative).toBeDefined();
      expect(Object.keys(claudeNative!.hashes).sort()).toEqual(['ideate', 'plan']);
      expect(m1.placements.some((p) => p.harness === 'claude' && p.kind === 'canonical')).toBe(
        true,
      );

      await installSkills({
        agent: 'codex',
        runtimes: [CLAUDE, CODEX],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: src.skillsSource,
        registerMcp: () => {},
        version: 'test-9.9.9',
      });

      const m2 = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SkillsProvenanceManifest;
      const nativeHarnesses = m2.placements
        .filter((p) => p.kind === 'native')
        .map((p) => p.harness);
      expect(nativeHarnesses).toEqual(expect.arrayContaining(['claude', 'codex']));
      expect(m2.skills).toEqual(expect.arrayContaining(['ideate', 'plan', 'refactor']));
    } finally {
      src.dispose();
      rmrf(home);
    }
  });

  /**
   * A new install reports no drift. Then the test appends to a skill file at the
   * canonical path. On POSIX that write goes through the symlink to the native
   * copy.
   */
  it('doctor_CanonicalCopyStale_ReportsDrift', async () => {
    const src = makeSkillsTree({ standard: ['plan'], runtimes: { claude: ['ideate'] } });
    const home = makeTmpHome();
    try {
      await installSkills({
        agent: 'claude',
        runtimes: [CLAUDE],
        spawn: fakeSpawn().fn,
        log: () => {},
        errLog: () => {},
        homeDir: () => home,
        skillsSource: src.skillsSource,
        registerMcp: () => {},
        version: 'test-1.0.0',
      });

      expect(detectLayoutDrift({ scope: 'user', home, projectRoot: home })).toEqual([]);

      const canonicalSkill = path.join(expandTilde('~/.agents/skills', home), 'plan', 'SKILL.md');
      fs.appendFileSync(canonicalSkill, '\nlocally edited\n', 'utf8');

      const findings = detectLayoutDrift({ scope: 'user', home, projectRoot: home });
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.skill === 'plan' && f.drift === 'modified')).toBe(true);
    } finally {
      src.dispose();
      rmrf(home);
    }
  });
});

describe('legacy-render + install-manifest provenance helpers', () => {
  /**
   * `hashSkillMdContent` must equal `normalizeAndHash` of the legacy hash
   * generator. CRLF must hash as LF, so an install from a Windows checkout
   * matches the committed legacy manifest.
   */
  it('hashSkillMdContent_MatchesLegacyGeneratorNormalizeAndHash', () => {
    const lf = '# ideate\n\nOrient the workflow.\n';
    const crlf = lf.replace(/\n/g, '\r\n');

    expect(hashSkillMdContent(lf)).toBe(normalizeAndHash(lf));
    expect(hashSkillMdContent(crlf)).toBe(hashSkillMdContent(lf));
    expect(hashSkillMdContent(crlf)).toBe(normalizeAndHash(crlf));
  });

  /** The file on disk holds CRLF. A directory with no `SKILL.md` gives `undefined`. */
  it('hashSkillMdFile_ReadsSkillMd_NormalizesCrlf', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmd-'));
    try {
      const lf = '# delegate\n\nDelegate to sub-agents.\n';
      fs.mkdirSync(path.join(dir, 'delegation'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'delegation', 'SKILL.md'),
        lf.replace(/\n/g, '\r\n'),
        'utf8',
      );
      expect(hashSkillMdFile(path.join(dir, 'delegation'))).toBe(hashSkillMdContent(lf));
      fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
      expect(hashSkillMdFile(path.join(dir, 'empty'))).toBeUndefined();
    } finally {
      rmrf(dir);
    }
  });

  it('indexLegacyHashesBySkill_UnionsHashesAcrossRuntimesAndReleases', () => {
    const manifest: LegacySkillRenderManifest = {
      algorithm: 'sha256',
      normalization: 'crlf-to-lf',
      scope: 'all-skill-renders',
      source: 'git-history',
      minRelease: 'v2.9.0',
      releases: ['v2.9.0', 'v2.10.0'],
      entries: [
        { release: 'v2.9.0', runtime: 'claude', skill: 'brainstorming', path: 'p1', hash: 'h1' },
        { release: 'v2.9.0', runtime: 'codex', skill: 'brainstorming', path: 'p2', hash: 'h2' },
        { release: 'v2.10.0', runtime: 'claude', skill: 'brainstorming', path: 'p3', hash: 'h3' },
        { release: 'v2.9.0', runtime: 'claude', skill: 'delegation', path: 'p4', hash: 'h4' },
      ],
    };
    const index = indexLegacyHashesBySkill(manifest);
    expect(index.get('brainstorming')).toEqual(new Set(['h1', 'h2', 'h3']));
    expect(index.get('delegation')).toEqual(new Set(['h4']));
    expect(index.get('nonexistent')).toBeUndefined();
  });

  /**
   * The test reads the committed legacy manifest, which must index the skills
   * that the rename migration targets. An absent manifest path gives `undefined`,
   * and the migration then keeps the directories.
   */
  it('loadLegacyHashIndex_ParsesRealCommittedManifest', () => {
    const manifestPath = findLegacyHashManifestPath();
    expect(manifestPath).toBeDefined();

    const index = loadLegacyHashIndex();
    expect(index).toBeDefined();
    expect((index!.get('brainstorming')?.size ?? 0)).toBeGreaterThan(0);
    expect((index!.get('delegation')?.size ?? 0)).toBeGreaterThan(0);
    expect((index!.get('workflow-state')?.size ?? 0)).toBeGreaterThan(0);

    const someHash = [...index!.get('brainstorming')!][0];
    expect(someHash).toMatch(/^[0-9a-f]{64}$/);

    expect(loadLegacyHashIndex({ manifestPath: path.join(os.tmpdir(), 'nope.json') })).toBeUndefined();
  });

  /** A different hash for the skill, or a skill that the manifest does not record, gives `false`. */
  it('installManifestVouchesForDir_MatchesRecordedWholeDirHash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provdir-'));
    try {
      fs.mkdirSync(path.join(dir, 'synthesis'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'synthesis', 'SKILL.md'), '# synthesis\n', 'utf8');
      const dirHash = hashSkillDirContent(path.join(dir, 'synthesis'));

      const manifest: SkillsProvenanceManifest = {
        schema: 'exarchos-skills-provenance/v1',
        version: '2.11.0',
        scope: 'user',
        generatedAt: new Date().toISOString(),
        skills: ['synthesis'],
        placements: [
          { harness: 'claude', kind: 'native', path: dir, hashes: { synthesis: dirHash } },
        ],
      };

      expect(installManifestVouchesForDir([manifest], 'synthesis', dirHash)).toBe(true);
      expect(installManifestVouchesForDir([manifest], 'synthesis', 'deadbeef')).toBe(false);
      expect(installManifestVouchesForDir([manifest], 'discovery', dirHash)).toBe(false);
    } finally {
      rmrf(dir);
    }
  });
});

/**
 * A {@link ChildSpawn} double for {@link createDefaultSpawn}. It records each launch, and the child
 * closes with exit code 0 and no stderr.
 */
function recordingChildSpawn(): {
  readonly calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>;
  readonly spawn: ChildSpawn;
} {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn: ChildSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    setImmediate(() => child.emit('close', 0));
    return child as unknown as ChildProcess;
  };
  return { calls, spawn };
}

describe('installSkills default spawn', () => {
  it('InstallSkills_DefaultSpawnOnWin32_RunsTheNpxShimThroughTheShell', async () => {
    const recorder = recordingChildSpawn();

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn: createDefaultSpawn({ platform: 'win32', spawn: recorder.spawn }),
      log: () => {},
      homeDir: () => '/home/tester',
      registerMcp: () => {},
    });

    expect(recorder.calls).toEqual([
      {
        command: 'npx',
        args: expect.arrayContaining(['github:lvlup-sw/exarchos']),
        options: expect.objectContaining({
          shell: true,
          stdio: ['inherit', 'inherit', 'pipe'],
          env: expect.objectContaining({ FORCE_COLOR: '0', CI: 'true' }),
        }),
      },
    ]);
  });

  it('InstallSkills_DefaultSpawnOnPosix_RunsNpxWithNoShell', async () => {
    const recorder = recordingChildSpawn();

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn: createDefaultSpawn({ platform: 'linux', spawn: recorder.spawn }),
      log: () => {},
      homeDir: () => '/home/tester',
      registerMcp: () => {},
    });

    expect(recorder.calls.map((call) => call.command)).toEqual(['npx']);
    expect(recorder.calls.map((call) => call.options.shell)).toEqual([undefined]);
    expect(recorder.calls.flatMap((call) => call.args)).toContain('github:lvlup-sw/exarchos');
  });

  /**
   * A runtime name is caller data, and on win32 the launch goes through `cmd.exe`. A `&` in the agent
   * ID starts a second command there, so the installer must refuse the name before any launch.
   */
  it('InstallSkills_AgentIdWithShellMetacharacter_RefusesBeforeAnyLaunch', async () => {
    const recorder = recordingChildSpawn();
    const unsafe = makeRuntime({ name: 'x&calc', skillsInstallPath: '~/.x/skills' });

    await expect(
      installSkills({
        agent: 'x&calc',
        runtimes: [unsafe],
        spawn: createDefaultSpawn({ platform: 'win32', spawn: recorder.spawn }),
        log: () => {},
        homeDir: () => '/home/tester',
        registerMcp: () => {},
      }),
    ).rejects.toThrow('is not a valid skills agent ID');
    expect(recorder.calls).toEqual([]);
  });
});
