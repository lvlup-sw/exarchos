// DR-14 (Task 024): `noUncheckedIndexedAccess` ratchet — regression guards.
//
// These suite tests guard the *durable* facts the fix wave established:
//   (1) the flag stays enabled on the root project, and
//   (2) the fix wave did not smuggle in escape hatches beyond a declared budget.
//
// The "typecheck green" half of the acceptance bar is enforced by CI's dedicated
// `npm run typecheck` (root) and `cd servers/exarchos-mcp && npm run typecheck`
// (server) steps — the root typecheck does NOT cover the nested server package,
// so both run. Re-spawning `tsc` from inside the suite would duplicate that CI
// step and tax every `test:run`; no test in this repo does so. This guard fails
// fast — in the unit suite, before the slow CI typecheck — if the flag is ever
// silently removed, which is what would make the tree stop typechecking green.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { countCasts, type CastCounts } from '../scripts/tsconfig-strictness/count-casts.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a compilerOptions flag from a (comment-tolerant) tsconfig JSON. */
function readCompilerFlag(tsconfigPath: string, flag: string): unknown {
  const raw = readFileSync(tsconfigPath, 'utf8');
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const parsed = JSON.parse(stripped) as {
    compilerOptions?: Record<string, unknown>;
  };
  return parsed.compilerOptions?.[flag];
}

describe('DR-14: noUncheckedIndexedAccess ratchet (root)', () => {
  it('TsconfigRoot_NoUncheckedIndexedAccessEnabled_TypecheckGreen', () => {
    // The flag is ON and cannot be silently removed. Combined with CI's
    // `npm run typecheck`, this pins "the root tree typechecks green UNDER the
    // flag" — the tree is proven clean at 0 errors with the flag enabled.
    expect(
      readCompilerFlag(resolve(REPO_ROOT, 'tsconfig.json'), 'noUncheckedIndexedAccess'),
    ).toBe(true);
  });

  it('TsconfigRoot_ExactOptionalPropertyTypesEnabled_TypecheckGreen', () => {
    // DR-14 task 025 — same guard shape for the second strict flag. The root
    // tree is proven clean at 0 errors under it via CI's `npm run typecheck`.
    expect(
      readCompilerFlag(resolve(REPO_ROOT, 'tsconfig.json'), 'exactOptionalPropertyTypes'),
    ).toBe(true);
  });

  it('FixWave_BothStrictFlags_FullSuitesGreen', () => {
    // DR-14 task 025 — both tsconfig-strictness ratchets are live on the root
    // project simultaneously. "Full suites green" under both flags is enforced
    // by CI (both `npm run typecheck` steps + both `test:run` suites); this
    // guard fails fast if either flag is silently dropped, which is what would
    // let a suite go red under the ratchets.
    const root = resolve(REPO_ROOT, 'tsconfig.json');
    expect(readCompilerFlag(root, 'noUncheckedIndexedAccess')).toBe(true);
    expect(readCompilerFlag(root, 'exactOptionalPropertyTypes')).toBe(true);
  });

  // Pre-wave escape-hatch census across BOTH typed src trees, measured on the
  // integration tip immediately before the tsconfig-strictness ratchets (tasks
  // 024 noUncheckedIndexedAccess + 025 exactOptionalPropertyTypes) landed
  // (root/src + servers/exarchos-mcp/src, test/bench/fixture files excluded —
  // see count-casts.ts). Both waves prefer real narrowing (guards, `?.`, `??`,
  // destructuring defaults) and field widening (`?: T | undefined`) over `!`/`as`,
  // so the combined introduced delta stays tiny and `as any` is barred outright.
  // RE-BASELINE (wiring-closure wave, PR #1733, 2026-08-06): the structural-
  // closure remediation added ~480 production files (~116k lines) whose casts
  // rode that PR's adversarial review (6-scope reviewer fan-out + kill probes),
  // not this ratchet. Measured on the post-fix-cycle integration tip:
  // nonNull 99 (prior baseline 84 + 15 after the fix wave removed 9 assertion
  // sites), asCast 3290, asAny 3 (zero growth — the outright bar held).
  //
  // RE-BASELINE DOWNWARD (internal-mechanics-overhaul task 057, DR-24,
  // 2026-08-07): asCast 3295 → 3258. Thirty-seven `as` assertions were PAID
  // DOWN in `servers/exarchos-mcp/src/workflow/guards.ts` — the guard table
  // asserted the shape of untyped projection fields (`state.tasks as Array<{
  // status: string }>`, `state.reviews as Record<string, unknown>`) instead of
  // narrowing them, so malformed state reached property access with the
  // checker's blessing and surfaced only as a TypeError the state machine
  // caught and relabelled. Every site now narrows through `isPlainObject`, and
  // a present-but-unusable `tasks` is REJECTED in-band rather than read as
  // "zero tasks, all complete". Pinned by `guards.test.ts` →
  // "malformed state is narrowed, not asserted (DR-24)".
  //
  // Lowering the floor here TIGHTENS the ratchet: the new floor is 32 sites
  // stricter than the one it replaces. `nonNull` is untouched at 99 because
  // the refactor removed no non-null assertions.
  //
  // ===================================================================
  // MEASUREMENT CORRECTION — NOT A PAYDOWN (task 058, DR-24, 2026-08-07)
  // ===================================================================
  // Every number ABOVE this line was produced by the OLD text census and is
  // NOT comparable to the numbers below it. Read them as a different unit.
  //
  // asCast 3258 -> 1753, nonNull 99 -> 78, asAny 3 -> 0. **No type debt was
  // paid down by that change.** Not one assertion was removed from the tree;
  // the census stopped counting things that were never assertions. Until
  // task 058 it matched `\bas\s+…` against RAW SOURCE TEXT, so it scored
  // English prose in comments, namespace imports and string contents as type
  // debt. Measured split of the 1505-match drop:
  //
  //     -1260  English prose in comments  ("…tracked as a known gap…")
  //      -140  namespace imports          (`import * as path from …`)
  //       -68  import/export aliases      (`import { load as yamlLoad }`)
  //       -60  text inside string/template literals
  //       +23  literal-type assertions the old regex MISSED
  //             (`x as 'created' | 'updated'`, `x as 5` — its alternation
  //              had no branch for a quote or a digit)
  //
  // All three surviving `as any` matches were comment prose, so the tree
  // holds ZERO real `as any`: with DELTA_BUDGET.asAny at 0, the very first
  // genuine one now fails the gate. `nonNull` fell purely by false-positive
  // removal — the old regex had no false negatives on that axis.
  //
  // Why this had to happen before the rest of the wave: the ceiling and floor
  // below pin the count into a CLOSED window (see DELTA_BUDGET), so the
  // wave's real allowance is 5 net new matches across all remaining tasks
  // combined — and under the text census an ordinary JSDoc sentence could
  // spend it. The census was itself an instance of this program's defect
  // class: an instrument that is declared, enforced, and measures a property
  // other than the one it names. It now counts parsed AST assertion nodes
  // (`ts.isAsExpression` / `<T>x` / `ts.isNonNullExpression`), so the budget
  // is denominated in real type debt. See `count-casts.ts` for the mechanism
  // and for why it now parses instead of pattern-matching.
  // ===================================================================
  // PAYDOWN RE-BASELINE — asCast 1753 -> 1748 (task 068, DR-23/DR-24, 2026-08-07)
  // ===================================================================
  // A real paydown of 5 assertion sites, measured on the post-058 AST census
  // (so it IS comparable to the number it replaces). Provenance:
  //
  //   -5  `orchestrate/invariants/add.ts` — the old `readExistingIds` read a
  //       catalog's ids through five successive assertions (`as unknown`,
  //       two `as { toJSON … }`, two `as { id … }`). Its replacement,
  //       `readCatalogIds` in `orchestrate/invariants/catalog-file.ts`,
  //       narrows through `isSeq` and a new `isPlainRecord` type PREDICATE
  //       instead, so the compiler checks what the author used to assert.
  //
  // The `invariants_amend` verb added by the same task contributes ZERO net
  // assertions: its YAML walk narrows through `isSeq`/`isMap`/`isPlainRecord`,
  // and its dispatch branch takes typed args from the validator that proved
  // them rather than re-asserting each field with `as` at the call site.
  //
  // Per the window rule below, this SLIDES the window down (it does not widen
  // it): the wave's remaining delta allowance is restored to a full 5 of 5,
  // not extended beyond it.
  const BASELINE: CastCounts = { nonNull: 78, asCast: 1748, asAny: 0 };
  // Declared budget = MAX escape-hatch sites maintenance work may introduce
  // before the NEXT documented re-baseline. Deliberately tighter than the
  // pre-wave nonNull budget: large additions must re-baseline in the open
  // (with review provenance recorded above), never ride a slack budget.
  // `as any` may never grow.
  //
  // HOW THE WINDOW WORKS — the delta ceiling and the symmetric floor below
  // together pin each measured count into `[BASELINE, BASELINE + DELTA_BUDGET]`.
  // That window is DELTA_BUDGET wide no matter how deep a paydown precedes it:
  // removing sites and re-baselining SLIDES the window down, it does not widen
  // it. So a paydown buys back the full budget (moving a saturated 5-of-5 count
  // to 0-of-5) — it does not bank extra allowance for later. Work that
  // legitimately needs more than DELTA_BUDGET new sites re-baselines in the
  // open with provenance recorded above, which is the documented path and the
  // only one that keeps the floor meaningful.
  //
  // UNCHANGED by task 058's measurement correction, deliberately. The budget
  // is no longer a documentation tax now that it is denominated in real
  // assertions, so 5 buys strictly more genuine headroom than it did before
  // while gating strictly more real debt.
  const DELTA_BUDGET: CastCounts = { nonNull: 5, asCast: 5, asAny: 0 };

  it('FixWave_CastBudget_MeasuredAndWithinDeclaredLimit', () => {
    const counts = countCasts([
      { dir: resolve(REPO_ROOT, 'src') },
      { dir: resolve(REPO_ROOT, 'servers/exarchos-mcp/src') },
    ]);
    const delta = {
      nonNull: counts.nonNull - BASELINE.nonNull,
      asCast: counts.asCast - BASELINE.asCast,
      asAny: counts.asAny - BASELINE.asAny,
    };
    // `as any` is barred outright — the wave introduces none (zero-growth ceiling).
    expect(delta.asAny).toBeLessThanOrEqual(DELTA_BUDGET.asAny);
    // Non-null assertions and `as` casts stay within the declared budget.
    expect(delta.nonNull).toBeLessThanOrEqual(DELTA_BUDGET.nonNull);
    expect(delta.asCast).toBeLessThanOrEqual(DELTA_BUDGET.asCast);
    // The counts never fall BELOW baseline without a re-baseline (guards against
    // a stale baseline silently masking a future regression) — symmetric floors
    // on BOTH escape-hatch axes, not just non-null assertions.
    expect(counts.nonNull).toBeGreaterThanOrEqual(BASELINE.nonNull);
    expect(counts.asCast).toBeGreaterThanOrEqual(BASELINE.asCast);
  });
});
