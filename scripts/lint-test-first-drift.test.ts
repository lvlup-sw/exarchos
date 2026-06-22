// scripts/lint-test-first-drift.test.ts — exercises the #1591 drift guard.
//
// The guard (scripts/lint-test-first-drift.mjs) is the standing defense that
// keeps test-FIRST framing (Iron Law / NO PRODUCTION CODE / unconditional RGR
// templates) from creeping back into commands/ + agents/ after the Phase-4
// excision. This test is the enforcing CI wiring: a seeded fixture MUST fail,
// the shipped tree MUST pass. (Co-located with the script so the vitest 'unit'
// project's `scripts/**/*.test.ts` include picks it up.)

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(import.meta.dirname, 'lint-test-first-drift.mjs');

function runGuard(dirs: string[]): { code: number; findings: Array<{ rule: string }> } {
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [SCRIPT, ...dirs], { encoding: 'utf8' });
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    code = e.status ?? 1;
    stdout = e.stdout?.toString() ?? '';
  }
  return { code, findings: JSON.parse(stdout).findings };
}

describe('test-first drift guard (#1591)', () => {
  it('DriftGuard_CleanTree_Passes', () => {
    const { code, findings } = runGuard([join(REPO_ROOT, 'commands'), join(REPO_ROOT, 'agents')]);
    expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
    expect(code).toBe(0);
  });

  it('DriftGuard_SeededIronLawFixture_Fails', () => {
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
      const { code, findings } = runGuard([dir]);
      const rules = findings.map((f) => f.rule);
      expect(rules).toContain('iron-law');
      expect(rules).toContain('no-production-code-first');
      expect(rules).toContain('unconditional-rgr-template');
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DriftGuard_OptInMarker_ExemptsRgrTemplate', () => {
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
      const { code, findings } = runGuard([dir]);
      expect(findings, JSON.stringify(findings, null, 2)).toHaveLength(0);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
