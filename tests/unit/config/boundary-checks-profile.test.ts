/**
 * The `boundaryChecks` term of the verification profile and its key `verification.boundaryChecks`.
 * The seeds come from the adapter configs at the checkout, and the key replaces every seed.
 * The term has no unresolved state, so the key refuses a command that does not fit the argv of the term.
 * Thus a config that loads always gives a profile that parses.
 *
 * Each resolver case passes a loader that spawns no git, so the case reads only the files of its root.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadExarchosConfigOutcome, type ExarchosConfigOutcome } from '../../../src/config/load-exarchos-config.js';
import { resolveVerificationProfile } from '../../../src/config/verification-profile.js';
import { FullExarchosConfigSchema } from '../../../src/config/yaml-schema.js';
import { VerificationProfileSchema, type VerificationProfile } from '../../../src/workflow/verification/profile.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import { cruiserCheck, taintCheck } from '../../helpers/verification-profile.js';

/** The text of one entry of `verification.boundaryChecks` with a `semgrep-taint` adapter. */
const TAINT_ENTRY = { adapter: 'semgrep-taint', command: 'semgrep --config rules/taint.yml', config: 'rules/taint.yml' };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmrf(root);
});

/** Makes a root that holds `files`. A name with a directory makes that directory. */
function rootWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'boundary-checks-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** Reads the config of a root with no git, so the case spawns nothing. */
function readWithNoGit(root: string): ExarchosConfigOutcome {
  return loadExarchosConfigOutcome(root, { findRepoRoot: () => null });
}

/** The profile of a root, resolved with a loader that spawns nothing. */
function profileAt(root: string): VerificationProfile {
  return resolveVerificationProfile(root, { loadConfig: readWithNoGit });
}

/** The issues of one parse of an `.exarchos.yml`, each with its dotted path. */
function issuePaths(config: unknown): readonly string[] {
  const result = FullExarchosConfigSchema.safeParse(config);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('resolveVerificationProfile — the boundaryChecks term', () => {
  /** The term pins the adapter, the seed argv and the config name that the checkout holds. The reverted resolver gives `[]`. */
  it('ResolveProfile_ACruiserConfigAtTheCheckout_PinsTheAdapter', () => {
    const root = rootWith({ '.dependency-cruiser.mjs': 'export default {};\n' });

    expect(profileAt(root).boundaryChecks).toEqual([cruiserCheck('.dependency-cruiser.mjs')]);
  });

  /** A taint ruleset gives the second seed, after the cruiser seed. The argv names the path that the checkout holds. */
  it('ResolveProfile_BothAdapterConfigsAtTheCheckout_PinTheCruiserThenTheTaintCheck', () => {
    const root = rootWith({
      '.dependency-cruiser.cjs': 'module.exports = {};\n',
      '.semgrep/no-raw-io-into-core.yaml': 'rules: []\n',
    });

    expect(profileAt(root).boundaryChecks).toEqual([cruiserCheck(), taintCheck('.semgrep/no-raw-io-into-core.yaml')]);
  });

  /** A root with no adapter config gives no boundary check. */
  it('ResolveProfile_ARootWithNoAdapterConfig_GivesNoBoundaryCheck', () => {
    expect(profileAt(rootWith({})).boundaryChecks).toEqual([]);
  });

  /** The block replaces every seed. The root holds a cruiser config, and the term holds only the entry of the block. */
  it('ResolveProfile_ABoundaryChecksBlock_ReplacesTheSeededAdapters', () => {
    const root = rootWith({
      '.dependency-cruiser.cjs': 'module.exports = {};\n',
      '.exarchos.yml': JSON.stringify({ verification: { boundaryChecks: [TAINT_ENTRY] } }),
    });

    expect(profileAt(root).boundaryChecks).toEqual([
      {
        adapter: 'semgrep-taint',
        command: { state: 'resolved', argv: ['semgrep', '--config', 'rules/taint.yml'], source: 'config' },
        config: 'rules/taint.yml',
      },
    ]);
  });

  /**
   * `[]` is a decision of the repository, so it gives no boundary check, also at a root that holds a config.
   * The killing assertion is the resolved glob term. The reverted schema refuses the key, so each glob term of that config is unresolved.
   */
  it('ResolveProfile_AnEmptyBoundaryChecksBlock_GivesNoBoundaryCheck', () => {
    const root = rootWith({
      '.dependency-cruiser.cjs': 'module.exports = {};\n',
      '.exarchos.yml': JSON.stringify({ verification: { boundaryChecks: [] } }),
    });

    const profile = profileAt(root);

    expect(profile.boundaryChecks).toEqual([]);
    expect(profile.tests.globs.state).toBe('resolved');
  });

  /** On a config that does not load, the key cannot be read, so the term keeps the seeds. Static analysis then fails the cruiser leg with the load error. */
  it('ResolveProfile_AConfigThatDoesNotLoad_KeepsTheSeededAdapters', () => {
    const root = rootWith({
      '.dependency-cruiser.cjs': 'module.exports = {};\n',
      '.exarchos.yml': 'not_a_known_key: true\n',
    });

    expect(profileAt(root).boundaryChecks).toEqual([cruiserCheck()]);
  });

  /** A block at the bound gives a profile that parses, so a config that loads gives a capsule that parses. The reverted resolver gives no entry. */
  it('ResolveProfile_ABoundaryChecksBlockAtItsBound_GivesAProfileThatParses', () => {
    const entries = Array.from({ length: 4 }, () => TAINT_ENTRY);
    const root = rootWith({ '.exarchos.yml': JSON.stringify({ verification: { boundaryChecks: entries } }) });

    const profile = profileAt(root);

    expect(profile.boundaryChecks).toHaveLength(4);
    expect(VerificationProfileSchema.safeParse(profile).success).toBe(true);
  });
});

describe('verification.boundaryChecks — the key', () => {
  /** The strict `verification` block of the reverted schema refuses the key. */
  it('VerificationConfig_ABoundaryChecksBlock_Parses', () => {
    const parsed = FullExarchosConfigSchema.parse({
      verification: {
        boundaryChecks: [
          { adapter: 'dependency-cruiser', command: 'depcruise --validate rules/b.cjs --output-type json', config: 'rules/b.cjs' },
          TAINT_ENTRY,
        ],
      },
    });

    expect(parsed.verification?.boundaryChecks).toHaveLength(2);
  });

  /** The killing assertion is the path. The reverted schema refuses the whole key at `verification`. */
  it('VerificationConfig_ABoundaryCheckWithAnUnknownAdapter_IsRefusedAtItsPath', () => {
    const entry = { adapter: 'eslint-boundaries', command: 'eslint .', config: 'rules.cjs' };

    expect(issuePaths({ verification: { boundaryChecks: [entry] } })).toEqual(['verification.boundaryChecks.0.adapter']);
  });

  /** Each field of an entry is required, and an entry refuses an unknown key. */
  it('VerificationConfig_ABoundaryCheckWithAMissingOrUnknownField_IsRefusedAtItsPath', () => {
    expect(issuePaths({ verification: { boundaryChecks: [{ adapter: 'semgrep-taint', config: 'a.yml' }] } })).toEqual([
      'verification.boundaryChecks.0.command',
    ]);
    expect(issuePaths({ verification: { boundaryChecks: [{ ...TAINT_ENTRY, bogus: true }] } })).toEqual([
      'verification.boundaryChecks.0',
    ]);
  });

  /** The list holds the bound of its term, so a fifth entry does not load, and the issue names the list. */
  it('VerificationConfig_ABoundaryCheckListPastItsBound_IsRefusedAtItsPath', () => {
    const entries = (count: number): unknown[] => Array.from({ length: count }, () => TAINT_ENTRY);

    expect(issuePaths({ verification: { boundaryChecks: entries(4) } })).toEqual([]);
    expect(issuePaths({ verification: { boundaryChecks: entries(5) } })).toEqual(['verification.boundaryChecks']);
  });

  /** A config path is relative and holds no `..` segment, so the pinned path cannot leave the root. */
  it('VerificationConfig_ABoundaryCheckConfigThatLeavesTheRoot_IsRefusedAtItsPath', () => {
    for (const config of ['../rules.yml', '/abs/rules.yml']) {
      expect(issuePaths({ verification: { boundaryChecks: [{ ...TAINT_ENTRY, config }] } }), config).toEqual([
        'verification.boundaryChecks.0.config',
      ]);
    }
  });

  /**
   * The term has no unresolved state, so a command that cannot become its argv does not load.
   * Thus the resolver always gives a term that parses, and prepare never refuses `CAPSULE_UNSOUND` on such a config.
   */
  it('VerificationConfig_ABoundaryCheckCommandThatDoesNotFitItsTerm_IsRefusedAtItsPath', () => {
    const commands = ['semgrep "unterminated', "semgrep ''", Array.from({ length: 65 }, (_, i) => `arg${i}`).join(' ')];

    for (const command of commands) {
      expect(issuePaths({ verification: { boundaryChecks: [{ ...TAINT_ENTRY, command }] } }), command).toEqual([
        'verification.boundaryChecks.0.command',
      ]);
    }
  });
});
