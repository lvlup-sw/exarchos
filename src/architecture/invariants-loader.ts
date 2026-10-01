/**
 * Loader for the machine-readable invariants catalog, such as `.exarchos/invariants.md`.
 * The frontmatter is the source of truth. This module parses it into typed
 * `InvariantEntry` values. Unknown fields stay on `raw`.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import type { ExarchosConfigInput } from '../config/exarchos-config-schema.js';
import { FullExarchosConfigSchema } from '../config/yaml-schema.js';
import {
  InvariantEntryV3Schema,
  type Enforcement,
  type InvariantEntryV3,
} from './invariant-schema.js';
import { resolveCatalogSources } from './catalog-sources.js';

/**
 * Schema versions the loader accepts. Version 3 adds the optional affinity,
 * enforcement, severity, and integrity-class fields. A catalog with no
 * `schema-version` loads, for old fixtures. A declared value outside this set throws.
 */
const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [2, 3] as const;

/** Values of the `cost-of-load` frontmatter field. The `core` scope keeps only `always-load` entries. */
export type CostOfLoad = 'always-load' | 'reference-only' | 'archivable';

const COST_OF_LOAD_VALUES: readonly CostOfLoad[] = [
  'always-load',
  'reference-only',
  'archivable',
] as const;

/**
 * Values of the `scope` option of `loadInvariants`:
 *   - `core`: substrate-axis entries with `cost-of-load: always-load`.
 *   - `substrate`: every substrate-axis entry.
 *   - `authoring`: every authoring-axis entry.
 *   - `all`: every entry. This is the default.
 */
export type InvariantsScope = 'core' | 'substrate' | 'authoring' | 'all';

const SCOPE_VALUES: readonly InvariantsScope[] = [
  'core',
  'substrate',
  'authoring',
  'all',
] as const;

/**
 * Values of the `axis` frontmatter field. A `substrate` entry describes a
 * runtime property. An `authoring` entry describes a prose or documentation concern.
 */
export type InvariantAxis = 'substrate' | 'authoring';

const AXIS_VALUES: readonly InvariantAxis[] = ['substrate', 'authoring'] as const;

export interface InvariantEntry {
  /** Stable identifier and primary key of the entry, such as `basileus-boundary`. */
  id: string;
  /** Short human-readable category name. */
  dimension: string;
  /** Axis classification. The loader throws when it is missing. */
  axis: InvariantAxis;
  /** Load-cost classification. See `CostOfLoad`. */
  costOfLoad: CostOfLoad;
  /** Surface areas (modules, file globs, capability domains) the invariant covers. */
  appliesTo: string[];
  /** One-to-two-sentence statement of the invariant. */
  summary: string;
  /** Pointers to source files where the invariant is detailed in prose. */
  references: string[];
  /** External research citations. `undefined` when not declared, which differs from a declared `[]`. */
  citations?: string[];
  /** SDLC phases this invariant applies to. `undefined` when `phase-affinity` is absent. */
  phaseAffinity?: NonNullable<InvariantEntryV3['phase-affinity']>;
  /** Workflow kinds this invariant applies to. `undefined` when `workflow-affinity` is absent. */
  workflowAffinity?: NonNullable<InvariantEntryV3['workflow-affinity']>;
  /** Workflow-state names this invariant applies to. `undefined` when `state-affinity` is absent. */
  stateAffinity?: NonNullable<InvariantEntryV3['state-affinity']>;
  /**
   * Declarative enforcement directive, validated by the `.strict()` combinator DSL
   * in `InvariantEntryV3Schema`. `undefined` when `enforcement` is absent.
   */
  enforcement?: Enforcement;
  /** Per-context severity overrides. `undefined` when `severity` is absent. */
  severity?: NonNullable<InvariantEntryV3['severity']>;
  /** Integrity-class classification. `undefined` when `integrity-class` is absent. */
  integrityClass?: NonNullable<InvariantEntryV3['integrity-class']>;
  /**
   * The catalog layer of the entry, which `mergeCatalogs` sets: `dev` (the maintainer
   * catalog, which owns the `INV-*` namespace), `sdlc` (the compiled-in baseline), or
   * `user` (a registered consumer catalog). Reserved-namespace authority uses this tier,
   * not the array position. A newly loaded entry has no tier.
   */
  tier?: 'dev' | 'sdlc' | 'user';
  /** The raw parsed entry for fields not yet promoted to the typed shape. */
  raw: Record<string, unknown>;
}

/** Untyped shape of one catalog entry from `gray-matter`. `parseEntry` validates it. */
interface RawInvariantEntry {
  id?: unknown;
  dimension?: unknown;
  axis?: unknown;
  'cost-of-load'?: unknown;
  'applies-to'?: unknown;
  summary?: unknown;
  references?: unknown;
  citations?: unknown;
  [key: string]: unknown;
}

/** Untyped shape of the file frontmatter from `gray-matter`. `loadInvariants` validates it. */
interface RawFrontmatter {
  'schema-version'?: unknown;
  invariants?: unknown;
  [key: string]: unknown;
}

/** Parses a YAML field as `string[]`. Throws with the entry id and field name on a shape mismatch. */
function asStringArray(value: unknown, field: string, id: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `invariants-loader: entry "${id}" field "${field}" must be an array, got ${typeof value}`,
    );
  }
  return value.map((v, i) => {
    if (typeof v !== 'string') {
      throw new Error(
        `invariants-loader: entry "${id}" field "${field}"[${i}] must be a string`,
      );
    }
    return v;
  });
}

/** Parses a YAML field as `string` and collapses folded-scalar whitespace. Throws on a mismatch. */
function asString(value: unknown, field: string, id: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `invariants-loader: entry "${id}" field "${field}" must be a string, got ${typeof value}`,
    );
  }
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parses and validates `axis`, with no default. A missing or invalid value throws.
 * The error names the entry, the field, and the allowed values, so an editor can fix
 * the catalog without the spec.
 */
function parseAxis(value: unknown, id: string): InvariantAxis {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Invariant entry '${id}' is missing required 'axis' field ` +
        `(schema-version: 2 requires explicit ` +
        `${AXIS_VALUES.join('|')})`,
    );
  }
  if (!(AXIS_VALUES as readonly string[]).includes(value)) {
    throw new Error(
      `Invariant entry '${id}' has invalid 'axis' value '${value}'; ` +
        `must be one of ${AXIS_VALUES.map((v) => `'${v}'`).join(', ')}`,
    );
  }
  return value as InvariantAxis;
}

/** Parses and validates `cost-of-load`, with no default. A missing or invalid value throws. */
function parseCostOfLoad(value: unknown, id: string): CostOfLoad {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `invariants-loader: entry "${id}" is missing required field "cost-of-load" ` +
        `(must be one of ${COST_OF_LOAD_VALUES.map((v) => `'${v}'`).join(', ')})`,
    );
  }
  if (!(COST_OF_LOAD_VALUES as readonly string[]).includes(value)) {
    throw new Error(
      `invariants-loader: entry "${id}" has invalid "cost-of-load" value '${value}'; ` +
        `must be one of ${COST_OF_LOAD_VALUES.map((v) => `'${v}'`).join(', ')}`,
    );
  }
  return value as CostOfLoad;
}

/** Validates one raw entry and projects it to `InvariantEntry`. A raw copy stays on `raw`. */
function parseEntry(raw: RawInvariantEntry): InvariantEntry {
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error('invariants-loader: entry is missing required field "id"');
  }
  const id = raw.id;
  const entry: InvariantEntry = {
    id,
    dimension: asString(raw.dimension, 'dimension', id),
    axis: parseAxis(raw.axis, id),
    costOfLoad: parseCostOfLoad(raw['cost-of-load'], id),
    appliesTo: asStringArray(raw['applies-to'], 'applies-to', id),
    summary: asString(raw.summary, 'summary', id),
    references: asStringArray(raw.references, 'references', id),
    raw: { ...raw },
  };
  if (raw.citations !== undefined) {
    entry.citations = asStringArray(raw.citations, 'citations', id);
  }
  projectV3Fields(raw, entry);
  return entry;
}

/**
 * The optional schema-v3 fields of `InvariantEntryV3Schema`. The pick leaves the v2
 * checks, with their tested error messages, as the authority for the v2 fields.
 */
const V3_FIELD_SCHEMA = InvariantEntryV3Schema.pick({
  'phase-affinity': true,
  'workflow-affinity': true,
  'state-affinity': true,
  enforcement: true,
  severity: true,
  'integrity-class': true,
});

/**
 * Validates the optional v3 fields, including the `.strict()` enforcement DSL, and
 * copies each declared field onto `entry`. An absent field stays `undefined`.
 */
function projectV3Fields(raw: RawInvariantEntry, entry: InvariantEntry): void {
  const v3 = V3_FIELD_SCHEMA.parse(raw);
  if (v3['phase-affinity'] !== undefined) entry.phaseAffinity = v3['phase-affinity'];
  if (v3['workflow-affinity'] !== undefined) {
    entry.workflowAffinity = v3['workflow-affinity'];
  }
  if (v3['state-affinity'] !== undefined) entry.stateAffinity = v3['state-affinity'];
  if (v3.enforcement !== undefined) entry.enforcement = v3.enforcement;
  if (v3.severity !== undefined) entry.severity = v3.severity;
  if (v3['integrity-class'] !== undefined) entry.integrityClass = v3['integrity-class'];
}

/**
 * The primary-key rule of the catalog. Returns the first id that occurs more than
 * once in `ids`, or `undefined` when every id is unique. The loader and the
 * `invariants` add and amend verbs share it, so the read and write paths cannot drift.
 *
 * An empty list is unique. This function cannot tell "no entries" from "could not
 * read the entries", so a caller must prove that it read its entries first.
 */
export function findDuplicateInvariantId(
  ids: Iterable<string>,
): string | undefined {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

/**
 * The rejection text for a duplicate id. The writer and the loader share it, so both
 * give the same message.
 */
export function duplicateInvariantIdMessage(id: string): string {
  return `Duplicate invariant ID: ${id}`;
}

/**
 * Pure raw-to-typed projection of a list of catalog entries. It does no file I/O,
 * version check, registration check, or scope filter. A non-object entry throws
 * with its index. A duplicate id throws, because it hides the earlier entry.
 * `loadInvariants` and `sdlc-catalog.ts` share this path, so the two cannot drift.
 */
export function parseInvariantEntries(rawEntries: unknown): InvariantEntry[] {
  if (!Array.isArray(rawEntries)) {
    throw new Error(
      'invariants-loader: parseInvariantEntries expects an array of entries',
    );
  }
  const entries = rawEntries.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        `invariants-loader: entry at index ${index} must be an object`,
      );
    }
    return parseEntry(raw as RawInvariantEntry);
  });
  const duplicate = findDuplicateInvariantId(entries.map((e) => e.id));
  if (duplicate !== undefined) {
    throw new Error(duplicateInvariantIdMessage(duplicate));
  }
  return entries;
}

/**
 * Reads the `invariants:` block from the closest `.exarchos.yml` above the catalog
 * file. Returns `{}` when no file is found or the block is absent. Then nothing is
 * registered, and `loadInvariants` returns no entries.
 */
export function readInvariantsConfig(catalogFilePath: string): ExarchosConfigInput {
  return discoverInvariantsConfig(catalogFilePath).config;
}

/**
 * The `.exarchos.yml` that a catalog file resolves against, and the directory of
 * that file. Registrations in `invariants.catalogs` are relative to this directory.
 * `root` is `undefined` when no config file exists.
 */
interface DiscoveredInvariantsConfig {
  config: ExarchosConfigInput;
  root: string | undefined;
}

/**
 * Walks up from the catalog file to the first `.exarchos.yml` or `.exarchos.yaml`.
 * The walk stops at the filesystem root.
 */
function discoverInvariantsConfig(
  catalogFilePath: string,
): DiscoveredInvariantsConfig {
  let dir = path.dirname(path.resolve(catalogFilePath));
  while (true) {
    for (const filename of ['.exarchos.yml', '.exarchos.yaml']) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return { config: parseInvariantsBlock(candidate), root: dir };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { config: {}, root: undefined };
    dir = parent;
  }
}

/**
 * Canonical form for path comparison: `.` and `..` collapsed, `/`-separated, and
 * no trailing slash. The same expression runs on POSIX and Windows, with no
 * platform branch, so the comparison has one behavior on both.
 */
function canonicalPath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/**
 * Returns true when the config registers `filePath` in `invariants.catalogs`.
 * `resolveCatalogSources` decides what a registration is.
 *
 * A relative registration resolves against `configRoot`. Without `configRoot`, it
 * matches a segment-aligned path suffix: `.exarchos/invariants.md` matches
 * `<any-dir>/.exarchos/invariants.md`, but not `<any-dir>/my.exarchos/invariants.md`.
 *
 * @param filePath Catalog file that the caller asks to load.
 * @param config Effective config, injected or read from disk.
 * @param configRoot Directory that registrations are relative to, when known.
 */
export function isCatalogRegistered(
  filePath: string,
  config: ExarchosConfigInput | undefined,
  configRoot?: string | undefined,
): boolean {
  const target = canonicalPath(path.resolve(filePath));
  return resolveCatalogSources(config).some((source) => {
    if (path.isAbsolute(source.path)) {
      return canonicalPath(path.resolve(source.path)) === target;
    }
    if (configRoot !== undefined) {
      return canonicalPath(path.resolve(configRoot, source.path)) === target;
    }
    const relative = canonicalPath(source.path);
    return target === relative || target.endsWith(`/${relative}`);
  });
}

/**
 * Extracts the `invariants:` block from a `.exarchos.yml` file. It validates the
 * whole document against `FullExarchosConfigSchema`, as `loadExarchosConfig` does,
 * so both readers reach the same verdict on a file.
 *
 * This function does not throw. A read error, a parse error, a document that is not
 * valid, or an absent block returns `{}`.
 */
function parseInvariantsBlock(configPath: string): ExarchosConfigInput {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const doc = parseYaml(raw);
    const candidate: unknown =
      doc === null || doc === undefined ? {} : doc;
    if (typeof candidate !== 'object' || Array.isArray(candidate)) {
      return {};
    }
    const result = FullExarchosConfigSchema.safeParse(candidate);
    if (!result.success) {
      return {};
    }
    const invariants = result.data.invariants;
    return invariants === undefined ? {} : { invariants };
  } catch {
    return {};
  }
}

/**
 * Loads and parses the invariants catalog from a Markdown file. It returns `[]`
 * unless the effective config registers the file in `invariants.catalogs`. The
 * registration check runs before the scope filter, so no scope can bypass it. The
 * Exarchos repo gets its catalog the same way: its `.exarchos.yml` registers it.
 *
 * @param filePath Absolute path to the catalog file.
 * @param opts `scope` filters the entries (see `InvariantsScope`). An unknown scope
 *   throws. `configRoot` is the directory that relative registrations of an injected
 *   config resolve against. Without it, a relative registration matches by path suffix.
 * @param config Explicit config. Without it, the loader reads the closest `.exarchos.yml`.
 */
export function loadInvariants(
  filePath: string,
  opts?: { scope?: InvariantsScope; configRoot?: string },
  config?: ExarchosConfigInput,
): InvariantEntry[] {
  const discovered =
    config === undefined ? discoverInvariantsConfig(filePath) : undefined;
  const effectiveConfig = config ?? discovered?.config ?? {};
  if (
    !isCatalogRegistered(
      filePath,
      effectiveConfig,
      opts?.configRoot ?? discovered?.root,
    )
  ) {
    return [];
  }
  const scope: InvariantsScope = opts?.scope ?? 'all';
  if (!(SCOPE_VALUES as readonly string[]).includes(scope)) {
    throw new Error(
      `invariants-loader: invalid scope '${scope}'; ` +
        `must be one of ${SCOPE_VALUES.map((v) => `'${v}'`).join(', ')}`,
    );
  }
  const source = fs.readFileSync(filePath, 'utf8');
  const parsed = matter(source);
  const data = parsed.data as RawFrontmatter;
  const declaredVersion = data['schema-version'];
  if (declaredVersion !== undefined && declaredVersion !== null) {
    if (
      typeof declaredVersion !== 'number' ||
      !SUPPORTED_SCHEMA_VERSIONS.includes(declaredVersion)
    ) {
      throw new Error(
        `invariants-loader: ${filePath} declares unsupported ` +
          `schema-version '${String(declaredVersion)}'; ` +
          `must be one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
      );
    }
  }
  if (!Array.isArray(data.invariants)) {
    throw new Error(
      `invariants-loader: ${filePath} frontmatter must declare an "invariants:" array`,
    );
  }
  const entries = parseInvariantEntries(data.invariants);
  switch (scope) {
    case 'core':
      return entries.filter(
        (e) => e.axis === 'substrate' && e.costOfLoad === 'always-load',
      );
    case 'substrate':
      return entries.filter((e) => e.axis === 'substrate');
    case 'authoring':
      return entries.filter((e) => e.axis === 'authoring');
    case 'all':
      return entries;
  }
}

/** Returns the `core` scope: `loadInvariants(filePath, { scope: 'core' }, config)`. */
export function loadCoreInvariants(
  filePath: string,
  config?: ExarchosConfigInput,
): InvariantEntry[] {
  return loadInvariants(filePath, { scope: 'core' }, config);
}

/**
 * Returns the set of invariant ids for the vocabulary-lint cross-check. When the
 * config does not register the catalog, the set is empty. Then vocabulary-lint
 * treats every `INV-*` token as unknown.
 */
export function loadInvariantIds(
  filePath: string,
  config?: ExarchosConfigInput,
): Set<string> {
  return new Set(loadInvariants(filePath, undefined, config).map((e) => e.id));
}
