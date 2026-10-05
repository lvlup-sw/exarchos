/**
 * Exercises the test-first drift guard, `tools/audit/gates/lint-test-first-drift.mjs`.
 * The guard keeps mandatory test-first framing out of the SDLC content.
 * A seeded fixture must fail, and the shipped tree must pass.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

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
      rmrf(dir);
    }
  });

  /** The RGR rule ignores case, so a `[Red]` or `[green]` variant cannot bypass the guard. */
  it('DriftGuard_LowercaseRgrVariant_Fails', async () => {
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
      rmrf(dir);
    }
  });

  /** A scan of zero files reads as a clean tree, so a missing scan directory must fail. */
  it('DriftGuard_MissingScanDir_FailsFast', async () => {
    const result = await spawnAsync('node', [SCRIPT, join(tmpdir(), 'drift-guard-does-not-exist-xyz')]);
    expect(result.status ?? 1).not.toBe(0);
    expect(result.stderr).toMatch(/scan directory does not exist/i);
  });

  /** The marker exempts a file from the RGR rule only. The other two rules have no opt-out. */
  it('DriftGuard_OptInMarker_ExemptsRgrTemplate', async () => {
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
      rmrf(dir);
    }
  });
});
