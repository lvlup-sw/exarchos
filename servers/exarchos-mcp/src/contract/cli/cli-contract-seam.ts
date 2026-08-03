// ─── CLI contract seam: generated CLI client + dispatch-closure census (P03-05) ─
//
// PROGRAM-03, API-005. The CLI is a GENERATED in-process client over the same
// MCP contract handler — not a separately authoritative dispatch facade. MCP is
// the standards-compliant WIRE projection of the contract; the CLI is the
// in-process projection. Both route API-action execution through ONE shared
// contract-handler seam (`dispatch` from `core/dispatch.ts`), so the two
// surfaces agree by construction.
//
// This module is the seam between the COMPILED contract (P03-03) and the CLI:
//
//   1. GENERATION  — `deriveCliSurface(compiledContract)` projects the compiled
//      descriptors into a deterministic, byte-stable CLI client surface
//      (per-action command path, help, flags, render format, and the stable
//      exit codes each action can produce). The checked-in golden
//      (`generated/cli-surface.json`) + its drift guard mirror the P03-03
//      proof-fixture pattern: running the generator IS the regeneration gesture.
//
//   2. CENSUS      — a two-collector, two-way-ratchet structural conformance
//      gate (same shape as `orchestrate/gate-ownership-census.ts`,
//      `architecture/effect-ledger.ts`, `architecture/vcs-ownership.ts`) proving
//      the exit criterion "API actions have no direct CLI-to-dispatch path":
//        • DISPATCH-SEAM CONTAINMENT (source scan) — the runtime `dispatch`
//          VALUE is imported only by the two authorized projection adapters
//          (the CLI client + the MCP wire). Any other module reaching the
//          dispatch core directly is a bypass; a declared projection that no
//          longer routes through it is stale cover.
//        • CLI COMMAND CLASSIFICATION (live Commander walk) — every live CLI
//          command classifies as an api-action group, a presentation alias, or
//          a host-local command. Host-local commands legitimately do NOT go
//          through the contract handler; the census RESPECTS that classification
//          rather than flagging it. An unclassified live command is a violation;
//          a declared host-local rule that no longer appears is stale cover.
//
// The generation half is PURE apart from reading the in-memory registry (via the
// compiler); the file-writing generator only runs when invoked directly, so
// importing this module has no filesystem side effect. The census source scan is
// comment-aware and string-preserving so a `dispatch` mentioned in prose is not
// mistaken for a call.
//
// Named `*-seam.ts` — the established `source-lint-seam` class (sibling of
// `architecture/contract-seam.ts`): a test-invoked gate that runs against
// production SOURCE, not a production import target.
//
// Usage (regenerate the golden, from servers/exarchos-mcp):
//   npx tsx src/contract/cli/cli-contract-seam.ts
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { canonicalJson } from '../request-context.js';
import { exitCodeForError, CONTRACT_EXIT_CODES } from '../error-families.js';
import {
  compile,
  deriveMetaModel,
  type CompiledContract,
  type ActionDescriptor,
  type JsonSchema,
} from '../compiler/index.js';
import { getFullRegistry, type CompositeTool } from '../../registry.js';
import { TIER1_HARNESSES } from '../../launcher/harness-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The shipped `src` root (this module lives at `src/contract/cli/`). */
export const DEFAULT_SRC_ROOT = path.resolve(HERE, '..', '..');

// ════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — Generated CLI client surface (derived from the compiled contract)
// ════════════════════════════════════════════════════════════════════════════

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One CLI flag, projected from an action's input JSON Schema. */
export interface CliFlag {
  /** Kebab-cased flag name (`featureId` → `feature-id`), matching the adapter. */
  readonly name: string;
  readonly required: boolean;
  readonly type: string;
}

/** A stable error code an action can surface, and the CLI exit code it maps to. */
export interface CliExitMapping {
  readonly code: string;
  readonly exitCode: number;
}

/** The generated CLI client's view of ONE API action. */
export interface CliCommand {
  readonly actionId: string;
  /** Registry tool group, `exarchos_`-stripped (the top-level command group). */
  readonly group: string;
  readonly action: string;
  /** Action alias used at the CLI (`get` → `status`), or the action name. */
  readonly commandName: string;
  readonly description: string;
  /** The render format the CLI defaults to for this action, or null. */
  readonly format: string | null;
  /** Top-level promotion name (presentation alias), or null. */
  readonly topLevel: string | null;
  readonly flags: readonly CliFlag[];
  /** The success exit code (always SUCCESS). */
  readonly successExitCode: number;
  /** Every stable error code → CLI exit code, from the frozen contract. */
  readonly errorExits: readonly CliExitMapping[];
}

/** The whole generated CLI client surface — a byte-stable contract projection. */
export interface CliSurface {
  readonly surfaceVersion: string;
  readonly generator: 'P03-05';
  readonly commands: readonly CliCommand[];
}

/** Kebab-case an input-schema property, matching `adapters/schema-to-flags.toKebab`. */
function toKebab(camel: string): string {
  return camel.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Coarse JSON-Schema type of one property (for the flag's value hint). */
function coarseType(propSchema: unknown): string {
  if (!isRecord(propSchema)) return 'unknown';
  if (Array.isArray(propSchema.enum)) return 'enum';
  const t = propSchema.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').sort(byString).join('|') || 'unknown';
  if ('anyOf' in propSchema || 'oneOf' in propSchema || 'allOf' in propSchema) return 'union';
  return 'unknown';
}

/**
 * Project an action's input JSON Schema into the CLI flag list. Mirrors the
 * adapter's flag derivation: skip the `action` discriminator, kebab-case the
 * name, mark required from the schema `required` array. Deterministic (sorted).
 */
export function deriveFlags(inputSchema: JsonSchema | undefined): CliFlag[] {
  if (inputSchema === undefined) return [];
  const properties = inputSchema.properties;
  if (!isRecord(properties)) return [];
  const requiredRaw = inputSchema.required;
  const required = new Set<string>(
    Array.isArray(requiredRaw) ? requiredRaw.filter((r): r is string => typeof r === 'string') : [],
  );
  const flags: CliFlag[] = [];
  for (const key of Object.keys(properties)) {
    if (key === 'action') continue;
    flags.push({
      name: toKebab(key),
      required: required.has(key),
      type: coarseType(properties[key]),
    });
  }
  return flags.sort((a, b) => byString(a.name, b.name));
}

function deriveCommand(descriptor: ActionDescriptor, input: JsonSchema | undefined): CliCommand {
  const presentation = descriptor.policy.presentation;
  const errorExits: CliExitMapping[] = [...descriptor.errorCodes]
    .sort(byString)
    .map((code) => ({ code, exitCode: exitCodeForError(code) }));
  return {
    actionId: descriptor.actionId,
    group: descriptor.tool.replace(/^exarchos_/, ''),
    action: descriptor.action,
    commandName: presentation.cliAlias ?? descriptor.action,
    description: descriptor.description,
    format: presentation.cliFormat,
    topLevel: presentation.topLevel,
    flags: deriveFlags(input),
    successExitCode: CONTRACT_EXIT_CODES.SUCCESS,
    errorExits,
  };
}

/**
 * Derive the generated CLI client surface from a compiled contract. Total and
 * deterministic: commands are sorted by ActionId, flags + exit mappings are
 * sorted, and every field comes from the frozen contract (descriptors, schemas,
 * the P03-02 exit-code authority) — no clock, path, or locale leaks in.
 */
export function deriveCliSurface(contract: CompiledContract): CliSurface {
  const commands = [...contract.descriptors]
    .sort((a, b) => byString(a.actionId, b.actionId))
    .map((descriptor) => deriveCommand(descriptor, contract.schemas.actions[descriptor.actionId]?.input));
  return { surfaceVersion: contract.surfaceVersion, generator: 'P03-05', commands };
}

/** The canonical, byte-stable serialization of a CLI surface. */
export function serializeCliSurface(surface: CliSurface): string {
  return canonicalJson(surface);
}

// ════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — Golden generator (checked-in drift baseline)
// ════════════════════════════════════════════════════════════════════════════

/** The checked-in generated-artifact directory. */
export const GENERATED_DIR = path.resolve(HERE, 'generated');

/** The checked-in generated CLI-surface baseline. */
export const CLI_SURFACE_FILE = path.resolve(GENERATED_DIR, 'cli-surface.json');

/**
 * Compile the live contract or throw a readable aggregated diagnostic. The throw
 * is intentional: the generator must fail loudly (blocked authority, a missing
 * policy field) rather than emit a partial or stale baseline (mirrors P03-03).
 */
export function compileForCli(): CompiledContract {
  const outcome = compile(deriveMetaModel());
  if (!outcome.ok) {
    const summary = outcome.diagnostics
      .map((d) => `  [${d.code}] ${d.actionId} ${d.path}: ${d.message}`)
      .join('\n');
    throw new Error(`CLI generation BLOCKED — ${outcome.diagnostics.length} diagnostic(s):\n${summary}`);
  }
  return outcome.output;
}

/** The canonical, byte-stable serialization written to disk (trailing newline). */
export function serializedCliSurfaceBaseline(): string {
  return serializeCliSurface(deriveCliSurface(compileForCli())) + '\n';
}

export interface GenerateCliResult {
  readonly surfaceFile: string;
  readonly surfaceVersion: string;
  readonly commandCount: number;
}

/** Regenerate + write the checked-in CLI-surface baseline. */
export function generateCliArtifacts(): GenerateCliResult {
  const surface = deriveCliSurface(compileForCli());
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(CLI_SURFACE_FILE, serializeCliSurface(surface) + '\n', 'utf8');
  return {
    surfaceFile: CLI_SURFACE_FILE,
    surfaceVersion: surface.surfaceVersion,
    commandCount: surface.commands.length,
  };
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
 * The authorized projection surface — the ONLY modules permitted to import the
 * runtime `dispatch` value. The CLI in-process client and the MCP wire
 * projection share this one handler, so neither is a *separately authoritative*
 * dispatch facade. Any OTHER importer is a direct-dispatch bypass.
 */
export const AUTHORIZED_DISPATCH_PROJECTIONS: readonly string[] = Object.freeze([
  'adapters/cli.ts',
  'adapters/mcp.ts',
]);

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
  'merge-orchestrate',
]);

export type CliCensusDiagnostic =
  | { readonly code: 'UNAUTHORIZED_DISPATCH_SITE'; readonly module: string; readonly message: string }
  | { readonly code: 'STALE_DISPATCH_PROJECTION'; readonly module: string; readonly message: string }
  | { readonly code: 'UNCLASSIFIED_CLI_COMMAND'; readonly command: string; readonly message: string }
  | { readonly code: 'STALE_HOST_LOCAL_RULE'; readonly command: string; readonly message: string }
  | { readonly code: 'STALE_PRESENTATION_ALIAS'; readonly command: string; readonly message: string };

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

/** Directories that are not shipped source (test/bench/eval harnesses). */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'test-helpers',
  'benchmarks',
  'evals',
]);

/** True for a shipped-source TypeScript module (not a test/decl/bench file). */
function isScannableFile(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.type-test.ts') &&
    !name.endsWith('.d.ts') &&
    !name.endsWith('.bench.ts')
  );
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

async function collectScannableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Scan the shipped source under `sourceRoot` and enumerate every dispatch site. */
export async function scanDispatchSites(sourceRoot: string = DEFAULT_SRC_ROOT): Promise<readonly DispatchSite[]> {
  const files = await collectScannableFiles(sourceRoot);
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
}

/** Pure combined verdict over an already-collected model (both collectors). */
export function runCliContractCensus(model: CliCensusModel): CliCensusResult {
  const diagnostics: CliCensusDiagnostic[] = [
    ...runDispatchSeamCensus(model.dispatchSites, model.projections ?? AUTHORIZED_DISPATCH_PROJECTIONS),
    ...runCliClassificationCensus(model.liveCommands, model.classification),
  ];
  return Object.freeze({ ok: diagnostics.length === 0, diagnostics });
}

/**
 * Collect the full model from the live system and return the verdict. This is
 * the callable the exit-proof harness drives against the real tree.
 */
export async function auditCliContract(sourceRoot: string = DEFAULT_SRC_ROOT): Promise<CliCensusResult> {
  const [dispatchSites, liveCommands] = await Promise.all([
    scanDispatchSites(sourceRoot),
    collectLiveCliCommands(),
  ]);
  return runCliContractCensus({
    dispatchSites,
    liveCommands,
    classification: deriveCliClassification(),
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
