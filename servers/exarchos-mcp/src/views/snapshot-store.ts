import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EVENT_SCHEMA_VERSION } from '../event-store/event-migration.js';

// ─── Snapshot Data ─────────────────────────────────────────────────────────

export interface SnapshotData<T = unknown> {
  readonly view: T;
  readonly highWaterMark: number;
  readonly savedAt: string;
  readonly schemaVersion: string;
}

// ─── Validation ──────────────────────────────────────────────────────────

const SAFE_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Whether `id` may be used verbatim as a snapshot filename segment.
 *
 * This is the projection-side counterpart to the write-side `validateStreamId`
 * (`shared/validation.ts`), which is intentionally more permissive — it accepts
 * two-segment slash ids, dots, and underscores. Snapshot filenames must stay
 * kebab-only: a slash would escape the snapshot directory and `.`/`..` invite
 * path traversal. Callers that iterate arbitrary streamIds (e.g. the pipeline
 * view) MUST skip any stream for which this returns `false` rather than forward
 * it into the snapshot path.
 *
 * Exported so `ViewMaterializer` shares this single source of truth instead of
 * re-deriving its own predicate. The narrow `startsWith('__')` guard added for
 * #1434 only covered `__migration__` and drifted from this pattern, letting
 * slash streamIds (`elicitation/<uuid>`, `workflow-state/<id>`, …) re-crash the
 * view — see RCA 2026-05-30-state-source-integrity.
 */
export function isSnapshotSafeId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id);
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}" — must match ${SAFE_ID_PATTERN}`,
    );
  }
}

/** Unlink a file, ignoring ENOENT (file-not-found) errors. */
async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ─── Snapshot Store ────────────────────────────────────────────────────────

export class SnapshotStore {
  /**
   * Optional per-view snapshot-namespace overrides (DR-5/DR-6): maps a
   * registered `viewName` to the filename segment its snapshots use on disk,
   * decoupling the persisted snapshot *lineage* from the projection's
   * registration name. A view listed here reads/writes
   * `<streamId>.<override>.snapshot.json` instead of `<streamId>.<viewName>...`,
   * so the pipeline view can move to a versioned (`pipeline-v2`) lineage while
   * the materializer, cache keys, and `BUILTIN_VIEW_NAMES` keep using
   * `'pipeline'`. Pre-upgrade files under the un-namespaced name are simply
   * never read → the stream re-folds. Views absent from the map are unaffected.
   */
  constructor(
    private readonly stateDir: string,
    private readonly snapshotNamespaces: Readonly<Record<string, string>> = {},
  ) {}

  /** Resolve the on-disk filename segment for a view (honoring the namespace map). */
  private resolveSnapshotName(viewName: string): string {
    return this.snapshotNamespaces[viewName] ?? viewName;
  }

  /**
   * Get the file path for a snapshot.
   * Validates streamId and the resolved snapshot name against a safe pattern
   * and asserts the resolved path stays inside stateDir to prevent path traversal.
   */
  private getSnapshotPath(streamId: string, viewName: string): string {
    assertSafeId(streamId, 'streamId');
    const snapshotName = this.resolveSnapshotName(viewName);
    assertSafeId(snapshotName, 'viewName');

    const resolved = path.resolve(
      this.stateDir,
      `${streamId}.${snapshotName}.snapshot.json`,
    );
    const normalizedBase = path.resolve(this.stateDir);

    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
      throw new Error(
        `Path traversal detected: resolved path "${resolved}" escapes stateDir "${normalizedBase}"`,
      );
    }

    return resolved;
  }

  /**
   * Save a view snapshot to disk atomically using tmp+rename.
   * Writes to a temporary file first, then renames to the target path.
   * This ensures the target file is never left in a partially-written state.
   */
  async save<T>(
    streamId: string,
    viewName: string,
    view: T,
    highWaterMark: number,
  ): Promise<void> {
    const filePath = this.getSnapshotPath(streamId, viewName);
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const data: SnapshotData<T> = {
      view,
      highWaterMark,
      savedAt: new Date().toISOString(),
      schemaVersion: EVENT_SCHEMA_VERSION,
    };

    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  /**
   * Load a view snapshot from disk.
   * Returns undefined if no snapshot exists or if the snapshot is corrupt.
   */
  async load<T>(
    streamId: string,
    viewName: string,
  ): Promise<SnapshotData<T> | undefined> {
    const filePath = this.getSnapshotPath(streamId, viewName);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as SnapshotData<T>;

      // Basic validation
      if (
        data.view === undefined ||
        data.highWaterMark === undefined ||
        typeof data.highWaterMark !== 'number' ||
        data.schemaVersion !== EVENT_SCHEMA_VERSION
      ) {
        return undefined;
      }

      return data;
    } catch {
      return undefined;
    }
  }

  /**
   * Delete a specific snapshot file.
   * Idempotent: does not throw if the file does not exist.
   */
  async delete(streamId: string, viewName: string): Promise<void> {
    const filePath = this.getSnapshotPath(streamId, viewName);
    await unlinkIfExists(filePath);
  }

  /**
   * Delete ALL snapshots for a given stream.
   * Uses exact prefix matching (`${streamId}.` with trailing dot) to avoid
   * false positives (e.g., "my-feature" vs "my-feature-2").
   * Returns array of deleted file names.
   */
  async deleteAllForStream(streamId: string): Promise<string[]> {
    assertSafeId(streamId, 'streamId');

    const prefix = `${streamId}.`;
    const suffix = '.snapshot.json';
    const deleted: string[] = [];

    let files: string[];
    try {
      files = await fs.readdir(this.stateDir);
    } catch {
      return deleted;
    }

    const matching = files.filter((f) => f.startsWith(prefix) && f.endsWith(suffix));

    for (const file of matching) {
      try {
        await unlinkIfExists(path.join(this.stateDir, file));
        deleted.push(file);
      } catch {
        // Skip files that couldn't be deleted (e.g., permission denied)
      }
    }

    return deleted;
  }
}
