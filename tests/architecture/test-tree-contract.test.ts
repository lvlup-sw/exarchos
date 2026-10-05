/**
 * Each tier of the test tree must run in exactly one vitest project.
 *
 * A tier that no project collects passes because it never runs. A tier that two projects
 * collect runs under two policies. Then a file that needs the 60s Windows headroom also runs
 * under the 5s budget and fails there.
 *
 * The mapping comes from the include globs that a real Vitest instance resolves, not from
 * the config source. Where a tier holds files, the collected files must agree with the globs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const TESTS_ROOT = join(REPO_ROOT, 'tests');

/**
 * The project that owns each tier. A project name states a runtime policy (alias, timeout,
 * pool), and a directory name states a test kind. The two are different axes, so this map
 * declares each owner and infers nothing from a shared name.
 */
const TIER_OWNER: Readonly<Record<string, string | null>> = {
  /** The tests of the product core: the `bun:sqlite` alias and the Windows headroom. */
  unit: 'core',
  integration: 'core',
  core: 'core',
  /** The root-package tiers: a short budget and no SQLite alias. */
  architecture: 'unit',
  e2e: 'unit',
  smoke: 'unit',
  migration: 'unit',
  benchmarks: 'unit',
  evals: 'unit',
  /**
   * The suites of the build and gate scripts. They test tooling, not the product, so they
   * do not get the `bun:sqlite` alias or the 60s Windows headroom. The script suites that
   * need the `core` policy are in `tests/core/scripts/`, inside the `core` tier.
   */
  scripts: 'unit',
  /** Test-support modules and their self-tests. A self-test of a helper is not product code. */
  helpers: 'unit',
  /** The tiers that exist for their runtime policy. */
  process: 'process',
  outcome: 'outcome',
  acceptance: 'acceptance',
  /**
   * `support` holds fixtures and shell suites. `null` means that vitest must collect nothing
   * here, so a stray `.test.ts` fixture fails the guard.
   */
  support: null,
};

type ResolvedProject = { name: string; include: string[]; collectedTiers: Set<string> };

let projects: ResolvedProject[] = [];
/** Every repo-relative path any project resolved, across all projects. */
let collectedFiles: string[] = [];

beforeAll(async () => {
  const vitest = await createVitest('test', { watch: false });
  try {
    const root = REPO_ROOT.replace(/\\/g, '/');
    for (const project of vitest.projects) {
      const { testFiles } = await project.globTestFiles();
      const collectedTiers = new Set<string>();
      for (const file of testFiles) {
        const rel = file.replace(/\\/g, '/').replace(`${root}/`, '');
        collectedFiles.push(rel);
        if (!rel.startsWith('tests/')) continue;
        const tier = rel.slice('tests/'.length).split('/')[0];
        if (tier) collectedTiers.add(tier);
      }
      projects.push({
        name: project.name,
        include: [...(project.config.include ?? [])],
        collectedTiers,
      });
    }
  } finally {
    await vitest.close();
  }
}, 120_000);

afterAll(() => {
  projects = [];
  collectedFiles = [];
});

/** Tier directories that exist on disk. */
function tierDirs(): string[] {
  return readdirSync(TESTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * The projects whose resolved globs cover `tests/<tier>/`.
 *
 * Each glob that names this tree starts with `tests/<tier>/`, so a prefix comparison is
 * exact. `GlobsNamingTheTestTree_AreScopedToOneTier` keeps that true: one broader glob
 * invalidates the comparison.
 */
function ownersByGlob(tier: string): string[] {
  const prefix = `tests/${tier}/`;
  return projects
    .filter((p) => p.include.some((g) => g.startsWith(prefix)))
    .map((p) => p.name)
    .sort();
}

describe('TestTree', () => {
  /** A tier directory with no declared owner fails here, before a file arrives in it. */
  it('EveryTierDirectory_IsCollectedByExactlyOneProject', () => {
    expect(projects.length, 'no projects resolved').toBeGreaterThan(0);

    const dirs = tierDirs();
    expect(dirs.length, 'no tier directories found under tests/').toBeGreaterThan(0);

    const undeclared = dirs.filter((d) => !(d in TIER_OWNER));
    expect(undeclared, 'tier directories with no declared owning project').toEqual([]);

    for (const tier of dirs) {
      const expected = TIER_OWNER[tier];
      const actual = ownersByGlob(tier);
      if (expected === null) {
        expect(actual, `tests/${tier}/ must be collected by no project`).toEqual([]);
      } else {
        expect(actual, `tests/${tier}/ must be collected by exactly one project`).toEqual([
          expected,
        ]);
      }
    }
  });

  /**
   * The premise of `ownersByGlob`. A glob with a wildcard in the tier segment collects every
   * tier at once, and the prefix comparison does not see it.
   */
  it('GlobsNamingTheTestTree_AreScopedToOneTier', () => {
    const offenders: string[] = [];
    for (const p of projects) {
      for (const g of p.include) {
        if (!g.startsWith('tests/')) continue;
        const segment = g.slice('tests/'.length).split('/')[0] ?? '';
        if (segment === '' || segment.includes('*')) offenders.push(`${p.name}: ${g}`);
      }
    }
    expect(offenders, 'include globs spanning more than one tier').toEqual([]);
  });

  /**
   * Calibration. The mapping comes from the resolved globs, and the collector is the authority
   * on what runs. For each tier that holds collected files, the two must agree.
   */
  it('WhatTheRunnerCollects_MatchesWhoTheGlobsSayOwnsIt', () => {
    const collectedBy = new Map<string, string[]>();
    for (const p of projects) {
      for (const tier of p.collectedTiers) {
        collectedBy.set(tier, [...(collectedBy.get(tier) ?? []), p.name].sort());
      }
    }

    expect(
      collectedBy.size,
      'the runner collects nothing under tests/, so there is nothing to calibrate against',
    ).toBeGreaterThan(0);

    for (const [tier, observed] of collectedBy) {
      expect(
        observed,
        `runner and resolved globs disagree about who collects tests/${tier}/`,
      ).toEqual(ownersByGlob(tier));
    }
  });

  /**
   * vitest fails only when no `--project` filter matches. A script that names one real
   * project and one missing project still runs, and it appears to cover a tier that it does
   * not run.
   */
  it('EveryProjectNamedInAScript_Exists', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    const defined = new Set(projects.map((p) => p.name));
    expect(defined.size, 'no projects resolved').toBeGreaterThan(0);

    const dangling: string[] = [];
    for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
      for (const m of body.matchAll(/--project[= ]([\w-]+)/g)) {
        const project = m[1];
        if (project && !defined.has(project)) dangling.push(`${name}: --project ${project}`);
      }
    }
    expect(dangling, 'npm scripts filtering on projects that do not exist').toEqual([]);
  });

  /**
   * The root tsconfig excludes every test file, so `tests/tsconfig.json` is the only typecheck
   * of the test tree. It must include the whole tree and must not repeat the exclusion of the
   * root config, and the `typecheck` script must run it. The config holds `//` line comments,
   * so the test removes them before the JSON parse.
   */
  it('TheTestTree_IsTypecheckedByItsOwnTsconfig', () => {
    const cfgPath = join(TESTS_ROOT, 'tsconfig.json');
    expect(existsSync(cfgPath), 'tests/tsconfig.json is absent').toBe(true);

    const cfg = JSON.parse(
      readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { include?: string[]; exclude?: string[] };

    expect(cfg.include, 'tests/tsconfig.json declares no include').toBeDefined();
    expect(cfg.include, 'tests/tsconfig.json no longer covers the whole tree').toContain('**/*.ts');
    expect(
      (cfg.exclude ?? []).filter((e) => e.includes('*.test.ts')),
      'tests/tsconfig.json excludes the tests it exists to check',
    ).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(
      pkg.scripts?.typecheck ?? '',
      'the tests tsconfig exists but no script runs it',
    ).toContain('-p tests');
  });

  /**
   * `unit/` and `integration/` hold latent type errors, so `tests/tsconfig.json` excludes them
   * until they compile. The test pins that debt list, so a new exemption fails here. Delete an
   * entry when its tier compiles.
   *
   * The `NOT_CODE` entries are a separate, fixed list, so a debt entry cannot pass as
   * not-code. Each debt entry must name a tier directory that exists.
   */
  it('TestsTsconfig_ExcludedTiers_OnlyShrink', () => {
    const cfg = JSON.parse(
      readFileSync(join(TESTS_ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { exclude?: string[] };
    const local = (cfg.exclude ?? []).filter((e) => !e.startsWith('../'));

    const NOT_CODE = ['evals/**/runs/**', 'evals/**/tasks/*/oracle.ts'];
    const debt = local.filter((e) => !NOT_CODE.includes(e)).sort();
    expect(debt, 'a tier was added to the typecheck exemption').toEqual([
      'integration/**',
      'unit/**',
    ]);
    expect(local.filter((e) => NOT_CODE.includes(e)).sort(), 'the not-code exclusion changed').toEqual(
      [...NOT_CODE].sort(),
    );

    for (const t of debt) {
      expect(existsSync(join(TESTS_ROOT, t.replace('/**', ''))), `exempted tier ${t} does not exist`).toBe(true);
    }
  });

  /**
   * The live `auditLayerBoundaries` suite is in the `unit` tier, which the `core` project
   * collects. `npm run test:run` runs the `unit` project and does not collect it. The test
   * pins the path, so a move of the suite to `tests/architecture/` fails here.
   */
  it('LayerBoundaryCensus_LivesInTheCoreHostedUnitTier', () => {
    const rel = 'tests/unit/architecture/layer-boundaries-seam.test.ts';
    expect(existsSync(join(REPO_ROOT, rel)), `${rel} is absent`).toBe(true);
    expect(TIER_OWNER.unit).toBe('core');
    expect(TIER_OWNER.architecture).toBe('unit');
    expect(collectedFiles, `${rel} is collected by no project`).toContain(rel);
    expect(ownersByGlob('unit')).toEqual(['core']);
    expect(ownersByGlob('architecture')).toEqual(['unit']);
    expect(collectedFiles).not.toContain('tests/architecture/layer-boundaries-seam.test.ts');
  });

  /**
   * The captured eval artifacts are under `tests/evals`, where the test globs reach. Each one
   * is a verbatim record of model output, with a module-load harness that calls
   * `process.exit`. In a vitest worker, it stops the worker and fails no assertion.
   *
   * The test reads what the resolved runner collects, because the glob string alone proves
   * only that a line exists. It first requires a tracked run artifact, so it cannot pass with
   * nothing to exclude.
   */
  it('CapturedEvalRuns_AfterMove_RemainExcludedFromCollection', async () => {
    const runFiles = (
      await execFileAsync('git', ['ls-files', 'tests/evals'], {
        cwd: REPO_ROOT,
      })
    )
      .split('\n')
      .filter((f) => f.includes('/runs/') && /\.test\.ts$/.test(f));

    expect(runFiles.length, 'no captured run artifacts found — this guard is vacuous').toBeGreaterThan(0);

    const collected = new Set<string>();
    for (const p of projects) for (const t of p.collectedTiers) collected.add(t);
    expect(collected.has('evals'), 'the evals tier is collected by no project').toBe(true);

    const collectedRunFiles = collectedFiles.filter((f) => f.includes('/runs/'));
    expect(collectedRunFiles, 'a captured run artifact reached a vitest project').toEqual([]);
  });
});
