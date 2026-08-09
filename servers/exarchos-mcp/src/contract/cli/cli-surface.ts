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

/**
 * Compile the live contract with the generation-time AUTHORITY freeze gate
 * stubbed `ok` — the UNGATED twin of {@link compileForCli}.
 *
 * NOT ON THE DISPATCH PATH. It was, briefly: the generated client's verify step
 * ran this compile lazily per process, until the win32 packaged proof showed
 * that a per-process compile blows the budget when every probe spawns a fresh
 * binary. Addressing now resolves from the static `generated/cli-action-ids.ts`
 * module, and this function's remaining job is verification — it is the second
 * term in `AddressingSurface_IsByteIdentical_ToTheGenerationSurface`, which is
 * what makes "verified against the generated module" equivalent to "verified
 * against the compiled contract".
 *
 * WHY THE STUB IS LOAD-BEARING, NOT A SHORTCUT: `verifyContractAuthority()`
 * collects its inputs by READING THE SOURCE TREE — `package.json`, the
 * `.exarchos/invariants.md` catalog, and `.ts` source files, all resolved
 * relative to `import.meta.url`. Inside a compiled single-file binary those
 * paths resolve into the bundle's virtual root (`/package.json`) and throw
 * ENOENT, so a runtime dispatch path gated on the freeze check crashes EVERY
 * CLI invocation of the shipped artifact (the P05-02 packaged proof caught
 * exactly this). The freeze gate is a GENERATION/CI-time control — it blocks
 * emitting artifacts from an unapproved tree via {@link compileForCli}, the
 * golden drift guard, and the authority tests — never a per-dispatch check.
 *
 * The PURE gates (meta-model SHAPE validation and SURFACE compatibility) still
 * run, and the authority verdict never alters compiler OUTPUT (it only gates),
 * so the descriptors — and therefore the ActionId surface — are byte-identical
 * to {@link compileForCli}'s whenever the tree's authority is approved. The
 * packaged-binary guard in `generated-client.test.ts` pins the LIVE dispatch
 * path (`invokeContractAction` → `contractActionIds`) rather than this
 * function; this function's own fs-independence is pinned there too, as a
 * property of a verification helper.
 */
export function compileForCliAddressing(): CompiledContract {
  const outcome = compile(deriveMetaModel(), {
    verifyAuthority: () => ({
      ok: true,
      violations: [],
      report:
        'runtime addressing: authority freeze is a generation-time gate ' +
        '(enforced by compileForCli + the golden drift guard), not a dispatch-time check',
    }),
  });
  if (!outcome.ok) {
    const summary = outcome.diagnostics
      .map((d) => `  [${d.code}] ${d.actionId} ${d.path}: ${d.message}`)
      .join('\n');
    throw new Error(
      `CLI runtime addressing BLOCKED — ${outcome.diagnostics.length} diagnostic(s):\n${summary}`,
    );
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

/** Path of the generated ADDRESSING module (see {@link renderCliActionIdsModule}). */
export const CLI_ACTION_IDS_FILE = path.resolve(GENERATED_DIR, 'cli-action-ids.ts');

/**
 * Render the generated addressing module: the sorted ActionId list of the
 * compiled surface as a static TS constant. The generated client imports this
 * MODULE (bundled at build time — no filesystem read, no meta-model compile)
 * to verify an id before dispatch, which is what keeps packaged cold-start
 * flat: the win32 packaged-proof probes timed out when every fresh process
 * re-ran the full meta-model → surface pipeline just to learn the id set.
 * Drift is impossible to hide: this file regenerates with the golden in one
 * gesture, and the seam's baseline test pins module == golden == derivation.
 */
export function renderCliActionIdsModule(surface: CliSurface): string {
  const ids = [...surface.commands.map((c) => c.actionId)].sort();
  return [
    '// GENERATED by `npx tsx src/contract/cli/cli-contract-seam.ts` — do not edit.',
    '// Static addressing set of the compiled contract surface (one ActionId per',
    '// line, sorted). Regenerates together with cli-surface.json; the seam',
    '// baseline test pins byte-agreement between this module, the golden, and a',
    '// fresh derivation.',
    '',
    'export const CLI_ACTION_IDS: readonly string[] = [',
    ...ids.map((id) => `  '${id}',`),
    '];',
    '',
  ].join('\n');
}

/** Regenerate + write the checked-in CLI-surface baseline + addressing module. */
export function generateCliArtifacts(): GenerateCliResult {
  const surface = deriveCliSurface(compileForCli());
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(CLI_SURFACE_FILE, serializeCliSurface(surface) + '\n', 'utf8');
  fs.writeFileSync(CLI_ACTION_IDS_FILE, renderCliActionIdsModule(surface), 'utf8');
  return {
    surfaceFile: CLI_SURFACE_FILE,
    surfaceVersion: surface.surfaceVersion,
    commandCount: surface.commands.length,
  };
}
