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
 * `src/contract/sdk/seam.ts`, whose handle types carry a generation brand (`src/contract/sdk/
 * brand.ts`). That brand is a TYPE-level guarantee: a handle drawn from one
 * generation cannot be passed where the other is expected.
 *
 * This lint is **retained, not superseded**, because the two instruments answer
 * different questions and neither implies the other:
 *
 *   • the brand decides WHAT MAY BE PASSED TO WHAT — but it cannot see a module
 *     that bypasses the seam, because an unbranded value is admitted by either
 *     brand (deliberately; see `src/contract/sdk/brand.ts` for why the discriminant is
 *     optional);
 *   • this lint decides WHO MAY IMPORT THE SDK — but it cannot see a mixed
 *     *pairing*, because it reads specifiers, not dataflow.
 *
 * The one module DR-26 licenses to hold both generations is the seam itself,
 * which is why {@link lintSdkGenerationMixing} exempts {@link SDK_SEAM_MODULE}
 * and nothing else. Retiring this lint requires measuring that the brand covers
 * every crossing — not believing the migration is complete.
 *
 * ── Task 062: this module reads specifiers, and now it reads them correctly ──
 * The note above says the lint "reads specifiers, not dataflow". That was true
 * of its intent and false of its implementation: it matched raw text, so a
 * specifier written inside a template literal — the shape every lint fixture in
 * this package uses — read as an import. See {@link SpecifierParser} for the
 * measured consequence (DR-26's migration denominator was floored ten above
 * zero) and for why the parse is a caller-supplied port rather than an import.
 */
import type { PluginFinding } from '../review/check-catalog.js';
import type { SdkGeneration } from '../contract/sdk/brand.js';

/**
 * Which SDK generation an import specifier belongs to.
 *
 * Re-exported from `src/contract/sdk/brand.js` rather than declared here: the brand and
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
 * One module specifier a parser resolved, with the 1-based line of its literal.
 */
export interface ParsedSpecifier {
  readonly specifier: string;
  readonly line: number;
}

/**
 * Resolves every module specifier a source text actually imports or re-exports.
 *
 * ── Why this is a PORT and not an implementation (DR-26, task 062) ───────────
 * Until task 062 this module matched specifiers with
 *
 *     /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
 *
 * against raw source. That regex carries no comment or literal exclusion, so an
 * SDK specifier written inside a template literal counted as an import — and the
 * lint's own fixture file, `sdk-generation-seam.test.ts`, holds TEN of them as
 * test input. They are not imports and can never be migrated, so DR-26's
 * {@link SdkSeamCensusResult.bypassSiteCount} was floored TEN above zero and
 * task 053 would have been handed a migration target it could not reach. A gate
 * that cannot succeed is worse than no gate.
 *
 * The sound answer is to parse, not to strip: a specifier inside a comment, a
 * string or a template literal is not an import NODE, so it is absent by
 * construction rather than by filtering. But the parser is `typescript`, a
 * devDependency, and this module is shipped source — importing it here would
 * make the compiler a runtime dependency of the compiled binary, which the
 * effect ledger correctly rejects (`unvetted-dependency:typescript` is a network
 * occurrence under `architecture/`, a layer owning no network rule; the live
 * census was run against that exact edit and failed).
 *
 * So the parse is INVERTED to the caller, exactly as the filesystem walk already
 * is, and exactly as `architecture/import-cycles.ts` inverts its
 * dependency-cruiser run. This module keeps the POLICY — which specifier belongs
 * to which generation, which module is the seam — and owns no mechanism. The
 * shipped implementation is `test-helpers/module-specifier-parser.ts`, where
 * `typescript` is licensed.
 *
 * The parameter is REQUIRED wherever it appears. A default would have to be
 * either the old regex (the defect, retained) or a throwing stub (a runtime
 * failure where the checker could have spoken), and an optional parser is how a
 * caller silently gets the wrong denominator back.
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

/**
 * Every MCP SDK import in `source`, in source order, with its generation.
 *
 * `parse` resolves what the module actually imports; this function only decides
 * which of those specifiers is an SDK specifier. See {@link SpecifierParser} for
 * why the parse is a required parameter rather than something this module does
 * for itself.
 *
 * @param source   Module source text.
 * @param parse    Specifier resolver — `test-helpers/module-specifier-parser.ts`
 *                 in this package.
 * @param fileName Reported to `parse` for its diagnostics only; it has no effect
 *                 on the result.
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
 * The owned SDK seam (DR-26), as a path relative to the package's `src` root.
 *
 * This is the ONE module licensed to hold both generations at once — that is
 * what "sole importer of either SDK generation" means. Matching is suffix-based
 * on a forward-slashed path so absolute, package-relative and src-relative
 * spellings all resolve, which is the shape the whole-tree sweeps produce.
 */
export const SDK_SEAM_MODULE = 'contract/sdk/seam.ts';

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
 * @param parse    Specifier resolver — see {@link SpecifierParser}. Required, so
 *   a caller cannot fall back to a text match and re-acquire the template-literal
 *   false positives task 062 removed.
 * @returns A single HIGH finding when the module imports from BOTH the v1 and
 *   v2 SDK generations; an empty array otherwise. Importing exclusively from
 *   one generation is always allowed — that is what "migrate directory by
 *   directory" means. The owned seam is exempt outright: holding both
 *   generations is its entire job, and the brand it applies (`src/contract/sdk/brand.ts`)
 *   is the guarantee this lint cannot provide.
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
// It does NOT fail a module for importing the SDK directly. The tree was full of
// such modules on introduction, and failing them here would have made this
// census unshippable before task 053 migrated them. Bypass sites are COUNTED
// (see {@link SdkSeamCensusResult.bypassSiteCount}) so the migration had a
// denominator to drive to zero; the rule that REJECTS them is `SDK_SEAM_BOUNDARY`
// in `layer-boundaries-seam.ts` (task 053), which now ships with zero exemptions
// because the backlog reached zero. The split is retained rather than collapsed:
// this census's job is to prove the instrument is alive (population, seam
// presence, both generations covered), and folding the rejection into it would
// make "migration complete" and "scanner broken" the same reading again.
//
// The size of that backlog is deliberately NOT restated here. It is a measured
// premise, it lives annotated in the spec (`sdk-import-sites` /
// `sdk-import-directories`) where `scripts/check-measured-premises.mjs` re-derives
// it, and a number copied into a comment is exactly the unbound representation
// this program exists to remove.
//
// The census is pure — it consumes an already-collected scan rather than
// walking the tree itself — matching `lintSdkGenerationMixing` above and keeping
// filesystem effects with the caller. Since task 062 the PARSE is inverted the
// same way and for a sharper reason (see {@link SpecifierParser}): this module
// is shipped source, and the only sound specifier resolver is the TypeScript
// compiler, which is a devDependency the effect ledger will not admit here.

/**
 * Every generation the census ranges over.
 *
 * Declaration-site typing rather than `['v1', 'v2'] as const`: an `as` here
 * would spend the wave's remaining cast budget (5 sites total) on a list that
 * the checker can type for free.
 */
// `ALL_GENERATIONS` was deleted by task 049 rather than left unused. It listed
// the generation VOCABULARY and was read as though it listed what is installed —
// the conflation that made `SEAM_GENERATION_UNCOVERED` fire on a correctly
// migrated tree. Coverage is now driven by `SdkSeamScan.installedGenerations`;
// the vocabulary itself still has exactly one authority, `SdkGeneration` in
// `../sdk/brand.ts`, and is deliberately NOT restated here.

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
   * How many modules the scan actually VISITED — the population, not the hits.
   *
   * Required, never optional or derived. It is the only tooth that can tell
   * "the tree is fully migrated" from "the walk resolved nothing", and those two
   * become indistinguishable in `sites` the moment task 053 finishes: a
   * completed migration legitimately drives {@link
   * SdkSeamCensusResult.bypassSiteCount} to zero, so a low site count stops
   * being evidence of a healthy scan. An optional field defaulting to "unknown"
   * would hand every caller the vacuity back.
   */
  readonly moduleCount: number;
  /**
   * Which generations are actually INSTALLED, read from `package.json`.
   *
   * ── Why this is an input rather than the module's own constant (task 049) ───
   * `SEAM_GENERATION_UNCOVERED` claims *"the seam imports nothing from the {g}
   * SDK, yet {g} is still an installed dependency"* — a statement about the
   * dependency manifest. Until task 049 it was checked against the generation
   * VOCABULARY (`['v1', 'v2']`) instead, which silently assumed every generation
   * the brand can name is also installed. DR-0's migration removed v1 outright,
   * making that assumption false and the diagnostic's own remedy ("or remove the
   * dependency") unreachable: taking it produced the very failure it advised.
   *
   * So the census now reads installation from the caller. Required, never
   * defaulted, for the same reason {@link SdkSeamScan.moduleCount} is: a default
   * of "assume both" restores the bug, and a default of "assume none" makes the
   * coverage arm vacuous. An empty list is itself reported (see
   * `NO_SDK_GENERATION_INSTALLED`) rather than passing quietly.
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
  /**
   * Sites outside the owned seam — task 053's migration backlog.
   *
   * Zero is the SUCCESS state and always has been, but until task 062 it was
   * arithmetically unreachable: `collectSdkImports` matched raw text, so the
   * lint's own fixture file contributed ten specifiers written inside template
   * literals. Those are not imports and cannot be migrated, so no amount of real
   * migration could drive this below ten. Parsing removes the floor; nothing
   * about the census's shape ever imposed one.
   */
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
 * Verdict over an already-collected scan. Independent fail-closed teeth, each
 * covering a distinct way this check could quietly become vacuous (the list is
 * enumerated rather than counted — a written total is one more thing to get
 * wrong when a tooth is added, as task 049 added one):
 *
 *   - `EMPTY_MODULE_POPULATION`     — the walk visited no modules at all, so
 *     every count below it is zero for a reason that has nothing to do with the
 *     tree (scan root moved, renamed package directory, broken walker);
 *   - `EMPTY_SDK_IMPORT_DENOMINATOR` — modules were visited but none imports
 *     either generation, so the specifier parser resolved nothing;
 *   - `SDK_SEAM_MODULE_MISSING`      — the seam was moved or renamed, so the
 *     brand covers nothing;
 *   - `SEAM_IMPORTS_NO_SDK`          — the seam file exists but imports no SDK,
 *     so it is a seam in name only;
 *   - `NO_SDK_GENERATION_INSTALLED`  — the manifest reader resolved no installed
 *     generation at all, which would make the coverage tooth below vacuously
 *     green;
 *   - `SEAM_GENERATION_UNCOVERED`    — an installed generation no longer reaches
 *     the seam, so half the brand has rotted while still reading as present.
 *
 * Note what is deliberately NOT a tooth: a zero {@link
 * SdkSeamCensusResult.bypassSiteCount}. That is the state task 053 is driving
 * toward, and failing on it would make the migration's success indistinguishable
 * from its instrument breaking. The two are separated by the first two teeth
 * instead — a completed migration still visits modules and still resolves the
 * seam's own sites, so the population and the denominator both stay non-empty.
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
    // Fail-closed twin to the empty-denominator teeth above: "no generation is
    // uncovered" is trivially true of an empty installed set, so an empty set
    // must be a failure rather than the strongest-looking pass in the file.
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
