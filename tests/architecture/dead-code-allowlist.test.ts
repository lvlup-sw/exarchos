import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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

/**
 * Ledger size at the last deliberate sweep (task 009). Lowering this is always
 * welcome. RAISING it means a new permanent exemption was accepted, which is a
 * decision that belongs in a diff someone reads — not a silent drift.
 */
const ALLOWLIST_BUDGET = 105;

/** Reasons that are not reasons. A rationale matching any of these is a stub. */
const STUB_RATIONALE = /^(n\/?a|tbd|todo|fixme|wip|unused|dead|legacy|see above|\?+|-+)\.?$/i;

/**
 * The measured floor at the task 009 sweep — the shortest rationale currently
 * shipped is 49 characters. Pinned AT the floor rather than below it so the
 * check actually binds: a new row cannot arrive thinner than the thinnest one
 * anybody has already had to defend.
 */
const MIN_RATIONALE_CHARS = 49;

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
