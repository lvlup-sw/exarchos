/**
 * The new keys of the `verification:` block: `tests`, `staticAnalysis` and `integration`.
 * Each key holds the bound of its profile term, so a value past it does not load, and the issue names its path.
 * The file also proves that the three copies of the safe-command class accept the same characters.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { safeCommand } from '../../../src/config/exarchos-config-schema.js';
import { resolveTestRuntime } from '../../../src/config/test-runtime-resolver.js';
import { FullExarchosConfigSchema } from '../../../src/config/yaml-schema.js';
import { VerificationProfileSchema } from '../../../src/workflow/verification/profile.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { nodeTestProfile } from '../../helpers/verification-profile.js';

/** A root with no marker and no config, for the resolver copy of the class. */
const EMPTY_ROOT = mkdtempSync(join(tmpdir(), 'verification-config-'));

afterAll(() => {
  rmrf(EMPTY_ROOT);
});

/** The issues of one parse of a whole `.exarchos.yml`, each with its dotted path. */
function issuesOf(config: unknown): ReadonlyArray<{ readonly path: string; readonly code: string; readonly keys?: readonly string[] }> {
  const result = FullExarchosConfigSchema.safeParse(config);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    ...(issue.code === 'unrecognized_keys' ? { keys: issue.keys } : {}),
  }));
}

/** A list of `count` distinct values made by `make`. */
function listOf<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

/** True when the strict resolver accepts `command` as a test override. */
function resolverAccepts(command: string): boolean {
  try {
    resolveTestRuntime(EMPTY_ROOT, { override: { test: command }, loadConfig: () => null });
    return true;
  } catch {
    return false;
  }
}

/** True when the profile schema accepts `token` as one argv token. */
function profileAccepts(token: string): boolean {
  const profile = nodeTestProfile();
  return VerificationProfileSchema.safeParse({
    ...profile,
    integration: { ...profile.integration, command: { state: 'resolved', argv: [token], source: 'config' } },
  }).success;
}

describe('the verification config keys', () => {
  it('VerificationConfig_EachNewBlock_Parses', () => {
    const result = FullExarchosConfigSchema.safeParse({
      verification: {
        tests: {
          globs: ['**/*_test.go'],
          support: ['testdata'],
          probe: { command: 'go test ./...', files: 'none', failureExitCodes: [1] },
        },
        staticAnalysis: { lint: 'go vet ./...', 'quality-check': 'make check' },
        integration: { command: 'go test ./...', report: 'exit-code', failureExitCodes: [1, 2] },
      },
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.verification?.tests?.probe?.files).toBe('none');
    expect(result.success && Object.keys(result.data.verification?.staticAnalysis ?? {})).toEqual(['lint', 'quality-check']);
  });

  it('VerificationConfig_AnUnknownKeyInANewBlock_IsRefusedAtItsPath', () => {
    expect(issuesOf({ verification: { tests: { bogus: true } } })).toEqual([
      { path: 'verification.tests', code: 'unrecognized_keys', keys: ['bogus'] },
    ]);
    expect(issuesOf({ verification: { integration: { command: 'make test', bogus: true } } })).toEqual([
      { path: 'verification.integration', code: 'unrecognized_keys', keys: ['bogus'] },
    ]);
  });

  /** Exit 0 is green, so a red code of 0 does not load, and the issue names the code list. */
  it('VerificationConfig_AFailureExitCodeOfZero_IsRefusedAtItsPath', () => {
    const probe = issuesOf({ verification: { tests: { probe: { command: 'make test', failureExitCodes: [0] } } } });
    const integration = issuesOf({ verification: { integration: { command: 'make test', failureExitCodes: [0] } } });

    expect(probe.map((issue) => issue.path)).toEqual(['verification.tests.probe.failureExitCodes.0']);
    expect(integration.map((issue) => issue.path)).toEqual(['verification.integration.failureExitCodes.0']);
  });

  /** Each list key refuses a value past the bound of its profile term, and it loads a value at the bound. */
  it('VerificationConfig_AListPastTheBoundOfItsTerm_IsRefusedAtItsPath', () => {
    const globs = (count: number): string[] => listOf(count, (i) => `src${i}/**/*.test.*`);
    const segments = (count: number): string[] => listOf(count, (i) => `support${i}`);
    const checks = (count: number): Record<string, string> =>
      Object.fromEntries(listOf(count, (i) => [`check${i}`, `make check${i}`]));
    const codes = (count: number): number[] => listOf(count, (i) => i + 1);
    const pathsOf = (config: unknown): string[] => issuesOf(config).map((issue) => issue.path);

    expect(pathsOf({ verification: { tests: { globs: globs(65) } } })).toEqual(['verification.tests.globs']);
    expect(pathsOf({ verification: { tests: { support: segments(65) } } })).toEqual(['verification.tests.support']);
    expect(pathsOf({ verification: { staticAnalysis: checks(17) } })).toEqual(['verification.staticAnalysis']);
    for (const count of [17, 0]) {
      expect(pathsOf({ verification: { tests: { probe: { command: 'make test', failureExitCodes: codes(count) } } } })).toEqual([
        'verification.tests.probe.failureExitCodes',
      ]);
      expect(pathsOf({ verification: { integration: { command: 'make test', failureExitCodes: codes(count) } } })).toEqual([
        'verification.integration.failureExitCodes',
      ]);
    }
    expect(
      pathsOf({
        verification: {
          tests: { globs: globs(64), support: segments(64), probe: { command: 'make test', failureExitCodes: codes(16) } },
          staticAnalysis: checks(16),
        },
      }),
    ).toEqual([]);
  });

  it('VerificationConfig_AGlobThatLeavesTheRoot_IsRefusedAtItsPath', () => {
    for (const glob of ['../x/**', '/abs/**']) {
      expect(issuesOf({ verification: { tests: { globs: [glob] } } }).map((issue) => issue.path), glob).toEqual([
        'verification.tests.globs.0',
      ]);
    }
  });

  /** The key order is the run order, and a parsed map moves an integer key to the front. So a check name starts with a letter. */
  it('VerificationConfig_ACheckNameThatStartsWithADigit_IsRefusedAtItsPath', () => {
    const issues = issuesOf({ verification: { staticAnalysis: { lint: 'make lint', '1': 'make first' } } });

    expect(issues.map((issue) => issue.path)).toEqual(['verification.staticAnalysis.1']);
  });

  it('VerificationConfig_ThePolicyBlockAlone_StillParses', () => {
    const result = FullExarchosConfigSchema.safeParse({ verification: { policy: { low: ['check_static_analysis'] } } });

    expect(result.success).toBe(true);
    expect(result.success && result.data.verification?.policy?.low).toEqual(['check_static_analysis']);
  });

  /**
   * The config, the resolver and the profile each hold a copy of the safe-command class.
   * A command that loads must give tokens that the profile accepts, so the three copies must accept the same characters.
   */
  it('SafeCommandClass_TheConfigTheResolverAndTheProfile_AcceptTheSameCharacters', () => {
    const characters = [...listOf(256, (code) => String.fromCharCode(code)), String.fromCharCode(0x4e2d), String.fromCharCode(0x2028)];
    const verdicts = characters.map((character) => {
      const token = `a${character}b`;
      return {
        code: character.charCodeAt(0),
        config: safeCommand.safeParse(token).success,
        resolver: resolverAccepts(token),
        profile: profileAccepts(token),
      };
    });

    expect(verdicts.filter((verdict) => verdict.config !== verdict.resolver || verdict.config !== verdict.profile)).toEqual([]);
    expect(verdicts.filter((verdict) => verdict.config).length).toBeGreaterThan(60);
    expect(verdicts.filter((verdict) => !verdict.config).length).toBeGreaterThan(100);
  });
});
