import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── The build graph (DR-2, task 011) ────────────────────────────────────────
//
// The end state this pins is "one product package plus explicitly-declared tool
// packages" — NOT one lockfile, and NOT one flattened test tier. Both of those
// readings are actively wrong here, and the second is dangerous: the core suite
// runs ~900 files under a 60 s per-test budget chosen for the Windows runner
// (#1620). Folding it into the root `unit` tier's 5 s budget would fail healthy
// tests by lottery on Windows, which is precisely the outcome the plan calls
// out. So the unification is DECLARATIVE — the policy and the package set are
// written down and checked here, so a later collapse cannot drop them quietly.
//
// @oracle-sources: ../../vitest.config.ts, git-tracked-manifest-listing

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');

const CORE_CONFIG = path.join(REPO_ROOT, 'vitest.config.ts');
const ROOT_CONFIG = path.join(REPO_ROOT, 'vitest.config.ts');

/**
 * Every package.json this repository ships, and what it is for. A manifest that
 * is not in this table fails the first test — which is the point: a fifth
 * package cannot appear without someone saying what it is.
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
  'documentation/package.json': {
    role: 'tool',
    disposition: 'retained',
    why: 'Documentation site toolchain. Retained here and scoped to task 039’s skeleton reduction, which owns the decision about what the documentation tree becomes.',
  },
};

function trackedManifests(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '*package.json'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((p) => !p.includes('node_modules'))
    .sort();
}

const coreConfig = readFileSync(CORE_CONFIG, 'utf8');

describe('BuildGraph_AfterUnification_DeclaredPackageSetMatchesTheManifestSet', () => {
  it('every tracked manifest is declared, and every declaration is tracked', () => {
    const tracked = trackedManifests();
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

  it('each declared manifest has its own lockfile beside it', () => {
    // Three manifest/lockfile PAIRS since task 019 dissolved the nested server
    // workspace. A manifest without a lockfile installs unpinned.
    for (const manifest of Object.keys(DECLARED_PACKAGES)) {
      const lock = path.join(REPO_ROOT, path.dirname(manifest), 'package-lock.json');
      expect(existsSync(lock), `${manifest} has no package-lock.json beside it`).toBe(true);
    }
  });
});

describe('ManifestSet_EveryTrackedPackageJson_IsClassifiedRetainedOrRetired', () => {
  // Task 011a. A fifth manifest must not be able to appear unnoticed: every
  // tracked package.json is the product, a declared tool package, or explicitly
  // retired. There is no fourth state, and "nobody got round to it" is not one.
  it('every manifest carries an explicit disposition', () => {
    const tracked = trackedManifests();
    for (const manifest of tracked) {
      const meta = DECLARED_PACKAGES[manifest];
      expect(meta, `${manifest} is tracked but unclassified`).toBeDefined();
      expect(['retained', 'retired'], `${manifest}: unknown disposition`).toContain(
        meta?.disposition,
      );
    }
  });

  it('a retired package leaves no CI paths-filter behind', () => {
    // The plan's condition: retired "with its CI filter removed in the same
    // change". A filter naming a package that no longer exists is a gate that
    // can never fire, which reads as green.
    const ci = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    for (const [manifest, meta] of Object.entries(DECLARED_PACKAGES)) {
      if (meta.disposition !== 'retired') continue;
      const dir = path.dirname(manifest);
      expect(ci, `${manifest} is retired but ci.yml still filters on ${dir}`).not.toContain(dir);
    }
  });

  it('evals-pkg is retained, and the CI filter that depends on it still exists', () => {
    // Retained "under a declared home": the package states its own purpose, and
    // the filter that makes a change to it fire RUN_EVALS is still wired. If
    // either half disappears the eval lane stops firing silently.
    const meta = DECLARED_PACKAGES['tools/evals-pkg/package.json'];
    expect(meta?.disposition).toBe('retained');
    const ci = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('tools/evals-pkg/**');

    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'tools/evals-pkg/package.json'), 'utf8'),
    ) as { private?: boolean; description?: string; dependencies?: Record<string, string> };
    // `private` is what keeps an opt-in tool package off the registry.
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies?.promptfoo).toBeDefined();
    expect((manifest.description ?? '').length).toBeGreaterThan(40);
  });

  it('the heavy eval dependency stays out of the product install closure', () => {
    // The entire reason this package exists (DR-3). If promptfoo appears in the
    // product manifest, the isolation has failed and every install pays for it.
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

describe('BuildGraph_BunSqliteAlias_ResolvesInEveryProject', () => {
  /**
   * Both configs that host bun:sqlite-touching tests declare the alias — the
   * core tier for the unit suite, the root `outcome` tier because it drives
   * real MCP handlers. "Resolves once" is about the SHIM, not the number of
   * declarations: two declarations are fine, two different targets are not.
   */
  function aliasTargets(configPath: string): string[] {
    const src = readFileSync(configPath, 'utf8');
    const dir = path.dirname(configPath);
    return [...src.matchAll(/'bun:sqlite':\s*fileURLToPath\(\s*\n?\s*new URL\(\s*\n?\s*'([^']+)'/g)]
      .map((m) => path.resolve(dir, m[1] as string));
  }

  const targets = [...aliasTargets(CORE_CONFIG), ...aliasTargets(ROOT_CONFIG)];

  it('every project that needs the alias declares it', () => {
    // Two, today. A zero here means a regex drifted from the config and the
    // rest of this suite would pass vacuously.
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

  it('the shim exists on disk', () => {
    // An alias pointing at a deleted shim resolves to nothing and every
    // storage-touching test fails at import time, far from the cause.
    for (const target of new Set(targets)) {
      expect(existsSync(target), `alias target missing: ${target}`).toBe(true);
    }
  });

  it('the root unit tier still does not collect the core suite', () => {
    // The unit tier has no alias of its own. If a later change points it at
    // servers/exarchos-mcp without carrying one, every bun:sqlite import breaks.
    const root = readFileSync(ROOT_CONFIG, 'utf8');
    const block = /name:\s*'unit'[\s\S]*?include:\s*\[([\s\S]*?)\]/.exec(root)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(0);
    // Comments inside the array legitimately DISCUSS servers/exarchos-mcp —
    // explaining why the hook tests live here rather than there. Only the glob
    // strings decide what is collected.
    const globs = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    expect(globs.length).toBeGreaterThan(5);
    expect(globs.filter((g) => g.includes('servers/exarchos-mcp'))).toEqual([]);
  });
});

describe('BuildGraph_CoreTestTier_RetainsItsDeclaredTimeoutPolicy', () => {
  it('keeps the 60 s per-test and per-hook budget chosen for the Windows runner', () => {
    // Explicitly NOT to be re-scaled (#1620). Linux is unaffected — fast tests
    // finish in milliseconds and never approach the cap — so the only thing a
    // reduction buys is Windows flake.
    expect(coreConfig).toMatch(/testTimeout:\s*60000/);
    expect(coreConfig).toMatch(/hookTimeout:\s*60000/);
  });

  it('keeps the forks pool', () => {
    expect(coreConfig).toMatch(/pool:\s*'forks'/);
  });

  it('keeps the type-test and bench includes', () => {
    expect(coreConfig).toContain('*.type-test.ts');
    // The bench tree is a STATED EXCEPTION in the layer map, so task 019 filed
    // it under `tools/` rather than carrying it into the product. What this
    // assertion protects is that the `core` project still collects it at all —
    // the location moved, the collection must not lapse.
    expect(coreConfig).toContain('tools/evals/bench/**/*.bench.ts');
  });

  it('keeps the EXARCHOS_SMOKE_ONLY exclusion toggle and its defaults', () => {
    // vitest's CLI --exclude is additive and cannot un-exclude, so this toggle
    // can only live in the config. Losing it either drags the heavy Stryker
    // smoke test into the coverage lane or makes it unrunnable.
    expect(coreConfig).toContain('EXARCHOS_SMOKE_ONLY');
    expect(coreConfig).toContain('configDefaults.exclude');
    expect(coreConfig).toContain('stryker-adapter.smoke.test.ts');
  });

  it('keeps benchmark.outputJson', () => {
    expect(coreConfig).toMatch(/outputJson:\s*'benchmark-results\.json'/);
  });

  it('the root tiers still declare their own timeouts rather than inheriting a default', () => {
    // WFQ-015: every root project states its timeout explicitly. The policy is
    // legible only while that stays true.
    const root = readFileSync(ROOT_CONFIG, 'utf8');
    expect((root.match(/testTimeout:/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('BuildGraph_CoverageRatchet_StillReceivesItsInputs', () => {
  it('the v8 provider emits json-summary, the artifact the ratchet reads', () => {
    expect(coreConfig).toMatch(/provider:\s*'v8'/);
    expect(coreConfig).toContain('json-summary');
  });

  it('reportOnFailure stays true so a red run still produces the summary', () => {
    // This repo carries known local-only red tests. With vitest's default
    // (false), the summary silently never materialises and the ratchet starves
    // — failing closed for a reason that has nothing to do with coverage.
    expect(coreConfig).toMatch(/reportOnFailure:\s*true/);
  });

  it('the baseline sits with the other audit oracles and the ratchet defaults to it', () => {
    const baseline = path.join(REPO_ROOT, 'tools/audit/coverage-baseline.json');
    expect(existsSync(baseline), 'coverage baseline missing from tools/audit/').toBe(true);
    const ratchet = readFileSync(path.join(REPO_ROOT, 'tools/audit/gates/check-coverage-ratchet.mjs'), 'utf8');
    expect(ratchet).toMatch(/'tools',\s*'audit',\s*'coverage-baseline\.json'/);
  });

  it('the baseline carries the provenance the ratchet refuses to run without', () => {
    // The ratchet fails closed on a baseline with no run-ids or no measured
    // spread. Checking it here means the failure surfaces in a named test
    // rather than as a mysterious exit 2 in CI.
    const baseline = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'tools/audit/coverage-baseline.json'), 'utf8'),
    ) as { runIds?: unknown; metrics?: Record<string, { spread?: unknown }> };
    expect(Array.isArray(baseline.runIds)).toBe(true);
    expect((baseline.runIds as string[]).length).toBeGreaterThanOrEqual(3);
  });
});
