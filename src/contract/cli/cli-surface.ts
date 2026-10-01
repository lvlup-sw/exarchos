/**
 * The generation half of the CLI contract seam. `deriveCliSurface` projects the compiled
 * contract into a byte-stable CLI client surface. The generator writes it and the addressing
 * module to `generated/`. Run `npx tsx src/contract/cli/cli-contract-seam.ts` to regenerate them.
 *
 * The census half stays in `cli-contract-seam.ts` because it imports the CLI adapter. The
 * `import-cycles` gate counts that dynamic import, so the split keeps the import graph acyclic.
 * Importing this module writes no file. `cli-contract-seam.ts` re-exports everything here.
 */

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
import {
  normalizeActionContract,
  type ActionContract,
} from '../../registry/action-contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  /** The success exit code. It is always `SUCCESS`. */
  readonly successExitCode: number;
  /** The CLI exit code for each stable error code of the action. */
  readonly errorExits: readonly CliExitMapping[];
  /**
   * The normalized action contract of the descriptor. It is absent when the descriptor declares
   * none. This view does not make a contract from annotations or auto-emits.
   */
  readonly actionContract?: ActionContract;
}

/** The whole generated CLI client surface. It is a byte-stable projection of the contract. */
export interface CliSurface {
  readonly surfaceVersion: string;
  readonly generator: 'P03-05';
  readonly commands: readonly CliCommand[];
}

/** Kebab-case an input-schema property, matching `adapters/cli/schema-to-flags.toKebab`. */
function toKebab(camel: string): string {
  return camel.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The coarse JSON Schema type of one property, for the value hint of the flag. */
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
 * Projects the input JSON Schema of an action into a sorted CLI flag list. Like the adapter,
 * it skips the `action` discriminator, kebab-cases each name, and reads `required` from the schema.
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

/** Normalizes the declared contract of the descriptor. It returns `undefined` when none is declared. */
function projectCliActionContract(descriptor: ActionDescriptor): ActionContract | undefined {
  const declared = descriptor.actionContract ?? descriptor.policy.actionContract;
  if (declared === undefined) return undefined;
  return normalizeActionContract(declared);
}

function deriveCommand(descriptor: ActionDescriptor, input: JsonSchema | undefined): CliCommand {
  const presentation = descriptor.policy.presentation;
  const errorExits: CliExitMapping[] = [...descriptor.errorCodes]
    .sort(byString)
    .map((code) => ({ code, exitCode: exitCodeForError(code) }));
  const actionContract = projectCliActionContract(descriptor);
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
    ...(actionContract === undefined ? {} : { actionContract }),
  };
}

/**
 * Derives the CLI client surface from a compiled contract. Commands, flags, and exit mappings
 * are sorted. Every field comes from the contract, so no clock, path, or locale gets in.
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

/** The checked-in generated-artifact directory. */
export const GENERATED_DIR = path.resolve(HERE, 'generated');

/** The checked-in generated CLI-surface baseline. */
export const CLI_SURFACE_FILE = path.resolve(GENERATED_DIR, 'cli-surface.json');

/**
 * Compiles the live contract, or throws with all the diagnostics. The generator must fail
 * instead of writing a partial or stale baseline.
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
 * Compiles the live contract with the authority freeze gate stubbed `ok`. No dispatch path
 * calls it. The test `AddressingSurface_IsByteIdentical_ToTheGenerationSurface` uses it to
 * prove that the generated addressing module agrees with the compiled contract.
 *
 * The freeze check reads the source tree, and inside the single-file binary those reads fail
 * with ENOENT. Thus the freeze gate is a generation-time control only. The authority verdict
 * only gates and never changes the output, so the result equals that of {@link compileForCli}
 * when the authority is approved.
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

/** The canonical serialization that the generator writes to disk, with a trailing newline. */
export function serializedCliSurfaceBaseline(): string {
  return serializeCliSurface(deriveCliSurface(compileForCli())) + '\n';
}

export interface GenerateCliResult {
  readonly surfaceFile: string;
  readonly surfaceVersion: string;
  readonly commandCount: number;
}

/** The path of the generated addressing module. See {@link renderCliActionIdsModule}. */
export const CLI_ACTION_IDS_FILE = path.resolve(GENERATED_DIR, 'cli-action-ids.ts');

/**
 * Renders the addressing module: the sorted ActionIds of the surface as a static TS constant.
 * The generated client imports it to verify an id before dispatch, with no file read and no
 * compile at start. It regenerates with the golden, and the seam baseline test pins the two together.
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

/** Writes the CLI surface baseline and the addressing module to `generated/`. */
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
