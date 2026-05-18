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
import matter from 'gray-matter';

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

interface RawInvariantEntry {
  id?: unknown;
  dimension?: unknown;
  'cost-of-load'?: unknown;
  'applies-to'?: unknown;
  summary?: unknown;
  references?: unknown;
  [key: string]: unknown;
}

interface RawFrontmatter {
  invariants?: unknown;
  [key: string]: unknown;
}

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

function asString(value: unknown, field: string, id: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `invariants-loader: entry "${id}" field "${field}" must be a string, got ${typeof value}`,
    );
  }
  // Collapse YAML folded-scalar whitespace so consumers get clean prose.
  return value.replace(/\s+/g, ' ').trim();
}

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
 * Load and parse the invariants catalog from the given Markdown file.
 *
 * @param filePath Absolute path to `docs/architecture/invariants.md`.
 * @param opts Optional filter. `scope: 'core'` returns only entries with
 *   `cost-of-load: always-load` (the Phase 0 working set); `scope: 'all'`
 *   (the default) returns every entry. Unknown scope values throw —
 *   silent fallback to `'all'` is forbidden per design §5 DIM-2.
 */
export function loadInvariants(
  filePath: string,
  opts?: { scope?: InvariantsScope },
): InvariantEntry[] {
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
 * Convenience: return the set of valid invariant IDs (for vocabulary-lint
 * cross-check).
 */
export function loadInvariantIds(filePath: string): Set<string> {
  return new Set(loadInvariants(filePath).map((e) => e.id));
}
