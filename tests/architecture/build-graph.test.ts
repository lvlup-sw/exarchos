// The build graph is one product package plus the tool packages that this file
// declares. It is not one lockfile, and it is not one flat test tier. The
// `core` project keeps a 60 s budget for each test, chosen for the Windows
// runner. The 5 s budget of the `unit` project fails healthy core tests on
// Windows. This suite pins the package set and the test policy, so that a
// later merge of the tiers cannot remove them silently.
//
// @oracle-sources: ../../vitest.config.ts, git-tracked-manifest-listing
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');

const CORE_CONFIG = path.join(REPO_ROOT, 'vitest.config.ts');
const ROOT_CONFIG = path.join(REPO_ROOT, 'vitest.config.ts');

/**
 * Each `package.json` that this repository tracks, with its role. A manifest
 * that is not in this table fails the first test, so each new package needs a
 * declared purpose.
 */
const DECLARED_PACKAGES: Readonly<
  Record<string, { role: string; disposition: 'retained' | 'retired'; why: string }>
> = {
  'package.json': {
    role: 'product',
    disposition: 'retained',
    why: 'The exarchos CLI, the MCP server, and their build/test entry points — the one package a user installs. Task 019 dissolved the nested `servers/exarchos-mcp` workspace into this manifest; its dependency closure merged in, and the vitest policy it carried became the root `core` project rather than being dropped.',
  },
  'tools/evals-pkg/package.json': {
    role: 'tool',
    disposition: 'retained',
    why: 'RETAINED (task 011a). Opt-in promptfoo eval harness, isolated so the heavy eval-only dependency stays OUT of the default product install (DR-3). The graders resolve promptfoo from THIS package at runtime, and ci.yml names it in the prompts: paths-filter so a change here still fires RUN_EVALS. Retiring it would delete a live eval capability and orphan that filter.',
  },
};

async function trackedManifests(): Promise<string[]> {
  return (await execFileAsync('git', ['-C', REPO_ROOT, 'ls-files', '*package.json']))
    .split('\n')
    .filter(Boolean)
    .filter((p) => !p.includes('node_modules'))
    .sort();
}

const coreConfig = readFileSync(CORE_CONFIG, 'utf8');

describe('BuildGraph_AfterUnification_DeclaredPackageSetMatchesTheManifestSet', () => {
  it('every tracked manifest is declared, and every declaration is tracked', async () => {
    const tracked = await trackedManifests();
    expect(tracked.length).toBeGreaterThan(1);
    expect(
      tracked,
      'The manifest set changed. Add the new package to DECLARED_PACKAGES with its role and ' +
        'reason, or remove the manifest — a package nobody has classified is a dependency ' +
        'closure nobody owns.',
    ).toEqual(Object.keys(DECLARED_PACKAGES).sort());
  });

  it('every declared package states a role and a reason', () => {
    for (const [manifest, meta] of Object.entries(DECLARED_PACKAGES)) {
      expect(['product', 'tool'], `${manifest}: unknown role`).toContain(meta.role);
      expect(meta.why.length, `${manifest}: no reason given`).toBeGreaterThan(30);
    }
  });

  /** A manifest without a lockfile installs unpinned dependencies. */
  it('each declared manifest has its own lockfile beside it', () => {
    for (const manifest of Object.keys(DECLARED_PACKAGES)) {
      const lock = path.join(REPO_ROOT, path.dirname(manifest), 'package-lock.json');
      expect(existsSync(lock), `${manifest} has no package-lock.json beside it`).toBe(true);
    }
  });
});

describe('ManifestSet_EveryTrackedPackageJson_IsClassifiedRetainedOrRetired', () => {
  /**
   * Each tracked manifest has a row in the table, and the row states
   * `retained` or `retired`. No other state exists.
   */
  it('every manifest carries an explicit disposition', async () => {
    const tracked = await trackedManifests();
    for (const manifest of tracked) {
      const meta = DECLARED_PACKAGES[manifest];
      expect(meta, `${manifest} is tracked but unclassified`).toBeDefined();
      expect(['retained', 'retired'], `${manifest}: unknown disposition`).toContain(
        meta?.disposition,
      );
    }
  });

  /**
   * A CI filter that names a retired package can never fire, and a gate that
   * never fires reads as green.
   */
  it('a retired package leaves no CI paths-filter behind', () => {
    const lanes = readFileSync(path.join(REPO_ROOT, '.github/ci-lanes.toml'), 'utf8');
    for (const [manifest, meta] of Object.entries(DECLARED_PACKAGES)) {
      if (meta.disposition !== 'retired') continue;
      const dir = path.dirname(manifest);
      expect(lanes, `${manifest} is retired but ci-lanes.toml still filters on ${dir}`).not.toContain(
        dir,
      );
    }
  });

  /**
   * The package states its purpose, and the CI filter still names the package
   * so that a change to it fires the eval lane. If one of the two disappears,
   * the eval lane stops silently. The `private` flag keeps the package off the
   * registry.
   */
  it('evals-pkg is retained, and the CI filter that depends on it still exists', () => {
    const meta = DECLARED_PACKAGES['tools/evals-pkg/package.json'];
    expect(meta?.disposition).toBe('retained');
    const lanes = readFileSync(path.join(REPO_ROOT, '.github/ci-lanes.toml'), 'utf8');
    expect(lanes).toContain('tools/evals-pkg/**');

    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'tools/evals-pkg/package.json'), 'utf8'),
    ) as { private?: boolean; description?: string; dependencies?: Record<string, string> };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies?.promptfoo).toBeDefined();
    expect((manifest.description ?? '').length).toBeGreaterThan(40);
  });

  /**
   * The eval package exists to isolate promptfoo. If the product manifest
   * names promptfoo, each product install pays for it.
   */
  it('the heavy eval dependency stays out of the product install closure', () => {
    for (const productManifest of ['package.json']) {
      const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, productManifest), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(
        { ...pkg.dependencies, ...pkg.devDependencies }.promptfoo,
        `${productManifest} pulls promptfoo into the product install closure`,
      ).toBeUndefined();
    }
  });
});

/**
 * Each project that runs tests on `bun:sqlite` declares the alias. More than
 * one declaration is correct, but all of them must point at one shim.
 * `aliasTargets` reads the shim path of each declaration in a config file.
 */
describe('BuildGraph_BunSqliteAlias_ResolvesInEveryProject', () => {
  function aliasTargets(configPath: string): string[] {
    const src = readFileSync(configPath, 'utf8');
    const dir = path.dirname(configPath);
    return [...src.matchAll(/'bun:sqlite':\s*fileURLToPath\(\s*\n?\s*new URL\(\s*\n?\s*'([^']+)'/g)]
      .map((m) => path.resolve(dir, m[1] as string));
  }

  const targets = [...aliasTargets(CORE_CONFIG), ...aliasTargets(ROOT_CONFIG)];

  /**
   * Denominator check. If the pattern drifts from the config and matches
   * nothing, the shim-exists test loops over an empty list and passes.
   */
  it('every project that needs the alias declares it', () => {
    expect(targets.length).toBeGreaterThanOrEqual(2);
  });

  it('every declaration resolves to the SAME shim', () => {
    expect(
      [...new Set(targets)],
      'The bun:sqlite alias points at more than one shim. Tests would run against different ' +
        'SQLite bindings depending on which tier collected them — and the divergence would ' +
        'surface as a storage bug, never as a config one.',
    ).toHaveLength(1);
  });

  /** An alias to a deleted shim makes each storage test fail at import time, far from the cause. */
  it('the shim exists on disk', () => {
    for (const target of new Set(targets)) {
      expect(existsSync(target), `alias target missing: ${target}`).toBe(true);
    }
  });

  /**
   * The `unit` project has no `bun:sqlite` alias of its own, so a core test
   * that it collects fails on that import. The test reads only the quoted
   * globs of the include list, because a comment in that list can name the
   * path.
   */
  it('the root unit tier still does not collect the core suite', () => {
    const root = readFileSync(ROOT_CONFIG, 'utf8');
    const block = /name:\s*'unit'[\s\S]*?include:\s*\[([\s\S]*?)\]/.exec(root)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(0);
    const globs = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    expect(globs.length).toBeGreaterThan(5);
    expect(globs.filter((g) => g.includes('servers/exarchos-mcp'))).toEqual([]);
  });
});

describe('BuildGraph_CoreTestTier_RetainsItsDeclaredTimeoutPolicy', () => {
  /**
   * The budget must stay unscaled. Fast tests on Linux never reach the cap, so
   * a lower value only causes failures on Windows.
   */
  it('keeps the 60 s per-test and per-hook budget chosen for the Windows runner', () => {
    expect(coreConfig).toMatch(/testTimeout:\s*60000/);
    expect(coreConfig).toMatch(/hookTimeout:\s*60000/);
  });

  it('keeps the forks pool', () => {
    expect(coreConfig).toMatch(/pool:\s*'forks'/);
  });

  /** The bench tree lives under `tools/`, outside the product. The `core` project must still collect it. */
  it('keeps the type-test and bench includes', () => {
    expect(coreConfig).toContain('*.type-test.ts');
    expect(coreConfig).toContain('tools/evals/bench/**/*.bench.ts');
  });

  /**
   * The `--exclude` flag of vitest only adds exclusions, so this toggle must
   * live in the config. Without it, the Stryker smoke test runs in the
   * coverage lane or cannot run at all.
   */
  it('keeps the EXARCHOS_SMOKE_ONLY exclusion toggle and its defaults', () => {
    expect(coreConfig).toContain('EXARCHOS_SMOKE_ONLY');
    expect(coreConfig).toContain('configDefaults.exclude');
    expect(coreConfig).toContain('stryker-adapter.smoke.test.ts');
  });

  it('keeps benchmark.outputJson', () => {
    expect(coreConfig).toMatch(/outputJson:\s*'benchmark-results\.json'/);
  });

  /** Each root project states its timeout explicitly, which keeps the policy readable. */
  it('the root tiers still declare their own timeouts rather than inheriting a default', () => {
    const root = readFileSync(ROOT_CONFIG, 'utf8');
    expect((root.match(/testTimeout:/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('BuildGraph_CoverageRatchet_StillReceivesItsInputs', () => {
  it('the v8 provider emits json-summary, the artifact the ratchet reads', () => {
    expect(coreConfig).toMatch(/provider:\s*'v8'/);
    expect(coreConfig).toContain('json-summary');
  });

  /**
   * Some tests fail only on a local machine. With the vitest default of
   * `false`, a red run writes no summary, and the ratchet fails closed for a
   * reason that is not coverage.
   */
  it('reportOnFailure stays true so a red run still produces the summary', () => {
    expect(coreConfig).toMatch(/reportOnFailure:\s*true/);
  });

  it('the baseline sits with the other audit oracles and the ratchet defaults to it', () => {
    const baseline = path.join(REPO_ROOT, 'tools/audit/coverage-baseline.json');
    expect(existsSync(baseline), 'coverage baseline missing from tools/audit/').toBe(true);
    const ratchet = readFileSync(path.join(REPO_ROOT, 'tools/audit/gates/check-coverage-ratchet.mjs'), 'utf8');
    expect(ratchet).toMatch(/'tools',\s*'audit',\s*'coverage-baseline\.json'/);
  });

  /**
   * The ratchet fails closed on a baseline with fewer than three distinct run
   * ids. This test names that failure before CI reports a bare exit code. The
   * ratchet also requires a `spread` for each metric, which this test does not
   * check.
   */
  it('the baseline carries the provenance the ratchet refuses to run without', () => {
    const baseline = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'tools/audit/coverage-baseline.json'), 'utf8'),
    ) as { runIds?: unknown; metrics?: Record<string, { spread?: unknown }> };
    expect(Array.isArray(baseline.runIds)).toBe(true);
    expect((baseline.runIds as string[]).length).toBeGreaterThanOrEqual(3);
  });
});
