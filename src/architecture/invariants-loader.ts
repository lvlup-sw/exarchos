/**
 * Loader for the machine-readable invariants catalog at
 * `.exarchos/invariants.md` (the dev catalog, relocated from
 * `docs/architecture/invariants.md` in T19; issue #1260).
 *
 * The frontmatter is the source of truth; this module parses it into a typed
 * `InvariantEntry[]` for consumption by `/ideate` first-turn surfacing, the
 * vocabulary-lint scanner, and the `check_invariant_conformance` gate (which
 * replaced the retired `design-invariants` skill in T-23).
 *
 * Implementation note: we use `gray-matter` (already a devDependency of the
 * MCP server) which sits on top of `js-yaml`. The loader is intentionally
 * tolerant — unknown fields are preserved on `raw` but typed accessors map
 * the documented shape.
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
 * Schema versions the loader accepts (DR-1). The catalog frontmatter may
 * declare `schema-version: 2` (the live v2 catalog) or `3` (the v3 catalog
 * that layers optional affinity / enforcement / severity / integrity-class
 * fields). An absent `schema-version` is tolerated for back-compat with
 * pre-v2 fixtures; any *declared* value outside this set is a loud parse
 * error (no silent acceptance of an unknown schema — DIM-2 contract).
 */
const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [2, 3] as const;

/**
 * Allowed values for the `cost-of-load` frontmatter field. Drives the
 * `/ideate` Phase 0 split between core entries surfaced by default and
 * reference-only entries loaded on-demand.
 */
export type CostOfLoad = 'always-load' | 'reference-only' | 'archivable';

const COST_OF_LOAD_VALUES: readonly CostOfLoad[] = [
  'always-load',
  'reference-only',
  'archivable',
] as const;

/**
 * Allowed values for the `scope` argument to `loadInvariants` (schema-v2).
 * Drives the v2 filter (spec §4.1, §4.2) that intersects axis with
 * `cost-of-load`:
 *
 *   - `'core'`      — axis=substrate AND cost-of-load=always-load
 *                     (the `/ideate` Phase 0 working set)
 *   - `'substrate'` — every entry on the substrate axis (any cost-of-load)
 *   - `'authoring'` — every entry on the authoring axis (empty after the
 *                     #1477 axiom excision removed the sole authoring entry)
 *   - `'all'`       — every entry (default, backwards-compat with v1)
 */
export type InvariantsScope = 'core' | 'substrate' | 'authoring' | 'all';

const SCOPE_VALUES: readonly InvariantsScope[] = [
  'core',
  'substrate',
  'authoring',
  'all',
] as const;

/**
 * Allowed values for the `axis` frontmatter field introduced in schema-v2.
 * `substrate` entries describe runtime-substrate properties; `authoring`
 * entries describe prose / documentation concerns. The `authoring` axis is
 * retained in the type for forward-compat, though no live entry declares it
 * after the #1477 axiom excision removed the sole authoring (DIM-8) entry.
 * Drives the v2 scope filter (Wave D1) which intersects axis with
 * `cost-of-load` for `scope: 'core'`.
 */
export type InvariantAxis = 'substrate' | 'authoring';

const AXIS_VALUES: readonly InvariantAxis[] = ['substrate', 'authoring'] as const;

export interface InvariantEntry {
  /** Stable identifier — e.g. "INV-1", "INV-5a", "basileus-boundary". */
  id: string;
  /** Short human-readable category name. */
  dimension: string;
  /**
   * Axis classification (schema-v2). Either `'substrate'` (runtime
   * substrate property) or `'authoring'` (prose / documentation concern).
   * Required for every entry under schema-v2; the loader throws on missing.
   */
  axis: InvariantAxis;
  /** Load-cost classification (drives Phase 0 surfacing — see `CostOfLoad`). */
  costOfLoad: CostOfLoad;
  /** Surface areas (modules, file globs, capability domains) the invariant covers. */
  appliesTo: string[];
  /** One-to-two-sentence statement of the invariant. */
  summary: string;
  /** Pointers to source files where the invariant is detailed in prose. */
  references: string[];
  /**
   * External research citations (schema-v2). Optional — recommended ≥3
   * entries for substrate-axis invariants; v1-era entries (pre-C4..C11)
   * typically omit it. Undefined when not declared (distinct from
   * declared-empty `[]`).
   */
  citations?: string[];
  /**
   * SDLC phases this invariant is relevant to (schema-v3, DR-1). Optional;
   * `undefined` when the entry does not declare `phase-affinity`. Element
   * type and validation come from `InvariantEntryV3Schema`.
   */
  phaseAffinity?: NonNullable<InvariantEntryV3['phase-affinity']>;
  /**
   * Workflow kinds this invariant is relevant to (schema-v3, DR-1).
   * Optional; `undefined` when `workflow-affinity` is absent.
   */
  workflowAffinity?: NonNullable<InvariantEntryV3['workflow-affinity']>;
  /**
   * Workflow-state names this invariant is relevant to (schema-v3, DR-1).
   * Optional; `undefined` when `state-affinity` is absent.
   */
  stateAffinity?: NonNullable<InvariantEntryV3['state-affinity']>;
  /**
   * Declarative enforcement directive (schema-v3, DR-1/DR-2). Optional;
   * `undefined` when `enforcement` is absent. Shape validated by the
   * `.strict()` combinator DSL in `InvariantEntryV3Schema`.
   */
  enforcement?: Enforcement;
  /**
   * Per-context severity overrides (schema-v3, DR-1). Optional; `undefined`
   * when `severity` is absent.
   */
  severity?: NonNullable<InvariantEntryV3['severity']>;
  /**
   * Integrity-class classification (schema-v3, DR-1). Optional; `undefined`
   * when `integrity-class` is absent.
   */
  integrityClass?: NonNullable<InvariantEntryV3['integrity-class']>;
  /**
   * Source-layer tier, assigned by `mergeCatalogs` (P1 T4). Identifies which
   * catalog layer an entry came from: `'dev'` (built-in/maintainer dev
   * catalog, owns the `INV-*` namespace), `'sdlc'` (the compiled-in SDLC-*
   * baseline), or `'user'` (a consumer-registered catalog). Reserved-namespace
   * authority is keyed off this tier rather than off array position. Absent on
   * a freshly-loaded entry; set during the merge.
   */
  tier?: 'dev' | 'sdlc' | 'user';
  /** The raw parsed entry for fields not yet promoted to the typed shape. */
  raw: Record<string, unknown>;
}

/** Untyped shape returned by `gray-matter` for a single catalog entry — validated by `parseEntry`. */
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

/** Untyped shape returned by `gray-matter` for the file frontmatter — validated by `loadInvariants`. */
interface RawFrontmatter {
  'schema-version'?: unknown;
  invariants?: unknown;
  [key: string]: unknown;
}

/** Parse a YAML field as `string[]`; throws with `entry-id + field-name` context on shape mismatch. */
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

/** Parse a YAML field as `string`; collapses folded-scalar whitespace; throws on shape mismatch. */
function asString(value: unknown, field: string, id: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `invariants-loader: entry "${id}" field "${field}" must be a string, got ${typeof value}`,
    );
  }
  // Collapse YAML folded-scalar whitespace so consumers get clean prose.
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parse + validate `axis` (schema-v2); throws loudly on missing or invalid
 * value (no silent default — DIM-2 contract). Required for every entry
 * under schema-version: 2.
 */
function parseAxis(value: unknown, id: string): InvariantAxis {
  if (typeof value !== 'string' || value.length === 0) {
    // Phrasing per plan D2 GREEN: name the entry id, the field, and cite
    // the schema-version + allowed values so catalog editors can fix the
    // omission without consulting the spec. Closes the v1-fixture regression
    // hole (no silent default — DIM-2 contract).
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

/** Parse + validate `cost-of-load`; throws loudly on missing or invalid value (no silent default — DIM-2 contract). */
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

/** Validate one raw entry and project to the typed `InvariantEntry`; preserves the raw shape for unknown-field forward-compat. */
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
  // Optional schema-v2 field — only project when declared so the typed
  // accessor preserves the "not declared" distinction (undefined vs []).
  if (raw.citations !== undefined) {
    entry.citations = asStringArray(raw.citations, 'citations', id);
  }
  // Optional schema-v3 fields (DR-1) — project through the Zod
  // `InvariantEntryV3Schema` source of truth so the v3 shape is validated
  // (incl. the `.strict()` enforcement-DSL sandbox guarantee, INV-4) without
  // being redefined here. Only declared fields are surfaced; absent fields
  // resolve to `undefined`, preserving full v2 back-compat.
  projectV3Fields(raw, entry);
  return entry;
}

/**
 * Validate and project the optional schema-v3 fields onto an already-built
 * `InvariantEntry`. Reuses `InvariantEntryV3Schema` (DR-1) so the v3 shape —
 * including the `.strict()` enforcement combinator DSL (INV-4 sandbox
 * guarantee) — is enforced at load time. Each field is only assigned when
 * declared, so absent fields stay `undefined` (v2 back-compat).
 *
 * We `.pick()` just the v3 keys rather than parsing the whole entry through
 * the v3 schema: the v2 loader's own required-field validation (with its
 * established, test-asserted error messages) stays the authority for v2
 * fields. This keeps the two validation surfaces decoupled.
 */
const V3_FIELD_SCHEMA = InvariantEntryV3Schema.pick({
  'phase-affinity': true,
  'workflow-affinity': true,
  'state-affinity': true,
  enforcement: true,
  severity: true,
  'integrity-class': true,
});

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

// ─── Catalog primary-key rule (DR-6: ONE authority, read AND write) ─────────
//
// Ids are the catalog's primary key. This rule was previously an inline
// `Set`-based loop inside `parseInvariantEntries` — reachable only from the
// READ path — while `invariants_add` honored an explicit `id` with no
// membership test at all. The writer could therefore author a catalog the
// reader refuses to load (task 068 / DR-24).
//
// It is extracted here, not restated at the write site, so the two paths cannot
// drift: `parseInvariantEntries` (read) and `verbs/invariants/add.ts`
// (write) both call these two functions and nothing else decides id uniqueness.
// A change to what "duplicate" means — case-folding, namespace scoping — moves
// both paths in one edit.

/**
 * The catalog's primary-key rule. Returns the FIRST id that appears more than
 * once in `ids`, or `undefined` when every id is unique.
 *
 * Total over its input: an empty list is vacuously unique. Callers that must
 * not accept a vacuous answer are responsible for proving their denominator
 * RESOLVED before asking (see `readCatalogIds` in
 * `verbs/invariants/add.ts`) — this function cannot distinguish "no
 * entries" from "could not read the entries", and must not pretend to.
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
 * The wire-visible rejection text for a primary-key violation. Shared so the
 * writer's refusal and the loader's throw are the same sentence — a caller
 * matching on this string sees one message regardless of which path produced
 * it.
 */
export function duplicateInvariantIdMessage(id: string): string {
  return `Duplicate invariant ID: ${id}`;
}

/**
 * Pure raw→typed projection for a list of catalog entries (no file-IO, no
 * `schema-version` guard, no `devCatalog` gate, no scope filter). Validates and
 * projects each raw entry via `parseEntry` (which enforces the v2 required
 * fields and the v3 `.strict()` enforcement DSL, INV-4) and rejects duplicate
 * ids — the same primary-key guarantee `loadInvariants` relies on.
 *
 * This is the single parse path shared by the file loader (`loadInvariants`)
 * and the inline plugin-shipped sdlc catalog (`sdlc-catalog.ts`, #1467), so the
 * two cannot drift (INV-2 spirit).
 */
export function parseInvariantEntries(rawEntries: unknown): InvariantEntry[] {
  if (!Array.isArray(rawEntries)) {
    throw new Error(
      'invariants-loader: parseInvariantEntries expects an array of entries',
    );
  }
  // Guard each element before parseEntry so a null/primitive entry yields a
  // clear, index-named loader error instead of a generic TypeError deep in the
  // parser. For the disk/consumer layers this surfaces as a DR-9 degradation
  // warning naming the catalog rather than an opaque crash.
  const entries = rawEntries.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        `invariants-loader: entry at index ${index} must be an object`,
      );
    }
    return parseEntry(raw as RawInvariantEntry);
  });
  // Reject duplicate IDs — IDs are the catalog's primary key and must be
  // unique. A silent duplicate would shadow the earlier entry and corrupt
  // vocabulary-lint / ideate Constraint surfacing. The rule itself lives in
  // `findDuplicateInvariantId` so the WRITE path enforces the identical
  // predicate rather than a second copy of it (DR-6 / task 068).
  const duplicate = findDuplicateInvariantId(entries.map((e) => e.id));
  if (duplicate !== undefined) {
    throw new Error(duplicateInvariantIdMessage(duplicate));
  }
  return entries;
}

/**
 * Read the `invariants:` block from the closest `.exarchos.yml` walking up
 * from the catalog file. Returns `{}` when no file is found or when the
 * YAML lacks the `invariants` key — both cases collapse to "nothing is
 * registered", hence an empty load at `loadInvariants` (DR-31).
 *
 * Implementation note: we intentionally do NOT route through
 * `loadExarchosConfig` because that function validates the *entire*
 * `.exarchos.yml` against `ExarchosConfigSchema.strict()` — the committed
 * root file also carries `agents:` / `review:` / `workflow:` keys validated
 * by the parallel `ProjectConfigSchema`, so a strict full-file parse would
 * throw on the unrelated keys. Extracting the `invariants` block in
 * isolation keeps this loader decoupled from the other schemas' shape.
 *
 * The walk-up is bounded by the filesystem root; we stop at the first hit.
 */
export function readInvariantsConfig(catalogFilePath: string): ExarchosConfigInput {
  return discoverInvariantsConfig(catalogFilePath).config;
}

/**
 * The `.exarchos.yml` a catalog file resolves against: the parsed config plus
 * the DIRECTORY that file lives in.
 *
 * The directory matters for DR-31 gating: `invariants.catalogs` registrations
 * are written relative to the config file, so "is this file registered?" can
 * only be answered by resolving those registrations against that directory.
 * `root` is `undefined` when no config file was found (nothing is registered,
 * so nothing loads).
 */
interface DiscoveredInvariantsConfig {
  config: ExarchosConfigInput;
  root: string | undefined;
}

function discoverInvariantsConfig(
  catalogFilePath: string,
): DiscoveredInvariantsConfig {
  let dir = path.dirname(path.resolve(catalogFilePath));
  // Bounded walk-up: stop at filesystem root.
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
 * Canonical form for path comparison: absolute-ized, `.`/`..` collapsed, and
 * `/`-separated with no trailing slash.
 *
 * The separator normalization is deliberate and is NOT a platform branch: the
 * same expression runs on POSIX and Windows, so the comparison below has
 * exactly one behavior on both. (A `process.platform` branch here would make
 * the gate live on one OS and dead on the other.)
 */
function canonicalPath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/**
 * DR-31 gate: **is a catalog registered for this file?**
 *
 * This replaces the retired `invariants.devCatalog !== 'enabled'` boolean
 * gate. The question the loader asks is no longer "did someone flip a
 * repo-only flag?" but "does this config register this catalog?" — the same
 * question a consumer's `.exarchos.yml` answers for its own files. Discovery
 * is delegated to `resolveCatalogSources`, so there is exactly ONE place that
 * knows what a registration is.
 *
 * Registrations resolve against `configRoot` (the directory of the
 * `.exarchos.yml` they came from, or the root the caller resolved them
 * against). When the config was injected without a root, the loader cannot
 * know which root the caller used, so a RELATIVE registration matches on a
 * segment-aligned path suffix — `.exarchos/invariants.md` matches
 * `<anyRoot>/.exarchos/invariants.md` but never `<anyRoot>/other.md` and never
 * a partial segment such as `<anyRoot>/my.exarchos/invariants.md`.
 *
 * @param filePath Catalog file the caller is asking to load.
 * @param config Effective config (already-injected or disk-read).
 * @param configRoot Directory registrations are relative to, when known.
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
 * Extract the `invariants:` block from a `.exarchos.yml` file, reconciled
 * with the strict `loadExarchosConfig` reader (#1479).
 *
 * Both readers now validate the *entire* document against the unified
 * `FullExarchosConfigSchema` (the merge of the test-runtime concern and the
 * project concern, see `config/yaml-schema.ts`), so they reach the SAME
 * verdict on any given file: a key valid in either concern is accepted; a
 * genuine typo or a malformed `invariants` block is rejected by both.
 *
 * This loader stays NON-throwing by contract — `loadInvariants` expects a
 * `{}` fallback rather than an exception. So an invalid document degrades to
 * `{}` here (no invariants flag honored), which mirrors `loadExarchosConfig`
 * refusing to return a config for the same file: neither path keeps a bogus
 * invariants block alive. Returns `{}` on read/parse errors or when the
 * `invariants` key is absent; default-disabled at the loader handles both as
 * "no flag set."
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
    // Reconciled verdict: validate the whole file with the same unified
    // schema the strict reader uses. An unknown sibling key or a malformed
    // invariants block fails the parse, and we degrade to "no flag set" —
    // identical observable behavior to the strict reader's rejection.
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
 * Load and parse the invariants catalog from the given Markdown file.
 *
 * **Gating (DR-31): registration, not a boolean.** The loader returns `[]`
 * unless the effective config REGISTERS this file in `invariants.catalogs`
 * (see `isCatalogRegistered`). Gating applies BEFORE any scope filter, so a
 * scope value cannot bypass it. The default reader walks up from the catalog
 * file looking for `.exarchos.yml`; tests and in-process callers may inject an
 * explicit `config` to bypass disk-IO. See `readInvariantsConfig`.
 *
 * This replaces the retired `invariants.devCatalog: 'enabled'` gate, which was
 * a repo-only loading mode no consumer could reproduce. **Behavior change:**
 * `devCatalog: 'disabled'` no longer suppresses a registered catalog — the
 * boolean is inert in either direction; only registration decides. A repo that
 * wants the old "disabled" outcome removes the registration.
 *
 * @param filePath Absolute path to `.exarchos/invariants.md`.
 * @param opts Optional filter (schema-v2; spec §4.1, §4.2):
 *   - `scope: 'core'`      — axis=substrate AND cost-of-load=always-load
 *                            (the /ideate Phase 0 working set; 10 entries
 *                            in v2). Tighter than v1's "always-load alone".
 *   - `scope: 'substrate'` — every entry on the substrate axis (19 today —
 *                            the whole catalog after the #1477 excision).
 *   - `scope: 'authoring'` — every entry on the authoring axis (empty today).
 *   - `scope: 'all'`       — every entry (default; v1 backwards-compat).
 *   Unknown scope values throw — silent fallback is forbidden per
 *   design §5 DIM-2.
 *   - `configRoot`         — directory the injected config's relative
 *                            `catalogs:` registrations resolve against. Supply
 *                            it whenever you resolved those registrations
 *                            yourself (as `resolveEffectiveCatalog` does);
 *                            omit it and a relative registration is matched by
 *                            segment-aligned suffix instead.
 * @param config Optional explicit config (dependency injection for tests).
 *   Defaults to reading `.exarchos.yml` via `readInvariantsConfig`.
 */
export function loadInvariants(
  filePath: string,
  opts?: { scope?: InvariantsScope; configRoot?: string },
  config?: ExarchosConfigInput,
): InvariantEntry[] {
  // Discover the config ONLY when one was not injected, so the disk walk-up
  // also yields the root its relative registrations are written against.
  const discovered =
    config === undefined ? discoverInvariantsConfig(filePath) : undefined;
  const effectiveConfig = config ?? discovered?.config ?? {};
  // Catalog gating — applied BEFORE any scope filter (DR-31).
  // Default-empty even inside the Exarchos repo: contributors get the catalog
  // because the repo's own committed `.exarchos.yml` REGISTERS it under
  // `invariants.catalogs`, not because the loader detected anything and not
  // because a repo-only flag was flipped.
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
  // Schema-version guard (DR-1). A declared `schema-version` must be one of
  // SUPPORTED_SCHEMA_VERSIONS (2 or 3). An absent version is tolerated for
  // back-compat with pre-v2 fixtures; any other declared value is a loud
  // parse error naming the offending value and the supported set.
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
  // Co-located scope filter — keep the policy next to the load to avoid
  // drift between the load contract and the surface API. See `InvariantsScope`
  // type docs for per-variant semantics; the switch arms mirror that order.
  switch (scope) {
    case 'core':
      // /ideate Phase 0 default: substrate-axis primitives that every
      // non-trivial design must consider — spec §4.1.
      return entries.filter(
        (e) => e.axis === 'substrate' && e.costOfLoad === 'always-load',
      );
    case 'substrate':
      // Runtime-substrate axis — every cost-of-load. The conformance gate's
      // catalog-generated audit prompt uses this when walking substrate
      // entries by axis.
      return entries.filter((e) => e.axis === 'substrate');
    case 'authoring':
      // Authoring (prose / documentation) axis — empty today, retained for
      // forward-compat (#1477 removed the sole authoring entry).
      return entries.filter((e) => e.axis === 'authoring');
    case 'all':
      // Full catalog — vocabulary-lint ID set + v1 backwards-compat default.
      return entries;
  }
}

/**
 * Convenience: return only the `cost-of-load: always-load` entries — the
 * `/ideate` Phase 0 working set. Equivalent to `loadInvariants(filePath,
 * { scope: 'core' })`; named so import sites express intent without the
 * option-object indirection. Honours the DR-31 registration gate via
 * the same default config reader as `loadInvariants`.
 */
export function loadCoreInvariants(
  filePath: string,
  config?: ExarchosConfigInput,
): InvariantEntry[] {
  return loadInvariants(filePath, { scope: 'core' }, config);
}

/**
 * Convenience: return the set of valid invariant IDs (for vocabulary-lint
 * cross-check). Honours the DR-31 registration gate — when the effective
 * config does not register this catalog, returns an empty set, so
 * vocabulary-lint will treat every `INV-*` token as unknown. Consumers using
 * Exarchos as a plugin outside the Exarchos repo therefore opt into invariant
 * checking exactly the way this repo does: by registering the catalog under
 * `invariants.catalogs` in their own `.exarchos.yml`.
 */
export function loadInvariantIds(
  filePath: string,
  config?: ExarchosConfigInput,
): Set<string> {
  return new Set(loadInvariants(filePath, undefined, config).map((e) => e.id));
}
