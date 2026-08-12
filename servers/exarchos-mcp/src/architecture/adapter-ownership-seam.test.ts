import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditAdapterOwnership,
  runAdapterOwnershipCensus,
  ADAPTER_OWNERSHIP,
  type AdapterOwnershipRule,
} from './adapter-ownership-seam.js';
import { scanEffectOccurrences, type EffectOccurrence } from './effect-ledger.js';
import { lexModule } from '../test-helpers/module-lexer.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('runAdapterOwnershipCensus — verdict logic', () => {
  const rules: AdapterOwnershipRule[] = [
    { adapter: 'network-adapter', effectClass: 'network', owners: ['workflow/feedback.ts'], note: 'n' },
  ];

  it('flags a network effect outside the owner surface as DIRECT_ADAPTER_BYPASS', () => {
    const occ: EffectOccurrence[] = [
      { module: 'workflow/feedback.ts', effectClass: 'network', evidence: 'fetch' },
      { module: 'verbs/rogue.ts', effectClass: 'network', evidence: 'undici' },
    ];
    const result = runAdapterOwnershipCensus(occ, rules);
    expect(result.ok).toBe(false);
    const bypass = result.diagnostics.find((d) => d.code === 'DIRECT_ADAPTER_BYPASS');
    expect(bypass && 'module' in bypass && bypass.module).toBe('verbs/rogue.ts');
    expect(bypass && 'evidence' in bypass && bypass.evidence).toBe('undici');
  });

  it('does NOT flag a different effect class (only the adapter class is confined)', () => {
    const occ: EffectOccurrence[] = [
      { module: 'workflow/feedback.ts', effectClass: 'network', evidence: 'fetch' },
      { module: 'anywhere/x.ts', effectClass: 'filesystem', evidence: 'fs' },
    ];
    expect(runAdapterOwnershipCensus(occ, rules).ok).toBe(true);
  });

  it('flags an owner that performs no such effect as STALE_ADAPTER_OWNER', () => {
    const result = runAdapterOwnershipCensus([], rules);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_ADAPTER_OWNER');
  });

  it('passes when every occurrence is owned and every owner claims the effect', () => {
    const occ: EffectOccurrence[] = [
      { module: 'workflow/feedback.ts', effectClass: 'network', evidence: 'fetch' },
    ];
    expect(runAdapterOwnershipCensus(occ, rules).ok).toBe(true);
  });
});

describe('EXIT PROOF — live adapter ownership', () => {
  it('(a) the live shipped source confines every declared adapter to its owner surface', async () => {
    const result = await auditAdapterOwnership(SRC_ROOT, lexModule);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ruleCount).toBeGreaterThan(0);
  });

  it('(b) a planted network effect outside the owner surface FAILS against the live occurrences', async () => {
    const occurrences = await scanEffectOccurrences(SRC_ROOT, lexModule);
    const planted: EffectOccurrence = {
      module: 'verbs/rogue-client.ts',
      effectClass: 'network',
      evidence: 'undici',
    };
    const result = runAdapterOwnershipCensus([...occurrences, planted], ADAPTER_OWNERSHIP);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === 'DIRECT_ADAPTER_BYPASS' &&
          'module' in d &&
          d.module === 'verbs/rogue-client.ts',
      ),
    ).toBe(true);
  });

  it('every declared adapter owner performs the effect it owns (no phantom owner)', async () => {
    const occurrences = await scanEffectOccurrences(SRC_ROOT, lexModule);
    for (const rule of ADAPTER_OWNERSHIP) {
      for (const owner of rule.owners) {
        expect(
          occurrences.some((o) => o.module === owner && o.effectClass === rule.effectClass),
          `${rule.adapter} owner ${owner} performs no ${rule.effectClass}`,
        ).toBe(true);
      }
    }
  });
});
