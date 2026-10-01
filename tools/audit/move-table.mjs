// The move table that dissolves `servers/exarchos-mcp` into the repo root.
//
// `move-tree.mjs` uses it to move files and rewrite import specifiers. The
// `retarget-*.mjs` codemods use it to rewrite the repo-relative path strings
// that `tsc` cannot see. One table keeps the two halves of a move in agreement.
// Two copies can disagree, and then a config silently matches nothing.
//
// Destinations follow `tools/audit/layer-map.json`. A directory that it maps to
// a layer lands under `src/`. A stated exception lands in its tool tree.

/** [oldRepoRelativePrefix, newRepoRelativePrefix], longest match wins. */
export const PREFIX_MOVES = [
  /**
   * Moves the root installer and renderer toolchain to `src/install/`, the
   * `install` peer of the layer map. This removes the `config/` and `runtimes/`
   * name clashes with the core.
   */
  ['src/', 'src/install/'],

  /** Stated exceptions: first-party tooling, not product code. */
  ['servers/exarchos-mcp/src/bench/', 'tools/evals/bench/'],
  ['servers/exarchos-mcp/src/benchmarks/', 'tools/evals/benchmarks/'],
  ['servers/exarchos-mcp/src/evals/', 'tools/evals/evals/'],
  ['servers/exarchos-mcp/src/ctk/', 'tools/conformance/src/ctk/'],
  ['servers/exarchos-mcp/src/parity/', 'tools/conformance/src/parity/'],
  ['servers/exarchos-mcp/src/test-helpers/', 'tools/test-helpers/'],

  /** Layer L9, the runtime. */
  ['servers/exarchos-mcp/src/agents/', 'src/runtime/agents/'],
  ['servers/exarchos-mcp/src/capabilities/', 'src/runtime/capabilities/'],
  ['servers/exarchos-mcp/src/channel/', 'src/runtime/channel/'],
  ['servers/exarchos-mcp/src/extensions/', 'src/runtime/extensions/'],
  ['servers/exarchos-mcp/src/launcher/', 'src/runtime/launcher/'],
  ['servers/exarchos-mcp/src/lib/', 'src/runtime/lib/'],
  ['servers/exarchos-mcp/src/workspace/', 'src/runtime/workspace/'],
  ['servers/exarchos-mcp/src/runtimes/', 'src/runtime/runtimes/'],
  ['servers/exarchos-mcp/src/runtime/', 'src/runtime/'],

  /** The `install` peer, which also receives the root installer toolchain. */
  ['servers/exarchos-mcp/src/onramp/', 'src/install/onramp/'],
  ['servers/exarchos-mcp/src/release/', 'src/install/release/'],
  ['servers/exarchos-mcp/src/install/', 'src/install/'],

  /** The rest of the core keeps its name one level up. */
  ['servers/exarchos-mcp/src/', 'src/'],

  /**
   * The core test and guard tiers stay apart from the root tiers, because both
   * sides hold a `process/` directory.
   */
  ['servers/exarchos-mcp/test/', 'tests/core/'],
  ['servers/exarchos-mcp/tests/', 'tests/core/'],
  ['servers/exarchos-mcp/scripts/', 'scripts/core/'],
  /**
   * Both trees hold an `unknown-unknown.trace.jsonl`. One shared directory
   * silently drops one of them.
   */
  ['servers/exarchos-mcp/evals/captured/', 'evals/captured/core/'],
  ['servers/exarchos-mcp/evals-pkg/', 'tools/evals-pkg/'],
];

/**
 * Files of the dissolved package that merged into the root file of the same
 * name. A literal that names one of them names the root file.
 */
export const FILE_ALIASES = [
  ['servers/exarchos-mcp/package-lock.json', 'package-lock.json'],
];

/**
 * Aliases for path arithmetic only, never for text substitution.
 *
 * As a resolved directory, `servers/exarchos-mcp` is the repo root. A walk into
 * `servers/` also aims at the root, because a too-short walk still lands on a
 * real directory. Applied to a string, the same mapping deletes the text.
 */
export const PATH_ONLY_ALIASES = [
  ['servers/exarchos-mcp/', ''],
  ['servers/exarchos-mcp', ''],
  ['servers/', ''],
  ['servers', ''],
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

/** Both tables, longest prefix first, so a file alias wins over a shorter directory prefix. */
const LITERAL_SORTED = [...FILE_ALIASES, ...PREFIX_MOVES].sort((a, b) => b[0].length - a[0].length);

/** Maps a repo-relative path string, the files of the dissolved package included. */
export function mapLiteral(rel) {
  for (const [from, to] of LITERAL_SORTED) if (rel.startsWith(from)) return to + rel.slice(from.length);
  return rel;
}

/**
 * The literal tables plus {@link PATH_ONLY_ALIASES}, longest prefix first. The
 * codemods use the result for path computation, not as replacement text.
 */
const PATH_SORTED = [...PATH_ONLY_ALIASES, ...FILE_ALIASES, ...PREFIX_MOVES].sort(
  (a, b) => b[0].length - a[0].length,
);

/** Maps a resolved directory path for the codemods that recompute a relative walk. */
export function mapPathTarget(rel) {
  for (const [from, to] of PATH_SORTED) if (rel.startsWith(from)) return to + rel.slice(from.length);
  return rel;
}
