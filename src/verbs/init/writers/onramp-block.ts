/**
 * Consumer on-ramp writers. They write the runtime-neutral Exarchos orientation block into the
 * `AGENTS.md` of a consumer, and a `CLAUDE.md` shim whose managed block holds one `@AGENTS.md`
 * import line. Claude Code follows that import to the same block.
 *
 * Both writes go through {@link insertManagedBlock} and reuse its fence constants. The block
 * content comes from `binding/standard/block.md` through {@link loadCanonicalBlockBody}.
 *
 * The `AGENTS.md` block must be self-contained, with no `@` import inside it. The writers warn
 * when the block passes 4 KiB or the target file nears the Codex 32 KiB cap.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { toPosix } from '../../../utils/paths.js';
import {
  insertManagedBlock,
  BINDING_MARKER_START,
  BINDING_MARKER_END,
  type InsertManagedBlockDeps,
} from '../../../install/onramp/managed-block.js';

/** The consumer-owned instructions file that holds the on-ramp block. */
export const AGENTS_MD_FILENAME = 'AGENTS.md';

/** Claude Code's always-loaded instructions file (holds the import shim). */
export const CLAUDE_MD_FILENAME = 'CLAUDE.md';

/** The own-line import the `CLAUDE.md` shim block carries. */
export const CLAUDE_MD_IMPORT_LINE = '@AGENTS.md';

/** Codex's instruction-file cap (32 KiB). Approaching it risks truncation. */
export const CODEX_FILE_CAP_BYTES = 32 * 1024;

/** Warn once the target file reaches 90% of the Codex cap ("near the cap"). */
export const CODEX_WARN_BYTES = Math.floor(CODEX_FILE_CAP_BYTES * 0.9);

/** The size budget for the on-ramp block payload (4 KiB). */
export const MAX_BLOCK_BYTES = 4 * 1024;

/** Provenance descriptor recorded in the `AGENTS.md` managed block. */
export const AGENTS_MD_PROVENANCE = 'exarchos on-ramp | source binding/standard/block.md';

/** Provenance descriptor recorded in the `CLAUDE.md` shim block. */
export const CLAUDE_MD_PROVENANCE = 'exarchos on-ramp shim | imports AGENTS.md';

/** Leading provenance comment insertManagedBlock renders inside a block. */
const PROVENANCE_PREFIX = '<!-- exarchos-managed:';

/**
 * Extracts the trimmed body between {@link BINDING_MARKER_START} and {@link BINDING_MARKER_END},
 * without a leading `insertManagedBlock` provenance comment. Text without a complete fence pair
 * comes back normalized and trimmed.
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
 * True when `content` holds an own-line `@import` directive, for example `@AGENTS.md` or
 * `@./path`. The `AGENTS.md` writer uses it to refuse an import inside its block.
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

/** Injected reads for the canonical block loader (defaults to real `fs`). */
export interface CanonicalBlockDeps {
  readonly readFileSync?: (p: string) => string;
  readonly existsSync?: (p: string) => boolean;
  /** Explicit path to `block.md` (defaults to {@link resolveCanonicalBlockPath}). */
  readonly blockPath?: string;
}

/**
 * Resolves `binding/standard/block.md`, a bundled asset that is not in the consumer repo. It tries
 * the repo root of the source layout (six levels up), then the bundled layout (five levels up),
 * then the process cwd. It returns the first path that exists, or the first candidate.
 */
export function resolveCanonicalBlockPath(existsSync: (p: string) => boolean = fs.existsSync): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const rel = ['binding', 'standard', 'block.md'];
  const candidates = [
    resolve(here, '..', '..', '..', '..', '..', '..', ...rel),
    resolve(here, '..', '..', '..', '..', '..', ...rel),
    resolve(process.cwd(), ...rel),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/**
 * Loads the canonical on-ramp block body from `binding/standard/block.md`, without fences. It
 * returns `null` when the asset cannot be read. Callers then skip the write and make no second
 * copy of the content.
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
 * Writes or updates the on-ramp block in `<projectRoot>/AGENTS.md`. `canonicalBody` must be the
 * fence-stripped `binding/standard/block.md` content. A body with an `@import` is refused. The
 * result adds size warnings for the block budget and the Codex cap.
 */
export function writeAgentsMdBlock(
  opts: { readonly projectRoot: string; readonly canonicalBody: string },
  deps: InsertManagedBlockDeps = {},
): OnrampBlockResult {
  const filePath = toPosix(join(opts.projectRoot, AGENTS_MD_FILENAME));

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
 * Writes or updates the `CLAUDE.md` shim, a managed block that holds only the `@AGENTS.md` import
 * line. Claude Code follows the import, so the block content stays in one file.
 */
export function writeClaudeMdShim(
  opts: { readonly projectRoot: string },
  deps: InsertManagedBlockDeps = {},
): OnrampBlockResult {
  const filePath = toPosix(join(opts.projectRoot, CLAUDE_MD_FILENAME));
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
  /**
   * True when either on-ramp surface did not land: the `AGENTS.md` block or the `CLAUDE.md` shim.
   * `wrote` is true when either surface wrote, so it cannot show a partial failure. The onboard
   * reconcile gate keeps the retired hooks in place while this flag is true.
   */
  readonly failed: boolean;
  readonly warnings: readonly string[];
}

/**
 * Deploys the `AGENTS.md` block and the `CLAUDE.md` shim for a project. The body comes from
 * `binding/standard/block.md` unless the caller supplies it. When the canonical block is missing,
 * it writes nothing and returns `failed: true` with a warning.
 *
 * `failed` is true when either surface fails. Claude Code reaches the `AGENTS.md` block only
 * through the shim, so a failed shim also leaves Claude Code without an on-ramp.
 */
export function deployOnrampBlocks(
  opts: { readonly projectRoot: string; readonly canonicalBody?: string | null },
  deps: InsertManagedBlockDeps & CanonicalBlockDeps = {},
): DeployOnrampResult {
  const canonicalBody = opts.canonicalBody ?? loadCanonicalBlockBody(deps);
  if (canonicalBody == null) {
    return {
      wrote: false,
      failed: true,
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

  return { wrote: agents.ok || shim.ok, failed: !agents.ok || !shim.ok, warnings };
}
