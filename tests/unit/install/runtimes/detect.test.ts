/**
 * Tests for `detectRuntime()`, which finds the agent runtime of the host from PATH and environment variables.
 * Each test injects its own `which` and `env`, so no test reads the real PATH or `process.env`.
 */

import { describe, it, expect } from 'vitest';
import type { RuntimeMap } from '../../../../src/install/runtimes/types.js';
import { detectRuntime, AmbiguousRuntimeError } from '../../../../src/install/runtimes/detect.js';

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
    detection: { binaries: ['claude'], envVars: ['CLAUDECODE'] },
    placeholders: {},
    ...overrides,
  };
}

const CLAUDE = makeRuntime();
const CODEX = makeRuntime({
  name: 'codex',
  skillsInstallPath: '~/.codex/skills',
  detection: { binaries: ['codex'], envVars: ['CODEX_SESSION'] },
});
const GENERIC = makeRuntime({
  name: 'generic',
  skillsInstallPath: './.skills',
  detection: { binaries: [], envVars: [] },
});

const RUNTIMES: RuntimeMap[] = [CLAUDE, CODEX, GENERIC];

/** Builds a `which` mock. A listed binary resolves to `/fake/bin/<name>`, and each other name gives null. */
function whichFrom(available: string[]): (cmd: string) => string | null {
  const set = new Set(available);
  return (cmd) => (set.has(cmd) ? `/fake/bin/${cmd}` : null);
}

describe('detectRuntime (task 020)', () => {
  it('DetectRuntime_ClaudeInPath_ReturnsClaude', () => {
    const result = detectRuntime(RUNTIMES, {
      which: whichFrom(['claude']),
      env: {},
    });
    expect(result).not.toBeNull();
    expect(result?.name).toBe('claude');
  });

  it('DetectRuntime_CodexInPath_ReturnsCodex', () => {
    const result = detectRuntime(RUNTIMES, {
      which: whichFrom(['codex']),
      env: {},
    });
    expect(result).not.toBeNull();
    expect(result?.name).toBe('codex');
  });

  it('DetectRuntime_MultipleCandidates_ThrowsAmbiguousError', () => {
    let caught: unknown;
    try {
      detectRuntime(RUNTIMES, {
        which: whichFrom(['claude', 'codex']),
        env: {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousRuntimeError);
    const err = caught as AmbiguousRuntimeError;
    expect(err.candidates).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(err.message).toContain('claude');
    expect(err.message).toContain('codex');
    expect(err.message).toContain('--agent');
  });

  it('DetectRuntime_NoCandidates_ReturnsNull', () => {
    const result = detectRuntime(RUNTIMES, {
      which: whichFrom([]),
      env: {},
    });
    expect(result).toBeNull();
  });

  /** The codex binary is in PATH, but the `CLAUDECODE` variable is set, so claude wins. */
  it('DetectRuntime_EnvVarSet_OverridesPathDetection', () => {
    const result = detectRuntime(RUNTIMES, {
      which: whichFrom(['codex']),
      env: { CLAUDECODE: '1' },
    });
    expect(result).not.toBeNull();
    expect(result?.name).toBe('claude');
  });

  /** The injected `which` resolves no name. A detected runtime here shows that the function read the real host. */
  it('DetectRuntime_RespectsInjectedPathLookup_Deterministic', () => {
    const which = (_cmd: string): string | null => null;
    const result = detectRuntime(RUNTIMES, { which, env: {} });
    expect(result).toBeNull();
  });
});
