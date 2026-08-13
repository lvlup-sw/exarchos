import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enumeratePairs } from '../../../scripts/audit/consolidate-suite.mjs';
import {
  findViolations,
  run,
  ALLOWLIST,
  EXIT_OK,
  EXIT_FINDING,
} from '../../../scripts/audit/check-no-duplicate-suites.mjs';

// A synthetic src tree mirroring the real layout: legacy copies under
// `__tests__/<area>/`, co-located copies under `<area>/`. A "twin" is a subject
// present in BOTH. The ratchet fails on any twin not in the allowlist.
describe('check-no-duplicate-suites (DR-1 ratchet)', () => {
  let root: string;
  let srcRoot: string;

  const writeFile = (rel: string, content = 'it("x", () => {});') => {
    const full = path.join(srcRoot, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  const writeTwin = (area: string, base: string) => {
    writeFile(`__tests__/${area}/${base}.test.ts`);
    writeFile(`${area}/${base}.test.ts`);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'no-dup-suites-'));
    srcRoot = path.join(root, 'src');
    mkdirSync(srcRoot, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const opts = (out: string[], err: string[]) => ({
    srcRoot,
    log: (m: string) => out.push(m),
    errlog: (m: string) => err.push(m),
  });

  // ── the shipped allowlist is EMPTY (the consolidated end-state) ─────────────
  it('ships an EMPTY allowlist (not seeded with the current 17 twins)', () => {
    expect(ALLOWLIST).toEqual([]);
  });

  // ── fails on a twin not in the allowlist ────────────────────────────────────
  it('FAILS (exit 1) on a twin that is not in the allowlist', () => {
    writeTwin('workflow', 'guards');
    const out: string[] = [];
    const err: string[] = [];
    const code = run([], opts(out, err));
    expect(code).toBe(EXIT_FINDING);
    expect(err.join('\n')).toContain('workflow/guards');
  });

  // ── cross-area collision: key on (area, basename), NOT basename alone ────────
  it('keys on (area, basename): the two `schemas` twins are DISTINCT violations', () => {
    writeTwin('workflow', 'schemas');
    writeTwin('event-store', 'schemas');
    const out: string[] = [];
    const code = run(['--json'], opts(out, []));
    expect(code).toBe(EXIT_FINDING);
    const ids = JSON.parse(out.join('\n')) as string[];
    // Both present as separate ids — a basename-only key would collapse them to one.
    expect(ids).toContain('workflow/schemas');
    expect(ids).toContain('event-store/schemas');
    expect(ids.filter((id) => id.endsWith('/schemas'))).toHaveLength(2);
  });

  it('keys on (area, basename): the two `tools` twins are DISTINCT violations', () => {
    writeTwin('workflow', 'tools');
    writeTwin('event-store', 'tools');
    const out: string[] = [];
    const code = run(['--json'], opts(out, []));
    expect(code).toBe(EXIT_FINDING);
    const ids = JSON.parse(out.join('\n')) as string[];
    expect(ids).toContain('workflow/tools');
    expect(ids).toContain('event-store/tools');
    expect(ids.filter((id) => id.endsWith('/tools'))).toHaveLength(2);
  });

  // ── a clean (twin-free) tree PASSES ─────────────────────────────────────────
  it('PASSES (exit 0) on a twin-free tree — co-located files with no legacy mirror', () => {
    // Co-located subjects only; a legacy file with NO co-located twin is not a pair.
    writeFile('workflow/guards.test.ts');
    writeFile('event-store/schemas.test.ts');
    writeFile('__tests__/stack/legacy-only.test.ts'); // legacy-only → not a twin
    const out: string[] = [];
    const err: string[] = [];
    const code = run([], opts(out, err));
    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('OK');
  });

  // ── the allowlist waiver is honored (both directions of the set-difference) ──
  it('findViolations honors the allowlist by full (area, basename) id, not basename', () => {
    writeTwin('workflow', 'schemas');
    writeTwin('event-store', 'schemas');
    const pairs = enumeratePairs(srcRoot);

    // Waiving ONLY workflow/schemas must leave event-store/schemas flagged
    // (a basename-only allowlist would wrongly waive both).
    const waiveOne = findViolations(pairs, ['workflow/schemas']);
    expect(waiveOne.map((v) => v.id)).toEqual(['event-store/schemas']);

    // Waiving both by full id clears the ratchet.
    const waiveBoth = findViolations(pairs, ['workflow/schemas', 'event-store/schemas']);
    expect(waiveBoth).toEqual([]);

    // Empty allowlist (the shipped state) flags both.
    expect(findViolations(pairs, []).map((v) => v.id).sort()).toEqual([
      'event-store/schemas',
      'workflow/schemas',
    ]);
  });
});
