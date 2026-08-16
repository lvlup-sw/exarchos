import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Repository root — `<repo>/tools/audit/gates/guard-inventory` → `<repo>`.
 *
 * Four hops, not three. A hop count is the fragile way to find a root: get it
 * wrong and it still resolves to a REAL directory (here, `tools/`), so every
 * scan below would run against a tree that contains none of the artifacts and
 * report a clean inventory of nothing. The assertion under it is what makes
 * a miscount fail loudly instead.
 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

// The miscount check, run at import. `package.json` alone is not enough — the
// walk could land on any package — so the root is confirmed by NAME.
const ROOT_MANIFEST = resolve(REPO_ROOT, 'package.json');
if (
  !existsSync(ROOT_MANIFEST) ||
  !(JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8')) as { name?: string }).name?.endsWith('/exarchos')
) {
  throw new Error(
    `guard-inventory: REPO_ROOT resolved to ${REPO_ROOT}, which is not the repository root. ` +
      'The hop count above is wrong for this module\'s depth — every scan would run against ' +
      'the wrong tree and report an inventory of nothing.',
  );
}

/** The spec whose Wave-1 task set is channel 2's denominator. */
export const SPEC_PATH = 'docs/specs/2026-08-06-internal-mechanics-overhaul.md';
/**
 * In-repo stand-in when the planning corpus is unmounted. Channel 2 reads a
 * frozen dated record; this is that record after the docs exodus, and
 * historical path rewrites map its `**Files:**` lists onto the current tree.
 * Distinct from the rev-3 kill fixture used by the measured-premises self-test.
 */
export const SPEC_FALLBACK = 'tools/audit/test-fixtures/measured-premises/internal-mechanics-overhaul.md';
/** The enforcer-wiring manifest — channel 1's denominator. */
export const MANIFEST_PATH = 'tools/audit/gates/enforcer-wiring-manifest.json';
/** Channel 3's scan root. */
export const MCP_SCRIPTS_DIR = 'tools/audit/core';
/**
 * Channel 4's scan roots — the directories that ARE the conformance suite.
 *
 * The single place a relocation of the suite is absorbed. Every root is required
 * to exist and to yield at least one guard ({@link scanGuardSuiteRoots}), so
 * retargeting this list wrongly reddens the build instead of quietly shrinking
 * the inventory — which is the whole failure mode channel 4 exists to prevent.
 */
export const GUARD_SUITE_ROOTS: readonly string[] = Object.freeze([
  'tools/conformance/src',
  // The 18 modules task 018a left behind: the invariants-catalog subsystem and
  // the shared utilities production imports. Still self-tested censuses, so
  // still guards — they just are not extractable without inverting the
  // dependency direction between `src/` and `tools/`. The MODULES stayed here
  // when task 030 lifted their suites into the `tests/unit/` mirror, which is
  // why the root still names `src/` — `selfTestCandidates` follows the move.
  'src/architecture',
  // Task 019 moved the agent-dispatch censuses here from `agents/`. Their only
  // other channel is the FROZEN spec's `**Files:**` list, which still cites the
  // dissolved package and therefore resolves to nothing — the precise case
  // channel 4 exists to answer from the tree instead of by editing a dated
  // record.
  'src/runtime/agents',
]);

/**
 * Prefix rewrites from the dissolved `servers/exarchos-mcp` package onto the
 * post-fold tree, longest-first so a specific subtree wins over the catch-all.
 *
 * Frozen specs cite the paths that existed when they were written. Rewriting
 * the SPEC would falsify a dated record; rewriting the lookup keeps the record
 * honest and the inventory current. Every target is asserted to exist by
 * `GuardInventory_HistoricalPathRewrites_AllResolve`, so a rewrite that stops
 * pointing at anything fails loudly instead of quietly resolving nothing.
 */
export const HISTORICAL_PATH_REWRITES: readonly (readonly [string, string])[] = Object.freeze([
  ['servers/exarchos-mcp/src/agents/', 'src/runtime/agents/'],
  ['servers/exarchos-mcp/src/launcher/', 'src/runtime/launcher/'],
  ['servers/exarchos-mcp/src/workspace/', 'src/runtime/workspace/'],
  ['servers/exarchos-mcp/src/capabilities/', 'src/workflow/capabilities/'],
  ['servers/exarchos-mcp/src/channel/', 'src/adapters/channel/'],
  ['servers/exarchos-mcp/src/test-helpers/', 'tools/test-helpers/'],
  ['servers/exarchos-mcp/src/evals/', 'tools/evals/'],
  ['servers/exarchos-mcp/scripts/', 'tools/audit/core/'],
  ['servers/exarchos-mcp/test/', 'tests/core/'],
  ['servers/exarchos-mcp/src/', 'src/'],
  ['servers/exarchos-mcp/', ''],
  // Task 036 dissolved the top-level `scripts/` tree into `tools/`. The
  // subdirectories map one-to-one; the flat files did not — 40 gates went to
  // `tools/audit/gates/` and 15 build/publish scripts to `tools/release/`,
  // which no single prefix can express. Both are declared against the same
  // `scripts/` prefix and `resolveHistoricalPath` takes the first that EXISTS,
  // so the tree itself disambiguates rather than a restated file list that
  // would drift. Sort is stable, so the order below is the probe order.
  ['scripts/core/', 'tools/audit/core/'],
  ['scripts/lib/', 'tools/audit/lib/'],
  ['scripts/audit/', 'tools/audit/'],
  ['scripts/__fixtures__/', 'tools/audit/__fixtures__/'],
  ['scripts/__shims__/', 'tools/audit/__shims__/'],
  ['scripts/test-fixtures/', 'tools/audit/test-fixtures/'],
  ['scripts/tsconfig-strictness/', 'tools/audit/tsconfig-strictness/'],
  ['scripts/', 'tools/audit/gates/'],
  ['scripts/', 'tools/release/'],
] as const);

const REWRITES_LONGEST_FIRST = [...HISTORICAL_PATH_REWRITES].sort((a, b) => b[0].length - a[0].length);

/**
 * Resolve a spec-declared path against the current tree, trying the path as
 * written first so a still-valid citation is never rewritten. Returns the
 * original when nothing resolves, so the caller still records it as unresolved.
 */
export function resolveHistoricalPath(file: string, exists: (p: string) => boolean): string {
  if (exists(file)) return file;
  for (const [from, to] of REWRITES_LONGEST_FIRST) {
    if (!file.startsWith(from)) continue;
    const candidate = to + file.slice(from.length);
    if (exists(candidate)) return candidate;
  }
  return file;
}
/** The aggregator that decides which `ci.yml` job can fail a PR. */
