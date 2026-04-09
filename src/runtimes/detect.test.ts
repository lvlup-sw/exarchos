/**
 * Unit tests for `detectRuntime()` — inspects PATH and environment variables
 * to figure out which agent runtime is installed on the host.
 *
 * Determinism: every test injects its own `which` and `env` mocks. The real
 * filesystem and the real `process.env` are never touched.
 *
 * Implements: DR-7 (runtime auto-detection for install-skills).
 */

import { describe, it, expect } from 'vitest';
import type { RuntimeMap } from './types.js';
import { detectRuntime, AmbiguousRuntimeError } from './detect.js';

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

/**
 * Build a deterministic `which` mock from a list of binaries that exist. Any
 * binary in the set resolves to `/fake/bin/<name>`; everything else returns
 * null (the shape required by the DetectDeps interface).
 */
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

  it('DetectRuntime_EnvVarSet_OverridesPathDetection', () => {
    // Codex binary is in PATH, but CLAUDECODE env var is set → claude wins.
    const result = detectRuntime(RUNTIMES, {
      which: whichFrom(['codex']),
      env: { CLAUDECODE: '1' },
    });
    expect(result).not.toBeNull();
    expect(result?.name).toBe('claude');
  });

  it('DetectRuntime_RespectsInjectedPathLookup_Deterministic', () => {
    // Inject a completely custom which that returns nothing for the real names
    // and only resolves a bogus name. Nothing should be detected, confirming
    // no OS calls leak through.
    const which = (_cmd: string): string | null => null;
    const result = detectRuntime(RUNTIMES, { which, env: {} });
    expect(result).toBeNull();
  });
});
