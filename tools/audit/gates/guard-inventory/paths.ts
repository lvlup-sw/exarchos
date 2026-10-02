import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Repository root, four directories above this module. A wrong hop count still
 * resolves to a real directory, so the check below makes a miscount fail at import.
 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * The root `package.json`. The import-time check reads its package name, because any
 * package has a `package.json`.
 */
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

/** The spec that channel 2 reads. Its `wave1Tasks` are the denominator of channel 2. */
export const SPEC_PATH = 'docs/specs/2026-08-06-internal-mechanics-overhaul.md';
/**
 * The in-repo copy of the spec, read when the planning corpus is not mounted.
 * `HISTORICAL_PATH_REWRITES` maps its `**Files:**` lists onto the current tree.
 * It is not the kill fixture of the measured-premises self-test.
 */
export const SPEC_FALLBACK = 'tools/audit/test-fixtures/measured-premises/internal-mechanics-overhaul.md';
/** The enforcer-wiring manifest, the denominator of channel 1. */
export const MANIFEST_PATH = 'tools/audit/gates/enforcer-wiring-manifest.json';
/** The scan root of channel 3. */
export const MCP_SCRIPTS_DIR = 'tools/audit/core';
/**
 * The scan roots of channel 4: the directories that hold the conformance suite.
 * Each root must exist and yield at least one guard ({@link scanGuardSuiteRoots}).
 * A wrong entry then fails the build and does not silently shrink the inventory.
 */
export const GUARD_SUITE_ROOTS: readonly string[] = Object.freeze([
  'tools/conformance/src',
  /**
   * The invariants-catalog subsystem and the shared utilities that production imports.
   * They are self-tested censuses, so they count as guards. A move to `tools/` inverts
   * the dependency direction. Their tests are in the `tests/unit/` mirror, which
   * `selfTestCandidates` follows.
   */
  'src/architecture',
  /**
   * The agent-dispatch censuses. Channel 4 finds them from the tree, so a spec path
   * that stops resolving does not hide them.
   */
  'src/runtime/agents',
]);

/**
 * Prefix rewrites from old paths onto the current tree, tried longest prefix first.
 * A frozen spec cites the paths of its date, so the lookup changes and the spec does not.
 * `GuardInventory_HistoricalPathRewrites_AllResolve` checks that each target exists.
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
  ['scripts/core/', 'tools/audit/core/'],
  ['scripts/lib/', 'tools/audit/lib/'],
  ['scripts/audit/', 'tools/audit/'],
  ['scripts/__fixtures__/', 'tools/audit/__fixtures__/'],
  ['scripts/__shims__/', 'tools/audit/__shims__/'],
  ['scripts/test-fixtures/', 'tools/audit/test-fixtures/'],
  ['scripts/tsconfig-strictness/', 'tools/audit/tsconfig-strictness/'],
  /**
   * The flat files under `scripts/` are in `tools/audit/gates/` or `tools/release/`. The
   * stable sort keeps this order, and `resolveHistoricalPath` returns the first that exists.
   */
  ['scripts/', 'tools/audit/gates/'],
  ['scripts/', 'tools/release/'],
] as const);

const REWRITES_LONGEST_FIRST = [...HISTORICAL_PATH_REWRITES].sort((a, b) => b[0].length - a[0].length);

/**
 * Resolves a path that the spec cites against the current tree. It tries the path
 * as written first. When nothing exists, it returns the original as unresolved.
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
