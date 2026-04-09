/**
 * Unit tests for the `installSkills()` function.
 *
 * All side effects (spawn, log, errLog, homeDir) are injected so the tests are
 * deterministic: no child processes, no filesystem, no environment leakage.
 *
 * Fixtures are built as in-memory `RuntimeMap` arrays and passed via the
 * `runtimes` dep — we do not touch the `runtimes/` directory on disk.
 *
 * Implements: DR-7 (install-skills CLI scaffold), DR-9 (docs), DR-10 (errors).
 */

import { describe, it, expect, vi } from 'vitest';
import type { RuntimeMap } from './runtimes/types.js';
import { installSkills, type SpawnResult } from './install-skills.js';

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
      hasHooks: true,
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
    });

    // spawn was called with skills/<name> == skills/claude
    expect(spawn.calls).toHaveLength(1);
    const args = spawn.calls[0].args;
    expect(args).toContain('skills/claude');
  });

  it('InstallSkills_WithAgentFlag_ConstructsCorrectNpxCommand', async () => {
    const spawn = fakeSpawn();

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn: spawn.fn,
      log: () => {},
      homeDir: () => '/home/tester',
    });

    expect(spawn.calls).toHaveLength(1);
    const { cmd, args } = spawn.calls[0];
    expect(cmd).toBe('npx');
    expect(args).toEqual([
      'skills',
      'add',
      'github:lvlup-sw/exarchos',
      'skills/claude',
      '--target',
      '/home/tester/.claude/skills',
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
    });

    // Find the log line that contains the command and assert it precedes
    // the spawn invocation.
    const logIdx = events.findIndex(
      (e) => e.kind === 'log' && e.payload.includes('npx skills add'),
    );
    const spawnIdx = events.findIndex((e) => e.kind === 'spawn');
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeLessThan(spawnIdx);
  });

  it('InstallSkills_WithAgentFlag_ExpandsTildeInInstallPath', async () => {
    const spawn = fakeSpawn();

    await installSkills({
      agent: 'claude',
      runtimes: ALL_RUNTIMES,
      spawn: spawn.fn,
      log: () => {},
      homeDir: () => '/home/alice',
    });

    const args = spawn.calls[0].args;
    const targetIdx = args.indexOf('--target');
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    expect(args[targetIdx + 1]).toBe('/home/alice/.claude/skills');
    // Tilde must be fully gone.
    expect(args[targetIdx + 1]).not.toContain('~');
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
      'npx skills add github:lvlup-sw/exarchos skills/claude --target /home/tester/.claude/skills',
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
      detectDeps: {
        which: (cmd) =>
          cmd === 'claude' || cmd === 'codex' ? `/fake/bin/${cmd}` : null,
        env: {},
      },
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].args).toContain('skills/claude');
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

    // Should have spawned with skills/generic.
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].args).toContain('skills/generic');

    // A clear fallback message should be logged.
    const joined = logs.join('\n');
    expect(joined.toLowerCase()).toContain('no agent detected');
    expect(joined.toLowerCase()).toContain('generic');
  });
});
