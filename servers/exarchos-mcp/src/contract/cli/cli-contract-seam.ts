// ─── CLI contract seam: generated CLI client + dispatch-closure census (P03-05) ─
//
// PROGRAM-03, API-005. MCP is the standards-compliant WIRE projection of the
// contract; the CLI is the in-process projection. Both route API-action
// execution through ONE shared contract-handler seam (`dispatch` from
// `core/dispatch.ts`).
//
// ─── DR-25 RESOLUTION: the CLI addresses actions through a generated client ──
//
// The GOVERNING framing of INV-2 is stronger than "both call the same handler":
// the CLI is a GENERATED CLIENT of the contract, equal to the MCP surface BY
// CONSTRUCTION. DR-25 (T-34) first recorded the gap as a governed, expiring
// deviation — `adapters/cli.ts` imported the runtime `dispatch` value and
// hand-assembled `(tool, args)` at six call sites, admitted only by a ledger
// row. That deviation is now RETIRED via DR-25's PRIMARY resolution:
//
//   • `contract/cli/generated-client.ts` is the ONE contract-derived dispatch
//     site on the CLI side. Every api-action call site in `adapters/cli.ts`
//     addresses its action by contract ActionId through
//     `invokeContractAction`, which verifies the id against
//     `generated/cli-action-ids.ts` before dispatching — the module the golden
//     emits from `deriveCliSurface(compileForCli())`, pinned byte-identical to a
//     fresh derivation — so an action the contract does not compile CANNOT be
//     addressed and the "no direct
//     CLI-to-dispatch path" exit criterion holds by construction rather than
//     by ledger cover.
//   • `adapters/cli.ts` no longer imports the runtime `dispatch` value at all
//     (the Commander tree remains hand-authored PRESENTATION — groups, command
//     names, flags — which the classification collector governs).
//   • The deviation MACHINERY below (`ContractDeviation`,
//     `CLI_CONTRACT_DEVIATIONS`, `runDeviationLedgerCensus` and its kill arms)
//     is retained with an EMPTY live ledger: any future direct route to the
//     dispatch core must either become a contract projection or record a new
//     governed, owned, expiring row — silence is not an option.
//
// The census arms that made the old record self-retiring are unchanged: a new
// unacknowledged bypass fails as UNACKNOWLEDGED_INV2_DEVIATION, and a ledger
// row covering nothing fails as STALE_DEVIATION (which is exactly how the
// retired `cli-direct-dispatch` row was forced out when the generated client
// landed).
//
// This module is the seam between the COMPILED contract (P03-03) and the CLI:
//
//   1. GENERATION  — `deriveCliSurface(compiledContract)` projects the compiled
//      descriptors into a deterministic, byte-stable CLI client surface
//      (per-action command path, help, flags, render format, and the stable
//      exit codes each action can produce). The checked-in golden
//      (`generated/cli-surface.json`) + its drift guard mirror the P03-03
//      proof-fixture pattern: running the generator IS the regeneration gesture.
//      Since the DR-25 primary resolution this derivation is GENERATIVE, not
//      only descriptive: `contract/cli/generated-client.ts` verifies every
//      CLI-addressed ActionId against it at dispatch time. The derivation
//      itself lives in `cli-surface.ts` (re-exported here) so that production
//      edge never touches the census half below.
//
//   2. CENSUS      — a THREE-collector, two-way-ratchet structural conformance
//      gate (same shape as `orchestrate/gate-ownership-census.ts`,
//      `architecture/effect-ledger.ts`, `architecture/vcs-ownership.ts`) over
//      the exit criterion "API actions have no direct CLI-to-dispatch path":
//        • DISPATCH-SEAM CONTAINMENT (source scan) — the runtime `dispatch`
//          VALUE is imported only by the authorized projection surface (the MCP
//          wire, plus any module a recorded deviation covers). Any other module
//          reaching the dispatch core directly is a bypass; a declared
//          projection that no longer routes through it is stale cover.
//        • CLI COMMAND CLASSIFICATION (live Commander walk) — every live CLI
//          command classifies as an api-action group, a presentation alias, or
//          a host-local command. Host-local commands legitimately do NOT go
//          through the contract handler; the census RESPECTS that classification
//          rather than flagging it. An unclassified live command is a violation;
//          a declared host-local rule that no longer appears is stale cover.
//        • DEVIATION LEDGER (DR-25) — every direct dispatch path that is NOT a
//          contract projection must be covered by a governed, unexpired ledger
//          row whose acknowledgement the deviating module also exports. An
//          uncovered path, an ungoverned/expired row, a row covering nothing,
//          or a ledger↔site disagreement each fail closed.
//
// The generation half is PURE apart from reading the in-memory registry (via the
// compiler); the file-writing generator only runs when invoked directly, so
// importing this module has no filesystem side effect. The census source scan is
// comment-aware and string-preserving so a `dispatch` mentioned in prose is not
// mistaken for a call.
//
// Named `*-seam.ts` — the established `source-lint-seam` class (sibling of
// `architecture/contract-seam.ts`): a test-invoked gate that runs against
// production SOURCE, never a production import target. The generation half
// (`deriveCliSurface` / `compileForCli`) moved to `cli-surface.ts` (re-exported
// here) precisely so `generated-client.ts` can consume it through a LAZY
// dynamic import without touching this census module — keeping the runtime
// import graph acyclic and the CLI's static cold-start graph free of the
// compiler (DR-5).
//
// Usage (regenerate the golden, from servers/exarchos-mcp):
//   npx tsx src/contract/cli/cli-contract-seam.ts
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { getFullRegistry, type CompositeTool } from '../../registry.js';
import { TIER1_HARNESSES } from '../../launcher/harness-registry.js';
import { generateCliArtifacts } from './cli-surface.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The shipped `src` root (this module lives at `src/contract/cli/`). */
export const DEFAULT_SRC_ROOT = path.resolve(HERE, '..', '..');

// ════════════════════════════════════════════════════════════════════════════
//  SECTION 1 + 2 — Generated CLI client surface + golden generator
// ════════════════════════════════════════════════════════════════════════════
//
// EXTRACTED to `cli-surface.ts` when the DR-25 primary resolution made the
// generation half a production import target of `generated-client.ts`: the
// census half below dynamically imports `adapters/cli.js` (the live Commander
// walk), so keeping both halves in one module would close a runtime import
// cycle adapter → generated client → seam → adapter (the `import-cycles` gate
// counts dynamic imports as runtime edges). Re-exported here so census callers
// and tests keep one import surface.

export {
  deriveFlags,
  deriveCliSurface,
  serializeCliSurface,
  compileForCli,
  serializedCliSurfaceBaseline,
  generateCliArtifacts,
  renderCliActionIdsModule,
  GENERATED_DIR,
  CLI_SURFACE_FILE,
  CLI_ACTION_IDS_FILE,
  type CliFlag,
  type CliExitMapping,
  type CliCommand,
  type CliSurface,
  type GenerateCliResult,
} from './cli-surface.js';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — Structural census (no direct CLI-to-dispatch path)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The shared MCP contract-handler seam. Both projections (CLI + MCP) route
 * API-action execution through the runtime `dispatch` VALUE exported here.
 */
export const DISPATCH_SEAM_MODULE = 'core/dispatch.ts';

/**
 * The projections that meet the GOVERNING INV-2 framing with no deviation:
 *
 *   • `adapters/mcp.ts` — the standards-compliant wire rendering of the
 *     contract handler: the reference surface the CLI is equal to, so its
 *     direct route to the shared handler is the projection itself, not a
 *     bypass of one.
 *   • `contract/cli/generated-client.ts` — the CLI's contract-derived dispatch
 *     seam (DR-25 primary resolution): it verifies every ActionId against
 *     `deriveCliSurface(compileForCli())` before dispatching, so an action the
 *     contract does not compile cannot be addressed from the CLI at all.
 *
 * A module here claims FULL compliance. A module that needs the shared handler
 * but does NOT meet the framing belongs in {@link CLI_CONTRACT_DEVIATIONS}
 * instead — it may not be quietly parked here (`runDeviationLedgerCensus`
 * rejects a module claimed by both).
 */
export const CONTRACT_PROJECTIONS: readonly string[] = Object.freeze([
  'adapters/mcp.ts',
  'contract/cli/generated-client.ts',
]);

// ─── DR-25 (T-34): the governed deviation ledger ────────────────────────────

/** `YYYY-MM-DD`. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ONE recorded, accepted deviation from a governing invariant.
 *
 * Field discipline mirrors the repo's `ADVISORY_REGISTRY` (`src/advisory-registry.ts`):
 * an unowned, undated, un-retirable exception is THEATRE — it launders a known
 * violation into permanent silence. Every field below is required and non-empty,
 * and `runDeviationLedgerCensus` enforces that mechanically.
 */
export interface ContractDeviation {
  /** Stable id, unique across the ledger. */
  readonly id: string;
  /** The deviating module, `src`-relative and forward-slashed. */
  readonly module: string;
  /** The governing invariant deviated from (e.g. `INV-2`). */
  readonly invariant: string;
  /** The deviation shape. Only one exists today; the union documents intent. */
  readonly kind: 'direct-dispatch-path';
  /** Accountable owner — must be non-empty. */
  readonly owner: string;
  /** WHY the deviation is accepted rather than fixed now. Non-empty. */
  readonly rationale: string;
  /** WHAT would close it (the retirement condition). Non-empty. */
  readonly retirement: string;
  /** Tracking ref (design rationale id + the spec that accepted it). Non-empty. */
  readonly tracking: string;
  /** Expiry `YYYY-MM-DD`. A PAST expiry FAILS the census — revisit or re-date. */
  readonly expires: string;
}

/**
 * The accepted-deviation ledger for the governing INV-2 (DR-25). EMPTY since
 * the DR-25 primary resolution landed: the one recorded row
 * (`cli-direct-dispatch`, covering `adapters/cli.ts`, expiry 2027-02-28)
 * self-retired as STALE_DEVIATION when the adapter stopped importing the
 * runtime `dispatch` value and began addressing actions through
 * `contract/cli/generated-client.ts`.
 *
 * The ledger MACHINERY stays live with all census arms armed: any future
 * direct route to the dispatch core must either be a true contract projection
 * ({@link CONTRACT_PROJECTIONS}) or record a new row here carrying an OWNER, a
 * RATIONALE, a RETIREMENT condition, a TRACKING ref and an EXPIRY — an
 * unacknowledged path fails the census closed. `owner` uses the same
 * vocabulary as `ADVISORY_REGISTRY` (`'exarchos'`), which resolves through
 * `.github/CODEOWNERS` (`servers/exarchos-mcp/ @reedsalus`).
 */
export const CLI_CONTRACT_DEVIATIONS: readonly ContractDeviation[] = Object.freeze([]);

/** Modules admitted to the dispatch seam only by a recorded deviation. */
export const DEVIATING_DISPATCH_MODULES: readonly string[] = Object.freeze(
  [...new Set(CLI_CONTRACT_DEVIATIONS.map((d) => d.module))].sort(byString),
);

/**
 * The authorized projection surface — the ONLY modules permitted to import the
 * runtime `dispatch` value. DERIVED (never hand-listed) from the two disjoint
 * sources above, so a module can reach the shared handler in exactly one of two
 * ways: it is a {@link CONTRACT_PROJECTIONS} member (compliant with the
 * governing framing), or it carries a governed row in
 * {@link CLI_CONTRACT_DEVIATIONS} (acknowledged, owned, expiring). Any OTHER
 * importer is a direct-dispatch bypass.
 */
export const AUTHORIZED_DISPATCH_PROJECTIONS: readonly string[] = Object.freeze(
  [...CONTRACT_PROJECTIONS, ...DEVIATING_DISPATCH_MODULES].sort(byString),
);

/**
 * Host-local CLI commands that legitimately do NOT route through the contract
 * handler (no MCP-wire equivalent): version/introspection verbs, the MCP
 * server-mode entry, the renamed-verb stubs, and the CLI-only harness launchers
 * (a stdio MCP surface cannot own a child process's lifecycle). The census
 * RESPECTS this classification rather than flagging these.
 */
export const HOST_LOCAL_COMMANDS: readonly string[] = Object.freeze([
  'version',
  'schema',
  'topology',
  'emissions',
  'mcp',
  'init',
  'install-skills',
  ...TIER1_HARNESSES,
]);

/**
 * Presentation aliases hard-wired in `adapters/cli.ts` — top-level promotions of
 * an API action (e.g. `exarchos doctor` → `exarchos_orchestrate.doctor`). Unlike
 * registry `cli.topLevel` promotions these are not derivable from the registry,
 * so they are declared here; the stale-rule ratchet keeps the list honest.
 */
export const PRESENTATION_ALIASES: readonly string[] = Object.freeze([
  'doctor',
  'feedback',
  'onboard',
  // `merge-orchestrate` was here until task 076 (DR-5). It is now a registry
  // `cli.topLevel` promotion, so it IS derivable and declaring it here would be
  // a STALE_PRESENTATION_ALIAS — this list is only for promotions the registry
  // cannot express. The stale-rule ratchet is what forced the removal.
]);

export type CliCensusDiagnostic =
  | { readonly code: 'UNAUTHORIZED_DISPATCH_SITE'; readonly module: string; readonly message: string }
  | { readonly code: 'STALE_DISPATCH_PROJECTION'; readonly module: string; readonly message: string }
  | { readonly code: 'UNCLASSIFIED_CLI_COMMAND'; readonly command: string; readonly message: string }
  | { readonly code: 'STALE_HOST_LOCAL_RULE'; readonly command: string; readonly message: string }
  | { readonly code: 'STALE_PRESENTATION_ALIAS'; readonly command: string; readonly message: string }
  // ─── DR-25 deviation-ledger arm ───────────────────────────────────────────
  /** A live direct-dispatch path covered by neither a projection nor a ledger row. */
  | { readonly code: 'UNACKNOWLEDGED_INV2_DEVIATION'; readonly module: string; readonly message: string }
  /** A ledger row missing a required governance field (owner/rationale/…/expiry). */
  | {
      readonly code: 'UNGOVERNED_DEVIATION';
      readonly deviation: string;
      readonly field: string;
      readonly message: string;
    }
  /** A ledger row whose expiry has passed — accept again explicitly, or fix it. */
  | { readonly code: 'EXPIRED_DEVIATION'; readonly deviation: string; readonly message: string }
  /** A ledger row covering no live direct-dispatch path — stale cover. */
  | { readonly code: 'STALE_DEVIATION'; readonly deviation: string; readonly message: string }
  /** A module claimed as BOTH fully compliant and deviating. */
  | { readonly code: 'CONFLICTING_DEVIATION'; readonly deviation: string; readonly message: string }
  /** The deviating module's own exported acknowledgement is missing or disagrees. */
  | {
      readonly code: 'DEVIATION_ANNOTATION_MISMATCH';
      readonly deviation: string;
      readonly message: string;
    };

export interface CliCensusResult {
  readonly ok: boolean;
  readonly diagnostics: readonly CliCensusDiagnostic[];
}

// ─── Collector 1: dispatch-seam containment (source scan) ────────────────────

/** A shipped module that imports the runtime `dispatch` value. */
export interface DispatchSite {
  /** Repo-relative to the scan root, forward-slashed. */
  readonly module: string;
}

/**
 * What the census may skip, and why it may skip it.
 *
 * The list this replaced named six directories as "not shipped source". Three of
 * them — `evals`, `benchmarks`, `test-helpers` — are inside `tsconfig.json`'s
 * `include` and outside its `exclude`, so the build compiles them and emits them
 * to `dist/`. They ARE shipped; the census skipped 51 emitted modules on the
 * strength of their folder names, which is precisely the shape DR-8 forbids
 * (roots exclude by PROPERTY, never by naming subtrees).
 *
 * So the boundary is now read from the build itself: whatever `tsconfig.json`
 * keeps out of the emit is not shipped, and everything else is in the census's
 * subject whatever it is called.
 */
export interface EmitBoundary {
  /** Directory names the build excludes wholesale (e.g. `__tests__`). */
  readonly directories: ReadonlySet<string>;
  /** Package-relative path prefixes the build excludes (e.g. a fixture tree). */
  readonly pathPrefixes: readonly string[];
  /** File suffixes the build excludes (e.g. `.test.ts`). */
  readonly suffixes: readonly string[];
}

/**
 * Exclusions that hold for ANY directory tree, with no build to consult: a
 * dependency tree, a build output, and dot-dirs. `.d.ts` joins them because a
 * declaration emits no runtime code at all.
 *
 * This is the floor, not the answer — it is deliberately the WIDEST scan, so a
 * root with no `tsconfig.json` (a synthetic fixture) is over-scanned rather than
 * under-scanned.
 */
const UNIVERSAL_EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist']);
const UNIVERSAL_EXCLUDED_SUFFIXES: readonly string[] = Object.freeze(['.d.ts']);

const UNIVERSAL_EMIT_BOUNDARY: EmitBoundary = Object.freeze({
  directories: UNIVERSAL_EXCLUDED_DIRS,
  pathPrefixes: Object.freeze([]),
  suffixes: UNIVERSAL_EXCLUDED_SUFFIXES,
});

/**
 * Translate a `tsconfig.json` `exclude` entry into the boundary it describes.
 *
 * Three glob shapes cover every entry this package uses, and an entry that fits
 * none of them is IGNORED rather than guessed at — an unrecognised glob must not
 * silently shrink the census's subject, and over-scanning is the safe direction.
 */
export function parseEmitBoundary(excludes: readonly string[]): EmitBoundary {
  const directories = new Set(UNIVERSAL_EXCLUDED_DIRS);
  const pathPrefixes: string[] = [];
  const suffixes = new Set(UNIVERSAL_EXCLUDED_SUFFIXES);
  for (const raw of excludes) {
    const entry = raw.replaceAll('\\', '/');
    const bareDir = /^(?:\*\*\/)?([^*/]+)(?:\/\*\*)?\/?$/.exec(entry);
    const suffixGlob = /^(?:\*\*\/)?\*(\.[^*/]+)$/.exec(entry);
    // Order matters: `**/__tests__/**` is a bare-directory glob that happens to
    // contain slashes, so the path-prefix arm must be the LAST resort.
    if (suffixGlob?.[1] !== undefined) {
      suffixes.add(suffixGlob[1]);
    } else if (bareDir?.[1] !== undefined) {
      directories.add(bareDir[1]);
    } else if (entry.includes('/')) {
      pathPrefixes.push(entry.replace(/\/?\*\*\/?$/, '').replace(/\/$/, ''));
    }
  }
  return Object.freeze({
    directories,
    pathPrefixes: Object.freeze(pathPrefixes),
    suffixes: Object.freeze([...suffixes]),
  });
}

/**
 * The emit boundary declared by the `tsconfig.json` beside `sourceRoot`, or the
 * universal floor when there is no build to ask (a synthetic root).
 *
 * A tsconfig that EXISTS but cannot be parsed throws: silently widening to the
 * floor there would be the census guessing at its own subject.
 */
export function resolveEmitBoundary(sourceRoot: string): EmitBoundary {
  const configPath = path.join(path.dirname(sourceRoot), 'tsconfig.json');
  if (!fs.existsSync(configPath)) return UNIVERSAL_EMIT_BOUNDARY;
  const raw = fs.readFileSync(configPath, 'utf8');
  // `tsconfig.json` permits comments; strip them before JSON.parse.
  // `tsconfig` files are JSONC. The old `^\s*//.*$` regex handled only
  // whole-line comments, so a trailing `// …` or any `/* … */` reached
  // `JSON.parse` and surfaced as a bare SyntaxError naming no file — for a
  // helper whose entire job is deriving the scan boundary FROM this config.
  // `stripComments` (below, and string-preserving) already knows how to do
  // this correctly, so it is used rather than a second, weaker stripper.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripComments(raw));
  } catch (cause) {
    throw new Error(
      `cli-contract-seam: could not parse ${configPath} as JSONC. The dispatch census ` +
        'derives its scan boundary from the build config, so an unreadable config is a ' +
        'boundary it will not guess.',
      { cause },
    );
  }
  const excludes =
    typeof parsed === 'object' && parsed !== null && 'exclude' in parsed
      ? (parsed as { readonly exclude?: unknown }).exclude
      : undefined;
  if (!Array.isArray(excludes)) {
    throw new Error(
      `cli-contract-seam: ${configPath} declares no \`exclude\` array. The dispatch ` +
        'census derives its scan boundary from the build; it will not invent one.',
    );
  }
  return parseEmitBoundary(excludes.filter((e): e is string => typeof e === 'string'));
}

/** True for a file the build compiles into `dist/`. */
function isScannableFile(name: string, boundary: EmitBoundary): boolean {
  return name.endsWith('.ts') && !boundary.suffixes.some((s) => name.endsWith(s));
}

/**
 * Strip `//` and block comments while PRESERVING string/template-literal content
 * (mirrors `architecture/vcs-ownership.stripComments`), so a `dispatch` named in
 * a JSDoc line is not mistaken for an import.
 */
export function stripComments(source: string): string {
  let out = '';
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  while (i < n) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out += ch;
      }
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < n) out += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// An import statement pulling from a `core/dispatch` specifier. The import clause
// (named bindings + optional default) is captured so a VALUE import of `dispatch`
// can be distinguished from a type-only `import type { DispatchContext }`.
const DISPATCH_IMPORT_RE = /import\s+([^;]*?)\s+from\s+(['"`])([^'"`]*core\/dispatch(?:\.js)?)\2/g;

/**
 * True when `source` imports the runtime `dispatch` VALUE from `core/dispatch`.
 *
 * `import type { DispatchContext } from '../core/dispatch.js'` and
 * `import { type DispatchContext } from '...'` are type-only edges and do NOT
 * count — only a value binding of `dispatch` (the shared handler) does.
 */
export function importsRuntimeDispatchValue(source: string): boolean {
  const stripped = stripComments(source);
  let match: RegExpExecArray | null;
  DISPATCH_IMPORT_RE.lastIndex = 0;
  while ((match = DISPATCH_IMPORT_RE.exec(stripped)) !== null) {
    const clause = (match[1] ?? '').trim();
    // `import type { ... }` — a whole-clause type import.
    if (/^type[\s{]/.test(clause)) continue;
    const brace = clause.match(/\{([^}]*)\}/);
    if (!brace) continue;
    const tokens = (brace[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const token of tokens) {
      if (/^type\s/.test(token)) continue; // inline `type X` binding
      const localName = (token.split(/\s+as\s+/)[0] ?? '').trim();
      if (localName === 'dispatch') return true;
    }
  }
  return false;
}

async function collectScannableFiles(
  root: string,
  boundary: EmitBoundary,
): Promise<string[]> {
  const packageRoot = path.dirname(root);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (boundary.directories.has(entry.name)) continue;
        // Dot-dirs are tooling state, not source, on every tree.
        if (entry.name.startsWith('.')) continue;
        const rel = relative(packageRoot, full).replaceAll('\\', '/');
        if (boundary.pathPrefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) {
          continue;
        }
        await walk(full);
      } else if (entry.isFile() && isScannableFile(entry.name, boundary)) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Scan the shipped source under `sourceRoot` and enumerate every dispatch site. */
export async function scanDispatchSites(
  sourceRoot: string = DEFAULT_SRC_ROOT,
  boundary: EmitBoundary = resolveEmitBoundary(sourceRoot),
): Promise<readonly DispatchSite[]> {
  const files = await collectScannableFiles(sourceRoot, boundary);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, 'utf8');
      if (!importsRuntimeDispatchValue(source)) return null;
      return { module: relative(sourceRoot, file).replaceAll('\\', '/') } satisfies DispatchSite;
    }),
  );
  return Object.freeze(
    perFile.filter((s): s is DispatchSite => s !== null).sort((a, b) => byString(a.module, b.module)),
  );
}

/**
 * Pure verdict over an already-collected dispatch-site set + the authorized
 * projection surface. Two independent, complementary checks:
 *   - UNAUTHORIZED_DISPATCH_SITE — a site no projection claims (a direct bypass);
 *   - STALE_DISPATCH_PROJECTION  — a projection that claims no site (phantom cover).
 */
export function runDispatchSeamCensus(
  sites: readonly DispatchSite[],
  projections: readonly string[] = AUTHORIZED_DISPATCH_PROJECTIONS,
): CliCensusDiagnostic[] {
  const authorized = new Set(projections);
  const diagnostics: CliCensusDiagnostic[] = [];

  for (const site of sites) {
    if (!authorized.has(site.module)) {
      diagnostics.push({
        code: 'UNAUTHORIZED_DISPATCH_SITE',
        module: site.module,
        message:
          `Module "${site.module}" imports the runtime \`dispatch\` value directly — a direct ` +
          `CLI-to-dispatch path around the shared contract handler. API-action execution must ` +
          `route through the ${DISPATCH_SEAM_MODULE} seam via the authorized projections ` +
          `(${AUTHORIZED_DISPATCH_PROJECTIONS.join(', ')}).`,
      });
    }
  }

  for (const projection of projections) {
    if (!sites.some((s) => s.module === projection)) {
      diagnostics.push({
        code: 'STALE_DISPATCH_PROJECTION',
        module: projection,
        message:
          `Authorized projection "${projection}" no longer imports the runtime \`dispatch\` ` +
          `value — stale cover. Restore its route through the shared handler or drop it from ` +
          `AUTHORIZED_DISPATCH_PROJECTIONS.`,
      });
    }
  }

  return diagnostics;
}

// ─── Collector 3: governed deviation ledger (DR-25) ─────────────────────────

/**
 * The machine-readable acknowledgement a DEVIATING module exports at the
 * deviation site (the retired `adapters/cli.ts` row exported one as
 * `CLI_DIRECT_DISPATCH_DEVIATION`; a future row must do the same).
 *
 * The acknowledgement lives in BOTH places on purpose: a reader of the
 * deviating module sees, at the import that causes the deviation, that it is
 * governed; a reader of the ledger sees the full governance record. The census
 * cross-checks them so neither can rot into decoration.
 */
export interface DeviationAnnotation {
  readonly invariant: string;
  readonly module: string;
  readonly owner: string;
  readonly expires: string;
}

/** A deviating module paired with the acknowledgement it exports (if any). */
export interface DeviationAnnotationSite {
  readonly module: string;
  /** The exported acknowledgement, or `undefined` when the module exports none. */
  readonly annotation: DeviationAnnotation | undefined;
}

/**
 * Per-module loaders for the exported acknowledgement. STATIC specifiers (not a
 * computed `import(variable)`) so the bundler/test transform can resolve them —
 * same idiom as `core/dispatch.COMPOSITE_HANDLER_LOADERS`. A ledger row whose
 * module has no loader here fails the census, so the map cannot silently lag
 * behind the ledger. EMPTY while the ledger is empty (the retired
 * `adapters/cli.ts` → `CLI_DIRECT_DISPATCH_DEVIATION` pair was the only
 * entry); a future deviation must add its loader alongside its row.
 */
const DEVIATION_ANNOTATION_LOADERS: Readonly<Record<string, () => Promise<Record<string, unknown>>>> =
  Object.freeze({});

/** The export name each deviating module publishes its acknowledgement under. */
const DEVIATION_ANNOTATION_EXPORTS: Readonly<Record<string, string>> = Object.freeze({});

/** Narrow an unknown module export to a {@link DeviationAnnotation}. */
function asAnnotation(value: unknown): DeviationAnnotation | undefined {
  if (!isRecord(value)) return undefined;
  const { invariant, module, owner, expires } = value;
  if (
    typeof invariant !== 'string' ||
    typeof module !== 'string' ||
    typeof owner !== 'string' ||
    typeof expires !== 'string'
  ) {
    return undefined;
  }
  return { invariant, module, owner, expires };
}

/**
 * Load the acknowledgement each ledger module exports. Uses dynamic imports so
 * this module's STATIC dependency graph stays free of the adapters subtree
 * (keeping the `npx tsx` generator lightweight), matching
 * {@link collectLiveCliCommands}.
 */
export async function collectDeviationAnnotations(
  ledger: readonly ContractDeviation[] = CLI_CONTRACT_DEVIATIONS,
): Promise<readonly DeviationAnnotationSite[]> {
  const modules = [...new Set(ledger.map((d) => d.module))].sort(byString);
  return Promise.all(
    modules.map(async (module): Promise<DeviationAnnotationSite> => {
      const loader = DEVIATION_ANNOTATION_LOADERS[module];
      const exportName = DEVIATION_ANNOTATION_EXPORTS[module];
      if (loader === undefined || exportName === undefined) return { module, annotation: undefined };
      try {
        const loaded = await loader();
        return { module, annotation: asAnnotation(loaded[exportName]) };
      } catch {
        return { module, annotation: undefined };
      }
    }),
  );
}

/** True when `expires` (`YYYY-MM-DD`) is strictly before `now`'s end-of-day. */
function isExpired(expires: string, now: Date): boolean {
  const deadline = Date.parse(`${expires}T23:59:59.999Z`);
  return Number.isNaN(deadline) || now.getTime() > deadline;
}

/**
 * Pure verdict over the deviation ledger. This is the collector that makes an
 * UNACKNOWLEDGED direct dispatch path impossible to introduce silently under
 * the governing INV-2: any non-projection route must carry a governed,
 * expiring, self-retiring exception. The live ledger is EMPTY today (the DR-25
 * `cli-direct-dispatch` row retired when the CLI's generated client landed);
 * every arm stays armed against the next candidate.
 *
 * Six independent arms — every one of them a way the acknowledgement could rot:
 *   - UNACKNOWLEDGED_INV2_DEVIATION — a live dispatch site claimed by neither a
 *     contract projection nor a ledger row (the bypass this collector exists to
 *     make impossible to introduce silently);
 *   - CONFLICTING_DEVIATION — a module claimed as BOTH compliant and deviating,
 *     so "compliance" cannot be used to launder a known deviation;
 *   - UNGOVERNED_DEVIATION — a row missing an owner / rationale / retirement /
 *     tracking ref, or carrying a malformed expiry;
 *   - EXPIRED_DEVIATION — the window closed; re-accept explicitly or fix it;
 *   - STALE_DEVIATION — a row covering no live dispatch site, i.e. cover for
 *     nothing. This is what retired the DR-25 row once the CLI became
 *     genuinely generated;
 *   - DEVIATION_ANNOTATION_MISMATCH — the deviating module's own exported
 *     acknowledgement is absent or disagrees with the ledger.
 *
 * `annotations` is optional: the annotation arm needs a live module import, so
 * a caller doing a purely structural check (no I/O) may omit it. `auditCliContract`
 * always supplies it.
 */
export function runDeviationLedgerCensus(
  sites: readonly DispatchSite[],
  ledger: readonly ContractDeviation[] = CLI_CONTRACT_DEVIATIONS,
  annotations: readonly DeviationAnnotationSite[] | undefined = undefined,
  now: Date = new Date(),
  compliant: readonly string[] = CONTRACT_PROJECTIONS,
): CliCensusDiagnostic[] {
  const diagnostics: CliCensusDiagnostic[] = [];
  const compliantSet = new Set(compliant);
  const covered = new Set(ledger.map((d) => d.module));

  // 1. Every live direct-dispatch site is either compliant or acknowledged.
  for (const site of sites) {
    if (compliantSet.has(site.module) || covered.has(site.module)) continue;
    diagnostics.push({
      code: 'UNACKNOWLEDGED_INV2_DEVIATION',
      module: site.module,
      message:
        `Module "${site.module}" reaches the ${DISPATCH_SEAM_MODULE} seam directly but is ` +
        `neither a contract projection (${CONTRACT_PROJECTIONS.join(', ')}) nor covered by a ` +
        `recorded deviation in CLI_CONTRACT_DEVIATIONS. The governing INV-2 permits no ` +
        `UNACKNOWLEDGED direct dispatch path: route it through a projection, or record it ` +
        `with an owner, a rationale, a retirement condition and an expiry.`,
    });
  }

  const annotationByModule = new Map(
    (annotations ?? []).map((a) => [a.module, a.annotation] as const),
  );

  for (const deviation of ledger) {
    // 2. A module cannot be both compliant and deviating.
    if (compliantSet.has(deviation.module)) {
      diagnostics.push({
        code: 'CONFLICTING_DEVIATION',
        deviation: deviation.id,
        message:
          `Deviation "${deviation.id}" names "${deviation.module}", which is ALSO claimed as a ` +
          `fully compliant contract projection. A module is one or the other — drop the ` +
          `deviation or drop the compliance claim.`,
      });
    }

    // 3. Every governance field is present and well-formed.
    const required: readonly (readonly [string, string])[] = [
      ['id', deviation.id],
      ['module', deviation.module],
      ['invariant', deviation.invariant],
      ['owner', deviation.owner],
      ['rationale', deviation.rationale],
      ['retirement', deviation.retirement],
      ['tracking', deviation.tracking],
    ];
    for (const [field, value] of required) {
      if (value.trim() !== '') continue;
      diagnostics.push({
        code: 'UNGOVERNED_DEVIATION',
        deviation: deviation.id,
        field,
        message:
          `Deviation "${deviation.id}" has an empty "${field}". An unowned or unjustified ` +
          `exception is theatre — it launders a known violation into permanent silence.`,
      });
    }
    if (!ISO_DATE_RE.test(deviation.expires)) {
      diagnostics.push({
        code: 'UNGOVERNED_DEVIATION',
        deviation: deviation.id,
        field: 'expires',
        message:
          `Deviation "${deviation.id}" has expiry "${deviation.expires}", which is not a ` +
          `\`YYYY-MM-DD\` date. An exception without a real deadline never expires.`,
      });
    } else if (isExpired(deviation.expires, now)) {
      // 4. The window closed.
      diagnostics.push({
        code: 'EXPIRED_DEVIATION',
        deviation: deviation.id,
        message:
          `Deviation "${deviation.id}" (${deviation.module}, ${deviation.invariant}) EXPIRED on ` +
          `${deviation.expires}. Retire it by meeting the retirement condition — ` +
          `${deviation.retirement} — or re-accept it explicitly with a new expiry and owner.`,
      });
    }

    // 5. The row still covers a live dispatch site.
    if (!sites.some((s) => s.module === deviation.module)) {
      diagnostics.push({
        code: 'STALE_DEVIATION',
        deviation: deviation.id,
        message:
          `Deviation "${deviation.id}" claims "${deviation.module}" imports the runtime ` +
          `\`dispatch\` value, but it no longer does — the deviation covers nothing. Delete the ` +
          `row (and, if the module is now a true projection, add it to CONTRACT_PROJECTIONS).`,
      });
    }

    // 6. The deviating module's own acknowledgement agrees with the ledger.
    if (annotations === undefined) continue;
    const annotation = annotationByModule.get(deviation.module);
    if (annotation === undefined) {
      diagnostics.push({
        code: 'DEVIATION_ANNOTATION_MISMATCH',
        deviation: deviation.id,
        message:
          `Deviation "${deviation.id}" is recorded in the ledger, but "${deviation.module}" ` +
          `exports no machine-readable acknowledgement. The deviation must be visible AT the ` +
          `site as a typed export, not only in the ledger and not as a prose comment.`,
      });
      continue;
    }
    const mismatches = (
      [
        ['invariant', annotation.invariant, deviation.invariant],
        ['module', annotation.module, deviation.module],
        ['owner', annotation.owner, deviation.owner],
        ['expires', annotation.expires, deviation.expires],
      ] as const
    ).filter(([, site, row]) => site !== row);
    if (mismatches.length > 0) {
      diagnostics.push({
        code: 'DEVIATION_ANNOTATION_MISMATCH',
        deviation: deviation.id,
        message:
          `Deviation "${deviation.id}" disagrees with the acknowledgement exported by ` +
          `"${deviation.module}": ` +
          mismatches.map(([f, site, row]) => `${f} site="${site}" ledger="${row}"`).join('; ') +
          `. The two records must agree or the acknowledgement has rotted.`,
      });
    }
  }

  return diagnostics;
}

// ─── Collector 2: CLI command classification (live Commander walk) ───────────

/** One live top-level CLI command as seen on the real Commander program. */
export interface LiveCliCommand {
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface CliClassification {
  /** Registry tool groups (the api-action command groups). */
  readonly toolGroups: readonly string[];
  /** Registry `cli.topLevel` promotions (presentation aliases of api actions). */
  readonly registryPromotions: readonly string[];
  /** Hard-wired adapter promotions (presentation aliases). */
  readonly presentationAliases: readonly string[];
  /** Host-local, non-contract commands. */
  readonly hostLocal: readonly string[];
}

/**
 * Derive the CLI command classification from the LIVE registry (plus the two
 * declared hard-wired sets). Tool groups + registry promotions are read from the
 * registry so they can never drift from it; only the hard-wired presentation
 * aliases + host-local set are declared (and ratcheted for staleness).
 */
export function deriveCliClassification(
  registry: readonly CompositeTool[] = getFullRegistry(),
): CliClassification {
  const toolGroups: string[] = [];
  const registryPromotions: string[] = [];
  for (const tool of registry) {
    toolGroups.push(tool.cli?.alias ?? tool.name.replace(/^exarchos_/, ''));
    for (const action of tool.actions) {
      if (action.cli?.topLevel !== undefined) registryPromotions.push(action.cli.topLevel);
    }
  }
  return {
    toolGroups: [...new Set(toolGroups)].sort(byString),
    registryPromotions: [...new Set(registryPromotions)].sort(byString),
    presentationAliases: [...PRESENTATION_ALIASES].sort(byString),
    hostLocal: [...HOST_LOCAL_COMMANDS].sort(byString),
  };
}

/**
 * Build the real Commander program and enumerate its top-level commands. Uses a
 * dynamic import so this module's STATIC dependency graph stays free of the
 * dispatch/adapters subtree (keeping the direct `npx tsx` generator lightweight
 * and tsx-safe); the census callers `await` it under the test runtime.
 */
export async function collectLiveCliCommands(): Promise<readonly LiveCliCommand[]> {
  const { buildCli } = await import('../../adapters/cli.js');
  const program = buildCli({
    stateDir: '/tmp/exarchos-cli-census',
    // The census only walks the REGISTERED command tree — no dispatch runs — so a
    // structural stand-in for the context suffices.
    eventStore: {} as never,
    enableTelemetry: false,
  } as never);
  return program.commands
    .map((c) => ({ name: c.name(), aliases: [...c.aliases()] }))
    .sort((a, b) => byString(a.name, b.name));
}

/**
 * Pure verdict over the live command set + a classification. Two-way ratchet:
 *   - UNCLASSIFIED_CLI_COMMAND — a live command that is neither a registry-backed
 *     api-action group / presentation alias nor a declared host-local command;
 *   - STALE_HOST_LOCAL_RULE / STALE_PRESENTATION_ALIAS — a declared rule with no
 *     live command (phantom cover), so the classification can never rot.
 */
export function runCliClassificationCensus(
  liveCommands: readonly LiveCliCommand[],
  classification: CliClassification,
): CliCensusDiagnostic[] {
  const diagnostics: CliCensusDiagnostic[] = [];

  const contractRouted = new Set<string>([
    ...classification.toolGroups,
    ...classification.registryPromotions,
    ...classification.presentationAliases,
  ]);
  const hostLocal = new Set(classification.hostLocal);
  const liveNames = new Set(liveCommands.map((c) => c.name));

  for (const command of liveCommands) {
    if (!contractRouted.has(command.name) && !hostLocal.has(command.name)) {
      diagnostics.push({
        code: 'UNCLASSIFIED_CLI_COMMAND',
        command: command.name,
        message:
          `Live CLI command "${command.name}" is unclassified: it is neither a registry-backed ` +
          `api-action group / presentation alias (contract-routed) nor a declared host-local ` +
          `command. Route it through the contract handler or declare it in HOST_LOCAL_COMMANDS.`,
      });
    }
  }

  for (const command of classification.hostLocal) {
    if (!liveNames.has(command)) {
      diagnostics.push({
        code: 'STALE_HOST_LOCAL_RULE',
        command,
        message:
          `Host-local rule for "${command}" claims no live CLI command — stale cover. Remove it ` +
          `from HOST_LOCAL_COMMANDS or restore the command.`,
      });
    }
  }

  for (const command of classification.presentationAliases) {
    if (!liveNames.has(command)) {
      diagnostics.push({
        code: 'STALE_PRESENTATION_ALIAS',
        command,
        message:
          `Presentation-alias rule for "${command}" claims no live CLI command — stale cover. ` +
          `Remove it from PRESENTATION_ALIASES or restore the promotion.`,
      });
    }
  }

  return diagnostics;
}

// ─── Composed census over the real system ────────────────────────────────────

export interface CliCensusModel {
  readonly dispatchSites: readonly DispatchSite[];
  readonly projections?: readonly string[];
  readonly liveCommands: readonly LiveCliCommand[];
  readonly classification: CliClassification;
  /** The DR-25 deviation ledger. Defaults to {@link CLI_CONTRACT_DEVIATIONS}. */
  readonly deviations?: readonly ContractDeviation[];
  /**
   * Acknowledgements exported by the deviating modules. OMIT to skip the
   * ledger↔site agreement arm (it needs a live module import, which a purely
   * structural caller cannot do); `auditCliContract` always supplies it.
   */
  readonly annotations?: readonly DeviationAnnotationSite[];
  /** Injectable clock for the expiry arm. Defaults to now. */
  readonly now?: Date;
}

/** Pure combined verdict over an already-collected model (all three collectors). */
export function runCliContractCensus(model: CliCensusModel): CliCensusResult {
  const diagnostics: CliCensusDiagnostic[] = [
    ...runDispatchSeamCensus(model.dispatchSites, model.projections ?? AUTHORIZED_DISPATCH_PROJECTIONS),
    ...runCliClassificationCensus(model.liveCommands, model.classification),
    ...runDeviationLedgerCensus(
      model.dispatchSites,
      model.deviations ?? CLI_CONTRACT_DEVIATIONS,
      model.annotations,
      model.now ?? new Date(),
    ),
  ];
  return Object.freeze({ ok: diagnostics.length === 0, diagnostics });
}

/**
 * Collect the full model from the live system and return the verdict. This is
 * the callable the exit-proof harness drives against the real tree.
 */
export async function auditCliContract(sourceRoot: string = DEFAULT_SRC_ROOT): Promise<CliCensusResult> {
  const [dispatchSites, liveCommands, annotations] = await Promise.all([
    scanDispatchSites(sourceRoot),
    collectLiveCliCommands(),
    collectDeviationAnnotations(),
  ]);
  return runCliContractCensus({
    dispatchSites,
    liveCommands,
    classification: deriveCliClassification(),
    annotations,
  });
}

// ─── Direct-invocation generator entry (never on import) ─────────────────────

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { surfaceFile, surfaceVersion, commandCount } = generateCliArtifacts();
  process.stdout.write(`wrote CLI-surface baseline: ${surfaceFile}\n`);
  process.stdout.write(`surface version: ${surfaceVersion} — ${commandCount} api-action command(s)\n`);
}
