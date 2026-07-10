import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import {
  stampProvenance,
  assertMeasured,
  isMeasured,
  ProvenanceError,
  REQUIRED_PROVENANCE_KEYS,
  type Provenance,
  type MeasurementSource,
  type SourcedRecord,
} from './provenance.js';

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbNonEmptyString = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

const arbProvenance: fc.Arbitrary<Provenance> = fc.record({
  binaryTag: arbNonEmptyString,
  gitSha: arbNonEmptyString,
  modelIds: fc.array(arbNonEmptyString, { minLength: 1, maxLength: 4 }),
  date: arbNonEmptyString,
});

const arbRecord = fc.record({
  metric: fc.double({ noNaN: true }),
  label: fc.string(),
});

// ─── stampProvenance: property round-trip on the pure core ──────────────────

describe('stampProvenance property', () => {
  it('Roundtrip_ArbitraryValidInputs_RequiredKeysIntact', () => {
    fc.assert(
      fc.property(arbRecord, arbProvenance, (record, provenance) => {
        const stamped = stampProvenance(record, provenance);

        // All four required provenance keys round-trip intact.
        expect(stamped.provenance.binaryTag).toBe(provenance.binaryTag);
        expect(stamped.provenance.gitSha).toBe(provenance.gitSha);
        expect(stamped.provenance.modelIds).toEqual(provenance.modelIds);
        expect(stamped.provenance.date).toBe(provenance.date);

        // The exact required-key set is present on the stamp.
        for (const key of REQUIRED_PROVENANCE_KEYS) {
          expect(stamped.provenance).toHaveProperty(key);
        }

        // The record's own fields survive unchanged.
        expect(stamped.metric).toBe(record.metric);
        expect(stamped.label).toBe(record.label);
      }),
      { numRuns: 50 }
    );
  });

  it('Pure_SameInputsSameOutput_Deterministic', () => {
    fc.assert(
      fc.property(arbRecord, arbProvenance, (record, provenance) => {
        expect(stampProvenance(record, provenance)).toEqual(stampProvenance(record, provenance));
      }),
      { numRuns: 30 }
    );
  });

  it('NoAlias_MutatingCallerModelIds_DoesNotLeakIntoStamp', () => {
    const modelIds = ['opus', 'sonnet'];
    const stamped = stampProvenance({ metric: 1 }, {
      binaryTag: 'v2.12.0-preview.2',
      gitSha: 'a240b4d8',
      modelIds,
      date: '2026-07-09',
    });
    modelIds.push('haiku');
    expect(stamped.provenance.modelIds).toEqual(['opus', 'sonnet']);
  });
});

// ─── stampProvenance: throws when a required key is missing ─────────────────

describe('stampProvenance validation', () => {
  const complete: Provenance = {
    binaryTag: 'v2.12.0-preview.2',
    gitSha: 'a240b4d8',
    modelIds: ['claude-opus-4-8'],
    date: '2026-07-09',
  };

  it('Accepts_CompleteProvenance_DoesNotThrow', () => {
    expect(() => stampProvenance({ n: 1 }, complete)).not.toThrow();
  });

  it.each(REQUIRED_PROVENANCE_KEYS)('Throws_When_%s_Missing', (key) => {
    const partial = { ...complete } as Record<string, unknown>;
    delete partial[key];
    expect(() => stampProvenance({ n: 1 }, partial as unknown as Provenance)).toThrow(ProvenanceError);
  });

  it('Throws_When_EmptyStringField', () => {
    expect(() => stampProvenance({ n: 1 }, { ...complete, gitSha: '   ' })).toThrow(ProvenanceError);
  });

  it('Throws_When_ModelIdsEmptyArray', () => {
    expect(() => stampProvenance({ n: 1 }, { ...complete, modelIds: [] })).toThrow(ProvenanceError);
  });

  it('Throws_When_ModelIdsContainsEmptyString', () => {
    expect(() => stampProvenance({ n: 1 }, { ...complete, modelIds: ['ok', ''] })).toThrow(ProvenanceError);
  });
});

// ─── assertMeasured: rejects modeled/assumed, accepts measured ──────────────

describe('assertMeasured', () => {
  it('Accepts_MeasuredRecord_DoesNotThrow', () => {
    const record: SourcedRecord = { source: 'measured' };
    expect(() => assertMeasured(record)).not.toThrow();
  });

  it('Rejects_ModeledRecord_Throws', () => {
    const record: SourcedRecord = { source: 'modeled' };
    expect(() => assertMeasured(record)).toThrow(ProvenanceError);
  });

  it('Rejects_AssumedRecord_Throws', () => {
    const record: SourcedRecord = { source: 'assumed' };
    expect(() => assertMeasured(record)).toThrow(ProvenanceError);
  });

  it('Rejects_MissingSource_Throws', () => {
    expect(() => assertMeasured({} as unknown as SourcedRecord)).toThrow(ProvenanceError);
  });

  it('Rejects_EveryNonMeasuredSource_Throws', () => {
    const nonMeasured: MeasurementSource[] = ['modeled', 'assumed'];
    for (const source of nonMeasured) {
      expect(() => assertMeasured({ source })).toThrow(ProvenanceError);
    }
  });

  it('Narrows_MeasuredRecord_AfterAssertion', () => {
    const record: SourcedRecord & { value: number } = { source: 'measured', value: 42 };
    assertMeasured(record);
    // After the assertion the record is narrowed to the measured variant; value survives.
    expect(record.value).toBe(42);
  });
});

// ─── isMeasured: non-throwing predicate ─────────────────────────────────────

describe('isMeasured', () => {
  it('True_ForMeasured_FalseOtherwise', () => {
    expect(isMeasured({ source: 'measured' })).toBe(true);
    expect(isMeasured({ source: 'modeled' })).toBe(false);
    expect(isMeasured({ source: 'assumed' })).toBe(false);
  });
});
