/**
 * The MCP SDK generation lint and the SDK import-site census.
 *
 * The v1 SDK is `@modelcontextprotocol/sdk` and its subpaths. The v2 SDK is
 * `@modelcontextprotocol/core`, `…/server` and `…/client`. The packages have different names, so
 * both can resolve. TypeScript accepts a mix of the two, because both declare a structural
 * `Transport`. A cross-generation linked pair compiles, then exchanges no messages.
 *
 * The lint fails a module that imports both generations. The seam module `contract/sdk/seam.ts` is
 * exempt, because its generation brands stop a handle of one generation in the position of the
 * other. The brand cannot see a module that bypasses the seam, and the lint cannot see a mixed
 * pair, so both checks stay. The module re-exports `SdkGeneration` from the brand, so the brand and
 * the lint agree on what a generation is.
 */
import type { PluginFinding } from '../review/check-catalog.js';
import type { SdkGeneration } from '../contract/sdk/brand.js';

export type { SdkGeneration };

/** The v1 package root. Every `@modelcontextprotocol/sdk/...` subpath is v1. */
const V1_PACKAGE = '@modelcontextprotocol/sdk';

/** The v2 package roots. Each can have subpaths, for example `@modelcontextprotocol/server/stdio`. */
const V2_PACKAGES: readonly string[] = [
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/client',
];

/**
 * One module specifier a parser resolved, with the 1-based line of its literal.
 */
export interface ParsedSpecifier {
  readonly specifier: string;
  readonly line: number;
}

/**
 * Resolves each module specifier that a source text imports or re-exports.
 *
 * A parse, not a text match, keeps out the specifiers in comments, strings and template literals.
 * The parser is the TypeScript compiler, a devDependency, and the effect ledger rejects it in
 * shipped source. Thus the caller supplies the parse, and
 * `tools/test-helpers/module-specifier-parser.ts` is the implementation. The parameter is required
 * wherever it appears, so a caller cannot fall back to a text match.
 */
export type SpecifierParser = (
  source: string,
  fileName?: string,
) => readonly ParsedSpecifier[];

/** True when `specifier` is exactly `pkg` or one of its subpaths. */
function isPackageOrSubpath(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * Returns the SDK generation of a module specifier, or `undefined` for a specifier outside the MCP
 * SDK. A match needs the exact package name or a `/` subpath, so `@modelcontextprotocol/sdk` does
 * not match a `@modelcontextprotocol/sdk-*` package.
 */
export function classifySdkImport(specifier: string): SdkGeneration | undefined {
  for (const pkg of V2_PACKAGES) {
    if (isPackageOrSubpath(specifier, pkg)) return 'v2';
  }
  if (isPackageOrSubpath(specifier, V1_PACKAGE)) return 'v1';
  return undefined;
}

/**
 * Returns each MCP SDK import in `source`, in source order, with its generation. `parse` resolves
 * the imports, and this function selects the SDK specifiers.
 *
 * @param source   The module source text.
 * @param parse    The specifier parser. See {@link SpecifierParser}.
 * @param fileName The name that `parse` uses in its diagnostics. It does not change the result.
 */
export function collectSdkImports(
  source: string,
  parse: SpecifierParser,
  fileName?: string,
): { specifier: string; generation: SdkGeneration; line: number }[] {
  const out: { specifier: string; generation: SdkGeneration; line: number }[] = [];
  for (const parsed of parse(source, fileName)) {
    const generation = classifySdkImport(parsed.specifier);
    if (generation === undefined) continue;
    out.push({ specifier: parsed.specifier, generation, line: parsed.line });
  }
  return out;
}

/**
 * The owned SDK seam, as a path relative to the `src` root. It is the one module that can import
 * both generations. The match is on a forward-slash path suffix, so absolute, package-relative and
 * src-relative paths all match.
 */
export const SDK_SEAM_MODULE = 'contract/sdk/seam.ts';

/** Is `filePath` the owned seam module? */
export function isOwnedSeamModule(filePath: string): boolean {
  const normalised = filePath.replaceAll('\\', '/');
  return normalised === SDK_SEAM_MODULE || normalised.endsWith(`/${SDK_SEAM_MODULE}`);
}

/**
 * Lints one module for MCP SDK imports from both generations.
 *
 * @param filePath The path on the finding. The {@link SDK_SEAM_MODULE} path is exempt.
 * @param source   The module source text.
 * @param parse    The specifier parser. See {@link SpecifierParser}.
 * @returns One HIGH finding when the module imports both v1 and v2, or an empty array. The
 *   finding points at the first v2 import, because in a migration that line is the new edit.
 */
export function lintSdkGenerationMixing(
  filePath: string,
  source: string,
  parse: SpecifierParser,
): PluginFinding[] {
  if (isOwnedSeamModule(filePath)) return [];
  const imports = collectSdkImports(source, parse, filePath);
  const v1 = imports.filter((i) => i.generation === 'v1');
  const v2 = imports.filter((i) => i.generation === 'v2');
  if (v1.length === 0 || v2.length === 0) return [];

  const firstV2 = v2[0];
  return [
    {
      source: 'sdk-generation-seam',
      severity: 'HIGH',
      file: filePath,
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
  /**
   * The number of modules that the scan visited, not the number of hits. It is required, because
   * it tells a fully migrated tree apart from a walk that resolved nothing.
   */
  readonly moduleCount: number;
  /**
   * The generations that `package.json` installs. `SEAM_GENERATION_UNCOVERED` is a claim about
   * the dependency manifest, so the caller supplies this list.
   *
   * It has no default. A default of all generations reports an uninstalled one as uncovered, and
   * a default of none makes the coverage check vacuous. An empty list gives
   * `NO_SDK_GENERATION_INSTALLED`.
   */
  readonly installedGenerations: readonly SdkGeneration[];
}

export type SdkSeamDiagnostic =
  | {
      readonly code: 'EMPTY_MODULE_POPULATION';
      readonly message: string;
    }
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
      readonly code: 'NO_SDK_GENERATION_INSTALLED';
      readonly message: string;
    }
  | {
      readonly code: 'SEAM_GENERATION_UNCOVERED';
      readonly generation: SdkGeneration;
      readonly message: string;
    };

export interface SdkSeamCensusResult {
  readonly ok: boolean;
  /** Modules the scan visited. Zero is a failure, never a pass. */
  readonly moduleCount: number;
  /** Every SDK import site — the denominator. Zero is a failure, never a pass. */
  readonly siteCount: number;
  /** Sites inside the owned seam. */
  readonly seamSiteCount: number;
  /** The sites outside the owned seam. Zero is the success state, not a failure. */
  readonly bypassSiteCount: number;
  readonly diagnostics: readonly SdkSeamDiagnostic[];
}

/**
 * Attributes each SDK import in one module source to that module. {@link isOwnedSeamModule}
 * decides the seam attribution, so the census and {@link lintSdkGenerationMixing} agree.
 */
export function collectSdkImportSites(
  module: string,
  source: string,
  parse: SpecifierParser,
): SdkImportSite[] {
  const throughSeam = isOwnedSeamModule(module);
  return collectSdkImports(source, parse, module).map((imported) => ({
    module,
    specifier: imported.specifier,
    generation: imported.generation,
    line: imported.line,
    throughSeam,
  }));
}

/**
 * Returns the verdict over a collected scan. The census counts the sites outside the seam, but
 * `SDK_SEAM_BOUNDARY` in `layer-boundaries-seam.ts` is the rule that rejects them.
 *
 * - `EMPTY_MODULE_POPULATION`: the walk visited no modules.
 * - `EMPTY_SDK_IMPORT_DENOMINATOR`: no visited module imports an SDK generation.
 * - `SDK_SEAM_MODULE_MISSING`: the seam module does not exist.
 * - `SEAM_IMPORTS_NO_SDK`: the seam imports no SDK package.
 * - `NO_SDK_GENERATION_INSTALLED`: the installed list is empty, so the coverage check is vacuous.
 * - `SEAM_GENERATION_UNCOVERED`: the seam imports nothing from an installed generation.
 */
export function runSdkSeamCensus(scan: SdkSeamScan): SdkSeamCensusResult {
  const diagnostics: SdkSeamDiagnostic[] = [];
  const seamSites = scan.sites.filter((site) => site.throughSeam);
  const bypassSites = scan.sites.filter((site) => !site.throughSeam);

  if (scan.moduleCount <= 0) {
    diagnostics.push({
      code: 'EMPTY_MODULE_POPULATION',
      message:
        'The SDK seam census resolved ZERO modules. Every count it reports is ' +
        'therefore zero for a reason unrelated to the tree — a moved scan root, ' +
        'a renamed package directory or a broken walker all present this way, ' +
        'and all three read as a completed migration. Reported as a failure ' +
        'rather than a pass (DR-26 non-empty denominator).',
    });
  }

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
  } else if (scan.installedGenerations.length === 0) {
    diagnostics.push({
      code: 'NO_SDK_GENERATION_INSTALLED',
      message:
        'The census was handed ZERO installed SDK generations, which makes the ' +
        'coverage arm below vacuously green. A tree with no MCP SDK dependency ' +
        'at all is not a migrated tree — it is an unreadable manifest or a ' +
        'broken reader.',
    });
  } else {
    for (const generation of scan.installedGenerations) {
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
    moduleCount: scan.moduleCount,
    siteCount: scan.sites.length,
    seamSiteCount: seamSites.length,
    bypassSiteCount: bypassSites.length,
    diagnostics,
  };
}
