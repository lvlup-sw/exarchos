// @ts-check
/**
 * @fileoverview Comment blocks, their fingerprints, and the baseline of known violations.
 *
 * A block is one `/* *\/` comment, or a run of own-line `//` comments with no gap. Each rule
 * reports per block. The baseline records known blocks by a hash of their text, with a count per
 * file. A baselined block stays suppressed only while its text is unchanged. An edited block is
 * new text, so every rule checks it again.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Where the baseline lives, relative to the repository root. */
export const DEFAULT_BASELINE_PATH = 'tools/audit/comment-quality/baseline.tsv';

/** Raised when the baseline cannot be read or is malformed. */
export class BaselineError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
}

/**
 * One comment as ESLint gives it.
 *
 * @typedef {object} RawComment
 * @property {string} type `Line`, `Block` or `Shebang`.
 * @property {string} value The text without its markers.
 * @property {readonly [number, number]} range
 */

/**
 * One comment block.
 *
 * @typedef {object} CommentBlock
 * @property {'line' | 'block'} kind
 * @property {boolean} ownLine False when code comes before the block on its first line.
 * @property {number} start Offset of the first character.
 * @property {number} end Offset one past the last character.
 * @property {number} line 1-based line of the first character.
 * @property {number} endLine 1-based line of the last character.
 * @property {string} raw The source text of the block, markers included.
 * @property {string} text The prose: markers removed and lines joined.
 */

/** @typedef {Map<string, Map<string, number>>} Baseline */

const DIRECTIVE_RE =
  /^\s*(?:eslint\b|eslint-disable|eslint-enable|eslint-env|globals?\b|exported\b|prettier-ignore|@ts-(?:ignore|expect-error|nocheck|check)|istanbul\s|c8\s|v8\s|jshint\b|jslint\b|biome-ignore|deno-lint-ignore|@vite-ignore|webpackChunkName|#!|\/\s*<reference\b)/;

const TYPE_ONLY_TAGS = [
  /^@(?:type|satisfies|enum|this|extends|augments|implements)\s+\{.*\}$/,
  /^@typedef(?:\s+\{.*\})?\s+[\w$.]+$/,
  /^@typedef\s+\{.*\}$/,
  /^@callback\s+[\w$.]+$/,
  /^@template(?:\s+\{.*\})?\s+[\w$]+(?:\s*,\s*[\w$]+)*$/,
  /^@import\s+.+\s+from\s+['"][^'"]+['"];?$/,
  /^@overload$/,
  /^@(?:param|arg|argument|property|prop)\s+\{.*\}\s+\[?[\w$.]+(?:=[^\]]*)?\]?$/,
  /^@(?:returns|return)\s+\{.*\}$/,
];

/**
 * Whether a comment is an instruction to a tool. The consumer fixes its text, so no rule reads it.
 *
 * @param {string} value Comment text without markers.
 * @returns {boolean}
 */
export function isDirective(value) {
  return DIRECTIVE_RE.test(value);
}

/**
 * Whether a `/** *\/` comment holds only JSDoc type syntax. Under `@ts-check` it is code, not prose.
 *
 * Every tag must be in a strict type-only form with nothing after it. A tag with prose is a block.
 *
 * @param {string} value Block-comment text without the outer markers, starting with `*`.
 * @returns {boolean}
 */
export function isTypeAnnotation(value) {
  if (!value.startsWith('*')) return false;
  const content = value
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s?/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ');
  if (!content.startsWith('@')) return false;
  return content.split(/\s+(?=@\w)/).every((tag) => TYPE_ONLY_TAGS.some((re) => re.test(tag)));
}

/**
 * Remove comment markers and join the lines into one line of prose.
 *
 * Joined lines let a pattern match a phrase that wraps onto the next comment line.
 *
 * @param {string} comment
 * @returns {string}
 */
export function stripMarkers(comment) {
  return comment
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+)\s?/, '').trimEnd())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The block text that the hash covers: line endings normalized and each line trimmed.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeBlock(raw) {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

/**
 * The 12-character hash that identifies a block's text.
 *
 * @param {string} raw
 * @returns {string}
 */
export function fingerprint(raw) {
  return createHash('sha256').update(normalizeBlock(raw)).digest('hex').slice(0, 12);
}

/**
 * Offsets of each line start, for offset-to-line lookups.
 *
 * @param {string} text
 * @returns {number[]}
 */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/**
 * The 1-based line that holds an offset.
 *
 * @param {readonly number[]} starts
 * @param {number} offset
 * @returns {number}
 */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Group a file's comments into blocks, in source order.
 *
 * Shebangs, directives and type-only JSDoc are not blocks, and a directive breaks a run.
 *
 * @param {readonly RawComment[]} comments
 * @param {string} text The full source text.
 * @returns {CommentBlock[]}
 */
export function groupBlocks(comments, text) {
  const starts = lineStarts(text);
  /** @type {CommentBlock[]} */
  const blocks = [];
  /** @type {CommentBlock | undefined} */
  let open;
  const close = () => {
    if (open !== undefined) blocks.push({ ...open, text: stripMarkers(open.raw) });
    open = undefined;
  };
  for (const comment of comments) {
    const [start, end] = comment.range;
    const skip =
      comment.type === 'Shebang' ||
      isDirective(comment.value) ||
      (comment.type === 'Block' && isTypeAnnotation(comment.value));
    if (skip) {
      close();
      continue;
    }
    const line = lineOf(starts, start);
    const endLine = lineOf(starts, Math.max(start, end - 1));
    const ownLine = text.slice(starts[line - 1] ?? 0, start).trim().length === 0;
    const kind = comment.type === 'Line' ? 'line' : 'block';
    if (kind === 'line' && ownLine && open?.kind === 'line' && open.ownLine && open.endLine === line - 1) {
      open = { ...open, end, endLine, raw: text.slice(open.start, end) };
      continue;
    }
    close();
    open = { kind, ownLine, start, end, line, endLine, raw: text.slice(start, end), text: '' };
    if (kind === 'block' || !ownLine) close();
  }
  close();
  return blocks;
}

/**
 * Pair each block with its hash and its index among blocks of the same hash.
 *
 * @param {readonly CommentBlock[]} blocks
 * @returns {{ block: CommentBlock, hash: string, occurrence: number }[]}
 */
export function withOccurrences(blocks) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return blocks.map((block) => {
    const hash = fingerprint(block.raw);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    return { block, hash, occurrence };
  });
}

/**
 * Whether the baseline covers the n-th violating block of a hash in one file.
 *
 * @param {ReadonlyMap<string, number> | undefined} entries The file's entries.
 * @param {string} hash
 * @param {number} violatingIndex 0-based index among the file's violating blocks with this hash.
 * @returns {boolean}
 */
export function isSuppressed(entries, hash, violatingIndex) {
  return violatingIndex < (entries?.get(hash) ?? 0);
}

/**
 * Parse baseline text. Each line is `path<TAB>hash<TAB>count`.
 *
 * @param {string} text
 * @param {string} [where] Named in error messages.
 * @returns {Baseline}
 */
export function parseBaseline(text, where = 'baseline') {
  /** @type {Baseline} */
  const baseline = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.length === 0) continue;
    const [file, hash, countText, extra] = line.split('\t');
    const count = Number(countText);
    if (file === undefined || file.length === 0 || extra !== undefined || !/^[0-9a-f]{12}$/.test(hash ?? '') || !Number.isInteger(count) || count < 1) {
      throw new BaselineError(`${where}:${i + 1} is not a \`path<TAB>hash<TAB>count\` line: ${JSON.stringify(line)}`);
    }
    const entries = baseline.get(file) ?? new Map();
    if (entries.has(hash)) throw new BaselineError(`${where}:${i + 1} repeats ${file} ${hash}.`);
    entries.set(/** @type {string} */ (hash), count);
    baseline.set(file, entries);
  }
  return baseline;
}

/**
 * Serialize a baseline in its one canonical order: by path, then by hash.
 *
 * @param {Baseline} baseline
 * @returns {string}
 */
export function serializeBaseline(baseline) {
  const lines = [];
  for (const file of [...baseline.keys()].sort()) {
    const entries = baseline.get(file) ?? new Map();
    for (const hash of [...entries.keys()].sort()) {
      const count = entries.get(hash) ?? 0;
      if (count > 0) lines.push(`${file}\t${hash}\t${count}`);
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Read and parse the baseline. A missing file throws, because no baseline is not the same as empty.
 *
 * @param {string} file
 * @returns {Baseline}
 */
export function loadBaseline(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new BaselineError(`comment baseline not found at ${file} (${detail}).`);
  }
  return parseBaseline(text, file);
}

/**
 * How many non-overlapping times a block's normalized text occurs in a file's normalized text.
 *
 * @param {string} fileText
 * @param {string} blockRaw
 * @returns {number}
 */
export function countTextOccurrences(fileText, blockRaw) {
  const haystack = normalizeBlock(fileText);
  const needle = normalizeBlock(blockRaw);
  if (needle.length === 0) return 0;
  let count = 0;
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    count += 1;
    from = haystack.indexOf(needle, from + needle.length);
  }
  return count;
}
