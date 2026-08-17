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
  readonly reason: 'registered' | 'already-registered' | 'upgraded';
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
 * Read the declared `tier` of a catalog registration node, or `undefined`. A
 * bare-string entry has no tier (the resolver treats it as `'user'`); an object
 * entry carries an explicit `tier` (or omits it, also defaulting to `'user'`).
 */
function registrationTier(entry: unknown): 'dev' | 'user' | undefined {
  if (entry && typeof entry === 'object' && 'tier' in entry) {
    const t = (entry as { tier: unknown }).tier;
    return t === 'dev' || t === 'user' ? t : undefined;
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

  // Dedupe / upgrade on the live `catalogs` YAMLSeq so we can mutate an
  // existing entry IN PLACE (preserving its position and any sibling comments).
  // The dedupe is keyed on `path` only; if a same-path entry exists with a
  // DIFFERENT tier, we UPGRADE it to the requested tier rather than skipping —
  // otherwise a path first registered as `tier: 'user'` could never be promoted
  // to `tier: 'dev'`. This mirrors the in-place upgrade in
  // `resolveCatalogSources` (#1487 review — LOW). When path+tier already match,
  // it is a no-op (idempotent).
  const existingSeq = doc.getIn(['invariants', 'catalogs'], true) as unknown;
  if (isSeq(existingSeq)) {
    for (const item of (existingSeq as YAMLSeq).items) {
      const json = (item as { toJSON?: () => unknown }).toJSON?.() ?? item;
      if (registrationPath(json) !== registration.path) continue;
      // Same path. The resolver treats an absent tier (bare-string or
      // tier-less object) as `'user'`, so compare against that effective tier;
      // when it already matches the request, this is a no-op (idempotent) and
      // we leave the bare-string/tier-less form untouched (no spurious write).
      const effectiveTier = registrationTier(json) ?? 'user';
      if (effectiveTier === registration.tier) {
        return { wrote: false, path: ymlPath, reason: 'already-registered' };
      }
      // Same path, different (or absent) tier — upgrade in place. Replace the
      // node with the requested `{ path, tier }` object form. A bare-string
      // entry is likewise promoted to the object form so its tier is explicit.
      (existingSeq as YAMLSeq).set(
        (existingSeq as YAMLSeq).items.indexOf(item),
        doc.createNode({ path: registration.path, tier: registration.tier }),
      );
      deps.write(ymlPath, doc.toString());
      return { wrote: true, path: ymlPath, reason: 'upgraded' };
    }
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
