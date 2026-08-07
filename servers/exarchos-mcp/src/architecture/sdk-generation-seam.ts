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
 *
 * ── DR-26: what changed, and what did NOT ───────────────────────────────────
 * DR-26 relocates DR-0's rung-2 criterion onto a subject that can carry it —
 * `src/sdk/seam.ts`, whose handle types carry a generation brand (`src/sdk/
 * brand.ts`). That brand is a TYPE-level guarantee: a handle drawn from one
 * generation cannot be passed where the other is expected.
 *
 * This lint is **retained, not superseded**, because the two instruments answer
 * different questions and neither implies the other:
 *
 *   • the brand decides WHAT MAY BE PASSED TO WHAT — but it cannot see a module
 *     that bypasses the seam, because an unbranded value is admitted by either
 *     brand (deliberately; see `src/sdk/brand.ts` for why the discriminant is
 *     optional);
 *   • this lint decides WHO MAY IMPORT THE SDK — but it cannot see a mixed
 *     *pairing*, because it reads specifiers, not dataflow.
 *
 * The one module DR-26 licenses to hold both generations is the seam itself,
 * which is why {@link lintSdkGenerationMixing} exempts {@link SDK_SEAM_MODULE}
 * and nothing else. Retiring this lint requires measuring that the brand covers
 * every crossing — not believing the migration is complete.
 */
import type { PluginFinding } from '../review/check-catalog.js';
import type { SdkGeneration } from '../sdk/brand.js';

/**
 * Which SDK generation an import specifier belongs to.
 *
 * Re-exported from `src/sdk/brand.js` rather than declared here: the brand and
 * the lint must never disagree about what a generation is, and two independent
 * declarations of the same vocabulary is exactly the one-authority-per-boundary
 * violation this program exists to remove.
 */
export type { SdkGeneration };

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
 * The owned SDK seam (DR-26), as a path relative to the package's `src` root.
 *
 * This is the ONE module licensed to hold both generations at once — that is
 * what "sole importer of either SDK generation" means. Matching is suffix-based
 * on a forward-slashed path so absolute, package-relative and src-relative
 * spellings all resolve, which is the shape the whole-tree sweeps produce.
 */
export const SDK_SEAM_MODULE = 'sdk/seam.ts';

/** Is `filePath` the owned seam module? */
export function isOwnedSeamModule(filePath: string): boolean {
  const normalised = filePath.replaceAll('\\', '/');
  return normalised === SDK_SEAM_MODULE || normalised.endsWith(`/${SDK_SEAM_MODULE}`);
}

/**
 * Lint one module for cross-generation MCP SDK imports.
 *
 * @param filePath Path reported on the finding. Also decides the DR-26 seam
 *   exemption — see {@link SDK_SEAM_MODULE}.
 * @param source   Module source text.
 * @returns A single HIGH finding when the module imports from BOTH the v1 and
 *   v2 SDK generations; an empty array otherwise. Importing exclusively from
 *   one generation is always allowed — that is what "migrate directory by
 *   directory" means. The owned seam is exempt outright: holding both
 *   generations is its entire job, and the brand it applies (`src/sdk/brand.ts`)
 *   is the guarantee this lint cannot provide.
 */
export function lintSdkGenerationMixing(
  filePath: string,
  source: string,
): PluginFinding[] {
  if (isOwnedSeamModule(filePath)) return [];
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

// ════════════════════════════════════════════════════════════════════════════
// DR-26 — the SDK import-site census
// ════════════════════════════════════════════════════════════════════════════
//
// ── What this census is for ─────────────────────────────────────────────────
// DR-26 requires that "a seam check resolving zero SDK import sites FAILS, so a
// moved or renamed module cannot pass as a clean tree". That is a vacuity guard,
// and it is not decoration: the sweeps in this package resolve their subject
// population from the filesystem, so a relocated `src/`, a renamed seam or a
// broken specifier scanner all present the same way — as a clean run over an
// empty set. A guard that reports "0 violations" over 0 subjects has not been
// shown to work.
//
// ── What it deliberately does NOT do ────────────────────────────────────────
// It does NOT fail a module for importing the SDK directly. The tree is full of
// such modules on introduction, and failing them here would make this census
// unshippable before task 053 migrates them. Bypass sites are COUNTED (see
// {@link SdkSeamCensusResult.bypassSiteCount}) so the migration has a
// denominator to drive to zero; the rule that rejects them is task 053's, in
// `layer-boundaries-seam.ts`.
//
// The size of that backlog is deliberately NOT restated here. It is a measured
// premise, it lives annotated in the spec (`sdk-import-sites` /
// `sdk-import-directories`) where `scripts/check-measured-premises.mjs` re-derives
// it, and a number copied into a comment is exactly the unbound representation
// this program exists to remove.
//
// The census is pure — it consumes an already-collected scan rather than
// walking the tree itself — matching `lintSdkGenerationMixing` above and keeping
// filesystem effects with the caller.

/**
 * Every generation the census ranges over.
 *
 * Declaration-site typing rather than `['v1', 'v2'] as const`: an `as` here
 * would spend the wave's remaining cast budget (5 sites total) on a list that
 * the checker can type for free.
 */
const ALL_GENERATIONS: readonly SdkGeneration[] = ['v1', 'v2'];

/** One resolved SDK import, attributed to the module that made it. */
export interface SdkImportSite {
  /** Scan-root-relative (or absolute), forward-slashed module path. */
  readonly module: string;
  /** The raw import specifier. */
  readonly specifier: string;
  /** Which generation the specifier belongs to. */
  readonly generation: SdkGeneration;
  /** 1-based line of the specifier. */
  readonly line: number;
  /** True when the importing module IS the owned seam ({@link SDK_SEAM_MODULE}). */
  readonly throughSeam: boolean;
}

/** Everything the census needs, collected from one whole-tree scan. */
export interface SdkSeamScan {
  /** Every SDK import site found under the scan root. */
  readonly sites: readonly SdkImportSite[];
  /** Whether {@link SDK_SEAM_MODULE} exists under the scan root. */
  readonly seamModulePresent: boolean;
}

export type SdkSeamDiagnostic =
  | {
      readonly code: 'EMPTY_SDK_IMPORT_DENOMINATOR';
      readonly message: string;
    }
  | {
      readonly code: 'SDK_SEAM_MODULE_MISSING';
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'SEAM_IMPORTS_NO_SDK';
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'SEAM_GENERATION_UNCOVERED';
      readonly generation: SdkGeneration;
      readonly message: string;
    };

export interface SdkSeamCensusResult {
  readonly ok: boolean;
  /** Every SDK import site — the denominator. Zero is a failure, never a pass. */
  readonly siteCount: number;
  /** Sites inside the owned seam. */
  readonly seamSiteCount: number;
  /** Sites outside the owned seam — task 053's migration backlog. */
  readonly bypassSiteCount: number;
  readonly diagnostics: readonly SdkSeamDiagnostic[];
}

/**
 * Attribute every SDK import in one module's source to that module.
 *
 * Pure; the seam attribution is decided by {@link isOwnedSeamModule}, so the
 * census and {@link lintSdkGenerationMixing} agree on which module is the seam.
 */
export function collectSdkImportSites(
  module: string,
  source: string,
): SdkImportSite[] {
  const throughSeam = isOwnedSeamModule(module);
  return collectSdkImports(source).map((imported) => ({
    module,
    specifier: imported.specifier,
    generation: imported.generation,
    line: imported.line,
    throughSeam,
  }));
}

/**
 * Verdict over an already-collected scan. Four independent fail-closed teeth,
 * each covering a distinct way this check could quietly become vacuous:
 *
 *   - `EMPTY_SDK_IMPORT_DENOMINATOR` — nothing resolved at all (scan root moved,
 *     or the specifier scanner stopped matching);
 *   - `SDK_SEAM_MODULE_MISSING`      — the seam was moved or renamed, so the
 *     brand covers nothing;
 *   - `SEAM_IMPORTS_NO_SDK`          — the seam file exists but imports no SDK,
 *     so it is a seam in name only;
 *   - `SEAM_GENERATION_UNCOVERED`    — an installed generation no longer reaches
 *     the seam, so half the brand has rotted while still reading as present.
 */
export function runSdkSeamCensus(scan: SdkSeamScan): SdkSeamCensusResult {
  const diagnostics: SdkSeamDiagnostic[] = [];
  const seamSites = scan.sites.filter((site) => site.throughSeam);
  const bypassSites = scan.sites.filter((site) => !site.throughSeam);

  if (scan.sites.length === 0) {
    diagnostics.push({
      code: 'EMPTY_SDK_IMPORT_DENOMINATOR',
      message:
        'The SDK seam census resolved ZERO import sites. Both generations are ' +
        'declared dependencies, so a tree in which nothing imports either one ' +
        'is a broken scan, not a clean tree — the scan root moved, the source ' +
        'was relocated, or the specifier scanner stopped matching. Reported as ' +
        'a failure rather than a pass (DR-26 non-empty denominator).',
    });
  }

  if (!scan.seamModulePresent) {
    diagnostics.push({
      code: 'SDK_SEAM_MODULE_MISSING',
      module: SDK_SEAM_MODULE,
      message:
        `The owned SDK seam "${SDK_SEAM_MODULE}" does not exist under the scan ` +
        `root. Every generation brand is applied there, so without it the ` +
        `rung-2 guarantee covers nothing. Re-point SDK_SEAM_MODULE if the seam ` +
        `moved deliberately.`,
    });
  } else if (seamSites.length === 0) {
    diagnostics.push({
      code: 'SEAM_IMPORTS_NO_SDK',
      module: SDK_SEAM_MODULE,
      message:
        `"${SDK_SEAM_MODULE}" exists but imports no MCP SDK package. A seam ` +
        `that draws from neither generation brands nothing — it is a seam in ` +
        `name only, and every consumer of it is unprotected.`,
    });
  } else {
    for (const generation of ALL_GENERATIONS) {
      if (seamSites.some((site) => site.generation === generation)) continue;
      diagnostics.push({
        code: 'SEAM_GENERATION_UNCOVERED',
        generation,
        message:
          `The owned seam imports nothing from the ${generation} SDK, yet ` +
          `${generation} is still an installed dependency. The ${generation} ` +
          `half of the brand has rotted while the seam still reads as present, ` +
          `so ${generation} handles would cross unbranded. Either restore the ` +
          `${generation} re-exports or remove the dependency.`,
      });
    }
  }

  return {
    ok: diagnostics.length === 0,
    siteCount: scan.sites.length,
    seamSiteCount: seamSites.length,
    bypassSiteCount: bypassSites.length,
    diagnostics,
  };
}
