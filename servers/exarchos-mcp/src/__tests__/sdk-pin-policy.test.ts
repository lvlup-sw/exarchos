// ─── #1292 / DR-0 — MCP SDK pin-policy guard ───────────────────────────────
//
// Every `@modelcontextprotocol/*` dependency is intentionally **exact-pinned**
// (no caret/tilde range), so a minor bump is an explicit, reviewed decision
// rather than something `npm install` picks up implicitly. This test guards
// against a future caret/tilde reintroduction on any of them.
//
// ── ONE generation, as of task 049 ──────────────────────────────────────────
//
//   • `@modelcontextprotocol/core`   — v2 protocol types.
//   • `@modelcontextprotocol/server` — v2 server surface.
//   • `@modelcontextprotocol/client` — v2 client surface. Added by task 049:
//     nine test modules and the exp1 eval driver drive the server through a
//     `Client` over an in-memory linked pair, so a v2 server with a v1 client
//     would have been the cross-generation pair `contract/sdk/seam.ts` exists to forbid.
//     Installing it is what let the v1 dependency go entirely.
//
// Re-scope note: the originating issue (#1292) assumed a `^1.0.0` range and
// proposed swapping to `1.26.x`. That premise was already stale — the v1
// dependency was exact at `1.29.0`. This is therefore a pin-policy
// ratification + guard, not a version swap.
//
// ── THE MIGRATION BLOCKER IS DISCHARGED, and this file records how ──────────
// Earlier revisions of this file carried a standing note that v1 could not be
// removed: v2 `2.0.0` deleted the experimental Tasks *store* seam the MCP
// adapter was built on (no `ServerOptions.taskStore`, no counterpart for
// `TaskStore` / `CreateTaskOptions` / `isTerminal`), so `EventSourcedTaskStore`
// had nothing to implement against.
//
// Task 051 designed the replacement: the store contract is now OWNED
// (`projections/task-store/port.ts`), and `projections/task-store/attach.ts` makes the one genuinely
// missing surface — the constructor option, which a v2 server ignores SILENTLY
// — impossible to ship by accident. What the migration deliberately gives up is
// the `tasks/*` wire surface, which v2 does not serve at all; per operator
// decision D10 that loss is accepted and announced (`describeTaskWireGap`),
// never silent.
//
// The old `SdkPinPolicy_V1AndV2_CoexistAsDistinctPackages` expectation said its
// own retirement condition out loud: *"If a future change drops v1, that is only
// legitimate once nothing imports it — at which point this expectation should be
// deleted deliberately, not silently."* This is that deliberate deletion. It is
// replaced by `SdkPinPolicy_V1Generation_IsFullyRemoved`, which asserts the
// stronger property the old test was waiting for, and asserts it over the SOURCE
// TREE rather than over `package.json` alone — an uninstalled package that some
// module still names is a broken build, not a completed migration.

/**
 * DR-30 authorities. `SdkPinPolicy_V1Generation_IsFullyRemoved` sweeps the
 * source corpus, so its verdict rests on two sources neither of which is
 * derived from the other:
 *
 *   • the MANIFESTS — the DECLARED dependency set (what npm was asked to
 *     install). Both this package's and the monorepo root's, across every
 *     dependency map, because npm hoisting makes a root declaration reachable
 *     from here.
 *   • the PACKAGE tree itself, parsed — the IMPORTED set (what the code
 *     actually names).
 *
 * The disagreement worth catching is exactly the one DR-0's removal criterion
 * names: a package removed from the manifest while a module still imports it,
 * or still declared while nothing does. A manifest cannot compute the tree and
 * the tree cannot compute the manifest, so they can genuinely disagree.
 *
 * ── SCOPE CORRECTION (post-049) ─────────────────────────────────────────────
 * Both authorities were originally read too narrowly, and the two narrowings
 * lined up to hide one real survivor. The tree side started at `src/`, so
 * `test/process/_helpers.ts` — a v1 `Client` driving the compiled binary over
 * stdio, imported by five live suites — was never looked at. The manifest side
 * read only `dependencies`, so the root's `devDependencies` entry that kept v1
 * installed and hoisted was never looked at either. Each half reported a
 * package-wide verdict it had not measured. Both are now read at their full
 * extent, and the anti-vacuity teeth below fail specifically on a regression
 * back to either narrowing.
 *
 * @oracle-sources: ../../package.json, ../test-helpers/module-specifier-parser.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseModuleSpecifiers } from '../test-helpers/module-specifier-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → servers/exarchos-mcp
const packageRoot = join(here, '..', '..');
const packageJsonPath = join(packageRoot, 'package.json');
// servers/exarchos-mcp → the monorepo root.
const repoRoot = join(packageRoot, '..', '..');
const repoPackageJsonPath = join(repoRoot, 'package.json');

/** The v2 packages. DR-0's migration landed on these three and only these. */
const V2_PACKAGES = [
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/client',
] as const;

/** The retired v1 package root. Every `…/sdk/*` subpath belongs to it too. */
const V1_PACKAGE = '@modelcontextprotocol/sdk';

/** Exact version (`2.0.0`) or minor-x (`2.0.x`) — no range operators. */
const EXACT_PIN = /^\d+\.\d+\.(\d+|x)$/;

function readDependencies(): Record<string, string> {
  const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null) {
    throw new Error('package.json did not parse to an object');
  }
  const deps = (pkg as { dependencies?: unknown }).dependencies;
  if (typeof deps !== 'object' || deps === null) {
    throw new Error('package.json has no dependencies object');
  }
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === 'string') out[name] = range;
  }
  return out;
}

/**
 * Every declared dependency of a manifest, across EVERY dependency map.
 *
 * Deliberately not just `dependencies`. The root manifest declared v1 under
 * `devDependencies`, and a check that read only `dependencies` would have
 * reported the removal complete while npm went on installing v1 and hoisting
 * it — a guard passing because it looked in the wrong drawer. npm installs
 * from all of these maps, so all of them are checked; the map names come from
 * npm's schema rather than from what this repo happens to use today.
 */
function readAllDeclaredDeps(manifestPath: string): Record<string, string> {
  const pkg: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null) {
    throw new Error(`${manifestPath} did not parse to an object`);
  }
  const maps = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const;
  const out: Record<string, string> = {};
  let mapsSeen = 0;
  for (const key of maps) {
    const map = (pkg as Record<string, unknown>)[key];
    if (typeof map !== 'object' || map === null) continue;
    mapsSeen += 1;
    for (const [name, range] of Object.entries(map)) {
      if (typeof range === 'string') out[name] = range;
    }
  }
  // ANTI-VACUITY: a manifest whose every dependency map is absent or renamed
  // would yield an empty record, and "v1 is not in here" would be true of an
  // empty record for the wrong reason.
  if (mapsSeen === 0) {
    throw new Error(`${manifestPath} declared no dependency maps at all`);
  }
  return out;
}

function expectExactPin(name: string, range: string): void {
  expect(range, `${name} must be exact-pinned, got "${range}"`).toMatch(EXACT_PIN);
  // Explicitly NOT a caret or tilde range — the whole point of the policy.
  expect(range.startsWith('^'), `${name} must not use a caret range`).toBe(false);
  expect(range.startsWith('~'), `${name} must not use a tilde range`).toBe(false);
}

/**
 * Every `.ts` module in the PACKAGE, paired with the package specifiers it imports.
 *
 * The population is DERIVED from the filesystem rather than enumerated, so a
 * relocated tree surfaces as an empty denominator (caught below) instead of a
 * clean pass. Specifiers come from a real parse, not a text match, so a v1
 * package name appearing inside a fixture STRING — which several architecture
 * tests carry on purpose, as the subject of their own kill fixtures — is
 * correctly not counted as an import.
 *
 * ── WHY THE ROOT IS THE PACKAGE, NOT `src/` ──────────────────────────────────
 * This walk originally started at `src/`, and that is exactly how task 049
 * shipped believing the migration was complete: `test/process/_helpers.ts`
 * drove the compiled binary with a v1 `Client` over stdio, five `test/process`
 * suites imported it, vitest ran all of them, and this guard could not see the
 * file because it was one directory to the side. The criterion was measured
 * over a subtree while being reported over the tree.
 *
 * A named subtree is a list, and a list is a thing that goes stale silently.
 * Walking the package root removes the list: any `.ts` anywhere in the package
 * is in scope by construction, so a new tree cannot be born outside the guard.
 * `node_modules`/`dist` are skipped because they are vendored and generated —
 * the only two exclusions, and both are properties of the directory rather
 * than names anyone has to remember to add.
 */
function importSitesInPackage(): {
  moduleCount: number;
  modulesOutsideSrc: number;
  v1Sites: string[];
} {
  const v1Sites: string[] = [];
  let moduleCount = 0;
  let modulesOutsideSrc = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        // Hidden directories are scratch or configuration, never published
        // source. This is not cosmetic: `sdk-generation-seam.test.ts` writes a
        // REAL v1-importing fixture to `mkdtempSync(packageRoot + '/.tmp-sdk-seam-')`
        // as the subject of its own kill probe, and vitest runs that file
        // concurrently with this one. Without this skip the two suites race and
        // this guard fails on another test's deliberate fixture — a flake that
        // would read as a v1 regression. Skipping by the dot PROPERTY rather
        // than by scratch-directory name keeps it from becoming another list.
        if (entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      moduleCount += 1;
      const module = relative(packageRoot, full).split(sep).join('/');
      if (!module.startsWith('src/')) modulesOutsideSrc += 1;
      for (const parsed of parseModuleSpecifiers(readFileSync(full, 'utf8'), full)) {
        const { specifier } = parsed;
        if (specifier === V1_PACKAGE || specifier.startsWith(`${V1_PACKAGE}/`)) {
          v1Sites.push(`${module}:${parsed.line} → ${specifier}`);
        }
      }
    }
  };

  walk(packageRoot);
  return { moduleCount, modulesOutsideSrc, v1Sites };
}

describe('MCP SDK pin policy (#1292, DR-0)', () => {
  it('SdkPinPolicy_V2Packages_AreExactPinned', () => {
    const deps = readDependencies();

    for (const name of V2_PACKAGES) {
      expect(deps[name], `${name} must be a declared dependency (DR-0)`).toBeTypeOf(
        'string',
      );
    }

    // Each must carry the exact-pin policy. The rationale is deliberate opt-in
    // to surface changes: v2 is a new major whose surface is still settling, so
    // an implicit `npm install` bump is exactly what the policy exists to
    // prevent.
    for (const name of V2_PACKAGES) {
      expectExactPin(name, deps[name]!);
    }

    // All three are ONE generation and must move together. A tree holding
    // `core@2.0.0` against `server@2.1.0` is the split-brain the single-seam
    // design assumes away, and it would present as a structural type mismatch
    // with no package identity to explain it.
    const versions = new Set(V2_PACKAGES.map((name) => deps[name]!));
    expect(
      [...versions],
      'The v2 packages must be pinned to ONE version — they are a single ' +
        'generation and the seam draws handles across all three.',
    ).toHaveLength(1);
  });

  it('SdkPinPolicy_V1Generation_IsFullyRemoved', () => {
    // ── DR-0's REMOVAL CRITERION, made executable ────────────────────────────
    // The acceptance criterion was stated as a shell command: *"the v1
    // dependency is removed only when nothing imports it (`grep -rn
    // "@modelcontextprotocol/sdk"` returns zero non-vendor hits)"*. A criterion
    // that only ever ran in someone's terminal is a criterion that regresses
    // silently, so it lives here instead.
    expect(
      readAllDeclaredDeps(packageJsonPath)[V1_PACKAGE],
      `${V1_PACKAGE} (v1) was removed by task 049. Re-declaring it re-opens the ` +
        `two-generation hazard the seam's brand exists to police — if that is ` +
        `genuinely wanted, it is a DR-0 decision to reverse, not a dependency ` +
        `to add back.`,
    ).toBeUndefined();

    // A v1 declaration at the MONOREPO ROOT is not a separate concern: npm
    // hoists it into a `node_modules/` above this package, so a root
    // declaration silently satisfies a v1 import here even with the package
    // manifest clean. That is precisely the state task 049 shipped — the
    // package manifest had dropped v1, the root manifest still carried it in
    // `devDependencies`, and `test/process/_helpers.ts` resolved through the
    // hoist. Reachability is the property under test and both manifests
    // determine it, so both are checked.
    expect(
      readAllDeclaredDeps(repoPackageJsonPath)[V1_PACKAGE],
      `${V1_PACKAGE} (v1) is still declared at the MONOREPO ROOT. npm hoists it ` +
        `into a \`node_modules/\` this package resolves through, so a v1 import ` +
        `here would resolve and the two-generation hazard stays open — the ` +
        `package-level removal alone does not close it.`,
    ).toBeUndefined();

    const { moduleCount, modulesOutsideSrc, v1Sites } = importSitesInPackage();

    // ANTI-VACUITY on the population itself. "Zero v1 imports" is worthless if
    // the walk resolved nothing — a relocated src root, a renamed extension or
    // a dead parser would all read as a completed migration.
    expect(
      moduleCount,
      'The source walk resolved implausibly few modules — the scan is broken, ' +
        'so its zero-v1-imports verdict means nothing.',
    ).toBeGreaterThan(50);

    // ANTI-VACUITY aimed at the ACTUAL historical failure. The count above is
    // dominated by `src/`, so a walk narrowed back to `src/` alone still clears
    // it by three orders of magnitude while being blind to the one tree where
    // v1 really survived. This tooth fails on that specific regression: the
    // scan must reach modules OUTSIDE `src/`, or it is not measuring the
    // criterion it reports on.
    expect(
      modulesOutsideSrc,
      'The walk resolved no modules outside `src/`. Task 049 shipped a ' +
        'surviving v1 import in `test/process/` for exactly this reason — a ' +
        'src-only scan reports a package-wide verdict it never measured.',
    ).toBeGreaterThan(0);

    expect(
      v1Sites,
      `These modules still import the retired v1 SDK. The package is no longer ` +
        `installed, so these are broken imports, not merely stale ones — route ` +
        `them through \`contract/sdk/seam.ts\`.`,
    ).toEqual([]);
  });
});
