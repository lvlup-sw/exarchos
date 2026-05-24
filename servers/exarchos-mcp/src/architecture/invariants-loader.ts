/**
 * Loader for the machine-readable invariants catalog at
 * `docs/architecture/invariants.md` (issue #1260).
 *
 * The frontmatter is the source of truth; this module parses it into a typed
 * `InvariantEntry[]` for consumption by `/ideate` first-turn surfacing, the
 * vocabulary-lint scanner, and the design-invariants skill.
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
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';
import {
  InvariantEntryV3Schema,
  type Enforcement,
  type InvariantEntryV3,
} from './invariant-schema.js';

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
 *   - `'authoring'` — every entry on the authoring axis (DIM-8 only in v2)
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
 * entries describe prose / documentation concerns (only DIM-8 today).
 * Drives the v2 scope filter (Wave D1) which intersects axis with
 * `cost-of-load` for `scope: 'core'`.
 */
export type InvariantAxis = 'substrate' | 'authoring';

const AXIS_VALUES: readonly InvariantAxis[] = ['substrate', 'authoring'] as const;

export interface InvariantEntry {
  /** Stable identifier — e.g. "INV-1", "INV-5a", "DIM-1", "basileus-boundary". */
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
   * entries for substrate-axis invariants; DIM-* axiom-pointer entries
   * and v1-era entries (pre-C4..C11) typically omit it. Undefined when
   * not declared (distinct from declared-empty `[]`).
   */
  citations?: string[];
  /**
   * Axiom-dimension overlap pointer (schema-v2). Optional `DIM-N` value
   * consumed by `/axiom:design`'s pairing-discovery to interleave project
   * invariants under each axiom dimension. When declared, must match
   * `/^DIM-\d+$/` and reference an existing DIM-N entry in the catalog.
   * See spec §4.3.
   */
  axiomOverlap?: string;
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
  axiom_overlap?: unknown;
  [key: string]: unknown;
}

/**
 * Pattern for the schema-v2 `axiom_overlap` field. Must match
 * `DIM-` followed by one or more digits to reference a DIM-N entry.
 */
const AXIOM_OVERLAP_PATTERN = /^DIM-\d+$/;

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
  // Optional schema-v2 field — format-checked against /^DIM-\d+$/. The
  // cross-reference check (declared overlap points at an existing DIM-N
  // entry) lives in `loadInvariants` so it can see the full entry set.
  if (raw.axiom_overlap !== undefined && raw.axiom_overlap !== null) {
    if (typeof raw.axiom_overlap !== 'string') {
      throw new Error(
        `invariants-loader: entry "${id}" field "axiom_overlap" must be a string, got ${typeof raw.axiom_overlap}`,
      );
    }
    if (!AXIOM_OVERLAP_PATTERN.test(raw.axiom_overlap)) {
      throw new Error(
        `invariants-loader: entry "${id}" has invalid "axiom_overlap" value '${raw.axiom_overlap}'; ` +
          `must match /^DIM-\\d+$/ (e.g. 'DIM-1', 'DIM-7')`,
      );
    }
    entry.axiomOverlap = raw.axiom_overlap;
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

/**
 * Read the `invariants:` block from the closest `.exarchos.yml` walking up
 * from the catalog file. Returns `{}` when no file is found or when the
 * YAML lacks the `invariants` key — both cases collapse to default-disabled
 * at `loadInvariants` (see §4.0 of the v2 spec).
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
function readInvariantsConfig(catalogFilePath: string): ExarchosConfig {
  let dir = path.dirname(path.resolve(catalogFilePath));
  // Bounded walk-up: stop at filesystem root.
  while (true) {
    for (const filename of ['.exarchos.yml', '.exarchos.yaml']) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return parseInvariantsBlock(candidate);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

/**
 * Extract only the `invariants:` block from a `.exarchos.yml` file.
 * Tolerates files whose other top-level keys do not match
 * `ExarchosConfigSchema` (`agents:`, `review:`, etc. validated by the
 * parallel `ProjectConfigSchema` — see notes on `readInvariantsConfig`).
 *
 * Returns `{}` on parse errors or when the `invariants` key is absent;
 * default-disabled at the loader handles both as "no flag set."
 */
function parseInvariantsBlock(configPath: string): ExarchosConfig {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const doc = parseYaml(raw);
    if (doc === null || doc === undefined || typeof doc !== 'object') {
      return {};
    }
    const invariants = (doc as Record<string, unknown>).invariants;
    if (invariants === undefined || invariants === null) {
      return {};
    }
    // Project just the keys we care about; the loader treats unknown values
    // as not-`'enabled'` so any malformed shape collapses to default-disabled.
    if (typeof invariants === 'object' && !Array.isArray(invariants)) {
      const devCatalog = (invariants as Record<string, unknown>).devCatalog;
      if (devCatalog === 'enabled' || devCatalog === 'disabled') {
        return { invariants: { devCatalog } };
      }
      return { invariants: {} };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Load and parse the invariants catalog from the given Markdown file.
 *
 * **Gating (Wave B2 / spec §4.0):** the loader consults
 * `config.invariants?.devCatalog`. When the flag is anything other than
 * `'enabled'` (including `undefined`, `'disabled'`, or an unset block),
 * the loader returns `[]` regardless of `opts.scope`. The default reader
 * walks up from the catalog file looking for `.exarchos.yml`; tests pass
 * an explicit `config` to bypass disk-IO. See `readInvariantsConfig`.
 *
 * @param filePath Absolute path to `docs/architecture/invariants.md`.
 * @param opts Optional filter (schema-v2; spec §4.1, §4.2):
 *   - `scope: 'core'`      — axis=substrate AND cost-of-load=always-load
 *                            (the /ideate Phase 0 working set; 10 entries
 *                            in v2). Tighter than v1's "always-load alone".
 *   - `scope: 'substrate'` — every entry on the substrate axis (26 in v2).
 *   - `scope: 'authoring'` — every entry on the authoring axis (DIM-8 in v2).
 *   - `scope: 'all'`       — every entry (default; v1 backwards-compat).
 *   Unknown scope values throw — silent fallback is forbidden per
 *   design §5 DIM-2.
 * @param config Optional explicit config (dependency injection for tests).
 *   Defaults to reading `.exarchos.yml` via `readInvariantsConfig`.
 */
export function loadInvariants(
  filePath: string,
  opts?: { scope?: InvariantsScope },
  config?: ExarchosConfig,
): InvariantEntry[] {
  const effectiveConfig = config ?? readInvariantsConfig(filePath);
  // Catalog gating — applied BEFORE any scope filter.
  // Default-disabled even inside the Exarchos repo: contributors get
  // the catalog because the repo's own committed `.exarchos.yml` sets
  // the flag, not because the loader detected anything.
  if (effectiveConfig.invariants?.devCatalog !== 'enabled') {
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
  const entries = (data.invariants as RawInvariantEntry[]).map(parseEntry);
  // Reject duplicate IDs at load time — IDs are the catalog's primary key and
  // must be unique. A silent duplicate would shadow the earlier entry and
  // corrupt vocabulary-lint / ideate Constraint surfacing.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate invariant ID: ${entry.id}`);
    }
    seen.add(entry.id);
  }
  // Referential integrity for `axiom_overlap` (PR #1459 CodeRabbit finding 1).
  // The format check in `parseEntry` only verifies the regex shape — a
  // reference that matches the shape (e.g. `DIM-99`) but does NOT point at
  // an existing DIM-N entry would otherwise parse successfully and become a
  // dangling pointer consumed by `/axiom:design`'s pairing-discovery. Catch
  // it here, after the full entry set is available, so the error names both
  // the offending entry and the set of valid DIM-* IDs.
  const dimIds = entries.filter((e) => e.id.startsWith('DIM-')).map((e) => e.id);
  const dimIdSet = new Set(dimIds);
  for (const entry of entries) {
    if (entry.axiomOverlap !== undefined && !dimIdSet.has(entry.axiomOverlap)) {
      const validList = dimIds.length > 0 ? dimIds.join(', ') : '(none in catalog)';
      throw new Error(
        `invariants-loader: entry "${entry.id}" declares axiom_overlap: ` +
          `'${entry.axiomOverlap}' but no such DIM-* entry exists in the ` +
          `catalog. Valid DIM-* IDs: ${validList}`,
      );
    }
  }
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
      // Runtime-substrate axis — every cost-of-load. design-invariants
      // skill body uses this when walking substrate entries by axis.
      return entries.filter((e) => e.axis === 'substrate');
    case 'authoring':
      // Authoring (prose / documentation) axis — DIM-8 only in v2.
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
 * option-object indirection. Honours the Wave B2 `devCatalog` gate via
 * the same default config reader as `loadInvariants`.
 */
export function loadCoreInvariants(
  filePath: string,
  config?: ExarchosConfig,
): InvariantEntry[] {
  return loadInvariants(filePath, { scope: 'core' }, config);
}

/**
 * Convenience: return the set of valid invariant IDs (for vocabulary-lint
 * cross-check). Honours the Wave B2 `devCatalog` gate — when the flag is
 * not `'enabled'`, returns an empty set, so vocabulary-lint will treat
 * every `INV-*` / `DIM-*` token as unknown. Consumers using Exarchos as a
 * plugin outside the Exarchos repo therefore opt into invariant checking
 * by declaring the same flag in their own `.exarchos.yml`.
 */
export function loadInvariantIds(
  filePath: string,
  config?: ExarchosConfig,
): Set<string> {
  return new Set(loadInvariants(filePath, undefined, config).map((e) => e.id));
}
