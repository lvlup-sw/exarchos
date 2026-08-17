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
 *  3. **The write is a SPLICE, not a round-trip.** An edit to one entry must
 *     leave every other entry's bytes alone (DR-3) — see
 *     {@link locateCatalogEntry}.
 */
import { parseDocument, stringify as stringifyYaml, isSeq, isMap } from 'yaml';

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
  /**
   * Absolute offset of `frontmatter` within `contents`.
   *
   * Callers that REBUILD the document from `frontmatter` + `body` cannot round
   * trip it: this pattern drops trailing whitespace on the closing fence
   * (`[ \t]*`) and cannot distinguish "no final newline" from "empty body",
   * so a rebuild silently normalises both. Splicing at this offset instead
   * carries every byte outside the replaced span through verbatim, which is
   * what DR-3 promises — the digest moves for the amendment and nothing else.
   */
  frontmatterStart: number;
} {
  // Frontmatter must open at the very start with a `---` line. Match the
  // opening fence, the frontmatter block, the closing `---` line, then the rest.
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(
    contents,
  );
  if (match) {
    const openingFence = /^---\r?\n/.exec(contents)?.[0] ?? '---\n';
    return {
      frontmatter: match[1] ?? '',
      body: match[2] ?? '',
      frontmatterStart: openingFence.length,
    };
  }
  return { frontmatter: contents, body: undefined, frontmatterStart: 0 };
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

// ─── Entry splice (DR-3) ────────────────────────────────────────────────────

/**
 * The result of rewriting a catalog with ONE entry's lines replaced.
 */
export interface CatalogSplice {
  /** The whole file, with only the located entry's lines replaced. */
  readonly contents: string;
  /** The lines that were written in the entry's place. */
  readonly entryText: string;
}

/**
 * One entry, found in a catalog's text, with everything a caller needs to amend
 * it: what it currently says, the bytes it currently occupies, and a splice
 * closed over the exact text it was measured against.
 */
export interface CatalogEntryLocation {
  /**
   * The entry's top-level fields as currently stored. This is an amendment's
   * MERGE BASE — the fields a patch carries through untouched.
   */
  readonly current: Record<string, unknown>;
  /** The entry's own lines, verbatim, as they stand in the file. */
  readonly currentText: string;
  /**
   * Rewrite the catalog with `entry` in this entry's place. Closed over the
   * located text and offsets, so a splice cannot be applied to a file other
   * than the one it was measured against.
   */
  readonly splice: (entry: unknown) => CatalogSplice;
}

/**
 * Outcome of locating one entry in a catalog.
 *
 * Discriminated for the same reason `CatalogIdScan` is. The alternative — hand
 * back a best-effort string and silently fall back to re-serializing the whole
 * document when the entry cannot be found — would reintroduce the very reflow
 * the splice exists to prevent, invisibly. A locate that matches nothing is a
 * REFUSAL, not a downgrade.
 */
export type CatalogEntryScan =
  | { readonly located: true; readonly entry: CatalogEntryLocation }
  | { readonly located: false; readonly reason: string };

/**
 * Re-indent a serialized block so it can sit at `indent` columns.
 *
 * The FIRST line is left alone: it lands immediately after the sequence's `- `
 * marker (or on the marker's continuation line), and the splice keeps that
 * prefix from the original text. Blank lines stay blank rather than acquiring
 * trailing whitespace.
 */
function reindentBlock(text: string, indent: number): string {
  const pad = ' '.repeat(indent);
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line.length === 0 ? line : `${pad}${line}`))
    .join('\n');
}

/**
 * Locate the entry with `id` in a catalog's text, so a caller can amend it
 * without rewriting anything else (DR-3).
 *
 * ## Why a splice rather than a document round-trip
 *
 * The obvious implementation of an amendment — parse the frontmatter,
 * `seq.set(index, entry)`, `doc.toString()` — is semantically correct and
 * produces a diff nobody can review. `yaml`'s serializer re-folds EVERY folded
 * scalar in the document at its own line width, so a one-field amendment to one
 * entry re-wraps entries it never named. Task 019's single-field edit to INV-17
 * came out as 69 inserts / 34 deletes, ~35 lines of which were cosmetic re-wrap
 * of INV-2 and INV-11.
 *
 * That is not merely noisy. The catalog is a frozen contract authority whose
 * digest is taken over its RAW TEXT (`contract/authority-digest.ts`), so a
 * collateral re-wrap moves that digest exactly as much as the real edit does,
 * and drags a contract re-approval along with every one-field correction. The
 * sanctioned path becomes the expensive one, which is the opposite of what
 * DR-23 built it for.
 *
 * So: parse only to LOCATE (the parser's node ranges are offsets into the
 * source text), then serialize only the amended entry and splice those bytes
 * into the original string. Untouched entries are never re-serialized, so they
 * cannot be re-wrapped, and the markdown body and the frontmatter's comments
 * survive for free — they are never rewritten at all.
 *
 * ## Non-empty denominator
 *
 * Refuses — rather than falling back to a whole-document rewrite — when the
 * frontmatter does not parse, `invariants:` is not a sequence, the sequence is
 * EMPTY, no item carries the id, or the located span covers zero characters.
 * The last three are the teeth: each is a case where the splice would match
 * nothing, write the file back unchanged, and report success.
 *
 * The id walk is deliberately NARROWER than `readCatalogIds`, which projects
 * the whole sequence with `toJSON()` and therefore resolves aliases. An aliased
 * entry (`- *base`) has a readable id but no map node of its own to rewrite, so
 * the id scan can resolve an id this locator cannot place. That divergence is
 * exactly what the refusal is for.
 */
export function locateCatalogEntry(contents: string, id: string): CatalogEntryScan {
  const { frontmatter, body, frontmatterStart } = splitCatalog(contents);

  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(frontmatter);
  } catch (err) {
    return {
      located: false,
      reason: `catalog frontmatter did not parse as YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (doc.errors.length > 0) {
    return {
      located: false,
      reason: `catalog frontmatter did not parse as YAML: ${doc.errors[0]?.message ?? 'unknown error'}`,
    };
  }

  const list: unknown = doc.get('invariants', true);
  if (!isSeq(list)) {
    return {
      located: false,
      reason: "catalog's 'invariants:' is not a YAML sequence, so no entry can be located in it",
    };
  }
  if (list.items.length === 0) {
    return {
      located: false,
      reason:
        "catalog's 'invariants:' resolved zero entries — a write against an empty " +
        'sequence would replace nothing and report success',
    };
  }

  // `isSeq` / `isMap` / `isPlainRecord` are type PREDICATES, so every narrowing
  // here is compiler-checked rather than asserted with a cast.
  let found:
    | { current: Record<string, unknown>; start: number; end: number; indent: number }
    | undefined;
  for (const item of list.items) {
    if (!isMap(item)) continue;
    const projected: unknown = item.toJSON();
    if (!isPlainRecord(projected) || projected.id !== id) continue;
    const range = item.range;
    if (range === null || range === undefined) {
      return {
        located: false,
        reason: `entry '${id}' carries no source range, so its lines cannot be placed in the file`,
      };
    }
    // `range` is [nodeStart, valueEnd, nodeEnd]. `valueEnd` is just past the
    // entry's own content (including its trailing newline) and before anything
    // belonging to the next item, so every byte outside it is somebody else's.
    const lineStart = frontmatter.lastIndexOf('\n', range[0] - 1) + 1;
    found = {
      current: projected,
      start: range[0],
      end: range[1],
      indent: range[0] - lineStart,
    };
    break;
  }

  if (found === undefined) {
    return {
      located: false,
      reason:
        `no entry with id '${id}' has a rewritable node in the catalog document ` +
        `— the splice would match zero lines`,
    };
  }

  const currentText = frontmatter.slice(found.start, found.end);
  if (currentText.length === 0) {
    return {
      located: false,
      reason:
        `entry '${id}' resolved to a zero-length span — a splice that matches no ` +
        `text would write the file back unchanged and report success`,
    };
  }

  // The catalog may be a CRLF working-tree checkout (this repo is authored on
  // Windows). Emit the line ending the file already uses, or the splice would
  // leave one LF entry inside an otherwise-CRLF file.
  const eol = /\r\n/.test(contents) ? '\r\n' : '\n';
  const span = found;

  return {
    located: true,
    entry: {
      current: span.current,
      currentText,
      splice: (entry: unknown): CatalogSplice => {
        // Serialize ONLY this entry, then re-indent it to the column the
        // sequence item's keys already sit at.
        let entryText = reindentBlock(stringifyYaml(entry), span.indent);
        // Match the replaced span's trailing shape exactly: the last entry of a
        // frontmatter block has no trailing newline inside the fences, and
        // adding one would insert a blank line nobody asked for.
        if (currentText.endsWith('\n')) {
          if (!entryText.endsWith('\n')) entryText += '\n';
        } else if (entryText.endsWith('\n')) {
          entryText = entryText.slice(0, -1);
        }
        if (eol === '\r\n') entryText = entryText.replace(/\n/g, '\r\n');

        // Splice into `contents` at an ABSOLUTE offset rather than rebuilding
        // the fences. Reconstruction had to re-emit the opening fence, the
        // closing fence and the body separator from scratch, and `splitCatalog`
        // does not preserve enough to do that losslessly: it discards trailing
        // whitespace on the closing fence line, and a file ending at `---` with
        // no final newline is indistinguishable from one with an empty body. So
        // an amendment silently rewrote bytes it never named — invisible to the
        // suite, because the one fixture shape in use is the shape that happens
        // to survive the round trip. Slicing the original keeps every byte
        // outside the entry's span exactly as it was found.
        const entryStart = frontmatterStart + span.start;
        const entryEnd = frontmatterStart + span.end;
        return {
          entryText,
          contents: contents.slice(0, entryStart) + entryText + contents.slice(entryEnd),
        };
      },
    },
  };
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
