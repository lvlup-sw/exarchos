// Ratchets for the strict compiler flags, and the census of escape hatches.
//
// The strict flags must stay enabled in each tsconfig that the repo compiles. The count of `x!`
// and `as` sites must stay inside a declared budget. This suite does not run `tsc`, because the
// `npm run typecheck` step in CI does that.
//
// @oracle-sources: ../../tools/audit/tsconfig-strictness/count-casts.ts, the TypeScript project resolver reading this repo's tsconfig files
//
// The two authorities are independent. The cast census parses source and counts assertion nodes.
// The TypeScript config resolver reports the files that each tsconfig project compiles.
// `CENSUS_ROOTS` is a hand-written list, so it can disagree with the resolver.
// `ScriptsCastCensus_Roots_CoverEveryTypecheckedTree` compares the two.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { countCasts, type CastCounts } from '../../tools/audit/tsconfig-strictness/count-casts.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Reads a `compilerOptions` flag from a tsconfig JSON file that can hold comments. */
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

/**
 * These tests pin the two strict flags in the root `tsconfig.json`. They do not run `tsc`. The
 * `npm run typecheck` step in CI proves that the tree compiles with the flags.
 */
describe('DR-14: strict-flag ratchet (product project)', () => {
  it('TsconfigRoot_NoUncheckedIndexedAccessEnabled_TypecheckGreen', () => {
    expect(
      readCompilerFlag(resolve(REPO_ROOT, 'tsconfig.json'), 'noUncheckedIndexedAccess'),
    ).toBe(true);
  });

  it('TsconfigRoot_ExactOptionalPropertyTypesEnabled_TypecheckGreen', () => {
    expect(
      readCompilerFlag(resolve(REPO_ROOT, 'tsconfig.json'), 'exactOptionalPropertyTypes'),
    ).toBe(true);
  });

  it('FixWave_BothStrictFlags_FullSuitesGreen', () => {
    const root = resolve(REPO_ROOT, 'tsconfig.json');
    expect(readCompilerFlag(root, 'noUncheckedIndexedAccess')).toBe(true);
    expect(readCompilerFlag(root, 'exactOptionalPropertyTypes')).toBe(true);
  });
});

/**
 * Each tsconfig that the repo compiles must enable the two strict flags, not only the product
 * tsconfig. A satellite project is where a strict-flag gap opens with no notice.
 */
describe('DR-14: strict-flag ratchet (satellite projects)', () => {
  const SATELLITES = ['tools/conformance', 'tools/evals-pkg'] as const;

  for (const pkg of SATELLITES) {
    it(`Tsconfig_${pkg.replace(/[^A-Za-z]/g, '')}_BothStrictFlagsEnabled`, () => {
      const config = resolve(REPO_ROOT, pkg, 'tsconfig.json');
      expect(readCompilerFlag(config, 'noUncheckedIndexedAccess')).toBe(true);
      expect(readCompilerFlag(config, 'exactOptionalPropertyTypes')).toBe(true);
    });
  }
});

/**
 * The census counts `x!`, `as` and `as any` sites in the non-test `.ts` files under `CENSUS_ROOTS`.
 * Each count must stay in `[BASELINE, BASELINE + DELTA_BUDGET]`, and the `as any` count must not
 * grow. `DELTA_BUDGET` is the number of sites that work can add before the next re-baseline.
 *
 * `PACKAGE_ROOTS` holds the directories whose tsconfig projects the census roots must cover.
 */
describe('DR-14: escape-hatch census', () => {
  const BASELINE: CastCounts = { nonNull: 70, asCast: 1722, asAny: 0 };

  const DELTA_BUDGET: CastCounts = { nonNull: 5, asCast: 5, asAny: 0 };

  const CENSUS_ROOTS: readonly string[] = [
    'src',
    'tools/audit',
    'tools/release',
    'tools/conformance',
    'tools/evals-pkg',
  ];

  const PACKAGE_ROOTS: readonly string[] = ['.', 'tools/conformance', 'tools/evals-pkg'];

  /**
   * A count less than the baseline fails too, because a stale baseline hides a later regression.
   * A re-baseline must set `BASELINE` to the count of the tree that ships, not of the tree before
   * the edits. After a paydown, that moves the window down and does not widen it. `DELTA_BUDGET`
   * must not grow to make room.
   *
   * Before `BASELINE` goes up, remove each new assertion that has a checked form. Narrowing, a type
   * predicate and `satisfies` are checked forms. The census counts `as const` and does not count
   * `satisfies`. Only a site with no cast-free form can stay. The commit must name the new sites,
   * and must say if the change is a paydown, a measurement correction or a scope change.
   */
  it('FixWave_CastBudget_MeasuredAndWithinDeclaredLimit', () => {
    const counts = countCasts(CENSUS_ROOTS.map((dir) => ({ dir: resolve(REPO_ROOT, dir) })));
    const delta = {
      nonNull: counts.nonNull - BASELINE.nonNull,
      asCast: counts.asCast - BASELINE.asCast,
      asAny: counts.asAny - BASELINE.asAny,
    };
    expect(delta.asAny).toBeLessThanOrEqual(DELTA_BUDGET.asAny);
    expect(delta.nonNull).toBeLessThanOrEqual(DELTA_BUDGET.nonNull);
    expect(delta.asCast).toBeLessThanOrEqual(DELTA_BUDGET.asCast);
    expect(counts.nonNull).toBeGreaterThanOrEqual(BASELINE.nonNull);
    expect(counts.asCast).toBeGreaterThanOrEqual(BASELINE.asCast);
  });

  /**
   * The census roots must cover each file that a tsconfig project in `PACKAGE_ROOTS` compiles. The
   * test reads each `tsconfig*.json` in those directories, so a new config there or a wider
   * `include` fails until the census covers it. A project in another directory is outside this
   * check. The test requires at least four configs, so an empty discovery does not pass.
   *
   * It skips `.d.ts` files, because a declaration file holds no expression.
   */
  it('ScriptsCastCensus_Roots_CoverEveryTypecheckedTree', () => {
    const configs: string[] = [];
    for (const pkg of PACKAGE_ROOTS) {
      for (const entry of readdirSync(resolve(REPO_ROOT, pkg))) {
        if (/^tsconfig(\..+)?\.json$/.test(entry)) configs.push(join(pkg, entry));
      }
    }
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

  /**
   * A root that does not exist counts nothing. A root inside another root counts its files twice.
   * Thus the list names `tools/audit` and `tools/release` and not `tools`, which also holds
   * `tools/conformance` and `tools/evals-pkg`.
   */
  it('CensusRoots_RealRepo_AllExistAndNoneNests', () => {
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
