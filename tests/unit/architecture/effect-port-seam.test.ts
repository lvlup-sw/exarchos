import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditEffectPorts,
  runEffectPortCensus,
  footprintOf,
  moduleFootprint,
  CONFORMANCE_EFFECT_PORTS,
  NARROW_EFFECT_PORTS,
  type EffectPortRule,
} from '../../../src/architecture/effect-port-seam.js';
import { scanEffectOccurrences, type EffectOccurrence } from '../../../src/architecture/effect-ledger.js';
import { lexModule } from '../../../tools/test-helpers/module-lexer.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../src');
/** `<repo>/tools/conformance/src` — `src/` sits directly beneath the repo root. */
const CONFORMANCE_SRC_ROOT = join(SRC_ROOT, '..', 'tools', 'conformance', 'src');

describe('footprintOf / moduleFootprint', () => {
  it('collects the distinct effect classes of a module from occurrences', () => {
    const occ: EffectOccurrence[] = [
      { module: 'a.ts', effectClass: 'filesystem', evidence: 'fs' },
      { module: 'a.ts', effectClass: 'process', evidence: 'cp' },
      { module: 'b.ts', effectClass: 'network', evidence: 'fetch' },
    ];
    expect([...footprintOf('a.ts', occ)].sort()).toEqual(['filesystem', 'process']);
    expect([...footprintOf('b.ts', occ)].sort()).toEqual(['network']);
    expect([...footprintOf('z.ts', occ)]).toEqual([]);
  });

  it('derives a footprint from real source via the ledger detector', () => {
    expect([...moduleFootprint('x.ts', `import net from 'node:net';`, lexModule)]).toEqual(['network']);
  });
});

describe('runEffectPortCensus — verdict logic', () => {
  const rules: EffectPortRule[] = [{ module: 'w/feedback.ts', port: ['network'], note: 'n' }];

  it('flags a module performing a class outside its port as BROAD_EFFECT_CONTEXT', () => {
    const occ: EffectOccurrence[] = [
      { module: 'w/feedback.ts', effectClass: 'network', evidence: 'fetch' },
      { module: 'w/feedback.ts', effectClass: 'filesystem', evidence: 'fs' },
    ];
    const result = runEffectPortCensus(occ, rules);
    expect(result.ok).toBe(false);
    const broad = result.diagnostics.find((d) => d.code === 'BROAD_EFFECT_CONTEXT');
    expect(broad && 'effectClass' in broad && broad.effectClass).toBe('filesystem');
    expect(broad && 'module' in broad && broad.module).toBe('w/feedback.ts');
  });

  /** With no occurrence, the declared `network` class covers nothing. */
  it('flags a port declaring an unperformed class (or a gone module) as STALE_EFFECT_PORT', () => {
    const result = runEffectPortCensus([], rules);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_EFFECT_PORT');
  });

  it('passes when the module footprint equals its declared port exactly', () => {
    const occ: EffectOccurrence[] = [
      { module: 'w/feedback.ts', effectClass: 'network', evidence: 'fetch' },
    ];
    expect(runEffectPortCensus(occ, rules).ok).toBe(true);
  });
});

describe('EXIT PROOF — live narrow effect ports', () => {
  /** The diagnostics assertion comes first, so a failure prints each diagnostic. */
  it('(a) every curated module holds exactly its declared narrow port', async () => {
    const result = await auditEffectPorts(SRC_ROOT, lexModule);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ruleCount).toBeGreaterThan(0);
  });

  /** `workflow/feedback.ts` declares a network-only port, so the planted process effect is outside its port. */
  it('(b) a planted broad effect on a narrow-port module FAILS against the live footprints', async () => {
    const occurrences = await scanEffectOccurrences(SRC_ROOT, lexModule);
    const planted: EffectOccurrence = {
      module: 'workflow/feedback.ts',
      effectClass: 'process',
      evidence: 'node:child_process',
    };
    const result = runEffectPortCensus([...occurrences, planted], NARROW_EFFECT_PORTS);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === 'BROAD_EFFECT_CONTEXT' &&
          'module' in d &&
          d.module === 'workflow/feedback.ts' &&
          d.effectClass === 'process',
      ),
    ).toBe(true);
  });

  it('every declared port module performs at least one of its declared classes (no phantom)', async () => {
    const occurrences = await scanEffectOccurrences(SRC_ROOT, lexModule);
    for (const rule of NARROW_EFFECT_PORTS) {
      const actual = footprintOf(rule.module, occurrences);
      for (const cls of rule.port) {
        expect(actual.has(cls), `${rule.module} does not perform declared ${cls}`).toBe(true);
      }
    }
  });
});

/**
 * The same proof for the port modules of the conformance package.
 * The census keys a module relative to the root that it scans, so these modules need a second pass over their root.
 */
describe('EXIT PROOF — live narrow effect ports (conformance package)', () => {
  it('(a) every curated conformance module holds exactly its declared narrow port', async () => {
    const result = await auditEffectPorts(CONFORMANCE_SRC_ROOT, lexModule, CONFORMANCE_EFFECT_PORTS);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ruleCount).toBeGreaterThan(0);
  });

  it('every declared conformance port module performs its declared classes (no phantom)', async () => {
    const occurrences = await scanEffectOccurrences(CONFORMANCE_SRC_ROOT, lexModule);
    for (const rule of CONFORMANCE_EFFECT_PORTS) {
      const actual = footprintOf(rule.module, occurrences);
      for (const cls of rule.port) {
        expect(actual.has(cls), `${rule.module} does not perform declared ${cls}`).toBe(true);
      }
    }
  });
});
