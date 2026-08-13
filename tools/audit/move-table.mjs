// The task 019 move table — one authority, two consumers.
//
// `move-tree.mjs` uses it to relocate files and rewrite import specifiers;
// `retarget-literals.mjs` uses the same table to reconcile the repo-relative
// path STRINGS that `tsc` cannot see. Keeping one table is the point: a second
// copy would let the two halves of the same move disagree, and the disagreement
// would surface as a config silently matching nothing rather than as an error.
//
// Destinations follow `tools/audit/layer-map.json`: directories it maps to a
// layer land under `src/`, and directories it marks as stated exceptions land
// in the tool tree assigned there rather than riding into the product.

/** [oldRepoRelativePrefix, newRepoRelativePrefix], longest match wins. */
export const PREFIX_MOVES = [
  // The old root `src/` was the installer and renderer toolchain in full —
  // operations/, wizard/, manifest/, config/ and runtimes/ included. It becomes
  // the `install` peer named in the layer map, which is also what dissolves the
  // config/ and runtimes/ name clashes with the incoming core.
  ['src/', 'src/install/'],

  // Stated exceptions: first-party tooling, not product code.
  ['servers/exarchos-mcp/src/bench/', 'tools/evals/bench/'],
  ['servers/exarchos-mcp/src/benchmarks/', 'tools/evals/benchmarks/'],
  ['servers/exarchos-mcp/src/evals/', 'tools/evals/evals/'],
  ['servers/exarchos-mcp/src/ctk/', 'tools/conformance/src/ctk/'],
  ['servers/exarchos-mcp/src/parity/', 'tools/conformance/src/parity/'],
  ['servers/exarchos-mcp/src/test-helpers/', 'tools/test-helpers/'],

  // L9 — runtime.
  ['servers/exarchos-mcp/src/agents/', 'src/runtime/agents/'],
  ['servers/exarchos-mcp/src/capabilities/', 'src/runtime/capabilities/'],
  ['servers/exarchos-mcp/src/channel/', 'src/runtime/channel/'],
  ['servers/exarchos-mcp/src/extensions/', 'src/runtime/extensions/'],
  ['servers/exarchos-mcp/src/launcher/', 'src/runtime/launcher/'],
  ['servers/exarchos-mcp/src/lib/', 'src/runtime/lib/'],
  ['servers/exarchos-mcp/src/workspace/', 'src/runtime/workspace/'],
  ['servers/exarchos-mcp/src/runtimes/', 'src/runtime/runtimes/'],
  ['servers/exarchos-mcp/src/runtime/', 'src/runtime/'],

  // The `install` peer, joined by the incoming installer toolchain above.
  ['servers/exarchos-mcp/src/onramp/', 'src/install/onramp/'],
  ['servers/exarchos-mcp/src/release/', 'src/install/release/'],
  ['servers/exarchos-mcp/src/install/', 'src/install/'],

  // Everything else in the core keeps its name one level up.
  ['servers/exarchos-mcp/src/', 'src/'],

  // The core's own test and guard tiers, kept as named tiers rather than merged
  // into the root ones — `process/` exists on both sides.
  ['servers/exarchos-mcp/test/', 'test/core/'],
  ['servers/exarchos-mcp/tests/', 'tests/core/'],
  ['servers/exarchos-mcp/scripts/', 'scripts/core/'],
  // Both trees carry an `unknown-unknown.trace.jsonl`; a shared directory would
  // silently drop one of them.
  ['servers/exarchos-mcp/evals/captured/', 'evals/captured/core/'],
  ['servers/exarchos-mcp/evals-pkg/', 'tools/evals-pkg/'],
];

/**
 * The dissolved package's own manifest and config files. These are not prefix
 * moves — each merged into the root file of the same name — so a literal naming
 * one now means the root one.
 */
export const FILE_ALIASES = [
  ['servers/exarchos-mcp/package-lock.json', 'package-lock.json'],
  // Catch-all, deliberately LAST by length so every specific prefix above wins:
  // the dissolved package's own root is now the repo root. Without this, a path
  // that walked up to the package root (`resolve(HERE, '..', '..')`) would keep
  // naming a directory that no longer exists.
  ['servers/exarchos-mcp/', ''],
  ['servers/exarchos-mcp', ''],
  ['servers/exarchos-mcp/package.json', 'package.json'],
  ['servers/exarchos-mcp/vitest.config.ts', 'vitest.config.ts'],
  ['servers/exarchos-mcp/tsconfig.scripts.json', 'tsconfig.scripts.json'],
  ['servers/exarchos-mcp/tsconfig.json', 'tsconfig.json'],
  ['servers/exarchos-mcp/stryker.conf.mjs', 'stryker.conf.mjs'],
  ['servers/exarchos-mcp/bunfig.toml', 'bunfig.toml'],
  ['servers/exarchos-mcp/bun.lock', 'bun.lock'],
];

const SORTED = [...PREFIX_MOVES].sort((a, b) => b[0].length - a[0].length);

/** Map a repo-relative path through the table. Unmoved paths return unchanged. */
export function mapRel(rel) {
  for (const [from, to] of SORTED) if (rel.startsWith(from)) return to + rel.slice(from.length);
  return rel;
}

/**
 * Map a repo-relative path STRING, including the dissolved package's own files.
 * Ordered longest-first across both tables so `…/package.json` never matches a
 * shorter directory prefix first.
 */
const LITERAL_SORTED = [...FILE_ALIASES, ...PREFIX_MOVES].sort((a, b) => b[0].length - a[0].length);

export function mapLiteral(rel) {
  for (const [from, to] of LITERAL_SORTED) if (rel.startsWith(from)) return to + rel.slice(from.length);
  return rel;
}
