/**
 * Writes an Exarchos-managed block, fenced by markers, into a consumer Markdown file such as `AGENTS.md`.
 * The consumer owns the file. Exarchos owns only the region between the markers, and each byte outside them stays the same.
 * The fence markers are a copy of those in `src/install/binding.ts`. A test asserts that the two copies match.
 *
 * Rules at this boundary:
 *   - A block is present only for exactly one clean `START`/`END` pair. A lone or duplicated marker counts as absent, so a new block is appended with a warning.
 *   - The block embeds a content hash. When the hash is equal, nothing is written.
 *   - When the content changes, one backup is written, then the block is replaced in place.
 *   - The block uses the existing line ending of the file (LF or CRLF).
 *   - The write is atomic, through `atomicWriteFile`. A missing file is created with only the block.
 *   - An I/O failure returns a structured error with `suggestedFix`, not a throw.
 *   - After the write, a re-read checks the block. A mismatch gives a warning.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import { atomicWriteFile } from '../../utils/atomic-write.js';

/** Fence opening the Exarchos-managed region. Mirrors root `binding.ts`. */
export const BINDING_MARKER_START = '<!-- exarchos:binding:start -->';

/** Fence closing the Exarchos-managed region. Mirrors root `binding.ts`. */
export const BINDING_MARKER_END = '<!-- exarchos:binding:end -->';

/** Prefix of the in-block provenance comment (carries the content hash). */
const PROVENANCE_PREFIX = '<!-- exarchos-managed:';

/** Token labelling the embedded content hash inside the provenance line. */
const HASH_TOKEN = 'content-sha256:';

/** Default suffix for the single change-backup copy. */
const DEFAULT_BACKUP_SUFFIX = '.exarchos.bak';

/** Default provenance descriptor when a caller omits one. */
const DEFAULT_PROVENANCE = 'exarchos-managed block';

/** Which mutation `insertManagedBlock` performed. */
export type ManagedBlockAction = 'created' | 'replaced' | 'unchanged';

/** Detected/emitted line ending for the target file. */
export type ManagedBlockLineEnding = 'lf' | 'crlf';

/** Structured failure code. */
export type ManagedBlockErrorCode = 'MANAGED_BLOCK_WRITE_FAILED' | 'MANAGED_BLOCK_READ_FAILED';

/** A structured, actionable failure (never thrown — returned in the Result). */
export interface ManagedBlockError {
  readonly code: ManagedBlockErrorCode;
  readonly message: string;
  /** A concrete next step the operator can take to unblock. */
  readonly suggestedFix: string;
  /** The underlying error string, for example an `EACCES` message, when available. */
  readonly cause?: string;
}

/** Options for {@link insertManagedBlock}. */
export interface InsertManagedBlockOptions {
  /** Absolute path to the consumer-owned Markdown file, for example `AGENTS.md`. */
  readonly filePath: string;
  /** The inner content Exarchos owns inside the fenced block. */
  readonly content: string;
  /**
   * The provenance text in the comment line of the block, for example the source file and version.
   * The default is a generic label. The content hash is always appended.
   */
  readonly provenance?: string;
}

/** Injected I/O seams for tests. Each defaults to the real `fs` function or to the shared atomic writer. */
export interface InsertManagedBlockDeps {
  readonly existsSync?: (p: string) => boolean;
  readonly readFileSync?: (p: string) => string;
  readonly writeFileAtomic?: (p: string, content: string) => void;
  readonly copyFileSync?: (src: string, dest: string) => void;
  /** Override the backup-file suffix (default {@link DEFAULT_BACKUP_SUFFIX}). */
  readonly backupSuffix?: string;
}

/** The outcome of {@link insertManagedBlock}. */
export type InsertManagedBlockResult =
  | {
      readonly ok: true;
      readonly action: ManagedBlockAction;
      readonly filePath: string;
      /** Present only when a change-backup was written (the `replaced` path). */
      readonly backupPath?: string;
      readonly lineEnding: ManagedBlockLineEnding;
      /** Non-fatal advisories (incomplete markers, round-trip mismatch, …). */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly error: ManagedBlockError };

/** Canonical form for hashing/rendering: LF newlines, outer whitespace trimmed. */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/** 16-hex-char sha256 prefix of the normalized content — the idempotency key. */
function contentHash(content: string): string {
  return crypto.createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex').slice(0, 16);
}

/** Detect the line ending of the file from its first newline. With no newline, the result is LF. */
function detectLineEnding(text: string): '\n' | '\r\n' {
  const idx = text.indexOf('\n');
  if (idx === -1) return '\n';
  return idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

type BlockLocation =
  | { readonly kind: 'complete'; readonly startIdx: number; readonly blockEnd: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' };

/**
 * Find the managed block. It is `complete` only when exactly one `START` and one `END` exist, with `END` after `START`.
 * Zero markers give `absent`. Each other case gives `malformed`, so foreign content is never claimed.
 */
function locateBlock(text: string): BlockLocation {
  const startCount = countOccurrences(text, BINDING_MARKER_START);
  const endCount = countOccurrences(text, BINDING_MARKER_END);
  if (startCount === 0 && endCount === 0) return { kind: 'absent' };
  const startIdx = text.indexOf(BINDING_MARKER_START);
  const endIdx = text.indexOf(BINDING_MARKER_END);
  if (startCount === 1 && endCount === 1 && endIdx > startIdx) {
    return { kind: 'complete', startIdx, blockEnd: endIdx + BINDING_MARKER_END.length };
  }
  return { kind: 'malformed' };
}

/** Extract the embedded content hash from a complete block region, if present. */
function parseEmbeddedHash(blockRegion: string): string | null {
  const match = blockRegion.match(new RegExp(`${HASH_TOKEN}([0-9a-f]+)`));
  return match?.[1] ?? null;
}

/**
 * Render the full fenced block (markers + provenance line + content) with the
 * given end-of-line sequence. The provenance line carries the content hash so a
 * later run can decide idempotency without re-hashing the extracted body.
 */
function renderBlock(content: string, provenance: string, hash: string, eol: '\n' | '\r\n'): string {
  const provenanceLine = `${PROVENANCE_PREFIX} ${provenance} | ${HASH_TOKEN}${hash} -->`;
  const lf = [BINDING_MARKER_START, provenanceLine, normalizeContent(content), BINDING_MARKER_END].join('\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

function writeError(filePath: string, err: unknown): { ok: false; error: ManagedBlockError } {
  const cause = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: {
      code: 'MANAGED_BLOCK_WRITE_FAILED',
      message: `Failed to write the Exarchos managed block to ${filePath}.`,
      suggestedFix: `Ensure ${filePath} and its parent directory are writable (check permissions and disk space), then retry.`,
      cause,
    },
  };
}

function readError(filePath: string, err: unknown): { ok: false; error: ManagedBlockError } {
  const cause = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: {
      code: 'MANAGED_BLOCK_READ_FAILED',
      message: `Failed to read ${filePath} before inserting the Exarchos managed block.`,
      suggestedFix: `Ensure ${filePath} is readable (check permissions), then retry.`,
      cause,
    },
  };
}

/**
 * Insert or update the Exarchos-managed block in `filePath`. The module header gives the rules.
 * On the append path, when the exact block is already present, nothing is written. Thus repeated runs on a malformed file do not stack duplicate blocks.
 * The append path checks only for the presence of the block, because the file stays malformed after the append.
 */
export function insertManagedBlock(
  options: InsertManagedBlockOptions,
  deps: InsertManagedBlockDeps = {},
): InsertManagedBlockResult {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFileAtomic = deps.writeFileAtomic ?? atomicWriteFile;
  const copyFileSync = deps.copyFileSync ?? fs.copyFileSync;
  const backupSuffix = deps.backupSuffix ?? DEFAULT_BACKUP_SUFFIX;

  const { filePath } = options;
  const provenance = options.provenance ?? DEFAULT_PROVENANCE;
  const newHash = contentHash(options.content);
  const warnings: string[] = [];

  if (!existsSync(filePath)) {
    const eol: '\n' = '\n';
    const text = `${renderBlock(options.content, provenance, newHash, eol)}${eol}`;
    try {
      writeFileAtomic(filePath, text);
    } catch (err) {
      return writeError(filePath, err);
    }
    verifyRoundTrip(filePath, newHash, readFileSync, warnings);
    return { ok: true, action: 'created', filePath, lineEnding: 'lf', warnings };
  }

  let existing: string;
  try {
    existing = readFileSync(filePath);
  } catch (err) {
    return readError(filePath, err);
  }

  const eol = detectLineEnding(existing);
  const lineEnding: ManagedBlockLineEnding = eol === '\r\n' ? 'crlf' : 'lf';
  const location = locateBlock(existing);

  if (location.kind === 'complete') {
    const blockRegion = existing.slice(location.startIdx, location.blockEnd);
    const existingHash = parseEmbeddedHash(blockRegion);

    if (existingHash === newHash) {
      return { ok: true, action: 'unchanged', filePath, lineEnding, warnings };
    }

    const backupPath = `${filePath}${backupSuffix}`;
    try {
      copyFileSync(filePath, backupPath);
    } catch (err) {
      return writeError(filePath, err);
    }

    const before = existing.slice(0, location.startIdx);
    const after = existing.slice(location.blockEnd);
    const nextText = `${before}${renderBlock(options.content, provenance, newHash, eol)}${after}`;
    try {
      writeFileAtomic(filePath, nextText);
    } catch (err) {
      return writeError(filePath, err);
    }
    verifyRoundTrip(filePath, newHash, readFileSync, warnings);
    return { ok: true, action: 'replaced', filePath, backupPath, lineEnding, warnings };
  }

  const block = renderBlock(options.content, provenance, newHash, eol);

  if (existing.includes(block)) {
    if (location.kind === 'malformed') {
      warnings.push(
        'Stray or duplicated Exarchos marker(s) detected alongside the managed block — the block is already present and was left unchanged. Remove the stray marker(s) to restore in-place updates.',
      );
    }
    return { ok: true, action: 'unchanged', filePath, lineEnding, warnings };
  }

  if (location.kind === 'malformed') {
    warnings.push(
      'Incomplete or duplicated Exarchos marker pair detected — treating the managed block as absent and appending a fresh block. Remove the stray marker(s) to restore in-place updates.',
    );
  }

  const separator = existing.trim().length > 0 ? `${eol}${eol}` : '';
  const nextText = `${existing}${separator}${block}${eol}`;
  try {
    writeFileAtomic(filePath, nextText);
  } catch (err) {
    return writeError(filePath, err);
  }
  verifyAppendedBlock(filePath, block, readFileSync, warnings);
  return { ok: true, action: 'created', filePath, lineEnding, warnings };
}

/**
 * Re-read the file and make sure that it holds one clean managed block with the expected hash.
 * A mismatch adds to `warnings` and is not a failure, because the atomic write succeeded.
 */
function verifyRoundTrip(
  filePath: string,
  expectedHash: string,
  readFileSync: (p: string) => string,
  warnings: string[],
): void {
  let reread: string;
  try {
    reread = readFileSync(filePath);
  } catch {
    warnings.push('Post-write verification could not re-read the file — the write succeeded but the block was not re-read.');
    return;
  }
  const location = locateBlock(reread);
  if (location.kind !== 'complete') {
    warnings.push('Post-write verification did not find a single clean managed block — a concurrent writer may have modified the file.');
    return;
  }
  const observed = parseEmbeddedHash(reread.slice(location.startIdx, location.blockEnd));
  if (observed !== expectedHash) {
    warnings.push('Post-write verification found a different block hash than written — a concurrent writer may have overwritten the block.');
  }
}

/**
 * Re-read the file and make sure that the appended block is present verbatim. A missing block adds to `warnings`.
 * Unlike {@link verifyRoundTrip}, it does not require one clean marker pair, because the append path leaves malformed foreign markers in place.
 */
function verifyAppendedBlock(
  filePath: string,
  expectedBlock: string,
  readFileSync: (p: string) => string,
  warnings: string[],
): void {
  let reread: string;
  try {
    reread = readFileSync(filePath);
  } catch {
    warnings.push('Post-write verification could not re-read the file — the write succeeded but the block was not re-read.');
    return;
  }
  if (!reread.includes(expectedBlock)) {
    warnings.push('Post-write verification did not find the appended managed block — a concurrent writer may have overwritten it.');
  }
}
