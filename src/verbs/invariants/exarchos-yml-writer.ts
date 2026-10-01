/**
 * The `.exarchos.yml` catalog-registration writer for `invariants_scaffold` and
 * `invariants_add`. It adds a `{ path, tier }` registration to
 * `invariants.catalogs`.
 *
 * It edits the `yaml` `Document` from `parseDocument` and writes `toString()`.
 * `parse` with `stringify` drops comments, and the seeded comments of a new
 * `.exarchos.yml` must stay after an edit. All fs access goes through the
 * injected `YmlWriterDeps`.
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
 * Reads the `path` of a catalog registration, in object or bare-string form.
 * It returns `undefined` for a shape that it does not know, and does not throw.
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
 * Reads the declared `tier` of a catalog registration, or `undefined`. A
 * bare-string entry has no tier. The resolver treats a missing tier as `'user'`.
 */
function registrationTier(entry: unknown): 'dev' | 'user' | undefined {
  if (entry && typeof entry === 'object' && 'tier' in entry) {
    const t = (entry as { tier: unknown }).tier;
    return t === 'dev' || t === 'user' ? t : undefined;
  }
  return undefined;
}

/**
 * Adds `registration` to `invariants.catalogs` in the `.exarchos.yml` at
 * `ymlPath`, and keeps comments. The match is on `path` only. A missing tier
 * counts as `'user'`.
 *   - Same path and tier: no write.
 *   - Same path, other tier: it replaces the entry in place with the object
 *     form, so a `'user'` path can change to `'dev'`.
 *   - No match: it appends. A non-sequence `catalogs` value becomes the first
 *     element of a new sequence from `createNode`. A plain array set through
 *     `setIn` has no `.add`.
 */
export function wireCatalogRegistration(
  ymlPath: string,
  registration: CatalogRegistrationInput,
  deps: YmlWriterDeps,
): WireResult {
  const source = deps.exists(ymlPath) ? deps.read(ymlPath) : '';
  const doc: Document = parseDocument(source);

  const existingSeq = doc.getIn(['invariants', 'catalogs'], true) as unknown;
  if (isSeq(existingSeq)) {
    for (const item of (existingSeq as YAMLSeq).items) {
      const json = (item as { toJSON?: () => unknown }).toJSON?.() ?? item;
      if (registrationPath(json) !== registration.path) continue;
      const effectiveTier = registrationTier(json) ?? 'user';
      if (effectiveTier === registration.tier) {
        return { wrote: false, path: ymlPath, reason: 'already-registered' };
      }
      (existingSeq as YAMLSeq).set(
        (existingSeq as YAMLSeq).items.indexOf(item),
        doc.createNode({ path: registration.path, tier: registration.tier }),
      );
      deps.write(ymlPath, doc.toString());
      return { wrote: true, path: ymlPath, reason: 'upgraded' };
    }
  }

  let catalogsNode = doc.getIn(['invariants', 'catalogs'], true) as unknown;
  if (!isSeq(catalogsNode)) {
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
