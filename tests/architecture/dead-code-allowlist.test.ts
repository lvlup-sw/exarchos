/**
 * Accountability for the dead-code allowlist.
 *
 * `knip-diff.ts` fails closed on an unallowlisted finding, an expired entry,
 * and an allowlist that violates the register schema. `knip-diff.test.ts` pins
 * those. This file covers what the schema cannot see: an entry whose rationale
 * is a formality.
 *
 * An exemption ledger decays when it collects rows that no person can defend,
 * and such rows pass validation. Thus these checks cover substance (the
 * rationale is a reason), reach (the file exists), and size (the ledger does
 * not grow).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllowlist } from '../../tools/audit/knip-diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'tools/audit/knip-allowlist.json');

const entries = loadAllowlist(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')));

/** True when `dir` contains any `.ts` file, recursively. */
function walkHasTs(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (walkHasTs(full)) return true;
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      return true;
    }
  }
  return false;
}

/**
 * The ledger size at the last deliberate sweep. A lower value is welcome. A
 * higher value accepts a new exemption, and that decision belongs in a diff
 * that a reviewer reads.
 */
const ALLOWLIST_BUDGET = 115;

/** Text that is not a reason. A rationale that matches this pattern is a stub. */
const STUB_RATIONALE = /^(n\/?a|tbd|todo|fixme|wip|unused|dead|legacy|see above|\?+|-+)\.?$/i;

/**
 * The length of the shortest rationale in the ledger. The pin sits at that
 * floor, so a new row cannot be shorter than the shortest existing row.
 */
const MIN_RATIONALE_CHARS = 49;

/**
 * A dead-code detector that scans a missing directory reports no dead code,
 * and that result looks the same as a clean tree. Thus this group checks the
 * knip globs against the live tree.
 */
describe('DeadCode_AfterRetarget_DetectorCoversTheNewTree', () => {
  const knip = JSON.parse(readFileSync(path.join(REPO_ROOT, 'knip.json'), 'utf8')) as {
    workspaces: Record<string, { entry: string[]; project: string[] }>;
  };

  const workspaceIds = Object.keys(knip.workspaces);

  /** With two workspace blocks, each detector can pass on the half of the tree that it scans. */
  it('the two workspaces collapsed to one', () => {
    expect(workspaceIds).toEqual(['.']);
  });

  /** Reads positive patterns only. A `!` entry narrows the scan, so it does not cover a root. */
  it('every source root of the six-directory tree is inside the project glob', () => {
    const globs = knip.workspaces['.']?.project ?? [];
    const positive = globs.filter((g) => !g.startsWith('!'));
    for (const root of ['src/', 'tests/', 'tools/']) {
      expect(
        positive.some((g) => g.startsWith(root)),
        `knip's project glob does not reach ${root} — the detector cannot see that tree`,
      ).toBe(true);
    }
  });

  /**
   * One `tools/` glob satisfies the test above and can still leave other tool
   * directories unscanned. The test skips `tools/eslint-rules`, because its
   * only TypeScript files are fixtures that `knip.json` ignores.
   */
  it('every tools/ directory that holds TypeScript is named by a project glob', () => {
    const globs = (knip.workspaces['.']?.project ?? []).filter((g) => !g.startsWith('!'));
    const toolsRoot = path.join(REPO_ROOT, 'tools');
    const dirs = readdirSync(toolsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    const uncovered: string[] = [];
    for (const dir of dirs) {
      const abs = path.join(toolsRoot, dir);
      const hasTs = walkHasTs(abs);
      if (!hasTs) continue;
      if (dir === 'eslint-rules') continue;
      const prefix = `tools/${dir}/`;
      if (!globs.some((g) => g.startsWith(prefix))) uncovered.push(prefix);
    }
    expect(uncovered, 'tools/ TypeScript trees knip cannot see').toEqual([]);
  });

  /**
   * A pattern that matches nothing looks the same as a pattern with no
   * findings. The test resolves the literal prefix of each glob, up to the
   * first wildcard, and requires that path to exist. This check is weaker
   * than a glob expansion, but it finds a renamed or removed root.
   */
  it('every declared glob matches at least one file that exists', () => {
    const all = [
      ...(knip.workspaces['.']?.entry ?? []),
      ...(knip.workspaces['.']?.project ?? []),
    ].filter((g) => !g.startsWith('!'));

    expect(all.length, 'no globs declared — the checks below would be vacuous').toBeGreaterThan(10);

    const dead = all.filter((glob) => {
      const literal = glob.split(/[*?[]/)[0] ?? '';
      const base = literal.endsWith('/') ? literal.slice(0, -1) : path.dirname(literal);
      return base !== '' && base !== '.' && !existsSync(path.join(REPO_ROOT, base));
    });

    expect(dead, 'knip globs whose root does not exist — they scan nothing').toEqual([]);
  });
});

describe('DeadCodeAllowlist_EveryEntry_CarriesOwnerAndExpiry', () => {
  it('the ledger is non-empty, so these checks are not vacuous', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every entry names an owner', () => {
    const unowned = entries.filter((e) => !e.owner || e.owner.trim().length === 0);
    expect(unowned.map((e) => e.symbol)).toEqual([]);
  });

  /**
   * The register contract is `expires` or `permanent`, and not both. An entry
   * with neither never comes up for review. An entry with both is ambiguous.
   */
  it('every entry carries a review deadline, or is explicitly permanent', () => {
    const undated = entries.filter((e) => e.expires === undefined && e.permanent !== true);
    expect(undated.map((e) => e.symbol)).toEqual([]);

    const both = entries.filter((e) => e.expires !== undefined && e.permanent === true);
    expect(both.map((e) => e.symbol)).toEqual([]);
  });

  /** No deadline re-examines a permanent entry, so its rationale must justify permanence. */
  it('a permanent exemption says WHY it can never expire', () => {
    for (const entry of entries.filter((e) => e.permanent === true)) {
      expect(
        /permanent|by construction|codegen|generated|regenerated/i.test(entry.rationale),
        `${entry.symbol}: permanent entry whose rationale never justifies permanence`,
      ).toBe(true);
    }
  });

  /** An expiry more than ten years away is a permanent entry that avoids the permanence rationale. */
  it('every expiry is a real, parseable, future-or-reviewable date', () => {
    for (const entry of entries) {
      if (entry.expires === undefined) continue;
      expect(entry.expires, `${entry.symbol}: expiry is not ISO yyyy-mm-dd`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(Number.isFinite(Date.parse(entry.expires))).toBe(true);
      const tenYears = Date.parse(entry.expires) - Date.now() > 10 * 365 * 24 * 3600 * 1000;
      expect(tenYears, `${entry.symbol}: expiry so distant it is permanence in disguise`).toBe(
        false,
      );
    }
  });

  /** A row for a deleted file exempts nothing and only adds weight to the ledger. */
  it('every entry points at a file that still exists', () => {
    const dangling = entries.filter((e) => !existsSync(path.join(REPO_ROOT, e.file)));
    expect(dangling.map((e) => e.file)).toEqual([]);
  });

  it('no two entries exempt the same finding twice', () => {
    const seen = new Map<string, number>();
    for (const e of entries) {
      const key = `${e.file}::${e.symbol}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it('the ledger has not grown past its last deliberate sweep', () => {
    expect(
      entries.length,
      'The dead-code allowlist grew. Prefer deleting the symbol, or `@proof` if it is a ' +
        'compile-time proof. If a new exemption is genuinely right, raise ALLOWLIST_BUDGET ' +
        'in the same commit so the decision is reviewable.',
    ).toBeLessThanOrEqual(ALLOWLIST_BUDGET);
  });
});

describe('DeadCodeAllowlist_BareEntry_IsRejected', () => {
  it('no shipped entry carries a stub rationale', () => {
    const stubs = entries.filter((e) => STUB_RATIONALE.test(e.rationale.trim()));
    expect(stubs.map((e) => e.symbol)).toEqual([]);
  });

  it('no shipped entry carries a rationale too short to be one', () => {
    const thin = entries
      .filter((e) => e.rationale.trim().length < MIN_RATIONALE_CHARS)
      .map((e) => `${e.symbol} (${e.rationale.trim().length} chars)`);
    expect(
      thin,
      'A rationale has to say why the symbol is unreachable AND what would retire the ' +
        'exemption. An assertion that it is fine is not a rationale.',
    ).toEqual([]);
  });

  /**
   * An entry that states no retirement condition makes a claim that no
   * evidence can falsify. Such entries have owners and deadlines, so the gate
   * accepts them, and this test pins their count. Extra words in a rationale
   * change the measurement and not the claim.
   */
  it('the un-retirable residue does not grow', () => {
    const stated = /retire|until|once |when |remove(d)? (it|this|when)|delete|drop(ped)? when|no longer/i;
    const silent = entries.filter((e) => !stated.test(e.rationale));
    expect(
      silent.length,
      'More entries now state no condition under which they could ever be removed. ' +
        'A rationale should end with what retires it — a real one, not a rewording.',
    ).toBeLessThanOrEqual(59);
  });

  /** The schema is the enforcement. This test pins that the loader rejects a bare row and does not coerce it. */
  it('a bare entry is rejected by the loader itself', () => {
    expect(() => loadAllowlist([{ symbol: 'x', file: 'src/foo.ts' }])).toThrow(
      /schema validation/,
    );
  });

  it('an entry missing only its rationale is still rejected', () => {
    expect(() =>
      loadAllowlist([{ symbol: 'x', file: 'src/foo.ts', owner: '@a', expires: '2099-01-01' }]),
    ).toThrow(/schema validation/);
  });

  it('an entry missing only its owner is still rejected', () => {
    expect(() =>
      loadAllowlist([{ symbol: 'x', file: 'src/foo.ts', expires: '2099-01-01', rationale: 'r' }]),
    ).toThrow(/schema validation/);
  });

  it('an entry with neither expiry nor permanent is rejected', () => {
    expect(() =>
      loadAllowlist([{ symbol: 'x', file: 'src/foo.ts', owner: '@a', rationale: 'r' }]),
    ).toThrow(/schema validation/);
  });
});
