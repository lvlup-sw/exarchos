import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  OUTPUT_KINDS,
  classifyOutput,
  describeOutputKind,
  economyMarker,
  hasConsistentEconomyState,
  CappedDataSchema,
  OutputEnvelopeSchema,
  type OutputKind,
} from '../../../src/contract/envelope.js';
import type { ToolResult } from '../../../src/format.js';
import { ECONOMY_META_TRUNCATED, ECONOMY_META_DEGRADED } from '../../../src/format.js';

const PERF = { ms: 1, bytes: 2, tokens: 3 };

function baseline(): ToolResult {
  return { success: true, data: { items: [1, 2, 3] }, next_actions: [], _meta: {}, _perf: PERF };
}
function capped(): ToolResult {
  return {
    success: true,
    data: { summary: 's', counts: { total: 3, shown: 1 }, firstPage: [1] },
    next_actions: [],
    _meta: { [ECONOMY_META_TRUNCATED]: true },
    _perf: PERF,
  };
}
function degraded(): ToolResult {
  return {
    success: true,
    data: { items: [1, 2, 3] },
    next_actions: [],
    _meta: { [ECONOMY_META_DEGRADED]: true },
    _perf: PERF,
  };
}
function failure(): ToolResult {
  return { success: false, error: { code: 'HANDLER_ERROR', message: 'boom' }, _meta: {}, _perf: PERF };
}

describe('envelope — output classification (totality)', () => {
  it('Classify_Baseline', () => {
    expect(classifyOutput(baseline())).toBe('baseline');
  });
  it('Classify_Capped', () => {
    expect(classifyOutput(capped())).toBe('capped');
  });
  it('Classify_Degraded', () => {
    expect(classifyOutput(degraded())).toBe('degraded');
  });
  it('Classify_Error', () => {
    expect(classifyOutput(failure())).toBe('error');
  });

  it('EveryToolResultMapsToExactlyOneKind', () => {
    // Totality: the four constructors cover the four kinds, one-to-one.
    const kinds = [baseline(), capped(), degraded(), failure()].map(classifyOutput);
    expect(new Set(kinds)).toEqual(new Set(OUTPUT_KINDS));
  });

  it('DescribeOutputKind_IsTotalOverTheVariantUnion', () => {
    for (const kind of OUTPUT_KINDS) {
      const d = describeOutputKind(kind);
      expect(d.kind).toBe(kind);
    }
    expect(describeOutputKind('error').success).toBe(false);
    expect(describeOutputKind('baseline').success).toBe(true);
    expect(describeOutputKind('capped').economyMarker).toBe(ECONOMY_META_TRUNCATED);
    expect(describeOutputKind('degraded').economyMarker).toBe(ECONOMY_META_DEGRADED);
  });
});

describe('envelope — economy markers', () => {
  it('EconomyMarker_ReadsTheStampedKey', () => {
    expect(economyMarker(baseline())).toBeNull();
    expect(economyMarker(capped())).toBe(ECONOMY_META_TRUNCATED);
    expect(economyMarker(degraded())).toBe(ECONOMY_META_DEGRADED);
  });

  it('Markers_AreMutuallyExclusive', () => {
    expect(hasConsistentEconomyState(baseline())).toBe(true);
    expect(hasConsistentEconomyState(capped())).toBe(true);
    const both: ToolResult = {
      success: true,
      data: {},
      next_actions: [],
      _meta: { [ECONOMY_META_TRUNCATED]: true, [ECONOMY_META_DEGRADED]: true },
      _perf: PERF,
    };
    expect(hasConsistentEconomyState(both)).toBe(false);
  });
});

describe('envelope — closed output union', () => {
  const dataSchema = z.object({ items: z.array(z.number()) });
  const schema = OutputEnvelopeSchema(dataSchema);

  it('AcceptsBaseline', () => {
    expect(schema.safeParse(baseline()).success).toBe(true);
  });
  it('AcceptsGenericCapped', () => {
    // The generic capped fallback validates via the CappedDataSchema arm.
    expect(schema.safeParse(capped()).success).toBe(true);
  });
  it('AcceptsDegraded', () => {
    expect(schema.safeParse(degraded()).success).toBe(true);
  });
  it('AcceptsError', () => {
    expect(schema.safeParse(failure()).success).toBe(true);
  });
  it('RejectsAForeignSuccessDataShape', () => {
    const bogus: ToolResult = {
      success: true,
      data: { unexpected: 'field-not-in-either-arm' },
      next_actions: [],
      _meta: {},
      _perf: PERF,
    };
    expect(schema.safeParse(bogus).success).toBe(false);
  });

  it('CappedDataSchema_PinsTheGenericFallbackShape', () => {
    expect(
      CappedDataSchema.safeParse({
        summary: 's',
        counts: { total: 5, shown: 2 },
        firstPage: [1, 2],
      }).success,
    ).toBe(true);
    expect(CappedDataSchema.safeParse({ summary: 's' }).success).toBe(false);
  });
});

// Silence unused-type lint without exporting it from a test.
const _kindType: OutputKind = 'baseline';
void _kindType;
