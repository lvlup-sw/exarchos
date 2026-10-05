import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enumeratePairs } from '../../../tools/audit/consolidate-suite.mjs';
import {
  findViolations,
  run,
  ALLOWLIST,
  EXIT_OK,
  EXIT_FINDING,
} from '../../../tools/audit/check-no-duplicate-suites.mjs';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The cases build a synthetic source tree. Legacy copies are under
 * `__tests__/<area>/` and co-located copies are under `<area>/`. A twin is a
 * subject that is present in both. The ratchet fails on a twin that is not in
 * the allowlist.
 */
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
  afterEach(() => rmrf(root));

  const opts = (out: string[], err: string[]) => ({
    srcRoot,
    log: (m: string) => out.push(m),
    errlog: (m: string) => err.push(m),
  });

  it('ships an EMPTY allowlist (not seeded with the current 17 twins)', () => {
    expect(ALLOWLIST).toEqual([]);
  });

  it('FAILS (exit 1) on a twin that is not in the allowlist', () => {
    writeTwin('workflow', 'guards');
    const out: string[] = [];
    const err: string[] = [];
    const code = run([], opts(out, err));
    expect(code).toBe(EXIT_FINDING);
    expect(err.join('\n')).toContain('workflow/guards');
  });

  /** If the key is the basename alone, the two ids collapse into one and this case fails. */
  it('keys on (area, basename): the two `schemas` twins are DISTINCT violations', () => {
    writeTwin('workflow', 'schemas');
    writeTwin('event-store', 'schemas');
    const out: string[] = [];
    const code = run(['--json'], opts(out, []));
    expect(code).toBe(EXIT_FINDING);
    const ids = JSON.parse(out.join('\n')) as string[];
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

  /** A legacy file with no co-located copy is not a twin. */
  it('PASSES (exit 0) on a twin-free tree — co-located files with no legacy mirror', () => {
    writeFile('workflow/guards.test.ts');
    writeFile('event-store/schemas.test.ts');
    writeFile('__tests__/stack/legacy-only.test.ts');
    const out: string[] = [];
    const err: string[] = [];
    const code = run([], opts(out, err));
    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('OK');
  });

  /**
   * A waiver of `workflow/schemas` alone leaves `event-store/schemas` flagged.
   * If the allowlist keys on the basename, that waiver clears both and this
   * case fails. A waiver of both ids clears the ratchet, and the empty
   * allowlist flags both.
   */
  it('findViolations honors the allowlist by full (area, basename) id, not basename', () => {
    writeTwin('workflow', 'schemas');
    writeTwin('event-store', 'schemas');
    const pairs = enumeratePairs(srcRoot);

    const waiveOne = findViolations(pairs, ['workflow/schemas']);
    expect(waiveOne.map((v) => v.id)).toEqual(['event-store/schemas']);

    const waiveBoth = findViolations(pairs, ['workflow/schemas', 'event-store/schemas']);
    expect(waiveBoth).toEqual([]);

    expect(findViolations(pairs, []).map((v) => v.id).sort()).toEqual([
      'event-store/schemas',
      'workflow/schemas',
    ]);
  });
});
