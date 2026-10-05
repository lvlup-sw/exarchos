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

  /** The loader fails closed. A guard with no rules gives the same result as a clean tree. */
  it('LoadPolicy_MissingFile_ExitsNonZero', () => {
    expect(() => loadPolicy(path.join(os.tmpdir(), 'absent-policy-file.json'))).toThrow(PolicyError);
  });

  it('LoadPolicy_MalformedJson_ExitsNonZero', () => {
    expect(() => loadPolicy(writeTempPolicy('{ not json'))).toThrow(PolicyError);
  });

  it('LoadPolicy_ExemptPathWithoutExpiry_Accepted', () => {
    expect(loadPolicy(writeTempPolicy(validDatum())).exemptPaths).toHaveLength(1);
  });

  /** An exemption is structural and permanent. An expired exemption fails files that must contain the text. */
  it('LoadPolicy_ExemptPathWithExpiry_Fails', () => {
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

  /** A bad pattern must fail at load, not at first use, so it fails the run and not one file. */
  it('LoadPolicy_UncompilablePattern_FailsAtLoad', () => {
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

  it('LoadPolicy_PlacementInRoster_RequiresEveryPlacementCheck', () => {
    const checks = ['banner', 'trailing', 'in-body', 'non-jsdoc', 'detached', 'floating'].map((id) => ({ id, enabled: true, message: 'm' }));
    const datum = (placement: unknown) => validDatum({ rules: ['comment-content', 'comment-placement'], placement });

    expect(loadPolicy(writeTempPolicy(datum({ testCallees: ['it'], checks }))).placement?.checks.size).toBe(6);
    expect(() => loadPolicy(writeTempPolicy(datum({ testCallees: ['it'], checks: checks.slice(1) })))).toThrow(/does not declare: banner/);
    expect(() => loadPolicy(writeTempPolicy(datum({ testCallees: ['it'], checks: [...checks, { id: 'nope', enabled: true, message: 'm' }] })))).toThrow(
      /not a placement check/,
    );
    expect(() => loadPolicy(writeTempPolicy(datum({ testCallees: ['it'], checks: [{ id: 'banner', message: 'm' }] })))).toThrow(/explicit boolean/);
    expect(() => loadPolicy(writeTempPolicy(datum(undefined)))).toThrow(/placement must be an object/);
  });

  it('LoadPolicy_PlacementOutsideRoster_IsAbsent', () => {
    expect(loadPolicy(writeTempPolicy(validDatum())).placement).toBeUndefined();
  });

  it('LoadPolicy_ProseInRoster_RequiresEveryCheckAndBudget', () => {
    const placement = { testCallees: ['it'], checks: ['banner', 'trailing', 'in-body', 'non-jsdoc', 'detached', 'floating'].map((id) => ({ id, enabled: true, message: 'm' })) };
    const steChecks = [
      { id: 'sentence-length', steRule: '6.3', limit: 25, enabled: true, remedy: 'r' },
      { id: 'paragraph-length', steRule: '6.6', limit: 6, enabled: true, remedy: 'r' },
      ...['semicolon', 'modal', 'contraction', 'perfect-tense', 'progressive-passive', 'latin-abbreviation'].map((id) => ({ id, steRule: '8.1', pattern: ';', enabled: true, remedy: 'r' })),
      { id: 'filler', source: 'table', terms: [{ term: 'just', pattern: '\\bjust\\b', use: 'delete it' }], enabled: true, remedy: 'r' },
    ];
    const budgets = [
      { id: 'header-lines', lines: 15, enabled: true, remedy: 'r' },
      { id: 'doc-lines', lines: 10, enabled: true, remedy: 'r' },
    ];
    const skill = { canonical: 'a/SKILL.md', mirror: 'b/SKILL.md', version: '1.2.0' };
    const datum = (prose: unknown, rules = ['comment-content', 'comment-placement', 'comment-prose']) => validDatum({ rules, placement, prose });

    expect(loadPolicy(writeTempPolicy(datum({ skill, steChecks, budgets }))).prose?.steChecks.map((c) => c.cite)).toContain('STE 6.3');
    expect(() => loadPolicy(writeTempPolicy(datum({ skill, steChecks: steChecks.slice(1), budgets })))).toThrow(/does not declare: sentence-length/);
    expect(() => loadPolicy(writeTempPolicy(datum({ skill, steChecks, budgets: budgets.slice(1) })))).toThrow(/does not declare: header-lines/);
    expect(() => loadPolicy(writeTempPolicy(datum({ skill, steChecks: [{ ...steChecks[0], enabled: false }, ...steChecks.slice(1)], budgets })))).toThrow(
      /disabled without a `disabledReason`/,
    );
    expect(() => loadPolicy(writeTempPolicy(datum({ skill, steChecks: [{ ...steChecks[0], source: 'x' }, ...steChecks.slice(1)], budgets })))).toThrow(
      /exactly one of `steRule` and `source`/,
    );
    expect(() => loadPolicy(writeTempPolicy(datum({ skill, steChecks, budgets }, ['comment-content', 'comment-prose'])))).toThrow(/must also name comment-placement/);
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

  /** Captured agent output is evidence, not authored code. A rewrite destroys the record. */
  it('Policy_EvalRunArtifact_NotScanned', () => {
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

  /** Each pattern was measured on the tree. Its reason records the measurement, so a reader can audit the decision. */
  it('Policy_MeasuredBelowFloor_ShipsDisabledWithItsNumber', () => {
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
  /** A shared expression with the `g` flag keeps `lastIndex` between uses and skips matches in the next file. */
  it('CompilePattern_CalledTwice_DoesNotShareLastIndex', () => {
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
