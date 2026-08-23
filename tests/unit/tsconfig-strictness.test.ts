// DR-14 (Task 024/025): strict-flag ratchets + the escape-hatch census.
//
// These suite tests guard the durable facts the fix wave established: the
// strict flags stay enabled on every tsconfig the repo compiles, and the wave
// did not smuggle in escape hatches beyond a declared budget.
//
// The "typecheck green" half of the acceptance bar is enforced by CI's
// `npm run typecheck`. Re-spawning `tsc` from inside the suite would duplicate
// that step and tax every run; no test in this repo does so. This guard fails
// fast — in the suite, before the slow CI typecheck — if a flag is ever
// silently removed, which is what would make the tree stop typechecking green.
//
// @oracle-sources: ../../tools/audit/tsconfig-strictness/count-casts.ts, the TypeScript project resolver reading this repo's tsconfig files
//
// Two independent authorities meet here, and DR-30's scope rule (assertion
// SHAPE, not annotation) correctly pulls both in. STATIC: one is the repo's own
// AST cast census, which parses source and counts assertion nodes; the other is
// TypeScript's config resolver, which answers a different question — which
// files a tsconfig project resolves — and neither reads the other's output.
// SEMANTIC: `CENSUS_ROOTS` is a hand-declared list of directories the census is
// pointed at, while the resolver reports the directories the repo actually
// compiles. Those two CAN disagree, and the whole reason
// `ScriptsCastCensus_Roots_CoverEveryTypecheckedTree` exists is that they did.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { countCasts, type CastCounts } from '../../tools/audit/tsconfig-strictness/count-casts.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

describe('DR-14: strict-flag ratchet (product project)', () => {
  it('TsconfigRoot_NoUncheckedIndexedAccessEnabled_TypecheckGreen', () => {
    // The flag is ON and cannot be silently removed. Combined with CI's
    // `npm run typecheck`, this pins "the tree typechecks green UNDER the
    // flag" — proven clean at 0 errors with the flag enabled.
    expect(
      readCompilerFlag(resolve(REPO_ROOT, 'tsconfig.json'), 'noUncheckedIndexedAccess'),
    ).toBe(true);
  });

  it('TsconfigRoot_ExactOptionalPropertyTypesEnabled_TypecheckGreen', () => {
    // DR-14 task 025 — same guard shape for the second strict flag.
    expect(
      readCompilerFlag(resolve(REPO_ROOT, 'tsconfig.json'), 'exactOptionalPropertyTypes'),
    ).toBe(true);
  });

  it('FixWave_BothStrictFlags_FullSuitesGreen', () => {
    // Both ratchets live simultaneously. "Full suites green" under both is
    // enforced by CI; this fails fast if either is dropped, which is what would
    // let a suite go red under the ratchets.
    const root = resolve(REPO_ROOT, 'tsconfig.json');
    expect(readCompilerFlag(root, 'noUncheckedIndexedAccess')).toBe(true);
    expect(readCompilerFlag(root, 'exactOptionalPropertyTypes')).toBe(true);
  });
});

describe('DR-14: strict-flag ratchet (satellite projects)', () => {
  // DR-14 requires BOTH strict flags in EVERY tsconfig the repo compiles, not
  // just the product one — a satellite project is exactly where a strict-flag
  // hole reopens unnoticed. `tools/evals-pkg` is the opt-in eval workspace DR-3
  // created and named as "a hole this program opened itself".
  const SATELLITES = ['tools/conformance', 'tools/evals-pkg'] as const;

  for (const pkg of SATELLITES) {
    it(`Tsconfig_${pkg.replace(/[^A-Za-z]/g, '')}_BothStrictFlagsEnabled`, () => {
      const config = resolve(REPO_ROOT, pkg, 'tsconfig.json');
      expect(readCompilerFlag(config, 'noUncheckedIndexedAccess')).toBe(true);
      expect(readCompilerFlag(config, 'exactOptionalPropertyTypes')).toBe(true);
    });
  }
});

describe('DR-14: escape-hatch census', () => {
  // Escape-hatch census across every typechecked tree (test/bench/fixture files
  // excluded — see count-casts.ts). The wave prefers real narrowing (guards,
  // `?.`, `??`, destructuring defaults) and field widening (`?: T | undefined`)
  // over `!`/`as`, so the introduced delta stays tiny and `as any` is barred
  // outright.
  //
  // The numbers below are a ledger, not decoration: each movement records
  // whether it was a PAYDOWN (debt removed), a MEASUREMENT CORRECTION (the
  // instrument changed, the tree did not) or a SCOPE CHANGE (jurisdiction
  // widened or narrowed). Conflating them is how a ratchet quietly stops
  // ratcheting, so they are kept distinct.
  //
  // MEASUREMENT CORRECTION (task 058) — asCast 3258 -> 1753, nonNull 99 -> 78,
  // asAny 3 -> 0. No debt was paid down. Until 058 the census matched
  // `\bas\s+…` against RAW SOURCE TEXT, so it scored English prose in comments
  // (-1260), namespace imports (-140), import aliases (-68) and string contents
  // (-60) as type debt, while MISSING literal-type assertions (+23). It now
  // counts parsed AST assertion nodes, so the budget is denominated in real
  // type debt. The census was itself an instance of this program's defect
  // class: an instrument that measures a property other than the one it names.
  //
  // SCOPE CHANGE (task 066) — asCast 1753 -> 1785. The census had scanned the
  // two `src` trees only, so BOTH `scripts/` trees were outside its
  // jurisdiction while also being typechecked by nothing. The 32 newly-counted
  // assertions were already in the tree. A directory covered by one gate and
  // not the other re-opens the class one gate at a time.
  //
  // CORRECTION + PAYDOWN (tasks 068, 070) — 1785 -> 1784 -> 1779. The 066
  // baseline was measured on the tip BEFORE its own edits, so it shipped stale
  // and the symmetric floor was red on arrival. The lesson, recorded because it
  // cost a red floor nobody saw: measure the tree you are shipping, not the one
  // you started from. The -5 that follows is task 068 replacing five successive
  // assertions in the invariants catalog reader with an `isPlainRecord` type
  // PREDICATE, so the compiler checks what the author used to assert.
  //
  // PAYDOWN (INV-11) — 1779 -> 1777. `enforceSharedMutatingGate` and
  // `canMutateShared` were DELETED, and their assertions went with them.
  //
  // SCOPE CHANGE (task 019, the servers/ fold) — nonNull 78 -> 72,
  // asCast 1777 -> 1698. **No type debt was paid down and none was
  // introduced.** The fold dissolved the nested server package, and the layer
  // map routed three of its subtrees to `tools/`: `evals/`, `bench/` and
  // `benchmarks/` to `tools/evals/`, and `test-helpers/` to
  // `tools/test-helpers/`. Those carried 6 nonNull + 79 asCast, and they left
  // the census because they left the TYPECHECK — no tsconfig project compiles
  // them any more. The roots below therefore still say exactly "every tree the
  // repo compiles"; that set simply got smaller. The typecheck hole itself is
  // the real finding and is tracked separately — this ledger records only that
  // the two gates still agree with each other.
  // PAYDOWN — nonNull 72 -> 70, asCast 1698 -> 1695. `handleGet` and
  // `handleSet` reached the ES v2 read and snapshot paths through a settable
  // module singleton that nothing in `src/` ever set, so every use of it needed
  // a `!` to tell the compiler the value was present when the code could not
  // show that it was. The read path now resolves the materializer per stateDir
  // and the snapshot path is gone, taking both assertions and three `as` casts
  // (the snapshot's shape juggling) with them. No debt was moved; five sites
  // stopped needing an escape hatch.
  const BASELINE: CastCounts = { nonNull: 70, asCast: 1695, asAny: 0 };

  // Declared budget = MAX escape-hatch sites maintenance work may introduce
  // before the NEXT documented re-baseline. `as any` may never grow.
  //
  // HOW THE WINDOW WORKS — the delta ceiling and the symmetric floor below
  // together pin each count into `[BASELINE, BASELINE + DELTA_BUDGET]`. That
  // window is DELTA_BUDGET wide no matter how deep a paydown precedes it:
  // removing sites and re-baselining SLIDES the window down, it does not widen
  // it. Work that legitimately needs more re-baselines in the open with
  // provenance recorded above — the only path that keeps the floor meaningful.
  const DELTA_BUDGET: CastCounts = { nonNull: 5, asCast: 5, asAny: 0 };

  /**
   * Every tree the census has jurisdiction over — the ones the repo compiles.
   *
   * Kept identical to the typecheck scope by
   * `ScriptsCastCensus_Roots_CoverEveryTypecheckedTree` below, so neither gate
   * can quietly cover a directory the other does not. `src` subsumes
   * `src/install`, so it is named once — listing a nested root as well would
   * double-count it. For the same reason the repo automation is named as the
   * two roots task 036 split it into rather than as a bare `tools`, which would
   * swallow `conformance` and `evals-pkg` and count them twice.
   */
  const CENSUS_ROOTS: readonly string[] = [
    'src',
    'tools/audit',
    'tools/release',
    'tools/conformance',
    'tools/evals-pkg',
  ];

  /** The package roots whose tsconfig projects define the typecheck scope. */
  const PACKAGE_ROOTS: readonly string[] = ['.', 'tools/conformance', 'tools/evals-pkg'];

  it('FixWave_CastBudget_MeasuredAndWithinDeclaredLimit', () => {
    const counts = countCasts(CENSUS_ROOTS.map((dir) => ({ dir: resolve(REPO_ROOT, dir) })));
    const delta = {
      nonNull: counts.nonNull - BASELINE.nonNull,
      asCast: counts.asCast - BASELINE.asCast,
      asAny: counts.asAny - BASELINE.asAny,
    };
    // `as any` is barred outright (zero-growth ceiling).
    expect(delta.asAny).toBeLessThanOrEqual(DELTA_BUDGET.asAny);
    // Non-null assertions and `as` casts stay within the declared budget.
    expect(delta.nonNull).toBeLessThanOrEqual(DELTA_BUDGET.nonNull);
    expect(delta.asCast).toBeLessThanOrEqual(DELTA_BUDGET.asCast);
    // The counts never fall BELOW baseline without a re-baseline (a stale
    // baseline would otherwise silently mask a future regression) — symmetric
    // floors on BOTH escape-hatch axes, not just non-null assertions.
    expect(counts.nonNull).toBeGreaterThanOrEqual(BASELINE.nonNull);
    expect(counts.asCast).toBeGreaterThanOrEqual(BASELINE.asCast);
  });

  it('ScriptsCastCensus_Roots_CoverEveryTypecheckedTree', () => {
    // The structural fix for "same blind spot, different gate": two gates
    // governing overlapping-but-unequal directories, with the difference
    // invisible because neither stated its scope in terms the other could be
    // checked against.
    //
    // Both scopes are DERIVED from the same source of truth — the tsconfig
    // projects the repo compiles, discovered by globbing rather than listed —
    // so a new project, or a widened `include`, drags the cast census along
    // with it or fails here.
    const configs: string[] = [];
    for (const pkg of PACKAGE_ROOTS) {
      for (const entry of readdirSync(resolve(REPO_ROOT, pkg))) {
        if (/^tsconfig(\..+)?\.json$/.test(entry)) configs.push(join(pkg, entry));
      }
    }
    // Non-empty denominator: a discovery that finds no projects would make the
    // containment assertion below vacuously true.
    expect(configs.length).toBeGreaterThanOrEqual(4);

    const compiled = new Set<string>();
    for (const config of configs) {
      const absolute = resolve(REPO_ROOT, config);
      const read = ts.readConfigFile(absolute, (p) => readFileSync(p, 'utf8'));
      expect(read.error).toBeUndefined();
      const json: unknown = read.config;
      if (typeof json !== 'object' || json === null) throw new Error(`${config} is not an object`);
      const parsed = ts.parseJsonConfigFileContent(
        json,
        ts.sys,
        dirname(absolute),
        undefined,
        absolute,
      );
      for (const file of parsed.fileNames) {
        const rel = relative(REPO_ROOT, file).split(sep).join('/');
        // Ambient declarations are excluded on BOTH sides: `count-casts.ts`
        // skips `__shims__/`, and a declaration file holds no expressions to
        // assert in. Comparing them would be comparing a scope neither gate has.
        if (rel.endsWith('.d.ts')) continue;
        compiled.add(rel);
      }
    }
    expect(compiled.size).toBeGreaterThan(0);

    for (const file of compiled) {
      const covered = CENSUS_ROOTS.some((root) => file.startsWith(`${root}/`));
      expect(covered, `${file} is compiled but sits outside the cast-census roots`).toBe(true);
    }
  });

  it('CensusRoots_RealRepo_AllExistAndNoneNests', () => {
    // A root that no longer exists censuses nothing and passes clean; a root
    // nested inside another double-counts everything it holds. The fold
    // produced both shapes elsewhere in this tree, so neither is hypothetical.
    for (const root of CENSUS_ROOTS) {
      expect(readdirSync(resolve(REPO_ROOT, root)).length, `${root} is empty or absent`)
        .toBeGreaterThan(0);
      for (const other of CENSUS_ROOTS) {
        if (other === root) continue;
        expect(root.startsWith(`${other}/`), `${root} nests inside ${other}`).toBe(false);
      }
    }
  });
});
