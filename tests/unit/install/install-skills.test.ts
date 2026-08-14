/**
 * Unit tests for the `installSkills()` function.
 *
 * All side effects (spawn, log, errLog, homeDir) are injected so the tests are
 * deterministic: no child processes, no filesystem, no environment leakage.
 *
 * Fixtures are built as in-memory `RuntimeMap` arrays and passed via the
 * `runtimes` dep — we do not touch the `content/harness/runtimes/` directory on disk.
 *
 * Implements: DR-7 (install-skills CLI scaffold), DR-9 (docs), DR-10 (errors).
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeMap } from '../../../src/install/runtimes/types.js';
import {
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
// Boundary check (Task 011): the migration's newline-normalized SKILL.md hash
// MUST equal the Task 023 generator's `normalizeAndHash`, so a CRLF-checkout
// install hash-matches the committed legacy manifest.
import { normalizeAndHash } from '../../../tools/release/generate-legacy-skill-hashes.mjs';
import { expandTilde } from '../../../src/install/install-skills.js';

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

    // After the #1217 non-interactive fix, spawn must include the upstream
    // skills CLI agent identifier (claude → claude-code) and the
    // non-interactive flag set. Asserting `--agent claude-code` is enough
    // to prove runtime resolution drove the correct argv.
    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0].args;
    const agentIdx = args.indexOf('--agent');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(args[agentIdx + 1]).toBe('claude-code');
  });

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
    // Post-#1217 argv: non-interactive flags drive the upstream `skills`
    // CLI to install every skill into the claude-code agent home without
    // any prompts. `--target`/`skills/<name>` were never valid upstream
    // flags and have been removed.
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

    // Find the log line that contains the command and assert it precedes
    // the spawn invocation.
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

  it('InstallSkills_WithAgentFlag_MapsRuntimeToUpstreamAgentId', async () => {
    // Post-#1217: `--target` is not a valid upstream `skills` CLI flag
    // (it was always silently ignored). The fix routes installs through
    // `--agent <id>` instead, where <id> is the upstream agent identifier
    // mapped from our internal runtime name.
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
    // claude → claude-code per mapRuntimeToSkillsCliAgent.
    expect(args[agentIdx + 1]).toBe('claude-code');
    // Sanity: the dead `--target` flag really is gone.
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

    // Spawn must not have been called.
    expect(spawn.calls).toHaveLength(0);

    // Error message must name every supported runtime.
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

// ─── Task 021 — error handling and interactive/non-interactive modes ─────────

describe('installSkills error handling (task 021)', () => {
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
    // The thrown Error should carry the child's exit code so the CLI main()
    // can call process.exit with it.
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
      /* expected */
    }
    // Exact command for manual retry must appear in errLog output.
    const joined = errLines.join('\n');
    expect(joined).toContain(
      'npx --yes skills add github:lvlup-sw/exarchos --skill * --agent claude-code -y -g --copy',
    );
  });

  it('InstallSkills_AmbiguousDetection_InteractivePrompt', async () => {
    // Two runtimes match via PATH, none via env. Interactive mode should
    // call the injected prompt to disambiguate.
    const spawn = fakeSpawn();
    const prompt = vi.fn(async (_q: string, choices: string[]) => {
      // Sanity: the choices include both ambiguous candidates.
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
    // Post-#1217: `skills/claude` positional is gone; agent identity is
    // now expressed through `--agent claude-code`.
    const args = spawn.calls[0].args;
    const agentIdx = args.indexOf('--agent');
    expect(args[agentIdx + 1]).toBe('claude-code');
  });

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
    // Remediation hint should name --agent in the error or errLog.
    const combined = `${(caught as Error).message}\n${errLines.join('\n')}`;
    expect(combined).toContain('--agent');
    // Spawn must NOT have run.
    expect(spawn.calls).toHaveLength(0);
  });

  it('InstallSkills_UnknownRuntimeFlag_PrintsSupportedList', async () => {
    // Strengthened version of the task 019 test: assert the error message
    // names every runtime we passed in.
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
    // Every runtime in ALL_RUNTIMES must appear, in some order.
    for (const r of ALL_RUNTIMES) {
      expect(msg).toContain(r.name);
    }
    expect(msg).toContain('bogus');
  });

  it('InstallSkills_NetworkError_PropagatesStderrVerbatim', async () => {
    // Simulate npx failing because the package couldn't be fetched. The
    // stderr bytes from the spawn call must reach errLog unchanged — no
    // wrapping, no re-encoding.
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
      /* expected */
    }
    const joined = errLines.join('\n');
    expect(joined).toContain(STDERR);
  });

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

    // Should have spawned for the upstream `universal` agent (our
    // `generic` runtime maps to upstream `universal` per
    // mapRuntimeToSkillsCliAgent).
    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0].args;
    const agentIdx = args.indexOf('--agent');
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    expect(args[agentIdx + 1]).toBe('universal');

    // A clear fallback message should be logged.
    const joined = logs.join('\n');
    expect(joined.toLowerCase()).toContain('no agent detected');
    expect(joined.toLowerCase()).toContain('generic');
  });
});

// ─── #1217 — non-interactive support ─────────────────────────────────────────

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
  it('mapRuntimeToSkillsCliAgent_unknown_passesThrough', () => {
    // Forward-compat: unmapped names go through unchanged so a future
    // runtime added in runtimes/<name>.yaml works automatically as long
    // as <name> matches an upstream agent ID.
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
      fs.rmSync(home, { recursive: true, force: true });
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
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('registerExarchosInClaudeJson_idempotent_secondCallPreservesMtime', async () => {
    const home = makeTmpHome();
    try {
      registerExarchosInClaudeJson(home);
      const configPath = path.join(home, '.claude.json');
      const beforeMtime = fs.statSync(configPath).mtimeMs;

      // Force a small wall-clock delay so any second write would visibly
      // bump mtimeMs. 20ms is comfortably above filesystem mtime resolution
      // on every supported platform.
      await new Promise((r) => setTimeout(r, 20));

      registerExarchosInClaudeJson(home);
      const afterMtime = fs.statSync(configPath).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── T3 — install canonical command aliases + post-install summary ───────────
// (#1471/#1472, v2.10.1 Bundle A)
//
// When a runtime declares `commandsInstallPath` AND a generated
// `command-aliases/<runtime>/` source tree exists, install-skills must also
// copy those `*.md` alias files into the expanded commands directory and print
// a post-install summary (skills dest + commands dest + restart hint). The gate
// is the presence of `commandsInstallPath` + source tree — never an "opencode"
// literal (INV-4).

describe('installSkills command aliases (T3, #1471/#1472)', () => {
  /**
   * opencode runtime fixture: declares `commandsInstallPath`, mirroring the
   * real `content/harness/runtimes/opencode.yaml`. The other fields match the production map
   * closely enough for the install path resolution.
   */
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

  /**
   * Build a temporary `skills/` source tree containing the per-runtime
   * subtree `<root>/<runtime>/<skill>/SKILL.md`, plus a sibling
   * `command-aliases/<runtime>/<name>.md` tree. Returns the two source roots
   * and a disposer. The skills source is needed so the local-copy fast path
   * (which the alias copy hangs off of) engages.
   */
  function makeAliasFixture(runtimeName: string): {
    skillsSource: string;
    aliasesSource: string;
    aliasFiles: string[];
    dispose: () => void;
  } {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-aliases-'));
    const skillsSource = path.join(tmp, 'skills');
    const aliasesSource = path.join(tmp, 'command-aliases');

    // One trivial skill so copyLocalSkills finds something to copy.
    const skillDir = path.join(skillsSource, runtimeName, 'sample-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# sample\n', 'utf8');

    // Two alias files under command-aliases/<runtime>/.
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
      dispose: () => fs.rmSync(tmp, { recursive: true, force: true }),
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

      // Alias files must land in the expanded commandsInstallPath.
      const destDir = expandTilde('~/.config/opencode/commands', home);
      for (const f of fx.aliasFiles) {
        expect(fs.existsSync(path.join(destDir, f))).toBe(true);
      }
    } finally {
      fx.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('InstallSkills_OpencodeShellOutPath_StillCopiesAliasFiles', async () => {
    // When skillsSource is undefined, skills install via the upstream
    // `npx skills add` shell-out. Alias install runs *after* that branch too,
    // so opencode must still get its /ideate, /plan, ... commands.
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
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('InstallSkills_RuntimeWithoutCommandsPath_WritesNoAliasFiles', async () => {
    // generic has no commandsInstallPath — even if an aliases source tree
    // happens to exist, nothing must be written for it.
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

      // No commands directory should have been created at all.
      const commandsRoot = path.join(home, '.config', 'opencode', 'commands');
      expect(fs.existsSync(commandsRoot)).toBe(false);
      // And the generic agents dir must contain no `.md` alias files.
      const genericCmds = expandTilde('~/.agents/commands', home);
      expect(fs.existsSync(genericCmds)).toBe(false);
    } finally {
      fx.dispose();
      fs.rmSync(home, { recursive: true, force: true });
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
      // Summary names both destinations.
      expect(joined).toContain(skillsDest);
      expect(joined).toContain(cmdsDest);
      // ...and includes a restart hint.
      expect(joined.toLowerCase()).toContain('restart');
    } finally {
      fx.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── Task 010 — canonical `.agents/skills` layout + copy-mode + provenance ────
// (DR-4, DR-8). The canonical set = procedural skills (`skills/standard/`) +
// the runtime's orchestration skills (`skills/<runtime>/`). It lands both at the
// cross-client convention path (`~/.agents/skills` user scope) AND the harness's
// native dir. On `win32` the convention copy is a file copy, never a symlink
// (INV-16). Every install writes/updates a per-scope provenance manifest, and
// `detectLayoutDrift` reports a stale/modified canonical copy read-only.

describe('installSkills canonical layout + provenance (Task 010, DR-4/DR-8)', () => {
  const IS_WIN = process.platform === 'win32';

  /**
   * Build a real `skills/` source tree with `standard/<proc>/SKILL.md`
   * procedural skills plus per-runtime `<runtime>/<orch>/SKILL.md` orchestration
   * skills. Real disk so the placement + hashing exercise the filesystem boundary.
   */
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
    return { skillsSource, dispose: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }

  function makeTmpHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'exarchos-canon-home-'));
  }

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

      // Per-harness native dir got both the procedural + orchestration skill.
      const nativeDir = expandTilde('~/.claude/skills', home);
      expect(fs.existsSync(path.join(nativeDir, 'plan', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(nativeDir, 'ideate', 'SKILL.md'))).toBe(true);

      // Cross-client canonical convention path got the same set (resolving
      // through the POSIX symlink to the native copy).
      const canonicalDir = expandTilde('~/.agents/skills', home);
      expect(fs.existsSync(path.join(canonicalDir, 'plan', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(canonicalDir, 'ideate', 'SKILL.md'))).toBe(true);

      // On POSIX the canonical entries are symlinks (dedup to the native copy);
      // on win32 they would be real copies (asserted separately).
      if (!IS_WIN) {
        expect(fs.lstatSync(path.join(canonicalDir, 'plan')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(canonicalDir, 'ideate')).isSymbolicLink()).toBe(true);
      }
    } finally {
      src.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('installSkills_Win32_UsesCopyNotSymlink', async () => {
    // Inject platform='win32': the canonical placement MUST copy, never symlink
    // (INV-16). copyDir/symlink recorders capture which primitive ran.
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

      // No symlink was ever created on win32.
      expect(symlinkCalls).toHaveLength(0);
      // The canonical `.agents/skills` copy went through copyDir (file copy).
      const canonicalDir = expandTilde('~/.agents/skills', home);
      const copiedIntoCanonical = copyCalls.some((c) => c.dest.startsWith(canonicalDir));
      expect(copiedIntoCanonical).toBe(true);
      // ...and the native dir was likewise a copy.
      const nativeDir = expandTilde('~/.claude/skills', home);
      const copiedIntoNative = copyCalls.some((c) => c.dest.startsWith(nativeDir));
      expect(copiedIntoNative).toBe(true);
    } finally {
      src.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

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

      // The manifest enumerates the per-harness placement paths (canonical +
      // native) with newline-normalized content hashes per skill.
      const claudeNative = m1.placements.find(
        (p) => p.harness === 'claude' && p.kind === 'native',
      );
      expect(claudeNative).toBeDefined();
      expect(Object.keys(claudeNative!.hashes).sort()).toEqual(['ideate', 'plan']);
      expect(m1.placements.some((p) => p.harness === 'claude' && p.kind === 'canonical')).toBe(
        true,
      );

      // A SECOND install into the same scope UPDATES (merges into) the manifest
      // rather than clobbering it — both harnesses' native placements survive.
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
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

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

      // Freshly installed: the on-disk copies match the recorded provenance
      // hashes, so `doctor` reports NO drift.
      expect(detectLayoutDrift({ scope: 'user', home, projectRoot: home })).toEqual([]);

      // Mutate a skill file at the canonical path (on POSIX this writes through
      // the symlink to the native copy) → the recorded hash no longer matches.
      const canonicalSkill = path.join(expandTilde('~/.agents/skills', home), 'plan', 'SKILL.md');
      fs.appendFileSync(canonicalSkill, '\nlocally edited\n', 'utf8');

      const findings = detectLayoutDrift({ scope: 'user', home, projectRoot: home });
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.skill === 'plan' && f.drift === 'modified')).toBe(true);
    } finally {
      src.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── Rename-migration provenance helpers (Task 011, DR-3/DR-8) ────────────────

describe('legacy-render + install-manifest provenance helpers', () => {
  it('hashSkillMdContent_MatchesLegacyGeneratorNormalizeAndHash', () => {
    // The migration's SKILL.md hash is the load-bearing cross-format contract: it
    // MUST be byte-identical to the Task 023 generator's `normalizeAndHash`, and
    // CRLF must normalize to LF so a Windows-checkout install still matches.
    const lf = '# ideate\n\nOrient the workflow.\n';
    const crlf = lf.replace(/\n/g, '\r\n');

    expect(hashSkillMdContent(lf)).toBe(normalizeAndHash(lf));
    // CRLF and LF hash identically (newline-normalized) — the CRLF-install case.
    expect(hashSkillMdContent(crlf)).toBe(hashSkillMdContent(lf));
    expect(hashSkillMdContent(crlf)).toBe(normalizeAndHash(crlf));
  });

  it('hashSkillMdFile_ReadsSkillMd_NormalizesCrlf', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillmd-'));
    try {
      const lf = '# delegate\n\nDelegate to sub-agents.\n';
      fs.mkdirSync(path.join(dir, 'delegation'), { recursive: true });
      // Write CRLF bytes on disk — the reader must newline-normalize before hashing.
      fs.writeFileSync(
        path.join(dir, 'delegation', 'SKILL.md'),
        lf.replace(/\n/g, '\r\n'),
        'utf8',
      );
      expect(hashSkillMdFile(path.join(dir, 'delegation'))).toBe(hashSkillMdContent(lf));
      // A dir with no SKILL.md → undefined (not a skill dir).
      fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
      expect(hashSkillMdFile(path.join(dir, 'empty'))).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
    // "matches ANY release" ⇒ the per-skill set unions every historical hash.
    expect(index.get('brainstorming')).toEqual(new Set(['h1', 'h2', 'h3']));
    expect(index.get('delegation')).toEqual(new Set(['h4']));
    expect(index.get('nonexistent')).toBeUndefined();
  });

  it('loadLegacyHashIndex_ParsesRealCommittedManifest', () => {
    // Consume the REAL committed Task 023 manifest (no invented parallel format):
    // it resolves on disk, parses, and indexes renamed-away skills.
    const manifestPath = findLegacyHashManifestPath();
    expect(manifestPath).toBeDefined();

    const index = loadLegacyHashIndex();
    expect(index).toBeDefined();
    // The renamed-away skills the migration targets are all covered historically.
    expect((index!.get('brainstorming')?.size ?? 0)).toBeGreaterThan(0);
    expect((index!.get('delegation')?.size ?? 0)).toBeGreaterThan(0);
    expect((index!.get('workflow-state')?.size ?? 0)).toBeGreaterThan(0);

    // Every hash in a set is a full 64-hex sha256 digest (the generator's shape).
    const someHash = [...index!.get('brainstorming')!][0];
    expect(someHash).toMatch(/^[0-9a-f]{64}$/);

    // Absent manifest path ⇒ undefined (the conservative PRESERVE default).
    expect(loadLegacyHashIndex({ manifestPath: path.join(os.tmpdir(), 'nope.json') })).toBeUndefined();
  });

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
      // A different content hash for the same skill does NOT vouch (modified dir).
      expect(installManifestVouchesForDir([manifest], 'synthesis', 'deadbeef')).toBe(false);
      // A skill the manifest never recorded is not vouched for.
      expect(installManifestVouchesForDir([manifest], 'discovery', dirHash)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
