import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllowlist } from '../../tools/audit/knip-diff.js';

// ─── Dead-code allowlist accountability (DR-8, task 009) ─────────────────────
//
// `knip-diff.ts` already fails closed on an unallowlisted finding, an expired
// entry, or an allowlist that violates the register schema — and
// `knip-diff.test.ts` pins those. This file covers what the schema cannot:
// whether an entry is a real justification or a formality that satisfies
// `rationale.length > 0`.
//
// That gap is the one that matters for a ratchet. An exemption ledger decays by
// accumulating rows nobody can defend, not by failing validation — so the
// checks here are about substance (is the reason a reason?), reach (does the
// file still exist?), and size (is the ledger growing?).

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
 * Ledger size at the last deliberate sweep. Lowering this is always welcome.
 * RAISING it means a new permanent exemption was accepted, which is a decision
 * that belongs in a diff someone reads — not a silent drift.
 *
 * 105 → 113 (task 042). Knip's `project` glob covered `tests/core/**` only;
 * widening it to the whole test tree made eight already-existing files visible
 * for the first time. None is new code and none is newly dead: six are the
 * quality-AB eval corpus (three `impl.stub.ts` read by path, three HIDDEN
 * `oracle.ts` that grade.ts copies into the sandbox — importing one would be an
 * eval-integrity defect, not a fix) and two are hand-run maintenance CLIs.
 *
 * Four OTHER findings surfaced by the same widening were deleted rather than
 * exempted, which is why this is +8 and not +12.
 */
const ALLOWLIST_BUDGET = 113;

/** Reasons that are not reasons. A rationale matching any of these is a stub. */
const STUB_RATIONALE = /^(n\/?a|tbd|todo|fixme|wip|unused|dead|legacy|see above|\?+|-+)\.?$/i;

/**
 * The measured floor at the task 009 sweep — the shortest rationale currently
 * shipped is 49 characters. Pinned AT the floor rather than below it so the
 * check actually binds: a new row cannot arrive thinner than the thinnest one
 * anybody has already had to defend.
 */
const MIN_RATIONALE_CHARS = 49;

describe('DeadCode_AfterRetarget_DetectorCoversTheNewTree', () => {
  // A dead-code detector aimed at a directory that no longer exists reports no
  // dead code, and reads exactly like a clean tree. Every other check in this
  // file is downstream of the detector having looked at something, so the
  // globs are checked against the LIVE tree rather than trusted.
  const knip = JSON.parse(readFileSync(path.join(REPO_ROOT, 'knip.json'), 'utf8')) as {
    workspaces: Record<string, { entry: string[]; project: string[] }>;
  };

  const workspaceIds = Object.keys(knip.workspaces);

  it('the two workspaces collapsed to one', () => {
    // Two workspace blocks meant two half-configured detectors, each able to
    // pass by scanning the half it could see.
    expect(workspaceIds).toEqual(['.']);
  });

  it('every source root of the six-directory tree is inside the project glob', () => {
    const globs = knip.workspaces['.']?.project ?? [];
    // Positive patterns only: a `!` entry narrows the scan, and a root
    // "covered" solely by an exclusion is not covered at all.
    const positive = globs.filter((g) => !g.startsWith('!'));
    for (const root of ['src/', 'tests/', 'tools/']) {
      expect(
        positive.some((g) => g.startsWith(root)),
        `knip's project glob does not reach ${root} — the detector cannot see that tree`,
      ).toBe(true);
    }
  });

  it('every tools/ directory that holds TypeScript is named by a project glob', () => {
    // `tools/audit/**` satisfies "some tools/ glob" and still leaves
    // `tools/release`, `tools/evals-pkg`, and `tools/git-hooks` invisible.
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
      // Fixture-only trees are ignored in knip.json, not scanned.
      if (dir === 'eslint-rules') continue;
      const prefix = `tools/${dir}/`;
      if (!globs.some((g) => g.startsWith(prefix))) uncovered.push(prefix);
    }
    expect(uncovered, 'tools/ TypeScript trees knip cannot see').toEqual([]);
  });

  it('every declared glob matches at least one file that exists', () => {
    // The stale-glob tooth. A pattern that matches nothing contributes nothing
    // and looks identical to one that found no findings.
    const all = [
      ...(knip.workspaces['.']?.entry ?? []),
      ...(knip.workspaces['.']?.project ?? []),
    ].filter((g) => !g.startsWith('!'));

    expect(all.length, 'no globs declared — the checks below would be vacuous').toBeGreaterThan(10);

    const dead = all.filter((glob) => {
      // Resolve the literal prefix (up to the first wildcard) and require it to
      // exist. That is weaker than expanding the glob and strong enough to
      // catch a root that was renamed or removed, which is the failure seen.
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

  it('every entry carries a review deadline, or is explicitly permanent', () => {
    // `expires` XOR `permanent` is the register contract. An entry with neither
    // never comes up for review; an entry with both is ambiguous about which
    // wins, and the ambiguity always resolves toward never expiring.
    const undated = entries.filter((e) => e.expires === undefined && e.permanent !== true);
    expect(undated.map((e) => e.symbol)).toEqual([]);

    const both = entries.filter((e) => e.expires !== undefined && e.permanent === true);
    expect(both.map((e) => e.symbol)).toEqual([]);
  });

  it('a permanent exemption says WHY it can never expire', () => {
    // "Permanent" is the strongest claim in the ledger and the only one no
    // deadline will ever re-examine, so it has to argue for itself in the text.
    for (const entry of entries.filter((e) => e.permanent === true)) {
      expect(
        /permanent|by construction|codegen|generated|regenerated/i.test(entry.rationale),
        `${entry.symbol}: permanent entry whose rationale never justifies permanence`,
      ).toBe(true);
    }
  });

  it('every expiry is a real, parseable, future-or-reviewable date', () => {
    for (const entry of entries) {
      if (entry.expires === undefined) continue;
      expect(entry.expires, `${entry.symbol}: expiry is not ISO yyyy-mm-dd`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(Number.isFinite(Date.parse(entry.expires))).toBe(true);
      // A decade-out deadline is `permanent` wearing a date to dodge the
      // justification the permanent branch above demands.
      const tenYears = Date.parse(entry.expires) - Date.now() > 10 * 365 * 24 * 3600 * 1000;
      expect(tenYears, `${entry.symbol}: expiry so distant it is permanence in disguise`).toBe(
        false,
      );
    }
  });

  it('every entry points at a file that still exists', () => {
    // A row whose file is gone exempts nothing. It is pure ledger weight, and
    // it hides the fact that the exemption was already earned back.
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

  it('the un-retirable residue does not grow', () => {
    // An exemption with no stated retirement condition can only be removed by
    // someone re-deriving the whole argument, which is why 45 of these say
    // "forward-compat surface" and nothing else — a claim no evidence can
    // falsify. They are real justifications with owners and deadlines, so the
    // gate accepts them; they are just the weakest rows in the ledger.
    //
    // Pinned rather than fixed: every one is an exported TYPE, and the plan
    // gates deletions on the task 004 reference census. Retiring them is a
    // census-gated sweep, not a rationale rewrite — padding the text would
    // change the measurement without changing the claim.
    const stated = /retire|until|once |when |remove(d)? (it|this|when)|delete|drop(ped)? when|no longer/i;
    const silent = entries.filter((e) => !stated.test(e.rationale));
    expect(
      silent.length,
      'More entries now state no condition under which they could ever be removed. ' +
        'A rationale should end with what retires it — a real one, not a rewording.',
    ).toBeLessThanOrEqual(59);
  });

  it('a bare entry is rejected by the loader itself', () => {
    // The schema is the enforcement; this pins that it actually rejects rather
    // than coercing, so the checks above are a supplement to a real gate and
    // not the only thing standing between a bare row and the ledger.
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
