// scripts/lint-test-first-drift.test.ts — exercises the #1591 drift guard.
//
// The guard (tools/audit/gates/lint-test-first-drift.mjs) is the standing defense that
// keeps test-FIRST framing (Iron Law / NO PRODUCTION CODE / unconditional RGR
// templates) from creeping back into commands/ + agents/ + content/ after the
// Phase-4 excision. This test is the enforcing CI wiring: a seeded fixture MUST
// fail, the shipped tree MUST pass. (Co-located with the script so the vitest
// 'unit' project's `scripts/**/*.test.ts` include picks it up.)

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(import.meta.dirname, '../../tools/audit/gates/lint-test-first-drift.mjs');

async function runGuard(dirs: string[]): Promise<{ code: number; findings: Array<{ rule: string }> }> {
  const result = await spawnAsync('node', [SCRIPT, ...dirs]);
  return { code: result.status ?? 1, findings: JSON.parse(result.stdout).findings };
}

describe('test-first drift guard (#1591)', () => {
  it('DriftGuard_CleanTree_Passes', async () => {
    const { code, findings } = await runGuard([
      join(REPO_ROOT, 'rendered/commands'),
      join(REPO_ROOT, 'rendered/agents'),
      join(REPO_ROOT, 'content'),
    ]);
    expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
    expect(code).toBe(0);
  });

  it('DriftGuard_SeededIronLawFixture_Fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-guard-'));
    try {
      writeFileSync(
        join(dir, 'bad.md'),
        [
          '# Plan',
          '## Iron Law',
          '> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST',
          '1. [RED] write test',
          '2. [GREEN] impl',
          '3. [REFACTOR] clean',
        ].join('\n'),
      );
      const { code, findings } = await runGuard([dir]);
      const rules = findings.map((f) => f.rule);
      expect(rules).toContain('iron-law');
      expect(rules).toContain('no-production-code-first');
      expect(rules).toContain('unconditional-rgr-template');
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DriftGuard_LowercaseRgrVariant_Fails', async () => {
    // The unconditional-RGR rule is case-insensitive: a `[Red]`/`[green]`
    // variant must not bypass the guard. (Iron-Law / NO-PRODUCTION literals
    // are already case-insensitive.)
    const dir = mkdtempSync(join(tmpdir(), 'drift-guard-'));
    try {
      writeFileSync(
        join(dir, 'bad.md'),
        [
          '# Plan',
          '1. [Red] write test',
          '2. [green] impl',
          '3. [Refactor] clean',
        ].join('\n'),
      );
      const { code, findings } = await runGuard([dir]);
      expect(findings.map((f) => f.rule)).toContain('unconditional-rgr-template');
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DriftGuard_MissingScanDir_FailsFast', async () => {
    // A missing scan root must abort loudly rather than silently scanning zero
    // files (which would let a misconfigured dir list read as a clean tree).
    const result = await spawnAsync('node', [SCRIPT, join(tmpdir(), 'drift-guard-does-not-exist-xyz')]);
    expect(result.status ?? 1).not.toBe(0);
    expect(result.stderr).toMatch(/scan directory does not exist/i);
  });

  it('DriftGuard_OptInMarker_ExemptsRgrTemplate', async () => {
    // A deliberate high-tier opt-in lane marks itself and is NOT flagged for the
    // RGR template (the Iron-Law / NO-PRODUCTION-CODE literals are never exempt).
    const dir = mkdtempSync(join(tmpdir(), 'drift-guard-'));
    try {
      writeFileSync(
        join(dir, 'optin.md'),
        [
          '# High-tier opt-in lane',
          '<!-- ladder-rgr-optin -->',
          '1. [RED] write test',
          '2. [GREEN] impl',
          '3. [REFACTOR] clean',
        ].join('\n'),
      );
      const { code, findings } = await runGuard([dir]);
      expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
