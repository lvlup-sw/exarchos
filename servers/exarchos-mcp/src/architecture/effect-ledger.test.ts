import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditEffectOwnership,
  runEffectLedgerCensus,
  detectModuleEffects,
  scanEffectOccurrences,
  ruleClaims,
  isScannableFile,
  EFFECT_OWNERSHIP,
  type EffectOccurrence,
  type EffectOwnershipRule,
} from './effect-ledger.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('detectModuleEffects', () => {
  it('classifies fs / process / network imports', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `import { readFile } from 'node:fs/promises';
       import { execFile } from 'node:child_process';
       import net from 'node:net';`,
    );
    const classes = occ.map((o) => o.effectClass).sort();
    expect(classes).toEqual(['filesystem', 'network', 'process']);
  });

  it('detects a global fetch as a network effect', () => {
    const occ = detectModuleEffects('x/y.ts', `export async function f() { return fetch('http://x'); }`);
    expect(occ.map((o) => o.effectClass)).toContain('network');
  });

  it('does NOT classify a specifier that only appears in a comment or string', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `// import { x } from 'node:fs';\nconst s = "from 'node:child_process'"; export const y = 1;`,
    );
    expect(occ).toHaveLength(0);
  });

  it('dedupes multiple fs imports into one filesystem occurrence', () => {
    const occ = detectModuleEffects(
      'x/y.ts',
      `import { readFile } from 'node:fs/promises';\nimport { existsSync } from 'node:fs';`,
    );
    expect(occ.filter((o) => o.effectClass === 'filesystem')).toHaveLength(1);
  });
});

describe('runEffectLedgerCensus — verdict logic', () => {
  const rules: EffectOwnershipRule[] = [
    { effectClass: 'process', match: 'vcs/', owner: 'vcs', idempotency: 'i', compensation: 'c' },
  ];

  it('flags an occurrence no rule claims as INDETERMINATE_OWNER', () => {
    const occ: EffectOccurrence[] = [
      { module: 'vcs/shell.ts', effectClass: 'process', evidence: 'node:child_process' },
      { module: 'mystery/rogue.ts', effectClass: 'process', evidence: 'node:child_process' },
    ];
    const result = runEffectLedgerCensus(occ, rules);
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('INDETERMINATE_OWNER');
    const indeterminate = result.diagnostics.find((d) => d.code === 'INDETERMINATE_OWNER');
    expect(indeterminate && 'module' in indeterminate && indeterminate.module).toBe('mystery/rogue.ts');
  });

  it('flags a rule that claims nothing as STALE_OWNERSHIP', () => {
    const result = runEffectLedgerCensus([], rules);
    expect(result.diagnostics.map((d) => d.code)).toContain('STALE_OWNERSHIP');
  });

  it('passes when every occurrence is claimed and every rule claims something', () => {
    const occ: EffectOccurrence[] = [
      { module: 'vcs/shell.ts', effectClass: 'process', evidence: 'node:child_process' },
    ];
    expect(runEffectLedgerCensus(occ, rules).ok).toBe(true);
  });
});

describe('ruleClaims', () => {
  it('prefix rule matches by directory; exact rule matches the module only', () => {
    const prefix: EffectOwnershipRule = { effectClass: 'filesystem', match: 'storage/', owner: 'o', idempotency: 'i', compensation: 'c' };
    const exact: EffectOwnershipRule = { effectClass: 'network', match: 'workflow/feedback.ts', owner: 'o', idempotency: 'i', compensation: 'c' };
    expect(ruleClaims(prefix, { module: 'storage/db.ts', effectClass: 'filesystem', evidence: 'fs' })).toBe(true);
    expect(ruleClaims(prefix, { module: 'storaged/db.ts', effectClass: 'filesystem', evidence: 'fs' })).toBe(false);
    expect(ruleClaims(exact, { module: 'workflow/feedback.ts', effectClass: 'network', evidence: 'fetch' })).toBe(true);
    expect(ruleClaims(exact, { module: 'workflow/other.ts', effectClass: 'network', evidence: 'fetch' })).toBe(false);
  });
});

describe('EXIT PROOF — live effect ledger', () => {
  it('(a) the live shipped source has ZERO indeterminate owners and no stale cover', async () => {
    const result = await auditEffectOwnership(SRC_ROOT);
    // Surfacing the diagnostics array makes any regression self-describing.
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.occurrenceCount).toBeGreaterThan(0);
  });

  it('(b) a planted unowned effect FAILS the census against the live rules', async () => {
    const occurrences = await scanEffectOccurrences(SRC_ROOT);
    const planted: EffectOccurrence = {
      module: 'channel/rogue-emitter.ts',
      effectClass: 'filesystem',
      evidence: 'node:fs',
    };
    const result = runEffectLedgerCensus([...occurrences, planted], EFFECT_OWNERSHIP);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'INDETERMINATE_OWNER' && 'module' in d && d.module === 'channel/rogue-emitter.ts',
      ),
    ).toBe(true);
  });
});

describe('isScannableFile', () => {
  it('accepts shipped .ts and rejects test/decl/bench files', () => {
    expect(isScannableFile('emitter.ts')).toBe(true);
    expect(isScannableFile('emitter.test.ts')).toBe(false);
    expect(isScannableFile('types.d.ts')).toBe(false);
    expect(isScannableFile('x.bench.ts')).toBe(false);
  });
});
