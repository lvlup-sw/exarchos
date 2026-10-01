/**
 * The CLI contract seam: the generated CLI client surface and the dispatch-closure census. MCP is
 * the wire projection of the contract, and the CLI is the in-process projection. Both run API
 * actions through the shared `dispatch` in `dispatch/core/dispatch.ts`.
 *
 * The CLI is a generated client of the contract. `contract/cli/generated-client.ts` is the one
 * CLI-side dispatch site. It checks each ActionId against `generated/cli-action-ids.ts`, so the CLI
 * cannot address an action that the contract does not compile. The generation half is in
 * `cli-surface.ts`, and this module re-exports it for census callers and tests.
 *
 * The census has three collectors over the rule that API actions have no direct CLI-to-dispatch
 * path: dispatch-seam containment, CLI command classification, and the deviation ledger. This
 * module is a test-invoked gate over production source, not a production import target.
 *
 * To regenerate the golden, run `npx tsx src/contract/cli/cli-contract-seam.ts` from the repository
 * root. The file write occurs only on direct invocation, not on import.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { getFullRegistry, type CompositeTool } from '../../registry.js';
import { TIER1_HARNESSES } from '../../runtime/launcher/harness-registry.js';
import { generateCliArtifacts } from './cli-surface.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The shipped `src` root (this module lives at `src/contract/cli/`). */
export const DEFAULT_SRC_ROOT = path.resolve(HERE, '../..');

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

/**
 * The shared MCP contract-handler seam. Both projections (CLI + MCP) route
 * API-action execution through the runtime `dispatch` VALUE exported here.
 */
export const DISPATCH_SEAM_MODULE = 'dispatch/core/dispatch.ts';

/**
 * The projections that reach the shared handler with no deviation. `adapters/mcp/mcp.ts` is the
 * wire rendering of the contract handler, so its route is the projection itself.
 * `contract/cli/generated-client.ts` checks each ActionId against the generated contract surface
 * before it dispatches. A module that needs the handler but is not a projection belongs in
 * {@link CLI_CONTRACT_DEVIATIONS}. `runDeviationLedgerCensus` rejects a module in both lists.
 */
export const CONTRACT_PROJECTIONS: readonly string[] = Object.freeze([
  'adapters/mcp/mcp.ts',
  'contract/cli/generated-client.ts',
]);

/** `YYYY-MM-DD`. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One recorded, accepted deviation from a governing invariant. As in `ADVISORY_REGISTRY`, each field
 * is required and non-empty, because an exception with no owner or date hides a known violation.
 * `runDeviationLedgerCensus` enforces this.
 */
export interface ContractDeviation {
  /** Stable id, unique across the ledger. */
  readonly id: string;
  /** The deviating module, `src`-relative and forward-slashed. */
  readonly module: string;
  /** The id of the governing invariant that the module deviates from. */
  readonly invariant: string;
  /** The deviation shape. There is one shape now. */
  readonly kind: 'direct-dispatch-path';
  /** Accountable owner — must be non-empty. */
  readonly owner: string;
  /** WHY the deviation is accepted rather than fixed now. Non-empty. */
  readonly rationale: string;
  /** The retirement condition that closes the deviation. Non-empty. */
  readonly retirement: string;
  /** Tracking ref (design rationale id + the spec that accepted it). Non-empty. */
  readonly tracking: string;
  /** Expiry `YYYY-MM-DD`. A PAST expiry FAILS the census — revisit or re-date. */
  readonly expires: string;
}

/**
 * The accepted-deviation ledger. It is empty, and all census arms stay active. A new direct route to
 * the dispatch core must be a contract projection ({@link CONTRACT_PROJECTIONS}). If it is not, it
 * must add a row here with an owner, a rationale, a retirement condition, a tracking ref, and an
 * expiry. Otherwise the census fails. `owner` uses the vocabulary of `ADVISORY_REGISTRY`.
 */
export const CLI_CONTRACT_DEVIATIONS: readonly ContractDeviation[] = Object.freeze([]);

/** Modules admitted to the dispatch seam only by a recorded deviation. */
export const DEVIATING_DISPATCH_MODULES: readonly string[] = Object.freeze(
  [...new Set(CLI_CONTRACT_DEVIATIONS.map((d) => d.module))].sort(byString),
);

/**
 * The only modules that can import the runtime `dispatch` value, derived from the two lists above.
 * Each is a {@link CONTRACT_PROJECTIONS} member or has a row in {@link CLI_CONTRACT_DEVIATIONS}. Any
 * other importer is a direct-dispatch bypass.
 */
export const AUTHORIZED_DISPATCH_PROJECTIONS: readonly string[] = Object.freeze(
  [...CONTRACT_PROJECTIONS, ...DEVIATING_DISPATCH_MODULES].sort(byString),
);

/**
 * Host-local CLI commands that do not route through the contract handler and have no MCP
 * equivalent. They include the introspection verbs, the MCP server entry, and the CLI-only harness
 * launchers. A stdio MCP surface cannot own the lifecycle of a child process.
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
 * Presentation aliases that `adapters/cli/cli.ts` hard-wires, such as `exarchos doctor` for
 * `exarchos_orchestrate.doctor`. The registry cannot derive them, so they are declared here. A
 * registry `cli.topLevel` promotion must not go here. The stale-rule ratchet fails on an alias
 * with no live command.
 */
export const PRESENTATION_ALIASES: readonly string[] = Object.freeze([
  'doctor',
  'feedback',
  'onboard',
]);

/** One census finding. {@link runDeviationLedgerCensus} describes the six deviation-ledger codes. */
export type CliCensusDiagnostic =
  | { readonly code: 'UNAUTHORIZED_DISPATCH_SITE'; readonly module: string; readonly message: string }
  | { readonly code: 'STALE_DISPATCH_PROJECTION'; readonly module: string; readonly message: string }
  | { readonly code: 'UNCLASSIFIED_CLI_COMMAND'; readonly command: string; readonly message: string }
  | { readonly code: 'STALE_HOST_LOCAL_RULE'; readonly command: string; readonly message: string }
  | { readonly code: 'STALE_PRESENTATION_ALIAS'; readonly command: string; readonly message: string }
  | { readonly code: 'UNACKNOWLEDGED_INV2_DEVIATION'; readonly module: string; readonly message: string }
  | {
      readonly code: 'UNGOVERNED_DEVIATION';
      readonly deviation: string;
      readonly field: string;
      readonly message: string;
    }
  | { readonly code: 'EXPIRED_DEVIATION'; readonly deviation: string; readonly message: string }
  | { readonly code: 'STALE_DEVIATION'; readonly deviation: string; readonly message: string }
  | { readonly code: 'CONFLICTING_DEVIATION'; readonly deviation: string; readonly message: string }
  | {
      readonly code: 'DEVIATION_ANNOTATION_MISMATCH';
      readonly deviation: string;
      readonly message: string;
    };

export interface CliCensusResult {
  readonly ok: boolean;
  readonly diagnostics: readonly CliCensusDiagnostic[];
}

/** A shipped module that imports the runtime `dispatch` value. */
export interface DispatchSite {
  /** Repo-relative to the scan root, forward-slashed. */
  readonly module: string;
}

/**
 * What the census can skip. The boundary comes from the build: a file that `tsconfig.json` keeps out
 * of the emit is not shipped. The census scans every other file, whatever its folder name.
 */
export interface EmitBoundary {
  /** Directory names that the build excludes as a whole, such as `__tests__`. */
  readonly directories: ReadonlySet<string>;
  /** Package-relative path prefixes that the build excludes, such as a fixture tree. */
  readonly pathPrefixes: readonly string[];
  /** File suffixes that the build excludes, such as `.test.ts`. */
  readonly suffixes: readonly string[];
}

/**
 * Exclusions that hold for any tree with no build to read: the dependency tree and the build output.
 * `.d.ts` files also go, because they emit no runtime code. This floor gives the widest scan, so a
 * root with no `tsconfig.json` gets more scan, not less.
 */
const UNIVERSAL_EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist']);
const UNIVERSAL_EXCLUDED_SUFFIXES: readonly string[] = Object.freeze(['.d.ts']);

const UNIVERSAL_EMIT_BOUNDARY: EmitBoundary = Object.freeze({
  directories: UNIVERSAL_EXCLUDED_DIRS,
  pathPrefixes: Object.freeze([]),
  suffixes: UNIVERSAL_EXCLUDED_SUFFIXES,
});

/**
 * Translate the `tsconfig.json` `exclude` entries into the boundary that they describe. Three glob
 * shapes cover the entries of this package. The function ignores an entry that fits none, because an
 * unknown glob must not shrink the scan. The path-prefix arm is last, because a bare-directory glob
 * such as the `__tests__` entry also contains slashes.
 */
export function parseEmitBoundary(excludes: readonly string[]): EmitBoundary {
  const directories = new Set(UNIVERSAL_EXCLUDED_DIRS);
  const pathPrefixes: string[] = [];
  const suffixes = new Set(UNIVERSAL_EXCLUDED_SUFFIXES);
  for (const raw of excludes) {
    const entry = raw.replaceAll('\\', '/');
    const bareDir = /^(?:\*\*\/)?([^*/]+)(?:\/\*\*)?\/?$/.exec(entry);
    const suffixGlob = /^(?:\*\*\/)?\*(\.[^*/]+)$/.exec(entry);
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
 * The emit boundary of the `tsconfig.json` beside `sourceRoot`, or the universal floor when there is
 * no such file. The file is JSONC, so `stripComments` removes its comments before the parse. A
 * tsconfig that exists but does not parse throws, so the census does not guess its own scope.
 */
export function resolveEmitBoundary(sourceRoot: string): EmitBoundary {
  const configPath = path.join(path.dirname(sourceRoot), 'tsconfig.json');
  if (!fs.existsSync(configPath)) return UNIVERSAL_EMIT_BOUNDARY;
  const raw = fs.readFileSync(configPath, 'utf8');
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
 * Strip line and block comments, and keep string and template-literal content. A `dispatch` named in
 * a comment thus does not count as an import.
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

/**
 * An import statement from a `core/dispatch` specifier. The regex captures the import clause, so a
 * value import of `dispatch` is different from a type-only `import type { DispatchContext }`.
 */
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
    if (/^type[\s{]/.test(clause)) continue;
    const brace = clause.match(/\{([^}]*)\}/);
    if (!brace) continue;
    const tokens = (brace[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const token of tokens) {
      if (/^type\s/.test(token)) continue;
      const localName = (token.split(/\s+as\s+/)[0] ?? '').trim();
      if (localName === 'dispatch') return true;
    }
  }
  return false;
}

/**
 * The sorted scannable files under `root`. The walk skips the boundary exclusions and the
 * dot-directories, which hold tooling state.
 */
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
 * The pure verdict over collected dispatch sites and the authorized projections. It reports
 * `UNAUTHORIZED_DISPATCH_SITE` for a site that no projection claims. It reports
 * `STALE_DISPATCH_PROJECTION` for a projection that claims no site.
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

/**
 * The machine-readable acknowledgement that a deviating module exports at the deviation site. A
 * reader of the module sees that the deviation is governed, and the ledger holds the full record.
 * The census checks that the two agree.
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
 * The per-module loaders for the exported acknowledgement. Each uses a static specifier, so the
 * bundler and the test transform can resolve it. A ledger row with no loader fails the census. The
 * map is empty while the ledger is empty. A new deviation must add its loader with its row.
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
 * Load the acknowledgement that each ledger module exports. Dynamic imports keep the adapters
 * subtree out of the static dependency graph of this module, as in {@link collectLiveCliCommands}.
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
 * The pure verdict over the deviation ledger. Each route that is not a projection must carry a
 * governed, expiring exception. The six codes are:
 *   - `UNACKNOWLEDGED_INV2_DEVIATION`: a live site with no projection and no ledger row.
 *   - `CONFLICTING_DEVIATION`: a module that is both a projection and a deviation.
 *   - `UNGOVERNED_DEVIATION`: a row with an empty field or a malformed expiry.
 *   - `EXPIRED_DEVIATION`: a row whose expiry has passed.
 *   - `STALE_DEVIATION`: a row that covers no live site.
 *   - `DEVIATION_ANNOTATION_MISMATCH`: a module export that is absent or disagrees with its row.
 * The annotation check needs a module import, so it runs only when `annotations` is given.
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
      diagnostics.push({
        code: 'EXPIRED_DEVIATION',
        deviation: deviation.id,
        message:
          `Deviation "${deviation.id}" (${deviation.module}, ${deviation.invariant}) EXPIRED on ` +
          `${deviation.expires}. Retire it by meeting the retirement condition — ` +
          `${deviation.retirement} — or re-accept it explicitly with a new expiry and owner.`,
      });
    }

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
 * Derive the CLI command classification. Tool groups and registry promotions come from the live
 * registry, so they cannot drift from it. Only the presentation aliases and the host-local set are
 * declared, and the census checks them for stale entries.
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
 * Build the real Commander program and list its top-level commands. A dynamic import keeps the
 * adapters subtree out of the static graph of this module. The walk runs no dispatch, so a
 * structural stand-in for the context is sufficient.
 */
export async function collectLiveCliCommands(): Promise<readonly LiveCliCommand[]> {
  const { buildCli } = await import('../../adapters/cli/cli.js');
  const program = buildCli({
    stateDir: '/tmp/exarchos-cli-census',
    eventStore: {} as never,
    enableTelemetry: false,
  } as never);
  return program.commands
    .map((c) => ({ name: c.name(), aliases: [...c.aliases()] }))
    .sort((a, b) => byString(a.name, b.name));
}

/**
 * The pure verdict over the live commands and a classification. It reports
 * `UNCLASSIFIED_CLI_COMMAND` for a live command that is not contract-routed or host-local. It reports
 * `STALE_HOST_LOCAL_RULE` or `STALE_PRESENTATION_ALIAS` for a declared rule with no live command.
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

export interface CliCensusModel {
  readonly dispatchSites: readonly DispatchSite[];
  readonly projections?: readonly string[];
  readonly liveCommands: readonly LiveCliCommand[];
  readonly classification: CliClassification;
  /** The deviation ledger. The default is {@link CLI_CONTRACT_DEVIATIONS}. */
  readonly deviations?: readonly ContractDeviation[];
  /**
   * The acknowledgements that the deviating modules export. Without it, the agreement check between
   * the ledger and the site does not run, because that check needs a module import.
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

/** True only on direct invocation, so an import of this module writes no file. */
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
