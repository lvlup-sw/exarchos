/**
 * Catalog-file primitives shared by the invariant write verbs, `invariants_add` and `invariants_amend`.
 * They live in one module because three facts must not drift between writers:
 * 1. The file shape. A catalog is markdown with YAML frontmatter, or bare YAML.
 *    A writer changes only the frontmatter and keeps the markdown body.
 * 2. The set of ids in use. The read must fail loudly when the entry list cannot be read.
 *    Otherwise a moved or renamed catalog reads as "no collisions".
 * 3. The write is a splice, not a round-trip. An edit to one entry keeps the bytes of every other entry.
 */
import { parseDocument, stringify as stringifyYaml, isSeq, isMap } from 'yaml';

import type { ToolResult } from '../../format.js';

/**
 * True when `value` is an object that is not an array and not null.
 * It is a type predicate, so the compiler checks the narrowing. A cast only asserts it.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Splits a catalog file into its YAML frontmatter and its optional markdown body.
 * In a fenced file (`---\n<yaml>\n---\n<body>`), the opening fence is the first line, and `body` is the text after the closing fence line.
 * Bare YAML gives `body: undefined`.
 * The function scans the fences itself and does not use the `.matter` field of gray-matter.
 * Gray-matter v4 caches by input string and sets `.matter` only on the first parse of a string.
 */
export function splitCatalog(contents: string): {
  frontmatter: string;
  body: string | undefined;
  /**
   * Absolute offset of `frontmatter` in `contents`.
   * A rebuild from `frontmatter` and `body` is lossy. It drops trailing whitespace on the closing fence line.
   * It also cannot tell a missing final newline from an empty body.
   * A splice at this offset keeps every byte outside the replaced span.
   */
  frontmatterStart: number;
} {
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
 * Outcome of a scan for the ids in use in a catalog.
 * The discriminant matters. A bare `string[]` turns every read failure into `[]`, and `[]` reads as "no collisions".
 * `resolved: true` with `ids: []` is a valid state, because a new catalog holds `invariants: []`.
 * The check is resolvability, not count, so that a writer can add the first entry.
 * A verb for which an empty catalog is an error, such as `invariants_amend`, adds that check itself.
 */
export type CatalogIdScan =
  | { readonly resolved: true; readonly ids: readonly string[] }
  | { readonly resolved: false; readonly reason: string };

/**
 * Reads the ids in use in the `invariants:` list of a catalog file. It fails closed.
 * It resolves only when the frontmatter parses, `invariants` is a sequence, and every element has a non-empty string `id`.
 * An id cannot be proven free against entries that the scan cannot read.
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
 * The result of rewriting a catalog with ONE entry's lines replaced.
 */
export interface CatalogSplice {
  /** The whole file, with only the located entry's lines replaced. */
  readonly contents: string;
  /** The lines that were written in the entry's place. */
  readonly entryText: string;
}

/**
 * One entry found in the catalog text, with what a caller needs to amend it.
 * It holds the current fields, the current bytes, and a splice bound to the exact text that the locator measured.
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
 * Outcome of a search for one entry in a catalog. It is discriminated for the same reason as `CatalogIdScan`.
 * A fallback to a whole-document rewrite brings back the reflow that the splice prevents.
 * A search that matches nothing is a refusal.
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
 * Locates the entry with `id` in the catalog text, so that a caller can amend it and change nothing else.
 * A document round-trip re-folds every folded scalar at the line width of `yaml`, so a one-field edit re-wraps other entries.
 * The contract digest covers the raw catalog text, so such a re-wrap moves the digest and requires a contract re-approval.
 * The function thus parses only to find the node range. It serializes only the amended entry and splices it into the original text.
 * The span ends at `range[1]`, the end of the entry content, before any byte of the next item.
 *
 * It refuses, and never rewrites the whole document, when the frontmatter does not parse or `invariants:` is not a sequence.
 * It also refuses when the sequence is empty, when no map item has the id, or when the span is empty.
 * The id search is narrower than `readCatalogIds`. An aliased entry (`- *base`) has a readable id but no map node to rewrite.
 * The splice keeps the line ending of the file and the trailing-newline shape of the replaced span.
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

  const eol = /\r\n/.test(contents) ? '\r\n' : '\n';
  const span = found;

  return {
    located: true,
    entry: {
      current: span.current,
      currentText,
      splice: (entry: unknown): CatalogSplice => {
        let entryText = reindentBlock(stringifyYaml(entry), span.indent);
        if (currentText.endsWith('\n')) {
          if (!entryText.endsWith('\n')) entryText += '\n';
        } else if (entryText.endsWith('\n')) {
          entryText = entryText.slice(0, -1);
        }
        if (eol === '\r\n') entryText = entryText.replace(/\n/g, '\r\n');

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
 * Refusal for a catalog whose id list did not resolve. The error carries the expected shape and a suggested fix.
 * `invariants_add` and `invariants_amend` share it, because neither can write against an entry list that it cannot read.
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
