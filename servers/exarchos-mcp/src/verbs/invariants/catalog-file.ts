/**
 * Catalog-file primitives shared by every invariant WRITE verb
 * (`invariants_add`, `invariants_amend`).
 *
 * These live in one module rather than being re-implemented per verb because
 * they encode two facts that must not drift between writers:
 *
 *  1. **The file shape.** A catalog is EITHER markdown-with-frontmatter (the
 *     dev catalog, which carries a prose body a naive whole-file round-trip
 *     would destroy) OR bare YAML. Every writer has to split, mutate only the
 *     frontmatter document, and reassemble.
 *  2. **The denominator.** "Which ids are already in use" is the input to the
 *     primary-key check. Resolving it must fail LOUDLY when the entry list
 *     cannot be read, or a moved/renamed catalog reads as "no collisions"
 *     (task 068 / DR-24).
 */
import { parseDocument, isSeq } from 'yaml';

import type { ToolResult } from '../../format.js';

/**
 * Is `value` a plain (non-array, non-null) object?
 *
 * A real type predicate rather than an `as Record<string, unknown>` cast: the
 * narrowing is then something the compiler CHECKED, not something the author
 * asserted. Shared by every catalog reader that has to look at a projected
 * YAML entry's fields.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Split a catalog file into its YAML frontmatter and (optional) markdown body.
 *
 * Catalog files are EITHER markdown-with-frontmatter (`---\n<yaml>\n---\n<body>`
 * — the dev catalog) OR bare YAML (no fences, no body — a user could register a
 * `.yml`). We do the split ourselves rather than via gray-matter's `.matter`
 * field: gray-matter v4 caches by input string and only populates `.matter` on
 * the FIRST parse of a given string, returning `undefined` for it on a cache
 * hit. Several call sites parse the same file contents, so depending on
 * `.matter` is a latent crash. A direct fence scan is deterministic and
 * cache-free.
 *
 * Returns `{ frontmatter, body }` where `body` is `undefined` for the bare-YAML
 * shape (no fences) and the verbatim post-fence text (including its leading
 * newline) for the fenced shape.
 */
export function splitCatalog(contents: string): {
  frontmatter: string;
  body: string | undefined;
} {
  // Frontmatter must open at the very start with a `---` line. Match the
  // opening fence, the frontmatter block, the closing `---` line, then the rest.
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(
    contents,
  );
  if (match) {
    return { frontmatter: match[1] ?? '', body: match[2] ?? '' };
  }
  return { frontmatter: contents, body: undefined };
}

/**
 * Outcome of scanning a catalog for the ids already in use.
 *
 * The discriminant is the point. The previous `readExistingIds` returned a bare
 * `string[]` and collapsed EVERY failure — absent `invariants:` key, a renamed
 * key, a null/map/scalar node, an entry with no readable id — into `[]`. An
 * empty id list is indistinguishable from "no collisions", so a moved or
 * renamed catalog read as a clean uniqueness check and every id looked free.
 * That is a vacuous denominator, and a uniqueness guard resting on one proves
 * nothing (task 068 / DR-24).
 *
 * `resolved: true` with `ids: []` is a DIFFERENT and legitimate state: a
 * freshly scaffolded catalog really is `invariants: []`. The tooth is
 * resolvability, not cardinality — making zero entries fatal outright would
 * make it impossible to author a catalog's first entry. Verbs for which an
 * empty catalog IS vacuous (`invariants_amend` — there is nothing to amend)
 * impose that check themselves, on a denominator they have proven resolved.
 */
export type CatalogIdScan =
  | { readonly resolved: true; readonly ids: readonly string[] }
  | { readonly resolved: false; readonly reason: string };

/**
 * Read the ids already in use in a catalog file's `invariants:` list.
 *
 * Fail-closed: resolves ONLY when the frontmatter parses, `invariants` is
 * present AND is a sequence, and every element carries a non-empty string
 * `id`. Anything else is unresolved — we cannot prove an id is free against
 * entries we could not read.
 */
export function readCatalogIds(catalogContents: string): CatalogIdScan {
  const { frontmatter } = splitCatalog(catalogContents);

  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(frontmatter);
  } catch (err) {
    return {
      resolved: false,
      reason: `catalog frontmatter did not parse as YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (doc.errors.length > 0) {
    return {
      resolved: false,
      reason: `catalog frontmatter did not parse as YAML: ${doc.errors[0]?.message ?? 'unknown error'}`,
    };
  }

  const list: unknown = doc.get('invariants', true);
  if (list === undefined || list === null) {
    return {
      resolved: false,
      reason:
        "catalog has no readable 'invariants:' list — the key is absent, null, or renamed. " +
        'A uniqueness check cannot run against entries it could not resolve.',
    };
  }
  if (!isSeq(list)) {
    return {
      resolved: false,
      reason:
        "catalog's 'invariants:' is not a YAML sequence. A uniqueness check " +
        'cannot run against entries it could not resolve.',
    };
  }

  const raw: unknown = list.toJSON();
  if (!Array.isArray(raw)) {
    return {
      resolved: false,
      reason: "catalog's 'invariants:' did not project to an array",
    };
  }

  const ids: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isPlainRecord(entry)) {
      return {
        resolved: false,
        reason: `catalog entry at index ${index} is not an object — its id cannot be read`,
      };
    }
    const id: unknown = entry.id;
    if (typeof id !== 'string' || id.length === 0) {
      return {
        resolved: false,
        reason: `catalog entry at index ${index} carries no readable string id — a uniqueness check against it would be vacuous`,
      };
    }
    ids.push(id);
  }

  return { resolved: true, ids };
}

/**
 * INV-5b carrier-shape refusal for a catalog whose id list did not RESOLVE.
 * Shared by `invariants_add` and `invariants_amend`: neither may proceed on a
 * denominator it could not read (task 068 / DR-24).
 */
export function catalogUnreadableResult(
  relCatalog: string,
  tier: 'dev' | 'user',
  reason: string,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'CATALOG_UNREADABLE',
      message:
        `Cannot resolve the existing entries of catalog '${relCatalog}': ${reason} ` +
        `Refusing to write: an unresolved entry list would make the id-uniqueness ` +
        `check vacuous, so a moved or renamed catalog would read as "no collisions".`,
      expectedShape: {
        invariants: '[ { id: string, ... } ]  # a YAML sequence of entries',
      },
      suggestedFix: {
        tool: 'exarchos_orchestrate',
        params: {
          action: 'doctor',
          note:
            `Check that '${relCatalog}' is the intended catalog and that its ` +
            "frontmatter declares an 'invariants:' sequence whose entries each " +
            'carry a string id. Run invariants_scaffold to create a fresh one.',
          tier,
        },
      },
    },
  };
}
