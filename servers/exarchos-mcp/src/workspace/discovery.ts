// ─── #1290 — Roots-based workspace discovery ─────────────────────────────────
//
// Resolution priority for a missing `featureId` at the dispatch boundary:
//
//     explicit > roots > cwd
//
// The dispatch path (see `core/dispatch.ts`) only invokes
// `resolveWorkspace` when the caller's payload omits `featureId`; an
// explicitly-supplied id always wins. When the client has declared the
// `roots` capability via `notifications/roots/list_changed`, the
// resolver inspects each root for an Exarchos workspace signature
// (`.exarchos.yml` or a state file under `docs/workflow-state/`). A
// single match returns the resolution; multiple matches return an
// `INVALID_INPUT` shape with `validTargets` so the caller can disambig-
// uate; zero matches falls back to a cwd-walk.
//
// The roots list is cached on the supplied {@link CapabilityResolver}.
// MCP clients emit `notifications/roots/list_changed` when the
// workspace boundary mutates; the `mcp/notifications.ts` handler
// calls `resolver.invalidateRootsCache()` so the next discovery call
// re-fetches.

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import { logger } from '../logger.js';

const discoveryLogger = logger.child({ subsystem: 'workspace-discovery' });
import { fileURLToPath } from 'node:url';

import type { CapabilityResolver } from '../capabilities/resolver.js';
import type { EventStore } from '../event-store/store.js';
import type { StorageBackend } from '../storage/backend.js';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Minimal `roots/list` surface consumed by {@link resolveWorkspace}. The
 * MCP SDK's full `RootsResult` carries more metadata; we accept only the
 * `uri` field so callers can pass a thin adapter or a test fixture
 * without dragging the SDK's type graph into discovery.
 */
export interface RootsClient {
  list(): Promise<readonly { uri: string }[]>;
}

/**
 * Discriminated-union return type for `resolveWorkspace`.
 *
 *   - `{success: true, source, featureId, path}` — single match (roots or cwd).
 *   - `{success: false, code: 'INVALID_INPUT', validTargets}` — multi-match;
 *     the caller must disambiguate by supplying an explicit `featureId`.
 *
 * Zero-match (no roots hit and no cwd hit) returns `undefined` from
 * `resolveWorkspace` rather than a success+empty shape so the dispatch
 * boundary can distinguish "discovery silently produced nothing" from
 * "discovery found multiple candidates."
 */
export type WorkspaceResolution =
  | {
      readonly success: true;
      readonly source: 'roots' | 'cwd';
      readonly featureId: string;
      readonly path: string;
    }
  | {
      readonly success: false;
      readonly code: 'INVALID_INPUT';
      readonly validTargets: readonly { readonly featureId: string; readonly path: string }[];
    };

export interface ResolveWorkspaceOpts {
  /** Optional explicit featureId. When provided, discovery short-circuits. */
  readonly featureId?: string;
  /** Capability resolver carrying the handshake-derived roots flag + cache. */
  readonly resolver: CapabilityResolver;
  /** Roots client adapter. Omitted callers force the cwd-walk branch. */
  readonly rootsClient?: RootsClient;
  /** Working directory for the cwd-walk fallback. */
  readonly cwd: string;
  /** Event store used to emit `workspace.resolved` on single-match. */
  readonly eventStore: EventStore;
  /**
   * Storage backend exposing the projected `workflow_state` table (#1504).
   * When the probed workspace is the one this backend serves
   * (`wfDir === eventStore.dir`), `deriveFeatureId` enumerates tracked
   * workflows from `listStates()` — the authoritative source — instead of
   * scanning `.state.json` files (which are absent once the write-path is
   * removed). Optional: CLI/legacy callers that omit it fall back to the
   * file scan.
   */
  readonly storage?: StorageBackend | undefined;
}

// ─── Pure detector ──────────────────────────────────────────────────────────

/** Event-store SQLite filenames that signal a tracked workspace (#1504). */
const EVENT_DB_FILENAMES = new Set(['exarchos.db', 'events.db']);

/**
 * Synchronous workspace detector. Returns `true` when `dir` carries an
 * Exarchos workspace signature: a `.exarchos.yml` file at the root, an
 * event-store db (`exarchos.db`/`events.db`) under `docs/workflow-state/`,
 * or at least one `<id>.state.json` there. Exported so unit tests can pin
 * the contract independently of `resolveWorkspace`'s integration surface.
 *
 * The db check (#1504) keeps detection working after the `.state.json`
 * write-path is removed: a tracked workspace may then carry only the event
 * store, with no state files on disk.
 */
export function isExarchosWorkspace(dir: string): boolean {
  // The detector is sync because discovery walks N roots in a tight
  // loop and we don't want N promise round-trips per call. Errors are
  // swallowed silently — a missing root or unreadable workflow-state
  // dir is "not a workspace," not a hard failure.
  try {
    if (fsSync.existsSync(path.join(dir, '.exarchos.yml'))) return true;
  } catch {
    // fall through
  }
  try {
    const wfDir = path.join(dir, 'docs', 'workflow-state');
    if (!fsSync.existsSync(wfDir)) return false;
    const entries = fsSync.readdirSync(wfDir);
    return entries.some((e) => e.endsWith('.state.json') || EVENT_DB_FILENAMES.has(e));
  } catch {
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert a `file://` URI to an absolute filesystem path. Falls back to
 * a literal interpretation when the URI is not a `file:` scheme — the
 * caller is responsible for filtering out non-file roots ahead of
 * detector dispatch.
 */
function uriToPath(uri: string): string | undefined {
  try {
    if (uri.startsWith('file://')) {
      return fileURLToPath(uri);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find a `featureId` inside a known-good workspace directory. Picks the
 * lexically-first tracked workflow so the result is deterministic across
 * calls. Returns `undefined` when the workspace carries the `.exarchos.yml`
 * (or db) signature but has no tracked workflows yet.
 *
 * Backend-first (#1504): when `storage` is supplied AND the probed workspace
 * is the one this server's event store serves (`wfDir === eventStore.dir`),
 * enumerate the authoritative `workflow_state` projection via `listStates()`
 * — `.state.json` files are absent once the write-path is removed. Other
 * roots (a different repo in the roots list) fall back to the file scan; the
 * single server-bound backend knows nothing about them. Mirrors the
 * lifecycle/prune migration (`storage/lifecycle.ts`).
 */
async function deriveFeatureId(
  workspace: string,
  eventStore: EventStore,
  storage?: StorageBackend,
): Promise<string | undefined> {
  const wfDir = path.join(workspace, 'docs', 'workflow-state');

  if (storage && path.resolve(wfDir) === path.resolve(eventStore.dir)) {
    const featureIds = storage
      .listStates()
      .map((s) => s.featureId)
      .sort();
    return featureIds.length > 0 ? featureIds[0] : undefined;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(wfDir);
  } catch {
    return undefined;
  }
  const stateFiles = entries
    .filter((e) => e.endsWith('.state.json'))
    .sort();
  if (stateFiles.length === 0) return undefined;
  return stateFiles[0]?.replace(/\.state\.json$/, '');
}

/**
 * Read-through cache: returns the cached roots list, or fetches via
 * `rootsClient.list()` and stores the result on the resolver before
 * returning. The cache is invalidated by the MCP notifications handler
 * (`mcp/notifications.ts`) on `roots/list_changed`.
 */
async function getOrFetchRoots(
  resolver: CapabilityResolver,
  rootsClient: RootsClient,
): Promise<readonly { uri: string }[]> {
  const cached = resolver.getCachedRoots();
  if (cached !== undefined) return cached;
  try {
    const fetched = await rootsClient.list();
    resolver.setCachedRoots(fetched);
    return fetched;
  } catch {
    // CodeRabbit MAJOR #1424: a transient `roots/list` failure must not
    // abort discovery — degrade to "no roots returned" so the caller's
    // for-loop yields no matches and dispatch falls through to the cwd
    // branch (which is the intended best-effort behavior, see DR-12 of
    // the workspace-discovery design). Cache nothing on failure so the
    // next dispatch retries the fetch instead of locking in an empty
    // snapshot.
    return [];
  }
}

/**
 * Walk from `cwd` upward looking for an Exarchos workspace signature.
 * Stops at the first hit (deepest wins) or when the parent equals the
 * current directory (filesystem root). Returns `undefined` on miss.
 */
function cwdWalk(cwd: string): string | undefined {
  let cur = path.resolve(cwd);
  // Bound the walk so a pathological symlink loop or a /-mounted cwd
  // doesn't spin. 64 iterations is far above the deepest realistic
  // workspace nesting (basileus → exarchos has been our worst case
  // and lives 3 levels deep).
  for (let i = 0; i < 64; i++) {
    if (isExarchosWorkspace(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

async function emitResolved(
  eventStore: EventStore,
  data: { source: 'roots' | 'cwd'; path: string; featureId: string },
): Promise<void> {
  // Emit best-effort: observability emission must never fail discovery.
  // The handler logs through the event store's own error surface if the
  // append fails for non-fatal reasons (idempotency conflict, etc.).
  try {
    await eventStore.append(data.featureId, {
      type: 'workspace.resolved',
      data,
    });
  } catch (err) {
    // Discovery is a read-side audit hook, not a write barrier — never
    // fail discovery on an emission error (idempotency conflicts on
    // replay, transient backend hiccups, etc.). CodeRabbit MINOR #1423:
    // surface via the workspace-discovery logger child so the missed
    // audit trail is observable instead of silently swallowed.
    discoveryLogger.warn(
      {
        featureId: data.featureId,
        source: data.source,
        error: err instanceof Error ? err.message : String(err),
      },
      'workspace.resolved emission failed; discovery proceeded without audit trail',
    );
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Resolve a workspace + `featureId` for a dispatch payload that did not
 * supply one. See module header for the priority chain and event
 * emission semantics.
 *
 * Returns:
 *   - `WorkspaceResolution & {success: true}` on single-match (roots or cwd).
 *   - `WorkspaceResolution & {success: false}` on multi-match (multiple roots
 *     contain workspaces). The dispatch boundary surfaces this as an
 *     `INVALID_INPUT` envelope so the caller can disambiguate.
 *   - `undefined` on full miss (no roots match, no cwd-walk hit). Callers
 *     should fall through to the existing `INVALID_INPUT: featureId is
 *     required` envelope.
 */
export async function resolveWorkspace(
  opts: ResolveWorkspaceOpts,
): Promise<WorkspaceResolution | undefined> {
  const { resolver, rootsClient, cwd, eventStore, storage } = opts;

  // Explicit featureId short-circuits — the dispatch boundary should
  // have filtered this case out before calling, but the guard keeps
  // the contract symmetric for direct callers and avoids surprising
  // event emissions when the caller already has authoritative state.
  if (opts.featureId !== undefined && opts.featureId.length > 0) {
    return undefined;
  }

  // Branch 1: Roots-based inference (only when the client declared roots
  // AND we have a client adapter to fetch them through).
  if (resolver.isRootsDeclared() && rootsClient !== undefined) {
    const roots = await getOrFetchRoots(resolver, rootsClient);
    const matches: { featureId: string; path: string }[] = [];

    for (const root of roots) {
      const rootPath = uriToPath(root.uri);
      if (rootPath === undefined) continue;
      if (!isExarchosWorkspace(rootPath)) continue;
      const featureId = await deriveFeatureId(rootPath, eventStore, storage);
      if (featureId === undefined) continue;
      matches.push({ featureId, path: rootPath });
    }

    if (matches.length === 1) {
      const m = matches[0]!;
      await emitResolved(eventStore, {
        source: 'roots',
        path: m.path,
        featureId: m.featureId,
      });
      return {
        success: true,
        source: 'roots',
        featureId: m.featureId,
        path: m.path,
      };
    }

    if (matches.length > 1) {
      return {
        success: false,
        code: 'INVALID_INPUT',
        validTargets: matches.map((m) => ({ featureId: m.featureId, path: m.path })),
      };
    }
    // Zero match in roots → fall through to cwd-walk.
  }

  // Branch 2: cwd-walk fallback. The walk is bounded; on miss we return
  // undefined and let the caller surface the existing `featureId is
  // required` envelope.
  const cwdHit = cwdWalk(cwd);
  if (cwdHit === undefined) return undefined;
  const featureId = await deriveFeatureId(cwdHit, eventStore, storage);
  if (featureId === undefined) return undefined;

  await emitResolved(eventStore, {
    source: 'cwd',
    path: cwdHit,
    featureId,
  });
  return { success: true, source: 'cwd', featureId, path: cwdHit };
}
