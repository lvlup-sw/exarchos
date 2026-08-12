import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPolicy,
  isExempt,
  isWaived,
  compilePattern,
  PolicyError,
  DEFAULT_POLICY_PATH,
} from './comment-policy.mjs';

const REPO_POLICY = path.resolve(import.meta.dirname, '../../.exarchos/comment-policy.json');

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
    exemptPaths: [{ glob: 'scripts/__fixtures__/**', reason: 'fixtures carry offender text' }],
    waivers: [],
    coverage: {},
    ...overrides,
  });
}

describe('loadPolicy', () => {
  it('LoadPolicy_ValidDatum_ExposesEveryDeclaredClass', () => {
    const policy = loadPolicy(writeTempPolicy(validDatum()));

    expect(policy.forbiddenOrdinals.map((p) => p.id)).toEqual(['dr']);
    expect(policy.allowedReferences.map((p) => p.id)).toEqual(['url']);
    expect(policy.changelogPatterns.map((p) => p.id)).toEqual(['formerly']);
    expect(policy.exemptPaths.map((p) => p.glob)).toEqual(['scripts/__fixtures__/**']);
    expect(policy.waivers).toEqual([]);
  });

  it('LoadPolicy_MissingFile_ExitsNonZero', () => {
    // Fail closed: running with defaults would give a guard no rules, which is
    // indistinguishable from a clean tree.
    expect(() => loadPolicy(path.join(os.tmpdir(), 'absent-policy-file.json'))).toThrow(PolicyError);
  });

  it('LoadPolicy_MalformedJson_ExitsNonZero', () => {
    expect(() => loadPolicy(writeTempPolicy('{ not json'))).toThrow(PolicyError);
  });

  it('LoadPolicy_ExpiredWaiver_Fails', () => {
    const file = writeTempPolicy(
      validDatum({
        waivers: [
          { glob: 'src/legacy.ts', owner: 'reed', expires: '2020-01-01', reason: 'inherited debt' },
        ],
      }),
    );

    expect(() => loadPolicy(file)).toThrow(/expired on 2020-01-01/);
  });

  it('LoadPolicy_LiveWaiver_Accepted', () => {
    const file = writeTempPolicy(
      validDatum({
        waivers: [
          { glob: 'src/legacy.ts', owner: 'reed', expires: '2099-01-01', reason: 'inherited debt' },
        ],
      }),
    );

    expect(loadPolicy(file).waivers[0]?.owner).toBe('reed');
  });

  it('LoadPolicy_WaiverWithoutOwner_Fails', () => {
    const file = writeTempPolicy(
      validDatum({ waivers: [{ glob: 'src/a.ts', expires: '2099-01-01', reason: 'x' }] }),
    );

    expect(() => loadPolicy(file)).toThrow(/owner/);
  });

  it('LoadPolicy_ExemptPathWithoutExpiry_Accepted', () => {
    expect(loadPolicy(writeTempPolicy(validDatum())).exemptPaths).toHaveLength(1);
  });

  it('LoadPolicy_ExemptPathWithExpiry_Fails', () => {
    // The two exemption classes are distinct on purpose. A structural exemption
    // that could lapse would start failing files that must contain the text.
    const file = writeTempPolicy(
      validDatum({
        exemptPaths: [{ glob: 'scripts/x/**', reason: 'r', expires: '2099-01-01' }],
      }),
    );

    expect(() => loadPolicy(file)).toThrow(/Structural exemptions are permanent/);
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
    expect(fs.existsSync(path.resolve(import.meta.dirname, '../..', DEFAULT_POLICY_PATH))).toBe(true);
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

    expect(isExempt(policy, 'docs/evals/some-suite/runs/2026-08-01/output.md')).toBe(true);
  });

  it('Policy_OwnSourcesAndFixtures_AreExempt', () => {
    const policy = loadPolicy(REPO_POLICY);

    expect(isExempt(policy, '.exarchos/comment-policy.json')).toBe(true);
    expect(isExempt(policy, 'scripts/lib/comment-classifier.mjs')).toBe(true);
    expect(isExempt(policy, 'scripts/__fixtures__/comment-hygiene/offenders.ts')).toBe(true);
    expect(isExempt(policy, 'eslint-rules/comment-content.js')).toBe(true);
  });

  it('Policy_OrdinaryProductionSource_NotExempt', () => {
    const policy = loadPolicy(REPO_POLICY);

    expect(isExempt(policy, 'servers/exarchos-mcp/src/registry.ts')).toBe(false);
    expect(isExempt(policy, 'docs/evals/harness/grader.ts')).toBe(false);
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

  it('Policy_CoverageRatchet_ShipsDisabledUntilTheTreeSettles', () => {
    const coverage = loadPolicy(REPO_POLICY).coverage as {
      exportedDeclarations?: { enabled?: boolean };
    };

    expect(coverage.exportedDeclarations?.enabled).toBe(false);
  });
});

describe('isWaived', () => {
  it('IsWaived_LiveWaiverMatchingPath_ReturnsTrue', () => {
    const policy = loadPolicy(
      writeTempPolicy(
        validDatum({
          waivers: [{ glob: 'src/legacy/**', owner: 'reed', expires: '2099-01-01', reason: 'debt' }],
        }),
      ),
    );

    expect(isWaived(policy, 'src/legacy/deep/file.ts')).toBe(true);
    expect(isWaived(policy, 'src/current/file.ts')).toBe(false);
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
      writeTempPolicy(validDatum({ exemptPaths: [{ glob: 'a/**/c.ts', reason: 'r' }] })),
    );

    expect(isExempt(policy, 'a/b/c.ts')).toBe(true);
    expect(isExempt(policy, 'a/b/d/c.ts')).toBe(true);
    expect(isExempt(policy, 'a/c.ts')).toBe(true);
  });

  it('Glob_SingleStar_DoesNotCrossDirectories', () => {
    const policy = loadPolicy(
      writeTempPolicy(validDatum({ exemptPaths: [{ glob: 'a/*.ts', reason: 'r' }] })),
    );

    expect(isExempt(policy, 'a/b.ts')).toBe(true);
    expect(isExempt(policy, 'a/b/c.ts')).toBe(false);
  });
});
