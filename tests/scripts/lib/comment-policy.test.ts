import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicy,
  isExempt,
  compilePattern,
  PolicyError,
  DEFAULT_POLICY_PATH,
} from '../../../tools/audit/lib/comment-policy.mjs';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';

const REPO_POLICY = path.resolve(import.meta.dirname, '../../../.exarchos/comment-policy.json');

function writeTempPolicy(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-policy-'));
  const file = path.join(dir, 'comment-policy.json');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function validDatum(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    rule: 'state the constraint',
    forbiddenOrdinals: [{ id: 'dr', pattern: 'DR-\\d+', flags: 'gi', enabled: true, remedy: 'say why' }],
    allowedReferences: [{ id: 'url', pattern: 'https?://\\S+', flags: 'gi', reason: 'resolvable' }],
    changelogPatterns: [{ id: 'formerly', pattern: '\\bformerly\\b', flags: 'gi', enabled: true }],
    rules: ['comment-content'],
    exemptPaths: [{ glob: 'tools/audit/__fixtures__/**', rules: ['comment-content'], reason: 'fixtures carry offender text' }],
    ...overrides,
  });
}

describe('loadPolicy', () => {
  it('LoadPolicy_ValidDatum_ExposesEveryDeclaredClass', () => {
    const policy = loadPolicy(writeTempPolicy(validDatum()));

    expect(policy.forbiddenOrdinals.map((p) => p.id)).toEqual(['dr']);
    expect(policy.allowedReferences.map((p) => p.id)).toEqual(['url']);
    expect(policy.changelogPatterns.map((p) => p.id)).toEqual(['formerly']);
    expect(policy.exemptPaths.map((p) => p.glob)).toEqual(['tools/audit/__fixtures__/**']);
    expect(policy.rules).toEqual(['comment-content']);
  });

  it('LoadPolicy_MissingFile_ExitsNonZero', () => {
    // Fail closed: running with defaults would give a guard no rules, which is
    // indistinguishable from a clean tree.
    expect(() => loadPolicy(path.join(os.tmpdir(), 'absent-policy-file.json'))).toThrow(PolicyError);
  });

  it('LoadPolicy_MalformedJson_ExitsNonZero', () => {
    expect(() => loadPolicy(writeTempPolicy('{ not json'))).toThrow(PolicyError);
  });

  it('LoadPolicy_ExemptPathWithoutExpiry_Accepted', () => {
    expect(loadPolicy(writeTempPolicy(validDatum())).exemptPaths).toHaveLength(1);
  });

  it('LoadPolicy_ExemptPathWithExpiry_Fails', () => {
    // The two exemption classes are distinct on purpose. A structural exemption
    // that could lapse would start failing files that must contain the text.
    const file = writeTempPolicy(
      validDatum({
        exemptPaths: [{ glob: 'scripts/x/**', rules: ['comment-content'], reason: 'r', expires: '2099-01-01' }],
      }),
    );

    expect(() => loadPolicy(file)).toThrow(/Exemptions are permanent/);
  });

  it('LoadPolicy_PatternWithoutExplicitEnabled_Fails', () => {
    const file = writeTempPolicy(
      validDatum({ forbiddenOrdinals: [{ id: 'dr', pattern: 'DR-\\d+' }] }),
    );

    expect(() => loadPolicy(file)).toThrow(/explicit boolean/);
  });

  it('LoadPolicy_UncompilablePattern_FailsAtLoad', () => {
    // At load rather than at first use, so a broken pattern fails the run
    // instead of the one file that happens to reach it.
    const file = writeTempPolicy(
      validDatum({ forbiddenOrdinals: [{ id: 'bad', pattern: '(unclosed', enabled: true }] }),
    );

    expect(() => loadPolicy(file)).toThrow(/invalid pattern/);
  });

  it('LoadPolicy_MissingRulesRoster_Fails', () => {
    expect(() => loadPolicy(writeTempPolicy(validDatum({ rules: undefined })))).toThrow(/rules must be an array/);
    expect(() => loadPolicy(writeTempPolicy(validDatum({ rules: [] })))).toThrow(/rules is empty/);
  });

  it('LoadPolicy_ExemptPathWithoutRules_Fails', () => {
    const file = writeTempPolicy(validDatum({ exemptPaths: [{ glob: 'a/**', reason: 'r' }] }));

    expect(() => loadPolicy(file)).toThrow(/exemptPaths\.a\/\*\*\.rules must be an array/);
  });

  it('LoadPolicy_ExemptPathNamingUnknownRule_Fails', () => {
    const file = writeTempPolicy(validDatum({ exemptPaths: [{ glob: 'a/**', rules: ['comment-nothing'], reason: 'r' }] }));

    expect(() => loadPolicy(file)).toThrow(/not in the rules roster/);
  });

  it('LoadPolicy_EmptyForbiddenOrdinals_Fails', () => {
    expect(() => loadPolicy(writeTempPolicy(validDatum({ forbiddenOrdinals: [] })))).toThrow(
      /forbids nothing/,
    );
  });
});

describe('the repository policy datum', () => {
  it('Policy_RepositoryDatum_LoadsCleanly', () => {
    expect(() => loadPolicy(REPO_POLICY)).not.toThrow();
  });

  it('Policy_DefaultPath_PointsAtTheRepositoryDatum', () => {
    expect(fs.existsSync(path.resolve(import.meta.dirname, '../../..', DEFAULT_POLICY_PATH))).toBe(true);
  });

  it('Policy_ExemptPath_NeverExpires', () => {
    const policy = loadPolicy(REPO_POLICY);

    for (const entry of policy.exemptPaths) {
      expect(entry).not.toHaveProperty('expires');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('Policy_EvalRunArtifact_NotScanned', () => {
    // Captured agent output is evidence, not authored code: rewriting it would
    // destroy the record and blocking on it would fail the tree for text no
    // author wrote.
    const policy = loadPolicy(REPO_POLICY);

    expect(isExempt(policy, 'tests/evals/some-suite/runs/2026-08-01/output.md', 'comment-content')).toBe(true);
  });

  it('Policy_OwnSourcesAndFixtures_AreExempt', () => {
    const policy = loadPolicy(REPO_POLICY);

    for (const rel of [
      '.exarchos/comment-policy.json',
      'tools/audit/lib/comment-classifier.mjs',
      'tools/audit/__fixtures__/comment-hygiene/offenders.ts',
      'tools/eslint-rules/comment-content.js',
      'tools/audit/gates/lint-comments.mjs',
      'tests/scripts/eslint-rules/comment-content.test.ts',
    ]) {
      expect(isExempt(policy, rel, 'comment-content'), rel).toBe(true);
    }
  });

  it('Policy_OrdinaryProductionSource_NotExempt', () => {
    const policy = loadPolicy(REPO_POLICY);

    expect(isExempt(policy, 'src/registry.ts', 'comment-content')).toBe(false);
    expect(isExempt(policy, 'tests/evals/harness/grader.ts', 'comment-content')).toBe(false);
  });

  it('Policy_MeasuredBelowFloor_ShipsDisabledWithItsNumber', () => {
    // Both of these were measured against the tree rather than assumed, and the
    // reason records the score so the decision can be re-read.
    const policy = loadPolicy(REPO_POLICY);

    for (const id of ['no-longer', 'passive-change-verb']) {
      const entry = policy.changelogPatterns.find((p) => p.id === id);
      expect(entry?.enabled, `"${id}" should ship disabled`).toBe(false);
      expect(entry?.disabledReason).toMatch(/Measured/);
    }
  });

  it('Policy_EveryExemptGlob_MatchesATrackedFile', async () => {
    const tracked = (await execFileAsync('git', ['ls-files'], { cwd: path.dirname(path.dirname(REPO_POLICY)) }))
      .split('\n')
      .filter((line) => line.length > 0);
    const policy = loadPolicy(REPO_POLICY);
    const dead = policy.exemptPaths
      .filter((entry) => !tracked.some((file) => entry.rules.some((rule) => isExempt({ ...policy, exemptPaths: [entry] }, file, rule))))
      .map((entry) => entry.glob);

    expect(policy.exemptPaths.length).toBeGreaterThan(0);
    expect(dead, 'exemption globs that match no tracked file').toEqual([]);
  });

  it('IsExempt_RuleOutsideTheRoster_Throws', () => {
    expect(() => isExempt(loadPolicy(REPO_POLICY), 'src/a.ts', 'comment-nothing')).toThrow(PolicyError);
  });
});

describe('compilePattern', () => {
  it('CompilePattern_CalledTwice_DoesNotShareLastIndex', () => {
    // A shared g-flagged expression carries lastIndex between uses and silently
    // skips matches in whichever file is scanned second.
    const entry = { id: 'dr', pattern: 'DR-\\d+', flags: 'g', enabled: true };

    expect(compilePattern(entry).test('see DR-7')).toBe(true);
    expect(compilePattern(entry).test('see DR-7')).toBe(true);
  });
});

describe('glob matching', () => {
  it('Glob_DoubleStar_CrossesDirectories', () => {
    const policy = loadPolicy(
      writeTempPolicy(validDatum({ exemptPaths: [{ glob: 'a/**/c.ts', rules: ['comment-content'], reason: 'r' }] })),
    );

    expect(isExempt(policy, 'a/b/c.ts', 'comment-content')).toBe(true);
    expect(isExempt(policy, 'a/b/d/c.ts', 'comment-content')).toBe(true);
    expect(isExempt(policy, 'a/c.ts', 'comment-content')).toBe(true);
  });

  it('Glob_SingleStar_DoesNotCrossDirectories', () => {
    const policy = loadPolicy(
      writeTempPolicy(validDatum({ exemptPaths: [{ glob: 'a/*.ts', rules: ['comment-content'], reason: 'r' }] })),
    );

    expect(isExempt(policy, 'a/b.ts', 'comment-content')).toBe(true);
    expect(isExempt(policy, 'a/b/c.ts', 'comment-content')).toBe(false);
  });
});
