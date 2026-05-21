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

/** Allowed values for the `scope` argument to `loadInvariants`. */
export type InvariantsScope = 'core' | 'all';

const SCOPE_VALUES: readonly InvariantsScope[] = ['core', 'all'] as const;

export interface InvariantEntry {
  /** Stable identifier — e.g. "INV-1", "INV-5a", "DIM-1", "basileus-boundary". */
  id: string;
  /** Short human-readable category name. */
  dimension: string;
  /** Load-cost classification (drives Phase 0 surfacing — see `CostOfLoad`). */
  costOfLoad: CostOfLoad;
  /** Surface areas (modules, file globs, capability domains) the invariant covers. */
  appliesTo: string[];
  /** One-to-two-sentence statement of the invariant. */
  summary: string;
  /** Pointers to source files where the invariant is detailed in prose. */
  references: string[];
  /** The raw parsed entry for fields not yet promoted to the typed shape. */
  raw: Record<string, unknown>;
}

/** Untyped shape returned by `gray-matter` for a single catalog entry — validated by `parseEntry`. */
interface RawInvariantEntry {
  id?: unknown;
  dimension?: unknown;
  'cost-of-load'?: unknown;
  'applies-to'?: unknown;
  summary?: unknown;
  references?: unknown;
  [key: string]: unknown;
}

/** Untyped shape returned by `gray-matter` for the file frontmatter — validated by `loadInvariants`. */
interface RawFrontmatter {
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
  return {
    id,
    dimension: asString(raw.dimension, 'dimension', id),
    costOfLoad: parseCostOfLoad(raw['cost-of-load'], id),
    appliesTo: asStringArray(raw['applies-to'], 'applies-to', id),
    summary: asString(raw.summary, 'summary', id),
    references: asStringArray(raw.references, 'references', id),
    raw: { ...raw },
  };
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
 * @param opts Optional filter. `scope: 'core'` returns only entries with
 *   `cost-of-load: always-load` (the Phase 0 working set); `scope: 'all'`
 *   (the default) returns every entry. Unknown scope values throw —
 *   silent fallback to `'all'` is forbidden per design §5 DIM-2.
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
  // Co-located scope filter — keep the policy next to the load to avoid
  // drift between the load contract and the surface API.
  if (scope === 'core') {
    return entries.filter((e) => e.costOfLoad === 'always-load');
  }
  return entries;
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
