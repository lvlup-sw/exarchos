import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../../../tools/audit/lib/comment-policy.mjs';
import { classifyText } from '../../../tools/audit/lib/comment-classifier.mjs';
import { steFindings } from '../../../tools/audit/lib/comment-ste.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const policy = loadPolicy(path.join(REPO_ROOT, '.exarchos/comment-policy.json'));

type PatternAudit = {
  totalMatches: number;
  adjudicated: number;
  truePositives: number;
  precision: number;
  verdict: 'enabled' | 'disabled';
  basis?: string;
  falsePositives?: { file: string; match: string; why: string }[];
};

const audit = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/__fixtures__/comment-hygiene/precision-sample.json'), 'utf8'),
) as {
  floor: { threshold: number; sampleSize: number };
  scannedFiles: number;
  indeterminateFiles: number;
  patterns: Record<string, PatternAudit>;
  checksMeasurement: { measuredAt: string; tree: string; sampling: string; parsedFiles: number };
  checks: Record<string, PatternAudit & { deterministic?: boolean }>;
};

const declared = [...policy.forbiddenOrdinals, ...policy.changelogPatterns];

/** Every placement and prose check, keyed as the sampler keys it, with its enabled flag. */
const declaredChecks: { key: string; enabled: boolean; budget: boolean }[] = [
  ...[...policy.placement!.checks].map(([id, check]) => ({ key: `comment-placement/${id}`, enabled: check.enabled, budget: false })),
  ...policy.prose!.steChecks.map((check) => ({ key: `comment-prose/${check.id}`, enabled: check.enabled, budget: false })),
  ...[...policy.prose!.budgets].map(([id, budget]) => ({ key: `comment-prose/${id}`, enabled: budget.enabled, budget: true })),
];

describe('precision audit', () => {
  /** Each declared pattern must carry an adjudicated score, so a reader can audit the decision to enable it. */
  it('Precision_SampledPattern_ScoreRecorded', () => {
    for (const entry of declared) {
      const record = audit.patterns[entry.id];
      expect(record, `no precision record for pattern "${entry.id}"`).toBeDefined();
      expect(record!.totalMatches).toBeGreaterThanOrEqual(0);
      expect(record!.adjudicated).toBeGreaterThan(0);
      expect(record!.precision).toBeGreaterThanOrEqual(0);
      expect(record!.precision).toBeLessThanOrEqual(1);
    }
  });

  it('Precision_EveryEnabledPattern_MeetsTheFloor', () => {
    const floor = audit.floor.threshold;

    for (const entry of declared) {
      if (!entry.enabled) continue;
      expect(
        audit.patterns[entry.id]!.precision,
        `pattern "${entry.id}" ships enabled below the ${floor} floor`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  /** A pattern below the floor must ship disabled. A record of the miss alone is not sufficient. */
  it('Precision_PatternBelowFloor_ShipsDisabled', () => {
    const belowFloor = Object.entries(audit.patterns).filter(
      ([, record]) => record.precision < audit.floor.threshold,
    );

    expect(belowFloor.length).toBeGreaterThan(0);

    for (const [id, record] of belowFloor) {
      expect(record.verdict).toBe('disabled');
      expect(declared.find((p) => p.id === id)?.enabled, `"${id}" is below the floor but enabled`).toBe(
        false,
      );
    }
  });

  /** A disabled pattern is a deferred decision, so it must keep its reason and the basis of its score. */
  it('Precision_DisabledPattern_RecordsWhyAndKeepsItsEvidence', () => {
    for (const entry of declared) {
      if (entry.enabled) continue;
      expect(entry.disabledReason, `"${entry.id}" is disabled without a reason`).toBeTruthy();
      expect(audit.patterns[entry.id]!.basis).toBeTruthy();
    }
  });

  /** A bare `T` with one digit occurs in generic parameters, template tags, link tags and timing notation. */
  it('Precision_TypeParameterT_NotClassifiedAsOrdinal', () => {
    const survivors = [
      'returns Map<T1, T2> for the caller',
      '@template T1 the element type',
      '{@link T2} names the second parameter',
      'measured from T0 to first byte',
      'the T1 and T2 arms are symmetric',
    ];

    for (const text of survivors) {
      expect(classifyText(text, policy), `"${text}" should not classify as an ordinal`).toEqual([]);
    }
  });

  /** The narrow hyphenated pattern must still catch a real task citation. */
  it('Precision_HyphenatedTaskShorthand_StillRejected', () => {
    expect(classifyText('follows T-35 exactly', policy).map((f) => f.patternId)).toContain(
      'task-shorthand',
    );
  });

  /** These phrasings were false positives in the sample. A pattern that becomes enabled must keep them silent. */
  it('Precision_RecordedFalsePositives_StayUnreported', () => {
    const phrasings = [
      'If `@proof` were renamed, or the tag moved, the assertion goes stale',
      'nothing was renamed — only the place the name is DECLARED moved',
      'a `consumedBy` naming a reducer that was deleted still boots',
      'the routing construct a route was extracted from',
      'allowlist entries knip no longer flags — a non-failing hygiene warning',
      'unprobed rungs may no longer accumulate once the program decides',
    ];

    for (const text of phrasings) {
      const changelogFindings = classifyText(text, policy).filter((f) => f.class === 'changelog');
      expect(changelogFindings, `"${text}" should not be reported as changelog narration`).toEqual([]);
    }
  });

  /** A pattern without an adjudicated score ships on an assumption, which the floor exists to prevent. */
  it('Precision_AuditCorpus_CoversEveryDeclaredPattern', () => {
    const declaredIds = new Set(declared.map((p) => p.id));
    const auditedIds = new Set(Object.keys(audit.patterns));

    expect([...declaredIds].filter((id) => !auditedIds.has(id))).toEqual([]);
  });

  /** An extractor that skips files without a report understates every count in the audit. */
  it('Precision_Measurement_ScannedARealTreeAndFoundNoIndeterminateFiles', () => {
    expect(audit.scannedFiles).toBeGreaterThan(1000);
    expect(audit.indeterminateFiles).toBe(0);
  });
});

describe('placement and prose precision', () => {
  /** A check that blocks without a measured number ships on an assumption, which the floor exists to prevent. */
  it('Precision_EveryPlacementAndProseCheck_HasARecord', () => {
    expect(declaredChecks.length).toBeGreaterThan(10);
    for (const { key } of declaredChecks) {
      const record = audit.checks[key];
      expect(record, `no precision record for "${key}"`).toBeDefined();
      expect(record!.totalMatches).toBeGreaterThan(0);
    }
  });

  it('Precision_EveryEnabledCheck_MeetsTheFloor', () => {
    for (const { key, enabled, budget } of declaredChecks) {
      const record = audit.checks[key]!;
      if (!enabled || (budget && record.deterministic === true)) continue;
      expect(record.adjudicated, `"${key}" has no adjudicated sample`).toBeGreaterThan(0);
      expect(record.precision, `"${key}" ships enabled below the floor`).toBeGreaterThanOrEqual(audit.floor.threshold);
    }
  });

  /** A line count has no false positive, so only a line budget can skip the sample. */
  it('Precision_DeterministicRecord_IsALineBudget', () => {
    for (const { key, budget } of declaredChecks) {
      if (audit.checks[key]?.deterministic === true) expect(budget, `"${key}" claims to be deterministic`).toBe(true);
    }
  });

  it('Precision_CheckBelowTheFloor_ShipsDisabledWithItsEvidence', () => {
    for (const { key, enabled } of declaredChecks) {
      const record = audit.checks[key]!;
      if (record.deterministic === true || record.precision >= audit.floor.threshold) continue;
      expect(enabled, `"${key}" is below the floor but enabled`).toBe(false);
      expect(record.basis).toBeTruthy();
      expect(record.falsePositives?.length).toBeGreaterThan(0);
    }
  });

  /** These phrasings were false positives in the sample. A later change to a pattern must keep them silent. */
  it('Precision_RecordedProseFalsePositives_StayUnreported', () => {
    const silent: [string, string][] = [
      ['contraction', '/** The timer is unref\'d here, and the file is fsync\'d first. */'],
      ['progressive-passive', '/** Its value is being wrong in a way a reader sees. */'],
      ['semicolon', '/** The loop is for(;;) with a break inside. */'],
      ['filler', '/** It runs just before the write, with a graceful shutdown. */'],
    ];
    for (const [checkId, raw] of silent) {
      expect(steFindings(raw, policy.prose!.steChecks).map((f) => f.checkId), raw).not.toContain(checkId);
    }
  });
});

