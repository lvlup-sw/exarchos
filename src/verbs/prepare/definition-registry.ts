/**
 * The registry of workflow definitions. It resolves the workflow type of a stream to one registered
 * definition, or to a refusal of prepare.
 *
 * The five built-in definitions and each user file go through one add path, `registerDefinition`.
 * The add path keeps one entry for the same type and digest, and it refuses the same type with another digest.
 * A user file lives under `.exarchos/workflows/` at the root of the work tree of the caller.
 * The registry reads that directory again on each call, so it holds no state across calls.
 *
 * The read follows no link. A link or a file in place of a directory refuses, and so does each read error.
 * Only an absent directory is absence. One finding refuses every user type of the checkout.
 * A built-in type reads no file and runs no git, so a bad file never blocks a built-in type.
 */

import type { Stats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import type { RepositoryObservation } from '../../utils/git-tree.js';
import { BUILT_IN_WORKFLOW_TYPES, builtInDefinition } from '../../workflow/definitions/built-in.js';
import type { ExarchosDefinition } from '../../workflow/definitions/extension.js';
import { checkUserDefinition } from '../../workflow/definitions/user.js';
import type { PrepareRefusal } from './types.js';

/** The directory of the checkout that holds the Exarchos files. */
const DOT_DIRECTORY = '.exarchos';

/** The directory under {@link DOT_DIRECTORY} that holds the user definition files. */
const WORKFLOWS_DIRECTORY = 'workflows';

/** The path of the definition directory from the checkout, with `/` separators. */
const DEFINITIONS_FILE = `${DOT_DIRECTORY}/${WORKFLOWS_DIRECTORY}`;

/** The name suffix of a definition file. The read ignores each other entry. */
const DEFINITION_SUFFIX = '.json';

/** The largest definition file that the read accepts, in bytes. */
const MAX_DEFINITION_BYTES = 262144;

/** The number of finding lines that a refusal message lists. The message gives the count of the rest. */
const MESSAGE_FINDING_LIMIT = 5;

/** The only error code of a directory `lstat` that means absence. */
const ABSENT_CODE = 'ENOENT';

/** Where a registered definition comes from: the built-in roster, or one file of the checkout. */
export type DefinitionSource = { readonly kind: 'built-in' } | { readonly kind: 'checkout'; readonly file: string };

/** One registered definition, with the digest that the add path compares. */
export interface RegisteredDefinition {
  /** The roster name of a built-in type, or the kernel `name` of a user file. */
  readonly workflowType: string;
  readonly source: DefinitionSource;
  /** The content digest of the whole definition, with its extension. */
  readonly digest: string;
  readonly definition: ExarchosDefinition;
}

/** One finding of the read of a checkout. */
export interface RegistryFinding {
  /** The path of the file from the checkout, with `/` separators. */
  readonly file: string;
  readonly rule: string;
  /** The keys from the root of the document. A `duplicate-name` finding holds the earlier file as its one key. */
  readonly path: readonly (string | number)[];
}

/** The three file reads of the registry. Production uses `node:fs/promises`, and a test passes its own reads. */
export interface DefinitionReads {
  readonly lstat: (file: string) => Promise<Stats>;
  readonly readdir: (dir: string) => Promise<string[]>;
  readonly readFile: (file: string) => Promise<Buffer>;
}

/** The result of the add path: the entries after the add, or the `duplicate-name` finding. */
export type Registration =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, RegisteredDefinition> }
  | { readonly ok: false; readonly finding: RegistryFinding };

/** The entries and the findings of the read of one checkout. */
export interface CheckoutDefinitions {
  readonly entries: ReadonlyMap<string, RegisteredDefinition>;
  readonly findings: readonly RegistryFinding[];
}

/** The `repository` arm of a repository observation: the root of the work tree and the common dir. */
export type LocatedCheckout = Extract<RepositoryObservation, { readonly kind: 'repository' }>;

/** The result of the locate step of the caller: the located checkout, or the refusal of the locate step. */
export type CheckoutLocation =
  | { readonly ok: true; readonly located: LocatedCheckout }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

/** The input of {@link resolveDefinition}. */
export interface ResolveDefinitionInput {
  readonly streamId: string;
  /** The workflow type of the stream, or `undefined` when the stream records none. */
  readonly workflowType: string | undefined;
  /** The locate step of the caller. The registry runs no git itself. */
  readonly locateCheckout: () => Promise<CheckoutLocation>;
  /** The custom types of the `workflows:` key of the server config. */
  readonly configWorkflowTypes: readonly string[];
  /** The file reads. With no reads, the registry uses `node:fs/promises`. */
  readonly reads?: DefinitionReads;
}

/** The result of {@link resolveDefinition}. A user type also carries the located checkout. */
export type DefinitionResolution =
  | { readonly ok: true; readonly registered: RegisteredDefinition; readonly located?: LocatedCheckout }
  | { readonly ok: false; readonly refusal: PrepareRefusal };

/** The file reads of production. */
const FILE_READS: DefinitionReads = {
  lstat: (file) => lstat(file),
  readdir: (dir) => readdir(dir),
  readFile: (file) => readFile(file),
};

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error code of a failed read, or `unreadable` when the error has no code. */
function errorCodeOf(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'unreadable';
}

/** Compares two names by UTF-16 code unit, so the order does not depend on a locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** The name of a source in a `duplicate-name` finding. */
function sourceName(source: DefinitionSource): string {
  return source.kind === 'checkout' ? source.file : 'built-in';
}

/** A `definition-file` finding. Its path holds one key: the class of the entry, or the error code of the read. */
function fileFinding(file: string, key: string): RegistryFinding {
  return { file, rule: 'definition-file', path: [key] };
}

/**
 * The add path of every definition. A new type adds its entry. The same type with the same digest keeps the held entry.
 * The same type with another digest gives a `duplicate-name` finding. Its file is the new entry, and its path holds the held entry.
 */
export function registerDefinition(
  entries: ReadonlyMap<string, RegisteredDefinition>,
  entry: RegisteredDefinition,
): Registration {
  const held = entries.get(entry.workflowType);
  if (held === undefined) return { ok: true, entries: new Map(entries).set(entry.workflowType, entry) };
  if (held.digest === entry.digest) return { ok: true, entries };
  return {
    ok: false,
    finding: { file: sourceName(entry.source), rule: 'duplicate-name', path: [sourceName(held.source)] },
  };
}

/**
 * Registers the five built-in definitions through the add path, in roster order.
 * @throws When a built-in type registers twice. The roster makes this impossible.
 */
function registerBuiltIns(): ReadonlyMap<string, RegisteredDefinition> {
  let entries: ReadonlyMap<string, RegisteredDefinition> = new Map();
  for (const workflowType of BUILT_IN_WORKFLOW_TYPES) {
    const definition = builtInDefinition(workflowType);
    const registered = registerDefinition(entries, {
      workflowType,
      source: { kind: 'built-in' },
      digest: contentDigest(definition),
      definition,
    });
    if (!registered.ok) throw new Error(`the built-in workflow type '${workflowType}' registers twice`);
    entries = registered.entries;
  }
  return entries;
}

/** The five built-in entries. The module load builds them once from the frozen built-in definitions. */
export const BUILT_IN_ENTRIES: ReadonlyMap<string, RegisteredDefinition> = registerBuiltIns();

/**
 * Reads one directory of the definition path with `lstat`. An `lstat` does not report a link as a directory.
 * So a link or a file gives `not-a-directory`. Only `ENOENT` is absence, and each other error code refuses.
 */
async function directoryFinding(
  checkout: string,
  keys: readonly string[],
  reads: DefinitionReads,
): Promise<RegistryFinding | 'directory' | 'absent'> {
  const file = keys.join('/');
  try {
    const stats = await reads.lstat(path.join(checkout, ...keys));
    return stats.isDirectory() ? 'directory' : fileFinding(file, 'not-a-directory');
  } catch (error) {
    const code = errorCodeOf(error);
    return code === ABSENT_CODE ? 'absent' : fileFinding(file, code);
  }
}

/**
 * Reads and checks one definition file. The entry must be a regular file of at most {@link MAX_DEFINITION_BYTES} bytes.
 * Its bytes must be JSON, and the document must pass the user rules on the one check path.
 */
async function readDefinitionFile(
  checkout: string,
  name: string,
  reads: DefinitionReads,
): Promise<{ readonly ok: true; readonly definition: ExarchosDefinition } | { readonly ok: false; readonly findings: readonly RegistryFinding[] }> {
  const file = `${DEFINITIONS_FILE}/${name}`;
  const full = path.join(checkout, DOT_DIRECTORY, WORKFLOWS_DIRECTORY, name);
  let bytes: Buffer;
  try {
    const stats = await reads.lstat(full);
    if (!stats.isFile()) return { ok: false, findings: [fileFinding(file, 'not-a-regular-file')] };
    if (stats.size > MAX_DEFINITION_BYTES) return { ok: false, findings: [fileFinding(file, 'size')] };
    bytes = await reads.readFile(full);
  } catch (error) {
    return { ok: false, findings: [fileFinding(file, errorCodeOf(error))] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, findings: [{ file, rule: 'definition-json', path: [] }] };
  }
  const checked = checkUserDefinition(raw);
  if (checked.ok) return { ok: true, definition: checked.definition };
  return { ok: false, findings: checked.findings.map((finding) => ({ file, rule: finding.rule, path: finding.path })) };
}

/**
 * Reads the user definitions of a checkout from `.exarchos/workflows/`. It reads each top-level `*.json` entry in code-unit name order.
 * It checks each file with the user rules, then it registers each valid file through the add path.
 * A checkout with no `.exarchos` or no `workflows` directory gives no entry and no finding.
 */
export async function readCheckoutDefinitions(
  checkout: string,
  reads: DefinitionReads = FILE_READS,
): Promise<CheckoutDefinitions> {
  for (const keys of [[DOT_DIRECTORY], [DOT_DIRECTORY, WORKFLOWS_DIRECTORY]]) {
    const directory = await directoryFinding(checkout, keys, reads);
    if (directory === 'absent') return { entries: new Map(), findings: [] };
    if (directory !== 'directory') return { entries: new Map(), findings: [directory] };
  }
  let names: string[];
  try {
    names = await reads.readdir(path.join(checkout, DOT_DIRECTORY, WORKFLOWS_DIRECTORY));
  } catch (error) {
    return { entries: new Map(), findings: [fileFinding(DEFINITIONS_FILE, errorCodeOf(error))] };
  }
  let entries: ReadonlyMap<string, RegisteredDefinition> = new Map();
  const findings: RegistryFinding[] = [];
  for (const name of names.filter((entry) => entry.endsWith(DEFINITION_SUFFIX)).sort(compareCodeUnits)) {
    const read = await readDefinitionFile(checkout, name, reads);
    if (!read.ok) {
      findings.push(...read.findings);
      continue;
    }
    const registered = registerDefinition(entries, {
      workflowType: read.definition.name,
      source: { kind: 'checkout', file: `${DEFINITIONS_FILE}/${name}` },
      digest: contentDigest(read.definition),
      definition: read.definition,
    });
    if (registered.ok) entries = registered.entries;
    else findings.push(registered.finding);
  }
  return { entries, findings };
}

/** A `WORKFLOW_TYPE_UNSUPPORTED` refusal whose first line names its finding. */
function unsupported(finding: string, text: string, lines: readonly string[] = []): DefinitionResolution {
  const message = [`${text} (finding: ${finding})`, ...lines].join('\n');
  return { ok: false, refusal: { code: 'WORKFLOW_TYPE_UNSUPPORTED', message } };
}

/** The lines `<file> <rule> <path>` of at most {@link MESSAGE_FINDING_LIMIT} findings, then the count of the rest. */
function findingLines(findings: readonly RegistryFinding[]): string[] {
  const lines = findings.slice(0, MESSAGE_FINDING_LIMIT).map((finding) =>
    [finding.file, finding.rule, finding.path.join('.')].filter((part) => part.length > 0).join(' '),
  );
  const rest = findings.length - MESSAGE_FINDING_LIMIT;
  return rest > 0 ? [...lines, `and ${rest} more`] : lines;
}

/**
 * Resolves the workflow type of a stream to one registered definition, or to a refusal of prepare.
 * A stream with no type refuses, and a built-in type gives its entry with no read.
 * A type of the `workflows:` key of the server config refuses before the locate step and the read.
 * Each other type runs the locate step, then the read of the checkout. A locate refusal passes through unchanged.
 */
export async function resolveDefinition(input: ResolveDefinitionInput): Promise<DefinitionResolution> {
  const { streamId, workflowType } = input;
  if (workflowType === undefined) {
    return unsupported('untyped', `prepare compiles a registered workflow definition, and '${streamId}' records no workflow type`);
  }
  const builtIn = BUILT_IN_ENTRIES.get(workflowType);
  if (builtIn !== undefined) return { ok: true, registered: builtIn };
  if (input.configWorkflowTypes.includes(workflowType)) {
    return unsupported(
      'config-workflow',
      `'${streamId}' is a '${workflowType}' workflow, and the workflows: key of the server config declares that type. ` +
        'prepare compiles no type of the workflows: key, because that key retires in v3.0. ' +
        'A definition file under .exarchos/workflows/ replaces it',
    );
  }
  const location = await input.locateCheckout();
  if (!location.ok) return { ok: false, refusal: location.refusal };
  const { located } = location;
  const directory = path.join(located.toplevel, DOT_DIRECTORY, WORKFLOWS_DIRECTORY);
  const read = await readCheckoutDefinitions(located.toplevel, input.reads);
  if (read.findings.length > 0) {
    return unsupported(
      'definition-invalid',
      `the workflow definitions under ${directory} fail their checks, so no user workflow type of '${streamId}' resolves`,
      findingLines(read.findings),
    );
  }
  const registered = read.entries.get(workflowType);
  if (registered !== undefined) return { ok: true, registered, located };
  return unsupported(
    'no-definition',
    `no registered definition declares the workflow type '${workflowType}' of '${streamId}'. ` +
      `It is not a built-in type, and no file under ${directory} declares it`,
  );
}
