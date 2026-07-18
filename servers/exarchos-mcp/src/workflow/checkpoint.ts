import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CheckpointState, CheckpointMeta } from './types.js';
import { ErrorCode } from './schemas.js';

// ─── Configurable Constants ────────────────────────────────────────────────

export const CHECKPOINT_OPERATION_THRESHOLD: number = Math.max(
  1,
  parseInt(process.env.CHECKPOINT_OPERATION_THRESHOLD || '', 10) || 20,
);

export const STALE_AFTER_MINUTES: number = Math.max(
  1,
  parseInt(process.env.STALE_AFTER_MINUTES || '', 10) || 120,
);

// ─── Checkpoint Functions ──────────────────────────────────────────────────

/** Increment operation counter, return updated checkpoint state (immutable). */
export function incrementOperations(checkpoint: CheckpointState): CheckpointState {
  const now = new Date().toISOString();
  return {
    ...checkpoint,
    operationsSince: checkpoint.operationsSince + 1,
    lastActivityTimestamp: now,
  };
}

/** Check if checkpoint is advised based on operation threshold. */
export function isCheckpointAdvised(checkpoint: CheckpointState): boolean {
  return checkpoint.operationsSince >= CHECKPOINT_OPERATION_THRESHOLD;
}

/**
 * Reset counter on phase transition or explicit checkpoint.
 * Updates timestamp, phase, summary, and resets operationsSince to 0.
 */
export function resetCounter(
  checkpoint: CheckpointState,
  phase: string,
  summary?: string,
): CheckpointState {
  const now = new Date().toISOString();
  return {
    ...checkpoint,
    timestamp: now,
    lastActivityTimestamp: now,
    phase,
    summary: summary ?? `Phase transition to ${phase}`,
    operationsSince: 0,
  };
}

/** Detect staleness: returns true if time since last activity exceeds staleAfterMinutes. */
export function isStale(checkpoint: CheckpointState): boolean {
  const minutesSince = getMinutesSinceActivity(checkpoint);
  return minutesSince > checkpoint.staleAfterMinutes;
}

/** Get minutes since last activity (rounded down). */
export function getMinutesSinceActivity(checkpoint: CheckpointState): number {
  const lastActivity = new Date(checkpoint.lastActivityTimestamp).getTime();
  if (Number.isNaN(lastActivity)) return 0;
  const now = Date.now();
  const diffMs = Math.max(0, now - lastActivity);
  return Math.floor(diffMs / (60 * 1000));
}

/** Build the _meta response block included in every tool response.
 *  Returns slim shape when no action needed, full shape when checkpoint or staleness attention required. */
export function buildCheckpointMeta(checkpoint: CheckpointState): CheckpointMeta {
  const advised = isCheckpointAdvised(checkpoint);
  const stale = isStale(checkpoint);

  if (!advised && !stale) {
    return { checkpointAdvised: false };
  }

  return {
    checkpointAdvised: advised,
    operationsSinceCheckpoint: checkpoint.operationsSince,
    lastCheckpointPhase: checkpoint.phase,
    lastCheckpointTimestamp: checkpoint.timestamp,
    stale,
    minutesSinceActivity: getMinutesSinceActivity(checkpoint),
  };
}

// ─── Checkpoint Gate (DR-5, DR-10) ────────────────────────────────────────

export interface CheckpointGateResult {
  gated: boolean;
  gate?: 'checkpoint_required';
  operationsSince?: number;
  threshold?: number;
  warning?: string;
}

export interface CheckpointEnforcementConfig {
  operationThreshold: number;
  enforceOnPhaseTransition: boolean;
  enforceOnWaveDispatch: boolean;
}

/**
 * Evaluate whether a checkpoint gate should block the current action.
 *
 * - Nullish checkpoint state: graceful degradation (DR-10) — returns not-gated with warning.
 * - Action-type enforcement toggles: config can disable gate per action type.
 * - Threshold comparison: operationsSince >= operationThreshold triggers the gate.
 */
export function shouldEnforceCheckpoint(
  checkpoint: CheckpointState | undefined | null,
  config: CheckpointEnforcementConfig,
  actionType: 'phase-transition' | 'wave-dispatch',
): CheckpointGateResult {
  // DR-10: graceful degradation when checkpoint state is missing
  if (checkpoint == null) {
    return { gated: false, warning: 'checkpoint-state-missing' };
  }

  // Check action-type enforcement toggles
  if (actionType === 'phase-transition' && !config.enforceOnPhaseTransition) {
    return { gated: false };
  }
  if (actionType === 'wave-dispatch' && !config.enforceOnWaveDispatch) {
    return { gated: false };
  }

  // Threshold comparison
  if (checkpoint.operationsSince >= config.operationThreshold) {
    return {
      gated: true,
      gate: 'checkpoint_required',
      operationsSince: checkpoint.operationsSince,
      threshold: config.operationThreshold,
    };
  }

  return { gated: false };
}

// ─── Checkpoint context @path substitution (DR-20, #1245) ──────────────────

/**
 * Byte cap for `@<path>`-substituted handoff context. Mirrors the
 * `CheckpointHandoffSchema.context` cap (`z.string().max(2048)`, DIM-7):
 * a UTF-8 file of ≤ 2048 bytes always decodes to a string of ≤ 2048
 * UTF-16 code units, so any file that passes this byte cap also passes
 * the schema's character cap — the substituted value can never fail
 * downstream re-validation on either the dispatch-input or the
 * persisted-event (`event-store/schemas.ts:HandoffEntryData`) side.
 */
export const CONTEXT_AT_PATH_MAX_BYTES = 2048;

/** Structured failure reasons for `resolveContextArgument` (INV-5b `data`). */
export type ContextAtPathFailureReason =
  | 'ENOENT'
  | 'NOT_A_FILE'
  | 'OVERSIZE'
  | 'EMPTY_PATH'
  | 'IO_ERROR'
  /**
   * The resolved (or symlink-canonicalized) path lands OUTSIDE the workspace
   * containment root — an absolute path elsewhere on the filesystem, a
   * `..`-traversal that climbs out of the root, or an in-workspace symlink
   * whose target escapes. DR-20 security (#1245): without this the `@<path>`
   * reader is a read-any-file-into-the-durable-log primitive.
   */
  | 'PATH_ESCAPE';

export type ResolveContextResult =
  | {
      readonly ok: true;
      /** Final context value — file content when substituted, the raw string otherwise. */
      readonly context: string;
      /** True iff the value was read from a file via `@<path>` syntax. */
      readonly substituted: boolean;
    }
  | {
      readonly ok: false;
      /** INV-5b error envelope fragment — lands on `ToolResult.error` verbatim. */
      readonly error: { readonly code: string; readonly message: string };
      /** Structured detail — lands on the ToolResult's top-level `data` block. */
      readonly details: {
        readonly path: string;
        readonly reason: ContextAtPathFailureReason;
        readonly sizeBytes?: number;
        readonly maxBytes?: number;
        /** Containment root the escaped path was checked against (`PATH_ESCAPE` only). */
        readonly root?: string;
      };
    };

/**
 * DR-20 (#1245) — `@<path>` argument substitution for the checkpoint
 * handoff context field.
 *
 * `workflow checkpoint --context @notes.md` (or an MCP dispatch carrying
 * `handoff.context: '@notes.md'`) reads the file at `<path>` into the
 * context value. Implemented at the handler/schema seam — NOT as a
 * bespoke Commander flag parser — because CLI flags auto-emit from the
 * action's Zod schema, so both the CLI and MCP arms flow through this
 * one resolver (INV-4 parity).
 *
 * Contract:
 * - Values NOT starting with `@` pass through verbatim (no fs access).
 * - `@` with an empty/blank path → structured `INVALID_INPUT`.
 * - Path escapes the workspace containment root (absolute path elsewhere,
 *   `..`-traversal out of `workspaceRoot`, or an in-workspace symlink whose
 *   real target escapes) → structured `INVALID_INPUT` with
 *   `details.reason === 'PATH_ESCAPE'`. The lexical check runs BEFORE any
 *   `fs` access (defense in depth), so an out-of-root absolute/traversal
 *   path is rejected without ever touching the file; the symlink check runs
 *   on the `fs.realpath` result. This is the DR-20 security boundary
 *   (#1245): it prevents the reader from becoming a
 *   read-any-file-into-the-durable-log primitive.
 * - Missing file → structured `FILE_IO_ERROR` with `ENOENT` in the
 *   message and `details.reason === 'ENOENT'` — never a raw exception.
 * - Directory / non-regular file → structured `INVALID_INPUT`.
 * - File over {@link CONTEXT_AT_PATH_MAX_BYTES} → structured
 *   `INVALID_INPUT` with actual/max sizes in `details` (checked via
 *   `stat` BEFORE reading, so an oversize file is never buffered).
 * - Relative paths resolve against `workspaceRoot` (the project the
 *   checkpoint belongs to), which defaults to the process working
 *   directory. The composite handler threads `ctx.cwd ?? process.cwd()`
 *   — the canonical project entry point — so the CLI and MCP arms share
 *   one containment root (INV-4 parity).
 *
 * @param workspaceRoot Absolute (or cwd-relative) containment root. Any
 *   resolved path outside it is rejected. Defaults to `process.cwd()`.
 */
export async function resolveContextArgument(
  raw: string,
  workspaceRoot: string = process.cwd(),
): Promise<ResolveContextResult> {
  if (!raw.startsWith('@')) {
    return { ok: true, context: raw, substituted: false };
  }

  const rawPath = raw.slice(1);
  if (rawPath.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message:
          'context @<path> substitution: path is empty — pass @./notes.md or an absolute path after the @',
      },
      details: { path: rawPath, reason: 'EMPTY_PATH' },
    };
  }

  // Resolve relative paths against the workspace root (the project the
  // checkpoint belongs to), not the ambient cwd, so containment is
  // well-defined for both the CLI and MCP arms.
  const rootAbs = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(rootAbs, rawPath);

  // DR-20 security (#1245, v2-12 review) — path containment, LEXICAL layer.
  // An absolute path pointing elsewhere on disk, or a `..`-traversal that
  // climbs out of the workspace, is rejected BEFORE any filesystem access
  // (defense in depth): an out-of-root path is never even `stat`'d, let
  // alone read into the append-only, syncable event log.
  if (!isPathWithinRoot(resolvedPath, rootAbs)) {
    return pathEscapeResult(resolvedPath, rootAbs);
  }

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: ErrorCode.FILE_IO_ERROR,
          message: `context file not found (ENOENT): ${resolvedPath}`,
        },
        details: { path: resolvedPath, reason: 'ENOENT' },
      };
    }
    return {
      ok: false,
      error: {
        code: ErrorCode.FILE_IO_ERROR,
        message: `context file unreadable (${errno ?? 'unknown errno'}): ${resolvedPath}`,
      },
      details: { path: resolvedPath, reason: 'IO_ERROR' },
    };
  }

  if (!stats.isFile()) {
    return {
      ok: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: `context @<path> substitution: not a regular file: ${resolvedPath}`,
      },
      details: { path: resolvedPath, reason: 'NOT_A_FILE' },
    };
  }

  if (stats.size > CONTEXT_AT_PATH_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message:
          `context file exceeds the ${CONTEXT_AT_PATH_MAX_BYTES}-byte handoff.context cap ` +
          `(${stats.size} bytes): ${resolvedPath}`,
      },
      details: {
        path: resolvedPath,
        reason: 'OVERSIZE',
        sizeBytes: stats.size,
        maxBytes: CONTEXT_AT_PATH_MAX_BYTES,
      },
    };
  }

  // DR-20 security (#1245, v2-12 review) — path containment, SYMLINK layer.
  // The lexical check above cannot see through symlinks: a link that sits
  // lexically inside the workspace but points outside would slip through
  // and still read an out-of-root file. `fs.realpath` canonicalizes every
  // symlink in the path; compare the real target against the REAL workspace
  // root (the root itself may sit under a symlink — e.g. `/var` → `/private/var`
  // on macOS, or a symlinked temp dir — so realpath both sides to avoid a
  // false-positive rejection of a legitimate in-workspace file). Runs before
  // `readFile`, so an escaping symlink's target is never read.
  let realPath: string;
  let realRoot: string;
  try {
    realPath = await fs.realpath(resolvedPath);
    realRoot = await fs.realpath(rootAbs);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: {
        code: ErrorCode.FILE_IO_ERROR,
        message: `context file path canonicalization failed (${errno ?? 'unknown errno'}): ${resolvedPath}`,
      },
      details: { path: resolvedPath, reason: 'IO_ERROR' },
    };
  }
  if (!isPathWithinRoot(realPath, realRoot)) {
    return pathEscapeResult(realPath, realRoot);
  }

  let content: string;
  try {
    content = await fs.readFile(realPath, 'utf8');
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: {
        code: ErrorCode.FILE_IO_ERROR,
        message: `context file read failed (${errno ?? 'unknown errno'}): ${resolvedPath}`,
      },
      details: { path: resolvedPath, reason: 'IO_ERROR' },
    };
  }

  return { ok: true, context: content, substituted: true };
}

/**
 * Lexical containment predicate for {@link resolveContextArgument}: is
 * `candidate` the same as, or nested inside, `root`? Both are expected to be
 * absolute, normalized paths (callers pass `path.resolve(...)` output).
 *
 * Rejects `..`-escaping relatives and cross-drive/cross-root paths (a
 * different Windows drive makes `path.relative` return an absolute path).
 * A file literally named `..name` is NOT a traversal — only an exact `..`
 * segment or a `../` prefix is — so the check keys on the path separator.
 */
function isPathWithinRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  if (rel.length === 0) return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** Build the structured `PATH_ESCAPE` INV-5b failure envelope. */
function pathEscapeResult(resolvedPath: string, root: string): ResolveContextResult {
  return {
    ok: false,
    error: {
      code: ErrorCode.INVALID_INPUT,
      message:
        'context @<path> substitution: path escapes the workspace root — ' +
        `refusing to read a file outside ${root}: ${resolvedPath}`,
    },
    details: { path: resolvedPath, reason: 'PATH_ESCAPE', root },
  };
}

/** Create initial checkpoint state for new workflows. */
export function createInitialCheckpoint(phase: string): CheckpointState {
  const now = new Date().toISOString();
  return {
    timestamp: now,
    phase,
    summary: `Workflow initialized at ${phase}`,
    operationsSince: 0,
    fixCycleCount: 0,
    lastActivityTimestamp: now,
    staleAfterMinutes: STALE_AFTER_MINUTES,
  };
}
