/**
 * MCP SDK generation seam (DR-0).
 *
 * Two generations of the MCP SDK are installed side by side:
 *
 *   • v1 — `@modelcontextprotocol/sdk` (and every `…/sdk/*` subpath)
 *   • v2 — `@modelcontextprotocol/core`, `…/server`, `…/client`
 *
 * They ship under DIFFERENT package names, so npm keeps both resolvable and
 * the source tree migrates directory by directory. The hazard that creates is
 * a module that draws protocol values from BOTH generations at once — most
 * sharply an `InMemoryTransport`-style "linked pair" whose halves come from
 * different packages. Such a pair is not actually linked: each half talks to
 * its own sibling, so the two peers exchange nothing and the failure looks
 * like a hang or an empty result rather than an error.
 *
 * WHY THIS LINT EXISTS — measured, not assumed. The DR-0 plan asserted that a
 * partially-migrated tree "must fail typecheck rather than resolve two copies
 * of the protocol types". That is **empirically false** for TypeScript. Both
 * generations declare a structural `Transport` interface, and v1's shape is
 * assignable to v2's, so `tsc --strict` accepts every mixing direction:
 *
 *     v1 transport → v2 `server.connect(...)`     — no error
 *     v2 transport → v1 `server.connect(...)`     — no error
 *     v1 half + v2 half of a "linked pair"        — no error
 *
 * (Reproduced against `@modelcontextprotocol/sdk@1.29.0` +
 * `@modelcontextprotocol/{core,server}@2.0.0` under the package's own strict
 * NodeNext settings.) Structural typing is doing exactly what it is specified
 * to do; nominal package identity is simply not part of TypeScript's model.
 *
 * So the compile-time rejection the migration needs has to be *built*, not
 * discovered. This lint is that gate: it fails a module that imports both
 * generations, which is the mechanical precondition for constructing a
 * cross-generation pair in the first place.
 */
import type { PluginFinding } from '../review/check-catalog.js';

/** Which SDK generation an import specifier belongs to. */
export type SdkGeneration = 'v1' | 'v2';

/** The v1 package root. Every `@modelcontextprotocol/sdk/...` subpath is v1. */
const V1_PACKAGE = '@modelcontextprotocol/sdk';

/** The v2 package roots. Each may carry subpaths (e.g. `/server/stdio`). */
const V2_PACKAGES: readonly string[] = [
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/client',
];

/**
 * Matches the module specifier of a static import/export or a dynamic
 * `import(...)`. Captures the specifier from whichever quote style is used.
 */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** True when `specifier` is exactly `pkg` or one of its subpaths. */
function isPackageOrSubpath(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * Classify a module specifier into its SDK generation, or `undefined` when it
 * is not an MCP SDK import at all.
 *
 * Note the ordering: the v2 names are checked first because none of them is a
 * prefix of the v1 name, and `@modelcontextprotocol/sdk` must not swallow a
 * hypothetical future `@modelcontextprotocol/sdk-*` package.
 */
export function classifySdkImport(specifier: string): SdkGeneration | undefined {
  for (const pkg of V2_PACKAGES) {
    if (isPackageOrSubpath(specifier, pkg)) return 'v2';
  }
  if (isPackageOrSubpath(specifier, V1_PACKAGE)) return 'v1';
  return undefined;
}

/** Every MCP SDK specifier in `source`, in source order, with its generation. */
export function collectSdkImports(
  source: string,
): { specifier: string; generation: SdkGeneration; line: number }[] {
  const out: { specifier: string; generation: SdkGeneration; line: number }[] = [];
  // Reset the shared regex's lastIndex — it carries the /g flag.
  SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPECIFIER_RE.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const generation = classifySdkImport(specifier);
    if (generation === undefined) continue;
    // Line number of the match start (1-based).
    const line = source.slice(0, match.index).split('\n').length;
    out.push({ specifier, generation, line });
  }
  return out;
}

/**
 * Lint one module for cross-generation MCP SDK imports.
 *
 * @param filePath Path reported on the finding.
 * @param source   Module source text.
 * @returns A single HIGH finding when the module imports from BOTH the v1 and
 *   v2 SDK generations; an empty array otherwise. Importing exclusively from
 *   one generation is always allowed — that is what "migrate directory by
 *   directory" means.
 */
export function lintSdkGenerationMixing(
  filePath: string,
  source: string,
): PluginFinding[] {
  const imports = collectSdkImports(source);
  const v1 = imports.filter((i) => i.generation === 'v1');
  const v2 = imports.filter((i) => i.generation === 'v2');
  if (v1.length === 0 || v2.length === 0) return [];

  const firstV2 = v2[0];
  return [
    {
      source: 'sdk-generation-seam',
      severity: 'HIGH',
      file: filePath,
      // Report at the first v2 import: in a directory-by-directory migration
      // the v2 line is the edit under review, and the v1 lines are the
      // leftovers it must have replaced.
      line: firstV2 === undefined ? 1 : firstV2.line,
      message:
        `Module imports BOTH MCP SDK generations — v1 (` +
        `${[...new Set(v1.map((i) => i.specifier))].join(', ')}` +
        `) and v2 (` +
        `${[...new Set(v2.map((i) => i.specifier))].join(', ')}` +
        `). TypeScript does NOT reject this: the two Transport interfaces are ` +
        `structurally compatible, so a cross-generation "linked pair" compiles ` +
        `cleanly and then silently exchanges no messages at runtime. Migrate ` +
        `this module to a single generation.`,
    },
  ];
}
