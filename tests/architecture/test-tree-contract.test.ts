import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

/**
 * The consolidated test tree is only worth having if every tier in it is
 * actually run, exactly once.
 *
 * Two failures are being guarded, and both are silent. A tier collected by NO
 * project passes by never executing — the shape that hid four oracles earlier
 * in this workflow. A tier collected by TWO runs its tests twice under two
 * different policies, so a file needing the 60s Windows headroom also runs
 * under the 5s budget and fails there for reasons unrelated to the code.
 *
 * Most tiers are still empty while tasks 030-033 move files into them, so the
 * mapping cannot be read off what the runner currently collects. It comes from
 * the RESOLVED include globs instead — read back out of a real Vitest instance
 * rather than off the config source, so what is asserted is what the runner
 * actually resolved. Where a tier does hold files, the two views are then
 * required to agree.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const TESTS_ROOT = join(REPO_ROOT, 'tests');

/**
 * Which project owns each tier. Project names describe RUNTIME POLICY (alias,
 * timeout, pool); directory names describe TEST KIND. They are deliberately not
 * the same axis, so the mapping is written down rather than inferred from a
 * name collision.
 */
const TIER_OWNER: Readonly<Record<string, string | null>> = {
  // The product core's own tests: `bun:sqlite` alias + Windows headroom.
  unit: 'core',
  integration: 'core',
  core: 'core',
  // Root-package tiers: fast, no SQLite.
  architecture: 'unit',
  e2e: 'unit',
  smoke: 'unit',
  migration: 'unit',
  benchmarks: 'unit',
  evals: 'unit',
  // The build/gate scripts' own suites (task 031). `unit`, not `core`, because
  // that is the project that collected them while they sat in scripts/ — they
  // test tooling, not the product, so the `bun:sqlite` alias and the 60s
  // Windows headroom are not theirs to inherit. Routing them through
  // `tests/unit/` would have handed them both, silently, via that tier's
  // existing glob. The five core-tier guards went to `tests/core/scripts/`
  // instead, which is nested inside the `core` tier and keeps its policy.
  scripts: 'unit',
  // Test-support modules and their self-tests (task 032). `unit` for the
  // same reason `scripts` is: it is the project that collected them at
  // `test/fixtures/`, and a helper's self-test is not product code.
  helpers: 'unit',
  // Tiers whose policy is their whole reason for existing.
  process: 'process',
  outcome: 'outcome',
  acceptance: 'acceptance',
  // `support` holds fixtures and shell suites. `null` is a claim with teeth:
  // vitest must collect nothing here, so a stray `.test.ts` fixture that would
  // execute as a test is a failure rather than a surprise.
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
 * Projects whose resolved globs cover `tests/<tier>/`.
 *
 * Every glob naming this tree is of the form `tests/<tier>/**` + a suffix, so a
 * prefix comparison is exact. `GlobsNamingTheTestTree_AreScopedToOneTier` is
 * what keeps that true — without it, one broader glob would quietly invalidate
 * this.
 */
function ownersByGlob(tier: string): string[] {
  const prefix = `tests/${tier}/`;
  return projects
    .filter((p) => p.include.some((g) => g.startsWith(prefix)))
    .map((p) => p.name)
    .sort();
}

describe('TestTree', () => {
  it('EveryTierDirectory_IsCollectedByExactlyOneProject', () => {
    expect(projects.length, 'no projects resolved').toBeGreaterThan(0);

    const dirs = tierDirs();
    expect(dirs.length, 'no tier directories found under tests/').toBeGreaterThan(0);

    // A new tier appearing with no declared owner is the ungoverned case, and
    // it has to fail here rather than when a file first lands in it.
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

  it('GlobsNamingTheTestTree_AreScopedToOneTier', () => {
    // The premise the mapping rests on. A glob like `tests/**/*.test.ts` would
    // collect every tier at once, and the prefix comparison would not notice.
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

  it('WhatTheRunnerCollects_MatchesWhoTheGlobsSayOwnsIt', () => {
    // Calibration. The mapping above is read off resolved globs; the authority
    // on what RUNS is what the collector returned. Where both can see the same
    // tier — the ones already holding files — they must agree, or the glob
    // reading means nothing for the empty tiers.
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

  it('EveryProjectNamedInAScript_Exists', () => {
    // `test:unit` carried `--project integration` against a project that was
    // never defined. vitest only errors when NO filter matches, so the dead
    // half was silently dropped on every run and the script read as if it
    // covered a tier it did not.
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

  it('TheTestTree_IsTypecheckedByItsOwnTsconfig', () => {
    // Until this config existed the root tsconfig excluded `**/*.test.ts`
    // outright, so no test in the repository was type-checked at all — a test
    // could name a deleted export and only the runner would notice, and only if
    // it ran.
    const cfgPath = join(TESTS_ROOT, 'tsconfig.json');
    expect(existsSync(cfgPath), 'tests/tsconfig.json is absent').toBe(true);

    const cfg = JSON.parse(
      // Strip line comments so the config can stay commented for readers.
      readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { include?: string[]; exclude?: string[] };

    expect(cfg.include, 'tests/tsconfig.json declares no include').toBeDefined();
    expect(cfg.include, 'tests/tsconfig.json no longer covers the whole tree').toContain('**/*.ts');
    // The exclusion that would make this config vacuous is the one the root
    // config carries, so name it rather than trusting it stays absent.
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

  it('TestsTsconfig_ExcludedTiers_OnlyShrink', () => {
    // Task 030 moved 925 never-type-checked files into `unit/` and
    // `integration/`, which carry 2,801 latent errors across 482 files. They are
    // excluded until that debt is paid, and this is the whole of the exemption:
    // a tier added here stops being checked, silently, exactly like the root
    // config's `**/*.test.ts` exclusion did for four years. Delete an entry when
    // its tier compiles; adding one is a deliberate act that fails here first.
    const cfg = JSON.parse(
      readFileSync(join(TESTS_ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { exclude?: string[] };
    const local = (cfg.exclude ?? []).filter((e) => !e.startsWith('../'));

    // The list holds two categories and conflating them is how a debt exemption
    // would slip in wearing a not-code label. DEBT may only shrink. NOT_CODE is
    // fixed, and each entry has to earn its place below.
    const NOT_CODE = ['evals/**/runs/**', 'evals/**/tasks/*/oracle.ts'];
    const debt = local.filter((e) => !NOT_CODE.includes(e)).sort();
    expect(debt, 'a tier was added to the typecheck exemption').toEqual([
      'integration/**',
      'unit/**',
    ]);
    expect(local.filter((e) => NOT_CODE.includes(e)).sort(), 'the not-code exclusion changed').toEqual(
      [...NOT_CODE].sort(),
    );

    // An exemption naming a tier that does not exist is spent config pretending
    // to be a concession.
    for (const t of debt) {
      expect(existsSync(join(TESTS_ROOT, t.replace('/**', ''))), `exempted tier ${t} does not exist`).toBe(true);
    }
  });

  it('CapturedEvalRuns_AfterMove_RemainExcludedFromCollection', () => {
    // Task 033 moved the captured eval artifacts under `tests/`, where the test
    // globs actually reach. Each one is a verbatim record of what a model wrote,
    // driven by a module-load harness that calls `process.exit` — reaching a
    // vitest worker, it would take the worker down rather than fail an
    // assertion. The exclusion that stops that used to be anchored on `docs/`,
    // which this move would have left matching nothing.
    //
    // Asserting the glob string would prove only that a line exists. This asks
    // the resolved runner what it actually collects.
    const runFiles = execFileSync('git', ['ls-files', 'tests/evals'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter((f) => f.includes('/runs/') && /\.test\.ts$/.test(f));

    // Denominator first: with no captured artifacts on disk this test would
    // pass by having nothing to exclude.
    expect(runFiles.length, 'no captured run artifacts found — this guard is vacuous').toBeGreaterThan(0);

    const collected = new Set<string>();
    for (const p of projects) for (const t of p.collectedTiers) collected.add(t);
    expect(collected.has('evals'), 'the evals tier is collected by no project').toBe(true);

    const collectedRunFiles = collectedFiles.filter((f) => f.includes('/runs/'));
    expect(collectedRunFiles, 'a captured run artifact reached a vitest project').toEqual([]);
  });
});
