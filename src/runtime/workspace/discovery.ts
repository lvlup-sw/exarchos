/**
 * Roots-based workspace discovery for a dispatch payload without a `featureId`.
 * The priority is: explicit `featureId`, then roots, then cwd.
 *
 * When the client declares the `roots` capability, the resolver checks each root for an
 * Exarchos workspace signature. One match gives the resolution. More than one match gives
 * `INVALID_INPUT` with `validTargets`. Zero matches fall back to a cwd walk.
 *
 * The roots list is cached on the {@link CapabilityResolver}. On
 * `notifications/roots/list_changed`, `mcp/notifications.ts` calls
 * `resolver.invalidateRootsCache()`, so the next call fetches the list again.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import { logger } from '../../logger.js';

const discoveryLogger = logger.child({ subsystem: 'workspace-discovery' });
import { fileURLToPath } from 'node:url';

import type { CapabilityResolver } from '../../workflow/capabilities/resolver.js';
import type { EventStore } from '../../events/store.js';
import type { StorageBackend } from '../../storage/backend.js';

/**
 * Minimal `roots/list` surface for {@link resolveWorkspace}. It reads only `uri`,
 * so a caller can pass a thin adapter or a test fixture without the MCP SDK types.
 */
export interface RootsClient {
  list(): Promise<readonly { uri: string }[]>;
}

/**
 * Result of `resolveWorkspace`.
 *
 *   - `success: true`: one match, from roots or cwd.
 *   - `success: false`: more than one match. The caller must supply an explicit `featureId`.
 *
 * Zero matches give `undefined`, so the dispatch boundary can tell "nothing found"
 * from "more than one candidate".
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
   * Storage backend with the projected `workflow_state` table. When the probed
   * workspace is the one this backend serves, `deriveFeatureId` reads `listStates()`,
   * not `.state.json` files. A caller that omits it gets the file scan.
   */
  readonly storage?: StorageBackend | undefined;
}

/** Event-store SQLite filenames that signal a tracked workspace. */
const EVENT_DB_FILENAMES = new Set(['exarchos.db', 'events.db']);

/**
 * Return `true` when `dir` has an Exarchos workspace signature: `.exarchos.yml` at
 * the root, or an event-store db or a `<id>.state.json` under `docs/workflow-state/`.
 * A tracked workspace can have only the event store and no state files.
 * The detector is synchronous, so a walk over many roots has no promise round-trip for each root.
 * A missing or unreadable directory gives `false`, not an error.
 */
export function isExarchosWorkspace(dir: string): boolean {
  try {
    if (fsSync.existsSync(path.join(dir, '.exarchos.yml'))) return true;
  } catch {
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

/**
 * Convert a `file://` URI to an absolute filesystem path. Return `undefined` for
 * another scheme or a URI that does not convert.
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
 * Find a `featureId` in a workspace directory. Pick the lexically first tracked
 * workflow, so the result is deterministic. Return `undefined` when there is no tracked workflow.
 *
 * If `storage` is given and the workspace is the one that the event store serves,
 * read the `workflow_state` projection with `listStates()`.
 * Other roots fall back to the `.state.json` file scan, because the backend has no data for them.
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
 * Return the cached roots list, or fetch it with `rootsClient.list()` and cache it.
 * A failed fetch gives an empty list, so discovery falls through to the cwd walk.
 * The function caches nothing on failure, so the next dispatch tries the fetch again.
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
    return [];
  }
}

/**
 * Walk up from `cwd` to find an Exarchos workspace signature. The deepest hit wins.
 * The walk stops at the filesystem root or after 64 steps, so a symlink loop cannot spin.
 * Return `undefined` on a miss.
 */
function cwdWalk(cwd: string): string | undefined {
  let cur = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (isExarchosWorkspace(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Append `workspace.resolved`, best effort. An append error never fails discovery.
 * The function logs it as a warning, so the missed audit event is visible.
 */
async function emitResolved(
  eventStore: EventStore,
  data: { source: 'roots' | 'cwd'; path: string; featureId: string },
): Promise<void> {
  try {
    await eventStore.append(data.featureId, {
      type: 'workspace.resolved',
      data,
    });
  } catch (err) {
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

/**
 * Resolve a workspace and a `featureId` for a dispatch payload that has none.
 * An explicit `featureId` gives `undefined` with no event.
 * The roots branch runs only when the client declared roots and `rootsClient` is given.
 * Zero root matches fall through to the cwd walk.
 * A full miss gives `undefined`, and the caller returns its `featureId is required` error.
 */
export async function resolveWorkspace(
  opts: ResolveWorkspaceOpts,
): Promise<WorkspaceResolution | undefined> {
  const { resolver, rootsClient, cwd, eventStore, storage } = opts;

  if (opts.featureId !== undefined && opts.featureId.length > 0) {
    return undefined;
  }

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
  }

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
