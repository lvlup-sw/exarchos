/**
 * `.exarchos.yml` catalog-registration writer (P2, T10).
 *
 * Shared by `invariants_scaffold` (T6) and `invariants_add` (T9). Appends a
 * `{ path, tier }` registration to `invariants.catalogs` when absent;
 * idempotent when already present (bare-string or object form).
 *
 * ## Comment preservation
 *
 * Uses the `yaml` package's `parseDocument` → mutate → `toString()` round-trip
 * (the `Document` API), NOT `parse` + `stringify`. `parse`+`stringify` discards
 * comments; the seeded onboarding comment stanza in a freshly-`init`-ed
 * `.exarchos.yml` (see `seed-exarchos-config.ts`) must survive an authoring
 * edit, so we round-trip the CST-backed `Document` instead.
 *
 * Pure-by-default: all fs access flows through injected `YmlWriterDeps`.
 */
import { parseDocument, isSeq } from 'yaml';
import type { Document, YAMLSeq } from 'yaml';

/** Injected fs hooks (tests substitute in-memory implementations). */
export interface YmlWriterDeps {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, contents: string) => void;
}

/** A catalog registration to wire into `invariants.catalogs`. */
export interface CatalogRegistrationInput {
  readonly path: string;
  readonly tier: 'dev' | 'user';
}

/** Result of the registration step. */
export interface WireResult {
  readonly wrote: boolean;
  readonly path: string;
  readonly reason: 'registered' | 'already-registered';
}

/**
 * Read the existing `path` of a catalog registration node (object or bare
 * string form) for dedupe comparison. Returns `undefined` for shapes we don't
 * recognise (defensive — never throws on a malformed entry).
 */
function registrationPath(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && 'path' in entry) {
    const p = (entry as { path: unknown }).path;
    return typeof p === 'string' ? p : undefined;
  }
  return undefined;
}

/**
 * Append `registration` to `invariants.catalogs` in the `.exarchos.yml` at
 * `ymlPath`, preserving comments. Idempotent: if a registration for the same
 * `path` already exists (in either form), no write occurs.
 */
export function wireCatalogRegistration(
  ymlPath: string,
  registration: CatalogRegistrationInput,
  deps: YmlWriterDeps,
): WireResult {
  const source = deps.exists(ymlPath) ? deps.read(ymlPath) : '';
  const doc: Document = parseDocument(source);

  // Read existing registrations (if any) via the plain JS projection so the
  // dedupe check is shape-tolerant (bare string OR { path, tier }).
  const existing = doc.getIn(['invariants', 'catalogs']) as unknown;
  const existingPaths: string[] = [];
  if (existing && typeof (existing as { toJSON?: unknown }).toJSON === 'function') {
    const arr = (existing as { toJSON: () => unknown }).toJSON();
    if (Array.isArray(arr)) {
      for (const e of arr) {
        const p = registrationPath(e);
        if (p !== undefined) existingPaths.push(p);
      }
    }
  }

  if (existingPaths.includes(registration.path)) {
    return { wrote: false, path: ymlPath, reason: 'already-registered' };
  }

  // Ensure invariants.catalogs is a YAMLSeq before appending. A missing node
  // is created as an empty sequence; a non-sequence existing value (scalar or
  // map — e.g. a malformed `catalogs: ""` or `catalogs: {}`) is wrapped into a
  // fresh sequence preserving the prior value as the first element, so `.add`
  // never throws on a non-sequence node (robustness — #1487 review).
  let catalogsNode = doc.getIn(['invariants', 'catalogs'], true) as unknown;
  if (!isSeq(catalogsNode)) {
    // Build the replacement via `createNode` so it is a real YAMLSeq (a plain
    // JS array stored through `setIn` over an existing parent map lacks `.add`).
    // A non-sequence existing value (scalar/map) is preserved as the first
    // element; a missing node becomes an empty sequence.
    const prior =
      catalogsNode === undefined || catalogsNode === null
        ? []
        : [doc.getIn(['invariants', 'catalogs'])];
    doc.setIn(['invariants', 'catalogs'], doc.createNode(prior));
    catalogsNode = doc.getIn(['invariants', 'catalogs'], true) as unknown;
  }
  const catalogs = catalogsNode as YAMLSeq;
  catalogs.add({ path: registration.path, tier: registration.tier });

  deps.write(ymlPath, doc.toString());
  return { wrote: true, path: ymlPath, reason: 'registered' };
}
