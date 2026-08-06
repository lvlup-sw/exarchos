// ─── Generated CLI client surface derivation (P03-05, Section 1 + 2) ─────────
//
// The GENERATION half of the CLI contract seam, extracted from
// `cli-contract-seam.ts` when the DR-25 primary resolution made it a
// PRODUCTION import target: `generated-client.ts` lazily imports THIS module to
// verify every CLI-addressed ActionId against the derived surface, while the
// census half (which dynamically imports `adapters/cli.js` to walk the live
// Commander tree) stays in the seam. Splitting them keeps the runtime import
// graph acyclic — adapter → generated client → surface derivation, with the
// census sitting outside that chain (the `import-cycles` gate counts dynamic
// imports as runtime edges, so this separation is load-bearing, not cosmetic).
//
//   1. GENERATION  — `deriveCliSurface(compiledContract)` projects the compiled
//      descriptors into a deterministic, byte-stable CLI client surface
//      (per-action command path, help, flags, render format, and the stable
//      exit codes each action can produce).
//   2. GOLDEN      — the checked-in `generated/cli-surface.json` + its drift
//      guard mirror the P03-03 proof-fixture pattern: running the generator
//      (`npx tsx src/contract/cli/cli-contract-seam.ts`) IS the regeneration
//      gesture.
//
// PURE apart from reading the in-memory registry (via the compiler); the
// file-writing generator only runs when invoked through the seam's
// direct-invocation entry, so importing this module has no filesystem side
// effect. `cli-contract-seam.ts` re-exports everything here, so census callers
// and tests keep a single import surface.
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../request-context.js';
import { exitCodeForError, CONTRACT_EXIT_CODES } from '../error-families.js';
import {
  compile,
  deriveMetaModel,
  type CompiledContract,
  type ActionDescriptor,
  type JsonSchema,
} from '../compiler/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
