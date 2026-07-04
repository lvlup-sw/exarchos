/**
 * Consumer-side managed-block writer (task 012).
 *
 * `insertManagedBlock` inserts or updates an Exarchos-owned, marker-fenced block
 * inside a consumer's Markdown file (e.g. `AGENTS.md`). The consumer OWNS the
 * file; Exarchos owns ONLY the fenced region between the two sentinels. Every
 * byte outside the markers is preserved verbatim.
 *
 * Fence sentinels are single-sourced conceptually to the workspace-root
 * `src/binding.ts` (`BINDING_MARKER_START` / `BINDING_MARKER_END`), but the MCP
 * server package cannot import across the package boundary (tsc `rootDir: "./src"`
 * — TS6059). So this module carries its OWN copy of the fence constants and the
 * companion `managed-block.test.ts` adds a cross-package EQUALITY GUARD that
 * reads the root `binding.ts` source TEXT and asserts the literals match — drift
 * is caught statically, with no runtime import and no JS bridge.
 *
 * Semantics (all load-bearing — this is a boundary module):
 *   - Complete-pair-only markers — a block is present only when EXACTLY ONE clean
 *     `START`/`END` pair exists. Any other marker configuration (a lone marker, a
 *     duplicated marker) is treated as ABSENT: we append a fresh block and warn,
 *     never claiming or replacing foreign content.
 *   - Content-hash idempotency — the block embeds a content hash. When the
 *     existing block's hash equals the new content's hash we do NOTHING (no
 *     write, no backup).
 *   - Backup-once on change — when content differs, back the file up exactly once,
 *     then replace the block IN PLACE (bytes before/after the markers untouched).
 *   - LF/CRLF preservation — the file's existing line ending is detected and the
 *     rendered block adopts it (INV-16 Windows portability).
 *   - Atomic write — staged via the shared `atomicWriteFile` (temp + fsync +
 *     rename), so a concurrent reader never sees a partial write.
 *   - Missing-file creation — a fresh file containing just the block.
 *   - Structured error with `suggestedFix` when the target is unwritable.
 *   - Post-write re-read verification — the block is re-read and round-tripped;
 *     a mismatch (a racing writer) yields a structured warning, not a throw.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import { atomicWriteFile } from '../utils/atomic-write.js';

// ─── Fence constants (own copy — see the module header + equality guard) ──────

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

// ─── Public shapes ────────────────────────────────────────────────────────────

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
  /** Underlying error string (e.g. an `EACCES` message), when available. */
  readonly cause?: string;
}

/** Options for {@link insertManagedBlock}. */
export interface InsertManagedBlockOptions {
  /** Absolute path to the consumer-owned Markdown file (e.g. `AGENTS.md`). */
  readonly filePath: string;
  /** The inner content Exarchos owns inside the fenced block. */
  readonly content: string;
  /**
   * Provenance descriptor recorded in the block's comment line (e.g. the source
   * file + version). Defaults to a generic label. The content hash is always
   * appended regardless.
   */
  readonly provenance?: string;
}

/**
 * Injected I/O seams (all default to the real `fs` / shared atomic writer). Tests
 * steer file mutation deterministically — e.g. a throwing `writeFileAtomic` for
 * the unwritable-target path, or a counting `copyFileSync` to prove backup-once.
 */
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

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Canonical form for hashing/rendering: LF newlines, outer whitespace trimmed. */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/** 16-hex-char sha256 prefix of the normalized content — the idempotency key. */
function contentHash(content: string): string {
  return crypto.createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Detect the file's dominant line ending from its FIRST newline. Absent any
 * newline, default to LF. Preserved on write (INV-16).
 */
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
 * Locate the managed block. Complete-pair-only: a block is present ONLY when
 * exactly one `START` and one `END` exist with `END` after `START`. Zero markers
 * ⇒ absent. Anything else (a lone marker, duplicated markers) ⇒ malformed — we
 * never treat ambiguous marker soup as ours, so foreign content is never claimed.
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
  return match ? match[1] : null;
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

// ─── Structured-error builders ────────────────────────────────────────────────

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

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Insert or update the Exarchos-managed fenced block in `filePath`. Synchronous,
 * Result-returning (never throws for expected I/O failures). See the module
 * header for the full semantics contract.
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

  // ── Missing file → create with just the block (default LF) ──
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

  // ── Read existing ──
  let existing: string;
  try {
    existing = readFileSync(filePath);
  } catch (err) {
    return readError(filePath, err);
  }

  const eol = detectLineEnding(existing);
  const lineEnding: ManagedBlockLineEnding = eol === '\r\n' ? 'crlf' : 'lf';
  const location = locateBlock(existing);

  // ── Exactly one clean pair → maybe replace in place ──
  if (location.kind === 'complete') {
    const blockRegion = existing.slice(location.startIdx, location.blockEnd);
    const existingHash = parseEmbeddedHash(blockRegion);

    // Content-hash idempotency: identical content ⇒ no write, no backup.
    if (existingHash === newHash) {
      return { ok: true, action: 'unchanged', filePath, lineEnding, warnings };
    }

    // Changed ⇒ back up exactly once, then replace the region IN PLACE.
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

  // ── Absent or malformed → append a fresh block (never claim foreign markers) ──
  if (location.kind === 'malformed') {
    warnings.push(
      'Incomplete or duplicated Exarchos marker pair detected — treating the managed block as absent and appending a fresh block. Remove the stray marker(s) to restore in-place updates.',
    );
  }

  const block = renderBlock(options.content, provenance, newHash, eol);
  const separator = existing.trim().length > 0 ? `${eol}${eol}` : '';
  const nextText = `${existing}${separator}${block}${eol}`;
  try {
    writeFileAtomic(filePath, nextText);
  } catch (err) {
    return writeError(filePath, err);
  }
  verifyRoundTrip(filePath, newHash, readFileSync, warnings);
  return { ok: true, action: 'created', filePath, lineEnding, warnings };
}

/**
 * Re-read the just-written file and confirm the managed block round-trips to the
 * hash we wrote. A mismatch means a concurrent writer clobbered us between write
 * and re-read — a structured WARNING (not a failure), since the atomic write
 * itself succeeded. Mutates `warnings` in place.
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
