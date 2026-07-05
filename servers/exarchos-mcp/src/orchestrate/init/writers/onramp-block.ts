/**
 * Consumer on-ramp writers (Task 013, DR-5).
 *
 * Emits the runtime-neutral Exarchos orientation block into a consumer's
 * `AGENTS.md` (every harness reads it) and a `CLAUDE.md` *shim* whose managed
 * block carries a single own-line `@AGENTS.md` import (Claude Code follows the
 * import to reach the same one-source orientation). Both writes route through
 * Task 012's {@link insertManagedBlock} — this module NEVER reimplements block
 * insertion, and it reuses that module's fence constants (which the Task-012
 * equality-guard test pins to the root `src/binding.ts` source), so there is no
 * second copy of the block content nor a second set of fence constants.
 *
 * The block CONTENT has a single source of truth: `binding/standard/block.md`
 * (the runtime-neutral block Task 006 produced). {@link loadCanonicalBlockBody}
 * reads it and strips the outer fences; the resulting body is the byte-identical
 * payload {@link insertManagedBlock} re-fences into `AGENTS.md`.
 *
 * DR-5 guards enforced here:
 *   - the `AGENTS.md` block is self-contained — NO `@imports` inside it (the
 *     shim's `@AGENTS.md` lives in `CLAUDE.md`, never in the block itself);
 *   - size guards — the block stays within a 4 KiB budget, and the writer warns
 *     when the target file approaches the Codex 32 KiB instruction-file cap.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  insertManagedBlock,
  BINDING_MARKER_START,
  BINDING_MARKER_END,
  type InsertManagedBlockDeps,
} from '../../../onramp/managed-block.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Consumer-owned instructions file every harness reads. */
export const AGENTS_MD_FILENAME = 'AGENTS.md';

/** Claude Code's always-loaded instructions file (holds the import shim). */
export const CLAUDE_MD_FILENAME = 'CLAUDE.md';

/** The own-line import the `CLAUDE.md` shim block carries. */
export const CLAUDE_MD_IMPORT_LINE = '@AGENTS.md';

/** Codex's instruction-file cap (32 KiB). Approaching it risks truncation. */
export const CODEX_FILE_CAP_BYTES = 32 * 1024;

/** Warn once the target file reaches 90% of the Codex cap ("near the cap"). */
export const CODEX_WARN_BYTES = Math.floor(CODEX_FILE_CAP_BYTES * 0.9);

/** DR-5 budget for the on-ramp block payload itself (4 KiB). */
export const MAX_BLOCK_BYTES = 4 * 1024;

/** Provenance descriptor recorded in the `AGENTS.md` managed block. */
export const AGENTS_MD_PROVENANCE = 'exarchos on-ramp | source binding/standard/block.md';

/** Provenance descriptor recorded in the `CLAUDE.md` shim block. */
export const CLAUDE_MD_PROVENANCE = 'exarchos on-ramp shim | imports AGENTS.md';

/** Leading provenance comment insertManagedBlock renders inside a block. */
const PROVENANCE_PREFIX = '<!-- exarchos-managed:';

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the inner body of a binding-fenced block: everything between
 * {@link BINDING_MARKER_START} and {@link BINDING_MARKER_END}, with a leading
 * `insertManagedBlock` provenance comment (if present) removed, trimmed. Text
 * without a complete fence pair is returned normalized+trimmed as-is. Reuses the
 * Task-012 fence constants — no second fence copy.
 */
export function stripBindingFences(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const startIdx = normalized.indexOf(BINDING_MARKER_START);
  const endIdx = normalized.indexOf(BINDING_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return normalized.trim();
  }
  let inner = normalized.slice(startIdx + BINDING_MARKER_START.length, endIdx).trim();
  if (inner.startsWith(PROVENANCE_PREFIX)) {
    const nl = inner.indexOf('\n');
    inner = nl === -1 ? '' : inner.slice(nl + 1).trim();
  }
  return inner;
}

/**
 * True when `content` carries an own-line `@import` directive (e.g. `@AGENTS.md`
 * or `@./path`). Used to reject `@imports` inside the self-contained `AGENTS.md`
 * block (the `CLAUDE.md` shim's `@AGENTS.md` is intentional and NOT run through
 * this guard).
 */
export function containsAtImport(content: string): boolean {
  return /^\s*@[^\s]+\s*$/m.test(content);
}

/** Byte length of `text` as UTF-8. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Size advisories for an on-ramp write: the block payload's 4 KiB budget and the
 * target file's approach to the Codex 32 KiB cap. Pure — the caller supplies the
 * measured byte counts.
 */
export function sizeGuardWarnings(params: {
  readonly filePath: string;
  readonly fileBytes: number;
  readonly blockBytes: number;
}): string[] {
  const warnings: string[] = [];
  if (params.blockBytes > MAX_BLOCK_BYTES) {
    warnings.push(
      `Exarchos on-ramp block is ${params.blockBytes} bytes, over the ${MAX_BLOCK_BYTES}-byte (4 KiB) budget for ${params.filePath}.`,
    );
  }
  if (params.fileBytes >= CODEX_WARN_BYTES) {
    warnings.push(
      `${params.filePath} is ${params.fileBytes} bytes, near the Codex ${CODEX_FILE_CAP_BYTES}-byte (32 KiB) instruction-file cap — trim it to avoid truncation.`,
    );
  }
  return warnings;
}

// ─── Canonical block source ───────────────────────────────────────────────────

/** Injected reads for the canonical block loader (defaults to real `fs`). */
export interface CanonicalBlockDeps {
  readonly readFileSync?: (p: string) => string;
  readonly existsSync?: (p: string) => boolean;
  /** Explicit path to `block.md` (defaults to {@link resolveCanonicalBlockPath}). */
  readonly blockPath?: string;
}

/**
 * Resolve `binding/standard/block.md`. The block is an Exarchos-bundled asset
 * (never in the consumer repo), so we resolve it relative to this module and the
 * process cwd, trying each candidate and returning the first that exists.
 */
export function resolveCanonicalBlockPath(existsSync: (p: string) => boolean = fs.existsSync): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const rel = ['binding', 'standard', 'block.md'];
  const candidates = [
    // src / dev layout: src/orchestrate/init/writers → repo root (6 up).
    resolve(here, '..', '..', '..', '..', '..', '..', ...rel),
    // bundled layout: dist/... one level shallower.
    resolve(here, '..', '..', '..', '..', '..', ...rel),
    // running from the repo/consumer root.
    resolve(process.cwd(), ...rel),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/**
 * Load the canonical on-ramp block body from `binding/standard/block.md` (fences
 * stripped). Returns `null` when the asset can't be read — callers fail open
 * (skip the on-ramp write) rather than fabricate a second copy of the content.
 */
export function loadCanonicalBlockBody(deps: CanonicalBlockDeps = {}): string | null {
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const existsSync = deps.existsSync ?? fs.existsSync;
  const blockPath = deps.blockPath ?? resolveCanonicalBlockPath(existsSync);
  try {
    return stripBindingFences(readFileSync(blockPath));
  } catch {
    return null;
  }
}

// ─── Writers ──────────────────────────────────────────────────────────────────

/** The outcome of a single on-ramp block write. */
export interface OnrampBlockResult {
  readonly ok: boolean;
  readonly filePath: string;
  readonly action?: 'created' | 'replaced' | 'unchanged';
  readonly warnings: readonly string[];
  /** Structured failure detail when `ok` is false. */
  readonly error?: string;
}

/** Byte length of the file at `filePath`, or 0 if unreadable. */
function measureFileBytes(filePath: string, deps: InsertManagedBlockDeps): number {
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  try {
    return byteLength(readFileSync(filePath));
  } catch {
    return 0;
  }
}

/**
 * Write (or update) the runtime-neutral on-ramp block into `<projectRoot>/AGENTS.md`.
 * The `canonicalBody` MUST be the fence-stripped `binding/standard/block.md`
 * content; it is rejected if it carries an `@import` (the block must be
 * self-contained). Size advisories are appended for the block budget and the
 * Codex cap.
 */
export function writeAgentsMdBlock(
  opts: { readonly projectRoot: string; readonly canonicalBody: string },
  deps: InsertManagedBlockDeps = {},
): OnrampBlockResult {
  const filePath = join(opts.projectRoot, AGENTS_MD_FILENAME);

  if (containsAtImport(opts.canonicalBody)) {
    return {
      ok: false,
      filePath,
      warnings: [],
      error: `The ${AGENTS_MD_FILENAME} on-ramp block must be self-contained — it must not carry an @import.`,
    };
  }

  const result = insertManagedBlock(
    { filePath, content: opts.canonicalBody, provenance: AGENTS_MD_PROVENANCE },
    deps,
  );
  if (!result.ok) {
    return { ok: false, filePath, warnings: [], error: result.error.message };
  }

  const warnings = [
    ...result.warnings,
    ...sizeGuardWarnings({
      filePath,
      fileBytes: measureFileBytes(filePath, deps),
      blockBytes: byteLength(opts.canonicalBody),
    }),
  ];
  return { ok: true, filePath, action: result.action, warnings };
}

/**
 * Write (or update) the `CLAUDE.md` shim: a managed block whose only content is
 * the own-line `@AGENTS.md` import. Claude Code follows the import to the same
 * one-source orientation, so the block content is never duplicated across files.
 */
export function writeClaudeMdShim(
  opts: { readonly projectRoot: string },
  deps: InsertManagedBlockDeps = {},
): OnrampBlockResult {
  const filePath = join(opts.projectRoot, CLAUDE_MD_FILENAME);
  const content = CLAUDE_MD_IMPORT_LINE;

  const result = insertManagedBlock(
    { filePath, content, provenance: CLAUDE_MD_PROVENANCE },
    deps,
  );
  if (!result.ok) {
    return { ok: false, filePath, warnings: [], error: result.error.message };
  }

  const warnings = [
    ...result.warnings,
    ...sizeGuardWarnings({
      filePath,
      fileBytes: measureFileBytes(filePath, deps),
      blockBytes: byteLength(content),
    }),
  ];
  return { ok: true, filePath, action: result.action, warnings };
}

/** The composed on-ramp deploy result (AGENTS.md block + CLAUDE.md shim). */
export interface DeployOnrampResult {
  readonly wrote: boolean;
  readonly warnings: readonly string[];
}

/**
 * Deploy both on-ramp surfaces for a project: the `AGENTS.md` block and the
 * `CLAUDE.md` `@AGENTS.md` shim. The canonical body is loaded from
 * `binding/standard/block.md` unless supplied. When the canonical block can't be
 * resolved the deploy fails open (no write) with an advisory — never a fabricated
 * block.
 */
export function deployOnrampBlocks(
  opts: { readonly projectRoot: string; readonly canonicalBody?: string | null },
  deps: InsertManagedBlockDeps & CanonicalBlockDeps = {},
): DeployOnrampResult {
  const canonicalBody = opts.canonicalBody ?? loadCanonicalBlockBody(deps);
  if (canonicalBody == null) {
    return {
      wrote: false,
      warnings: [
        `Exarchos on-ramp skipped: canonical ${AGENTS_MD_FILENAME} block source (binding/standard/block.md) not found.`,
      ],
    };
  }

  const warnings: string[] = [];
  const agents = writeAgentsMdBlock({ projectRoot: opts.projectRoot, canonicalBody }, deps);
  warnings.push(...agents.warnings);
  if (agents.error) warnings.push(agents.error);

  const shim = writeClaudeMdShim({ projectRoot: opts.projectRoot }, deps);
  warnings.push(...shim.warnings);
  if (shim.error) warnings.push(shim.error);

  return { wrote: agents.ok || shim.ok, warnings };
}
