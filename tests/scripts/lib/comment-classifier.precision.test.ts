import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '../../../scripts/lib/comment-policy.mjs';
import { classifyText } from '../../../scripts/lib/comment-classifier.mjs';

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
  fs.readFileSync(path.join(REPO_ROOT, 'scripts/__fixtures__/comment-hygiene/precision-sample.json'), 'utf8'),
) as {
  floor: { threshold: number; sampleSize: number };
  scannedFiles: number;
  indeterminateFiles: number;
  patterns: Record<string, PatternAudit>;
};

const declared = [...policy.forbiddenOrdinals, ...policy.changelogPatterns];

describe('precision audit', () => {
  it('Precision_SampledPattern_ScoreRecorded', () => {
    // Every pattern that ships carries an adjudicated number, so the decision
    // to enable it can be re-read rather than taken on trust.
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

  it('Precision_PatternBelowFloor_ShipsDisabled', () => {
    // The floor is the mechanism, so a measured miss must actually switch the
    // pattern off rather than being recorded and ignored.
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

  it('Precision_DisabledPattern_RecordsWhyAndKeepsItsEvidence', () => {
    // A disabled pattern is a deferred decision, not a dead one: whoever picks
    // it up needs the failing cases, not just the score.
    for (const entry of declared) {
      if (entry.enabled) continue;
      expect(entry.disabledReason, `"${entry.id}" is disabled without a reason`).toBeTruthy();
      expect(audit.patterns[entry.id]!.basis).toBeTruthy();
    }
  });

  it('Precision_TypeParameterT_NotClassifiedAsOrdinal', () => {
    // The measured collision class for a bare `T<n>`: generic parameters,
    // template tags, link tags and timing notation all appear in this tree.
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

  it('Precision_HyphenatedTaskShorthand_StillRejected', () => {
    // Narrowing to the hyphenated form must not cost the real citations.
    expect(classifyText('follows T-35 exactly', policy).map((f) => f.patternId)).toContain(
      'task-shorthand',
    );
  });

  it('Precision_RecordedFalsePositives_StayUnreported', () => {
    // The adjudicated misses are a regression corpus: if a later narrowing
    // enables one of these patterns, these exact phrasings must stay silent.
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

  it('Precision_AuditCorpus_CoversEveryDeclaredPattern', () => {
    // A pattern added to the policy without an adjudicated number would ship
    // on an assumption, which is the thing the floor exists to prevent.
    const declaredIds = new Set(declared.map((p) => p.id));
    const auditedIds = new Set(Object.keys(audit.patterns));

    expect([...declaredIds].filter((id) => !auditedIds.has(id))).toEqual([]);
  });

  it('Precision_Measurement_ScannedARealTreeAndFoundNoIndeterminateFiles', () => {
    // A parse-based extractor that silently skipped files would understate
    // every number above it.
    expect(audit.scannedFiles).toBeGreaterThan(1000);
    expect(audit.indeterminateFiles).toBe(0);
  });
});
